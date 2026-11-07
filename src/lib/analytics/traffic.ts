/**
 * Syncbay PaaS — HTTP traffic analytics over `TrafficSample` (Team B, v1.2).
 *
 * Time-bucketed requests, status classes, bandwidth and latency for a set of services the
 * caller may read, plus per-service totals (top services). Buckets with no rows are returned
 * as zeros; `hasData` / `lastSampleAt` tell the UI whether anything was ever recorded.
 * Error rate = (5xx + proxy network errors) / requests.
 */

import { db } from "@/lib/db";
import { PERIODS } from "@/lib/telemetry/metrics-sampler";

export type TrafficPeriod = "1h" | "24h" | "7d";

export interface TrafficCounts {
  requests: number;
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  errors: number;
  bytesIn: number;
  bytesOut: number;
  latencyAvgMs: number | null;
  latencyMaxMs: number | null;
}

export interface TrafficPoint extends TrafficCounts {
  timestamp: string;
}

export interface TrafficTotals extends TrafficCounts {
  errorRatePercent: number | null;
}

export interface TopService extends TrafficTotals {
  serviceId: string;
  name: string;
  projectId: string;
  projectName: string;
}

export interface TrafficReport {
  period: TrafficPeriod;
  bucketSecs: number;
  since: string;
  until: string;
  points: TrafficPoint[];
  totals: TrafficTotals;
  histogram: { lt50: number; lt200: number; lt1000: number; ge1000: number };
  topServices: TopService[];
  hasData: boolean;
  lastSampleAt: string | null;
}

export interface ServiceRef {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
}

