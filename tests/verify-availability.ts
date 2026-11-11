/**
 * Verification: a deployed service stays reachable (Syncbay v1.3).
 *
 * Real: Postgres (DATABASE_URL, Prisma) and a runner daemon process on localhost
 * (`runner/src/index.ts`, RUNNER_PORT 49100) running real native Node apps.
 *
 *  1. Defaults: a new service is always-on (scale-to-zero off).
 *  2. Hostname ownership: two services with the same name and environment get different
 *     platform hosts; a failing deploy of one never touches the other's address.
 *  3. Zero downtime: while a new version builds, and after a new version fails, the live
 *     version keeps its route (registry and DB resolver) and keeps answering.
 *  4. Ports: `Service.port` stays the app's own port; the runner's host port is stored on the
 *     deployment and is what the tunnel ingress table uses.
 *  5. Always-on: a sleeping service with scale-to-zero off is started again by the cron
 *     reconciler; scale-to-zero and paused services are left alone.
 *
 * Usage: DATABASE_URL=postgresql://… npm run test:availability
 */

import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const ROOT = path.resolve(__dirname, "..");
const RUNNER_PORT = Number(process.env.RUNNER_PORT || 49100);
const SECRET = crypto.randomBytes(24).toString("hex");
const RUN = crypto.randomBytes(3).toString("hex");

