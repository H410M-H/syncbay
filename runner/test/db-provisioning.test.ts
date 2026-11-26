/**
 * Runner managed-database provisioning against REAL servers.
 *
 *   native  RunnerServices forced to mode "native": real initdb/pg_ctl and redis-server
 *           processes, checked with psql / redis-cli, then deleted (data dir removed).
 *   docker  mode "docker": a real postgres:16-alpine container (skipped when
 *           `docker info` fails), checked with psql through the mapped port; a
 *           pgvector/pgvector:pg16 container (extensions ["vector"], pg_extension checked)
 *           and a valkey/valkey:8-alpine container (engine "valkey").
 *   volumes dockerVolumeFlags / prepareNativeVolumes on a temp state dir.
 *
 * Run: cd runner && npm run test:provision   (ports 45500-45999)
 */

import assert from "node:assert";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { PortManager } from "../src/port-manager.ts";
import { RunnerServices } from "../src/services.ts";
import { NativeDatabaseManager } from "../src/native-db.ts";
import { dockerVolumeFlags, prepareNativeVolumes } from "../src/volumes.ts";

// Binary names via env so hosts with non-PATH installs can point at them.
const PSQL = process.env.PSQL_BIN || "psql";
const PG_ISREADY = process.env.PG_ISREADY_BIN || "pg_isready";
const REDIS_CLI = process.env.REDIS_CLI_BIN || "redis-cli";
const PG_CONFIG = process.env.PG_CONFIG_BIN || "pg_config";

const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sb-runner-state-"));
fs.chmodSync(stateRoot, 0o755); // the unprivileged DB user must traverse it when the runner is root

