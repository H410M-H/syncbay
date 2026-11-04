/**
 * Verification: deploy lifecycle against REAL infrastructure (Team A, Syncbay v1.1).
 *
 * Real: Postgres (DATABASE_URL, Prisma), two runner daemon processes on localhost
 * (`runner/src/index.ts`, RUNNER_PORT 41100 push / 41101 pull) running a real native Node
 * app, and the real Next route handlers for the pull queue (served by a tiny local adapter).
 * Mocked: the GitHub API (an in-memory Octokit stand-in).
 *
 *  1. DeploymentJob queue: orchestrator lease, SKIP LOCKED claims, runner events/lease checks.
 *  2. recoverStaleDeployments(): runner-lease requeue/fail, resume, re-run, legacy fail.
 *  3. Push (webhook) runner: VERCEL=1 still probes /health for real; a poll-budget hand-off is
 *     resumed by the recovery sweep; ACTIVE supersedes and stops the previous instance.
 *  4. restart (new process, same port), instant rollback (revives the superseded instance),
 *     pause (SLEEPING, stopped), delete (routes removed, port freed).
 *  5. Pull mode: runner claims over HMAC, reports events, control-plane stop job.
 *  6. Health: simulated only when the runner says so; no VERCEL short-cut.
 *  7. PR preview status success/failure + accurate comment, no first-account token fallback,
 *     HEAD SHA resolution, timing-safe GitHub webhook signature.
 *
 * Usage: DATABASE_URL=postgresql://… npm run test:deploy
 */

import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const ROOT = path.resolve(__dirname, "..");
const PUSH_PORT = 41100;
const PULL_PORT = 41101;
const ADAPTER_PORT = 41200;
const SECRET = crypto.randomBytes(24).toString("hex");
const RUN = crypto.randomBytes(3).toString("hex");

