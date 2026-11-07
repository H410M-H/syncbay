/**
 * Syncbay PaaS — Canary releases (DB-backed)
 *
 * A `CanaryConfig` row splits a service's traffic between a stable and a
 * canary deployment's upstream. The proxy (`src/lib/edge/canary.ts`) picks a
 * variant per client with a sticky cookie and counts routed requests;
 * `evaluateCanaryHealth` trips an automatic rollback when the canary's 5xx
 * rate exceeds the threshold. The request/5xx signal is the canary deployment's
 * `TrafficSample` rows (runner proxy counters, drained every minute; upstream
 * network errors count as 5xx because the client got a 502). A caller may supply
 * `errorCounts` instead. With neither, the result is INSUFFICIENT_DATA (rate null).
 */

import type { PrismaClient } from "@prisma/client";

export type CanaryStatus = "ACTIVE" | "PROMOTED" | "ROLLED_BACK";
export type CanaryVariant = "stable" | "canary";

export interface CanaryConfig {
  id: string;
  serviceId: string;
  stableDeploymentId: string;
  canaryDeploymentId: string;
  stableUpstreamUrl: string;
  canaryUpstreamUrl: string;
  canaryWeightPercent: number;
  autoRollbackThreshold5xxPercent: number;
  status: CanaryStatus;
  startedAt: string;
  totalRequestsRouted: number;
  canaryRequestsRouted: number;
  lastHealthEvaluation?: {
    evaluatedAt: string;
    canary5xxRatePercent: number | null;
    healthy: boolean | null;
    reason?: string;
  };
}

export interface CanaryHealthResult {
  action: "MAINTAIN" | "ROLLBACK" | "PROMOTE" | "INSUFFICIENT_DATA";
  errorRatePercent: number | null;
  requests: number;
  errors5xx: number;
  reason: string;
}

export type CanaryDb = Pick<PrismaClient, "canaryConfig" | "deployment" | "metricSample" | "trafficSample">;
type CanaryRow = Awaited<ReturnType<CanaryDb["canaryConfig"]["findUniqueOrThrow"]>>;

export function toCanaryConfig(row: CanaryRow): CanaryConfig {
  return {
    id: row.id,
    serviceId: row.serviceId,
    stableDeploymentId: row.stableDeploymentId,
    canaryDeploymentId: row.canaryDeploymentId,
    stableUpstreamUrl: row.stableUpstreamUrl,
    canaryUpstreamUrl: row.canaryUpstreamUrl,
    canaryWeightPercent: row.weightPercent,
    autoRollbackThreshold5xxPercent: row.autoRollbackThreshold5xxPercent,
    status: row.status as CanaryStatus,
    startedAt: row.startedAt.toISOString(),
    totalRequestsRouted: row.stableRequests + row.canaryRequests,
    canaryRequestsRouted: row.canaryRequests,
    lastHealthEvaluation: row.lastEvaluatedAt
      ? {
          evaluatedAt: row.lastEvaluatedAt.toISOString(),
          canary5xxRatePercent: row.lastErrorRatePercent,
          healthy: row.lastHealthy,
          reason: row.lastReason ?? undefined,
        }
      : undefined,
  };
}

// ─── Pure routing / health logic ─────────────────────────────────────────────

/**
 * Picks the variant for one request. `roll` is a number in [0, 100); a valid
 * sticky variant from the client's cookie wins while the split is active.
 */
export function pickVariant(
  config: Pick<CanaryConfig, "status" | "canaryWeightPercent">,
  roll: number,
  sticky?: CanaryVariant | null
): CanaryVariant {
  if (config.status === "ROLLED_BACK" || config.canaryWeightPercent <= 0) return "stable";
  if (config.status === "PROMOTED" || config.canaryWeightPercent >= 100) return "canary";
  if (sticky === "stable" || sticky === "canary") return sticky;
  return roll < config.canaryWeightPercent ? "canary" : "stable";
}

/** Deployment id a request with the given roll is routed to. */
export function routeTraffic(config: CanaryConfig, roll: number = Math.random() * 100): string {
  return pickVariant(config, roll % 100) === "canary" ? config.canaryDeploymentId : config.stableDeploymentId;
}

