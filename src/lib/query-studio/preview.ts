/**
 * Syncbay — read-only data previews (pure, client-safe).
 *
 * Builds the statements the Data view sends through `queryStudio.execute` in read mode:
 * `SELECT * FROM "<schema>"."<table>" LIMIT 50` with exact identifier quoting, and a
 * type-appropriate read command for a Redis key. Also masks connection URLs for display.
 */

type PreviewProvider = "POSTGRES" | "MYSQL" | "REDIS";

export const PREVIEW_ROW_LIMIT = 50;

/** Postgres identifier: wrapped in double quotes, embedded quotes doubled. */
export function quotePgIdent(name: string): string {
  if (name.includes("\0")) throw new Error("Identifier contains a NUL byte");
  return `"${name.replace(/"/g, '""')}"`;
}

/** MySQL identifier: wrapped in backticks, embedded backticks doubled. */
export function quoteMysqlIdent(name: string): string {
  if (name.includes("\0")) throw new Error("Identifier contains a NUL byte");
  return `\`${name.replace(/`/g, "``")}\``;
}

export interface PreviewTable {
  /** Display name from introspection (`schema.table` outside `public`). */
  tableName: string;
  /** Raw schema / table name when introspection supplied them. */
  schema?: string;
  name?: string;
}

/** First `limit` rows of a table, quoted so any table name is a single identifier. */
export function buildTablePreviewQuery(provider: "POSTGRES" | "MYSQL", table: PreviewTable, limit: number = PREVIEW_ROW_LIMIT): string {
  const n = Math.min(Math.max(Math.floor(limit), 1), 1000);
  if (provider === "MYSQL") return `SELECT * FROM ${quoteMysqlIdent(table.name ?? table.tableName)} LIMIT ${n}`;
  const name = table.name ?? table.tableName;
  const qualified = table.schema ? `${quotePgIdent(table.schema)}.${quotePgIdent(name)}` : quotePgIdent(name);
  return `SELECT * FROM ${qualified} LIMIT ${n}`;
}

/** Double-quoted Redis argument compatible with Query Studio's `parseRedisCommand`. */
export function quoteRedisArg(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Read-only command showing (at most 50 items of) a Redis key, by its TYPE. */
export function buildRedisPreviewCommand(key: string, type: string): string {
  const k = quoteRedisArg(key);
  const last = PREVIEW_ROW_LIMIT - 1;
  switch (type) {
    case "string":
      return `GET ${k}`;
    case "hash":
      return `HSCAN ${k} 0 COUNT ${PREVIEW_ROW_LIMIT}`;
    case "list":
      return `LRANGE ${k} 0 ${last}`;
    case "set":
      return `SSCAN ${k} 0 COUNT ${PREVIEW_ROW_LIMIT}`;
    case "zset":
      return `ZRANGE ${k} 0 ${last} WITHSCORES`;
    case "stream":
      return `XRANGE ${k} - + COUNT ${PREVIEW_ROW_LIMIT}`;
    default:
      return `TYPE ${k}`;
  }
}

/** Connection URL with the password replaced, for display. Unparsable input is fully masked. */
const SECRET_PARAMS = /^(password|pass|pwd|secret|token|auth|access_?key|sslpassword)$/i;

export function maskConnectionUrl(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "****";
    // redis://<secret>@host: a user part with no password is the password for Redis.
    else if (parsed.username && /^rediss?:$/i.test(parsed.protocol)) parsed.username = "****";
    for (const key of [...parsed.searchParams.keys()]) if (SECRET_PARAMS.test(key)) parsed.searchParams.set(key, "****");
    return parsed.toString();
  } catch {
    // Not a parseable URL: hide everything between "://" and the last "@", and any password=… pair.
    return url
      .replace(/(:\/\/)[^/]*@/, (_m, scheme) => `${scheme}****@`)
      .replace(/([?&;](?:password|pass|pwd|secret|token)=)[^&;\s]*/gi, "$1****");
  }
}
