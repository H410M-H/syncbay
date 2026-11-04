/**
 * Syncbay PaaS — Last-request tracking for scale-to-zero.
 *
 * `src/proxy.ts` calls `recordServiceRequest(host)` for every request it routes to
 * an ACTIVE service. Writes are debounced per host (30 s per instance) and go to
 * Upstash (`SET syncbay:edge:last:<host> <ms> EX 7d`) when configured, otherwise
 * to `Service.lastRequestAt`. The idle sleeper reads both.
 */

import { normalizeHostname } from "@/lib/edge/service-registry";

export const ACTIVITY_DEBOUNCE_MS = 30_000;
export const ACTIVITY_KEY_PREFIX = "syncbay:edge:last:";
const ACTIVITY_TTL_SECS = 7 * 24 * 60 * 60;
const MAX_TRACKED_HOSTS = 10_000;

const lastWrite = new Map<string, number>();

function upstashConfig(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

async function upstash(cfg: { url: string; token: string }, command: unknown[]): Promise<unknown> {
  const res = await globalThis.fetch(cfg.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
    cache: "no-store",
    signal: AbortSignal.timeout(1_000),
  });
  if (!res.ok) throw new Error(`Upstash REST HTTP ${res.status}`);
  const json = (await res.json()) as { result?: unknown; error?: string };
  if (json?.error) throw new Error(`Upstash REST error: ${json.error}`);
  return json?.result;
}

/** Service id for a routed host: exact Domain row first, then the platform subdomain. */
export async function resolveServiceIdForHost(host: string): Promise<string | null> {
  const { db } = await import("@/lib/db");
  const { generateDefaultSubdomain } = await import("@/lib/domain-service");
  const domain = await db.domain.findFirst({
    where: { hostname: host, service: { deletedAt: null } },
    select: { serviceId: true },
  });
  if (domain) return domain.serviceId;

  const suffix = [".syncbay.app", ".localhost"].find((s) => host.endsWith(s));
  if (!suffix) return null;
  const sub = host.slice(0, -suffix.length);
  const platformHost = `${sub}.syncbay.app`;
  const candidates = await db.service.findMany({
    where: { deletedAt: null, name: { startsWith: sub.split("-")[0] } },
    select: { id: true, name: true, environment: { select: { name: true, isPrEnv: true, prNumber: true } } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const match = candidates.find(
    (s) =>
      generateDefaultSubdomain(s.name, s.environment?.name || "production") === platformHost ||
      (s.environment?.isPrEnv && `${s.name}-pr-${s.environment.prNumber}.syncbay.app` === platformHost) ||
      s.name === sub ||
      s.id === sub
  );
  return match?.id ?? null;
}

async function writeActivity(host: string, at: number): Promise<void> {
  const cfg = upstashConfig();
  if (cfg) {
    await upstash(cfg, ["SET", ACTIVITY_KEY_PREFIX + host, String(at), "EX", String(ACTIVITY_TTL_SECS)]);
    return;
  }
  if (!process.env.DATABASE_URL) return;
  const serviceId = await resolveServiceIdForHost(host);
  if (!serviceId) return;
  const { db } = await import("@/lib/db");
  await db.service.update({ where: { id: serviceId }, data: { lastRequestAt: new Date(at) } });
}

/**
 * Records a request to `host`. Fire-and-forget: returns the pending write (or
 * null when debounced) and never rejects.
 */
export function recordServiceRequest(rawHost: string, now = Date.now()): Promise<void> | null {
  const host = normalizeHostname(rawHost);
  if (!host) return null;
  const prev = lastWrite.get(host);
  if (prev !== undefined && now - prev < ACTIVITY_DEBOUNCE_MS) return null;
  if (lastWrite.size >= MAX_TRACKED_HOSTS) lastWrite.clear();
  lastWrite.set(host, now);
  return writeActivity(host, now).catch(() => {
    // Activity tracking must never affect request routing; allow a retry next request.
    lastWrite.delete(host);
  });
}

/** Latest recorded request time (ms) over `hosts` in Upstash, or null. */
export async function readUpstashActivity(hosts: string[]): Promise<number | null> {
  const cfg = upstashConfig();
  if (!cfg || hosts.length === 0) return null;
  const values = ((await upstash(cfg, ["MGET", ...hosts.map((h) => ACTIVITY_KEY_PREFIX + normalizeHostname(h))])) ||
    []) as Array<string | null>;
  let latest: number | null = null;
  for (const v of values) {
    const n = v ? Number(v) : NaN;
    if (Number.isFinite(n) && (latest === null || n > latest)) latest = n;
  }
  return latest;
}

/** Test hook: forget debounce state. */
export function resetActivityDebounce(): void {
  lastWrite.clear();
}
