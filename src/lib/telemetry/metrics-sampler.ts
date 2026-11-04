/**
 * Syncbay PaaS — Real container/process metrics.
 *
 * `fetchContainerMetrics()` asks the runner (`GET /api/metrics/:containerId`, HMAC)
 * or, with no RUNNER_URL on a single host, the same collector in-process.
 * `sampleActiveServices()` (1-minute cron) stores one `MetricSample` per running
 * deployment; the metrics router and stream read them back.
 */

import { db } from "@/lib/db";
import { getRunnerBaseUrl, runnerFetch } from "@/lib/runner-client";

/** Cadence of the sampler cron; each sample stands for this many seconds of usage. */
export const SAMPLE_INTERVAL_SECS = 60;

export interface RuntimeMetrics {
  containerId: string;
  source: "docker" | "proc";
  cpuPercent: number;
  memoryMb: number;
  memoryLimitMb: number | null;
  netRxBytes: number | null;
  netTxBytes: number | null;
  sampledAt: string;
}

function isServerless(): boolean {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

/**
 * One live reading, or null when the container is not running / cannot be
 * observed from here (serverless without a runner, SSH driver, mock ids).
 */
export async function fetchContainerMetrics(containerId: string): Promise<RuntimeMetrics | null> {
  if (!containerId) return null;
  if (getRunnerBaseUrl()) {
    const res = await runnerFetch(`/api/metrics/${encodeURIComponent(containerId)}`, { timeoutMs: 8000 });
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) throw new Error(`Runner metrics HTTP ${res.status}`);
    return (await res.json()) as RuntimeMetrics;
  }
  if (isServerless() || process.env.RUNNER_DRIVER === "ssh" || process.env.RUNNER_DRIVER === "mock") return null;
  // Local driver: the runner pipeline runs in this process/host.
  const { collectContainerMetrics } = await import("../../../runner/src/metrics");
  return collectContainerMetrics(containerId);
}

export interface SampleReport {
  sampled: number;
  skipped: number;
  errors: Array<{ deploymentId: string; error: string }>;
}

/** Latest ACTIVE deployment (with a container) of every running service. */
async function runningDeployments() {
  return db.deployment.findMany({
    where: { status: "ACTIVE", cfContainerId: { not: null }, service: { deletedAt: null, isPaused: false } },
    orderBy: { createdAt: "desc" },
    distinct: ["serviceId"],
    select: { id: true, serviceId: true, cfContainerId: true },
  });
}

