/**
 * Verification: live dashboard analytics + per-service HTTP traffic (Team B, v1.2).
 *
 * Runs against a REAL Postgres (TEST_DATABASE_URL, else DATABASE_URL, migrated with
 * `prisma migrate deploy`) and a REAL runner daemon started in-process on RUNNER_PORT
 * (default 48110), which builds and runs a real native first-party app (200/404/500/slow paths).
 * Every request below is real HTTP through the runner's reverse proxy (`x-target-port`).
 * Nothing is mocked.
 *
 *  1. analytics.overview counts live services from the LATEST deployment per non-deleted
 *     service (not ACTIVE deployment rows), excludes deleted services/projects, counts
 *     non-deleted projects, deploy success rate + avg build time, live resources, runner status.
 *  2. deploymentTimeline per-day outcome counts; recentActivity (errors, audit for admins only).
 *  3. Runner POST /api/traffic/drain: 401 unsigned, 401 replayed, 405 GET.
 *  4. Real HTTP through the runner proxy → collectTraffic() → TrafficSample (2xx/4xx/5xx, bytes,
 *     latency); a second drain is empty; same-minute drains are summed.
 *  5. analytics.traffic (service + workspace scope, top services, membership).
 *  6. Local-driver path: the in-process store drains the same way; port-based attribution.
 *  7. evaluateCanaryHealth reads the real 5xx rate from TrafficSample (MAINTAIN, then ROLLBACK).
 *  8. Retention purge; runner misconfiguration is reported (no secret in production).
 */

import assert from "node:assert";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("verify-analytics needs TEST_DATABASE_URL (or DATABASE_URL) pointing at a migrated Postgres");
  process.exit(1);
}
process.env.DATABASE_URL = dbUrl;
process.env.DIRECT_URL = process.env.DIRECT_URL || dbUrl;
delete process.env.VERCEL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.RUNNER_QUEUE_MODE;

const RUNNER_PORT = parseInt(process.env.RUNNER_PORT || "48110", 10);
const APP_PORT_RANGE = [48200, 48299] as const;
const SECRET = crypto.randomBytes(16).toString("hex");
process.env.RUNNER_SECRET = SECRET;
delete process.env.RUNNER_WEBHOOK_SECRET;
delete process.env.SYNCBAY_WEBHOOK_SECRET;
process.env.RUNNER_URL = `http://127.0.0.1:${RUNNER_PORT}`;
process.env.RUNNER_DRIVER = "webhook";

let passed = 0;
async function step(name: string, fn: () => Promise<void>) {
  const t0 = Date.now();
  await fn();
  passed += 1;
  console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await sleep(150);
  }
}

/** Canonical runner signature `${ts}.${nonce}.${METHOD}.${path}.${body}` (single-use nonce). */
function signed(method: string, p: string, body: string) {
  const ts = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString("hex");
  const sig = crypto.createHmac("sha256", SECRET).update(`${ts}.${nonce}.${method}.${p}.${body}`).digest("hex");
  return { "X-Syncbay-Signature": `sha256=${sig}`, "X-Syncbay-Timestamp": ts, "X-Syncbay-Nonce": nonce };
}

/** First-party native app the runner builds and runs (plain Node, no dependencies). */
const APP_SOURCE = `const http = require("http");
const port = parseInt(process.env.PORT || "3000", 10);
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/health") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end('{"status":"ok"}'); }
    if (req.url === "/ok") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("A".repeat(64)); }
    if (req.url === "/boom") { res.writeHead(500); return res.end("server error"); }
    if (req.url === "/slow") return setTimeout(() => { res.writeHead(200); res.end("slow"); }, 120);
    if (req.url === "/echo" && req.method === "POST") { res.writeHead(201); return res.end(body); }
    res.writeHead(404); res.end("not found");
  });
}).listen(port, "0.0.0.0", () => console.log("analytics test app on " + port));
`;

