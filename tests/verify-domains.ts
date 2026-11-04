/**
 * Verification: custom domains, Cloudflare fail-closed behaviour, cache purge, tunnel
 * ingress sync and session-cookie scoping.
 *
 * REAL:   Postgres (DATABASE_URL, rows seeded and removed by this test), DNS resolution
 *         through node:dns/promises against a local authoritative UDP DNS server
 *         (tests/harness/dns-stub.ts, bound to 127.0.0.1:43053 via dns.setServers),
 *         Postgres advisory locks, the local-mode tunnel config file + restart command.
 * MOCKED: every api.cloudflare.com call (a stubbed global fetch) — the API is blocked here.
 *
 * Usage: DATABASE_URL=… npm run test:domains
 */

import assert from "node:assert";
import crypto from "node:crypto";
import * as dns from "node:dns";
import * as dnsPromises from "node:dns/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { startDnsStub, type StubRecords } from "./harness/dns-stub";

const DNS_PORT = 43053;
const RUN = crypto.randomBytes(3).toString("hex");
const prisma = new PrismaClient();
(globalThis as any).prisma = prisma;

// ─── Mocked Cloudflare API ──────────────────────────────────────────────────
interface CfCall {
  method: string;
  url: string;
  body: any;
  startedAt: number;
  endedAt?: number;
}
const cfCalls: CfCall[] = [];
let cfHandler: (call: CfCall) => Promise<{ status: number; json: any }> = async () => ({ status: 200, json: { success: true, result: {} } });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = typeof input === "string" ? input : input.url;
  if (!url.startsWith("https://api.cloudflare.com/")) return realFetch(input, init);
  const call: CfCall = { method: init.method || "GET", url, body: init.body ? JSON.parse(init.body) : undefined, startedAt: Date.now() };
  cfCalls.push(call);
  const { status, json } = await cfHandler(call);
  call.endedAt = Date.now();
  return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

const CF_ENV = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ZONE_ID", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_TUNNEL_ID", "TUNNEL_CONFIG_FILE", "TUNNEL_RESTART_COMMAND"];
function clearCfEnv() {
  for (const k of CF_ENV) delete process.env[k];
}

