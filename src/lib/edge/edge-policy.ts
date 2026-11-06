/**
 * Syncbay PaaS — Per-host edge policy (WAF rules + canary split)
 *
 * The proxy looks up a host's service, its enabled `WafRule`s and its
 * `CanaryConfig` once per 15 s per instance (single-flighted, negative results
 * cached too). Lookups need `DATABASE_URL`; without it, or on a DB error, the
 * policy is empty and traffic is not filtered (fail open).
 */

import { db } from "@/lib/db";
import { generateDefaultSubdomain } from "@/lib/domain-service";
import type { WafRuleLike } from "@/lib/devops/waf-engine";

export interface CanaryPolicy {
  id: string;
  status: string;
  weightPercent: number;
  stableUpstreamUrl: string;
  canaryUpstreamUrl: string;
}

export interface EdgePolicy {
  serviceId: string;
  wafRules: WafRuleLike[];
  canary: CanaryPolicy | null;
}

const POLICY_TTL_MS = 15_000;
const cache = new Map<string, { policy: EdgePolicy | null; expiresAt: number }>();
const inflight = new Map<string, Promise<EdgePolicy | null>>();
let warned = false;

function normalize(host: string): string {
  return (host || "").trim().toLowerCase().split(":")[0];
}

/** Service id for a request host: exact Domain row, else the platform default host `<svc>-<env>`. */
async function resolveServiceId(host: string): Promise<string | null> {
  const platformHost = host.endsWith(".localhost") ? `${host.slice(0, -".localhost".length)}.syncbay.app` : host;
  const domain = await db.domain.findFirst({
    where: { hostname: { in: Array.from(new Set([host, platformHost])) }, service: { deletedAt: null } },
    select: { serviceId: true },
  });
  if (domain) return domain.serviceId;

  if (!platformHost.endsWith(".syncbay.app")) return null;
  const sub = platformHost.slice(0, -".syncbay.app".length);
  if (!sub || sub.includes(".")) return null;
  const parts = sub.split("-");
  const candidates = parts.map((_, i) => parts.slice(0, i + 1).join("-"));
  const services = await db.service.findMany({
    where: { deletedAt: null, name: { in: candidates, mode: "insensitive" } },
    select: { id: true, name: true, environment: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 25,
  });
  const match = services.find((s) => generateDefaultSubdomain(s.name, s.environment?.name || "production") === platformHost);
  return match?.id ?? null;
}

async function loadPolicy(host: string): Promise<EdgePolicy | null> {
  const serviceId = await resolveServiceId(host);
  if (!serviceId) return null;
  const [rules, canary] = await Promise.all([
    db.wafRule.findMany({
      where: { serviceId, enabled: true },
      select: { id: true, type: true, value: true, rateLimitRpm: true, enabled: true },
    }),
    db.canaryConfig.findUnique({
      where: { serviceId },
      select: { id: true, status: true, weightPercent: true, stableUpstreamUrl: true, canaryUpstreamUrl: true },
    }),
  ]);
  return { serviceId, wafRules: rules, canary };
}

/** Cached policy for a host, or null (no service / no DB / lookup failed). */
export async function getEdgePolicy(rawHost: string): Promise<EdgePolicy | null> {
  const host = normalize(rawHost);
  if (!host || !process.env.DATABASE_URL) return null;
  const now = Date.now();
  const hit = cache.get(host);
  if (hit && hit.expiresAt > now) return hit.policy;

  let pending = inflight.get(host);
  if (!pending) {
    pending = loadPolicy(host)
      .catch((err) => {
        if (!warned) {
          warned = true;
          console.warn(`[edge-policy] lookup failed, serving without WAF/canary: ${err?.message || err}`);
        }
        return hit?.policy ?? null;
      })
      .then((policy) => {
        cache.set(host, { policy, expiresAt: Date.now() + POLICY_TTL_MS });
        if (cache.size > 5000) cache.delete(cache.keys().next().value as string);
        return policy;
      })
      .finally(() => inflight.delete(host));
    inflight.set(host, pending);
  }
  return pending;
}

/** Drops cached policies (tests, or after a rule change in this process). */
export function clearEdgePolicyCache(host?: string): void {
  if (host) cache.delete(normalize(host));
  else cache.clear();
}