let passed = 0;
const ok = (msg: string) => {
  passed += 1;
  console.log(`  ✔ ${msg}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 40000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(250);
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required (real Postgres)");
  for (const k of ["GITHUB_TOKEN", "RUNNER_URL", "RUNNER_DRIVER", "RUNNER_QUEUE_MODE", "UPSTASH_REDIS_REST_URL", "VERCEL", "CLOUDFLARE_TUNNEL_ID"]) delete process.env[k];
  Object.assign(process.env, { RUNNER_SECRET: SECRET, RUNNER_FALLBACK_LOCAL: "false" });

  const prisma = new PrismaClient();
  (globalThis as any).prisma = prisma;

  const { executeDeployment } = await import("../src/lib/orchestrator/engine");
  const { claimDefaultHostname } = await import("../src/lib/domains/claim");
  const { resolveServiceHostnames, primaryServiceHostname } = await import("../src/lib/domains/service-hosts");
  const { getServiceRoute } = await import("../src/lib/edge/service-registry");
  const { resolveServiceRouteFromDb } = await import("../src/lib/edge/resolve");
  const { buildIngressRoutesFromDb } = await import("../src/lib/tunnel/tunnel-sync");
  const { stopServiceToSleep } = await import("../src/lib/scale/service-control");
  const { wakeAlwaysOnServices } = await import("../src/lib/scale/always-on");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-availability-"));
  const appFile = path.join(tmp, "app.cjs");
  fs.writeFileSync(
    appFile,
    `const http = require("http");
setTimeout(() => {
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ version: process.env.APP_VERSION }));
  }).listen(parseInt(process.env.PORT, 10), "127.0.0.1");
}, parseInt(process.env.APP_DELAY_MS || "0", 10));
`
  );

  const runner: ChildProcess = spawn(process.execPath, [path.join(ROOT, "node_modules/tsx/dist/cli.mjs"), path.join(ROOT, "runner/src/index.ts")], {
    cwd: tmp,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "development", RUNNER_PORT: String(RUNNER_PORT), RUNNER_HOST: "127.0.0.1", RUNNER_SECRET: SECRET, RUNNER_DB_MODE: "mock", RUNNER_AUTO_INSTALL_BUILDX: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  runner.stdout?.on("data", (c) => process.env.DEBUG_RUNNER && process.stdout.write(`[runner] ${c}`));
  runner.stderr?.on("data", (c) => process.env.DEBUG_RUNNER && process.stderr.write(`[runner] ${c}`));

  const name = `web${RUN}`;
  const mkTenant = async (tag: string) => {
    const user = await prisma.user.create({ data: { email: `${tag}-${RUN}@test.syncbay.app` } });
    const workspace = await prisma.workspace.create({ data: { name: `ws-${tag}-${RUN}`, slug: `ws-${tag}-${RUN}`, members: { create: { userId: user.id, role: "OWNER" } } } });
    const project = await prisma.project.create({ data: { workspaceId: workspace.id, name: "portfolio" } });
    const env = await prisma.environment.create({ data: { projectId: project.id, name: "production", isDefault: true } });
    return { user, workspace, project, env };
  };
  const mkService = (envId: string, extra: Record<string, unknown> = {}) =>
    prisma.service.create({
      data: {
        environmentId: envId,
        name,
        sourceType: "empty",
        startCommand: `node "${appFile}"`,
        port: 3000,
        variables: { create: [{ key: "APP_VERSION", value: "v1", isSecret: false }, { key: "APP_DELAY_MS", value: "0", isSecret: false }] },
        ...extra,
      } as any,
    });
  const setVar = (serviceId: string, key: string, value: string) => prisma.environmentVariable.updateMany({ where: { serviceId, key }, data: { value } });
  const newDeployment = async (serviceId: string) => {
    const build = await prisma.build.create({ data: { serviceId, status: "QUEUED" } });
    return prisma.deployment.create({ data: { serviceId, buildId: build.id, status: "QUEUED" } });
  };
  const deploy = async (serviceId: string) => {
    const d = await newDeployment(serviceId);
    const result = await executeDeployment(d.id, d.buildId, serviceId, { serviceId }).catch((err: Error) => ({ status: "FAILED", error: err.message }));
    return { d, result, row: await prisma.deployment.findUniqueOrThrow({ where: { id: d.id } }) };
  };
  const viaRunner = async (port: number) => (await fetch(`http://127.0.0.1:${RUNNER_PORT}/`, { headers: { "x-target-port": String(port) }, signal: AbortSignal.timeout(3000) })).json();

  const mine = await mkTenant("owner");
  const theirs = await mkTenant("tester");
  const cleanup = async () => {
    runner.kill("SIGTERM");
    for (const t of [mine, theirs]) {
      await prisma.deploymentJob.deleteMany({ where: { deployment: { service: { environment: { projectId: t.project.id } } } } }).catch(() => null);
      await prisma.deployment.deleteMany({ where: { service: { environment: { projectId: t.project.id } } } }).catch(() => null);
      await prisma.workspace.delete({ where: { id: t.workspace.id } }).catch(() => null);
      await prisma.user.delete({ where: { id: t.user.id } }).catch(() => null);
    }
    await prisma.$disconnect();
    fs.rmSync(tmp, { recursive: true, force: true });
  };

  try {
    await waitFor("runner /health", async () => (await fetch(`http://127.0.0.1:${RUNNER_PORT}/health`)).ok, 20000);
    process.env.RUNNER_URL = `http://127.0.0.1:${RUNNER_PORT}`;

    // ─── 1. Defaults ─────────────────────────────────────────────────────────
    console.log("\n[1] Defaults");
    const svcA = await mkService(mine.env.id);
    const svcB = await mkService(theirs.env.id, { startCommand: `node -e "console.error('boom'); process.exit(2)"` });
    assert.strictEqual(svcA.scaleToZero, false);
    assert.strictEqual(svcA.idleTimeoutSecs, 1800);
    ok("a new service is always-on (scaleToZero false, idle timeout 1800 s if enabled later)");

    // ─── 2. Hostname ownership ───────────────────────────────────────────────
    console.log("\n[2] Hostname ownership");
    const hostA = await claimDefaultHostname(prisma, { id: svcA.id, name, environment: { name: "production" } });
    const hostB = await claimDefaultHostname(prisma, { id: svcB.id, name, environment: { name: "production" } });
    assert.strictEqual(hostA, `${name}-production.syncbay.app`);
    assert.notStrictEqual(hostB, hostA);
    assert.match(hostB, new RegExp(`^${name}-production-[a-z0-9]+\\.syncbay\\.app$`));
    assert.strictEqual(await claimDefaultHostname(prisma, { id: svcB.id, name, environment: { name: "production" } }), hostB, "claiming again returns the same host");
    const bWithDomains = await prisma.service.findUniqueOrThrow({ where: { id: svcB.id }, include: { domains: true, environment: true } });
    assert.ok(!resolveServiceHostnames(bWithDomains).includes(hostA), "the second service does not route the first one's host");
    assert.strictEqual(primaryServiceHostname(bWithDomains), hostB);
    ok(`same name + environment → ${hostA} and ${hostB}`);

    const a1 = await deploy(svcA.id);
    assert.strictEqual(a1.row.status, "ACTIVE", JSON.stringify(a1.result));
    assert.strictEqual((await viaRunner(a1.row.assignedPort!)).version, "v1");
    const b1 = await deploy(svcB.id);
    assert.strictEqual(b1.row.status, "FAILED");
    assert.strictEqual(getServiceRoute(hostA)?.status, "ACTIVE", "the other tenant's failed deploy left this host alone");
    assert.strictEqual(getServiceRoute(hostA)?.targetPort, a1.row.assignedPort);
    assert.strictEqual(getServiceRoute(hostB)?.status, "FAILED");
    assert.strictEqual((await resolveServiceRouteFromDb(hostA, { exactHostname: true }))?.targetPort, a1.row.assignedPort);
    ok("a failed deploy of the other service marks only its own host FAILED");

    // ─── 3 + 4. Zero downtime and ports ──────────────────────────────────────
    console.log("\n[3] Zero-downtime redeploys");
    await setVar(svcA.id, "APP_VERSION", "v2");
    await setVar(svcA.id, "APP_DELAY_MS", "4000");
    const d2 = await newDeployment(svcA.id);
    const running = executeDeployment(d2.id, d2.buildId, svcA.id, { serviceId: svcA.id });
    await waitFor("v2 in flight", async () => ["BUILDING", "DEPLOYING"].includes((await prisma.deployment.findUniqueOrThrow({ where: { id: d2.id } })).status));
    const during = getServiceRoute(hostA);
    assert.strictEqual(during?.status, "ACTIVE", "the host is not switched to the build splash");
    assert.strictEqual(during?.targetPort, a1.row.assignedPort);
    assert.strictEqual((await resolveServiceRouteFromDb(hostA, { exactHostname: true }))?.status, "ACTIVE", "DB resolver serves the live version too");
    assert.strictEqual((await viaRunner(a1.row.assignedPort!)).version, "v1", "v1 answers while v2 starts");
    await running;
    const a2 = await prisma.deployment.findUniqueOrThrow({ where: { id: d2.id } });
    assert.strictEqual(a2.status, "ACTIVE");
    assert.notStrictEqual(a2.assignedPort, a1.row.assignedPort);
    assert.strictEqual(getServiceRoute(hostA)?.targetPort, a2.assignedPort);
    assert.strictEqual((await viaRunner(a2.assignedPort!)).version, "v2");
    assert.strictEqual((await prisma.deployment.findUniqueOrThrow({ where: { id: a1.d.id } })).status, "SUPERSEDED");
    ok(`v1 kept serving on :${a1.row.assignedPort} while v2 started; traffic then moved to :${a2.assignedPort}`);

    await prisma.service.update({ where: { id: svcA.id }, data: { startCommand: `node -e "console.error('bad release'); process.exit(3)"` } });
    const a3 = await deploy(svcA.id);
    assert.strictEqual(a3.row.status, "FAILED");
    assert.match(a3.row.errorMessage || "", /bad release/);
    assert.strictEqual(getServiceRoute(hostA)?.status, "ACTIVE", "a failed release does not take the site down");
    assert.strictEqual(getServiceRoute(hostA)?.targetPort, a2.assignedPort);
    const dbRoute = await resolveServiceRouteFromDb(hostA, { exactHostname: true });
    assert.deepStrictEqual([dbRoute?.status, dbRoute?.targetPort], ["ACTIVE", a2.assignedPort]);
    assert.strictEqual((await viaRunner(a2.assignedPort!)).version, "v2");
    ok("a failed release leaves v2 live (registry and DB resolver still ACTIVE on its port)");

    console.log("\n[4] App port vs host port");
    const svcAfter = await prisma.service.findUniqueOrThrow({ where: { id: svcA.id } });
    assert.strictEqual(svcAfter.port, 3000, "Service.port is still the app's own port");
    assert.ok(a2.assignedPort! >= 10000, "the host port lives on the deployment");
    const ingress = await buildIngressRoutesFromDb(prisma);
    assert.strictEqual(ingress.find((r) => r.hostname === hostA)?.targetPort, a2.assignedPort, "tunnel ingress targets the live host port");
    assert.ok(!ingress.some((r) => r.hostname === hostB), "a service with nothing live has no ingress rule");
    ok("Service.port stays 3000; deployment.assignedPort drives routing and tunnel ingress");

    // ─── 5. Always-on ────────────────────────────────────────────────────────
    console.log("\n[5] Always-on reconciler");
    await prisma.service.update({ where: { id: svcA.id }, data: { startCommand: `node "${appFile}"` } });
    await setVar(svcA.id, "APP_DELAY_MS", "0");
    const loaded = async () => prisma.service.findUniqueOrThrow({ where: { id: svcA.id }, include: { domains: true, environment: true } });
    await stopServiceToSleep(await loaded(), { id: a2.id, cfContainerId: a2.cfContainerId }, { reason: "test: put to sleep" });
    assert.strictEqual((await prisma.deployment.findUniqueOrThrow({ where: { id: a2.id } })).status, "SLEEPING");
    assert.strictEqual(getServiceRoute(hostA)?.status, "SLEEPING");

    await prisma.service.update({ where: { id: svcA.id }, data: { scaleToZero: true } });
    assert.ok(!(await wakeAlwaysOnServices()).woken.some((w) => w.serviceId === svcA.id), "scale-to-zero services stay asleep");
    await prisma.service.update({ where: { id: svcA.id }, data: { scaleToZero: false, isPaused: true } });
    assert.ok(!(await wakeAlwaysOnServices()).woken.some((w) => w.serviceId === svcA.id), "paused services stay stopped");
    await prisma.service.update({ where: { id: svcA.id }, data: { isPaused: false } });

    const report = await wakeAlwaysOnServices();
    assert.ok(report.woken.some((w) => w.serviceId === svcA.id && w.deploymentId === a2.id), JSON.stringify(report));
    const awake = await waitFor("always-on service ACTIVE again", async () => {
      const d = await prisma.deployment.findUniqueOrThrow({ where: { id: a2.id } });
      return d.status === "ACTIVE" ? d : null;
    });
    assert.strictEqual((await viaRunner(awake.assignedPort!)).version, "v2");
    assert.strictEqual(getServiceRoute(hostA)?.status, "ACTIVE");
    assert.ok(!(await wakeAlwaysOnServices()).woken.some((w) => w.serviceId === svcA.id), "nothing to do once it is live");
    ok("a sleeping always-on service was started again (newer failed build ignored); scale-to-zero and paused ones were not");

    console.log(`\n✅ verify-availability: ${passed} checks passed (real Postgres + real runner daemon)`);
  } finally {
    await cleanup();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("\nverify-availability FAILED:", err);
    process.exit(1);
  }
);
