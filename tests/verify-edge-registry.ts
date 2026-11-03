/**
 * Verification Test: Two-tier Edge Service Registry + proxy.ts routing
 *
 * Validates (mocked fetch for Upstash REST, mocked globalThis.prisma for the DB tier):
 * 1. Write-through: registerServiceRouteAsync / removeServiceRouteAsync hit Upstash with Bearer auth.
 * 2. L1 TTL: ACTIVE entries are served from L1 for 15s, then re-hydrated from L2.
 * 3. Upstash hydration: a route written by "another process" is picked up on an L1 miss.
 * 4. Negative cache: unknown hosts are not re-queried for 5s.
 * 5. DB fallback: without Upstash, routes resolve through resolveServiceRouteFromDb();
 *    with Upstash, a miss there falls through to the DB.
 * 6. Stale-on-error: an L2 outage serves the last known L1 entry.
 * 7. BUILDING → ACTIVE: proxy serves the splash while BUILDING and switches to the
 *    upstream within ~2s of the DB flipping to ACTIVE.
 * 8. proxy host rules: *.vercel.app, IPs and unknown custom domains pass through;
 *    /api/deployments is never rewritten on service hosts; verified custom domains route.
 */

import assert from "node:assert";
import { NextRequest } from "next/server";
import {
  registerServiceRouteAsync,
  removeServiceRouteAsync,
  resolveServiceRoute,
  clearServiceRoutes,
  getL2Store,
  UpstashRestStore,
} from "../src/lib/edge/service-registry";
import { proxy } from "../src/proxy";

// ─── Controllable clock ──────────────────────────────────────────────────────
const realNow = Date.now.bind(Date);
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
const advance = (ms: number) => {
  clockOffset += ms;
};

// ─── Mock Upstash REST ───────────────────────────────────────────────────────
const UPSTASH_URL = "https://upstash.mock.local";
const UPSTASH_TOKEN = "upstash-test-token";
const redis = new Map<string, string>();
const redisSets = new Map<string, Set<string>>();
let upstashCalls: any[][] = [];
let upstashDown = false;

function runCommand(cmd: any[]): any {
  const [op, ...args] = cmd;
  switch (String(op).toUpperCase()) {
    case "MGET":
      return args.map((k: string) => redis.get(k) ?? null);
    case "SET":
      redis.set(args[0], args[1]);
      return "OK";
    case "DEL":
      return redis.delete(args[0]) ? 1 : 0;
    case "SADD": {
      const set = redisSets.get(args[0]) ?? new Set<string>();
      set.add(args[1]);
      redisSets.set(args[0], set);
      return 1;
    }
    case "SREM":
      return redisSets.get(args[0])?.delete(args[1]) ? 1 : 0;
    default:
      throw new Error(`unsupported command ${op}`);
  }
}

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith(UPSTASH_URL)) {
    if (upstashDown) throw new Error("ECONNREFUSED upstash");
    const auth = new Headers(init?.headers).get("authorization");
    assert.strictEqual(auth, `Bearer ${UPSTASH_TOKEN}`, "Upstash requests carry the Bearer token");
    const body = JSON.parse(init.body);
    const pipeline = url.endsWith("/pipeline");
    const commands: any[][] = pipeline ? body : [body];
    upstashCalls.push(...commands);
    const results = commands.map((c) => ({ result: runCommand(c) }));
    return new Response(JSON.stringify(pipeline ? results : results[0]), { status: 200 });
  }
  return originalFetch(input, init);
}) as typeof fetch;

// ─── Mock Prisma ─────────────────────────────────────────────────────────────
const dbState = {
  calls: 0,
  domains: [] as any[],
  services: [] as any[],
};

function matchHostname(cond: any, hostname: string): boolean {
  if (typeof cond === "string") return cond === hostname;
  if (cond?.startsWith) return hostname.startsWith(cond.startsWith);
  return false;
}

(globalThis as any).prisma = {
  domain: {
    findFirst: async ({ where }: any) => {
      dbState.calls++;
      const domain = dbState.domains.find((d) => {
        if (where.OR) return where.OR.some((c: any) => matchHostname(c.hostname, d.hostname));
        return matchHostname(where.hostname, d.hostname) && (!where.status || where.status === d.status);
      });
      if (!domain) return null;
      return { ...domain, service: dbState.services.find((s) => s.id === domain.serviceId) ?? null };
    },
  },
  service: {
    findFirst: async ({ where }: any) => {
      dbState.calls++;
      return (
        dbState.services.find((s) =>
          (where.OR || []).some((c: any) => (c.id && c.id === s.id) || (typeof c.name === "string" && c.name === s.name))
        ) ?? null
      );
    },
  },
  deployment: { findUnique: async () => null },
};

