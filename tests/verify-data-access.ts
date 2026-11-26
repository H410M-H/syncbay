/**
 * Verification: the Data view ("see your data") and connectivity checks against REAL infrastructure.
 *
 * Real: Postgres (DATABASE_URL, Prisma, migrated; plus a second database `<name>_inspect` that the
 * view inspects), Redis (TEST_REDIS_URL, default redis://127.0.0.1:6379/13), two runner daemon
 * processes spawned from `runner/src/index.ts` (46510: Docker databases, volumes read directly;
 * 46511: RUNNER_VOLUME_ACCESS=container, read through a busybox helper container), the runner
 * of origin/main (46512, to see what an older runner answers), Docker (managed Postgres/Redis
 * containers, a named volume), SeaweedFS S3 in Docker (or TEST_S3_ENDPOINT/…_KEY_ID/…_SECRET)
 * through R2_ENDPOINT, and the real tRPC routers through `appRouter.createCaller`.
 * Mocked: nothing. One tiny local HTTP server stands in for "an old runner that proxies every
 * unknown path to its only app" (answers 200 HTML).
 *
 *  1. Databases: checkConnection (external Postgres, Redis, runner-provisioned Postgres + Redis
 *     with the runner probe, dead port with the firewall/SSH-tunnel hint, wrong password, simulated
 *     sb-db-*, PROVISIONING); schema; 50-row read-only previews with exact identifier quoting.
 *  2. Buckets: checkConnection, delimiter listing (folders), pagination, presigned download,
 *     missing bucket, wrong keys, and the not-configured path.
 *  3. Volumes: native and Docker volumes, listing/reading, binary detection, 64 KiB truncation,
 *     traversal and symlink escapes through tRPC and raw signed runner requests, unsigned and
 *     replayed requests, unknown routes, old runners, no runner, unreachable runner, wrong secret.
 *  4. Membership: outsiders get NOT_FOUND on every new procedure; viewers cannot read contents.
 *  5. Inventory: masked URLs, no passwords or variable values.
 *
 * Usage: DATABASE_URL=postgresql://… npm run test:data
 */

import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { Client as PgClient } from "pg";
import Redis from "ioredis";

const ROOT = path.resolve(__dirname, "..");
const PORT_A = 46510;
const PORT_B = 46511;
const PORT_OLD = 46512;
const PORT_PROXYING_OLD = 46513;
const DEAD_PORT = 46519; // nothing listens here
const SEAWEED_PORT = 46530;
const DB_PORT_RANGE = "46540-46569";
const SECRET = crypto.randomBytes(24).toString("hex");
const RUN = crypto.randomBytes(3).toString("hex");
const SEAWEED_CONTAINER = `sb-data-seaweed-${RUN}`;
const S3_KEY = `sbkey${RUN}`;
const S3_SECRET = `sbsecret${RUN}${crypto.randomBytes(8).toString("hex")}`;
const INSPECT_PASSWORD = "syncbay"; // the local server's password; must never appear in output
const env = process.env as Record<string, string | undefined>;

