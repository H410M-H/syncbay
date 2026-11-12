/**
 * Syncbay PaaS — Database Query Studio engine
 *
 * Runs queries against a managed database's real `connectionUrl` with `pg`,
 * `mysql2` or `ioredis`, and introspects its schema (`information_schema`
 * for SQL, `SCAN` + `TYPE` for Redis).
 *
 * Read mode (the default) runs SQL inside a `READ ONLY` transaction that is
 * always rolled back, as one statement (Postgres extended protocol / MySQL
 * without multi-statements), with a 10 s statement timeout and a 1000-row cap.
 * Redis read mode accepts only read commands. Write mode is for OWNER/ADMIN
 * (enforced by the router); Safe Mode additionally refuses destructive SQL
 * (DROP, TRUNCATE, DELETE without WHERE, ALTER … DROP) and FLUSHALL/FLUSHDB.
 */

import { Client as PgClient, type QueryConfig } from "pg";
import Redis from "ioredis";
import mysql from "mysql2/promise";

export type QueryProvider = "POSTGRES" | "REDIS" | "MYSQL";
export type QueryMode = "read" | "write";

export interface QueryColumn {
  name: string;
  type: string;
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: Record<string, any>[];
  rowCount: number;
  durationMs: number;
  commandType: string;
  isDestructive: boolean;
  mode: QueryMode;
  truncated: boolean;
  warning?: string;
}

export interface TableColumnSchema {
  name: string;
  type: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  defaultValue?: string;
}

export interface TableSchema {
  tableName: string;
  columns: TableColumnSchema[];
  rowCountEstimate: number;
}

export interface QueryTarget {
  provider: QueryProvider;
  connectionUrl: string;
}

export interface QueryOptions {
  mode?: QueryMode;
  safeMode?: boolean;
  timeoutMs?: number;
  rowLimit?: number;
}

export const QUERY_TIMEOUT_MS = 10_000;
export const QUERY_ROW_LIMIT = 1000;
const CONNECT_TIMEOUT_MS = 5_000;
const REDIS_SCAN_KEY_LIMIT = 200;

// ─── SQL helpers ──────────────────────────────────────────────────────────────

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--.*$/gm, " ");
}

/**
 * Detects destructive SQL operations across all statements in a query string
 */
export function detectDestructiveSql(rawSql: string): { isDestructive: boolean; reason?: string } {
  const statements = stripSqlComments(rawSql)
    .split(";")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    const upper = stmt.toUpperCase();
    if (/\bDROP\s+(TABLE|DATABASE|SCHEMA|VIEW)\b/.test(upper)) {
      return { isDestructive: true, reason: `DROP command detected: "${stmt.slice(0, 40)}"` };
    }
    if (/\bTRUNCATE(\s+TABLE)?\b/.test(upper)) {
      return { isDestructive: true, reason: `TRUNCATE command detected: "${stmt.slice(0, 40)}"` };
    }
    if (/\bDELETE\s+FROM\b/.test(upper) && !/\bWHERE\b/.test(upper)) {
      return { isDestructive: true, reason: `DELETE without WHERE clause detected: "${stmt.slice(0, 40)}"` };
    }
    if (/\bALTER\s+TABLE\b/.test(upper) && /\bDROP\b/.test(upper)) {
      return { isDestructive: true, reason: `ALTER TABLE ... DROP detected: "${stmt.slice(0, 40)}"` };
    }
  }
  return { isDestructive: false };
}

/** First keyword of the (comment-stripped) query, upper-cased. */
function commandTypeOf(sql: string): string {
  const match = stripSqlComments(sql).trim().match(/^[A-Za-z]+/);
  return match ? match[0].toUpperCase() : "UNKNOWN";
}

/** Single SELECT-like statement with the trailing semicolon removed, or null. */
function cappableSelect(sql: string): string | null {
  const body = sql.trim().replace(/;\s*$/, "");
  if (body.includes(";")) return null;
  const head = commandTypeOf(body);
  return head === "SELECT" || head === "WITH" || head === "VALUES" || head === "TABLE" ? body : null;
}