function setEnv(opts: { upstash: boolean; db: boolean }) {
  if (opts.upstash) {
    process.env.UPSTASH_REDIS_REST_URL = UPSTASH_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = UPSTASH_TOKEN;
  } else {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
  if (opts.db) process.env.DATABASE_URL = "postgresql://mock:mock@localhost:5432/mock";
  else delete process.env.DATABASE_URL;
}

function reset() {
  clearServiceRoutes();
  redis.clear();
  redisSets.clear();
  upstashCalls = [];
  upstashDown = false;
  dbState.calls = 0;
  dbState.domains = [];
  dbState.services = [];
}

const key = (host: string) => UpstashRestStore.KEY_PREFIX + host;

function req(host: string, path = "/") {
  return new NextRequest(`http://${host}${path}`, { headers: { host } });
}

async function run() {
  console.log("================================================================================");
  console.log("        SYNCBAY TWO-TIER EDGE REGISTRY & PROXY VERIFICATION SUITE               ");
  console.log("================================================================================");
  delete process.env.RUNNER_URL;
  delete process.env.NEXTAUTH_URL;

  // ─── 1. Write-through ──────────────────────────────────────────────────────
  console.log("\n[1] Write-through to Upstash...");
  {
    reset();
    setEnv({ upstash: true, db: false });
    assert.strictEqual(getL2Store().kind, "upstash");
    await registerServiceRouteAsync("Web-Prod.Syncbay.App", 10001, "ACTIVE", "http://127.0.0.1:10001", true);
    const stored = JSON.parse(redis.get(key("web-prod.syncbay.app"))!);
    assert.strictEqual(stored.targetPort, 10001);
    assert.strictEqual(stored.isLocal, true);
    assert.ok(redisSets.get(UpstashRestStore.INDEX_KEY)?.has("web-prod.syncbay.app"), "host added to index set");
    const setCmd = upstashCalls.find((c) => c[0] === "SET")!;
    assert.deepStrictEqual(setCmd.slice(3), ["EX", String(7 * 24 * 60 * 60)], "SET uses EX expiry");

    await removeServiceRouteAsync("web-prod.syncbay.app");
    assert.strictEqual(redis.has(key("web-prod.syncbay.app")), false, "DEL removed key");
    assert.strictEqual(redisSets.get(UpstashRestStore.INDEX_KEY)?.has("web-prod.syncbay.app"), false);
    assert.strictEqual(await resolveServiceRoute("web-prod.syncbay.app"), null);
    console.log("  ✔ register/remove write through (SET EX + SADD / DEL + SREM, Bearer auth)");
  }

  // ─── 2 + 3. L1 TTL expiry and Upstash hydration ────────────────────────────
  console.log("\n[2] L1 TTL expiry & Upstash hydration...");
  {
    reset();
    setEnv({ upstash: true, db: false });
    // Written by another process: only present in Redis
    redis.set(
      key("api-prod.syncbay.app"),
      JSON.stringify({ hostname: "api-prod.syncbay.app", targetPort: 10002, status: "ACTIVE", upstreamUrl: "http://127.0.0.1:10002", updatedAt: 1 })
    );
    const first = await resolveServiceRoute("API-PROD.syncbay.app");
    assert.strictEqual(first?.targetPort, 10002, "hydrated from Upstash on L1 miss");
    assert.strictEqual(upstashCalls.filter((c) => c[0] === "MGET").length, 1);

    // Another process moves the port; L1 still serves the cached value within 15s
    redis.set(
      key("api-prod.syncbay.app"),
      JSON.stringify({ hostname: "api-prod.syncbay.app", targetPort: 10003, status: "ACTIVE", upstreamUrl: "http://127.0.0.1:10003", updatedAt: 2 })
    );
    advance(14_000);
    assert.strictEqual((await resolveServiceRoute("api-prod.syncbay.app"))?.targetPort, 10002, "L1 hit within TTL");
    assert.strictEqual(upstashCalls.filter((c) => c[0] === "MGET").length, 1, "no L2 call within TTL");

    advance(1_500);
    assert.strictEqual((await resolveServiceRoute("api-prod.syncbay.app"))?.targetPort, 10003, "re-hydrated after 15s TTL");
    assert.strictEqual(upstashCalls.filter((c) => c[0] === "MGET").length, 2);

    // .localhost alias resolves via the .syncbay.app key
    const alias = await resolveServiceRoute("api-prod.localhost");
    assert.strictEqual(alias?.targetPort, 10003, ".localhost alias hydrated from .syncbay.app key");
    console.log("  ✔ L1 serves for 15s, then re-hydrates from Upstash; aliases resolve");
  }

  // ─── 4. Negative cache ─────────────────────────────────────────────────────
  console.log("\n[3] Negative cache...");
  {
    reset();
    setEnv({ upstash: true, db: false });
    assert.strictEqual(await resolveServiceRoute("ghost.syncbay.app"), null);
    assert.strictEqual(await resolveServiceRoute("ghost.syncbay.app"), null);
    assert.strictEqual(upstashCalls.length, 1, "second miss answered from negative cache");
    advance(5_100);
    await resolveServiceRoute("ghost.syncbay.app");
    assert.strictEqual(upstashCalls.length, 2, "negative cache expires after 5s");
    await registerServiceRouteAsync("ghost.syncbay.app", 10004, "ACTIVE");
    assert.strictEqual((await resolveServiceRoute("ghost.syncbay.app"))?.targetPort, 10004, "register clears negative entry");
    console.log("  ✔ misses cached for 5s and cleared on register");
  }

  // ─── 5. DB fallback ────────────────────────────────────────────────────────
  console.log("\n[4] DB resolver fallback...");
  {
    reset();
    setEnv({ upstash: false, db: true });
    assert.strictEqual(getL2Store().kind, "db");
    dbState.services = [
      { id: "srv_web", name: "web", port: 10010, isPaused: false, deployments: [{ status: "ACTIVE", cfContainerId: "proc_1" }] },
      { id: "srv_shop", name: "shop", port: 10011, isPaused: false, deployments: [{ status: "ACTIVE", cfContainerId: "ctr_9" }] },
    ];
    dbState.domains = [
      { hostname: "web-production.syncbay.app", serviceId: "srv_web", status: "ACTIVE" },
      { hostname: "shop.example.com", serviceId: "srv_shop", status: "ACTIVE" },
      { hostname: "pending.example.com", serviceId: "srv_shop", status: "PENDING" },
    ];

    const web = await resolveServiceRoute("web-production.syncbay.app");
    assert.strictEqual(web?.status, "ACTIVE");
    assert.strictEqual(web?.targetPort, 10010);
    assert.strictEqual(web?.isLocal, true, "proc_ container → isLocal");

    const shop = await resolveServiceRoute("SHOP.example.com");
    assert.strictEqual(shop?.targetPort, 10011, "verified custom domain resolves exactly");
    assert.strictEqual(await resolveServiceRoute("pending.example.com"), null, "unverified custom domain does not route");
    assert.strictEqual(await resolveServiceRoute("web.attacker.com"), null, "custom hosts never fuzzy-match service names");

    // Upstash configured but missing the key → DB fallback
    clearServiceRoutes();
    setEnv({ upstash: true, db: true });
    assert.strictEqual(getL2Store().kind, "upstash+db");
    const chained = await resolveServiceRoute("web-production.syncbay.app");
    assert.strictEqual(chained?.targetPort, 10010, "Upstash miss falls through to DB");
    assert.strictEqual(upstashCalls.filter((c) => c[0] === "MGET").length, 1);
    console.log("  ✔ DB resolver hydrates platform + verified custom domains; Upstash miss falls back to DB");
  }

  // ─── 6. Stale on error ─────────────────────────────────────────────────────
  console.log("\n[5] Stale-on-error...");
  {
    reset();
    setEnv({ upstash: true, db: false });
    await registerServiceRouteAsync("stale.syncbay.app", 10020, "ACTIVE");
    advance(16_000);
    upstashDown = true;
    const stale = await resolveServiceRoute("stale.syncbay.app");
    assert.strictEqual(stale?.targetPort, 10020, "L2 outage serves last known route");
    console.log("  ✔ L2 outage serves the stale L1 entry");
  }

  // ─── 7. BUILDING → ACTIVE through proxy ────────────────────────────────────
  console.log("\n[6] BUILDING → ACTIVE transition via proxy...");
  {
    reset();
    setEnv({ upstash: false, db: true });
    const deployment = { status: "BUILDING", cfContainerId: "proc_x" };
    dbState.services = [{ id: "srv_api", name: "api", port: 10030, isPaused: false, deployments: [deployment] }];
    dbState.domains = [{ hostname: "api-staging.syncbay.app", serviceId: "srv_api", status: "ACTIVE" }];

    const building = await proxy(req("api-staging.syncbay.app", "/dashboard"));
    const splash = building.headers.get("x-middleware-rewrite") || "";
    assert.ok(splash.includes("/service-preview/api-staging"), `BUILDING → splash, got ${splash}`);
    assert.ok(splash.includes("status=BUILDING"));

    const health = await proxy(req("api-staging.syncbay.app", "/health"));
    assert.strictEqual(health.status, 503, "/health is 503 while BUILDING");

    deployment.status = "ACTIVE";
    advance(1_000);
    const stillCached = await proxy(req("api-staging.syncbay.app", "/dashboard"));
    assert.ok((stillCached.headers.get("x-middleware-rewrite") || "").includes("/service-preview/"), "non-ACTIVE cached ≤2s");

    advance(1_100);
    const active = await proxy(req("api-staging.syncbay.app", "/dashboard"));
    const upstream = active.headers.get("x-middleware-rewrite") || "";
    assert.ok(upstream.includes("10030") && upstream.includes("/dashboard"), `ACTIVE → upstream, got ${upstream}`);
    const okHealth = await proxy(req("api-staging.syncbay.app", "/health"));
    assert.strictEqual(okHealth.status, 200, "/health is 200 once ACTIVE");

    const callsAfterActive = dbState.calls;
    advance(10_000);
    await proxy(req("api-staging.syncbay.app", "/"));
    assert.strictEqual(dbState.calls, callsAfterActive, "ACTIVE route served from L1 for 15s");
    console.log("  ✔ splash while BUILDING, upstream within ~2s of ACTIVE, ACTIVE cached 15s");
  }

  // ─── 8. Host rules ─────────────────────────────────────────────────────────
  console.log("\n[7] proxy service-host restrictions...");
  {
    reset();
    setEnv({ upstash: false, db: true });
    dbState.services = [{ id: "srv_shop", name: "shop", port: 10040, isPaused: false, deployments: [{ status: "ACTIVE" }] }];
    dbState.domains = [{ hostname: "shop.example.com", serviceId: "srv_shop", status: "ACTIVE" }];

    for (const host of ["syncbay-git-main.vercel.app", "10.0.0.5", "localhost", "www.syncbay.app"]) {
      const res = await proxy(req(host, "/dashboard"));
      assert.strictEqual(res.headers.get("x-middleware-rewrite"), null, `${host} must pass through`);
    }
    assert.strictEqual(dbState.calls, 0, "control-plane / vercel / IP hosts never hit the registry");

    const unknown = await proxy(req("random.example.org", "/"));
    assert.strictEqual(unknown.headers.get("x-middleware-rewrite"), null, "unregistered custom domain passes through");

    const custom = await proxy(req("shop.example.com", "/cart"));
    assert.ok((custom.headers.get("x-middleware-rewrite") || "").includes("10040"), "verified custom domain routes upstream");

    await registerServiceRouteAsync("logs-app.syncbay.app", 10050, "BUILDING");
    const sse = await proxy(req("logs-app.syncbay.app", "/api/deployments/dep_1/logs/stream"));
    assert.strictEqual(sse.headers.get("x-middleware-rewrite"), null, "/api/deployments bypasses rewrite on service hosts");
    const wake = await proxy(req("logs-app.syncbay.app", "/api/v1/services/wake"));
    assert.strictEqual(wake.headers.get("x-middleware-rewrite"), null, "/api/v1/services/wake bypasses rewrite");
    console.log("  ✔ only *.syncbay.app, *.localhost and registered custom domains are service hosts");
  }

  console.log("\n================================================================================");
  console.log("🎉 ALL EDGE REGISTRY & PROXY CHECKS PASSED");
  console.log("================================================================================");
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ TEST RUN FAILED:", err);
    process.exit(1);
  });
