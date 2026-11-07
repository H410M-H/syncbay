/**
 * Syncbay PaaS — per-service HTTP traffic collection.
 *
 * `collectTraffic()` (1-minute cron, next to `sampleActiveServices()`) drains the runner's
 * proxy counters with a signed `POST /api/traffic/drain` (runner/src/traffic.ts) and adds them
 * to one `TrafficSample` row per service, deployment and UTC minute. With the local driver (no
 * `RUNNER_URL`, not serverless) it drains the process-wide in-process store the same way.
 *
 * Attribution never trusts the runner's `serviceId`: an entry is matched to a `Deployment` by
 * `deploymentId`/`jobId`, then by `cfContainerId`, then, only when exactly one ACTIVE
 * deployment has it, by `assignedPort`. Unmatched entries are counted and dropped.
 * The drain is at-most-once (the runner resets on response), so a failed DB write loses that
 * minute's counts rather than double-counting it.
 */

import * as crypto from "node:crypto";
import { db } from "@/lib/db";
import { getRunnerBaseUrl, runnerFetch } from "@/lib/runner-client";
import type { TrafficDrain, TrafficEntry } from "../../../runner/src/traffic";

export interface TrafficCollectReport {
  source: "runner" | "in-process" | "none";
  entries: number;
  written: number;
  unmatched: number;
  requests: number;
  droppedBuckets: number;
  skipped?: string;
}

