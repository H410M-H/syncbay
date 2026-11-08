/**
 * Verification: project actions, wizard dedupe and runner preflight against REAL infrastructure
 * (Team A, Syncbay v1.2).
 *
 * Real: Postgres (DATABASE_URL, Prisma), one runner daemon process (`runner/src/index.ts`,
 * RUNNER_PORT 47100, webhook mode) running real native Node apps, the real tRPC routers (direct
 * callers plus the fetch adapter for the wire error shape) and the real REST route handlers.
 * Mocked: nothing. GitHub is not involved (services have no repo); a tiny local HTTP server
 * answers 530 to exercise the health-check error path.
 *
 *  1. Duplicate project names: CONFLICT + existingProjectId (direct and over the wire), races, REST 409.
 *  2. Rename (update) with the duplicate check; viewers are refused.
 *  3. Real deploys of two native apps through `deployment.trigger` → runner → ACTIVE; list counts.
 *  4. redeployAll creates and runs new deployments (old instances superseded and stopped).
 *  5. pauseAll stops the processes (SLEEPING, routes SLEEPING); resumeAll brings them back.
 *  6. Preflight with NODE_ENV=production, RUNNER_URL set and no secret: PRECONDITION_FAILED / 412,
 *     no deployment row; stop/restart/pause report the failure instead of "stopped".
 *  7. getRunnerConfigStatus() never leaks the secret; checkRunnerHealth() online / offline / 530.
 *  8. delete tears down: processes gone, routes removed, domains released, project hidden.
 *
 * Usage: DATABASE_URL=postgresql://… npm run test:projects
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
const RUNNER_PORT = 47100;
const DEAD_PORT = 47199; // nothing listens here
const GATEWAY_530_PORT = 47130;
const SECRET = crypto.randomBytes(24).toString("hex");
const RUN = crypto.randomBytes(3).toString("hex");
const env = process.env as Record<string, string | undefined>;

let passed = 0;
const ok = (msg: string) => {
  passed += 1;
  console.log(`  ✔ ${msg}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 45000): Promise<T> {
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

/** PID the app reports for a deployment (the runner launches it through a shell, so it is not proc_<pid>). */
const appPids = new Map<string, number>();
const pidOf = (deploymentId: string) => {
  const pid = appPids.get(deploymentId);
  assert.ok(pid, `no recorded app pid for ${deploymentId}`);
  return pid;
};