async function main() {
  const { db } = await import("../src/lib/db");
  const { appRouter } = await import("../src/server/root");
  const { collectTraffic, purgeOldTraffic } = await import("../src/lib/telemetry/traffic-sampler");
  const { getRunnerConfigStatus } = await import("../src/lib/orchestrator/runner-config");
  const canary = await import("../src/lib/devops/canary-engine");
  const { RunnerDaemon } = await import("../runner/src/index.ts");
  const { PortManager } = await import("../runner/src/port-manager.ts");
  const { BuildPipeline } = await import("../runner/src/pipeline.ts");
  const { getDefaultTrafficStats } = await import("../runner/src/traffic.ts");

  await db.$queryRaw`SELECT 1`;
  console.log(`[analytics] real Postgres: ${dbUrl!.replace(/\/\/[^@]*@/, "//***@")}`);

  // ─── Seed ──────────────────────────────────────────────────────────────────
  const tag = `an${Date.now().toString(36)}`;
  const HOUR = 3_600_000;
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms);
  const user = await db.user.create({ data: { email: `${tag}@example.test`, name: "Analytics Owner" } });
  const outsider = await db.user.create({ data: { email: `${tag}-out@example.test`, name: "Outsider" } });
  const ws1 = await db.workspace.create({ data: { name: `WS1 ${tag}`, slug: `${tag}-1`, spendingCapCents: 1000, members: { create: { userId: user.id, role: "OWNER" } } } });
  const ws2 = await db.workspace.create({ data: { name: `WS2 ${tag}`, slug: `${tag}-2`, members: { create: { userId: user.id, role: "MEMBER" } } } });
  const wsOut = await db.workspace.create({ data: { name: `WSO ${tag}`, slug: `${tag}-o`, members: { create: { userId: outsider.id, role: "OWNER" } } } });
  const mkProject = async (workspaceId: string, name: string, deletedAt: Date | null = null) => {
    const project = await db.project.create({ data: { name, workspaceId, deletedAt } });
    const env = await db.environment.create({ data: { name: "production", isDefault: true, projectId: project.id } });
    return { project, env };
  };
  const pA = await mkProject(ws1.id, `alpha-${tag}`);
  const pDeleted = await mkProject(ws1.id, `gone-${tag}`, new Date());
  const pB = await mkProject(ws2.id, `beta-${tag}`);
  const pOut = await mkProject(wsOut.id, `out-${tag}`);
  type Dep = { status: string; createdAt?: Date; startedAt?: Date; completedAt?: Date; errorMessage?: string };
  const mkService = async (environmentId: string, name: string, deps: Dep[], extra: Record<string, unknown> = {}) => {
    const service = await db.service.create({ data: { name, environmentId, sourceType: "empty", ...extra } as any });
    const build = await db.build.create({ data: { serviceId: service.id, status: "SUCCEEDED", commitSha: "0123456789abcdef", commitMessage: `feat: ${name}` } });
    const rows = [];
    for (const d of deps) {
      rows.push(await db.deployment.create({ data: { serviceId: service.id, buildId: build.id, ...d } as any }));
    }
    return { service, build, deployments: rows };
  };

  // Project A (ws1): live ×2 (one has TWO stale ACTIVE rows), sleeping, building, paused, failed-after-active, never, deleted.
  const live1 = await mkService(pA.env.id, `live1${tag}`, [
    { status: "FAILED", createdAt: ago(2 * 24 * HOUR), errorMessage: "old failure" },
    { status: "ACTIVE", createdAt: ago(30 * 60_000), startedAt: ago(30 * 60_000), completedAt: ago(30 * 60_000 - 10_000) },
  ]);
  const live2 = await mkService(pA.env.id, `live2${tag}`, [
    { status: "ACTIVE", createdAt: ago(3 * HOUR), startedAt: ago(3 * HOUR), completedAt: ago(3 * HOUR - 20_000) },
    { status: "ACTIVE", createdAt: ago(2 * HOUR), startedAt: ago(2 * HOUR), completedAt: ago(2 * HOUR - 30_000) },
  ]);
  const sleeping = await mkService(pA.env.id, `sleep${tag}`, [{ status: "SLEEPING", createdAt: ago(5 * 24 * HOUR), startedAt: ago(5 * 24 * HOUR), completedAt: ago(5 * 24 * HOUR - 40_000) }]);
  const building = await mkService(pA.env.id, `build${tag}`, [{ status: "BUILDING", createdAt: ago(60_000) }]);
  const paused = await mkService(pA.env.id, `pause${tag}`, [{ status: "SLEEPING", createdAt: ago(3 * 24 * HOUR) }], { isPaused: true });
  const failed = await mkService(pA.env.id, `fail${tag}`, [
    { status: "ACTIVE", createdAt: ago(6 * 24 * HOUR) },
    { status: "FAILED", createdAt: ago(2 * HOUR), errorMessage: "Error: npm run build failed (exit code 1)" },
  ]);
  const never = await mkService(pA.env.id, `never${tag}`, []);
  const deletedSvc = await mkService(pA.env.id, `delsvc${tag}`, [{ status: "ACTIVE", createdAt: ago(HOUR) }], { deletedAt: new Date() });
  const inDeletedProject = await mkService(pDeleted.env.id, `delproj${tag}`, [{ status: "ACTIVE", createdAt: ago(HOUR) }]);
  // ws2 (member): the service the runner really runs, created live below.
  const traffic = await mkService(pB.env.id, `web${tag}`, [{ status: "QUEUED", createdAt: ago(10 * 60_000) }]);
  const outSvc = await mkService(pOut.env.id, `outsvc${tag}`, [{ status: "ACTIVE", createdAt: ago(HOUR) }]);
  await db.auditLogEntry.create({ data: { workspaceId: ws1.id, actorUserId: user.id, action: "workspace.spending_cap_updated" } });
  await db.auditLogEntry.create({ data: { workspaceId: ws2.id, actorUserId: user.id, action: "member.invited" } });

  const caller = (userId: string) => appRouter.createCaller({ db, session: { user: { id: userId } }, headers: new Headers() } as any);

  const pm = new PortManager({ rangeStart: APP_PORT_RANGE[0], rangeEnd: APP_PORT_RANGE[1] });
  const daemon = new RunnerDaemon({
    port: RUNNER_PORT,
    host: "127.0.0.1",
    webhookSecret: SECRET,
    portManager: pm,
    pipeline: new BuildPipeline({ portManager: pm }),
    // no `traffic`: the daemon uses the process-wide store, which the local-driver path drains too
  });
  await daemon.start();
  const runnerBase = process.env.RUNNER_URL!;
  const trafficDep = traffic.deployments[0];
  const jobId = `job_${tag}`;
  const workDir = path.join(process.cwd(), ".runner_workspace", jobId);
  let appContainer: string | null = null;

  try {
    console.log("\n[1] analytics.overview");
    await step("services from the latest deployment per non-deleted service; deleted excluded", async () => {
      const ov = await caller(user.id).analytics.overview({ workspaceId: ws1.id });
      assert.strictEqual(ov.workspaces, 1);
      assert.strictEqual(ov.projects, 1, "the deleted project is not counted");
      // The old dashboard counted ACTIVE deployment rows: live1 1 + live2 2 + failed 1 + deleted 2 = 6.
      assert.deepStrictEqual(ov.services, { total: 7, live: 2, sleeping: 1, failed: 1, building: 1, paused: 1, idle: 1 });
      const all = await caller(user.id).analytics.overview();
      assert.strictEqual(all.workspaces, 2);
      assert.strictEqual(all.projects, 2);
      assert.strictEqual(all.services.total, 8);
      assert.strictEqual(all.services.building, 2, "ws2's QUEUED deployment counts as building");
      await assert.rejects(caller(outsider.id).analytics.overview({ workspaceId: ws1.id }), (e: any) => e.code === "NOT_FOUND");
      void [live1, live2, sleeping, building, paused, failed, never, deletedSvc, inDeletedProject, outSvc];
    });
    await step("deploy stats over 24h/7d: success rate and avg build time", async () => {
      const ov = await caller(user.id).analytics.overview({ workspaceId: ws1.id });
      // 24h (non-deleted): live1 ACTIVE(10 s), live2 ACTIVE(20 s) + ACTIVE(30 s), building, failed FAILED.
      assert.deepStrictEqual(
        { ...ov.deploys["24h"] },
        { total: 5, succeeded: 3, failed: 1, inProgress: 1, cancelled: 0, successRate: 75, avgBuildMs: 20_000 }
      );
      // 7d adds sleeping (SLEEPING, 40 s), paused (SLEEPING, no timings), failed's ACTIVE and live1's old FAILED.
      const d7 = ov.deploys["7d"];
      assert.deepStrictEqual([d7.total, d7.succeeded, d7.failed, d7.inProgress], [9, 6, 2, 1]);
      assert.strictEqual(d7.successRate, 75);
      assert.strictEqual(d7.avgBuildMs, 25_000, "mean of 10/20/30/40 s; rows without timings are skipped");
    });
    await step("month-to-date cost against the cap; fresh MetricSample summary for live services only", async () => {
      await db.usageRecord.create({
        data: { serviceId: live1.service.id, workspaceId: ws1.id, resourceType: "CPU_ACTIVE_SECONDS", quantity: 36_000, periodStart: ago(2 * HOUR), periodEnd: ago(HOUR) },
      });
      await db.metricSample.createMany({
        data: [
          { serviceId: live1.service.id, deploymentId: live1.deployments[1].id, containerId: "c1", source: "docker", cpuPercent: 10, memoryMb: 100, memoryLimitMb: 512 },
          { serviceId: live2.service.id, deploymentId: live2.deployments[1].id, containerId: "c2", source: "docker", cpuPercent: 30, memoryMb: 200, memoryLimitMb: 1024 },
          // stale (20 min old) and a non-live service: ignored
          { serviceId: live2.service.id, deploymentId: live2.deployments[1].id, containerId: "c2", source: "docker", cpuPercent: 99, memoryMb: 999, sampledAt: ago(20 * 60_000) },
          { serviceId: sleeping.service.id, containerId: "c3", source: "docker", cpuPercent: 80, memoryMb: 800 },
        ],
      });
      const ov = await caller(user.id).analytics.overview({ workspaceId: ws1.id });
      assert.ok(ov.usage.estimatedCostCents > 0, `cost ${ov.usage.estimatedCostCents}`);
      assert.strictEqual(ov.usage.nearestCap?.workspaceId, ws1.id);
      assert.strictEqual(ov.usage.nearestCap?.capPercent, Math.round((ov.usage.estimatedCostCents / 1000) * 1000) / 10);
      assert.deepStrictEqual(
        { ...ov.resources, newestSampleAt: null },
        { liveServices: 2, sampledServices: 2, cpuPercentAvg: 20, memoryUsedMb: 300, memoryLimitMb: 1536, newestSampleAt: null }
      );
    });
    await step("runner card: webhook mode, host only, health from the real daemon", async () => {
      const ov = await caller(user.id).analytics.overview();
      assert.deepStrictEqual({ ...ov.runner.config, problem: ov.runner.config.problem ?? null }, { mode: "webhook", urlHost: `127.0.0.1:${RUNNER_PORT}`, secretConfigured: true, problem: null });
      assert.strictEqual(ov.runner.health.online, true);
      assert.ok(typeof ov.runner.health.uptime === "number" && typeof ov.runner.health.activeJobs === "number");
      assert.ok(!JSON.stringify(ov).includes(SECRET), "secret never exposed");
    });

    console.log("\n[2] Timeline and activity");
    await step("deploymentTimeline: per-UTC-day outcomes, zero days filled", async () => {
      const tl = await caller(user.id).analytics.deploymentTimeline({ workspaceId: ws1.id, days: 7 });
      assert.strictEqual(tl.series.length, 7);
      const dayOf = (d: Date) => d.toISOString().slice(0, 10);
      const expected = new Map<string, { s: number; f: number; p: number }>();
      const add = (d: Date, k: "s" | "f" | "p") => {
        const e = expected.get(dayOf(d)) || { s: 0, f: 0, p: 0 };
        e[k] += 1;
        expected.set(dayOf(d), e);
      };
      for (const d of [live1.deployments[1], ...live2.deployments, sleeping.deployments[0], paused.deployments[0], failed.deployments[0]]) add(d.createdAt, "s");
      for (const d of [live1.deployments[0], failed.deployments[1]]) add(d.createdAt, "f");
      add(building.deployments[0].createdAt, "p");
      for (const day of tl.series) {
        const e = expected.get(day.day) || { s: 0, f: 0, p: 0 };
        assert.deepStrictEqual([day.succeeded, day.failed, day.inProgress], [e.s, e.f, e.p], day.day);
      }
      assert.deepStrictEqual(tl.totals, { total: 9, succeeded: 6, failed: 2, successRate: 75 });
      const tl30 = await caller(user.id).analytics.deploymentTimeline({ workspaceId: ws1.id, days: 30 });
      assert.strictEqual(tl30.series.length, 30);
    });
    await step("recentActivity: failures carry errorMessage; audit only for owner/admin workspaces", async () => {
      const { items } = await caller(user.id).analytics.recentActivity({ limit: 50 });
      const fail = items.find((i) => i.kind === "deployment" && i.id === failed.deployments[1].id);
      assert.ok(fail && fail.kind === "deployment" && fail.errorMessage?.includes("npm run build failed"));
      assert.ok(fail.kind === "deployment" && fail.commitSha === "0123456");
      const audits = items.filter((i) => i.kind === "audit");
      assert.ok(audits.some((a) => a.kind === "audit" && a.action === "workspace.spending_cap_updated"), "ws1 (OWNER) audit shown");
      assert.ok(!audits.some((a) => a.workspaceId === ws2.id), "ws2 (MEMBER) audit hidden");
      assert.ok(!items.some((i) => i.kind === "deployment" && [deletedSvc.service.id, inDeletedProject.service.id, outSvc.service.id].includes(i.serviceId)));
      const sorted = [...items].sort((a, b) => b.at.localeCompare(a.at));
      assert.deepStrictEqual(items.map((i) => i.id), sorted.map((i) => i.id), "newest first");
    });

    console.log("\n[3] Runner drain route auth");
    await step("unsigned 401, replayed 401, GET 405; a signed drain is accepted once", async () => {
      const p = "/api/traffic/drain";
      assert.strictEqual((await fetch(`${runnerBase}${p}`, { method: "POST", body: "{}" })).status, 401);
      const headers = { "Content-Type": "application/json", ...signed("POST", p, "{}") };
      const ok = await fetch(`${runnerBase}${p}`, { method: "POST", headers, body: "{}" });
      assert.strictEqual(ok.status, 200);
      await ok.json();
      assert.strictEqual((await fetch(`${runnerBase}${p}`, { method: "POST", headers, body: "{}" })).status, 401, "replay");
      assert.strictEqual((await fetch(`${runnerBase}${p}`, { headers: signed("GET", p, p) })).status, 405);
      const tampered = { "Content-Type": "application/json", ...signed("POST", p, "{}") };
      assert.strictEqual((await fetch(`${runnerBase}${p}`, { method: "POST", headers: tampered, body: '{"x":1}' })).status, 401, "body is signed");
    });

    console.log("\n[4] Real traffic through the runner proxy → TrafficSample");
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(path.join(workDir, "server.js"), APP_SOURCE);
    const job = await (async () => {
      const body = JSON.stringify({ jobId, deploymentId: trafficDep.id, serviceId: traffic.service.id, serviceName: traffic.service.name, targetPort: 3000 });
      const res = await fetch(`${runnerBase}/api/builds`, { method: "POST", headers: { "Content-Type": "application/json", ...signed("POST", "/api/builds", body) }, body });
      assert.strictEqual(res.status, 202);
      return until(async () => {
        const p = `/api/builds/${jobId}`;
        const j = await (await fetch(`${runnerBase}${p}`, { headers: signed("GET", p, jobId) })).json();
        if (j.status === "FAILED") throw new Error(`runner build failed: ${j.error}`);
        return j.status === "ACTIVE" ? j : null;
      }, 60_000, "runner build ACTIVE");
    })();
    appContainer = job.containerId;
    const appPort: number = job.assignedPort;
    assert.ok(String(appContainer).startsWith("proc_"), `native process expected, got ${appContainer}`);
    await db.deployment.update({
      where: { id: trafficDep.id },
      data: { status: "ACTIVE", cfContainerId: appContainer, assignedPort: appPort, startedAt: ago(60_000), completedAt: new Date() },
    });
    console.log(`    runner started ${appContainer} on port ${appPort}`);
    // Canary on the real deployment (stable = an earlier deployment of the same service).
    const stableDep = await db.deployment.create({ data: { serviceId: traffic.service.id, buildId: traffic.build.id, status: "SUPERSEDED", createdAt: ago(20 * 60_000) } });
    await db.canaryConfig.create({
      data: {
        serviceId: traffic.service.id,
        stableDeploymentId: stableDep.id,
        canaryDeploymentId: trafficDep.id,
        stableUpstreamUrl: "http://127.0.0.1:1",
        canaryUpstreamUrl: `http://127.0.0.1:${appPort}`,
        weightPercent: 50,
        autoRollbackThreshold5xxPercent: 50,
        startedAt: ago(5 * 60_000),
      },
    });
    await step("canary with no traffic yet: INSUFFICIENT_DATA, null rate", async () => {
      const res = await canary.evaluateCanaryHealth(db, traffic.service.id);
      assert.strictEqual(res.action, "INSUFFICIENT_DATA");
      assert.strictEqual(res.errorRatePercent, null);
    });

    const via = async (p: string, init: RequestInit = {}) => {
      const r = await fetch(`${runnerBase}${p}`, { ...init, headers: { ...(init.headers as any), "x-target-port": String(appPort) } });
      const text = await r.text();
      return { status: r.status, text };
    };
    const expected = { requests: 0, s2xx: 0, s4xx: 0, s5xx: 0, bytesIn: 0, bytesOut: 0 };
    const send = async (p: string, n: number, init: RequestInit = {}) => {
      for (let i = 0; i < n; i++) {
        const r = await via(p, init);
        expected.requests += 1;
        expected.bytesOut += Buffer.byteLength(r.text);
        expected.bytesIn += init.body ? Buffer.byteLength(String(init.body)) : 0;
        if (r.status < 300) expected.s2xx += 1;
        else if (r.status >= 500) expected.s5xx += 1;
        else if (r.status >= 400) expected.s4xx += 1;
      }
    };
    const rowsFor = () => db.trafficSample.findMany({ where: { deploymentId: trafficDep.id } });
    const sum = (rows: any[], k: string) => rows.reduce((n, r) => n + Number(r[k]), 0);

    await step("2xx/4xx/5xx, bytes and latency from real requests land in TrafficSample", async () => {
      const drainedBefore = await collectTraffic(); // clears anything counted so far (none expected)
      assert.strictEqual(drainedBefore.source, "runner");
      await send("/ok", 10);
      await send("/nope", 3);
      await send("/boom", 2);
      await send("/slow", 1);
      await send("/echo", 1, { method: "POST", body: "B".repeat(500) });
      assert.deepStrictEqual([expected.requests, expected.s2xx, expected.s4xx, expected.s5xx], [17, 12, 3, 2]);
      const report = await collectTraffic();
      assert.strictEqual(report.source, "runner");
      assert.strictEqual(report.requests, 17, JSON.stringify(report));
      assert.strictEqual(report.unmatched, 0);
      assert.ok(report.written >= 1);
      const rows = await rowsFor();
      assert.ok(rows.every((r) => r.serviceId === traffic.service.id && r.bucketStart.getUTCSeconds() === 0 && r.bucketStart.getUTCMilliseconds() === 0));
      assert.deepStrictEqual(
        ["requests", "s2xx", "s3xx", "s4xx", "s5xx", "errors", "bytesIn", "bytesOut"].map((k) => sum(rows, k)),
        [17, 12, 0, 3, 2, 0, 500, expected.bytesOut]
      );
      assert.ok(Math.max(...rows.map((r) => r.latencyMaxMs)) >= 100, "the /slow request is visible in max latency");
      assert.strictEqual(sum(rows, "lt50") + sum(rows, "lt200") + sum(rows, "lt1000") + sum(rows, "ge1000"), 17);
      console.log(`    rows=${rows.length} bytesOut=${expected.bytesOut} maxLatency=${Math.max(...rows.map((r) => r.latencyMaxMs))}ms`);
    });
    await step("a second drain is empty and changes nothing", async () => {
      const report = await collectTraffic();
      assert.deepStrictEqual([report.entries, report.written, report.requests], [0, 0, 0]);
      assert.strictEqual(sum(await rowsFor(), "requests"), 17);
    });
    await step("drains landing in the same minute are summed (ON CONFLICT), never duplicated", async () => {
      await send("/ok", 2);
      await send("/boom", 1);
      await collectTraffic();
      await send("/ok", 2);
      await collectTraffic();
      const rows = await rowsFor();
      assert.strictEqual(sum(rows, "requests"), 22);
      assert.strictEqual(sum(rows, "s5xx"), 3);
      const minutes = rows.map((r) => r.bucketStart.toISOString());
      assert.strictEqual(new Set(minutes).size, minutes.length, "one row per (service, deployment, minute)");
    });

    console.log("\n[5] analytics.traffic");
    await step("service scope: totals, error rate, histogram, points; membership enforced", async () => {
      const t = await caller(user.id).analytics.traffic({ serviceId: traffic.service.id, period: "1h" });
      assert.strictEqual(t.hasData, true);
      assert.deepStrictEqual([t.totals.requests, t.totals.s2xx, t.totals.s4xx, t.totals.s5xx, t.totals.errors], [22, 16, 3, 3, 0]);
      assert.strictEqual(t.totals.errorRatePercent, Math.round((3 / 22) * 10000) / 100);
      assert.strictEqual(t.totals.bytesIn, 500);
      assert.ok(t.totals.latencyAvgMs !== null && t.totals.latencyMaxMs! >= 100);
      assert.strictEqual(t.histogram.lt50 + t.histogram.lt200 + t.histogram.lt1000 + t.histogram.ge1000, 22);
      assert.strictEqual(t.points.length, 12);
      assert.strictEqual(t.points.reduce((n, p) => n + p.requests, 0), 22);
      assert.strictEqual(t.topServices[0].serviceId, traffic.service.id);
      await assert.rejects(caller(outsider.id).analytics.traffic({ serviceId: traffic.service.id }), (e: any) => e.code === "NOT_FOUND");
    });
    await step("workspace scope: all workspaces include ws2 traffic, ws1 alone has none", async () => {
      const all = await caller(user.id).analytics.traffic({ period: "24h" });
      assert.strictEqual(all.totals.requests, 22);
      assert.strictEqual(all.topServices[0].projectName, pB.project.name);
      const ws1Only = await caller(user.id).analytics.traffic({ workspaceId: ws1.id, period: "24h" });
      assert.deepStrictEqual([ws1Only.totals.requests, ws1Only.hasData, ws1Only.points.length], [0, false, 24]);
    });

    console.log("\n[6] Local-driver path (in-process store) and port attribution");
    await step("without RUNNER_URL the in-process store drains the same way; unknown ids map by port", async () => {
      // Opened without a job identity (as the local driver's in-process proxy would), so the
      // bucket — including the two real proxied requests that follow in the same minute — is
      // attributed by port: the ACTIVE deployment whose assignedPort matches.
      getDefaultTrafficStats().record(appPort, { status: 503, latencyMs: 7, bytesIn: 0, bytesOut: 10 });
      await send("/ok", 2); // real requests, counted by the in-process daemon in the process-wide store
      const saved = process.env.RUNNER_URL;
      delete process.env.RUNNER_URL;
      try {
        const report = await collectTraffic();
        assert.strictEqual(report.source, "in-process");
        assert.strictEqual(report.requests, 3);
        assert.strictEqual(report.unmatched, 0, "port → the ACTIVE deployment with that assignedPort");
      } finally {
        process.env.RUNNER_URL = saved;
      }
      const rows = await rowsFor();
      assert.deepStrictEqual([sum(rows, "requests"), sum(rows, "s5xx")], [25, 4]);
    });

    console.log("\n[7] Canary health from real TrafficSample rates");
    await step("4/25 = 16% 5xx: MAINTAIN under a 50% threshold, ROLLBACK under 5%", async () => {
      const ok = await canary.evaluateCanaryHealth(db, traffic.service.id);
      assert.strictEqual(ok.action, "MAINTAIN", ok.reason);
      assert.deepStrictEqual([ok.requests, ok.errors5xx, ok.errorRatePercent], [25, 4, 16]);
      await db.canaryConfig.update({ where: { serviceId: traffic.service.id }, data: { autoRollbackThreshold5xxPercent: 5 } });
      const rb = await canary.evaluateCanaryHealth(db, traffic.service.id);
      assert.strictEqual(rb.action, "ROLLBACK");
      assert.strictEqual(rb.errorRatePercent, 16);
      const cfg = await canary.getCanaryConfig(db, traffic.service.id);
      assert.deepStrictEqual([cfg!.status, cfg!.canaryWeightPercent], ["ROLLED_BACK", 0]);
    });

    console.log("\n[8] Retention and runner misconfiguration");
    await step("purgeOldTraffic drops buckets older than the retention window only", async () => {
      await db.trafficSample.create({ data: { serviceId: traffic.service.id, deploymentId: stableDep.id, bucketStart: ago(40 * 24 * HOUR), requests: 5 } });
      const purged = await purgeOldTraffic(35);
      assert.ok(purged >= 1);
      assert.strictEqual(await db.trafficSample.count({ where: { deploymentId: stableDep.id } }), 0);
      assert.strictEqual(sum(await rowsFor(), "requests"), 25);
    });
    await step("production without RUNNER_SECRET: actionable problem, no secret leaked", async () => {
      const env = process.env as Record<string, string | undefined>;
      const savedEnv = env.NODE_ENV;
      delete env.RUNNER_SECRET;
      env.NODE_ENV = "production";
      try {
        const st = getRunnerConfigStatus();
        assert.strictEqual(st.mode, "webhook");
        assert.strictEqual(st.secretConfigured, false);
        assert.match(st.problem || "", /RUNNER_URL is set but RUNNER_SECRET is missing/);
      } finally {
        env.NODE_ENV = savedEnv;
        env.RUNNER_SECRET = SECRET;
      }
    });

    console.log(`\nverify-analytics: ${passed} checks passed against real Postgres + a real runner daemon`);
  } finally {
    if (appContainer) await daemon.stopInstance(appContainer).catch(() => null);
    await daemon.stop();
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => null);
    const wsIds = [ws1.id, ws2.id, wsOut.id];
    const serviceIds = (await db.service.findMany({ where: { environment: { project: { workspaceId: { in: wsIds } } } }, select: { id: true } })).map((s) => s.id);
    await db.trafficSample.deleteMany({ where: { serviceId: { in: serviceIds } } });
    await db.metricSample.deleteMany({ where: { serviceId: { in: serviceIds } } });
    await db.usageRecord.deleteMany({ where: { workspaceId: { in: wsIds } } });
    await db.auditLogEntry.deleteMany({ where: { workspaceId: { in: wsIds } } });
    await db.deployment.deleteMany({ where: { serviceId: { in: serviceIds } } });
    await db.workspace.deleteMany({ where: { id: { in: wsIds } } });
    await db.user.deleteMany({ where: { id: { in: [user.id, outsider.id] } } });
    await db.$disconnect();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("\nverify-analytics FAILED:", err);
    process.exit(1);
  }
);
