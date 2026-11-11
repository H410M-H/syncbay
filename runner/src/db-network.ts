/**
 * Private networking for managed databases.
 *
 * A database's connection URL carries the runner's public address (`RUNNER_DB_HOST`) so that
 * external tools can use it. An app that runs on the same runner must not go out to that public
 * address and back: on most clouds the packet leaves through the gateway and is then dropped by
 * the firewall or security group. `rewriteDatabaseUrls()` points such URLs at the address the
 * database answers on from inside this host: the Docker bridge gateway for a container, or
 * 127.0.0.1 for a host process.
 */

export interface DatabaseTarget {
  /** Host written into the public connection URL. */
  publicHost: string;
  /** Host port the database is published on. */
  port: number;
  /** Address of the same port as seen by an app instance on this runner. */
  internalHost: string;
}

export interface RewriteResult {
  env: Record<string, string>;
  /** Names of the variables that were changed. */
  rewritten: string[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replaces `scheme://[user:pass@]publicHost:port` with the internal host in every variable. */
export function rewriteDatabaseUrls(env: Record<string, string>, targets: DatabaseTarget[]): RewriteResult {
  const out: Record<string, string> = { ...env };
  const rewritten: string[] = [];
  const active = targets.filter((t) => t.publicHost && t.internalHost && t.publicHost !== t.internalHost);
  if (active.length === 0) return { env: out, rewritten };

  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || !value.includes("://")) continue;
    let next = value;
    for (const t of active) {
      const host = t.publicHost.includes(":") ? `\\[?${escapeRegExp(t.publicHost)}\\]?` : escapeRegExp(t.publicHost);
      const pattern = new RegExp(`(://(?:[^@/\\s]*@)?)${host}:${t.port}(?![0-9])`, "g");
      next = next.replace(pattern, `$1${t.internalHost}:${t.port}`);
    }
    if (next !== value) {
      out[key] = next;
      rewritten.push(key);
    }
  }
  return { env: out, rewritten };
}

/** Parses `RUNNER_DB_PORT_RANGE` ("54320-54399"); null when unset or invalid. */
export function parsePortRange(raw: string | undefined): { start: number; end: number } | null {
  const match = /^\s*(\d{2,5})\s*-\s*(\d{2,5})\s*$/.exec(raw || "");
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start < 1024 || end > 65535 || start >= end) return null;
  return { start, end };
}
