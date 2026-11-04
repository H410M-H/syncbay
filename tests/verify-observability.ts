/**
 * Verification: observability, usage metering and scale-to-zero (Team B).
 *
 * Runs against a REAL Postgres (TEST_DATABASE_URL, else DATABASE_URL, migrated with
 * `prisma migrate deploy`) and a REAL runner daemon started in-process, which
 * builds and runs a real native process. Docker metrics run when `docker` works.
 * Only the Upstash REST calls are mocked (stubbed fetch), and are labelled so.
 *
 *  1. Batched log persistence (≥200 lines flush immediately, small batches ≤250 ms).
 *  2. Stream replay from the DB on a "fresh instance", live follow, cross-instance DB tail, no duplicates.
 *  3. No synthesised history for a deployment without logs.
 *  4. Runner SSE proxy when neither the bus nor the DB has lines.
 *  5. Runner GET /api/metrics/:id — HMAC, /proc for native processes, docker stats for containers.
 *  6. Sampler → MetricSample → metrics.live / metrics.historical.
 *  7. Hourly UsageRecord writer (idempotent) → metrics.workspaceUsage.
 *  8. Spending cap: 80 % warning email once, 100 % pause + billing alert once, wake refused (402).
 *  9. Proxy last-request tracking (DB column, 30 s debounce) and Upstash mode (mocked fetch).
 * 10. Idle sleeper stops the real process and marks the deployment SLEEPING.
 * 11. Engine failure persists Deployment.errorMessage and flushes logs.
 * 12. Cron auth (Bearer CRON_SECRET, timing-safe, no default secret).
 */

import assert from "node:assert";
import { spawn, execFileSync } from "node:child_process";
import * as crypto from "node:crypto";

const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("verify-observability needs TEST_DATABASE_URL (or DATABASE_URL) pointing at a migrated Postgres");
  process.exit(1);
}
process.env.DATABASE_URL = dbUrl;
process.env.DIRECT_URL = process.env.DIRECT_URL || dbUrl;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.VERCEL;
delete process.env.CRON_SECRET;

const RUNNER_PORT = 42110;
const SECRET = crypto.randomBytes(16).toString("hex");
process.env.RUNNER_SECRET = SECRET;
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

function signed(method: string, path: string, body: string) {
  const ts = Date.now().toString();
  const sig = crypto.createHmac("sha256", SECRET).update(`${ts}.${method}.${path}.${body}`).digest("hex");
  return { "X-Syncbay-Signature": `sha256=${sig}`, "X-Syncbay-Timestamp": ts };
}

/** Reads SSE `data:` payloads from a ReadableStream until `stop()` returns true. */
async function collectSse(stream: ReadableStream<Uint8Array>, stop: (events: any[]) => boolean, timeoutMs: number) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const events: any[] = [];
  const statuses: string[] = [];
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  // Keep one outstanding read: abandoning a pending read() would drop its chunk.
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  while (Date.now() < deadline && !stop(events)) {
    pending = pending || reader.read();
    const next = await Promise.race([pending, sleep(Math.max(1, Math.min(250, deadline - Date.now()))).then(() => null)]);
    if (!next) continue;
    pending = null;
    if (next.done) break;
    buf += decoder.decode(next.value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const isStatus = chunk.startsWith("event: status");
      const data = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!data) continue;
      const parsed = JSON.parse(data.slice(6));
      if (isStatus) statuses.push(parsed.status);
      else events.push(parsed);
    }
  }
  await reader.cancel().catch(() => undefined);
  return { events, statuses };
}