/** Rejects simulated `sb-db-*` instances, which have no server behind them. */
function assertReachable(target: QueryTarget): void {
  if (!target.connectionUrl) throw new Error("Database has no connection URL");
  if (/\.syncbay-db\.internal\b/.test(target.connectionUrl)) {
    throw new Error("This database is a simulated instance with no server behind it. Provision it on a runner to query it.");
  }
}

function guardSafeMode(sql: string, safeMode: boolean): { isDestructive: boolean } {
  const destructive = detectDestructiveSql(sql);
  if (destructive.isDestructive && safeMode) {
    throw new Error(`Safe Mode Block: ${destructive.reason}. Disable Safe Mode to execute destructive queries.`);
  }
  return { isDestructive: destructive.isDestructive };
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  return value;
}

function normalizeRows(rows: Record<string, unknown>[]): Record<string, any>[] {
  return rows.map((row) => {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(row)) out[k] = jsonSafe(v);
    return out;
  });
}

// ─── Postgres ─────────────────────────────────────────────────────────────────

async function withPg<T>(connectionUrl: string, fn: (client: PgClient) => Promise<T>): Promise<T> {
  const client = new PgClient({
    connectionString: connectionUrl,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    application_name: "syncbay-query-studio",
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => null);
  }
}

async function runPostgres(target: QueryTarget, sql: string, opts: Required<QueryOptions>): Promise<Omit<QueryResult, "durationMs">> {
  const { isDestructive } = guardSafeMode(sql, opts.safeMode);
  const capped = cappableSelect(sql);
  const text = capped ? `SELECT * FROM (${capped}) AS sb_query_studio LIMIT ${opts.rowLimit + 1}` : sql.trim();

  return withPg(target.connectionUrl, async (client) => {
    await client.query(opts.mode === "read" ? "BEGIN TRANSACTION READ ONLY" : "BEGIN");
    try {
      await client.query(`SET LOCAL statement_timeout = ${Math.floor(opts.timeoutMs)}`);
      // Extended protocol: exactly one statement, so `COMMIT; …` cannot escape the transaction.
      const res = await client.query({ text, queryMode: "extended" } as QueryConfig & { queryMode: "extended" });
      await client.query(opts.mode === "read" ? "ROLLBACK" : "COMMIT");
      const rows = normalizeRows((res.rows || []) as Record<string, unknown>[]);
      const truncated = rows.length > opts.rowLimit;
      return {
        columns: (res.fields || []).map((f) => ({ name: f.name, type: pgTypeName(f.dataTypeID) })),
        rows: truncated ? rows.slice(0, opts.rowLimit) : rows,
        rowCount: res.rows?.length ? Math.min(res.rows.length, opts.rowLimit) : res.rowCount ?? 0,
        commandType: res.command || commandTypeOf(sql),
        isDestructive,
        mode: opts.mode,
        truncated,
        warning: truncated ? `Result truncated to ${opts.rowLimit} rows` : undefined,
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => null);
      throw err;
    }
  });
}

const PG_TYPES: Record<number, string> = {
  16: "boolean", 17: "bytea", 20: "bigint", 21: "smallint", 23: "integer", 25: "text", 114: "json",
  700: "real", 701: "double precision", 1042: "char", 1043: "varchar", 1082: "date", 1114: "timestamp",
  1184: "timestamptz", 1700: "numeric", 2950: "uuid", 3802: "jsonb",
};

function pgTypeName(oid: number): string {
  return PG_TYPES[oid] || `oid:${oid}`;
}