export async function sampleActiveServices(options: { concurrency?: number } = {}): Promise<SampleReport> {
  const report: SampleReport = { sampled: 0, skipped: 0, errors: [] };
  const queue = await runningDeployments();
  const worker = async () => {
    for (let dep = queue.shift(); dep; dep = queue.shift()) {
      try {
        const m = await fetchContainerMetrics(dep.cfContainerId!);
        if (!m) {
          report.skipped += 1;
          continue;
        }
        await db.metricSample.create({
          data: {
            serviceId: dep.serviceId,
            deploymentId: dep.id,
            containerId: dep.cfContainerId!,
            source: m.source,
            cpuPercent: m.cpuPercent,
            memoryMb: m.memoryMb,
            memoryLimitMb: m.memoryLimitMb,
            netRxBytes: m.netRxBytes,
            netTxBytes: m.netTxBytes,
            sampledAt: new Date(m.sampledAt || Date.now()),
          },
        });
        report.sampled += 1;
      } catch (err) {
        report.errors.push({ deploymentId: dep.id, error: (err as Error)?.message || String(err) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 8) }, worker));
  return report;
}

/** Retention: drops samples older than `days`. */
export async function purgeOldSamples(days: number): Promise<number> {
  if (!(days > 0)) return 0;
  const res = await db.metricSample.deleteMany({ where: { sampledAt: { lt: new Date(Date.now() - days * 86_400_000) } } });
  return res.count;
}

// ─── Read side ───────────────────────────────────────────────────────────────

export interface TelemetryPoint {
  timestamp: string;
  cpuPercent: number;
  memoryUsedMb: number;
  memoryLimitMb: number | null;
  memoryPercent: number | null;
  networkIngressKb: number | null;
  networkEgressKb: number | null;
  diskUsedMb: number | null;
  diskLimitMb: number | null;
}

interface SampleLike {
  cpuPercent: number;
  memoryMb: number;
  memoryLimitMb: number | null;
  netRxBytes: number | null;
  netTxBytes: number | null;
  sampledAt: Date | string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** KB/s between two cumulative byte counters, or null. */
function rateKbPerSec(cur: number | null, prev: number | null | undefined, seconds: number): number | null {
  if (cur === null || prev === null || prev === undefined || !(seconds > 0)) return null;
  const delta = cur - prev;
  return delta >= 0 ? round1(delta / 1024 / seconds) : null;
}

/** Converts a sample (and optionally the one before it, for network rates) to a point. */
export function sampleToPoint(sample: SampleLike, prev?: SampleLike | null): TelemetryPoint {
  const ts = new Date(sample.sampledAt);
  const seconds = prev ? (ts.getTime() - new Date(prev.sampledAt).getTime()) / 1000 : 0;
  return {
    timestamp: ts.toISOString(),
    cpuPercent: round1(sample.cpuPercent),
    memoryUsedMb: round1(sample.memoryMb),
    memoryLimitMb: sample.memoryLimitMb,
    memoryPercent: sample.memoryLimitMb ? round1((sample.memoryMb / sample.memoryLimitMb) * 100) : null,
    networkIngressKb: rateKbPerSec(sample.netRxBytes, prev?.netRxBytes, seconds),
    networkEgressKb: rateKbPerSec(sample.netTxBytes, prev?.netTxBytes, seconds),
    diskUsedMb: null,
    diskLimitMb: null,
  };
}

export const PERIODS = {
  "1h": { buckets: 12, bucketSecs: 5 * 60 },
  "24h": { buckets: 24, bucketSecs: 60 * 60 },
  "7d": { buckets: 28, bucketSecs: 6 * 60 * 60 },
  "30d": { buckets: 30, bucketSecs: 24 * 60 * 60 },
} as const;

interface BucketRow {
  bucket: Date;
  cpu: number | null;
  mem: number | null;
  lim: number | null;
  rx: number | null;
  tx: number | null;
}

/** Time-bucketed averages of a service's samples (only buckets that have data). */
export async function historicalPoints(serviceId: string, period: keyof typeof PERIODS, now = Date.now()) {
  const { buckets, bucketSecs } = PERIODS[period];
  const bucketMs = bucketSecs * 1000;
  const end = Math.ceil(now / bucketMs) * bucketMs;
  const since = new Date(end - buckets * bucketMs);
  const interval = `${bucketSecs} seconds`;
  // TIMESTAMP(3) columns hold UTC wall-clock values: bind a zone-less literal.
  const sinceTs = since.toISOString().replace("Z", "");
  const rows = await db.$queryRaw<BucketRow[]>`
    SELECT bucket, AVG(cpu)::float8 AS cpu, AVG(mem)::float8 AS mem, MAX(lim)::float8 AS lim,
           SUM(rx)::float8 AS rx, SUM(tx)::float8 AS tx
    FROM (
      SELECT date_bin(${interval}::interval, "sampledAt", ${sinceTs}::timestamp) AS bucket, "containerId",
             AVG("cpuPercent") AS cpu, AVG("memoryMb") AS mem, MAX("memoryLimitMb") AS lim,
             MAX("netRxBytes") - MIN("netRxBytes") AS rx, MAX("netTxBytes") - MIN("netTxBytes") AS tx
      FROM "metric_samples"
      WHERE "serviceId" = ${serviceId} AND "sampledAt" >= ${sinceTs}::timestamp
      GROUP BY 1, 2
    ) per_container
    GROUP BY bucket
    ORDER BY bucket`;
  return rows.map((r): TelemetryPoint => {
    const mem = r.mem ?? 0;
    return {
      timestamp: new Date(r.bucket).toISOString(),
      cpuPercent: round1(r.cpu ?? 0),
      memoryUsedMb: round1(mem),
      memoryLimitMb: r.lim,
      memoryPercent: r.lim ? round1((mem / r.lim) * 100) : null,
      networkIngressKb: r.rx === null ? null : round1(r.rx / 1024 / bucketSecs),
      networkEgressKb: r.tx === null ? null : round1(r.tx / 1024 / bucketSecs),
      diskUsedMb: null,
      diskLimitMb: null,
    };
  });
}

/** The two most recent samples of a deployment or service (newest first). */
export async function latestSamples(where: { deploymentId?: string; serviceId?: string }) {
  return db.metricSample.findMany({ where, orderBy: { sampledAt: "desc" }, take: 2 });
}