/** Decision from observed canary request / 5xx counts. */
export function evaluateCanaryCounts(
  config: Pick<CanaryConfig, "status" | "autoRollbackThreshold5xxPercent">,
  errors5xx: number,
  requests: number,
  minRequests = 20
): CanaryHealthResult {
  if (config.status === "ROLLED_BACK") {
    return { action: "ROLLBACK", errorRatePercent: null, requests, errors5xx, reason: "Canary is rolled back. Set a weight to retry." };
  }
  if (config.status === "PROMOTED") {
    return { action: "PROMOTE", errorRatePercent: null, requests, errors5xx, reason: "Canary has been promoted to 100% of traffic." };
  }
  if (requests < minRequests) {
    return {
      action: "INSUFFICIENT_DATA",
      errorRatePercent: requests > 0 ? +((errors5xx / requests) * 100).toFixed(2) : null,
      requests,
      errors5xx,
      reason: `Not enough canary traffic to judge (${requests} < ${minRequests} requests)`,
    };
  }
  const errorRatePercent = +((Math.max(0, errors5xx) / requests) * 100).toFixed(2);
  if (errorRatePercent >= config.autoRollbackThreshold5xxPercent) {
    return {
      action: "ROLLBACK",
      errorRatePercent,
      requests,
      errors5xx,
      reason: `Automated Rollback Triggered: Canary 5xx error rate (${errorRatePercent}%) exceeded safety threshold (${config.autoRollbackThreshold5xxPercent}%)`,
    };
  }
  return {
    action: "MAINTAIN",
    errorRatePercent,
    requests,
    errors5xx,
    reason: `Canary healthy: error rate ${errorRatePercent}% is below threshold (${config.autoRollbackThreshold5xxPercent}%)`,
  };
}

/** Request / 5xx counts of a deployment since a time, from whatever source records them. */
export type ErrorCountSource = (deploymentId: string, since: Date) => Promise<{ requests: number; errors5xx: number } | null>;

/**
 * Default source: the deployment's `TrafficSample` minutes since `since` (rounded down to the
 * minute). 5xx = upstream 5xx + proxy network errors. Null when no traffic row exists.
 */
export function trafficErrorCounts(db: Pick<CanaryDb, "trafficSample">): ErrorCountSource {
  return async (deploymentId, since) => {
    const agg = await db.trafficSample.aggregate({
      where: { deploymentId, bucketStart: { gte: new Date(Math.floor(since.getTime() / 60_000) * 60_000) } },
      _sum: { requests: true, s5xx: true, errors: true },
      _count: { _all: true },
    });
    if (!agg._count._all) return null;
    return { requests: agg._sum.requests ?? 0, errors5xx: (agg._sum.s5xx ?? 0) + (agg._sum.errors ?? 0) };
  };
}

// ─── DB operations ────────────────────────────────────────────────────────────

export async function getCanaryConfig(db: CanaryDb, serviceId: string): Promise<CanaryConfig | null> {
  const row = await db.canaryConfig.findUnique({ where: { serviceId } });
  return row ? toCanaryConfig(row) : null;
}

function upstreamFromHealthUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function assertUpstreamUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid upstream URL "${url}"`);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("Upstream URL must be http(s)");
  return parsed.origin;
}

/**
 * Starts (or replaces) a canary for a service. Upstreams default to the
 * deployments' recorded health-check origin; pass them explicitly otherwise.
 */
export async function startCanary(
  db: CanaryDb,
  input: {
    serviceId: string;
    stableDeploymentId: string;
    canaryDeploymentId: string;
    stableUpstreamUrl?: string;
    canaryUpstreamUrl?: string;
    weightPercent?: number;
    autoRollbackThreshold5xxPercent?: number;
  }
): Promise<CanaryConfig> {
  if (input.stableDeploymentId === input.canaryDeploymentId) {
    throw new Error("Stable and canary deployments must differ");
  }
  const deployments = await db.deployment.findMany({
    where: { id: { in: [input.stableDeploymentId, input.canaryDeploymentId] }, serviceId: input.serviceId },
  });
  const stable = deployments.find((d) => d.id === input.stableDeploymentId);
  const canary = deployments.find((d) => d.id === input.canaryDeploymentId);
  if (!stable || !canary) throw new Error("Both deployments must belong to this service");

  const stableUpstreamUrl = input.stableUpstreamUrl
    ? assertUpstreamUrl(input.stableUpstreamUrl)
    : upstreamFromHealthUrl(stable.healthCheckUrl);
  const canaryUpstreamUrl = input.canaryUpstreamUrl
    ? assertUpstreamUrl(input.canaryUpstreamUrl)
    : upstreamFromHealthUrl(canary.healthCheckUrl);
  if (!stableUpstreamUrl || !canaryUpstreamUrl) {
    throw new Error("Upstream URLs are unknown for these deployments; pass stableUpstreamUrl and canaryUpstreamUrl");
  }

  const weightPercent = Math.round(Math.min(Math.max(input.weightPercent ?? 10, 0), 100));
  const data = {
    stableDeploymentId: stable.id,
    canaryDeploymentId: canary.id,
    stableUpstreamUrl,
    canaryUpstreamUrl,
    weightPercent,
    autoRollbackThreshold5xxPercent: input.autoRollbackThreshold5xxPercent ?? 5,
    status: "ACTIVE",
    stableRequests: 0,
    canaryRequests: 0,
    lastEvaluatedAt: null,
    lastErrorRatePercent: null,
    lastHealthy: null,
    lastReason: null,
    startedAt: new Date(),
  };
  const row = await db.canaryConfig.upsert({
    where: { serviceId: input.serviceId },
    create: { serviceId: input.serviceId, ...data },
    update: data,
  });
  return toCanaryConfig(row);
}

async function requireCanary(db: CanaryDb, serviceId: string): Promise<CanaryRow> {
  const row = await db.canaryConfig.findUnique({ where: { serviceId } });
  if (!row) throw new Error("No canary release is configured for this service");
  return row;
}

export async function updateCanaryWeight(db: CanaryDb, serviceId: string, weightPercent: number): Promise<CanaryConfig> {
  if (weightPercent < 0 || weightPercent > 100) throw new Error("Canary weight must be between 0 and 100 percent");
  await requireCanary(db, serviceId);
  const weight = Math.round(weightPercent);
  const status: CanaryStatus = weight === 100 ? "PROMOTED" : weight === 0 ? "ROLLED_BACK" : "ACTIVE";
  const row = await db.canaryConfig.update({ where: { serviceId }, data: { weightPercent: weight, status } });
  return toCanaryConfig(row);
}

export async function promoteCanary(db: CanaryDb, serviceId: string): Promise<CanaryConfig> {
  await requireCanary(db, serviceId);
  const row = await db.canaryConfig.update({ where: { serviceId }, data: { status: "PROMOTED", weightPercent: 100 } });
  return toCanaryConfig(row);
}

export async function rollbackCanary(db: CanaryDb, serviceId: string, reason?: string): Promise<CanaryConfig> {
  await requireCanary(db, serviceId);
  const row = await db.canaryConfig.update({
    where: { serviceId },
    data: { status: "ROLLED_BACK", weightPercent: 0, ...(reason ? { lastReason: reason, lastHealthy: false } : {}) },
  });
  return toCanaryConfig(row);
}

/**
 * Evaluates the canary over the last `windowMinutes` and rolls back
 * automatically above the threshold. Request/5xx counts come from
 * `options.errorCounts`, else from the canary's `TrafficSample` rows. With no
 * traffic recorded the result is INSUFFICIENT_DATA with a null rate, and the
 * reason says how many resource samples the canary has, so a canary that is
 * not even running is visible.
 */
export async function evaluateCanaryHealth(
  db: CanaryDb,
  serviceId: string,
  options: { windowMinutes?: number; minRequests?: number; now?: Date; errorCounts?: ErrorCountSource } = {}
): Promise<CanaryHealthResult> {
  const row = await requireCanary(db, serviceId);
  const now = options.now || new Date();
  const since = new Date(Math.max(row.startedAt.getTime(), now.getTime() - (options.windowMinutes ?? 15) * 60_000));
  const source = options.errorCounts || trafficErrorCounts(db);
  const counts = await source(row.canaryDeploymentId, since).catch(() => null);

  let result: CanaryHealthResult;
  if (counts) {
    result = evaluateCanaryCounts(toCanaryConfig(row), counts.errors5xx, counts.requests, options.minRequests);
  } else {
    result = evaluateCanaryCounts(toCanaryConfig(row), 0, 0, options.minRequests);
    if (row.status === "ACTIVE") {
      const samples = await db.metricSample
        .count({ where: { deploymentId: row.canaryDeploymentId, sampledAt: { gte: since } } })
        .catch(() => 0);
      result = {
        ...result,
        reason:
          samples > 0
            ? `No request traffic recorded for the canary (MetricSample has ${samples} CPU/memory sample(s) for the canary in this window)`
            : "No metrics recorded for the canary deployment in this window",
      };
    }
  }

  if (row.status === "ACTIVE") {
    await db.canaryConfig.update({
      where: { serviceId },
      data: {
        lastEvaluatedAt: now,
        lastErrorRatePercent: result.errorRatePercent,
        lastHealthy: result.action === "MAINTAIN" ? true : result.action === "ROLLBACK" ? false : null,
        lastReason: result.reason,
        ...(result.action === "ROLLBACK" ? { status: "ROLLED_BACK", weightPercent: 0 } : {}),
      },
    });
  }
  return result;
}
