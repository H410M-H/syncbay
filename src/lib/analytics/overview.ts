/**
 * Syncbay PaaS — dashboard aggregates (Team B, v1.2).
 *
 * Every function takes the caller's already-authorised workspace ids and only counts
 * non-deleted services in non-deleted projects. A service's state comes from its LATEST
 * deployment (never from counting deployment rows), with `Service.isPaused` taking precedence.
 */

import { db } from "@/lib/db";

export type ServiceState = "live" | "sleeping" | "failed" | "building" | "paused" | "idle";

export interface ServiceCounts {
  total: number;
  live: number;
  sleeping: number;
  failed: number;
  building: number;
  paused: number;
  /** Never deployed, or the latest deployment was cancelled/superseded. */
  idle: number;
}

/** State of a service from `isPaused` and its latest deployment's status. */
export function serviceState(isPaused: boolean, latestStatus: string | null): ServiceState {
  if (isPaused) return "paused";
  switch (latestStatus) {
    case "ACTIVE":
      return "live";
    case "SLEEPING":
      return "sleeping";
    case "FAILED":
    case "CRASHED":
      return "failed";
    case "QUEUED":
    case "BUILDING":
    case "DEPLOYING":
      return "building";
    default:
      return "idle";
  }
}

export interface ServiceStateRow {
  id: string;
  name: string;
  isPaused: boolean;
  status: string | null;
  deploymentId: string | null;
  projectId: string;
  projectName: string;
  workspaceId: string;
}

/** Each non-deleted service in scope with its latest deployment (index: deployments(serviceId, createdAt)). */
export async function latestServiceStates(workspaceIds: string[]): Promise<ServiceStateRow[]> {
  if (workspaceIds.length === 0) return [];
  return db.$queryRaw<ServiceStateRow[]>`
    SELECT s."id", s."name", s."isPaused", d."status"::text AS "status", d."id" AS "deploymentId",
           p."id" AS "projectId", p."name" AS "projectName", p."workspaceId"
    FROM "services" s
    JOIN "environments" e ON e."id" = s."environmentId"
    JOIN "projects" p ON p."id" = e."projectId"
    LEFT JOIN LATERAL (
      SELECT "id", "status" FROM "deployments" WHERE "serviceId" = s."id" ORDER BY "createdAt" DESC LIMIT 1
    ) d ON true
    WHERE s."deletedAt" IS NULL AND p."deletedAt" IS NULL AND p."workspaceId" = ANY(${workspaceIds}::text[])`;
}

export function countServiceStates(rows: Pick<ServiceStateRow, "isPaused" | "status">[]): ServiceCounts {
  const counts: ServiceCounts = { total: 0, live: 0, sleeping: 0, failed: 0, building: 0, paused: 0, idle: 0 };
  for (const r of rows) {
    counts.total += 1;
    counts[serviceState(r.isPaused, r.status)] += 1;
  }
  return counts;
}

export async function countProjects(workspaceIds: string[]): Promise<number> {
  if (workspaceIds.length === 0) return 0;
  return db.project.count({ where: { workspaceId: { in: workspaceIds }, deletedAt: null } });
}

/** Deployment outcomes: reached ACTIVE (incl. later slept/superseded) vs failed. */
const SUCCEEDED = ["ACTIVE", "SLEEPING", "SUPERSEDED"];
const FAILED = ["FAILED", "CRASHED"];
const IN_PROGRESS = ["QUEUED", "BUILDING", "DEPLOYING"];

export interface DeployStats {
  total: number;
  succeeded: number;
  failed: number;
  inProgress: number;
  cancelled: number;
  /** succeeded / (succeeded + failed), percent; null when nothing finished. */
  successRate: number | null;
  /** Mean start → live time of succeeded deployments (buildDurationMs when recorded). */
  avgBuildMs: number | null;
}

interface DeployStatsRow {
  total: number;
  succeeded: number;
  failed: number;
  in_progress: number;
  cancelled: number;
  avg_build_ms: number | null;
}

/** UTC wall-clock literal for TIMESTAMP(3) columns. */
const ts = (d: Date) => d.toISOString().replace("Z", "");

export function successRate(succeeded: number, failed: number): number | null {
  const finished = succeeded + failed;
  return finished > 0 ? Math.round((succeeded / finished) * 1000) / 10 : null;
}

/** Deployments created since `since` in scope. */
export async function deployStats(workspaceIds: string[], since: Date): Promise<DeployStats> {
  const empty: DeployStats = { total: 0, succeeded: 0, failed: 0, inProgress: 0, cancelled: 0, successRate: null, avgBuildMs: null };
  if (workspaceIds.length === 0) return empty;
  const [row] = await db.$queryRaw<DeployStatsRow[]>`
    SELECT count(*)::float8 AS "total",
           count(*) FILTER (WHERE d."status"::text = ANY(${SUCCEEDED}::text[]))::float8 AS "succeeded",
           count(*) FILTER (WHERE d."status"::text = ANY(${FAILED}::text[]))::float8 AS "failed",
           count(*) FILTER (WHERE d."status"::text = ANY(${IN_PROGRESS}::text[]))::float8 AS "in_progress",
           count(*) FILTER (WHERE d."status"::text = 'CANCELLED')::float8 AS "cancelled",
           AVG(COALESCE(d."buildDurationMs"::float8, EXTRACT(EPOCH FROM (d."completedAt" - d."startedAt")) * 1000))
             FILTER (WHERE d."status"::text = ANY(${SUCCEEDED}::text[])
                     AND (d."buildDurationMs" IS NOT NULL OR (d."completedAt" IS NOT NULL AND d."startedAt" IS NOT NULL)))::float8 AS "avg_build_ms"
    FROM "deployments" d
    JOIN "services" s ON s."id" = d."serviceId"
    JOIN "environments" e ON e."id" = s."environmentId"
    JOIN "projects" p ON p."id" = e."projectId"
    WHERE d."createdAt" >= ${ts(since)}::timestamp
      AND s."deletedAt" IS NULL AND p."deletedAt" IS NULL AND p."workspaceId" = ANY(${workspaceIds}::text[])`;
  if (!row) return empty;
  const succeeded = Number(row.succeeded) || 0;
  const failed = Number(row.failed) || 0;
  return {
    total: Number(row.total) || 0,
    succeeded,
    failed,
    inProgress: Number(row.in_progress) || 0,
    cancelled: Number(row.cancelled) || 0,
    successRate: successRate(succeeded, failed),
    avgBuildMs: row.avg_build_ms === null ? null : Math.round(Number(row.avg_build_ms)),
  };
}