/** GET through the runner's reverse proxy (x-target-port), like the edge does. */
async function viaRunner(port: number): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${RUNNER_PORT}/`, { headers: { "x-target-port": String(port) }, signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function rejects(fn: () => Promise<unknown>, check: (e: any) => boolean, label: string): Promise<any> {
  try {
    await fn();
  } catch (e: any) {
    assert.ok(check(e), `${label}: unexpected error ${e?.code} ${e?.message}`);
    return e;
  }
  throw new Error(`${label}: expected a rejection`);
}

function startRunner(workDir: string): ChildProcess {
  const child = spawn(process.execPath, [path.join(ROOT, "node_modules/tsx/dist/cli.mjs"), path.join(ROOT, "runner/src/index.ts")], {
    cwd: workDir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "development",
      RUNNER_PORT: String(RUNNER_PORT),
      RUNNER_HOST: "127.0.0.1",
      RUNNER_SECRET: SECRET,
      RUNNER_STATE_DIR: path.join(workDir, ".state"),
      SYNCBAY_API_URL: `http://127.0.0.1:${DEAD_PORT}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (c) => process.env.DEBUG_RUNNER && process.stdout.write(`[runner] ${c}`));
  child.stderr?.on("data", (c) => process.env.DEBUG_RUNNER && process.stderr.write(`[runner] ${c}`));
  return child;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required (real Postgres)");
  for (const k of [
    "GITHUB_TOKEN",
    "GITHUB_PAT",
    "GITHUB_ACCESS_TOKEN",
    "RUNNER_QUEUE_MODE",
    "RUNNER_WEBHOOK_SECRET",
    "SYNCBAY_WEBHOOK_SECRET",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "CLOUDFLARE_TUNNEL_ID",
    "CLOUDFLARE_API_TOKEN",
    "TUNNEL_CONFIG_FILE",
    "VERCEL",
    "VERCEL_ENV",
    "RUNNER_FORCE_LOCAL",
  ]) {
    delete env[k];
  }
  Object.assign(env, {
    NODE_ENV: "development",
    RUNNER_URL: `http://127.0.0.1:${RUNNER_PORT}`,
    RUNNER_DRIVER: "webhook",
    RUNNER_SECRET: SECRET,
    RUNNER_FALLBACK_LOCAL: "false",
  });

  const prisma = new PrismaClient();
  (globalThis as any).prisma = prisma;

  const { appRouter } = await import("../src/server/root");
  const { fetchRequestHandler } = await import("@trpc/server/adapters/fetch");
  const { getRunnerConfigStatus, checkRunnerHealth, isRunnerConfigError } = await import("../src/lib/orchestrator/runner-config");
  const { resolveRunnerSecret, AuthenticationError } = await import("../src/lib/orchestrator/runner-driver");
  const { driverFor, resolveServiceHostnames } = await import("../src/lib/orchestrator/lifecycle");
  const { scheduleDeployment } = await import("../src/lib/orchestrator/schedule");
  const { getServiceRoute } = await import("../src/lib/edge/service-registry");
  const { resolveServiceRouteFromDb } = await import("../src/lib/edge/resolve");
  const { ErrorDetails } = await import("../src/server/error-details");
  const deploymentsRoute = await import("../src/app/api/v1/deployments/route");
  const projectsRoute = await import("../src/app/api/v1/projects/route");
  const { NextRequest } = await import("next/server");

  // ─── Fixtures ──────────────────────────────────────────────────────────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-a-projects-"));
  const appFile = path.join(tmp, "app.cjs");
  fs.writeFileSync(
    appFile,
    `const http = require("http");
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ pid: process.pid, svc: process.env.SVC_NAME, path: req.url }));
}).listen(parseInt(process.env.PORT, 10), "127.0.0.1");
`
  );

  const users = await Promise.all(
    ["owner", "member", "viewer"].map((r) => prisma.user.create({ data: { email: `${r}-${RUN}@test.syncbay.app`, name: r } }))
  );
  const [owner, member, viewer] = users;
  const workspace = await prisma.workspace.create({
    data: {
      name: `ws-${RUN}`,
      slug: `ws-${RUN}`,
      members: {
        create: [
          { userId: owner.id, role: "OWNER" },
          { userId: member.id, role: "MEMBER" },
          { userId: viewer.id, role: "VIEWER" },
        ],
      },
    },
  });
  const rawToken = `sb_live_${crypto.randomBytes(16).toString("hex")}`;
  await prisma.apiToken.create({
    data: {
      workspaceId: workspace.id,
      userId: owner.id,
      name: "test",
      scope: "FULL_ACCESS",
      tokenHash: crypto.createHash("sha256").update(rawToken).digest("hex"),
    },
  });

  const ctx = (userId: string) => ({ db: prisma, session: { user: { id: userId }, expires: "2099-01-01" }, headers: new Headers() });
  const asOwner = appRouter.createCaller(ctx(owner.id) as any);
  const asMember = appRouter.createCaller(ctx(member.id) as any);
  const asViewer = appRouter.createCaller(ctx(viewer.id) as any);
  const rest = (url: string, body: unknown) =>
    new NextRequest(`http://localhost${url}`, {
      method: "POST",
      headers: { authorization: `Bearer ${rawToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const countRows = async (serviceIds: string[]) => ({
    deployments: await prisma.deployment.count({ where: { serviceId: { in: serviceIds } } }),
    builds: await prisma.build.count({ where: { serviceId: { in: serviceIds } } }),
  });

  const gateway530 = http.createServer((_req, res) => {
    res.writeHead(530, { "content-type": "text/html" });
    res.end("<h1>Error 1033</h1>");
  });
  await new Promise<void>((r) => gateway530.listen(GATEWAY_530_PORT, "127.0.0.1", () => r()));

  const runner = startRunner(tmp);
  const cleanup = async () => {
    runner.kill("SIGTERM");
    gateway530.close();
    const services = await prisma.service.findMany({ where: { environment: { project: { workspaceId: workspace.id } } }, select: { id: true } });
    const ids = services.map((s) => s.id);
    await prisma.deploymentJob.deleteMany({ where: { serviceId: { in: ids } } }).catch(() => null);
    await prisma.deployment.deleteMany({ where: { serviceId: { in: ids } } }).catch(() => null);
    await prisma.apiToken.deleteMany({ where: { workspaceId: workspace.id } }).catch(() => null);
    await prisma.workspace.delete({ where: { id: workspace.id } }).catch(() => null);
    await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } }).catch(() => null);
    await prisma.$disconnect();
    fs.rmSync(tmp, { recursive: true, force: true });
  };

  try {
    await waitFor("runner /health", async () => (await fetch(`http://127.0.0.1:${RUNNER_PORT}/health`)).ok, 30000);

    // ─── 1. Duplicate names ──────────────────────────────────────────────────
    console.log("\n[1] Duplicate project names");
    const portfolio = await asOwner.project.create({ workspaceId: workspace.id, name: "portfolio" });
    const dup = await rejects(
      () => asMember.project.create({ workspaceId: workspace.id, name: "  Portfolio " }),
      (e) => e.code === "CONFLICT",
      "duplicate create"
    );
    assert.strictEqual(dup.message, 'A project named "portfolio" already exists');
    assert.ok(dup.cause instanceof ErrorDetails && dup.cause.details.existingProjectId === portfolio.id);
    ok("create rejects a duplicate name (trimmed, case-insensitive) with CONFLICT + existingProjectId");

    // Over the wire (what the wizard reads): error.data.code / error.data.details.existingProjectId
    const wire = await fetchRequestHandler({
      endpoint: "/api/trpc",
      req: new Request("http://localhost/api/trpc/project.create?batch=1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ "0": { json: { workspaceId: workspace.id, name: "portfolio" } } }),
      }),
      router: appRouter,
      createContext: () => ctx(owner.id) as any,
    });
    const wireBody = await wire.json();
    const wireData = wireBody[0]?.error?.json?.data;
    assert.strictEqual(wireData?.code, "CONFLICT");
    assert.strictEqual(wireData?.httpStatus, 409);
    assert.deepStrictEqual(wireData?.details, { existingProjectId: portfolio.id });
    ok("tRPC wire error carries data.code=CONFLICT, httpStatus 409 and data.details.existingProjectId");

    const race = await Promise.allSettled([1, 2, 3, 4, 5].map(() => asOwner.project.create({ workspaceId: workspace.id, name: `race-${RUN}` })));
    assert.strictEqual(race.filter((r) => r.status === "fulfilled").length, 1, "exactly one concurrent create wins");
    assert.ok(race.every((r) => r.status === "fulfilled" || (r.reason as any)?.code === "CONFLICT"));
    assert.strictEqual(await prisma.project.count({ where: { workspaceId: workspace.id, name: `race-${RUN}` } }), 1);
    ok("5 concurrent creates of one name → 1 project, 4 CONFLICTs (advisory lock)");

    await rejects(() => asViewer.project.create({ workspaceId: workspace.id, name: "nope" }), (e) => e.code === "FORBIDDEN", "viewer create");
    const restDup = await projectsRoute.POST(rest("/api/v1/projects", { name: "PORTFOLIO" }));
    assert.strictEqual(restDup.status, 409);
    assert.strictEqual((await restDup.json()).existingProjectId, portfolio.id);
    ok("viewer create is FORBIDDEN; POST /api/v1/projects duplicate → 409 with existingProjectId");

    // ─── 2. Rename ───────────────────────────────────────────────────────────
    console.log("\n[2] Rename");
    const renamed = await asMember.project.update({ projectId: portfolio.id, name: `portfolio-${RUN}`, description: "My site" });
    assert.strictEqual(renamed.name, `portfolio-${RUN}`);
    assert.strictEqual(renamed.description, "My site");
    const renameDup = await rejects(
      () => asOwner.project.update({ projectId: portfolio.id, name: `RACE-${RUN}` }),
      (e) => e.code === "CONFLICT",
      "rename to an existing name"
    );
    assert.ok(renameDup.cause.details.existingProjectId);
    await asOwner.project.update({ projectId: portfolio.id, name: `Portfolio-${RUN}` }); // own name, other case: allowed
    await rejects(() => asViewer.project.update({ projectId: portfolio.id, name: "x" }), (e) => e.code === "FORBIDDEN", "viewer rename");
    ok("update renames, rejects another project's name (CONFLICT), allows a case change of its own, refuses viewers");

    // ─── 3. Real deploys ─────────────────────────────────────────────────────
    console.log(`\n[3] Real deploys on the runner (:${RUNNER_PORT})`);
    const envId = portfolio.environments[0].id;
    const mkService = (name: string) =>
      prisma.service.create({
        data: {
          environmentId: envId,
          name,
          sourceType: "empty",
          startCommand: `node "${appFile}"`,
          port: 3000,
          scaleToZero: false,
          variables: { create: [{ key: "SVC_NAME", value: name, isSecret: false }] },
        },
        include: { environment: true, domains: true },
      });
    const webBase = await mkService(`web${RUN}`);
    const domain = await prisma.domain.create({
      data: { serviceId: webBase.id, hostname: `shop-${RUN}.example.test`, status: "ACTIVE", verificationTxt: `tok-${RUN}` },
    });
    const web = await prisma.service.findUniqueOrThrow({ where: { id: webBase.id }, include: { environment: true, domains: true } });
    const api = await mkService(`api${RUN}`);
    const idle = await prisma.service.create({ data: { environmentId: envId, name: `idle${RUN}`, sourceType: "empty" } });
    const live = [web, api];
    const serviceIds = [web.id, api.id, idle.id];

    const latestActive = (serviceId: string, notIn: string[] = []) =>
      waitFor(`ACTIVE deployment of ${serviceId}`, async () => {
        const d = await prisma.deployment.findFirst({ where: { serviceId, id: { notIn } }, orderBy: { createdAt: "desc" } });
        if (d?.status === "FAILED") throw Object.assign(new Error(`deployment failed: ${d.errorMessage}`), { fatal: true });
        return d?.status === "ACTIVE" ? d : null;
      });

    const triggered = await Promise.all(live.map((s) => asMember.deployment.trigger({ serviceId: s.id, commitMessage: "first" })));
    const first = await Promise.all(live.map((s, i) => latestActive(s.id).then((d) => (assert.strictEqual(d.id, triggered[i].deployment.id), d))));
    for (const [i, d] of first.entries()) {
      assert.match(d.cfContainerId || "", /^proc_\d+$/);
      const body = await viaRunner(d.assignedPort!);
      assert.strictEqual(body.svc, live[i].name);
      assert.ok(isAlive(body.pid));
      appPids.set(d.id, body.pid);
    }
    ok(`deployment.trigger → runner → ACTIVE for 2 native apps (${first.map((d) => d.cfContainerId).join(", ")}), served via the runner proxy`);

    const listed = (await asViewer.project.list({ workspaceId: workspace.id })).find((p) => p.id === portfolio.id)!;
    assert.deepStrictEqual(listed.counts, { services: 3, live: 2, sleeping: 0, failed: 0, building: 0, paused: 0 });
    assert.ok(listed.lastDeployedAt && new Date(listed.lastDeployedAt).getTime() >= new Date(first[0].createdAt).getTime() - 1);
    assert.strictEqual(listed.myRole, "VIEWER");
    ok("list: counts {services 3, live 2} from latest deployments, lastDeployedAt, caller role");

    // ─── 4. redeployAll ──────────────────────────────────────────────────────
    console.log("\n[4] redeployAll");
    await rejects(() => asViewer.project.redeployAll({ projectId: portfolio.id }), (e) => e.code === "FORBIDDEN", "viewer redeployAll");
    const redeploy = await asMember.project.redeployAll({ projectId: portfolio.id });
    assert.strictEqual(redeploy.scheduled, 2);
    const byName = Object.fromEntries(redeploy.results.map((r) => [r.serviceName, r]));
    assert.strictEqual(byName[idle.name].status, "skipped");
    assert.strictEqual(byName[idle.name].reason, "No previous deployment");
    for (const s of live) {
      assert.strictEqual(byName[s.name].status, "scheduled");
      assert.strictEqual(byName[s.name].rebuild, false, "fast redeploy reuses the build");
    }
    const second = await Promise.all(live.map((s, i) => latestActive(s.id, [first[i].id])));
    for (const [i, d] of second.entries()) {
      assert.strictEqual(d.id, byName[live[i].name].deploymentId);
      assert.strictEqual(d.buildId, first[i].buildId, "same build reused");
      assert.strictEqual((await prisma.deployment.findUniqueOrThrow({ where: { id: first[i].id } })).status, "SUPERSEDED");
      await waitFor("superseded process gone", async () => !isAlive(pidOf(first[i].id)), 10000);
      const body = await viaRunner(d.assignedPort!);
      assert.notStrictEqual(body.pid, pidOf(first[i].id));
      appPids.set(d.id, body.pid);
    }
    ok("redeployAll scheduled 2 fast redeploys (idle service skipped); both ACTIVE, old instances SUPERSEDED and stopped");

    // ─── 5. pauseAll / resumeAll ─────────────────────────────────────────────
    console.log("\n[5] pauseAll / resumeAll");
    const paused = await asMember.project.pauseAll({ projectId: portfolio.id });
    assert.strictEqual(paused.paused, 3);
    for (const s of live) assert.strictEqual(paused.results.find((r) => r.serviceId === s.id)?.stopped, 1);
    for (const d of second) {
      await waitFor("paused process gone", async () => !isAlive(pidOf(d.id)), 10000);
      await rejects(() => viaRunner(d.assignedPort!), () => true, "paused app no longer answers");
      assert.strictEqual((await prisma.deployment.findUniqueOrThrow({ where: { id: d.id } })).status, "SLEEPING");
    }
    for (const s of live) {
      assert.strictEqual((await prisma.service.findUniqueOrThrow({ where: { id: s.id } })).isPaused, true);
      for (const host of resolveServiceHostnames(s)) assert.strictEqual(getServiceRoute(host)?.status, "SLEEPING", host);
    }
    const pausedList = (await asOwner.project.list({ workspaceId: workspace.id })).find((p) => p.id === portfolio.id)!;
    assert.deepStrictEqual(pausedList.counts, { services: 3, live: 0, sleeping: 3, failed: 0, building: 0, paused: 3 });
    ok("pauseAll: both processes stopped, deployments SLEEPING, services paused, routes SLEEPING, counts 3 paused");

    const resumed = await asMember.project.resumeAll({ projectId: portfolio.id });
    assert.strictEqual(resumed.resumed, 3);
    for (const [i, s] of live.entries()) {
      const r = resumed.results.find((x) => x.serviceId === s.id)!;
      assert.strictEqual(r.deploymentId, second[i].id, "wakes the sleeping deployment");
    }
    assert.strictEqual(resumed.results.find((r) => r.serviceId === idle.id)?.reason, "Nothing to wake");
    const third: any[] = [];
    for (const [i, s] of live.entries()) {
      const d = await waitFor("woken deployment ACTIVE with a new process", async () => {
        const row = await prisma.deployment.findUniqueOrThrow({ where: { id: second[i].id } });
        if (row.status === "FAILED") throw new Error(`wake failed: ${row.errorMessage}`);
        return row.status === "ACTIVE" && row.cfContainerId !== second[i].cfContainerId ? row : null;
      });
      const body = await viaRunner(d.assignedPort!);
      assert.strictEqual(body.svc, s.name);
      assert.ok(isAlive(body.pid) && body.pid !== pidOf(second[i].id));
      appPids.set(d.id, body.pid); // same deployment id, new process
      assert.strictEqual((await prisma.service.findUniqueOrThrow({ where: { id: s.id } })).isPaused, false);
      third.push(d);
    }
    ok("resumeAll: services unpaused, sleeping deployments re-run → new processes serving again");

    // ─── 6. Preflight + misconfigured runner ─────────────────────────────────
    console.log("\n[6] Runner misconfigured (NODE_ENV=production, RUNNER_URL set, no RUNNER_SECRET)");
    const before = await countRows(serviceIds);
    env.NODE_ENV = "production";
    delete env.RUNNER_SECRET;
    try {
      const status = getRunnerConfigStatus();
      assert.strictEqual(status.mode, "webhook");
      assert.strictEqual(status.urlHost, `127.0.0.1:${RUNNER_PORT}`);
      assert.strictEqual(status.secretConfigured, false);
      assert.ok(status.problem?.startsWith("Runner not configured: RUNNER_URL is set but RUNNER_SECRET is missing"), status.problem);
      assert.ok(status.problem.includes("deploy/alibaba-ecs/.env"));
      ok(`status: ${status.problem}`);

      const isPrecondition = (e: any) => e.code === "PRECONDITION_FAILED" && e.message === status.problem;
      await rejects(() => asMember.deployment.trigger({ serviceId: web.id }), isPrecondition, "trigger");
      await rejects(() => asMember.deployment.redeploy({ deploymentId: third[0].id }), isPrecondition, "redeploy");
      await rejects(() => asMember.deployment.redeploy({ deploymentId: third[0].id, rebuild: true }), isPrecondition, "clean rebuild");
      await rejects(() => asMember.project.redeployAll({ projectId: portfolio.id }), isPrecondition, "redeployAll");
      const restDeploy = await deploymentsRoute.POST(rest("/api/v1/deployments", { serviceId: web.id }));
      assert.strictEqual(restDeploy.status, 412);
      assert.deepStrictEqual(await restDeploy.json(), { error: status.problem, code: "RUNNER_NOT_CONFIGURED" });
      const restRedeploy = await deploymentsRoute.POST(rest("/api/v1/deployments", { deploymentId: third[0].id, redeploy: true }));
      assert.strictEqual(restRedeploy.status, 412);
      assert.deepStrictEqual(await countRows(serviceIds), before, "no deployment or build row was created");
      ok("trigger / redeploy / clean rebuild / redeployAll → PRECONDITION_FAILED; REST → 412; zero new deployment/build rows");

      const runnerStatus = await asViewer.deployment.runnerStatus({ health: true });
      assert.strictEqual(runnerStatus.problem, status.problem);
      assert.strictEqual(runnerStatus.health?.online, true, "the daemon itself is up; only the control plane config is wrong");

      await rejects(() => asMember.project.pauseAll({ projectId: portfolio.id }), isPrecondition, "pauseAll");
      await rejects(() => asMember.service.setPaused({ serviceId: web.id, paused: true }), isPrecondition, "setPaused");
      await rejects(() => asMember.service.restart({ serviceId: web.id }), isPrecondition, "restart");
      for (const d of third) {
        assert.ok(isAlive(pidOf(d.id)), "instance still running");
        assert.strictEqual((await prisma.deployment.findUniqueOrThrow({ where: { id: d.id } })).status, "ACTIVE", "not falsely marked stopped");
      }
      await rejects(
        () => asOwner.project.delete({ projectId: portfolio.id, confirmName: `Portfolio-${RUN}` }),
        isPrecondition,
        "delete with unreachable instances"
      );
      for (const id of serviceIds) {
        const svc = await prisma.service.findUniqueOrThrow({ where: { id } });
        assert.strictEqual(svc.isPaused, false, "failed pauseAll changed nothing (not even the idle service)");
        assert.strictEqual(svc.deletedAt, null, "failed delete changed nothing");
      }
      assert.strictEqual((await prisma.project.findUniqueOrThrow({ where: { id: portfolio.id } })).deletedAt, null);
      assert.throws(() => driverFor("webhook"), (e: any) => isRunnerConfigError(e) && e.message === status.problem);
      assert.throws(() => resolveRunnerSecret(), (e: any) => e instanceof AuthenticationError && e.message === status.problem);
      ok("pauseAll / setPaused / restart / delete → PRECONDITION_FAILED and nothing changed: instances ACTIVE and running; driverFor no longer falls back to local");

      // Webhook / cron path: scheduleDeployment is unchanged, logs the problem, and the engine fails
      // the deployment with the same actionable message.
      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };
      try {
        const build = await prisma.build.create({ data: { serviceId: web.id, status: "QUEUED" } });
        const dep = await prisma.deployment.create({ data: { serviceId: web.id, buildId: build.id, status: "QUEUED" } });
        await scheduleDeployment(dep.id, build.id, web.id, { serviceId: web.id, commitMessage: "cron/webhook path" });
        const failed = await waitFor("scheduled deployment FAILED", async () => {
          const row = await prisma.deployment.findUniqueOrThrow({ where: { id: dep.id } });
          return row.status === "FAILED" ? row : null;
        }, 15000);
        assert.strictEqual(failed.errorMessage, status.problem);
        assert.ok(warnings.some((w) => w.includes(`[schedule] deployment ${dep.id}: ${status.problem}`)), "scheduleDeployment logged it");
        await prisma.deploymentJob.deleteMany({ where: { deploymentId: dep.id } });
        await prisma.deployment.delete({ where: { id: dep.id } });
        await prisma.build.delete({ where: { id: build.id } });
      } finally {
        console.warn = origWarn;
      }
      ok("scheduleDeployment (webhook/cron path) logs the problem; the engine records the same message on the deployment");

      // Missing URL with RUNNER_DRIVER=webhook is reported too
      env.RUNNER_SECRET = SECRET;
      const savedUrl = env.RUNNER_URL;
      delete env.RUNNER_URL;
      const noUrl = getRunnerConfigStatus();
      assert.ok(noUrl.problem?.startsWith("Runner not configured: RUNNER_DRIVER=webhook is set but RUNNER_URL is missing"), noUrl.problem);
      env.RUNNER_URL = savedUrl;
    } finally {
      env.NODE_ENV = "development";
      env.RUNNER_SECRET = SECRET;
    }
    assert.strictEqual(getRunnerConfigStatus().problem, undefined);
    ok("RUNNER_DRIVER=webhook without RUNNER_URL is a problem in production; fixed config clears it");

    // ─── 7. Status never leaks the secret; health check ──────────────────────
    console.log("\n[7] Runner status & health");
    env.RUNNER_URL = `https://user:pa55@runner.example.test:8443/base?token=abc`;
    const leaky = JSON.stringify(getRunnerConfigStatus());
    assert.ok(!leaky.includes(SECRET) && !leaky.includes("pa55") && !leaky.includes("token=abc"), leaky);
    assert.strictEqual(getRunnerConfigStatus().urlHost, "runner.example.test:8443");
    env.RUNNER_URL = `http://127.0.0.1:${RUNNER_PORT}`;
    const health = await checkRunnerHealth();
    assert.strictEqual(health.online, true);
    assert.ok(typeof health.latencyMs === "number" && typeof health.uptime === "number" && typeof health.activeJobs === "number", JSON.stringify(health));
    env.RUNNER_URL = `http://127.0.0.1:${DEAD_PORT}`;
    const down = await checkRunnerHealth();
    assert.strictEqual(down.online, false);
    assert.match(down.error || "", /Runner unreachable: ECONNREFUSED/);
    env.RUNNER_URL = `http://127.0.0.1:${GATEWAY_530_PORT}`;
    const tunnelDown = await checkRunnerHealth();
    assert.strictEqual(tunnelDown.online, false);
    assert.strictEqual(tunnelDown.error, "Runner /health returned HTTP 530 (Cloudflare tunnel is not connected)");
    env.RUNNER_URL = `http://127.0.0.1:${RUNNER_PORT}`;
    ok(`status exposes only the host; health online (${health.latencyMs} ms, uptime ${Math.round(health.uptime!)}s), refused → offline, 530 → tunnel hint`);

    // ─── 8. Delete teardown ──────────────────────────────────────────────────
    console.log("\n[8] Delete teardown");
    const hosts = [...resolveServiceHostnames(web), ...resolveServiceHostnames(api)];
    assert.ok(hosts.includes(domain.hostname));
    // (step 6's failed deployment left web's routes FAILED: the engine's existing failure path)
    for (const h of hosts) assert.ok(getServiceRoute(h), `route ${h} registered before delete`);

    await rejects(() => asMember.project.delete({ projectId: portfolio.id, confirmName: `Portfolio-${RUN}` }), (e) => e.code === "FORBIDDEN", "member delete");
    await rejects(() => asOwner.project.delete({ projectId: portfolio.id, confirmName: "portfolio" }), (e) => e.code === "BAD_REQUEST", "wrong confirm name");
    const deleted = await asOwner.project.delete({ projectId: portfolio.id, confirmName: `Portfolio-${RUN}` });
    assert.ok(deleted.deletedAt);
    assert.strictEqual(deleted.teardown.reduce((n, t) => n + t.stopped, 0), 2);
    for (const d of third) {
      await waitFor("deleted process gone", async () => !isAlive(pidOf(d.id)), 10000);
      await rejects(() => viaRunner(d.assignedPort!), () => true, "deleted app no longer answers");
      assert.strictEqual((await prisma.deployment.findUniqueOrThrow({ where: { id: d.id } })).status, "CANCELLED");
    }
    const allocated: number[] = (await (await fetch(`http://127.0.0.1:${RUNNER_PORT}/health`)).json()).allocatedPorts || [];
    for (const d of third) assert.ok(!allocated.includes(d.assignedPort!), `port ${d.assignedPort} freed on the runner`);
    for (const h of hosts) {
      assert.strictEqual(getServiceRoute(h), null, `route ${h} removed`);
      const fromDb = await resolveServiceRouteFromDb(h, { exactHostname: true });
      assert.ok(!fromDb || fromDb.status !== "ACTIVE", `DB resolve of ${h} is not ACTIVE`);
    }
    assert.strictEqual(await prisma.domain.count({ where: { id: domain.id } }), 0, "custom domain released");
    assert.strictEqual(await prisma.service.count({ where: { id: { in: serviceIds }, deletedAt: null } }), 0, "services marked deleted");
    const afterList = await asOwner.project.list({ workspaceId: workspace.id });
    assert.ok(!afterList.some((p) => p.id === portfolio.id), "hidden from list");
    await rejects(() => asOwner.project.byId({ projectId: portfolio.id }), (e) => e.code === "NOT_FOUND", "byId after delete");
    ok("delete: 2 processes stopped, ports freed, deployments CANCELLED, every route removed, domain released, services + project hidden");

    const again = await asOwner.project.create({ workspaceId: workspace.id, name: `Portfolio-${RUN}` });
    assert.notStrictEqual(again.id, portfolio.id);
    ok("a deleted project's name can be reused");

    console.log(`\n✅ verify-project-actions: ${passed} checks passed`);
  } finally {
    await cleanup();
  }
}

main().catch((err) => {
  console.error("\n❌ verify-project-actions failed:", err);
  process.exit(1);
});