let passed = 0;
const ok = (msg: string) => {
  passed += 1;
  console.log(`  ✔ ${msg}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 30000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(250);
  }
}

function isAlive(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return !/^\d+ \(.*\) Z/.test(stat);
  } catch {
    return false;
  }
}

async function getJson(url: string, headers?: Record<string, string>): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
  return res.json();
}

function startRunner(port: number, workDir: string, extra: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, [path.join(ROOT, "node_modules/tsx/dist/cli.mjs"), path.join(ROOT, "runner/src/index.ts")], {
    cwd: workDir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "development",
      RUNNER_PORT: String(port),
      RUNNER_HOST: "127.0.0.1",
      RUNNER_SECRET: SECRET,
      SYNCBAY_API_URL: `http://127.0.0.1:${ADAPTER_PORT}`,
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tag = `[runner:${port}]`;
  child.stdout?.on("data", (c) => process.env.DEBUG_RUNNER && process.stdout.write(`${tag} ${c}`));
  child.stderr?.on("data", (c) => process.env.DEBUG_RUNNER && process.stderr.write(`${tag} ${c}`));
  return child;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required (real Postgres)");
  for (const k of ["GITHUB_TOKEN", "GITHUB_PAT", "GITHUB_ACCESS_TOKEN", "RUNNER_URL", "RUNNER_DRIVER", "RUNNER_QUEUE_MODE", "UPSTASH_REDIS_REST_URL"]) {
    delete process.env[k];
  }
  Object.assign(process.env, {
    RUNNER_SECRET: SECRET,
    RUNNER_FALLBACK_LOCAL: "false",
    GITHUB_WEBHOOK_SECRET: "gh-webhook-test-secret",
  });

  const prisma = new PrismaClient();
  (globalThis as any).prisma = prisma;

  const { enqueueDeploymentJob, acquireOrchestratorLease, releaseOrchestratorLease, enqueuePullJob, claimNextJob, recordRunnerEvents } =
    await import("../src/lib/orchestrator/job-queue");
  const { recoverStaleDeployments } = await import("../src/lib/orchestrator/recovery");
  const { executeDeployment } = await import("../src/lib/orchestrator/engine");
  const { scheduleDeployment } = await import("../src/lib/orchestrator/schedule");
  const { restartServiceInstance, stopServiceInstances, resolveServiceHostnames } = await import("../src/lib/orchestrator/lifecycle");
  const { executeInstantRollback } = await import("../src/lib/devops/instant-rollback");
  const { getServiceRoute } = await import("../src/lib/edge/service-registry");
  const { logEventBus } = await import("../src/lib/telemetry/event-bus");
  const { RunnerDriverFactory } = await import("../src/lib/orchestrator/runner-driver");
  const pr = await import("../src/lib/orchestrator/pr-manager");
  const claimRoute = await import("../src/app/api/v1/runner/jobs/claim/route");
  const eventsRoute = await import("../src/app/api/v1/runner/jobs/[id]/events/route");
  const ghRoute = await import("../src/app/api/webhooks/github/route");
  const { NextRequest } = await import("next/server");

  // ─── Fixtures ──────────────────────────────────────────────────────────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-a-lifecycle-"));
  const appFile = path.join(tmp, "app.cjs");
  fs.writeFileSync(
    appFile,
    `const http = require("http");
const delay = parseInt(process.env.APP_DELAY_MS || "0", 10);
setTimeout(() => {
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ pid: process.pid, version: process.env.APP_VERSION, path: req.url }));
  }).listen(parseInt(process.env.PORT, 10), "127.0.0.1");
}, delay);
`
  );

  const owner = await prisma.user.create({ data: { email: `owner-${RUN}@test.syncbay.app`, name: "Owner" } });
  const stranger = await prisma.user.create({ data: { email: `stranger-${RUN}@test.syncbay.app` } });
  const workspace = await prisma.workspace.create({
    data: { name: `ws-${RUN}`, slug: `ws-${RUN}`, members: { create: { userId: owner.id, role: "OWNER" } } },
  });
  const project = await prisma.project.create({ data: { workspaceId: workspace.id, name: `proj-${RUN}` } });
  const env = await prisma.environment.create({ data: { projectId: project.id, name: "production", isDefault: true } });
  const service = await prisma.service.create({
    data: {
      environmentId: env.id,
      name: `lc${RUN}`,
      sourceType: "empty",
      startCommand: `node "${appFile}"`,
      port: 3000,
      variables: { create: [{ key: "APP_VERSION", value: "v1", isSecret: false }, { key: "APP_DELAY_MS", value: "3000", isSecret: false }] },
    },
  });
  const setVar = (key: string, value: string) =>
    prisma.environmentVariable.updateMany({ where: { serviceId: service.id, key }, data: { value } });
  const newDeployment = async (svcId = service.id, commitSha: string | null = null) => {
    const build = await prisma.build.create({ data: { serviceId: svcId, status: "QUEUED", commitSha } });
    return prisma.deployment.create({ data: { serviceId: svcId, buildId: build.id, status: "QUEUED" } });
  };

  // Local adapter: serves the real Next route handlers for the runner pull API.
  const adapter = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = `http://127.0.0.1:${ADAPTER_PORT}${req.url}`;
    const request = new NextRequest(url, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
    });
    let response: Response;
    const ev = new URL(url).pathname.match(/^\/api\/v1\/runner\/jobs\/([^/]+)\/events$/);
    if (new URL(url).pathname === "/api/v1/runner/jobs/claim") response = await claimRoute.POST(request);
    else if (ev) response = await eventsRoute.POST(request, { params: Promise.resolve({ id: decodeURIComponent(ev[1]) }) });
    else response = new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((r) => adapter.listen(ADAPTER_PORT, "127.0.0.1", () => r()));

  const pushRunner = startRunner(PUSH_PORT, tmp, {});
  const pullDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-a-pull-"));
  const pullRunner = startRunner(PULL_PORT, pullDir, {
    RUNNER_QUEUE_MODE: "pull",
    RUNNER_ID: `pull-${RUN}`,
    RUNNER_POLL_INTERVAL_MS: "500",
  });
  const cleanup = async () => {
    pushRunner.kill("SIGTERM");
    pullRunner.kill("SIGTERM");
    adapter.close();
    await prisma.deploymentJob.deleteMany({ where: { serviceId: { in: (await prisma.service.findMany({ where: { environment: { projectId: project.id } }, select: { id: true } })).map((s) => s.id) } } }).catch(() => null);
    await prisma.deployment.deleteMany({ where: { service: { environment: { projectId: project.id } } } }).catch(() => null);
    await prisma.workspace.delete({ where: { id: workspace.id } }).catch(() => null);
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, stranger.id] } } }).catch(() => null);
    await prisma.$disconnect();
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(pullDir, { recursive: true, force: true });
  };

  try {
    await waitFor("push runner /health", () => getJson(`http://127.0.0.1:${PUSH_PORT}/health`), 20000);
    await waitFor("pull runner /health", () => getJson(`http://127.0.0.1:${PULL_PORT}/health`), 20000);

    // ─── 1. Job queue on real Postgres ───────────────────────────────────────
    console.log("\n[1] DeploymentJob queue (real Postgres)");
    {
      const d = await newDeployment();
      await enqueueDeploymentJob({ deploymentId: d.id, buildId: d.buildId, serviceId: service.id, options: { cleanBuild: true } });
      const job = await prisma.deploymentJob.findUniqueOrThrow({ where: { deploymentId: d.id } });
      assert.strictEqual(job.status, "PENDING");
      const leases = await Promise.all([1, 2, 3, 4].map(() => acquireOrchestratorLease(d.id)));
      assert.strictEqual(leases.filter(Boolean).length, 1, "exactly one concurrent orchestrator wins the lease");
      await releaseOrchestratorLease(d.id);
      assert.strictEqual(await acquireOrchestratorLease(d.id), true);
      ok("orchestrator lease is exclusive under concurrency and can be released");

      const p = await newDeployment();
      const jobId = await enqueuePullJob({
        deploymentId: p.id,
        buildId: p.buildId,
        serviceId: service.id,
        serviceName: "x",
        environmentVariables: { SECRET_KEY: "s3cr3t" },
        onLog: () => {},
      });
      // Use a runner id that the live pull runner will not use, and race 6 claimers.
      const claims = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => claimNextJob(`racer-${RUN}-${i}`)));
      const won = claims.filter((c) => c?.id === jobId);
      assert.strictEqual(won.length, 1, "SKIP LOCKED: one claimer wins");
      const holder = (await prisma.deploymentJob.findUniqueOrThrow({ where: { id: jobId! } })).leaseOwner!;
      ok(`FOR UPDATE SKIP LOCKED claim: 1 of 6 concurrent runners got job ${jobId!.slice(0, 8)}`);

      const wrong = await recordRunnerEvents(jobId!, { runnerId: "intruder", logs: ["x"] });
      assert.strictEqual(wrong.status, 409);
      const beat = await recordRunnerEvents(jobId!, { runnerId: holder, logs: ["[pipeline] hello from runner"] });
      assert.strictEqual(beat.status, 200);
      assert.ok(logEventBus.getHistory(p.id).some((l) => l.message.includes("hello from runner")));
      const done = await recordRunnerEvents(jobId!, { runnerId: holder, status: "SUCCEEDED", result: { containerId: "c1", port: 1234 } });
      assert.strictEqual(done.status, 200);
      const after = await prisma.deploymentJob.findUniqueOrThrow({ where: { id: jobId! } });
      assert.strictEqual(after.status, "SUCCEEDED");
      assert.strictEqual(after.payload, null, "payload (with env secrets) cleared on completion");
      ok("events: non-holder 409, holder renews + relays logs, terminal result recorded, payload cleared");
      await prisma.deployment.updateMany({ where: { id: { in: [d.id, p.id] } }, data: { status: "CANCELLED" } });
    }

    // ─── 2. Recovery sweep ───────────────────────────────────────────────────
    console.log("\n[2] recoverStaleDeployments()");
    {
      const old = new Date(Date.now() - 10 * 60_000);
      const mk = async (status: string, data: Record<string, unknown>) => {
        const d = await newDeployment();
        await prisma.deployment.update({ where: { id: d.id }, data: { status: status as any } });
        const j = await prisma.deploymentJob.create({ data: { deploymentId: d.id, buildId: d.buildId, serviceId: service.id, ...data } as any });
        await prisma.$executeRawUnsafe(`UPDATE "deployment_jobs" SET "updatedAt" = $1 WHERE "id" = $2`, old, j.id);
        return { d, j };
      };
      const requeue = await mk("BUILDING", { mode: "pull", status: "RUNNING", leaseOwner: "dead", leaseExpiresAt: old, attempts: 1, orchestratorLeaseUntil: new Date(Date.now() + 60_000) });
      const exhausted = await mk("BUILDING", { mode: "pull", status: "RUNNING", leaseOwner: "dead", leaseExpiresAt: old, attempts: 3, orchestratorLeaseUntil: new Date(Date.now() + 60_000) });
      const resume = await mk("DEPLOYING", { mode: "push", status: "RUNNING", driverType: "webhook", runnerJobId: "rjob-1", orchestratorLeaseUntil: old });
      const rerun = await mk("QUEUED", { mode: "push", status: "PENDING" });
      const legacy = await newDeployment();
      await prisma.$executeRawUnsafe(`UPDATE "deployments" SET "status" = 'BUILDING', "createdAt" = $1 WHERE "id" = $2`, new Date(Date.now() - 2 * 3600_000), legacy.id);

      const calls: Array<{ id: string; resume?: any }> = [];
      const report = await recoverStaleDeployments({
        limit: 20,
        execute: (async (id: string, _b: string, _s: string, o: any) => {
          calls.push({ id, resume: o?.resume });
          return { status: "ACTIVE" };
        }) as any,
      });
      assert.ok(report.requeued.includes(requeue.d.id));
      assert.strictEqual((await prisma.deploymentJob.findUniqueOrThrow({ where: { id: requeue.j.id } })).status, "QUEUED");
      assert.ok(report.failed.includes(exhausted.d.id));
      assert.deepStrictEqual(calls.find((c) => c.id === resume.d.id)?.resume, { runnerJobId: "rjob-1", driverType: "webhook" });
      assert.ok(report.rerun.includes(rerun.d.id) && !calls.find((c) => c.id === rerun.d.id)?.resume);
      assert.ok(report.failed.includes(legacy.id));
      assert.strictEqual((await prisma.deployment.findUniqueOrThrow({ where: { id: legacy.id } })).status, "FAILED");
      const second = await recoverStaleDeployments({ limit: 20, execute: (async () => ({})) as any });
      assert.ok(!second.resumed.includes(resume.d.id), "resumed deployment holds a fresh orchestrator lease");
      ok("expired runner lease requeued / exhausted failed, lapsed orchestration resumed, never-started re-run, legacy failed");
      await prisma.deployment.updateMany({
        where: { id: { in: [requeue.d.id, exhausted.d.id, resume.d.id, rerun.d.id] } },
        data: { status: "CANCELLED" },
      });
      await prisma.deploymentJob.updateMany({ where: { id: requeue.j.id }, data: { status: "CANCELLED" } });
    }

    // ─── 3. Push runner: real health probe on VERCEL, hand-off + resume, supersede ──
    console.log("\n[3] Webhook runner on :41100 — health, hand-off/resume, supersede");
    process.env.RUNNER_URL = `http://127.0.0.1:${PUSH_PORT}`;
    process.env.RUNNER_DRIVER = "webhook";
    const proxied = (port: number) => getJson(`http://127.0.0.1:${PUSH_PORT}/`, { "x-target-port": String(port) });

    process.env.VERCEL = "1";
    process.env.DEPLOY_POLL_BUDGET_MS = "1200"; // app starts after 3 s → engine hands off
    const d1 = await newDeployment();
    await enqueueDeploymentJob({ deploymentId: d1.id, buildId: d1.buildId, serviceId: service.id });
    assert.strictEqual(await acquireOrchestratorLease(d1.id), true);
    const first = await executeDeployment(d1.id, d1.buildId, service.id, { serviceId: service.id });
    assert.strictEqual(first.status, "PENDING");
    const handedOff = await prisma.deploymentJob.findUniqueOrThrow({ where: { deploymentId: d1.id } });
    assert.strictEqual(handedOff.status, "RUNNING");
    assert.strictEqual(handedOff.orchestratorLeaseUntil, null);
    assert.strictEqual(handedOff.runnerJobId, d1.buildId);
    ok("poll budget exhausted → engine hands off, job RUNNING with runner job id, lease released");

    delete process.env.DEPLOY_POLL_BUDGET_MS;
    const rec = await recoverStaleDeployments({ graceMs: 0 });
    assert.ok(rec.resumed.includes(d1.id), `recovery resumed d1 (${JSON.stringify(rec)})`);
    const dep1 = await prisma.deployment.findUniqueOrThrow({ where: { id: d1.id }, include: { job: true } });
    assert.strictEqual(dep1.status, "ACTIVE");
    assert.strictEqual(dep1.runnerDriver, "webhook");
    assert.ok(dep1.assignedPort && dep1.cfContainerId?.startsWith("proc_"));
    assert.strictEqual(dep1.job?.status, "SUCCEEDED");
    const history1 = logEventBus.getHistory(d1.id).map((l) => l.message);
    assert.ok(history1.some((m) => m.includes(`Health check passed on http://127.0.0.1:${PUSH_PORT}/health`)), "probed through the runner");
    assert.ok(!history1.some((m) => m.includes("simulated")), "VERCEL=1 no longer skips the probe");
    assert.ok(history1.some((m) => m.includes("Target commit: branch HEAD")), "no invented SHA");
    const v1 = await proxied(dep1.assignedPort!);
    assert.strictEqual(v1.version, "v1");
    ok(`recovery resumed polling → ACTIVE; real /health probe via runner proxy under VERCEL=1; app ${dep1.cfContainerId} serves v1`);
    delete process.env.VERCEL;

    await setVar("APP_VERSION", "v2");
    await setVar("APP_DELAY_MS", "0");
    const d2 = await newDeployment();
    await scheduleDeployment(d2.id, d2.buildId, service.id, { serviceId: service.id });
    const dep2 = await waitFor("d2 ACTIVE", async () => {
      const d = await prisma.deployment.findUnique({ where: { id: d2.id } });
      if (d?.status === "FAILED") throw new Error(logEventBus.getError(d2.id) || "d2 failed");
      return d?.status === "ACTIVE" ? d : null;
    }, 45000);
    const v2res = await proxied(dep2.assignedPort!);
    assert.strictEqual(v2res.version, "v2", JSON.stringify({ v2res, dep2, logs: logEventBus.getHistory(d2.id).slice(-15).map((l) => l.message) }));
    const sup = await prisma.deployment.findUniqueOrThrow({ where: { id: d1.id } });
    assert.strictEqual(sup.status, "SUPERSEDED");
    await waitFor("v1 process gone", async () => !isAlive(v1.pid), 8000);
    await assert.rejects(fetch(`http://127.0.0.1:${dep1.assignedPort}/`, { signal: AbortSignal.timeout(1000) }));
    const hosts = resolveServiceHostnames({ name: service.name, environment: env, domains: [] });
    assert.strictEqual(getServiceRoute(hosts[0])?.targetPort, dep2.assignedPort);
    ok(`scheduleDeployment → d2 ACTIVE (v2); d1 SUPERSEDED and its process (pid ${v1.pid}) stopped; route → :${dep2.assignedPort}`);

    // ─── 4. restart / rollback / pause / delete ──────────────────────────────
    console.log("\n[4] restart, instant rollback, pause, delete");
    const before = await proxied(dep2.assignedPort!);
    const restarted = await restartServiceInstance(service.id, owner.id);
    assert.strictEqual(restarted.mode, "restart");
    assert.strictEqual(restarted.port, dep2.assignedPort, "same port");
    assert.notStrictEqual(restarted.containerId, dep2.cfContainerId);
    const afterRestart = await proxied(dep2.assignedPort!);
    assert.notStrictEqual(afterRestart.pid, before.pid);
    assert.ok(!isAlive(before.pid));
    assert.strictEqual((await prisma.deployment.findUniqueOrThrow({ where: { id: d2.id } })).cfContainerId, restarted.containerId);
    ok(`restart: pid ${before.pid} → ${afterRestart.pid} on the same port, deployment points at ${restarted.containerId}`);

    const rb = await executeInstantRollback(prisma, owner.id, { deploymentId: d1.id, serviceId: service.id });
    assert.strictEqual(rb.mode, "restart");
    const rolled = await prisma.deployment.findUniqueOrThrow({ where: { id: d1.id } });
    assert.strictEqual(rolled.status, "ACTIVE");
    const v1again = await proxied(rolled.assignedPort!);
    assert.strictEqual(v1again.version, "v1", "the superseded build's own launch spec (env v1) was revived");
    assert.strictEqual((await prisma.deployment.findUniqueOrThrow({ where: { id: d2.id } })).status, "SUPERSEDED");
    await waitFor("v2 process gone", async () => !isAlive(afterRestart.pid), 8000);
    assert.strictEqual(getServiceRoute(hosts[0])?.targetPort, rolled.assignedPort);
    ok(`instant rollback restarted d1 (v1) on :${rolled.assignedPort}, re-registered routes, stopped d2`);

    const paused = await stopServiceInstances(service.id, "pause");
    assert.deepStrictEqual(paused.stopped, [d1.id]);
    assert.strictEqual((await prisma.deployment.findUniqueOrThrow({ where: { id: d1.id } })).status, "SLEEPING");
    await waitFor("v1 stopped on pause", async () => !isAlive(v1again.pid), 8000);
    assert.strictEqual(getServiceRoute(hosts[0])?.status, "SLEEPING");
    ok("pause: instance stopped, deployment SLEEPING, every host routed SLEEPING");

    const portsBefore: number[] = (await getJson(`http://127.0.0.1:${PUSH_PORT}/health`)).allocatedPorts;
    const res2 = await restartServiceInstance(service.id, owner.id); // revive (no live deployment → redeploy path)
    assert.strictEqual(res2.mode, "redeploy");
    const revived = await waitFor("revived ACTIVE", async () => {
      const d = await prisma.deployment.findUnique({ where: { id: res2.deploymentId! } });
      return d?.status === "ACTIVE" ? d : null;
    }, 45000);
    const deleted = await stopServiceInstances(service.id, "delete");
    assert.ok(deleted.stopped.includes(revived.id));
    for (const h of hosts) assert.strictEqual(getServiceRoute(h), null);
    const portsAfter: number[] = (await getJson(`http://127.0.0.1:${PUSH_PORT}/health`)).allocatedPorts;
    assert.ok(!portsAfter.includes(revived.assignedPort!), "runner freed the port");
    assert.ok(portsAfter.length <= portsBefore.length + 1);
    ok("restart without a live instance redeploys; delete stops it, removes routes, frees the runner port");

    // ─── 5. Pull mode ────────────────────────────────────────────────────────
    console.log("\n[5] Pull-mode runner on :41101 (claim/events over HMAC via the real route handlers)");
    delete process.env.RUNNER_URL;
    delete process.env.RUNNER_DRIVER;
    process.env.RUNNER_QUEUE_MODE = "pull";
    const pullSvc = await prisma.service.create({
      data: {
        environmentId: env.id,
        name: `pl${RUN}`,
        sourceType: "empty",
        startCommand: `node "${appFile}"`,
        port: 3000,
        variables: { create: [{ key: "APP_VERSION", value: "pull-v1", isSecret: false }] },
      },
    });
    const d3 = await newDeployment(pullSvc.id);
    const r3 = await executeDeployment(d3.id, d3.buildId, pullSvc.id, { serviceId: pullSvc.id });
    assert.strictEqual(r3.status, "ACTIVE");
    const dep3 = await prisma.deployment.findUniqueOrThrow({ where: { id: d3.id }, include: { job: true } });
    assert.strictEqual(dep3.runnerDriver, "queue");
    assert.strictEqual(dep3.job?.runnerId, `pull-${RUN}`);
    assert.strictEqual(dep3.job?.payload, null);
    const pullApp = await getJson(`http://127.0.0.1:${r3.port}/`);
    assert.strictEqual(pullApp.version, "pull-v1");
    assert.ok(logEventBus.getHistory(d3.id).some((l) => l.message.includes("Health verified by the pull-mode runner")));
    ok(`runner pull-${RUN} claimed, built and reported; deployment ACTIVE on :${r3.port} serving pull-v1`);

    const pausedPull = await stopServiceInstances(pullSvc.id, "pause");
    assert.deepStrictEqual(pausedPull.queued, [d3.id]);
    const stopJob = await waitFor("stop control job", async () => {
      const j = await prisma.deploymentJob.findFirst({ where: { kind: "stop", targetContainerId: dep3.cfContainerId } });
      return j?.status === "SUCCEEDED" ? j : null;
    }, 20000);
    assert.strictEqual(stopJob.targetRunnerId, `pull-${RUN}`);
    await waitFor("pull app stopped", async () => !isAlive(pullApp.pid), 8000);
    ok("pause in pull mode queues a stop job for the hosting runner, which stops the instance");

    const unsigned = await fetch(`http://127.0.0.1:${ADAPTER_PORT}/api/v1/runner/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Syncbay-Signature": `sha256=${"0".repeat(64)}`, "X-Syncbay-Timestamp": String(Date.now()) },
      body: JSON.stringify({ runnerId: "evil" }),
    });
    assert.strictEqual(unsigned.status, 401);
    ok("claim endpoint rejects a bad HMAC signature (401)");
    delete process.env.RUNNER_QUEUE_MODE;

    // ─── 6. Simulated only when the runner says so ───────────────────────────
    console.log("\n[6] Health-probe gating");
    {
      const origCreate = RunnerDriverFactory.createDriver;
      const fake = (simulated: boolean): any => ({
        type: "webhook",
        dispatchBuild: async () => ({ jobId: "fake", driverType: "webhook", status: "ACTIVE", assignedPort: 41999, containerId: "c_fake", metadata: { simulated } }),
        checkStatus: async () => ({ jobId: "fake", status: "ACTIVE" }),
        stopContainer: async (id: string) => ({ containerId: id, stopped: true }),
      });
      const svc = await prisma.service.create({ data: { environmentId: env.id, name: `hp${RUN}`, sourceType: "empty", port: 3000 } });
      process.env.VERCEL = "1";
      process.env.RUNNER_DRIVER = "webhook";
      process.env.RUNNER_URL = "http://127.0.0.1:41998"; // nothing listens here
      try {
        RunnerDriverFactory.createDriver = (() => fake(true)) as any;
        const s1 = await newDeployment(svc.id);
        assert.strictEqual((await executeDeployment(s1.id, s1.buildId, svc.id, { serviceId: svc.id })).status, "ACTIVE");
        RunnerDriverFactory.createDriver = (() => fake(false)) as any;
        const s2 = await newDeployment(svc.id);
        await assert.rejects(executeDeployment(s2.id, s2.buildId, svc.id, { serviceId: svc.id }), /health check failed/i);
        assert.strictEqual((await prisma.deployment.findUniqueOrThrow({ where: { id: s2.id } })).status, "FAILED");
        assert.strictEqual((await prisma.deploymentJob.findUnique({ where: { deploymentId: s2.id } }))?.status ?? "FAILED", "FAILED");
      } finally {
        RunnerDriverFactory.createDriver = origCreate;
        delete process.env.VERCEL;
        delete process.env.RUNNER_DRIVER;
        delete process.env.RUNNER_URL;
      }
      ok("runner metadata.simulated skips the probe; a real runner on VERCEL=1 with no healthy app FAILS");
    }

    // ─── 7. GitHub: PR status, token fallback, SHA, webhook signature (GitHub API mocked) ──
    console.log("\n[7] PR preview status & GitHub auth (Octokit mocked)");
    {
      const calls: any[] = [];
      const comments: any[] = [];
      const octokit: any = {
        rest: {
          repos: {
            createCommitStatus: async (a: any) => calls.push(a),
            getCommit: async (a: any) => ({ data: { sha: `sha-of-${a.ref}` } }),
            get: async () => ({ data: { default_branch: "main" } }),
          },
          issues: {
            listComments: async () => ({ data: comments }),
            createComment: async (a: any) => comments.push({ id: comments.length + 1, body: a.body }),
            updateComment: async (a: any) => {
              comments.find((c) => c.id === a.comment_id).body = a.body;
            },
          },
        },
      };
      const prEnv = await prisma.environment.create({ data: { projectId: project.id, name: "pr-7", isPrEnv: true, prNumber: 7 } });
      const prSvc = await prisma.service.create({
        data: { environmentId: prEnv.id, name: "web", sourceType: "github", repoUrl: "https://github.com/acme/shop", branch: "feat-x" },
      });
      const pd = await newDeployment(prSvc.id, "abc1234def");
      assert.strictEqual(await pr.reportPreviewDeploymentStatus(pd.id, "success", prisma, octokit), true);
      assert.strictEqual(calls[0].state, "success");
      assert.strictEqual(calls[0].sha, "abc1234def");
      assert.strictEqual(calls[0].context, "syncbay/preview");
      assert.ok(comments[0].body.includes("🟢 Active"));
      logEventBus.recordError(pd.id, "npm run build failed (exit code 2)");
      await pr.reportPreviewDeploymentStatus(pd.id, "failure", prisma, octokit);
      assert.strictEqual(calls[1].state, "failure");
      assert.strictEqual(comments.length, 1, "comment updated in place");
      assert.ok(comments[0].body.includes("🔴 Failed") && comments[0].body.includes("exit code 2"));
      assert.strictEqual(await pr.reportPreviewDeploymentStatus(d2.id, "success", prisma, octokit), false, "non-PR deployments are ignored");
      ok("syncbay/preview commit status success → failure; PR comment rewritten with the real state and error");

      await prisma.account.create({
        data: { userId: stranger.id, type: "oauth", provider: "github", providerAccountId: `s-${RUN}`, access_token: "stranger-token" },
      });
      assert.strictEqual(await pr.getOctokitClient(project.id), null, "an unrelated user's token is never borrowed");
      await prisma.account.create({
        data: { userId: owner.id, type: "oauth", provider: "github", providerAccountId: `o-${RUN}`, access_token: "owner-token" },
      });
      assert.ok(await pr.getOctokitClient(project.id), "workspace member's token is used");
      ok("no first-GitHub-account fallback; a workspace member's token is used");

      assert.strictEqual(await pr.resolveHeadCommitSha("https://github.com/acme/shop.git", "feat-x", { octokit }), "sha-of-feat-x");
      assert.strictEqual(await pr.resolveHeadCommitSha("https://github.com/acme/shop", null, { octokit }), "sha-of-main");
      assert.strictEqual(await pr.resolveHeadCommitSha("https://gitlab.com/acme/shop", "main", { octokit }), null);
      ok("HEAD SHA resolved through the GitHub API (branch or default branch); non-GitHub → null");

      const payload = JSON.stringify({ zen: "hi" });
      const sign = (body: string) => "sha256=" + crypto.createHmac("sha256", "gh-webhook-test-secret").update(body).digest("hex");
      const ghReq = (sig: string) =>
        new Request("http://127.0.0.1/api/webhooks/github", {
          method: "POST",
          headers: { "x-hub-signature-256": sig, "x-github-event": "ping", "x-github-delivery": "d1" },
          body: payload,
        });
      assert.strictEqual((await ghRoute.POST(ghReq("sha256=short"))).status, 401, "length mismatch rejected without throwing");
      assert.strictEqual((await ghRoute.POST(ghReq(sign(payload + "x")))).status, 401);
      assert.strictEqual((await ghRoute.POST(ghReq(sign(payload)))).status, 200);
      ok("GitHub webhook signature compared with timingSafeEqual (bad length/bad digest 401, valid 200)");
    }

    console.log(`\n✅ verify-deploy-lifecycle: ${passed} checks passed (real Postgres + real runner daemons; GitHub API mocked)`);
  } finally {
    await cleanup();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("\n❌ verify-deploy-lifecycle failed:", err?.stack || err);
    process.exit(1);
  }
);