function isServerless(): boolean {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

async function drainSource(): Promise<{ source: "runner" | "in-process"; drain: TrafficDrain } | { source: "none"; reason: string }> {
  if (getRunnerBaseUrl()) {
    const res = await runnerFetch("/api/traffic/drain", { method: "POST", body: {}, timeoutMs: 10_000 });
    if (res.status === 404) return { source: "none", reason: "runner has no /api/traffic/drain route (update the runner)" };
    if (!res.ok) throw new Error(`Runner traffic drain HTTP ${res.status}`);
    return { source: "runner", drain: (await res.json()) as TrafficDrain };
  }
  const driver = (process.env.RUNNER_DRIVER || "").toLowerCase();
  if (isServerless()) return { source: "none", reason: "no RUNNER_URL: serverless control plane has no runner proxy" };
  if (driver === "ssh" || driver === "mock" || driver === "queue") {
    return { source: "none", reason: `RUNNER_DRIVER=${driver} without RUNNER_URL: the runner proxy is not reachable` };
  }
  // Local driver: counters recorded by a runner proxy running in this process.
  const { getDefaultTrafficStats } = await import("../../../runner/src/traffic");
  return { source: "in-process", drain: getDefaultTrafficStats().drain() };
}

interface Target {
  serviceId: string;
  deploymentId: string;
}

async function attribute(entries: TrafficEntry[]): Promise<Array<Target | null>> {
  const ids = [...new Set(entries.flatMap((e) => [e.deploymentId, e.jobId]).filter((v): v is string => Boolean(v)))];
  const containers = [...new Set(entries.map((e) => e.containerId).filter((v): v is string => Boolean(v)))];
  const or = [
    ...(ids.length ? [{ id: { in: ids } }] : []),
    ...(containers.length ? [{ cfContainerId: { in: containers } }] : []),
  ];
  const deps = or.length
    ? await db.deployment.findMany({
        where: { OR: or },
        select: { id: true, serviceId: true, cfContainerId: true },
        orderBy: { createdAt: "desc" },
      })
    : [];
  const byId = new Map(deps.map((d) => [d.id, d]));
  const byContainer = new Map<string, (typeof deps)[number]>();
  for (const d of deps) if (d.cfContainerId && !byContainer.has(d.cfContainerId)) byContainer.set(d.cfContainerId, d);

  const direct = entries.map((e) => {
    const d =
      (e.deploymentId && byId.get(e.deploymentId)) ||
      (e.jobId && byId.get(e.jobId)) ||
      (e.containerId && byContainer.get(e.containerId)) ||
      null;
    return d ? { serviceId: d.serviceId, deploymentId: d.id } : null;
  });

  const ports = [...new Set(entries.filter((_, i) => !direct[i]).map((e) => e.port))];
  if (ports.length === 0) return direct;
  const live = await db.deployment.findMany({
    where: { status: "ACTIVE", assignedPort: { in: ports }, service: { deletedAt: null } },
    select: { id: true, serviceId: true, assignedPort: true },
  });
  const byPort = new Map<number, Target | null>();
  for (const d of live) {
    const port = d.assignedPort!;
    byPort.set(port, byPort.has(port) ? null : { serviceId: d.serviceId, deploymentId: d.id }); // ambiguous → none
  }
  return entries.map((e, i) => direct[i] || byPort.get(e.port) || null);
}

type Row = Target & Omit<TrafficEntry, "port" | "containerId" | "jobId" | "deploymentId" | "serviceId">;

/** Sums entries per (service, deployment, minute). */
function aggregate(entries: TrafficEntry[], targets: Array<Target | null>): Row[] {
  const rows = new Map<string, Row>();
  entries.forEach((e, i) => {
    const t = targets[i];
    if (!t) return;
    const key = `${t.serviceId}|${t.deploymentId}|${e.bucketStart}`;
    const r = rows.get(key);
    if (!r) {
      rows.set(key, {
        ...t,
        bucketStart: e.bucketStart,
        requests: e.requests,
        s2xx: e.s2xx,
        s3xx: e.s3xx,
        s4xx: e.s4xx,
        s5xx: e.s5xx,
        errors: e.errors,
        bytesIn: e.bytesIn,
        bytesOut: e.bytesOut,
        latencySumMs: e.latencySumMs,
        latencyMaxMs: e.latencyMaxMs,
        lt50: e.lt50,
        lt200: e.lt200,
        lt1000: e.lt1000,
        ge1000: e.ge1000,
      });
      return;
    }
    for (const k of ["requests", "s2xx", "s3xx", "s4xx", "s5xx", "errors", "bytesIn", "bytesOut", "latencySumMs", "lt50", "lt200", "lt1000", "ge1000"] as const) {
      r[k] += e[k];
    }
    r.latencyMaxMs = Math.max(r.latencyMaxMs, e.latencyMaxMs);
  });
  return [...rows.values()];
}

const int = (n: unknown) => Math.max(0, Math.round(Number(n) || 0));
const num = (n: unknown) => Math.max(0, Number(n) || 0);

/** Adds a row's counters to its minute (creates the row the first time). */
async function upsertRow(r: Row): Promise<void> {
  const minute = new Date(Math.floor(Date.parse(r.bucketStart) / 60_000) * 60_000);
  // TIMESTAMP(3) columns hold UTC wall-clock values: bind a zone-less literal.
  const bucketTs = minute.toISOString().replace("Z", "");
  await db.$executeRaw`
    INSERT INTO "traffic_samples" ("id", "serviceId", "deploymentId", "bucketStart", "requests", "s2xx", "s3xx", "s4xx", "s5xx",
      "errors", "bytesIn", "bytesOut", "latencySumMs", "latencyMaxMs", "lt50", "lt200", "lt1000", "ge1000", "createdAt", "updatedAt")
    VALUES (${`ts_${crypto.randomUUID()}`}, ${r.serviceId}, ${r.deploymentId}, ${bucketTs}::timestamp, ${int(r.requests)}, ${int(r.s2xx)},
      ${int(r.s3xx)}, ${int(r.s4xx)}, ${int(r.s5xx)}, ${int(r.errors)}, ${BigInt(int(r.bytesIn))}, ${BigInt(int(r.bytesOut))},
      ${num(r.latencySumMs)}, ${num(r.latencyMaxMs)}, ${int(r.lt50)}, ${int(r.lt200)}, ${int(r.lt1000)}, ${int(r.ge1000)},
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("serviceId", "deploymentId", "bucketStart") DO UPDATE SET
      "requests" = "traffic_samples"."requests" + EXCLUDED."requests",
      "s2xx" = "traffic_samples"."s2xx" + EXCLUDED."s2xx",
      "s3xx" = "traffic_samples"."s3xx" + EXCLUDED."s3xx",
      "s4xx" = "traffic_samples"."s4xx" + EXCLUDED."s4xx",
      "s5xx" = "traffic_samples"."s5xx" + EXCLUDED."s5xx",
      "errors" = "traffic_samples"."errors" + EXCLUDED."errors",
      "bytesIn" = "traffic_samples"."bytesIn" + EXCLUDED."bytesIn",
      "bytesOut" = "traffic_samples"."bytesOut" + EXCLUDED."bytesOut",
      "latencySumMs" = "traffic_samples"."latencySumMs" + EXCLUDED."latencySumMs",
      "latencyMaxMs" = GREATEST("traffic_samples"."latencyMaxMs", EXCLUDED."latencyMaxMs"),
      "lt50" = "traffic_samples"."lt50" + EXCLUDED."lt50",
      "lt200" = "traffic_samples"."lt200" + EXCLUDED."lt200",
      "lt1000" = "traffic_samples"."lt1000" + EXCLUDED."lt1000",
      "ge1000" = "traffic_samples"."ge1000" + EXCLUDED."ge1000",
      "updatedAt" = CURRENT_TIMESTAMP`;
}

/** Drains the runner's traffic counters into `TrafficSample`. */
export async function collectTraffic(): Promise<TrafficCollectReport> {
  const drained = await drainSource();
  if (drained.source === "none") {
    return { source: "none", entries: 0, written: 0, unmatched: 0, requests: 0, droppedBuckets: 0, skipped: drained.reason };
  }
  const entries = Array.isArray(drained.drain.entries) ? drained.drain.entries : [];
  const report: TrafficCollectReport = {
    source: drained.source,
    entries: entries.length,
    written: 0,
    unmatched: 0,
    requests: 0,
    droppedBuckets: int(drained.drain.droppedBuckets),
  };
  if (entries.length === 0) return report;

  const targets = await attribute(entries);
  report.unmatched = targets.filter((t) => !t).length;
  for (const row of aggregate(entries, targets)) {
    await upsertRow(row);
    report.written += 1;
    report.requests += int(row.requests);
  }
  return report;
}

/** Retention: drops traffic buckets older than `days`. */
export async function purgeOldTraffic(days: number): Promise<number> {
  if (!(days > 0)) return 0;
  const res = await db.trafficSample.deleteMany({ where: { bucketStart: { lt: new Date(Date.now() - days * 86_400_000) } } });
  return res.count;
}