async function main() {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL (real Postgres) is required");
  clearCfEnv();
  process.env.CLOUDFLARE_CNAME_TARGET = "cname.syncbay.app";
  const setNodeEnv = (v: string | undefined) => {
    if (v === undefined) delete (process.env as any).NODE_ENV;
    else (process.env as any).NODE_ENV = v;
  };
  const originalNodeEnv = process.env.NODE_ENV;

  const domainService = await import("../src/lib/domain-service");
  const { CloudflareApiClient, CloudflareNotConfiguredError } = await import("../src/lib/tunnel/cloudflare-api");
  const { purgeEdgeCache, getEdgeRegions } = await import("../src/lib/edge/edge-router");
  const { buildIngressRoutesFromDb, requestTunnelReload, syncTunnelIngress } = await import("../src/lib/tunnel/tunnel-sync");
  const { resolveDomainUpstream } = await import("../src/lib/edge/domain-upstream");
  const { registerServiceRoute, clearServiceRoutes } = await import("../src/lib/edge/service-registry");
  const { resolveAuthCookieDomain, buildAuthCookies } = await import("../src/lib/auth-cookies");

  // ─── 0. Is real public DNS reachable from here? ───────────────────────────
  console.log("[0] public DNS egress probe");
  const publicProbe = await dnsPromises.resolveTxt("_dmarc.google.com").then(() => "reachable", (e) => `unreachable (${e.code})`);
  console.log(`  · public DNS is ${publicProbe}; verification below uses a local authoritative DNS server`);

  const zone = new Map<string, StubRecords>();
  const stub = await startDnsStub(DNS_PORT, zone);
  dns.setServers([`127.0.0.1:${DNS_PORT}`]);
  dnsPromises.setServers([`127.0.0.1:${DNS_PORT}`]);

  // ─── Seed real rows ───────────────────────────────────────────────────────
  const ws = await prisma.workspace.create({ data: { name: `dom-${RUN}`, slug: `dom-${RUN}` } });
  const project = await prisma.project.create({ data: { workspaceId: ws.id, name: "web" } });
  const env = await prisma.environment.create({ data: { projectId: project.id, name: "production" } });
  const mkService = async (name: string, data: Record<string, any> = {}) => {
    const svc = await prisma.service.create({ data: { environmentId: env.id, name, sourceType: "github", port: 10500, ...data } });
    const build = await prisma.build.create({ data: { serviceId: svc.id } });
    return { svc, build };
  };
  const live = await mkService(`api${RUN}`);
  await prisma.deployment.create({ data: { serviceId: live.svc.id, buildId: live.build.id, status: "ACTIVE", cfContainerId: "c_abc" } });
  const paused = await mkService(`paused${RUN}`, { isPaused: true });
  await prisma.deployment.create({ data: { serviceId: paused.svc.id, buildId: paused.build.id, status: "ACTIVE" } });
  const building = await mkService(`build${RUN}`);
  await prisma.deployment.create({ data: { serviceId: building.svc.id, buildId: building.build.id, status: "BUILDING" } });
  const removed = await mkService(`gone${RUN}`, { deletedAt: new Date() });
  await prisma.deployment.create({ data: { serviceId: removed.svc.id, buildId: removed.build.id, status: "ACTIVE" } });

  const host = `app-${RUN}.customer.test`;
  const records = domainService.generateVerificationRecords(host);
  const domain = await prisma.domain.create({
    data: { serviceId: live.svc.id, hostname: host, status: "PENDING", verificationTxt: records.txtRecord },
  });
  const apex = `apex-${RUN}.test`;
  const apexDomain = await prisma.domain.create({
    data: { serviceId: live.svc.id, hostname: apex, status: "PENDING", verificationTxt: domainService.generateVerificationRecords(apex).txtRecord },
  });
  const generated = await prisma.domain.create({
    data: { serviceId: live.svc.id, hostname: `gen-${RUN}.syncbay.app`, isGenerated: true, status: "PENDING" },
  });

  try {
    // ─── 1. Real DNS verification ───────────────────────────────────────────
    console.log("[1] DNS verification via node:dns/promises → local DNS server");
    let r = await domainService.verifyDomainDetailed(domain.id);
    assert.strictEqual(r.status, "VERIFYING", "no records → stays VERIFYING");
    assert.ok(r.errors.some((e) => e.includes(`_syncbay-challenge.${host}`)), "missing TXT reported");
    assert.ok(stub.queries.includes(`_syncbay-challenge.${host}/16`), "TXT query reached the DNS server");

    zone.set(`_syncbay-challenge.${host}`, { TXT: ["syncbay-verification=wrong"] });
    r = await domainService.verifyDomainDetailed(domain.id);
    assert.strictEqual(r.status, "VERIFYING");
    assert.ok(r.errors.some((e) => e.includes("does not contain")), "wrong TXT value reported");

    zone.set(`_syncbay-challenge.${host}`, { TXT: ["unrelated=1", records.txtRecord] });
    r = await domainService.verifyDomainDetailed(domain.id);
    assert.strictEqual(r.status, "VERIFYING", "TXT alone is not enough");
    assert.ok(r.dns!.txt.ok && !r.dns!.cname.ok);

    zone.set(host, { CNAME: "elsewhere.example.net" });
    r = await domainService.verifyDomainDetailed(domain.id);
    assert.ok(r.errors.some((e) => e.includes("points to elsewhere.example.net")), "wrong CNAME reported");

    zone.set(host, { CNAME: "cname.syncbay.app" });
    r = await domainService.verifyDomainDetailed(domain.id);
    assert.strictEqual(r.status, "ACTIVE", "TXT + CNAME → ACTIVE without Cloudflare");
    assert.strictEqual(r.dns!.cname.via, "cname");
    const row = await prisma.domain.findUniqueOrThrow({ where: { id: domain.id } });
    assert.ok(row.status === "ACTIVE" && row.verifiedAt, "persisted ACTIVE + verifiedAt");

    // Apex with CNAME flattening: A records equal the target's
    zone.set(`_syncbay-challenge.${apex}`, { TXT: [domainService.generateVerificationRecords(apex).txtRecord] });
    zone.set(apex, { A: ["203.0.113.7"] });
    zone.set("cname.syncbay.app", { A: ["203.0.113.7"] });
    r = await domainService.verifyDomainDetailed(apexDomain.id);
    assert.strictEqual(r.status, "ACTIVE");
    assert.strictEqual(r.dns!.cname.via, "flattened", "apex verified through flattened A records");

    assert.strictEqual(await domainService.verifyDomain(generated.id), "ACTIVE", "generated *.syncbay.app host ACTIVE");
    console.log("  ✔ TXT challenge + CNAME (and flattened apex) resolved for real; missing/wrong records keep VERIFYING");

    // ─── 2. Cloudflare custom-hostname status (MOCKED API) ───────────────────
    console.log("[2] Cloudflare custom hostname status (mocked api.cloudflare.com)");
    const cf = new CloudflareApiClient({ apiToken: "cf-test-token", zoneId: "zone123" });
    let chStatus = { status: "pending", ssl: "pending_validation" };
    cfHandler = async (call) => {
      if (call.url.includes("/custom_hostnames?hostname=")) {
        return { status: 200, json: { success: true, result: [{ id: "6f1c0d8e-0000-4000-8000-000000000001", hostname: host, status: chStatus.status, ssl: { status: chStatus.ssl } }] } };
      }
      return { status: 404, json: { success: false, errors: [{ message: "not found" }] } };
    };
    await prisma.domain.update({ where: { id: domain.id }, data: { cfRecordId: null } });
    r = await domainService.verifyDomainDetailed(domain.id, { cloudflare: cf });
    assert.strictEqual(r.status, "VERIFYING", "DNS ok but Cloudflare pending → VERIFYING");
    assert.strictEqual((await prisma.domain.findUniqueOrThrow({ where: { id: domain.id } })).cfRecordId, "6f1c0d8e-0000-4000-8000-000000000001", "real (UUID) record id stored");
    cfCalls.length = 0;
    chStatus = { status: "active", ssl: "active" };
    r = await domainService.verifyDomainDetailed(domain.id, { cloudflare: cf });
    assert.strictEqual(r.status, "ACTIVE", "Cloudflare active + certificate active → ACTIVE");
    assert.ok(cfCalls[0].url.endsWith("/zones/zone123/custom_hostnames/6f1c0d8e-0000-4000-8000-000000000001"), "UUID ids fetched by id");
    cfHandler = async () => ({ status: 200, json: { success: true, result: { id: "6f1c0d8e-0000-4000-8000-000000000001", hostname: host, status: "active", ssl: { status: "failed" } } } });
    r = await domainService.verifyDomainDetailed(domain.id, { cloudflare: cf });
    assert.strictEqual(r.status, "FAILED", "certificate failure → FAILED");
    cfHandler = async () => ({ status: 500, json: { success: false, errors: [{ message: "upstream exploded" }] } });
    r = await domainService.verifyDomainDetailed(domain.id, { cloudflare: cf });
    assert.strictEqual(r.status, "VERIFYING", "Cloudflare API error never yields ACTIVE");
    assert.ok(r.errors.some((e) => e.includes("upstream exploded")));
    console.log("  ✔ Cloudflare pending/active/failed/error mapped; API errors never simulated");

    // ─── 3. Fail closed in production ───────────────────────────────────────
    console.log("[3] Cloudflare client fails closed in production");
    setNodeEnv("production");
    const unconfigured = new CloudflareApiClient({ apiToken: "", zoneId: "", accountId: "" });
    await assert.rejects(unconfigured.createCustomHostname({ hostname: "x.example.com" }), CloudflareNotConfiguredError);
    await assert.rejects(unconfigured.verifyCustomHostname("x.example.com"), CloudflareNotConfiguredError);
    await assert.rejects(unconfigured.provisionTunnelToken("t"), CloudflareNotConfiguredError, "no fake tunnel token in production");
    assert.strictEqual(await unconfigured.getCustomHostname("x.example.com"), null);
    setNodeEnv(originalNodeEnv);
    const dev = await unconfigured.provisionTunnelToken("t");
    assert.strictEqual(dev.simulated, true, "dev placeholder token is labelled simulated");
    const cfFail = new CloudflareApiClient({ apiToken: "t", zoneId: "z", accountId: "a" });
    await assert.rejects(cfFail.createCustomHostname({ hostname: "y.example.com" }), /upstream exploded/, "live API error is thrown, not simulated");
    await assert.rejects(cfFail.provisionTunnelToken("t"), /upstream exploded/);
    console.log("  ✔ no simulated hostnames/tokens in production; live errors surface");

    // ─── 4. Cache purge ─────────────────────────────────────────────────────
    console.log("[4] purgeEdgeCache (mocked Cloudflare purge_cache)");
    let p = await purgeEdgeCache({ all: true });
    assert.ok(!p.success && !p.configured && p.purgedPops.length === 0 && /not configured/.test(p.message), "unconfigured purge is explicit");
    process.env.CLOUDFLARE_ZONE_ID = "zone123";
    process.env.CLOUDFLARE_API_TOKEN = "cf-test-token";
    cfCalls.length = 0;
    cfHandler = async () => ({ status: 200, json: { success: true, result: { id: "purge-1" } } });
    p = await purgeEdgeCache({ all: true });
    assert.ok(p.success && p.configured && p.cloudflarePurgeId === "purge-1");
    assert.deepStrictEqual(cfCalls[0].body, { purge_everything: true });
    assert.ok(cfCalls[0].url.endsWith("/zones/zone123/purge_cache") && cfCalls[0].method === "POST");
    await purgeEdgeCache({ domain: host, path: "/assets/app.js" });
    assert.deepStrictEqual(cfCalls[1].body, { files: [`https://${host}/assets/app.js`] });
    p = await purgeEdgeCache({ path: "/x" });
    assert.ok(!p.success && cfCalls.length === 2, "path without domain rejected before calling Cloudflare");
    cfHandler = async () => ({ status: 403, json: { success: false, errors: [{ message: "Authentication error" }] } });
    p = await purgeEdgeCache({ tag: "v1" });
    assert.ok(!p.success && /Authentication error/.test(p.message));
    clearCfEnv();
    assert.ok(getEdgeRegions().every((reg) => reg.illustrative === true), "static POP list marked illustrative");
    console.log("  ✔ real purge request shape, explicit 'not configured', POPs illustrative");

    // ─── 5. Tunnel ingress from the DB route table ──────────────────────────
    console.log("[5] tunnel ingress sync (real Postgres + advisory lock; Cloudflare API mocked)");
    const routes = await buildIngressRoutesFromDb();
    const mine = routes.filter((rt) => rt.hostname.includes(RUN));
    const names = mine.map((rt) => rt.hostname).sort();
    assert.deepStrictEqual(names, [apex, host, `api${RUN}-production.syncbay.app`, `gen-${RUN}.syncbay.app`].sort(), `ACTIVE services + ACTIVE domains only, got ${names}`);
    assert.ok(mine.every((rt) => rt.targetPort === 10500 && rt.targetHost === "127.0.0.1"));

    cfCalls.length = 0;
    const skipped = await requestTunnelReload("test:unconfigured");
    assert.strictEqual(skipped.status, "skipped", "no-op when the tunnel is not configured");
    assert.strictEqual(cfCalls.length, 0);

    process.env.CLOUDFLARE_TUNNEL_ID = "tun-1";
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct-1";
    process.env.CLOUDFLARE_API_TOKEN = "cf-test-token";
    cfHandler = async (call) => {
      await new Promise((res) => setTimeout(res, 150));
      return { status: 200, json: { success: true, result: { version: cfCalls.indexOf(call) + 1 } } };
    };
    const burst = await Promise.all([requestTunnelReload("a"), requestTunnelReload("b"), requestTunnelReload("c")]);
    assert.strictEqual(cfCalls.length, 1, "burst debounced into one PUT");
    assert.ok(burst.every((b) => b === burst[0]) && burst[0].status === "applied" && burst[0].mode === "api");
    assert.deepStrictEqual(burst[0].reasons, ["a", "b", "c"]);
    const put = cfCalls[0];
    assert.ok(put.method === "PUT" && put.url.endsWith("/accounts/acct-1/cfd_tunnel/tun-1/configurations"));
    const ingress = put.body.config.ingress as Array<{ hostname?: string; service: string }>;
    assert.ok(ingress.some((i) => i.hostname === host && i.service === "http://127.0.0.1:10500"), "custom domain → service port");
    assert.strictEqual(ingress[ingress.length - 1].service, "http_status:404", "catch-all last");
    assert.ok(!ingress.some((i) => i.hostname?.startsWith(`paused${RUN}`) || i.hostname?.startsWith(`build${RUN}`) || i.hostname?.startsWith(`gone${RUN}`)));

    // Two concurrent syncs on separate pooled connections: the advisory lock serialises them
    cfCalls.length = 0;
    await Promise.all([syncTunnelIngress(["x"]), syncTunnelIngress(["y"])]);
    assert.strictEqual(cfCalls.length, 2);
    const [c1, c2] = [...cfCalls].sort((m, n) => m.startedAt - n.startedAt);
    assert.ok(c1.endedAt! <= c2.startedAt, `advisory lock serialised the PUTs (${c1.endedAt} <= ${c2.startedAt})`);

    cfHandler = async () => ({ status: 500, json: { success: false, errors: [{ message: "tunnel API down" }] } });
    const failed = await requestTunnelReload("z", { debounceMs: 0 });
    assert.ok(failed.status === "error" && /tunnel API down/.test(failed.error || ""), "failure reported, never thrown");

    // Local mode: atomic YAML write + restart command
    clearCfEnv();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sbc-tunnel-"));
    process.env.CLOUDFLARE_TUNNEL_ID = "tun-local";
    process.env.TUNNEL_CONFIG_FILE = path.join(dir, "config.yml");
    process.env.TUNNEL_RESTART_COMMAND = `touch ${path.join(dir, "restarted")}`;
    const local = await requestTunnelReload("local", { debounceMs: 0 });
    assert.strictEqual(local.status, "applied");
    assert.strictEqual(local.mode, "local");
    const yaml = await fs.readFile(process.env.TUNNEL_CONFIG_FILE, "utf8");
    assert.ok(yaml.includes(`hostname: ${host}`) && yaml.includes("service: http://127.0.0.1:10500"));
    await fs.access(path.join(dir, "restarted"));
    clearCfEnv();
    await fs.rm(dir, { recursive: true, force: true });
    console.log("  ✔ full table from DB, debounced, lock-serialised, no-op unconfigured, local mode restarts cloudflared");

    // ─── 6. Domain upstream from the live route ─────────────────────────────
    console.log("[6] custom domain upstream copies the live platform route");
    clearServiceRoutes();
    registerServiceRoute(`api${RUN}-production.syncbay.app`, 10777, "ACTIVE", "http://runner.internal:10777", false);
    const svcRow = await prisma.service.findUniqueOrThrow({ where: { id: live.svc.id }, include: { environment: true, deployments: true } });
    let up = await resolveDomainUpstream(svcRow);
    assert.deepStrictEqual(
      { port: up.targetPort, url: up.upstreamUrl, local: up.isLocal, source: up.source },
      { port: 10777, url: "http://runner.internal:10777", local: false, source: "live-route" }
    );
    up = await resolveDomainUpstream({ ...svcRow, isPaused: true });
    assert.strictEqual(up.status, "SLEEPING", "paused service routes to the splash");
    clearServiceRoutes();
    console.log("  ✔ upstream/port/isLocal from the live route, not a guessed 127.0.0.1");

    // ─── 7. Session cookie scoping ──────────────────────────────────────────
    console.log("[7] AUTH_COOKIE_DOMAIN");
    assert.strictEqual(resolveAuthCookieDomain({ NODE_ENV: "development", AUTH_COOKIE_DOMAIN: ".syncbay.app" } as any), null);
    assert.strictEqual(resolveAuthCookieDomain({ NODE_ENV: "production", NEXTAUTH_URL: "https://syncbay.app" } as any), ".syncbay.app");
    assert.strictEqual(resolveAuthCookieDomain({ NODE_ENV: "production", NEXTAUTH_URL: "https://sb-git-x.vercel.app" } as any), null);
    assert.strictEqual(resolveAuthCookieDomain({ NODE_ENV: "production", AUTH_COOKIE_DOMAIN: "example.dev" } as any), ".example.dev");
    assert.strictEqual(resolveAuthCookieDomain({ NODE_ENV: "production", NEXTAUTH_URL: "https://syncbay.app", AUTH_COOKIE_DOMAIN: "none" } as any), null);
    const cookies = buildAuthCookies({ NODE_ENV: "production", NEXTAUTH_URL: "https://syncbay.app" } as any)!;
    assert.deepStrictEqual(cookies.sessionToken!.options, { httpOnly: true, sameSite: "lax", path: "/", secure: true, domain: ".syncbay.app" });
    assert.strictEqual(cookies.sessionToken!.name, "__Secure-next-auth.session-token");
    console.log("  ✔ production session cookie scoped to .syncbay.app (secure, lax); previews host-only");

    console.log("\nAll domain / edge verifications passed.");
  } finally {
    setNodeEnv(originalNodeEnv);
    clearCfEnv();
    await prisma.workspace.delete({ where: { id: ws.id } }).catch(async () => {
      await prisma.service.deleteMany({ where: { environmentId: env.id } }).catch(() => null);
    });
    await prisma.$disconnect();
    await stub.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n✖ Domain verification failed:", err);
    process.exit(1);
  });
