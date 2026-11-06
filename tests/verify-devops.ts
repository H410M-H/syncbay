/**
 * Verification Test: DevOps engines against REAL Postgres + a REAL local HTTP server
 *
 * Needs a migrated Postgres: TEST_DATABASE_URL (default postgresql://syncbay:syncbay@localhost:5432/sb_e).
 * 1. CronJob CRUD on real rows; next-run calculation.
 * 2. runDueCronJobs(now) calls a real HTTP server: success, retry-until-success,
 *    timeout, non-retryable 404, disabled jobs skipped; CronRun rows recorded;
 *    concurrent invocations never double-claim an occurrence.
 * 3. WAF through the real `proxy()` function: CIDR block, path block, rate limit
 *    (in-memory counter) and hit counters flushed to WafRule rows.
 *    The Upstash rate counter is exercised against a stubbed fetch (MOCKED).
 * 4. Canary weighted split through `proxy()`: ~30% of 2000 cookieless requests,
 *    sticky cookie pinning, stats flushed to CanaryConfig, rollback behaviour,
 *    evaluateCanaryHealth against a real MetricSample row (CPU/memory only → null rate)
 *    and with INJECTED request/5xx counts (real CanaryConfig rows).
 * 5. applyVercelMigration writes CronJob/WafRule rows.
 */

import assert from "node:assert";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "postgresql://syncbay:syncbay@localhost:5432/sb_e";
process.env.DIRECT_URL = process.env.DATABASE_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.RUNNER_URL;

const PORT_BASE = 45100;

interface Hit {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function startServer(port: number) {
  const hits: Hit[] = [];
  let flakyCount = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method || "", url: req.url || "", headers: req.headers, body });
      const path = (req.url || "").split("?")[0];
      if (path === "/tick") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true, received: body }));
      }
      if (path === "/flaky") {
        flakyCount++;
        if (flakyCount <= 2) {
          res.writeHead(503);
          return res.end("warming up");
        }
        res.writeHead(200);
        return res.end("ok after retries");
      }
      if (path === "/slow") {
        setTimeout(() => {
          res.writeHead(200);
          res.end("too late");
        }, 2500);
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, hits, port: (server.address() as AddressInfo).port };
}

