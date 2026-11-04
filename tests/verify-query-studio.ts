/**
 * Verification Test: Query Studio against REAL Postgres 16 and REAL Redis 7
 *
 * TEST_DATABASE_URL (default postgresql://syncbay:syncbay@localhost:5432/sb_e) is the
 * control-plane DB; a scratch database `<db>_qs` is created on the same server
 * as the "customer" database. TEST_REDIS_URL defaults to redis://localhost:6379/5.
 * 1. Postgres: SELECT, real information_schema introspection (PKs), 1000-row cap,
 *    statement timeout, read-only enforcement (INSERT fails, `COMMIT; INSERT` and
 *    multi-statement escapes fail, nothing persisted), write mode persists.
 * 2. Redis: GET/HGETALL/KEYS(SCAN), SCAN+TYPE introspection, read-only refuses SET,
 *    write mode SET works, forbidden commands refused.
 * 3. Router: write mode is refused for MEMBER and allowed for OWNER (real rows).
 */

import assert from "node:assert";
import { Client } from "pg";
import Redis from "ioredis";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "postgresql://syncbay:syncbay@localhost:5432/sb_e";
process.env.DIRECT_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.TEST_REDIS_URL || "redis://localhost:6379/5";

async function ensureScratchDb(): Promise<string> {
  const base = new URL(process.env.DATABASE_URL!);
  const name = `${base.pathname.slice(1)}_qs`;
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (!exists.rowCount) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  base.pathname = `/${name}`;
  const url = base.toString();
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query(`DROP TABLE IF EXISTS orders; DROP TABLE IF EXISTS customers;
    CREATE TABLE customers (id serial PRIMARY KEY, email text NOT NULL UNIQUE, name text, created_at timestamptz DEFAULT now());
    CREATE TABLE orders (id bigserial PRIMARY KEY, customer_id int REFERENCES customers(id), total numeric(10,2) NOT NULL);
    INSERT INTO customers (email, name) VALUES ('a@example.test', 'Ada'), ('b@example.test', 'Bob');
    INSERT INTO orders (customer_id, total) VALUES (1, 19.99), (2, 5.00); ANALYZE customers;`);
  await c.end();
  return url;
}