interface SumRow {
  requests: number;
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  errors: number;
  bytes_in: number;
  bytes_out: number;
  lat_sum: number;
  lat_max: number | null;
  lt50: number;
  lt200: number;
  lt1000: number;
  ge1000: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function counts(r: SumRow | undefined): TrafficCounts {
  const requests = Number(r?.requests) || 0;
  return {
    requests,
    s2xx: Number(r?.s2xx) || 0,
    s3xx: Number(r?.s3xx) || 0,
    s4xx: Number(r?.s4xx) || 0,
    s5xx: Number(r?.s5xx) || 0,
    errors: Number(r?.errors) || 0,
    bytesIn: Number(r?.bytes_in) || 0,
    bytesOut: Number(r?.bytes_out) || 0,
    latencyAvgMs: requests > 0 ? round1((Number(r?.lat_sum) || 0) / requests) : null,
    latencyMaxMs: requests > 0 && r?.lat_max != null ? round1(Number(r.lat_max)) : null,
  };
}

export function errorRatePercent(c: Pick<TrafficCounts, "requests" | "s5xx" | "errors">): number | null {
  return c.requests > 0 ? Math.round(((c.s5xx + c.errors) / c.requests) * 10000) / 100 : null;
}

const withRate = (c: TrafficCounts): TrafficTotals => ({ ...c, errorRatePercent: errorRatePercent(c) });

/** Traffic for `services` over `period` (most recent buckets, aligned like metrics.historical). */
export async function trafficReport(services: ServiceRef[], period: TrafficPeriod, options: { top?: number; now?: number } = {}): Promise<TrafficReport> {
  const { buckets, bucketSecs } = PERIODS[period];
  const bucketMs = bucketSecs * 1000;
  const now = options.now ?? Date.now();
  const end = Math.ceil(now / bucketMs) * bucketMs;
  const since = new Date(end - buckets * bucketMs);
  // TIMESTAMP(3) columns hold UTC wall-clock values: bind a zone-less literal.
  const sinceTs = since.toISOString().replace("Z", "");
  const interval = `${bucketSecs} seconds`;
  const ids = services.map((s) => s.id);

  const zeroPoints = (): TrafficPoint[] =>
    Array.from({ length: buckets }, (_, i) => ({ timestamp: new Date(since.getTime() + i * bucketMs).toISOString(), ...counts(undefined) }));
  const report: TrafficReport = {
    period,
    bucketSecs,
    since: since.toISOString(),
    until: new Date(end).toISOString(),
    points: zeroPoints(),
    totals: withRate(counts(undefined)),
    histogram: { lt50: 0, lt200: 0, lt1000: 0, ge1000: 0 },
    topServices: [],
    hasData: false,
    lastSampleAt: null,
  };
  if (ids.length === 0) return report;

  const [bucketRows, serviceRows, last] = await Promise.all([
    db.$queryRaw<Array<SumRow & { bucket: Date }>>`
      SELECT date_bin(${interval}::interval, "bucketStart", ${sinceTs}::timestamp) AS "bucket",
        SUM("requests")::float8 AS "requests", SUM("s2xx")::float8 AS "s2xx", SUM("s3xx")::float8 AS "s3xx",
        SUM("s4xx")::float8 AS "s4xx", SUM("s5xx")::float8 AS "s5xx", SUM("errors")::float8 AS "errors",
        SUM("bytesIn")::float8 AS "bytes_in", SUM("bytesOut")::float8 AS "bytes_out",
        SUM("latencySumMs")::float8 AS "lat_sum", MAX("latencyMaxMs")::float8 AS "lat_max",
        SUM("lt50")::float8 AS "lt50", SUM("lt200")::float8 AS "lt200", SUM("lt1000")::float8 AS "lt1000", SUM("ge1000")::float8 AS "ge1000"
      FROM "traffic_samples"
      WHERE "serviceId" = ANY(${ids}::text[]) AND "bucketStart" >= ${sinceTs}::timestamp
      GROUP BY 1 ORDER BY 1`,
    db.$queryRaw<Array<SumRow & { serviceId: string }>>`
      SELECT "serviceId",
        SUM("requests")::float8 AS "requests", SUM("s2xx")::float8 AS "s2xx", SUM("s3xx")::float8 AS "s3xx",
        SUM("s4xx")::float8 AS "s4xx", SUM("s5xx")::float8 AS "s5xx", SUM("errors")::float8 AS "errors",
        SUM("bytesIn")::float8 AS "bytes_in", SUM("bytesOut")::float8 AS "bytes_out",
        SUM("latencySumMs")::float8 AS "lat_sum", MAX("latencyMaxMs")::float8 AS "lat_max",
        SUM("lt50")::float8 AS "lt50", SUM("lt200")::float8 AS "lt200", SUM("lt1000")::float8 AS "lt1000", SUM("ge1000")::float8 AS "ge1000"
      FROM "traffic_samples"
      WHERE "serviceId" = ANY(${ids}::text[]) AND "bucketStart" >= ${sinceTs}::timestamp
      GROUP BY 1 ORDER BY 2 DESC`,
    db.trafficSample.findFirst({ where: { serviceId: { in: ids } }, orderBy: { bucketStart: "desc" }, select: { bucketStart: true } }),
  ]);

  const byTs = new Map(report.points.map((p, i) => [p.timestamp, i]));
  for (const r of bucketRows) {
    const i = byTs.get(new Date(r.bucket).toISOString());
    if (i !== undefined) report.points[i] = { timestamp: report.points[i].timestamp, ...counts(r) };
  }

  const total: SumRow = { requests: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, errors: 0, bytes_in: 0, bytes_out: 0, lat_sum: 0, lat_max: null, lt50: 0, lt200: 0, lt1000: 0, ge1000: 0 };
  for (const r of serviceRows) {
    for (const k of ["requests", "s2xx", "s3xx", "s4xx", "s5xx", "errors", "bytes_in", "bytes_out", "lat_sum", "lt50", "lt200", "lt1000", "ge1000"] as const) {
      total[k] += Number(r[k]) || 0;
    }
    if (r.lat_max != null) total.lat_max = Math.max(total.lat_max ?? 0, Number(r.lat_max));
  }
  report.totals = withRate(counts(total));
  report.histogram = { lt50: total.lt50, lt200: total.lt200, lt1000: total.lt1000, ge1000: total.ge1000 };
  const ref = new Map(services.map((s) => [s.id, s]));
  report.topServices = serviceRows
    .filter((r) => ref.has(r.serviceId))
    .slice(0, options.top ?? 5)
    .map((r) => {
      const s = ref.get(r.serviceId)!;
      return { serviceId: s.id, name: s.name, projectId: s.projectId, projectName: s.projectName, ...withRate(counts(r)) };
    });
  report.lastSampleAt = last ? last.bucketStart.toISOString() : null;
  report.hasData = Boolean(last);
  return report;
}