async function serve(services: RunnerServices) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const pathname = new URL(req.url || "/", "http://x").pathname;
      const handled = await services.handle(req, res, pathname, body, () => true);
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(base + p, { method, body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json" } });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { server, call };
}

function psql(url: string, sql: string): string {
  return execFileSync(PSQL, [url, "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8", timeout: 30000 }).trim();
}

const nativeMgr = new NativeDatabaseManager(path.join(stateRoot, "databases"));
const providers = nativeMgr.availableProviders();

test("native Postgres: initdb/pg_ctl provisioning, health, real query, delete", { skip: !providers.includes("POSTGRES") && "initdb not installed" }, async () => {
  const services = new RunnerServices({ mode: "native", native: nativeMgr, portManager: new PortManager({ rangeStart: 45500, rangeEnd: 45699 }) });
  const { server, call } = await serve(services);
  try {
    const created = await call("POST", "/api/databases", { id: "pgnative1", provider: "POSTGRES" });
    assert.strictEqual(created.status, 201, JSON.stringify(created.json));
    assert.strictEqual(created.json.mode, "native");
    assert.ok(created.json.port >= 45500 && created.json.port <= 45699);
    const url = created.json.connectionUrl as string;
    assert.match(url, /^postgresql:\/\/postgres:[^@]+@127\.0\.0\.1:\d+\/main$/);

    psql(url, "CREATE TABLE t (id int)");
    psql(url, "INSERT INTO t VALUES (42)");
    assert.strictEqual(psql(url, "SELECT id FROM t"), "42");
    assert.match(psql(url, "SHOW server_version"), /^\d+/);
    // Password auth is enforced over TCP
    const bad = spawnSync(PSQL, [url.replace(/:[^:@/]+@/, ":wrong@"), "-c", "SELECT 1"], { encoding: "utf8" });
    assert.notStrictEqual(bad.status, 0, "wrong password must be rejected");

    const health = await call("GET", "/api/databases/pgnative1/health");
    assert.strictEqual(health.json.healthy, true, JSON.stringify(health.json));
    assert.strictEqual(health.json.mode, "native");

    // A fresh RunnerServices (runner restart) still finds the instance via meta.json
    const restarted = await serve(new RunnerServices({ mode: "native", native: nativeMgr, portManager: new PortManager({ rangeStart: 45700, rangeEnd: 45799 }) }));
    try {
      assert.strictEqual((await restarted.call("GET", "/api/databases/pgnative1/health")).json.healthy, true);
    } finally {
      restarted.server.close();
    }

    const deleted = await call("DELETE", "/api/databases/pgnative1");
    assert.strictEqual(deleted.json.deleted, true);
    assert.strictEqual(fs.existsSync(nativeMgr.dirFor("pgnative1")), false, "data dir removed");
    const probe = spawnSync(PG_ISREADY, ["-h", "127.0.0.1", "-p", String(created.json.port)], { encoding: "utf8" });
    assert.notStrictEqual(probe.status, 0, "server stopped");
  } finally {
    await nativeMgr.destroy("pgnative1").catch(() => null);
    server.close();
  }
});

test("native Redis: redis-server provisioning with requirepass, health, delete", { skip: !providers.includes("REDIS") && "redis-server not installed" }, async () => {
  const services = new RunnerServices({ mode: "native", native: nativeMgr, portManager: new PortManager({ rangeStart: 45800, rangeEnd: 45899 }) });
  const { server, call } = await serve(services);
  try {
    const created = await call("POST", "/api/databases", { id: "rdnative1", provider: "REDIS" });
    assert.strictEqual(created.status, 201, JSON.stringify(created.json));
    assert.strictEqual(created.json.mode, "native");
    const url = new URL(created.json.connectionUrl);
    const password = decodeURIComponent(url.password);
    const cli = (args: string[], auth?: string) =>
      spawnSync(REDIS_CLI, ["-h", "127.0.0.1", "-p", url.port, ...args], { encoding: "utf8", env: { ...process.env, ...(auth ? { REDISCLI_AUTH: auth } : {}) } });
    assert.match(cli(["ping"]).stdout, /NOAUTH/, "requirepass enforced");
    assert.strictEqual(cli(["set", "k", "v"], password).stdout.trim(), "OK");
    assert.strictEqual(cli(["get", "k"], password).stdout.trim(), "v");

    const health = await call("GET", "/api/databases/rdnative1/health");
    assert.strictEqual(health.json.healthy, true, JSON.stringify(health.json));

    const deleted = await call("DELETE", "/api/databases/rdnative1");
    assert.strictEqual(deleted.json.deleted, true);
    assert.strictEqual(fs.existsSync(nativeMgr.dirFor("rdnative1")), false);
    await new Promise((r) => setTimeout(r, 300));
    assert.notStrictEqual(cli(["ping"], password).stdout.trim(), "PONG", "server stopped");
  } finally {
    await nativeMgr.destroy("rdnative1").catch(() => null);
    server.close();
  }
});

test("native mode refuses MySQL (needs Docker)", async () => {
  const services = new RunnerServices({ mode: "native", native: nativeMgr, portManager: new PortManager({ rangeStart: 45900, rangeEnd: 45909 }) });
  const { server, call } = await serve(services);
  try {
    const res = await call("POST", "/api/databases", { id: "mysqlnope", provider: "MYSQL" });
    assert.strictEqual(res.status, 501);
  } finally {
    server.close();
  }
});

const dockerOk = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" }).status === 0;

test("docker Postgres: postgres:16-alpine container, health, real query, delete", { skip: !dockerOk && "docker unavailable" }, async () => {
  const services = new RunnerServices({ mode: "docker", portManager: new PortManager({ rangeStart: 45910, rangeEnd: 45999 }) });
  const { server, call } = await serve(services);
  try {
    const created = await call("POST", "/api/databases", { id: "pgdocker1", provider: "POSTGRES" });
    assert.strictEqual(created.status, 201, JSON.stringify(created.json));
    assert.strictEqual(created.json.mode, "docker");
    let healthy = false;
    for (let i = 0; i < 60 && !healthy; i++) {
      healthy = (await call("GET", "/api/databases/pgdocker1/health")).json.healthy === true;
      if (!healthy) await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(healthy, "pg_isready inside the container");
    let out = "";
    for (let i = 0; i < 20 && out !== "7"; i++) {
      try {
        out = psql(created.json.connectionUrl, "SELECT 3 + 4");
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    assert.strictEqual(out, "7");
    const deleted = await call("DELETE", "/api/databases/pgdocker1");
    assert.strictEqual(deleted.json.deleted, true);
    const ps = spawnSync("docker", ["ps", "-a", "--filter", "name=syncbay-db-pgdocker1", "-q"], { encoding: "utf8" });
    assert.strictEqual(ps.stdout.trim(), "", "container removed");
    const vol = spawnSync("docker", ["volume", "ls", "-q", "--filter", "name=syncbay-db-pgdocker1-data"], { encoding: "utf8" });
    assert.strictEqual(vol.stdout.trim(), "", "volume removed");
  } finally {
    spawnSync("docker", ["rm", "-f", "syncbay-db-pgdocker1"]);
    spawnSync("docker", ["volume", "rm", "-f", "syncbay-db-pgdocker1-data"]);
    server.close();
  }
});

test("docker Postgres + pgvector: extensions [vector] uses pgvector/pgvector:pg16 and creates the extension", { skip: !dockerOk && "docker unavailable" }, async () => {
  const services = new RunnerServices({ mode: "docker", portManager: new PortManager({ rangeStart: 45910, rangeEnd: 45999 }) });
  const { server, call } = await serve(services);
  try {
    const created = await call("POST", "/api/databases", { id: "pgvec1", provider: "POSTGRES", extensions: ["vector"] });
    assert.strictEqual(created.status, 201, JSON.stringify(created.json));
    assert.deepStrictEqual(created.json.extensions, ["vector"]);
    const image = spawnSync("docker", ["inspect", "-f", "{{.Config.Image}}", "syncbay-db-pgvec1"], { encoding: "utf8" }).stdout.trim();
    assert.strictEqual(image, "pgvector/pgvector:pg16");
    // The runner answered only after CREATE EXTENSION succeeded, so it is there right away.
    assert.strictEqual(psql(created.json.connectionUrl, "SELECT extname FROM pg_extension WHERE extname = 'vector'"), "vector");
    assert.strictEqual(psql(created.json.connectionUrl, "SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector"), "1");
    assert.strictEqual((await call("GET", "/api/databases/pgvec1/health")).json.healthy, true);
    const bad = await call("POST", "/api/databases", { id: "pgvec2", provider: "POSTGRES", extensions: ["postgis"] });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.json.error, /Unsupported extension: postgis/);
    assert.strictEqual((await call("DELETE", "/api/databases/pgvec1")).json.deleted, true);
  } finally {
    spawnSync("docker", ["rm", "-f", "syncbay-db-pgvec1"]);
    spawnSync("docker", ["volume", "rm", "-f", "syncbay-db-pgvec1-data"]);
    server.close();
  }
});

test("docker Valkey: engine valkey runs valkey/valkey:8-alpine with requirepass, health, delete", { skip: !dockerOk && "docker unavailable" }, async () => {
  const services = new RunnerServices({ mode: "docker", portManager: new PortManager({ rangeStart: 45910, rangeEnd: 45999 }) });
  const { server, call } = await serve(services);
  try {
    const created = await call("POST", "/api/databases", { id: "valkey1", provider: "REDIS", engine: "valkey" });
    assert.strictEqual(created.status, 201, JSON.stringify(created.json));
    assert.match(created.json.connectionUrl, /^redis:\/\/default:/);
    const image = spawnSync("docker", ["inspect", "-f", "{{.Config.Image}}", "syncbay-db-valkey1"], { encoding: "utf8" }).stdout.trim();
    assert.strictEqual(image, "valkey/valkey:8-alpine");
    let healthy = false;
    for (let i = 0; i < 30 && !healthy; i++) {
      healthy = (await call("GET", "/api/databases/valkey1/health")).json.healthy === true;
      if (!healthy) await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(healthy, "PING through redis-cli (valkey-cli) inside the container");
    const info = spawnSync("docker", ["exec", "syncbay-db-valkey1", "sh", "-c", 'valkey-cli -a "$REDIS_PASSWORD" --no-auth-warning INFO server'], { encoding: "utf8" });
    assert.match(info.stdout, /valkey_version:8\./);
    assert.strictEqual((await call("DELETE", "/api/databases/valkey1")).json.deleted, true);
  } finally {
    spawnSync("docker", ["rm", "-f", "syncbay-db-valkey1"]);
    spawnSync("docker", ["volume", "rm", "-f", "syncbay-db-valkey1-data"]);
    server.close();
  }
});

test("native Postgres: extensions [vector] without pgvector on the host fails clearly and cleans up", { skip: !providers.includes("POSTGRES") && "initdb not installed" }, async () => {
  const hasVector = (() => {
    try {
      const share = execFileSync(PG_CONFIG, ["--sharedir"], { encoding: "utf8" }).trim();
      return fs.existsSync(path.join(share, "extension", "vector.control"));
    } catch {
      return false;
    }
  })();
  const services = new RunnerServices({ mode: "native", native: nativeMgr, portManager: new PortManager({ rangeStart: 45600, rangeEnd: 45699 }), dbHost: "127.0.0.1" });
  const { server, call } = await serve(services);
  try {
    const created = await call("POST", "/api/databases", { id: "pgvecnative1", provider: "POSTGRES", extensions: ["vector"] });
    if (hasVector) {
      assert.strictEqual(created.status, 201, JSON.stringify(created.json));
      assert.strictEqual(psql(created.json.connectionUrl, "SELECT extname FROM pg_extension WHERE extname = 'vector'"), "vector");
      await call("DELETE", "/api/databases/pgvecnative1");
    } else {
      assert.strictEqual(created.status, 500);
      assert.match(created.json.error, /CREATE EXTENSION vector failed/);
      assert.match(created.json.error, /pgvector is not installed on this runner host/);
      assert.strictEqual(fs.existsSync(nativeMgr.dirFor("pgvecnative1")), false, "data dir removed");
    }
  } finally {
    await nativeMgr.destroy("pgvecnative1").catch(() => null);
    server.close();
  }
});

test("volumes: docker -v flags and native bind dirs", () => {
  const vols = [
    { id: "vol1", name: "uploads", mountPath: "/data" },
    { id: "vol2", name: "cache", mountPath: "tmp/cache" },
    { id: "bad id", name: "x", mountPath: "/x" },
    { id: "vol3", name: "evil", mountPath: "/a;rm -rf /" },
  ];
  assert.strictEqual(dockerVolumeFlags(vols), "-v syncbay-vol-vol1:/data -v syncbay-vol-vol2:/app/tmp/cache");
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-app-"));
  const { env, mounts } = prepareNativeVolumes(vols, appDir, path.join(stateRoot, "volumes"));
  assert.strictEqual(mounts.length, 2);
  assert.strictEqual(env.SYNCBAY_VOLUME_PATH, path.join(stateRoot, "volumes", "vol1"));
  assert.strictEqual(env.VOLUME_CACHE_PATH, path.join(stateRoot, "volumes", "vol2"));
  fs.writeFileSync(path.join(appDir, "tmp/cache/file.txt"), "persisted");
  assert.strictEqual(fs.readFileSync(path.join(stateRoot, "volumes", "vol2", "file.txt"), "utf8"), "persisted", "relative mount symlinked to the volume");
  fs.rmSync(appDir, { recursive: true, force: true });
});

test.after(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true });
});