async function main() {
  const { executeQuery, getDatabaseSchema } = await import("../src/lib/query-studio/engine");
  const pgUrl = await ensureScratchDb();
  const pg = { provider: "POSTGRES" as const, connectionUrl: pgUrl };
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
  const countCustomers = async () => {
    const c = new Client({ connectionString: pgUrl });
    await c.connect();
    const r = await c.query("SELECT count(*)::int AS n FROM customers");
    await c.end();
    return r.rows[0].n as number;
  };

  console.log("\n[1] Postgres (real server)");
  await step("SELECT returns real rows and column types", async () => {
    const res = await executeQuery(pg, "SELECT id, email, name FROM customers ORDER BY id");
    assert.strictEqual(res.mode, "read");
    assert.strictEqual(res.rowCount, 2);
    assert.strictEqual(res.rows[0].email, "a@example.test");
    assert.deepStrictEqual(res.columns.map((c) => c.name), ["id", "email", "name"]);
    assert.strictEqual(res.columns[0].type, "integer");
  });

  await step("information_schema introspection with primary keys", async () => {
    const tables = await getDatabaseSchema(pg);
    const customers = tables.find((t) => t.tableName === "customers");
    assert.ok(customers, "customers table found");
    assert.ok(customers!.columns.find((c) => c.name === "id")!.isPrimaryKey);
    assert.strictEqual(customers!.columns.find((c) => c.name === "email")!.nullable, false);
    assert.strictEqual(customers!.rowCountEstimate, 2);
    assert.ok(tables.some((t) => t.tableName === "orders"));
  });

  await step("1000-row cap truncates large results", async () => {
    const res = await executeQuery(pg, "SELECT g FROM generate_series(1, 5000) AS g;");
    assert.strictEqual(res.rows.length, 1000);
    assert.strictEqual(res.truncated, true);
  });

  await step("statement timeout cancels long queries", async () => {
    await assert.rejects(() => executeQuery(pg, "SELECT pg_sleep(3)", { timeoutMs: 300 }), /statement timeout|canceling statement/);
  });

  await step("read-only: INSERT fails and nothing is persisted", async () => {
    const before = await countCustomers();
    await assert.rejects(
      () => executeQuery(pg, "INSERT INTO customers (email) VALUES ('evil@example.test')"),
      /read-only transaction/
    );
    await assert.rejects(() => executeQuery(pg, "COMMIT; INSERT INTO customers (email) VALUES ('evil2@example.test')"), /multiple commands/);
    await assert.rejects(() => executeQuery(pg, "UPDATE customers SET name = 'x' WHERE id = 1"), /read-only transaction/);
    assert.strictEqual(await countCustomers(), before);
  });

  await step("write mode commits; Safe Mode still blocks DELETE without WHERE", async () => {
    const res = await executeQuery(pg, "INSERT INTO customers (email, name) VALUES ('c@example.test', 'Cy')", { mode: "write" });
    assert.strictEqual(res.commandType, "INSERT");
    assert.strictEqual(res.rowCount, 1);
    assert.strictEqual(await countCustomers(), 3);
    await assert.rejects(() => executeQuery(pg, "DELETE FROM orders", { mode: "write" }), /Safe Mode Block/);
  });

  console.log("\n[2] Redis 7 (real server, DB 5)");
  const prefix = `qs:${Math.random().toString(36).slice(2, 7)}`;
  const redis = new Redis(REDIS_URL);
  await redis.set(`${prefix}:greeting`, "hello");
  await redis.hset(`${prefix}:user:1`, { name: "Ada", plan: "pro" });
  await redis.rpush(`${prefix}:queue`, "a", "b", "c");
  await redis.expire(`${prefix}:greeting`, 600);
  const rd = { provider: "REDIS" as const, connectionUrl: REDIS_URL };

  await step("GET / HGETALL / KEYS (served by SCAN)", async () => {
    assert.strictEqual((await executeQuery(rd, `GET ${prefix}:greeting`)).rows[0].value, "hello");
    const h = await executeQuery(rd, `HGETALL ${prefix}:user:1`);
    assert.deepStrictEqual(Object.fromEntries(h.rows.map((r) => [r.field, r.value])), { name: "Ada", plan: "pro" });
    const keys = await executeQuery(rd, `KEYS ${prefix}:*`);
    assert.strictEqual(keys.rowCount, 3);
    assert.strictEqual((await executeQuery(rd, "PING")).rows[0].response, "PONG");
  });

  await step("SCAN + TYPE introspection", async () => {
    const tables = await getDatabaseSchema(rd);
    const byKey = new Map(tables.map((t) => [t.tableName, t]));
    assert.strictEqual(byKey.get(`${prefix}:user:1`)?.columns[0].type, "hash");
    assert.strictEqual(byKey.get(`${prefix}:queue`)?.columns[0].type, "list");
    assert.strictEqual(byKey.get(`${prefix}:queue`)?.rowCountEstimate, 3);
    assert.match(byKey.get(`${prefix}:greeting`)!.columns[1].type, /^\d+s$/);
  });

  await step("read-only refuses SET; write mode allows it; forbidden commands refused", async () => {
    await assert.rejects(() => executeQuery(rd, `SET ${prefix}:x 1`), /Read-only mode/);
    assert.strictEqual(await redis.exists(`${prefix}:x`), 0);
    const res = await executeQuery(rd, `SET ${prefix}:x "a b"`, { mode: "write" });
    assert.strictEqual(res.rows[0].status, "OK");
    assert.strictEqual(await redis.get(`${prefix}:x`), "a b");
    await assert.rejects(() => executeQuery(rd, "FLUSHDB", { mode: "write" }), /Safe Mode Block/);
    await assert.rejects(() => executeQuery(rd, "MONITOR", { mode: "write" }), /not available/);
  });

  console.log("\n[3] Router role enforcement (real control-plane rows)");
  const { db } = await import("../src/lib/db");
  const { queryStudioRouter } = await import("../src/server/routers/query-studio");
  const suffix = Math.random().toString(36).slice(2, 8);
  const owner = await db.user.create({ data: { email: `qs-owner-${suffix}@example.test` } });
  const member = await db.user.create({ data: { email: `qs-member-${suffix}@example.test` } });
  const ws = await db.workspace.create({ data: { name: "QS", slug: `qs-${suffix}` } });
  await db.workspaceMember.createMany({
    data: [
      { workspaceId: ws.id, userId: owner.id, role: "OWNER" },
      { workspaceId: ws.id, userId: member.id, role: "MEMBER" },
    ],
  });
  const project = await db.project.create({ data: { workspaceId: ws.id, name: "qs" } });
  const env = await db.environment.create({ data: { projectId: project.id, name: "production" } });
  const instance = await db.databaseInstance.create({
    data: { environmentId: env.id, provider: "POSTGRES", name: "main", connectionUrl: pgUrl, region: "local", status: "ACTIVE" },
  });
  const caller = (userId: string) =>
    (queryStudioRouter as any).createCaller({ db, headers: new Headers(), session: { user: { id: userId }, expires: "2099-01-01" } });

  try {
    await step("MEMBER: read allowed, write refused (FORBIDDEN)", async () => {
      const res = await caller(member.id).execute({ databaseId: instance.id, query: "SELECT count(*) AS n FROM customers" });
      assert.strictEqual(Number(res.rows[0].n), 3);
      await assert.rejects(
        () => caller(member.id).execute({ databaseId: instance.id, query: "INSERT INTO customers (email) VALUES ('m@example.test')", mode: "write" }),
        /OWNER or ADMIN/
      );
      const schema = await caller(member.id).getSchema({ databaseId: instance.id });
      assert.strictEqual(schema.canWrite, false);
    });
    await step("OWNER: write mode allowed", async () => {
      const res = await caller(owner.id).execute({ databaseId: instance.id, query: "INSERT INTO customers (email) VALUES ('o@example.test')", mode: "write" });
      assert.strictEqual(res.rowCount, 1);
      assert.strictEqual((await caller(owner.id).getSchema({ databaseId: instance.id })).canWrite, true);
    });
  } finally {
    await db.databaseInstance.delete({ where: { id: instance.id } }).catch(() => null);
    await db.environment.delete({ where: { id: env.id } }).catch(() => null);
    await db.project.delete({ where: { id: project.id } }).catch(() => null);
    await db.workspaceMember.deleteMany({ where: { workspaceId: ws.id } }).catch(() => null);
    await db.workspace.delete({ where: { id: ws.id } }).catch(() => null);
    await db.user.deleteMany({ where: { id: { in: [owner.id, member.id] } } }).catch(() => null);
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
    await db.$disconnect();
  }

  if (failures) {
    console.error(`\n💥 verify-query-studio: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\n✨ verify-query-studio: all checks passed (real Postgres 16 + real Redis 7)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