async function main() {
  const { NextRequest } = await import("next/server");
  const { db } = await import("../src/lib/db");
  const cron = await import("../src/lib/devops/cron-engine");
  const { runDueCronJobs, executeCronJob } = await import("../src/lib/devops/cron-runner");
  const waf = await import("../src/lib/devops/waf-engine");
  const canary = await import("../src/lib/devops/canary-engine");
  const { flushWafHits, UpstashRateCounter } = await import("../src/lib/edge/waf");
  const { flushCanaryStats, CANARY_COOKIE } = await import("../src/lib/edge/canary");
  const { clearEdgePolicyCache } = await import("../src/lib/edge/edge-policy");
  const { registerServiceRoute, clearServiceRoutes } = await import("../src/lib/edge/service-registry");
  const { applyVercelMigration, parseVercelConfig } = await import("../src/lib/devops/vercel-migrator");
  const { proxy } = await import("../src/proxy");

  const suffix = Math.random().toString(36).slice(2, 8);
  const svcName = `cron${suffix}`;
  const host = `${svcName}-production.syncbay.app`;
  const srv = await startServer(PORT_BASE + Math.floor(Math.random() * 400));
  const upstream = `http://127.0.0.1:${srv.port}`;
  const activate = () => registerServiceRoute(host, srv.port, "ACTIVE", upstream, true);

  // ─── Seed ──────────────────────────────────────────────────────────────────
  const user = await db.user.create({ data: { email: `devops-${suffix}@example.test`, name: "DevOps Test" } });
  const workspace = await db.workspace.create({ data: { name: "DevOps Test", slug: `devops-${suffix}` } });
  await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
  const project = await db.project.create({ data: { workspaceId: workspace.id, name: "devops" } });
  const env = await db.environment.create({ data: { projectId: project.id, name: "production", isDefault: true } });
  const service = await db.service.create({ data: { environmentId: env.id, name: svcName, sourceType: "github", port: srv.port } });

  let failures = 0;
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      console.log(`  ✔ ${name}`);
    } catch (err: any) {
      failures++;
      console.error(`  ✘ ${name}\n    ${err?.stack || err}`);
    }
  };

  try {
    console.log("\n[1] CronJob CRUD (real Postgres)");
    const t0 = new Date("2026-11-04T12:00:30Z");
    let tickId = "";
    await step("create / list / toggle / runs list", async () => {
      const job = await cron.createCronJob(
        db,
        { serviceId: service.id, name: "tick", schedule: "* * * * *", path: "/tick?src=cron", method: "POST", headers: { "x-api-key": "test-key" } },
        t0
      );
      tickId = job.id;
      assert.strictEqual(job.nextRunAt, "2026-11-04T12:01:00.000Z");
      const listed = await cron.listCronJobs(db, service.id);
      assert.strictEqual(listed.length, 1);
      await assert.rejects(() => cron.createCronJob(db, { serviceId: service.id, name: "x", schedule: "61 * * * *", path: "/x" }));
      await assert.rejects(() => cron.createCronJob(db, { serviceId: service.id, name: "x", schedule: "* * * * *", path: "//evil.test/x" }));
    });

    console.log("\n[2] runDueCronJobs → real HTTP");
    const flaky = await cron.createCronJob(db, { serviceId: service.id, name: "flaky", schedule: "* * * * *", path: "/flaky", maxRetries: 2 }, t0);
    const slow = await cron.createCronJob(db, { serviceId: service.id, name: "slow", schedule: "* * * * *", path: "/slow", timeoutMs: 1000, maxRetries: 0 }, t0);
    const missing = await cron.createCronJob(db, { serviceId: service.id, name: "missing", schedule: "* * * * *", path: "/nope", maxRetries: 3 }, t0);
    const off = await cron.createCronJob(db, { serviceId: service.id, name: "off", schedule: "* * * * *", path: "/tick" }, t0);
    await cron.toggleCronJob(db, off.id, false, t0);
    // POST body for the tick job
    await db.cronJob.update({ where: { id: tickId }, data: { body: JSON.stringify({ hello: "cron" }) } });

    const runAt = new Date("2026-11-04T12:01:05Z");
    await step("due jobs execute with timeout/retry semantics and CronRun rows", async () => {
      activate();
      const summary = await runDueCronJobs(runAt, { retryBaseMs: 50 });
      const ours = summary.results.filter((r) => [tickId, flaky.id, slow.id, missing.id].includes(r.jobId));
      assert.strictEqual(ours.length, 4, `expected 4 executions, got ${ours.length}`);
      const by = (id: string) => ours.find((r) => r.jobId === id)!;
      assert.strictEqual(by(tickId).status, "SUCCESS");
      assert.strictEqual(by(tickId).statusCode, 200);
      assert.ok(by(tickId).responseSnippet?.includes("hello"), "response snippet recorded");
      assert.strictEqual(by(flaky.id).status, "SUCCESS");
      assert.strictEqual(by(flaky.id).attempts, 3, "503, 503, then 200");
      assert.strictEqual(by(slow.id).status, "TIMEOUT");
      assert.strictEqual(by(missing.id).status, "FAILED");
      assert.strictEqual(by(missing.id).statusCode, 404);
      assert.strictEqual(by(missing.id).attempts, 1, "4xx is not retried");
      assert.ok(!summary.results.some((r) => r.jobId === off.id), "disabled job skipped");

      const tickHit = srv.hits.find((h) => h.url === "/tick?src=cron");
      assert.ok(tickHit, "server received the cron request");
      assert.strictEqual(tickHit!.method, "POST");
      assert.strictEqual(tickHit!.headers["x-api-key"], "test-key");
      assert.strictEqual(tickHit!.headers["x-syncbay-cron-job"], tickId);
      assert.strictEqual(tickHit!.body, JSON.stringify({ hello: "cron" }));

      const runs = await db.cronRun.findMany({ where: { cronJobId: { in: [tickId, flaky.id, slow.id, missing.id] } } });
      assert.strictEqual(runs.length, 4);
      const job = await db.cronJob.findUniqueOrThrow({ where: { id: tickId } });
      assert.strictEqual(job.lastStatus, "SUCCESS");
      assert.strictEqual(job.nextRunAt.toISOString(), "2026-11-04T12:02:00.000Z", "nextRunAt advanced");
      assert.strictEqual(job.lockedUntil, null, "lease released");
    });

    await step("same occurrence is not re-run; concurrent invocations claim once", async () => {
      const again = await runDueCronJobs(runAt, { retryBaseMs: 50 });
      assert.ok(!again.results.some((r) => r.jobId === tickId), "already-advanced job not re-run");
      const nextMinute = new Date("2026-11-04T12:02:10Z");
      await db.cronJob.updateMany({ where: { id: { in: [flaky.id, slow.id, missing.id] } }, data: { enabled: false } });
      activate();
      const [a, b] = await Promise.all([runDueCronJobs(nextMinute), runDueCronJobs(nextMinute)]);
      const count = [...a.results, ...b.results].filter((r) => r.jobId === tickId).length;
      assert.strictEqual(count, 1, `tick claimed ${count} times by two concurrent runs`);
    });

    await step("manual trigger records a manual CronRun", async () => {
      activate();
      const run = await executeCronJob(tickId, { trigger: "manual" });
      assert.strictEqual(run.trigger, "manual");
      assert.strictEqual(run.status, "SUCCESS");
      const logs = await cron.listCronRuns(db, tickId);
      assert.ok(logs.length >= 3);
    });

    console.log("\n[3] WAF through proxy()");
    const req = (path: string, ip: string, cookie?: string) =>
      new NextRequest(`http://${host}${path}`, {
        headers: { host, "x-forwarded-for": `${ip}, 10.0.0.1`, ...(cookie ? { cookie } : {}) },
      });
    await step("CIDR + path blocks return 403; clean traffic is rewritten", async () => {
      await waf.updateWafConfig(db, service.id, { ipBlocklist: ["203.0.113.0/24"], pathBlocklist: ["/wp-admin/*"] });
      clearEdgePolicyCache();
      activate();
      const blocked = await proxy(req("/", "203.0.113.77"));
      assert.strictEqual(blocked.status, 403);
      assert.strictEqual(blocked.headers.get("x-syncbay-waf"), "IP_BLOCK");
      const pathBlocked = await proxy(req("/wp-admin/install.php", "198.51.100.1"));
      assert.strictEqual(pathBlocked.status, 403);
      const ok = await proxy(req("/hello", "198.51.100.1"));
      assert.strictEqual(ok.status, 200);
      assert.ok(ok.headers.get("x-middleware-rewrite")?.startsWith(upstream), "clean request rewritten to upstream");
    });

    await step("rate limit (5 rpm) returns 429 with Retry-After on the 6th request", async () => {
      await waf.updateWafConfig(db, service.id, { rateLimitRpm: 5 });
      clearEdgePolicyCache();
      activate();
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) statuses.push((await proxy(req("/api/x", "192.0.2.50"))).status);
      assert.deepStrictEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
      const other = await proxy(req("/api/x", "192.0.2.51"));
      assert.strictEqual(other.status, 200, "limit is per client IP");
      const limited = await proxy(req("/api/x", "192.0.2.50"));
      assert.ok(Number(limited.headers.get("retry-after")) > 0);
    });

    await step("hit counters flush to WafRule rows and surface as security events", async () => {
      await flushWafHits();
      const events = await waf.getSecurityEvents(db, service.id);
      const types = events.map((e) => e.actionTaken).sort();
      assert.deepStrictEqual(types, ["BLOCKED_429", "BLOCKED_IP", "BLOCKED_PATH"]);
      const rl = events.find((e) => e.actionTaken === "BLOCKED_429")!;
      assert.strictEqual(rl.hitCount, 3);
      assert.strictEqual(rl.clientIp, "192.0.2.50");
      const config = await waf.getWafConfig(db, service.id);
      assert.deepStrictEqual(config.ipBlocklist, ["203.0.113.0/24"]);
      assert.strictEqual(config.rateLimitRpm, 5);
    });

    await step("Upstash fixed-window counter (MOCKED fetch)", async () => {
      const store = new Map<string, number>();
      const realFetch = globalThis.fetch;
      let auth = "";
      globalThis.fetch = (async (_url: any, init: any) => {
        auth = init.headers.Authorization;
        const cmds = JSON.parse(init.body) as string[][];
        const out = cmds.map(([op, key]) => {
          if (op === "INCR") {
            store.set(key, (store.get(key) || 0) + 1);
            return { result: store.get(key) };
          }
          return { result: 1 };
        });
        return new Response(JSON.stringify(out), { status: 200 });
      }) as typeof fetch;
      try {
        const counter = new UpstashRateCounter("https://upstash.mock.local", "tok");
        const rules = [{ id: "rl", type: "RATE_LIMIT", value: "/*", rateLimitRpm: 2, enabled: true }];
        const d = [];
        for (let i = 0; i < 3; i++) d.push(await waf.inspectRequest(rules, { ip: "1.1.1.1", path: "/" }, counter));
        assert.deepStrictEqual(d.map((x) => x.status), [200, 200, 429]);
        assert.strictEqual(auth, "Bearer tok");
        assert.ok([...store.keys()][0].startsWith("syncbay:waf:rl:rl:1.1.1.1:"));
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    // Clear WAF rules so canary traffic isn't rate limited
    await db.wafRule.deleteMany({ where: { serviceId: service.id } });

    console.log("\n[4] Canary split through proxy()");
    const build = await db.build.create({ data: { serviceId: service.id, status: "SUCCEEDED" } });
    const stableDep = await db.deployment.create({ data: { serviceId: service.id, buildId: build.id, status: "ACTIVE" } });
    const canaryDep = await db.deployment.create({ data: { serviceId: service.id, buildId: build.id, status: "ACTIVE" } });
    const stablePort = srv.port;
    const canaryPort = srv.port + 1;
    let routed = 0;
    await step("30% weight splits 2000 cookieless requests within ±4%", async () => {
      await assert.rejects(() => canary.startCanary(db, { serviceId: service.id, stableDeploymentId: stableDep.id, canaryDeploymentId: canaryDep.id }), /Upstream URLs are unknown/);
      await canary.startCanary(db, {
        serviceId: service.id,
        stableDeploymentId: stableDep.id,
        canaryDeploymentId: canaryDep.id,
        stableUpstreamUrl: `http://127.0.0.1:${stablePort}`,
        canaryUpstreamUrl: `http://127.0.0.1:${canaryPort}`,
        weightPercent: 30,
      });
      clearEdgePolicyCache();
      let canaryHits = 0;
      for (let i = 0; i < 2000; i++) {
        if (i % 500 === 0) activate();
        const res = await proxy(req(`/p${i}`, "198.51.100.9"));
        const target = res.headers.get("x-middleware-rewrite") || "";
        if (target.startsWith(`http://127.0.0.1:${canaryPort}/`)) canaryHits++;
        else assert.ok(target.startsWith(`http://127.0.0.1:${stablePort}/`), `unexpected target ${target}`);
        assert.ok((res.headers.get("set-cookie") || "").includes(`${CANARY_COOKIE}=`), "sticky cookie issued");
        routed++;
      }
      const pct = (canaryHits / 2000) * 100;
      console.log(`    canary share: ${pct.toFixed(1)}% (${canaryHits}/2000)`);
      assert.ok(Math.abs(pct - 30) <= 4, `canary share ${pct}% not within 30±4%`);
    });

    await step("sticky cookie pins a client to one variant", async () => {
      activate();
      const first = await proxy(req("/sticky", "198.51.100.10"));
      const cookie = (first.headers.get("set-cookie") || "").split(";")[0];
      const firstTarget = new URL(first.headers.get("x-middleware-rewrite")!).port;
      routed++;
      for (let i = 0; i < 25; i++) {
        const res = await proxy(req("/sticky", "198.51.100.10", cookie));
        assert.strictEqual(new URL(res.headers.get("x-middleware-rewrite")!).port, firstTarget);
        assert.strictEqual(res.headers.get("set-cookie"), null, "pinned client gets no new cookie");
        routed++;
      }
    });

    await step("routed-request stats flush to CanaryConfig", async () => {
      await flushCanaryStats();
      const cfg = await canary.getCanaryConfig(db, service.id);
      assert.strictEqual(cfg!.totalRequestsRouted, routed);
      const share = (cfg!.canaryRequestsRouted / cfg!.totalRequestsRouted) * 100;
      assert.ok(share > 20 && share < 40);
    });

    await step("evaluateCanaryHealth: null rate from real MetricSample rows; injected 5xx counts trip rollback", async () => {
      await db.metricSample.create({
        data: { serviceId: service.id, deploymentId: canaryDep.id, containerId: "proc_1", source: "proc", cpuPercent: 3.5, memoryMb: 42 },
      });
      const res = await canary.evaluateCanaryHealth(db, service.id);
      assert.strictEqual(res.action, "INSUFFICIENT_DATA");
      assert.strictEqual(res.errorRatePercent, null);
      assert.match(res.reason, /1 CPU\/memory sample/);
      const injected = await canary.evaluateCanaryHealth(db, service.id, {
        errorCounts: async () => ({ requests: 100, errors5xx: 10 }), // INJECTED counts (no real 5xx source exists)
      });
      assert.strictEqual(injected.action, "ROLLBACK");
      assert.strictEqual(injected.errorRatePercent, 10);
      const cfg = await canary.getCanaryConfig(db, service.id);
      assert.strictEqual(cfg!.status, "ROLLED_BACK");
      assert.strictEqual(cfg!.canaryWeightPercent, 0);
    });

    await step("after rollback: stable serves while the live route is the canary; a new deploy is not overridden", async () => {
      clearEdgePolicyCache();
      clearServiceRoutes();
      registerServiceRoute(host, canaryPort, "ACTIVE", `http://127.0.0.1:${canaryPort}`, true);
      const res = await proxy(req("/after", "198.51.100.11"));
      assert.ok(res.headers.get("x-middleware-rewrite")!.startsWith(`http://127.0.0.1:${stablePort}/`));
      registerServiceRoute(host, canaryPort + 5, "ACTIVE", `http://127.0.0.1:${canaryPort + 5}`, true);
      const res2 = await proxy(req("/after", "198.51.100.11"));
      assert.ok(res2.headers.get("x-middleware-rewrite")!.startsWith(`http://127.0.0.1:${canaryPort + 5}/`));
    });

    console.log("\n[5] Vercel migration writes rows");
    await step("applyVercelMigration creates CronJob + RATE_LIMIT WafRule (idempotent crons)", async () => {
      const plan = parseVercelConfig(JSON.stringify({ crons: [{ path: "/api/cron/daily", schedule: "0 3 * * *" }] }));
      const first = await applyVercelMigration(db, service.id, plan);
      const second = await applyVercelMigration(db, service.id, plan);
      assert.strictEqual(first.cronsAdded, 1);
      assert.strictEqual(second.cronsAdded, 0);
      assert.strictEqual(second.cronsSkipped, 1);
      const rules = await waf.listWafRules(db, service.id);
      assert.ok(rules.some((r) => r.type === "RATE_LIMIT" && r.rateLimitRpm === plan.wafRules.rateLimitRpm));
    });
  } finally {
    await db.service.delete({ where: { id: service.id } }).catch(() => null);
    await db.environment.delete({ where: { id: env.id } }).catch(() => null);
    await db.project.delete({ where: { id: project.id } }).catch(() => null);
    await db.workspaceMember.deleteMany({ where: { workspaceId: workspace.id } }).catch(() => null);
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => null);
    await db.user.delete({ where: { id: user.id } }).catch(() => null);
    srv.server.close();
    await db.$disconnect();
  }

  if (failures) {
    console.error(`\n💥 verify-devops: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\n✨ verify-devops: all checks passed (real Postgres + real HTTP server)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