async function main() {
  const { db } = await import("../src/lib/db");
  const { logEventBus } = await import("../src/lib/telemetry/event-bus");
  const { createDeploymentLogStream } = await import("../src/lib/telemetry/log-stream");
  const { sampleActiveServices } = await import("../src/lib/telemetry/metrics-sampler");
  const { writeUsageRecords, enforceSpendingCaps } = await import("../src/lib/usage/metering");
  const { sleepIdleServices } = await import("../src/lib/scale/idle-sleeper");
  const activity = await import("../src/lib/scale/activity");
  const { EmailService } = await import("../src/lib/email/service");
  const { appRouter } = await import("../src/server/root");
  const { RunnerDaemon } = await import("../runner/src/index.ts");
  const { PortManager } = await import("../runner/src/port-manager.ts");
  const { BuildPipeline } = await import("../runner/src/pipeline.ts");

  await db.$queryRaw`SELECT 1`;
  console.log(`[observe] real Postgres: ${dbUrl!.replace(/\/\/[^@]*@/, "//***@")}`);

  // ─── Seed ──────────────────────────────────────────────────────────────────
  const tag = `obs${Date.now().toString(36)}`;
  const user = await db.user.create({ data: { email: `${tag}@example.test`, name: "Obs Owner" } });
  const outsider = await db.user.create({ data: { email: `${tag}-out@example.test`, name: "Outsider" } });
  const ws = await db.workspace.create({
    data: { name: `WS ${tag}`, slug: tag, members: { create: { userId: user.id, role: "OWNER" } } },
  });
  const project = await db.project.create({ data: { name: `p-${tag}`, workspaceId: ws.id } });
  const env = await db.environment.create({ data: { name: "production", projectId: project.id } as any });
  const mkService = async (name: string, extra: Record<string, unknown> = {}) => {
    const service = await db.service.create({ data: { name, environmentId: env.id, sourceType: "empty", ...extra } as any });
    const build = await db.build.create({ data: { serviceId: service.id, status: "SUCCEEDED" } });
    const deployment = await db.deployment.create({ data: { serviceId: service.id, buildId: build.id, status: "QUEUED" } });
    return { service, build, deployment };
  };
  const logsSvc = await mkService(`logs${tag}`);
  const emptySvc = await mkService(`empty${tag}`);
  const runSvc = await mkService(`run${tag}`, { idleTimeoutSecs: 60 });
  const usageSvc = await mkService(`use${tag}`);
  const busySvc = await mkService(`busy${tag}`);
  const caller = (userId: string) =>
    appRouter.createCaller({ db, session: { user: { id: userId } }, headers: new Headers() } as any);

  const pm = new PortManager({ rangeStart: 42200, rangeEnd: 42299 });
  const daemon = new RunnerDaemon({
    port: RUNNER_PORT,
    host: "127.0.0.1",
    webhookSecret: SECRET,
    portManager: pm,
    pipeline: new BuildPipeline({ portManager: pm }),
  });
  await daemon.start();
  const runnerBase = process.env.RUNNER_URL!;
  const extraPids: number[] = [];
  let appPid = 0;
  let dockerId: string | null = null;

  try {
    console.log("\n[1] Batched log persistence");
    await step("450 lines → 450 rows with contiguous seq; ≥200-line batches flush without waiting", async () => {
      const id = logsSvc.deployment.id;
      for (let i = 0; i < 450; i++) logEventBus.publish(id, { stream: "stdout", message: `line ${i}` });
      await logEventBus.flush();
      const rows = await db.deploymentLog.findMany({ where: { deploymentId: id }, orderBy: { seq: "asc" } });
      assert.strictEqual(rows.length, 450);
      assert.deepStrictEqual(rows.map((r) => r.seq), Array.from({ length: 450 }, (_, i) => i));
      assert.strictEqual(rows[449].line, "line 449");
    });
    await step("small batch is persisted by the 250 ms timer (no explicit flush)", async () => {
      const id = logsSvc.deployment.id;
      logEventBus.publish(id, { stream: "stderr", message: "Error: timer-flushed" });
      await until(() => db.deploymentLog.count({ where: { deploymentId: id } }).then((n) => n === 451), 1500, "timer flush");
    });

    console.log("\n[2] Stream: replay → live → cross-instance tail");
    await step("fresh instance replays 451 DB lines, then follows bus + DB tail without duplicates", async () => {
      const id = logsSvc.deployment.id;
      logEventBus.clear(id); // simulate another instance: nothing in memory
      const ctrl = new AbortController();
      const stream = createDeploymentLogStream({ deploymentId: id, signal: ctrl.signal, pollMs: 200, allowRunnerProxy: false });
      setTimeout(() => logEventBus.publish(id, { stream: "system", message: "[syncbay] live line" }), 400);
      setTimeout(() => {
        void db.deploymentLog.create({
          data: { id: `log_${crypto.randomUUID()}`, deploymentId: id, seq: 10_000, stream: "stdout", line: "from other instance", ts: new Date() },
        }).then(() => undefined); // PrismaPromise is lazy: it only runs once then() is called
      }, 700);
      const { events, statuses } = await collectSse(
        stream,
        (ev) => ev.some((e) => e.message === "from other instance") && ev.some((e) => e.message === "[syncbay] live line"),
        6000
      );
      ctrl.abort();
      await sleep(600); // let the live line flush, then make sure it was not re-sent from the DB tail
      assert.strictEqual(events[0].message, "line 0");
      assert.strictEqual(events[450].message, "Error: timer-flushed");
      assert.strictEqual(events[450].stream, "stderr");
      assert.ok(events.some((e) => e.message === "[syncbay] live line"), "live line");
      assert.ok(events.some((e) => e.message === "from other instance"), "cross-instance line");
      assert.strictEqual(new Set(events.map((e) => e.id)).size, events.length, "no duplicate ids");
      assert.ok(statuses.includes("QUEUED"), "status event");
    });

    console.log("\n[3] No synthesised history");
    await step("a deployment without logs streams no data lines", async () => {
      const ctrl = new AbortController();
      const stream = createDeploymentLogStream({ deploymentId: emptySvc.deployment.id, signal: ctrl.signal, pollMs: 200, allowRunnerProxy: false });
      const { events, statuses } = await collectSse(stream, () => false, 800);
      ctrl.abort();
      assert.strictEqual(events.length, 0);
      assert.deepStrictEqual(statuses, ["QUEUED"]);
      const history = await caller(user.id).deployment.logs({ deploymentId: emptySvc.deployment.id });
      assert.strictEqual(history.length, 0, "deployment.logs must not synthesise");
      await assert.rejects(caller(outsider.id).deployment.logs({ deploymentId: logsSvc.deployment.id }), (e: any) => e.code === "NOT_FOUND");
    });

    console.log("\n[4] Real runner build + runner SSE proxy");
    const runDepId = runSvc.deployment.id;
    const job = await (async () => {
      const body = JSON.stringify({ deploymentId: runDepId, jobId: runDepId, serviceName: runSvc.service.name, targetPort: 42200 });
      const res = await fetch(`${runnerBase}/api/builds`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...signed("POST", "/api/builds", body) },
        body,
      });
      assert.strictEqual(res.status, 202);
      return until(async () => {
        const p = `/api/builds/${runDepId}`;
        const r = await fetch(`${runnerBase}${p}`, { headers: signed("GET", p, runDepId) });
        const j = await r.json();
        if (j.status === "FAILED") throw new Error(`runner build failed: ${j.error}`);
        return j.status === "ACTIVE" ? j : null;
      }, 60_000, "runner build ACTIVE");
    })();
    const containerId: string = job.containerId;
    const pid = Number(containerId.replace("proc_", ""));
    appPid = pid;
    console.log(`    runner started native process ${containerId} on port ${job.assignedPort}`);
    await step("stream proxies GET /api/builds/:id/logs SSE when bus and DB are empty", async () => {
      const ctrl = new AbortController();
      const stream = createDeploymentLogStream({ deploymentId: runDepId, signal: ctrl.signal, pollMs: 300 });
      const { events } = await collectSse(stream, (ev) => ev.length >= 3, 5000);
      ctrl.abort();
      assert.ok(events.length >= 3, `runner lines (${events.length})`);
      assert.ok(events[0].message.includes(`Build job ${runDepId} accepted`), events[0].message);
      assert.ok(events.every((e) => e.id.startsWith("runner_")));
    });

    console.log("\n[5] Runner GET /api/metrics/:containerId");
    await step("native process via /proc (signed); 401 unsigned; 404 unknown", async () => {
      const p = `/api/metrics/${containerId}`;
      const unsigned = await fetch(`${runnerBase}${p}`);
      assert.strictEqual(unsigned.status, 401);
      const res = await fetch(`${runnerBase}${p}`, { headers: signed("GET", p, p) });
      assert.strictEqual(res.status, 200);
      const m = await res.json();
      assert.strictEqual(m.source, "proc");
      assert.ok(m.memoryMb > 5, `rss ${m.memoryMb} MB`);
      assert.ok(m.pids >= 1);
      const missing = "/api/metrics/proc_999999999";
      const r404 = await fetch(`${runnerBase}${missing}`, { headers: signed("GET", missing, missing) });
      assert.strictEqual(r404.status, 404);
      console.log(`    proc: cpu=${m.cpuPercent}% rss=${m.memoryMb}MB pids=${m.pids}`);
    });
    await step("busy native process reports high CPU", async () => {
      const child = spawn(process.execPath, ["-e", "for(;;){}"], { detached: true, stdio: "ignore" });
      extraPids.push(child.pid!);
      await sleep(300);
      const p = `/api/metrics/proc_${child.pid}`;
      const m = await (await fetch(`${runnerBase}${p}`, { headers: signed("GET", p, p) })).json();
      assert.ok(m.cpuPercent > 50, `cpu ${m.cpuPercent}%`);
      await db.deployment.update({ where: { id: busySvc.deployment.id }, data: { status: "ACTIVE", cfContainerId: `proc_${child.pid}` } });
    });
    let dockerOk = false;
    try {
      execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 });
      dockerOk = true;
    } catch {
      console.log("    (docker unavailable: container metrics step skipped)");
    }
    if (dockerOk) {
      await step("docker container via docker stats", async () => {
        dockerId = execFileSync("docker", ["run", "-d", "--rm", "--name", `sb-b-metrics-${tag}`, "redis:7-alpine"], { encoding: "utf8" }).trim();
        const p = `/api/metrics/${dockerId}`;
        const m = await (await fetch(`${runnerBase}${p}`, { headers: signed("GET", p, p) })).json();
        assert.strictEqual(m.source, "docker");
        assert.ok(m.memoryMb > 0 && m.memoryLimitMb > 0, JSON.stringify(m));
        assert.ok(m.netRxBytes !== null);
        console.log(`    docker: cpu=${m.cpuPercent}% mem=${m.memoryMb}/${m.memoryLimitMb}MB rx=${m.netRxBytes}B`);
      });
    }

    console.log("\n[6] Sampler → MetricSample → metrics router");
    await step("sampleActiveServices stores real samples; live/historical read them", async () => {
      await db.deployment.update({
        where: { id: runDepId },
        data: { status: "ACTIVE", cfContainerId: containerId, completedAt: new Date(Date.now() - 10 * 60_000) },
      });
      const report = await sampleActiveServices();
      assert.ok(report.sampled >= 2, JSON.stringify(report));
      const samples = await db.metricSample.findMany({ where: { deploymentId: runDepId } });
      assert.strictEqual(samples.length, 1);
      assert.strictEqual(samples[0].source, "proc");
      const busy = await db.metricSample.findFirst({ where: { deploymentId: busySvc.deployment.id } });
      assert.ok(busy && busy.cpuPercent > 50, `busy sample cpu ${busy?.cpuPercent}`);
      const live = await caller(user.id).metrics.live({ serviceId: runSvc.service.id });
      assert.strictEqual(live.source, "proc");
      assert.ok(live.point && live.point.memoryUsedMb > 0);
      const hist = await caller(user.id).metrics.historical({ serviceId: busySvc.service.id, period: "1h" });
      assert.strictEqual(hist.points.length, 1);
      assert.ok(hist.points[0].cpuPercent > 50);
      assert.ok(Math.abs(Date.parse(hist.points[0].timestamp) - Date.now()) < 6 * 60_000, hist.points[0].timestamp);
      await assert.rejects(caller(outsider.id).metrics.historical({ serviceId: busySvc.service.id, period: "1h" }), (e: any) => e.code === "NOT_FOUND");
    });

    console.log("\n[7] Hourly usage records");
    const HOUR = 3_600_000;
    const prevHour = new Date(Math.floor(Date.now() / HOUR) * HOUR - HOUR);
    await step("60 samples in the last full hour → CPU-s, GiB-h, egress; idempotent", async () => {
      await db.metricSample.createMany({
        data: Array.from({ length: 60 }, (_, i) => ({
          serviceId: usageSvc.service.id,
          deploymentId: usageSvc.deployment.id,
          containerId: "c_usage",
          source: "docker",
          cpuPercent: 50,
          memoryMb: 512,
          netTxBytes: (i + 1) * 1_000_000,
          netRxBytes: 0,
          sampledAt: new Date(prevHour.getTime() + i * 60_000),
        })),
      });
      await writeUsageRecords();
      await writeUsageRecords(); // re-run must not duplicate
      const recs = await db.usageRecord.findMany({ where: { serviceId: usageSvc.service.id } });
      const by = Object.fromEntries(recs.map((r) => [r.resourceType, r]));
      assert.strictEqual(recs.length, 3);
      assert.ok(Math.abs(by.CPU_ACTIVE_SECONDS.quantity - 1800) < 1e-6, String(by.CPU_ACTIVE_SECONDS.quantity));
      assert.ok(Math.abs(by.MEMORY_GIB_HOURS.quantity - 0.5) < 1e-6, String(by.MEMORY_GIB_HOURS.quantity));
      assert.ok(Math.abs(by.EGRESS_GB.quantity - 0.059) < 1e-9, String(by.EGRESS_GB.quantity));
      assert.strictEqual(by.CPU_ACTIVE_SECONDS.periodStart.getTime(), prevHour.getTime());
      assert.strictEqual(by.CPU_ACTIVE_SECONDS.workspaceId, ws.id);
    });
    await step("workspaceUsage reads month-to-date records", async () => {
      const usage = await caller(user.id).metrics.workspaceUsage({ workspaceId: ws.id });
      // Another run in this workspace may add a little from the live samples above.
      assert.ok(usage.totals.CPU_ACTIVE_SECONDS >= 1800);
      assert.ok(usage.estimatedCostCents >= 4, String(usage.estimatedCostCents)); // 3.6 + 0.25 + 0.531
      assert.ok(usage.usageRecordsCount >= 3);
    });

    console.log("\n[8] Spending cap");
    const sent: Array<{ kind: string; to: unknown }> = [];
    const origWarn = EmailService.sendUsageWarning;
    const origAlert = EmailService.sendBillingAlert;
    (EmailService as any).sendUsageWarning = async (p: any) => {
      sent.push({ kind: "warning", to: p.to });
      return origWarn.call(EmailService, p); // real template render, dev-mode transport
    };
    (EmailService as any).sendBillingAlert = async (p: any) => {
      sent.push({ kind: "alert", to: p.to });
      return origAlert.call(EmailService, p);
    };
    try {
      await step("≥80 % sends one usage warning", async () => {
        const { estimatedCostCents } = await caller(user.id).metrics.workspaceUsage({ workspaceId: ws.id });
        await db.workspace.update({ where: { id: ws.id }, data: { spendingCapCents: Math.ceil(estimatedCostCents / 0.85) } });
        const [r1] = (await enforceSpendingCaps()).filter((r) => r.workspaceId === ws.id);
        assert.ok(r1.warned && !r1.capReached, JSON.stringify(r1));
        const [r2] = (await enforceSpendingCaps()).filter((r) => r.workspaceId === ws.id);
        assert.ok(!r2.warned, "warning only once per month");
        assert.deepStrictEqual(sent.map((s) => s.kind), ["warning"]);
        assert.deepStrictEqual(sent[0].to, [user.email]);
      });
      await step("≥100 % pauses running services, sends one billing alert, wake → 402", async () => {
        await db.deployment.update({ where: { id: usageSvc.deployment.id }, data: { status: "ACTIVE" } });
        await db.workspace.update({ where: { id: ws.id }, data: { spendingCapCents: 1 } });
        // Keep the real process for the idle-sleep step: pause only the usage service here.
        await db.service.updateMany({ where: { id: { in: [runSvc.service.id] } }, data: { isPaused: true } });
        const [r1] = (await enforceSpendingCaps()).filter((r) => r.workspaceId === ws.id);
        assert.ok(r1.capReached && r1.alerted, JSON.stringify(r1));
        assert.ok(r1.paused.includes(usageSvc.service.id));
        const svc = await db.service.findUniqueOrThrow({ where: { id: usageSvc.service.id }, include: { deployments: true } });
        assert.strictEqual(svc.isPaused, true);
        assert.strictEqual(svc.deployments[0].status, "SLEEPING");
        const [r2] = (await enforceSpendingCaps()).filter((r) => r.workspaceId === ws.id);
        assert.ok(!r2.alerted && r2.paused.length === 0);
        assert.deepStrictEqual(sent.map((s) => s.kind), ["warning", "alert"]);

        const { NextRequest } = await import("next/server");
        const { POST } = await import("../src/app/api/v1/services/wake/route");
        const res = await POST(
          new NextRequest("http://localhost/api/v1/services/wake", {
            method: "POST",
            headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
            body: JSON.stringify({ serviceId: usageSvc.service.id }),
          })
        );
        assert.strictEqual(res.status, 402);
        // Raise the cap: state clears so services can be woken again.
        await db.workspace.update({ where: { id: ws.id }, data: { spendingCapCents: 1_000_000 } });
        await enforceSpendingCaps();
        const wsRow = await db.workspace.findUniqueOrThrow({ where: { id: ws.id } });
        assert.strictEqual(wsRow.spendCapReachedAt, null);
        await db.service.update({ where: { id: runSvc.service.id }, data: { isPaused: false } });
      });
    } finally {
      (EmailService as any).sendUsageWarning = origWarn;
      (EmailService as any).sendBillingAlert = origAlert;
    }

    console.log("\n[9] Last-request tracking");
    const { generateDefaultSubdomain } = await import("../src/lib/domain-service");
    const runHost = generateDefaultSubdomain(runSvc.service.name, "production");
    await step("proxy records Service.lastRequestAt for ACTIVE routes, debounced 30 s", async () => {
      const { registerServiceRoute } = await import("../src/lib/edge/service-registry");
      const { proxy } = await import("../src/proxy");
      const { NextRequest } = await import("next/server");
      registerServiceRoute(runHost, job.assignedPort, "ACTIVE", `http://127.0.0.1:${job.assignedPort}`, true);
      const waits: Promise<unknown>[] = [];
      const event = { waitUntil: (p: Promise<unknown>) => waits.push(p) } as any;
      await proxy(new NextRequest(`http://${runHost}/`, { headers: { host: runHost } }), event);
      assert.strictEqual(waits.length, 1);
      await Promise.all(waits);
      const row = await db.service.findUniqueOrThrow({ where: { id: runSvc.service.id } });
      assert.ok(row.lastRequestAt && Date.now() - row.lastRequestAt.getTime() < 5000, String(row.lastRequestAt));
      await proxy(new NextRequest(`http://${runHost}/x`, { headers: { host: runHost } }), event);
      assert.strictEqual(waits.length, 1, "second request within 30 s is debounced");
    });
    await step("Upstash mode writes SET … EX and reads MGET (MOCKED fetch)", async () => {
      const calls: unknown[] = [];
      const realFetch = globalThis.fetch;
      process.env.UPSTASH_REDIS_REST_URL = "https://upstash.mock.invalid";
      process.env.UPSTASH_REDIS_REST_TOKEN = "mock-token";
      globalThis.fetch = (async (_url: any, init: any) => {
        const cmd = JSON.parse(init.body);
        calls.push(cmd);
        const result = cmd[0] === "MGET" ? cmd.slice(1).map((_: string, i: number) => (i === 0 ? "1700000000000" : null)) : "OK";
        return new Response(JSON.stringify({ result }), { status: 200 });
      }) as typeof fetch;
      try {
        await activity.recordServiceRequest(`up-${tag}.syncbay.app`, 1_700_000_000_000);
        const last = await activity.readUpstashActivity([`up-${tag}.syncbay.app`, "other.syncbay.app"]);
        assert.deepStrictEqual(calls[0], ["SET", `syncbay:edge:last:up-${tag}.syncbay.app`, "1700000000000", "EX", "604800"]);
        assert.strictEqual(last, 1_700_000_000_000);
      } finally {
        globalThis.fetch = realFetch;
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
      }
    });

    console.log("\n[10] Idle sleeper");
    await step("recently requested service stays up", async () => {
      const r = await sleepIdleServices();
      assert.ok(!r.slept.some((s) => s.serviceId === runSvc.service.id));
    });
    await step("idle service: real process stopped, deployment SLEEPING, route SLEEPING", async () => {
      await db.service.update({ where: { id: runSvc.service.id }, data: { lastRequestAt: new Date(Date.now() - 10 * 60_000) } });
      const r = await sleepIdleServices();
      const mine = r.slept.find((s) => s.serviceId === runSvc.service.id);
      assert.ok(mine, JSON.stringify(r));
      assert.strictEqual(mine!.containerStopped, true, JSON.stringify(mine));
      await until(async () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }, 5000, "native process exit");
      const dep = await db.deployment.findUniqueOrThrow({ where: { id: runDepId } });
      assert.strictEqual(dep.status, "SLEEPING");
      const { resolveServiceRouteFromDb } = await import("../src/lib/edge/resolve");
      const route = await resolveServiceRouteFromDb(runHost.replace(/\.syncbay\.app$/, ""));
      assert.strictEqual(route?.status, "SLEEPING");
      const logs = await db.deploymentLog.findMany({ where: { deploymentId: runDepId } });
      assert.ok(logs.some((l) => l.line.startsWith("[scale-to-zero] No requests")));
    });

    console.log("\n[11] Engine failure → Deployment.errorMessage");
    await step("failed dispatch persists errorMessage and the error log line", async () => {
      const { executeDeployment } = await import("../src/lib/orchestrator/engine");
      const saved = { url: process.env.RUNNER_URL, fb: process.env.RUNNER_FALLBACK_LOCAL };
      process.env.RUNNER_URL = "http://127.0.0.1:42999";
      process.env.RUNNER_FALLBACK_LOCAL = "false";
      try {
        await assert.rejects(
          executeDeployment(emptySvc.deployment.id, emptySvc.build.id, emptySvc.service.id, { serviceId: emptySvc.service.id, driverType: "webhook" })
        );
      } finally {
        process.env.RUNNER_URL = saved.url;
        process.env.RUNNER_FALLBACK_LOCAL = saved.fb;
      }
      const dep = await db.deployment.findUniqueOrThrow({ where: { id: emptySvc.deployment.id } });
      assert.strictEqual(dep.status, "FAILED");
      assert.ok(dep.errorMessage && dep.errorMessage.length > 0);
      const logs = await db.deploymentLog.findMany({ where: { deploymentId: dep.id }, orderBy: { seq: "asc" } });
      assert.ok(logs.at(-1)!.line.startsWith("[error] Deployment failed"), logs.at(-1)!.line);
      const byId = await caller(user.id).deployment.byId({ deploymentId: dep.id });
      assert.strictEqual(byId.errorMessage, dep.errorMessage);
      console.log(`    errorMessage: ${dep.errorMessage!.slice(0, 90)}`);
    });

    console.log("\n[12] Cron auth");
    await step("Bearer CRON_SECRET required (timing-safe); production without secret → 401", async () => {
      const { isAuthorizedCronRequest } = await import("../src/lib/crons/cron-auth");
      const { GET } = await import("../src/app/api/cron/tick/route");
      const { NextRequest } = await import("next/server");
      const env = process.env as Record<string, string | undefined>;
      const nodeEnv = env.NODE_ENV;
      try {
        env.NODE_ENV = "production";
        assert.strictEqual(isAuthorizedCronRequest(new Headers()), false);
        assert.strictEqual(isAuthorizedCronRequest(new Headers({ "x-vercel-cron": "1" })), false);
        assert.strictEqual(isAuthorizedCronRequest(new Headers({ authorization: "Bearer syncbay-secret-cron-token" })), false);
        env.CRON_SECRET = "cron-test-secret";
        const bad = await GET(new NextRequest("http://localhost/api/cron/tick", { headers: { authorization: "Bearer nope" } }));
        assert.strictEqual(bad.status, 401);
        const good = await GET(new NextRequest("http://localhost/api/cron/tick", { headers: { authorization: "Bearer cron-test-secret" } }));
        assert.strictEqual(good.status, 200);
        const body = await good.json();
        assert.ok("metrics" in body && "recovery" in body);
        env.NODE_ENV = "development";
        delete env.CRON_SECRET;
        assert.strictEqual(isAuthorizedCronRequest(new Headers()), true, "dev without secret is allowed");
      } finally {
        env.NODE_ENV = nodeEnv;
        delete env.CRON_SECRET;
      }
    });

    console.log(`\nverify-observability: ${passed} checks passed`);
  } finally {
    for (const p of extraPids) {
      try {
        process.kill(-p, "SIGKILL");
      } catch {
        // already gone
      }
    }
    if (dockerId) {
      try {
        execFileSync("docker", ["rm", "-f", dockerId], { stdio: "ignore" });
      } catch {
        // ignore
      }
    }
    if (appPid > 1) {
      try {
        process.kill(-appPid, "SIGKILL");
      } catch {
        // already stopped by the idle sleeper
      }
    }
    await daemon.stop();
    const serviceIds = [logsSvc, emptySvc, runSvc, usageSvc, busySvc].map((s) => s.service.id);
    const deploymentIds = [logsSvc, emptySvc, runSvc, usageSvc, busySvc].map((s) => s.deployment.id);
    await db.deploymentLog.deleteMany({ where: { deploymentId: { in: deploymentIds } } });
    await db.metricSample.deleteMany({ where: { serviceId: { in: serviceIds } } });
    await db.usageRecord.deleteMany({ where: { workspaceId: ws.id } });
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => null);
    await db.user.deleteMany({ where: { id: { in: [user.id, outsider.id] } } });
    await db.$disconnect();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("\nverify-observability FAILED:", err);
    process.exit(1);
  }
);