async function introspectPostgres(target: QueryTarget): Promise<TableSchema[]> {
  return withPg(target.connectionUrl, async (client) => {
    await client.query("SET statement_timeout = 10000");
    const cols = await client.query(
      `SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default
         FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema') AND c.table_schema NOT LIKE 'pg_toast%'
          AND t.table_type IN ('BASE TABLE', 'VIEW')
        ORDER BY c.table_schema, c.table_name, c.ordinal_position`
    );
    const pks = await client.query(
      `SELECT kcu.table_schema, kcu.table_name, kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'`
    );
    const counts = await client.query(
      `SELECT n.nspname AS table_schema, c.relname AS table_name, GREATEST(c.reltuples, 0)::bigint AS estimate
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')`
    );
    const pkSet = new Set(pks.rows.map((r) => `${r.table_schema}.${r.table_name}.${r.column_name}`));
    const countMap = new Map(counts.rows.map((r) => [`${r.table_schema}.${r.table_name}`, Number(r.estimate)]));
    const tables = new Map<string, TableSchema>();
    for (const r of cols.rows) {
      const key = `${r.table_schema}.${r.table_name}`;
      const tableName = r.table_schema === "public" ? r.table_name : key;
      let table = tables.get(key);
      if (!table) {
        table = { tableName, columns: [], rowCountEstimate: countMap.get(key) ?? 0 };
        tables.set(key, table);
      }
      table.columns.push({
        name: r.column_name,
        type: r.data_type,
        nullable: r.is_nullable === "YES",
        isPrimaryKey: pkSet.has(`${key}.${r.column_name}`),
        defaultValue: r.column_default ?? undefined,
      });
    }
    return Array.from(tables.values());
  });
}

// ─── MySQL ────────────────────────────────────────────────────────────────────

async function withMysql<T>(connectionUrl: string, fn: (conn: mysql.Connection) => Promise<T>): Promise<T> {
  const conn = await mysql.createConnection({ uri: connectionUrl, connectTimeout: CONNECT_TIMEOUT_MS, multipleStatements: false });
  try {
    return await fn(conn);
  } finally {
    await conn.end().catch(() => null);
  }
}

async function runMysql(target: QueryTarget, sql: string, opts: Required<QueryOptions>): Promise<Omit<QueryResult, "durationMs">> {
  const { isDestructive } = guardSafeMode(sql, opts.safeMode);
  const capped = cappableSelect(sql);
  const text = capped ? `SELECT * FROM (${capped}) AS sb_query_studio LIMIT ${opts.rowLimit + 1}` : sql.trim().replace(/;\s*$/, "");

  return withMysql(target.connectionUrl, async (conn) => {
    await conn.query(`SET SESSION MAX_EXECUTION_TIME = ${Math.floor(opts.timeoutMs)}`);
    await conn.query(opts.mode === "read" ? "START TRANSACTION READ ONLY" : "START TRANSACTION");
    try {
      const [result, fields] = await conn.query({ sql: text, timeout: opts.timeoutMs });
      await conn.query(opts.mode === "read" ? "ROLLBACK" : "COMMIT");
      if (Array.isArray(result)) {
        const rows = normalizeRows(result as Record<string, unknown>[]);
        const truncated = rows.length > opts.rowLimit;
        return {
          columns: (fields || []).map((f) => ({ name: f.name, type: String(f.type ?? "") })),
          rows: truncated ? rows.slice(0, opts.rowLimit) : rows,
          rowCount: Math.min(rows.length, opts.rowLimit),
          commandType: commandTypeOf(sql),
          isDestructive,
          mode: opts.mode,
          truncated,
          warning: truncated ? `Result truncated to ${opts.rowLimit} rows` : undefined,
        };
      }
      const header = result as mysql.ResultSetHeader;
      return {
        columns: [{ name: "affectedRows", type: "integer" }],
        rows: [{ affectedRows: header.affectedRows }],
        rowCount: header.affectedRows,
        commandType: commandTypeOf(sql),
        isDestructive,
        mode: opts.mode,
        truncated: false,
      };
    } catch (err) {
      await conn.query("ROLLBACK").catch(() => null);
      throw err;
    }
  });
}