export interface TimelineDay {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  total: number;
  succeeded: number;
  failed: number;
  inProgress: number;
  cancelled: number;
}

/** Per-UTC-day deployment counts by outcome for the last `days` days (today included, zero days filled). */
export async function deploymentTimeline(workspaceIds: string[], days: number, now = new Date()) {
  const DAY = 86_400_000;
  const today = Math.floor(now.getTime() / DAY) * DAY;
  const start = new Date(today - (days - 1) * DAY);
  const series: TimelineDay[] = Array.from({ length: days }, (_, i) => ({
    day: new Date(start.getTime() + i * DAY).toISOString().slice(0, 10),
    total: 0,
    succeeded: 0,
    failed: 0,
    inProgress: 0,
    cancelled: 0,
  }));
  if (workspaceIds.length > 0) {
    const rows = await db.$queryRaw<Array<{ day: string; status: string; n: number }>>`
      SELECT to_char(date_trunc('day', d."createdAt"), 'YYYY-MM-DD') AS "day", d."status"::text AS "status", count(*)::float8 AS "n"
      FROM "deployments" d
      JOIN "services" s ON s."id" = d."serviceId"
      JOIN "environments" e ON e."id" = s."environmentId"
      JOIN "projects" p ON p."id" = e."projectId"
      WHERE d."createdAt" >= ${ts(start)}::timestamp
        AND s."deletedAt" IS NULL AND p."deletedAt" IS NULL AND p."workspaceId" = ANY(${workspaceIds}::text[])
      GROUP BY 1, 2`;
    const byDay = new Map(series.map((d) => [d.day, d]));
    for (const r of rows) {
      const d = byDay.get(r.day);
      if (!d) continue;
      const n = Number(r.n) || 0;
      d.total += n;
      if (SUCCEEDED.includes(r.status)) d.succeeded += n;
      else if (FAILED.includes(r.status)) d.failed += n;
      else if (IN_PROGRESS.includes(r.status)) d.inProgress += n;
      else d.cancelled += n;
    }
  }
  const succeeded = series.reduce((n, d) => n + d.succeeded, 0);
  const failed = series.reduce((n, d) => n + d.failed, 0);
  return {
    days,
    from: series[0].day,
    to: series[series.length - 1].day,
    series,
    totals: {
      total: series.reduce((n, d) => n + d.total, 0),
      succeeded,
      failed,
      successRate: successRate(succeeded, failed),
    },
  };
}

export interface ResourceSummary {
  /** Live (ACTIVE, not paused) services in scope. */
  liveServices: number;
  /** Live services with a sample in the last 10 minutes. */
  sampledServices: number;
  cpuPercentAvg: number | null;
  memoryUsedMb: number | null;
  /** Docker limits summed; native processes share the host, so its memory counts once. */
  memoryLimitMb: number | null;
  newestSampleAt: string | null;
}

const FRESH_SAMPLE_MS = 10 * 60_000;

/** Newest `MetricSample` per live service (only samples from the last 10 minutes count as live). */
export async function liveResourceSummary(liveServiceIds: string[], now = new Date()): Promise<ResourceSummary> {
  const summary: ResourceSummary = {
    liveServices: liveServiceIds.length,
    sampledServices: 0,
    cpuPercentAvg: null,
    memoryUsedMb: null,
    memoryLimitMb: null,
    newestSampleAt: null,
  };
  if (liveServiceIds.length === 0) return summary;
  const rows = await db.$queryRaw<Array<{ cpu: number; mem: number; lim: number | null; source: string; at: Date }>>`
    SELECT DISTINCT ON ("serviceId") "cpuPercent" AS "cpu", "memoryMb" AS "mem", "memoryLimitMb" AS "lim", "source", "sampledAt" AS "at"
    FROM "metric_samples"
    WHERE "serviceId" = ANY(${liveServiceIds}::text[]) AND "sampledAt" >= ${ts(new Date(now.getTime() - FRESH_SAMPLE_MS))}::timestamp
    ORDER BY "serviceId", "sampledAt" DESC`;
  if (rows.length === 0) return summary;
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const dockerLimit = rows.filter((r) => r.source !== "proc" && r.lim).reduce((n, r) => n + Number(r.lim), 0);
  const hostLimit = rows.filter((r) => r.source === "proc" && r.lim).reduce((n, r) => Math.max(n, Number(r.lim)), 0);
  summary.sampledServices = rows.length;
  summary.cpuPercentAvg = round1(rows.reduce((n, r) => n + Number(r.cpu), 0) / rows.length);
  summary.memoryUsedMb = round1(rows.reduce((n, r) => n + Number(r.mem), 0));
  summary.memoryLimitMb = dockerLimit + hostLimit > 0 ? round1(dockerLimit + hostLimit) : null;
  summary.newestSampleAt = new Date(Math.max(...rows.map((r) => new Date(r.at).getTime()))).toISOString();
  return summary;
}