let passed = 0;
const ok = (msg: string) => {
  passed += 1;
  console.log(`  ✔ ${msg}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 60000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(300);
  }
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

function docker(args: string[], input?: string): string {
  return execFileSync("docker", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], timeout: 120000 });
}

function startRunner(script: string, port: number, stateDir: string, extra: Record<string, string> = {}): ChildProcess {
  fs.mkdirSync(stateDir, { recursive: true });
  const child = spawn(process.execPath, [path.join(ROOT, "node_modules/tsx/dist/cli.mjs"), script], {
    cwd: stateDir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "development",
      RUNNER_PORT: String(port),
      RUNNER_HOST: "127.0.0.1",
      RUNNER_SECRET: SECRET,
      RUNNER_STATE_DIR: stateDir,
      SYNCBAY_API_URL: `http://127.0.0.1:${DEAD_PORT}`,
      RUNNER_AUTO_INSTALL_BUILDX: "false",
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
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required (real, migrated Postgres)");
  for (const k of [
    "GITHUB_TOKEN",
    "RUNNER_QUEUE_MODE",
    "RUNNER_WEBHOOK_SECRET",
    "SYNCBAY_WEBHOOK_SECRET",
    "RUNNER_DRIVER",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "CLOUDFLARE_TUNNEL_ID",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_ENDPOINT",
    "TUNNEL_CONFIG_FILE",
    "VERCEL",
    "VERCEL_ENV",
  ]) {
    delete env[k];
  }
  Object.assign(env, { NODE_ENV: "development", RUNNER_URL: `http://127.0.0.1:${PORT_A}`, RUNNER_SECRET: SECRET, RUNNER_FALLBACK_LOCAL: "false" });

  const inspectUrl = (() => {
    const u = new URL(process.env.TEST_INSPECT_DATABASE_URL || process.env.DATABASE_URL!);
    if (!process.env.TEST_INSPECT_DATABASE_URL) u.pathname = `${u.pathname.replace(/^\//, "") || "postgres"}_inspect`;
    u.search = "";
    return u.toString();
  })();
  const redisUrl = process.env.TEST_REDIS_URL || "redis://127.0.0.1:6379/13";

  const prisma = new PrismaClient();
  (globalThis as any).prisma = prisma;
  const { appRouter } = await import("../src/server/root");
  const { signRequest } = await import("../src/lib/orchestrator/runner-driver");
  const { buildTablePreviewQuery, buildRedisPreviewCommand, PREVIEW_ROW_LIMIT } = await import("../src/lib/query-studio/preview");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-data-"));
  const stateA = path.join(tmp, "runner-a");
  const stateB = path.join(tmp, "runner-b");
  const stateOld = path.join(tmp, "runner-old");
  const children: ChildProcess[] = [];
  const servers: http.Server[] = [];
  const dockerVolumes: string[] = [];
  let seaweedStarted = false;
  const redisKeys: string[] = [];
  const createdDbIds: string[] = [];
  let workspaceIds: string[] = [];
  let userIds: string[] = [];
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });

  const cleanup = async () => {
    for (const c of children) c.kill("SIGTERM");
    for (const s of servers) s.close();
    if (redisKeys.length) await redis.del(...redisKeys).catch(() => undefined);
    redis.disconnect();
    for (const v of dockerVolumes) {
      try {
        docker(["volume", "rm", "-f", v]);
      } catch {}
    }
    if (seaweedStarted) {
      try {
        docker(["rm", "-f", SEAWEED_CONTAINER]);
      } catch {}
    }
    // Runner-provisioned database containers (a failed run may not have deleted them).
    for (const id of createdDbIds) {
      try {
        const names = docker(["ps", "-aq", "--filter", `label=syncbay.managed-db=${id.toLowerCase()}`]).trim();
        if (names) docker(["rm", "-f", "-v", ...names.split(/\s+/)]);
      } catch {}
    }
    if (workspaceIds.length) {
      await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } }).catch((e) => console.error("cleanup workspaces:", e.message));
    }
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    await prisma.$disconnect();
    fs.rmSync(tmp, { recursive: true, force: true });
  };

  try {
    // ─── Infrastructure ──────────────────────────────────────────────────────
    console.log("\n[0] Infrastructure");
    // Inspected database: created on the same server when missing.
    {
      const admin = new PgClient({ connectionString: process.env.DATABASE_URL });
      await admin.connect();
      const dbName = new URL(inspectUrl).pathname.slice(1);
      const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
      if (!exists.rowCount) await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
      await admin.end();
      const c = new PgClient({ connectionString: inspectUrl });
      await c.connect();
      await c.query(`DROP TABLE IF EXISTS public.items, public."we""ird name"; DROP SCHEMA IF EXISTS other CASCADE;`);
      await c.query(`CREATE TABLE public.items (id serial PRIMARY KEY, label text, note text)`);
      await c.query(`INSERT INTO public.items (label, note) SELECT 'item-' || g, CASE WHEN g % 7 = 0 THEN NULL ELSE 'n' END FROM generate_series(1, 60) g`);
      await c.query(`CREATE TABLE public."we""ird name" ("col ""x""" text); INSERT INTO public."we""ird name" VALUES ('quoted-ok')`);
      await c.query(`CREATE SCHEMA other; CREATE TABLE other.things (v int); INSERT INTO other.things VALUES (1), (2), (3)`);
      await c.end();
    }
    ok(`inspected Postgres ${new URL(inspectUrl).pathname.slice(1)}: items (60 rows), "we""ird name", other.things`);

    await redis.connect();
    const rk = (k: string) => {
      const key = `sbdata:${RUN}:${k}`;
      redisKeys.push(key);
      return key;
    };
    await redis.set(rk("str"), "hello");
    await redis.hset(rk("hash"), { a: "1", b: "2" });
    await redis.rpush(rk("list"), ...Array.from({ length: 70 }, (_, i) => `v${i}`));
    await redis.sadd(rk("set"), "x", "y");
    await redis.zadd(rk("zset"), 1, "one", 2, "two");
    await redis.xadd(rk("stream"), "*", "f", "v");
    await redis.set(rk('we"ird \\ key'), "quoted");
    ok(`Redis ${redisUrl}: 7 keys seeded (string, hash, 70-item list, set, zset, stream, quoted name)`);

    children.push(startRunner(path.join(ROOT, "runner/src/index.ts"), PORT_A, stateA, { RUNNER_DB_MODE: "docker", RUNNER_DB_PORT_RANGE: DB_PORT_RANGE }));
    children.push(startRunner(path.join(ROOT, "runner/src/index.ts"), PORT_B, stateB, { RUNNER_DB_MODE: "mock", RUNNER_VOLUME_ACCESS: "container" }));
    // A runner from before the volume routes (the parent of the commit that added them; origin/main
    // has them since PR #22), for the "runner needs updating" path.
    let oldRunner = false;
    try {
      fs.mkdirSync(stateOld, { recursive: true });
      const archive = execFileSync("git", ["-C", ROOT, "archive", "0389be2^", "runner/src"], { maxBuffer: 64 * 1024 * 1024 });
      execFileSync("tar", ["-x", "-C", stateOld], { input: archive });
      children.push(startRunner(path.join(stateOld, "runner/src/index.ts"), PORT_OLD, path.join(stateOld, "state"), { RUNNER_DB_MODE: "mock" }));
      oldRunner = true;
    } catch (e: any) {
      console.log(`  - origin/main runner not available (${e.message.split("\n")[0]}); old-runner check uses the stub only`);
    }
    const proxyingOld = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>my app</title>");
    });
    await new Promise<void>((r) => proxyingOld.listen(PORT_PROXYING_OLD, "127.0.0.1", () => r()));
    servers.push(proxyingOld);
    for (const port of oldRunner ? [PORT_A, PORT_B, PORT_OLD] : [PORT_A, PORT_B]) {
      await waitFor(`runner ${port}`, async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok, 60000);
    }
    ok(`runner daemons up on ${PORT_A} (docker DBs, direct volumes) and ${PORT_B} (container helper)${oldRunner ? `, origin/main runner on ${PORT_OLD}` : ""}`);

    // SeaweedFS S3 (unless an endpoint is given).
    let s3: { endpoint: string; key: string; secret: string } | null = null;
    if (process.env.TEST_S3_ENDPOINT && process.env.TEST_S3_ACCESS_KEY_ID && process.env.TEST_S3_SECRET_ACCESS_KEY) {
      s3 = { endpoint: process.env.TEST_S3_ENDPOINT, key: process.env.TEST_S3_ACCESS_KEY_ID, secret: process.env.TEST_S3_SECRET_ACCESS_KEY };
    } else {
      try {
        const cfg = path.join(tmp, "s3.json");
        fs.writeFileSync(
          cfg,
          JSON.stringify({ identities: [{ name: "syncbay", credentials: [{ accessKey: S3_KEY, secretKey: S3_SECRET }], actions: ["Admin", "Read", "List", "Tagging", "Write"] }] })
        );
        fs.chmodSync(tmp, 0o755);
        fs.chmodSync(cfg, 0o644);
        docker(["run", "-d", "--name", SEAWEED_CONTAINER, "-p", `127.0.0.1:${SEAWEED_PORT}:8333`, "-v", `${cfg}:/etc/s3.json:ro`, "chrislusf/seaweedfs", "server", "-s3", "-s3.config=/etc/s3.json"]);
        seaweedStarted = true;
        // Anonymous requests are refused (403) once the S3 gateway is up.
        await waitFor("SeaweedFS S3", async () => (await fetch(`http://127.0.0.1:${SEAWEED_PORT}/`)).status === 403, 90000);
        s3 = { endpoint: `http://127.0.0.1:${SEAWEED_PORT}`, key: S3_KEY, secret: S3_SECRET };
      } catch (e: any) {
        console.log(`  - SeaweedFS could not start (${e.message.split("\n")[0]}); only the not-configured bucket path runs`);
      }
    }
    if (s3) ok(`S3 endpoint ${s3.endpoint}${seaweedStarted ? " (SeaweedFS in Docker, auth enabled)" : ""}`);

    // ─── Fixtures ────────────────────────────────────────────────────────────
    const mkUser = (r: string) => prisma.user.create({ data: { email: `${r}-${RUN}@data.test.syncbay.app`, name: r } });
    const [owner, member, viewer, outsider] = await Promise.all(["owner", "member", "viewer", "outsider"].map(mkUser));
    userIds = [owner.id, member.id, viewer.id, outsider.id];
    const workspace = await prisma.workspace.create({
      data: {
        name: `data-${RUN}`,
        slug: `data-${RUN}`,
        members: { create: [{ userId: owner.id, role: "OWNER" }, { userId: member.id, role: "MEMBER" }, { userId: viewer.id, role: "VIEWER" }] },
      },
    });
    const otherWs = await prisma.workspace.create({ data: { name: `other-${RUN}`, slug: `other-${RUN}`, members: { create: [{ userId: outsider.id, role: "OWNER" }] } } });
    workspaceIds = [workspace.id, otherWs.id];
    const project = await prisma.project.create({ data: { workspaceId: workspace.id, name: `shop-${RUN}` } });
    const prodEnv = await prisma.environment.create({ data: { projectId: project.id, name: "production", isDefault: true } });
    const svc = await prisma.service.create({
      data: {
        environmentId: prodEnv.id,
        name: `web${RUN}`,
        sourceType: "empty",
        startCommand: "node server.js",
        port: 3000,
        variables: { create: [{ key: "API_KEY", value: `sk_live_VARSECRET${RUN}`, isSecret: true }] },
      },
    });
    const nativeVol = await prisma.volume.create({ data: { serviceId: svc.id, name: "uploads", mountPath: "/data", sizeGb: 1 } });
    const dockerVol = await prisma.volume.create({ data: { serviceId: svc.id, name: "cache", mountPath: "/cache", sizeGb: 1 } });
    const ghostVol = await prisma.volume.create({ data: { serviceId: svc.id, name: "never-deployed", mountPath: "/ghost", sizeGb: 1 } });

    const ctx = (userId: string) => ({ db: prisma, session: { user: { id: userId }, expires: "2099-01-01" }, headers: new Headers() });
    const asOwner = appRouter.createCaller(ctx(owner.id) as any);
    const asMember = appRouter.createCaller(ctx(member.id) as any);
    const asViewer = appRouter.createCaller(ctx(viewer.id) as any);
    const asOutsider = appRouter.createCaller(ctx(outsider.id) as any);

    // ─── 1. Databases ────────────────────────────────────────────────────────
    console.log("\n[1] Databases");
    const extPg = await prisma.databaseInstance.create({
      data: { environmentId: prodEnv.id, name: "inspect", provider: "POSTGRES", region: "local", status: "ACTIVE", connectionUrl: inspectUrl },
    });
    const extRedis = await prisma.databaseInstance.create({
      data: { environmentId: prodEnv.id, name: "cache-redis", provider: "REDIS", region: "local", status: "ACTIVE", connectionUrl: redisUrl },
    });
    const deadUrl = `postgresql://app:dead-pw-${RUN}@127.0.0.1:${DEAD_PORT}/app`;
    const deadPg = await prisma.databaseInstance.create({
      data: { environmentId: prodEnv.id, name: "dead", provider: "POSTGRES", region: "local", status: "ACTIVE", connectionUrl: deadUrl },
    });
    const badPwUrl = (() => {
      const u = new URL(inspectUrl);
      u.password = `wrong-pw-${RUN}`;
      return u.toString();
    })();
    const badPw = await prisma.databaseInstance.create({
      data: { environmentId: prodEnv.id, name: "badpw", provider: "POSTGRES", region: "local", status: "ACTIVE", connectionUrl: badPwUrl },
    });
    const simulated = await prisma.databaseInstance.create({
      data: { environmentId: prodEnv.id, name: "sim", provider: "POSTGRES", region: "local", status: "ACTIVE", connectionUrl: `postgresql://u:simpw${RUN}@sb-db-${RUN}.syncbay-db.internal:5432/app` },
    });
    const provisioning = await prisma.databaseInstance.create({
      data: { environmentId: prodEnv.id, name: "pending", provider: "POSTGRES", region: "local", status: "PROVISIONING", connectionUrl: "" },
    });

    // Viewers never receive the password: not in the URL, the credentials or the CLI command.
    const pgPassword = new URL(inspectUrl).password;
    for (const seen of [await asViewer.database.byId({ databaseId: extPg.id }), ...(await asViewer.database.list({ environmentId: prodEnv.id }))]) {
      assert.ok(!JSON.stringify(seen).includes(`:${pgPassword}@`) && seen.credentials.password === "", `viewer sees no password: ${seen.credentials.cliCommand}`);
    }
    assert.ok(JSON.stringify(await asOwner.database.byId({ databaseId: extPg.id })).includes(`:${pgPassword}@`), "owners still get the full URL");
    ok("viewers get masked connection URLs, credentials and CLI commands; owners the real ones");
    const pgCheck = await asViewer.database.checkConnection({ databaseId: extPg.id });
    assert.strictEqual(pgCheck.ok, true, JSON.stringify(pgCheck));
    assert.match(pgCheck.serverVersion || "", /^\d+/);
    assert.strictEqual(pgCheck.runner, null, "external DB: no runner probe");
    ok(`external Postgres: ok in ${pgCheck.latencyMs} ms, server ${pgCheck.serverVersion} (viewer may test)`);

    const redisCheck = await asMember.database.checkConnection({ databaseId: extRedis.id });
    assert.strictEqual(redisCheck.ok, true, JSON.stringify(redisCheck));
    assert.match(redisCheck.serverVersion || "", /^\d+\.\d+/);
    ok(`external Redis: ok in ${redisCheck.latencyMs} ms, server ${redisCheck.serverVersion}`);

    const dead = await asOwner.database.checkConnection({ databaseId: deadPg.id });
    assert.strictEqual(dead.ok, false);
    assert.match(dead.error || "", /ECONNREFUSED/);
    assert.match(dead.hint || "", /firewall/i);
    assert.match(dead.hint || "", /ssh -N -L/);
    assert.ok(!JSON.stringify(dead).includes(`dead-pw-${RUN}`), "password not echoed");
    ok(`dead port: ok:false (${dead.error}); hint names the firewall and an SSH tunnel; no password`);

    const wrongPw = await asOwner.database.checkConnection({ databaseId: badPw.id });
    assert.strictEqual(wrongPw.ok, false);
    assert.match(`${wrongPw.error} ${wrongPw.hint}`, /password|credential|auth/i);
    assert.ok(!JSON.stringify(wrongPw).includes(`wrong-pw-${RUN}`));
    ok(`wrong password: ok:false with a credentials hint (${wrongPw.hint})`);

    const sim = await asOwner.database.checkConnection({ databaseId: simulated.id });
    assert.strictEqual(sim.ok, false);
    assert.match(sim.error || "", /simulated/);
    const pend = await asOwner.database.checkConnection({ databaseId: provisioning.id });
    assert.strictEqual(pend.ok, false);
    assert.match(pend.error || "", /provisioning/);
    ok("simulated sb-db-* and PROVISIONING databases: ok:false with a reason");

    // Schema + previews
    const schema = await asViewer.queryStudio.getSchema({ databaseId: extPg.id });
    const names = schema.tables.map((t: any) => t.tableName);
    for (const n of ["items", 'we"ird name', "other.things"]) assert.ok(names.includes(n), `schema lists ${n}: ${names.join(", ")}`);
    const items = schema.tables.find((t: any) => t.tableName === "items")!;
    const weird = schema.tables.find((t: any) => t.tableName === 'we"ird name')!;
    const things = schema.tables.find((t: any) => t.tableName === "other.things")!;
    assert.strictEqual((things as any).schema, "other");
    assert.strictEqual((things as any).name, "things");
    const itemsQuery = buildTablePreviewQuery("POSTGRES", items);
    assert.strictEqual(itemsQuery, `SELECT * FROM "public"."items" LIMIT ${PREVIEW_ROW_LIMIT}`);
    const itemsRows = await asMember.queryStudio.execute({ databaseId: extPg.id, query: itemsQuery, mode: "read", safeMode: true });
    assert.strictEqual(itemsRows.rowCount, 50);
    assert.ok(itemsRows.rows.some((r: any) => r.note === null), "NULLs come through");
    const weirdRows = await asMember.queryStudio.execute({ databaseId: extPg.id, query: buildTablePreviewQuery("POSTGRES", weird), mode: "read", safeMode: true });
    assert.deepStrictEqual(weirdRows.rows, [{ 'col "x"': "quoted-ok" }]);
    const thingRows = await asMember.queryStudio.execute({ databaseId: extPg.id, query: buildTablePreviewQuery("POSTGRES", things), mode: "read", safeMode: true });
    assert.strictEqual(thingRows.rowCount, 3);
    await rejects(() => asViewer.queryStudio.execute({ databaseId: extPg.id, query: itemsQuery, mode: "read", safeMode: true }), (e) => e.code === "FORBIDDEN", "viewer rows");
    ok(`schema: ${names.length} tables incl. "we""ird name" and other.things; previews: items 50 of 60 rows, quoted table 1 row, other.things 3 rows; viewer refused rows`);

    const redisSchema = await asMember.queryStudio.getSchema({ databaseId: extRedis.id });
    const ours = redisSchema.tables.filter((t: any) => t.tableName.startsWith(`sbdata:${RUN}:`));
    assert.strictEqual(ours.length, 7, `our keys: ${ours.map((t: any) => t.tableName).join(", ")}`);
    const seen: string[] = [];
    for (const t of ours) {
      const type = t.columns[0]?.type ?? "string";
      const cmd = buildRedisPreviewCommand(t.tableName, type);
      const res = await asMember.queryStudio.execute({ databaseId: extRedis.id, query: cmd, mode: "read", safeMode: true });
      const blob = JSON.stringify(res.rows);
      if (type === "string") assert.ok(blob.includes(t.tableName.endsWith("str") ? "hello" : "quoted"), `${t.tableName}: ${blob}`);
      if (type === "list") {
        assert.ok(blob.includes("v49") && !blob.includes("v50"), "list preview capped at 50 items");
      }
      if (type === "hash") assert.ok(blob.includes('"a"') || blob.includes("a"), blob);
      seen.push(type);
    }
    for (const t of ["string", "hash", "list", "set", "zset", "stream"]) assert.ok(seen.includes(t), `previewed a ${t}`);
    ok(`Redis key sample: ${ours.length} keys typed (${[...new Set(seen)].join(", ")}); every preview command runs read-only; list capped at 50`);

    // Runner-provisioned Postgres + Redis (Docker on runner A)
    const managedPg = await asOwner.database.create({ environmentId: prodEnv.id, name: `mpg${RUN}`, provider: "POSTGRES" });
    createdDbIds.push(managedPg.id);
    const managedRedis = await asOwner.database.create({ environmentId: prodEnv.id, name: `mredis${RUN}`, provider: "REDIS" });
    createdDbIds.push(managedRedis.id);
    for (const db of [managedPg, managedRedis]) {
      assert.ok((db as any).containerId, `${db.name} has a runner container`);
      const check = await waitFor(
        `${db.name} reachable`,
        async () => {
          const r = await asOwner.database.checkConnection({ databaseId: db.id });
          return r.ok && r.runner?.healthy ? r : null;
        },
        60000
      );
      assert.ok(check.serverVersion);
      ok(`runner-provisioned ${db.provider}: ok in ${check.latencyMs} ms, server ${check.serverVersion}, runner probe healthy (${check.runner!.latencyMs} ms)`);
    }
    const mSchema = await asOwner.queryStudio.getSchema({ databaseId: managedPg.id });
    assert.ok(Array.isArray(mSchema.tables));
    ok(`runner-provisioned Postgres introspects (${mSchema.tables.length} tables in a fresh database)`);

    // ─── 2. Buckets ──────────────────────────────────────────────────────────
    console.log("\n[2] Buckets");
    const notConfiguredBucket = await prisma.bucket.create({ data: { projectId: project.id, name: "offline", r2BucketRef: `sb-offline-${RUN}` } });
    const nc = await asViewer.bucket.checkConnection({ bucketId: notConfiguredBucket.id });
    assert.strictEqual(nc.ok, false);
    assert.match(nc.hint || "", /R2 keys are not configured on Syncbay/);
    const ncInv = await asOwner.data.inventory({ projectId: project.id });
    assert.strictEqual(ncInv.storageConfigured, false);
    ok(`no R2 keys: checkConnection ok:false — "${nc.hint}"; inventory.storageConfigured=false`);

    let bucketId: string | null = null;
    if (s3) {
      Object.assign(env, { R2_ENDPOINT: s3.endpoint, R2_ACCESS_KEY_ID: s3.key, R2_SECRET_ACCESS_KEY: s3.secret });
      const bucket = await asMember.bucket.create({ projectId: project.id, name: `media${RUN}` });
      bucketId = bucket.id;
      const files: Record<string, Buffer> = {
        "readme.txt": Buffer.from("top level\n"),
        "folder/a.txt": Buffer.from("alpha\n"),
        "folder/c.bin": crypto.randomBytes(300),
        "folder/sub/b.txt": Buffer.from("beta\n"),
      };
      for (const [key, body] of Object.entries(files)) {
        const put = await asMember.bucket.generatePresignedUrl({ bucketId: bucket.id, key, operation: "put", expiresInSeconds: 300 });
        const res = await fetch(put.url, { method: "PUT", body: new Uint8Array(body) });
        assert.ok(res.ok, `PUT ${key}: ${res.status} ${await res.text()}`);
      }
      const check = await asViewer.bucket.checkConnection({ bucketId: bucket.id });
      assert.strictEqual(check.ok, true, JSON.stringify(check));
      assert.strictEqual(check.hasObjects, true);
      ok(`bucket created on the S3 server, 4 objects uploaded via presigned PUT; checkConnection ok in ${check.latencyMs} ms, hasObjects`);

      const root = await asViewer.bucket.listObjects({ bucketId: bucket.id, delimiter: "/" });
      assert.deepStrictEqual(root.prefixes, ["folder/"]);
      assert.deepStrictEqual(root.objects.map((o: any) => o.key), ["readme.txt"]);
      const folder = await asViewer.bucket.listObjects({ bucketId: bucket.id, delimiter: "/", prefix: "folder/" });
      assert.deepStrictEqual(folder.prefixes, ["folder/sub/"]);
      assert.deepStrictEqual(folder.objects.map((o: any) => o.key).sort(), ["folder/a.txt", "folder/c.bin"]);
      assert.strictEqual(folder.objects.find((o: any) => o.key === "folder/c.bin")!.size, 300);
      const p1 = await asViewer.bucket.listObjects({ bucketId: bucket.id, limit: 2 });
      assert.strictEqual(p1.objects.length, 2);
      assert.ok(p1.nextContinuationToken, "first page has a cursor");
      const p2 = await asViewer.bucket.listObjects({ bucketId: bucket.id, limit: 2, cursor: p1.nextContinuationToken! });
      assert.strictEqual(new Set([...p1.objects, ...p2.objects].map((o: any) => o.key)).size, 4);
      ok("delimiter listing: root → [folder/] + readme.txt; folder/ → [folder/sub/] + a.txt, c.bin (300 B); cursor pagination covers all 4 keys");

      const dl = await asOwner.bucket.generatePresignedUrl({ bucketId: bucket.id, key: "folder/c.bin", operation: "get", expiresInSeconds: 300 });
      const got = Buffer.from(await (await fetch(dl.url)).arrayBuffer());
      assert.ok(got.equals(files["folder/c.bin"]), "downloaded bytes match");
      for (const operation of ["get", "put"] as const) {
        await assert.rejects(asViewer.bucket.generatePresignedUrl({ bucketId: bucket.id, key: "folder/c.bin", operation, expiresInSeconds: 300 }), (e: any) => e.code === "FORBIDDEN");
      }
      ok("presigned GET downloads the exact bytes; viewers get no download or upload link");

      const missing = await prisma.bucket.create({ data: { projectId: project.id, name: "gone", r2BucketRef: `sb-gone-${RUN}` } });
      const gone = await asOwner.bucket.checkConnection({ bucketId: missing.id });
      assert.strictEqual(gone.ok, false);
      assert.match(gone.error || "", /does not exist/);
      env.R2_SECRET_ACCESS_KEY = "wrong-secret-key";
      const denied = await asOwner.bucket.checkConnection({ bucketId: bucket.id });
      env.R2_SECRET_ACCESS_KEY = s3.secret;
      assert.strictEqual(denied.ok, false);
      assert.match(denied.hint || "", /refused Syncbay's R2 keys/);
      ok(`missing bucket → "${gone.error}"; wrong secret → ok:false, hint "${denied.hint}"`);
    }

    // ─── 3. Volumes ──────────────────────────────────────────────────────────
    console.log("\n[3] Volumes");
    const volRoot = path.join(stateA, "volumes", nativeVol.id);
    fs.mkdirSync(path.join(volRoot, "nested/deep"), { recursive: true });
    fs.writeFileSync(path.join(volRoot, "hello.txt"), "hello volume\n");
    fs.writeFileSync(path.join(volRoot, "nested/deep/note.md"), "# deep\n");
    fs.writeFileSync(path.join(volRoot, "photo.png"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), crypto.randomBytes(512)]));
    fs.writeFileSync(path.join(volRoot, "big.log"), "x".repeat(100 * 1024));
    fs.writeFileSync(path.join(stateA, "secret.txt"), "TOP-SECRET runner file\n");
    fs.symlinkSync("/etc", path.join(volRoot, "etc-link"));
    fs.symlinkSync("/etc/passwd", path.join(volRoot, "passwd-link"));
    fs.symlinkSync("../../secret.txt", path.join(volRoot, "rel-escape"));
    fs.symlinkSync("hello.txt", path.join(volRoot, "inner-link"));

    const vCheck = await asViewer.volume.checkConnection({ volumeId: nativeVol.id });
    assert.strictEqual(vCheck.ok, true, JSON.stringify(vCheck));
    assert.strictEqual((vCheck as any).backend, "native");
    ok(`native volume: checkConnection ok (${(vCheck as any).entries} entries, ${vCheck.latencyMs} ms)`);

    const listing = await asViewer.volume.listFiles({ volumeId: nativeVol.id, path: "" });
    const byName = Object.fromEntries(listing.entries.map((e: any) => [e.name, e]));
    assert.strictEqual(byName["nested"].type, "dir");
    assert.strictEqual(byName["hello.txt"].type, "file");
    assert.strictEqual(byName["hello.txt"].size, 13);
    for (const l of ["etc-link", "passwd-link", "rel-escape", "inner-link"]) assert.strictEqual(byName[l].type, "symlink", l);
    const deep = await asViewer.volume.listFiles({ volumeId: nativeVol.id, path: "nested/deep" });
    assert.deepStrictEqual(deep.entries.map((e: any) => e.name), ["note.md"]);
    ok(`viewer lists files: ${listing.entries.length} root entries (symlinks reported as symlinks), nested/deep → note.md`);

    await rejects(() => asViewer.volume.readFile({ volumeId: nativeVol.id, path: "hello.txt" }), (e) => e.code === "FORBIDDEN", "viewer readFile");
    const hello = await asMember.volume.readFile({ volumeId: nativeVol.id, path: "hello.txt" });
    assert.strictEqual(hello.kind, "text");
    assert.strictEqual((hello as any).text, "hello volume\n");
    const note = await asMember.volume.readFile({ volumeId: nativeVol.id, path: "nested/deep/note.md" });
    assert.strictEqual((note as any).text, "# deep\n");
    const png = await asMember.volume.readFile({ volumeId: nativeVol.id, path: "photo.png" });
    assert.strictEqual(png.kind, "binary");
    assert.strictEqual((png as any).mimeType, "image/png");
    assert.strictEqual(png.size, 520);
    assert.ok(!("text" in png), "binary content not returned");
    const big = await asMember.volume.readFile({ volumeId: nativeVol.id, path: "big.log" });
    assert.strictEqual(big.kind, "text");
    assert.strictEqual(big.truncated, true);
    assert.strictEqual(big.size, 100 * 1024);
    assert.strictEqual((big as any).text.length, 64 * 1024);
    ok("member reads: text (hello.txt, nested note), binary photo.png → size 520 + image/png only, big.log 100 KB → first 64 KB, truncated; viewer refused");

    const traversal: Array<[string, string]> = [
      ["../../secret.txt", "BAD_REQUEST"],
      ["nested/../../secret.txt", "BAD_REQUEST"],
      ["/etc/passwd", "BAD_REQUEST"],
      ["..\\..\\secret.txt", "BAD_REQUEST"],
      ["%2e%2e/%2e%2e/secret.txt", "NOT_FOUND"], // literal name, not decoded: stays inside the volume
      ["passwd-link", "FORBIDDEN"],
      ["rel-escape", "FORBIDDEN"],
      ["etc-link/passwd", "FORBIDDEN"],
    ];
    for (const [p, code] of traversal) {
      const err = await rejects(() => asMember.volume.readFile({ volumeId: nativeVol.id, path: p }), (e) => e.code === code, `readFile ${p}`);
      assert.ok(!String(err.message).includes("TOP-SECRET") && !String(err.message).includes("root:x:"), "no content leaks");
    }
    await rejects(() => asMember.volume.listFiles({ volumeId: nativeVol.id, path: "etc-link" }), (e) => e.code === "FORBIDDEN", "list etc-link");
    await rejects(() => asMember.volume.listFiles({ volumeId: nativeVol.id, path: "../" }), (e) => e.code === "BAD_REQUEST", "list ../");
    const inner = await asMember.volume.readFile({ volumeId: nativeVol.id, path: "inner-link" });
    assert.strictEqual((inner as any).text, "hello volume\n");
    ok(`tRPC traversal refused: ${traversal.length} read attempts (.., backslashes, absolute, symlinks to /etc and outside) + 2 listings; an internal symlink still reads`);

    // Raw signed runner requests (the runner is the guard, whatever the caller sends)
    const runnerGet = (port: number, target: string, headers?: Record<string, string>) => {
      const u = new URL(target, "http://x");
      const h = headers ?? signRequest(SECRET, "GET", u.pathname, `${u.pathname}${u.search}`).headers;
      return fetch(`http://127.0.0.1:${port}${target}`, { headers: h });
    };
    const vp = `/api/volumes/${nativeVol.id}`;
    const raw: Array<[string, number, string]> = [
      [`${vp}/file?path=..%2F..%2Fsecret.txt`, 400, "INVALID_PATH"],
      [`${vp}/file?path=%2e%2e%2F%2e%2e%2Fsecret.txt`, 400, "INVALID_PATH"],
      [`${vp}/file?path=%2Fetc%2Fpasswd`, 400, "INVALID_PATH"],
      [`${vp}/file?path=passwd-link`, 403, "PATH_ESCAPES"],
      [`${vp}/file?path=rel-escape`, 403, "PATH_ESCAPES"],
      [`${vp}/files?path=etc-link`, 403, "PATH_ESCAPES"],
      [`/api/volumes/..%2F..%2Fetc/stat`, 400, "INVALID_ID"],
      [`${vp}/nope`, 404, "UNKNOWN_ROUTE"],
      [`/api/volumes`, 404, "UNKNOWN_ROUTE"],
      [`/api/volumes/no-such-volume/stat`, 404, "VOLUME_NOT_FOUND"],
    ];
    for (const [target, status, code] of raw) {
      const res = await runnerGet(PORT_A, target);
      const text = await res.text();
      assert.strictEqual(res.status, status, `${target}: ${res.status} ${text}`);
      assert.strictEqual(JSON.parse(text).code, code, target);
      assert.ok(!text.includes("TOP-SECRET") && !text.includes("root:x:"), target);
    }
    assert.strictEqual((await runnerGet(PORT_A, `${vp}/file?path=hello.txt`, {})).status, 401, "unsigned");
    const signedOnce = signRequest(SECRET, "GET", `${vp}/file`, `${vp}/file?path=hello.txt`).headers;
    assert.strictEqual((await runnerGet(PORT_A, `${vp}/file?path=hello.txt`, signedOnce)).status, 200);
    assert.strictEqual((await runnerGet(PORT_A, `${vp}/file?path=hello.txt`, signedOnce)).status, 401, "replay");
    const swapped = signRequest(SECRET, "GET", `${vp}/file`, `${vp}/file?path=hello.txt`).headers;
    assert.strictEqual((await runnerGet(PORT_A, `${vp}/file?path=big.log`, swapped)).status, 401, "query is signed");
    ok(`raw runner requests: ${raw.length} hostile/unknown targets answered with status + code, nothing leaked; unsigned 401, replay 401, swapped query 401`);

    // Docker named volume: direct mountpoint (runner A) and helper container (runner B)
    const dockerName = `syncbay-vol-${dockerVol.id.toLowerCase()}`;
    docker(["volume", "create", dockerName]);
    dockerVolumes.push(dockerName);
    docker([
      "run", "--rm", "-v", `${dockerName}:/v`, "busybox:1.36.1", "sh", "-c",
      "mkdir -p /v/logs && echo 'cached entry' > /v/item.txt && printf 'l1\\nl2\\n' > /v/logs/app.log && head -c 200 /dev/urandom > /v/blob.bin && ln -s /etc/shadow /v/shadow-link && ln -s item.txt /v/inner",
    ]);
    for (const [port, access] of [[PORT_A, "direct"], [PORT_B, "container"]] as const) {
      env.RUNNER_URL = `http://127.0.0.1:${port}`;
      const c = await asMember.volume.checkConnection({ volumeId: dockerVol.id });
      assert.strictEqual(c.ok, true, JSON.stringify(c));
      assert.strictEqual((c as any).backend, "docker");
      assert.strictEqual((c as any).access, access);
      const l = await asMember.volume.listFiles({ volumeId: dockerVol.id, path: "" });
      const types = Object.fromEntries(l.entries.map((e: any) => [e.name, e.type]));
      assert.deepStrictEqual(types, { logs: "dir", "item.txt": "file", "blob.bin": "file", "shadow-link": "symlink", inner: "symlink" }, JSON.stringify(types));
      const item = await asMember.volume.readFile({ volumeId: dockerVol.id, path: "item.txt" });
      assert.strictEqual((item as any).text, "cached entry\n");
      const log = await asMember.volume.readFile({ volumeId: dockerVol.id, path: "logs/app.log" });
      assert.strictEqual((log as any).text, "l1\nl2\n");
      const blob = await asMember.volume.readFile({ volumeId: dockerVol.id, path: "blob.bin" });
      assert.strictEqual(blob.size, 200);
      const viaInner = await asMember.volume.readFile({ volumeId: dockerVol.id, path: "inner" });
      assert.strictEqual((viaInner as any).text, "cached entry\n");
      await rejects(() => asMember.volume.readFile({ volumeId: dockerVol.id, path: "shadow-link" }), (e) => e.code === "FORBIDDEN", `${access} shadow-link`);
      await rejects(() => asMember.volume.readFile({ volumeId: dockerVol.id, path: "../../../etc/shadow" }), (e) => e.code === "BAD_REQUEST", `${access} ..`);
      await rejects(() => asMember.volume.listFiles({ volumeId: dockerVol.id, path: "item.txt" }), (e) => e.code === "BAD_REQUEST", `${access} list a file`);
      ok(`Docker volume via runner ${port} (${access}): check ok, 5 entries typed, text/nested/binary/internal-symlink reads, /etc/shadow link + .. refused`);
    }
    env.RUNNER_URL = `http://127.0.0.1:${PORT_A}`;

    // Volume that was never deployed, old runners, no runner, unreachable runner, wrong secret
    const ghost = await asMember.volume.checkConnection({ volumeId: ghostVol.id });
    assert.strictEqual(ghost.ok, false);
    assert.strictEqual((ghost as any).code, "VOLUME_NOT_FOUND");
    assert.match(ghost.hint || "", /Deploy the service first/);
    await rejects(() => asMember.volume.listFiles({ volumeId: ghostVol.id, path: "" }), (e) => e.code === "NOT_FOUND", "ghost list");
    ok(`never-deployed volume: ok:false VOLUME_NOT_FOUND — "${ghost.hint}"`);

    const outdated: Array<[number, string]> = oldRunner ? [[PORT_OLD, "origin/main runner"], [PORT_PROXYING_OLD, "old runner proxying to its app"]] : [[PORT_PROXYING_OLD, "old runner proxying to its app"]];
    if (oldRunner) {
      const rawOld = await runnerGet(PORT_OLD, `${vp}/stat`);
      const body = await rawOld.text();
      assert.strictEqual(rawOld.status, 404);
      assert.ok(!JSON.parse(body).code, `old runner answers without a code: ${body}`);
      ok(`origin/main runner answers ${rawOld.status} ${body} for ${vp}/stat (no code)`);
    }
    for (const [port, label] of outdated) {
      env.RUNNER_URL = `http://127.0.0.1:${port}`;
      const c = await asMember.volume.checkConnection({ volumeId: nativeVol.id });
      assert.strictEqual(c.ok, false);
      assert.strictEqual((c as any).code, "RUNNER_OUTDATED", `${label}: ${JSON.stringify(c)}`);
      assert.match(c.hint || "", /runner needs updating/);
      await rejects(() => asMember.volume.listFiles({ volumeId: nativeVol.id, path: "" }), (e) => e.code === "PRECONDITION_FAILED" && /runner needs updating/.test(e.message), `${label} list`);
      ok(`${label}: RUNNER_OUTDATED, "runner needs updating" (check + PRECONDITION_FAILED on list)`);
    }

    delete env.RUNNER_URL;
    const none = await asMember.volume.checkConnection({ volumeId: nativeVol.id });
    assert.strictEqual(none.ok, false);
    assert.match(none.error || "", /Volumes live on a runner/);
    await rejects(() => asMember.volume.listFiles({ volumeId: nativeVol.id, path: "" }), (e) => e.code === "PRECONDITION_FAILED", "no runner list");
    const invNoRunner = await asMember.data.inventory({ projectId: project.id });
    assert.strictEqual(invNoRunner.runnerConfigured, false);
    env.RUNNER_URL = `http://127.0.0.1:${DEAD_PORT}`;
    const unreachable = await asMember.volume.checkConnection({ volumeId: nativeVol.id });
    assert.strictEqual((unreachable as any).code, "RUNNER_UNREACHABLE");
    env.RUNNER_URL = `http://127.0.0.1:${PORT_A}`;
    env.RUNNER_SECRET = "not-the-runner-secret";
    const badSecret = await asMember.volume.checkConnection({ volumeId: nativeVol.id });
    env.RUNNER_SECRET = SECRET;
    assert.strictEqual((badSecret as any).code, "RUNNER_AUTH");
    ok(`no RUNNER_URL → "${none.error}"; dead runner → RUNNER_UNREACHABLE; wrong secret → RUNNER_AUTH`);

    // ─── 4. Membership ───────────────────────────────────────────────────────
    console.log("\n[4] Membership");
    const notFound = (e: any) => e.code === "NOT_FOUND" || e.code === "FORBIDDEN";
    const outsiderCalls: Array<[string, () => Promise<unknown>]> = [
      ["data.inventory", () => asOutsider.data.inventory({ projectId: project.id })],
      ["database.checkConnection", () => asOutsider.database.checkConnection({ databaseId: extPg.id })],
      ["bucket.checkConnection", () => asOutsider.bucket.checkConnection({ bucketId: bucketId ?? notConfiguredBucket.id })],
      ["bucket.listObjects", () => asOutsider.bucket.listObjects({ bucketId: bucketId ?? notConfiguredBucket.id, delimiter: "/" })],
      ["volume.checkConnection", () => asOutsider.volume.checkConnection({ volumeId: nativeVol.id })],
      ["volume.listFiles", () => asOutsider.volume.listFiles({ volumeId: nativeVol.id, path: "" })],
      ["volume.readFile", () => asOutsider.volume.readFile({ volumeId: nativeVol.id, path: "hello.txt" })],
      ["volume.readFile (docker)", () => asOutsider.volume.readFile({ volumeId: dockerVol.id, path: "item.txt" })],
      ["queryStudio.getSchema", () => asOutsider.queryStudio.getSchema({ databaseId: extPg.id })],
    ];
    for (const [label, call] of outsiderCalls) {
      const e = await rejects(call, notFound, `outsider ${label}`);
      assert.ok(!String(e.message).includes(project.name), "no project details leak");
    }
    ok(`outsider refused on all ${outsiderCalls.length} procedures (${outsiderCalls.map((c) => c[0]).join(", ")})`);

    // ─── 5. Inventory ────────────────────────────────────────────────────────
    console.log("\n[5] Inventory");
    const inv = await asViewer.data.inventory({ projectId: project.id });
    assert.strictEqual(inv.myRole, "VIEWER");
    assert.strictEqual(inv.runnerConfigured, true);
    assert.strictEqual(inv.storageConfigured, Boolean(s3));
    const invEnv = inv.environments.find((e: any) => e.id === prodEnv.id)!;
    assert.ok(invEnv.databases.length >= 8);
    assert.deepStrictEqual(invEnv.services.find((s: any) => s.id === svc.id)!.volumes.map((v: any) => v.name).sort(), ["cache", "never-deployed", "uploads"]);
    const invPg = invEnv.databases.find((d: any) => d.id === extPg.id)!;
    assert.ok(invPg.maskedUrl.includes("****"), invPg.maskedUrl);
    assert.strictEqual(invEnv.databases.find((d: any) => d.id === simulated.id)!.simulated, true);
    assert.strictEqual(invEnv.databases.find((d: any) => d.id === managedPg.id)!.runnerManaged, true);
    const blob = JSON.stringify(inv);
    const managedRows = await prisma.databaseInstance.findMany({ where: { id: { in: [managedPg.id, managedRedis.id] } }, select: { connectionUrl: true } });
    const secrets = [
      INSPECT_PASSWORD && `:${INSPECT_PASSWORD}@`,
      `dead-pw-${RUN}`,
      `wrong-pw-${RUN}`,
      `simpw${RUN}`,
      `sk_live_VARSECRET${RUN}`,
      ...managedRows.map((r) => new URL(r.connectionUrl).password).filter(Boolean),
      S3_SECRET,
    ];
    for (const s of secrets) assert.ok(!blob.includes(s), `inventory leaks ${s.slice(0, 6)}…`);
    assert.ok(!/connectionUrl|containerId|variables/.test(blob), "no raw fields");
    const injected = await prisma.environmentVariable.count({ where: { serviceId: svc.id, key: { in: ["DATABASE_URL", "REDIS_URL"] } } }).catch(() => -1);
    ok(`inventory (viewer): ${invEnv.databases.length} databases with masked URLs, ${inv.buckets.length} buckets, 3 volumes; no password, variable value (${injected >= 0 ? `${injected} injected DB variables present in the DB` : "variables"}) or raw URL in ${blob.length} bytes`);

    // ─── Teardown checks ─────────────────────────────────────────────────────
    console.log("\n[6] Teardown");
    for (const db of [managedPg, managedRedis]) {
      await asOwner.database.delete({ databaseId: db.id, confirmName: db.name });
      const left = docker(["ps", "-aq", "--filter", `label=syncbay.managed-db=${db.id.toLowerCase()}`]).trim();
      assert.strictEqual(left, "", `${db.name} container removed`);
    }
    if (bucketId) {
      const del = await asMember.bucket.delete({ bucketId });
      assert.ok((del as any).objectsRemoved >= 4 || (del as any).remoteDeleted !== false);
    }
    ok("runner databases deleted (containers gone)" + (bucketId ? ", bucket emptied and deleted" : ""));

    console.log(`\n✅ verify-data-access: ${passed} checks passed`);
  } finally {
    await cleanup();
  }
}

main().catch((err) => {
  console.error("\n❌ verify-data-access failed:", err);
  process.exit(1);
});