async function introspectMysql(target: QueryTarget): Promise<TableSchema[]> {
  return withMysql(target.connectionUrl, async (conn) => {
    const [cols] = await conn.query(
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_KEY AS k, COLUMN_DEFAULT AS d
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`
    );
    const [counts] = await conn.query(
      `SELECT TABLE_NAME AS t, TABLE_ROWS AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`
    );
    const countMap = new Map((counts as any[]).map((r) => [r.t, Number(r.n) || 0]));
    const tables = new Map<string, TableSchema>();
    for (const r of cols as any[]) {
      let table = tables.get(r.t);
      if (!table) {
        table = { tableName: r.t, columns: [], rowCountEstimate: countMap.get(r.t) ?? 0 };
        tables.set(r.t, table);
      }
      table.columns.push({
        name: r.c,
        type: r.type,
        nullable: r.nullable === "YES",
        isPrimaryKey: r.k === "PRI",
        defaultValue: r.d ?? undefined,
      });
    }
    return Array.from(tables.values());
  });
}

// ─── Redis ────────────────────────────────────────────────────────────────────

const REDIS_READ_COMMANDS = new Set([
  "PING", "ECHO", "GET", "MGET", "GETRANGE", "STRLEN", "EXISTS", "TYPE", "TTL", "PTTL", "DBSIZE", "INFO",
  "SCAN", "KEYS", "RANDOMKEY", "HGET", "HMGET", "HGETALL", "HKEYS", "HVALS", "HLEN", "HEXISTS", "HSCAN",
  "LRANGE", "LLEN", "LINDEX", "SMEMBERS", "SCARD", "SISMEMBER", "SSCAN", "ZRANGE", "ZREVRANGE",
  "ZRANGEBYSCORE", "ZCARD", "ZSCORE", "ZRANK", "ZSCAN", "XRANGE", "XREVRANGE", "XLEN", "MEMORY", "OBJECT",
]);
/** Never allowed from the studio: they block the connection or administer the server. */
const REDIS_FORBIDDEN = new Set([
  "SHUTDOWN", "DEBUG", "MONITOR", "SUBSCRIBE", "PSUBSCRIBE", "SSUBSCRIBE", "SYNC", "PSYNC", "REPLICAOF",
  "SLAVEOF", "BLPOP", "BRPOP", "BLMOVE", "BZPOPMIN", "BZPOPMAX", "XREAD", "XREADGROUP", "WAIT", "SELECT",
  "MULTI", "EXEC", "QUIT", "RESET", "CLIENT", "ACL", "MODULE", "FAILOVER", "CLUSTER",
]);
const REDIS_SAFE_MODE_BLOCKED = new Set(["FLUSHALL", "FLUSHDB", "CONFIG", "SCRIPT", "FUNCTION", "SWAPDB"]);

/** Splits a Redis command line into arguments, honouring single/double quotes. */
export function parseRedisCommand(line: string): string[] {
  const args: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line.trim()))) {
    if (m[1] !== undefined) args.push(m[1].replace(/\\(.)/g, "$1"));
    else if (m[2] !== undefined) args.push(m[2].replace(/\\(.)/g, "$1"));
    else args.push(m[3]);
  }
  return args;
}

function connectRedis(connectionUrl: string, timeoutMs: number): Redis {
  return new Redis(connectionUrl, {
    lazyConnect: true,
    connectTimeout: CONNECT_TIMEOUT_MS,
    commandTimeout: timeoutMs,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
}

async function withRedis<T>(connectionUrl: string, timeoutMs: number, fn: (r: Redis) => Promise<T>): Promise<T> {
  const redis = connectRedis(connectionUrl, timeoutMs);
  redis.on("error", () => null);
  await redis.connect();
  try {
    return await fn(redis);
  } finally {
    redis.disconnect();
  }
}

async function scanKeys(redis: Redis, pattern: string, limit: number): Promise<{ keys: string[]; truncated: boolean }> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 200);
    cursor = next;
    for (const k of batch) {
      if (keys.length >= limit) return { keys, truncated: true };
      keys.push(k);
    }
  } while (cursor !== "0");
  return { keys, truncated: false };
}

function redisRows(reply: unknown, command: string): { columns: QueryColumn[]; rows: Record<string, any>[] } {
  const fmt = (v: unknown) => (Buffer.isBuffer(v) ? v.toString("utf8") : v);
  if (command === "HGETALL" && Array.isArray(reply)) {
    const rows: Record<string, any>[] = [];
    for (let i = 0; i + 1 < reply.length; i += 2) rows.push({ field: fmt(reply[i]), value: fmt(reply[i + 1]) });
    return { columns: [{ name: "field", type: "string" }, { name: "value", type: "string" }], rows };
  }
  if (Array.isArray(reply)) {
    return {
      columns: [{ name: "index", type: "integer" }, { name: "value", type: "string" }],
      rows: reply.map((v, index) => ({ index, value: Array.isArray(v) ? JSON.stringify(v.map(fmt)) : fmt(v) })),
    };
  }
  if (command === "PING") return { columns: [{ name: "response", type: "string" }], rows: [{ response: fmt(reply) }] };
  if (reply === "OK") return { columns: [{ name: "status", type: "string" }], rows: [{ status: "OK" }] };
  return {
    columns: [{ name: "value", type: reply === null ? "nil" : typeof reply === "number" ? "integer" : "string" }],
    rows: [{ value: fmt(reply) }],
  };
}

async function runRedis(target: QueryTarget, line: string, opts: Required<QueryOptions>): Promise<Omit<QueryResult, "durationMs">> {
  const args = parseRedisCommand(line);
  if (args.length === 0) throw new Error("Empty Redis command");
  const command = args[0].toUpperCase();
  if (REDIS_FORBIDDEN.has(command)) throw new Error(`Redis command ${command} is not available in Query Studio`);
  if (opts.mode === "read" && !REDIS_READ_COMMANDS.has(command)) {
    throw new Error(`Read-only mode: ${command} modifies data. Switch to write mode (OWNER/ADMIN) to run it.`);
  }
  const isDestructive = REDIS_SAFE_MODE_BLOCKED.has(command);
  if (isDestructive && opts.safeMode) {
    throw new Error(`Safe Mode Block: ${command} detected. Disable Safe Mode to execute it.`);
  }

  return withRedis(target.connectionUrl, opts.timeoutMs, async (redis) => {
    if (command === "KEYS") {
      // KEYS blocks the server on large keyspaces; serve it with SCAN instead.
      const { keys, truncated } = await scanKeys(redis, args[1] || "*", opts.rowLimit);
      return {
        columns: [{ name: "index", type: "integer" }, { name: "value", type: "string" }],
        rows: keys.map((value, index) => ({ index, value })),
        rowCount: keys.length,
        commandType: command,
        isDestructive: false,
        mode: opts.mode,
        truncated,
        warning: truncated ? `Result truncated to ${opts.rowLimit} keys` : undefined,
      };
    }
    const reply = await redis.call(args[0], ...args.slice(1));
    const { columns, rows } = redisRows(reply, command);
    const truncated = rows.length > opts.rowLimit;
    return {
      columns,
      rows: truncated ? rows.slice(0, opts.rowLimit) : rows,
      rowCount: Math.min(rows.length, opts.rowLimit),
      commandType: command,
      isDestructive,
      mode: opts.mode,
      truncated,
      warning: truncated ? `Result truncated to ${opts.rowLimit} rows` : undefined,
    };
  });
}

async function introspectRedis(target: QueryTarget): Promise<TableSchema[]> {
  return withRedis(target.connectionUrl, QUERY_TIMEOUT_MS, async (redis) => {
    const { keys } = await scanKeys(redis, "*", REDIS_SCAN_KEY_LIMIT);
    if (keys.length === 0) return [];
    const typePipe = redis.pipeline();
    for (const k of keys) typePipe.type(k).pttl(k);
    const typeReplies = (await typePipe.exec()) || [];
    const sizePipe = redis.pipeline();
    const types: string[] = [];
    keys.forEach((k, i) => {
      const type = String(typeReplies[i * 2]?.[1] ?? "none");
      types.push(type);
      if (type === "string") sizePipe.strlen(k);
      else if (type === "list") sizePipe.llen(k);
      else if (type === "hash") sizePipe.hlen(k);
      else if (type === "set") sizePipe.scard(k);
      else if (type === "zset") sizePipe.zcard(k);
      else if (type === "stream") sizePipe.xlen(k);
      else sizePipe.exists(k);
    });
    const sizes = (await sizePipe.exec()) || [];
    return keys.map((key, i) => {
      const ttlMs = Number(typeReplies[i * 2 + 1]?.[1] ?? -1);
      return {
        tableName: key,
        columns: [
          { name: "type", type: types[i], nullable: false, isPrimaryKey: false },
          { name: "ttl", type: ttlMs < 0 ? "none" : `${Math.ceil(ttlMs / 1000)}s`, nullable: true, isPrimaryKey: false },
        ],
        rowCountEstimate: Number(sizes[i]?.[1] ?? 0),
      };
    });
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

const UNREACHABLE = /ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|connection timeout|timeout expired|connect timeout|Connection is closed/i;

/**
 * A network failure gets an answer the user can act on. The control plane connects from outside
 * the runner, so a database on a self-hosted runner is reachable only when its port is open.
 */
async function reachable<T>(target: QueryTarget, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    const code = (err as { code?: string })?.code || "";
    if (!UNREACHABLE.test(`${code} ${message}`)) throw err;
    let where = "the database";
    let port = "";
    try {
      const url = new URL(target.connectionUrl);
      where = `${url.hostname}:${url.port}`;
      port = url.port;
    } catch {
      // keep the generic wording
    }
    throw new Error(
      `Could not reach ${where} (${code || "connection timed out"}). Services on the same runner connect over the private network and are not affected. ` +
        `For Query Studio and external tools, open TCP port ${port || "of the database"} in the runner host's firewall or security group ` +
        `(set RUNNER_DB_PORT_RANGE on the runner to keep database ports in one small range).`
    );
  }
}

/** Executes one query/command against a managed database. */
export async function executeQuery(target: QueryTarget, rawQuery: string, options: QueryOptions = {}): Promise<QueryResult> {
  const query = (rawQuery || "").trim();
  if (!query) throw new Error("Query is empty");
  assertReachable(target);
  const opts: Required<QueryOptions> = {
    mode: options.mode || "read",
    safeMode: options.safeMode ?? true,
    timeoutMs: Math.min(Math.max(options.timeoutMs ?? QUERY_TIMEOUT_MS, 100), QUERY_TIMEOUT_MS),
    rowLimit: Math.min(Math.max(options.rowLimit ?? QUERY_ROW_LIMIT, 1), QUERY_ROW_LIMIT),
  };
  const started = Date.now();
  const result = await reachable(target, () =>
    target.provider === "REDIS" ? runRedis(target, query, opts) : target.provider === "MYSQL" ? runMysql(target, query, opts) : runPostgres(target, query, opts)
  );
  return { ...result, durationMs: Date.now() - started };
}

/** Real schema of a managed database (tables + columns, or Redis keys). */
export async function getDatabaseSchema(target: QueryTarget): Promise<TableSchema[]> {
  assertReachable(target);
  return reachable(target, () =>
    target.provider === "REDIS" ? introspectRedis(target) : target.provider === "MYSQL" ? introspectMysql(target) : introspectPostgres(target)
  );
}
