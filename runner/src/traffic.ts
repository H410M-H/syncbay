/**
 * Syncbay Runner — HTTP traffic counters for proxied application traffic.
 *
 * Every app request reaches the daemon's reverse proxy (`proxyRequest` in index.ts: the Vercel
 * edge proxy sends `RUNNER_URL` + `x-target-port`, the tunnel ingress points at the daemon). The
 * proxy reports each request here, and `TrafficStats` keeps counters per target port and UTC
 * minute: requests, status classes (2xx/3xx/4xx/5xx, plus `errors` for upstream network
 * failures the proxy answered with 502), request/response body bytes, latency sum/max (time to
 * the upstream's response headers) and a coarse latency histogram (<50, <200, <1000, ≥1000 ms).
 *
 * `POST /api/traffic/drain` (HMAC, single-use nonce, verified by the daemon's
 * `verifySignedRequest()`; POST payload = raw body) returns everything counted since the last
 * drain, attributed to `containerId`/`jobId`/`deploymentId` through the job ↔ port map, and
 * resets the counters. The control plane (`src/lib/telemetry/traffic-sampler.ts`) drains once a
 * minute and writes `TrafficSample` rows. Draining is at-most-once: counters are cleared when the
 * response is produced.
 *
 * This module has no runner imports so the control plane can load it in-process (local driver).
 */

import type * as http from "node:http";

const MINUTE_MS = 60_000;
/** Undrained port×minute buckets kept before the oldest are dropped (counted in `droppedBuckets`). */
const DEFAULT_MAX_BUCKETS = 50_000;

export interface TrafficCounters {
  requests: number;
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  /** Upstream network errors (connection refused/reset): the proxy answered 502 itself. */
  errors: number;
  bytesIn: number;
  bytesOut: number;
  latencySumMs: number;
  latencyMaxMs: number;
  lt50: number;
  lt200: number;
  lt1000: number;
  ge1000: number;
}

export interface TrafficIdentity {
  containerId?: string | null;
  jobId?: string | null;
  deploymentId?: string | null;
  serviceId?: string | null;
}

export interface TrafficEntry extends TrafficCounters {
  port: number;
  /** Start of the UTC minute the traffic was counted in (ISO 8601). */
  bucketStart: string;
  containerId: string | null;
  jobId: string | null;
  deploymentId: string | null;
  serviceId: string | null;
}

export interface TrafficDrain {
  /** Start of the drained window: the previous drain, or when this store was created. */
  since: string;
  drainedAt: string;
  entries: TrafficEntry[];
  /** Buckets evicted because nothing drained them (bounded memory). */
  droppedBuckets: number;
}

export type TrafficIdentityResolver = (port: number) => TrafficIdentity | null | undefined;

/** One in-flight proxied request; each method is safe to call more than once. */
export interface ProxyTrafficTracker {
  /** The upstream answered with `status` (records the request and its latency). */
  response(status: number): void;
  /** Response body bytes streamed back to the client. */
  bytesOut(bytes: number): void;
  /** The upstream could not be reached; recorded as a network error unless a response was recorded. */
  failed(): void;
}

export function emptyCounters(): TrafficCounters {
  return {
    requests: 0,
    s2xx: 0,
    s3xx: 0,
    s4xx: 0,
    s5xx: 0,
    errors: 0,
    bytesIn: 0,
    bytesOut: 0,
    latencySumMs: 0,
    latencyMaxMs: 0,
    lt50: 0,
    lt200: 0,
    lt1000: 0,
    ge1000: 0,
  };
}

type StatusKey = "s2xx" | "s3xx" | "s4xx" | "s5xx" | "errors";

/** Status class counter for a final HTTP status (1xx is counted with 2xx); null = network error. */
export function statusClass(status: number | null): StatusKey {
  if (status === null || !Number.isFinite(status) || status < 100 || status > 599) return "errors";
  if (status < 300) return "s2xx";
  if (status < 400) return "s3xx";
  if (status < 500) return "s4xx";
  return "s5xx";
}

export function latencyBucket(ms: number): "lt50" | "lt200" | "lt1000" | "ge1000" {
  if (ms < 50) return "lt50";
  if (ms < 200) return "lt200";
  if (ms < 1000) return "lt1000";
  return "ge1000";
}

interface Bucket {
  port: number;
  minute: number;
  counters: TrafficCounters;
  identity: TrafficIdentity | null;
}

export class TrafficStats {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private readonly maxBuckets: number;
  private lastDrainAt: number;
  private dropped = 0;

  constructor(options: { now?: () => number; maxBuckets?: number } = {}) {
    this.now = options.now || Date.now;
    this.maxBuckets = Math.max(1, options.maxBuckets ?? DEFAULT_MAX_BUCKETS);
    this.lastDrainAt = this.now();
  }

  /** Number of undrained port×minute buckets. */
  get size(): number {
    return this.buckets.size;
  }

  private bucket(port: number, resolve?: TrafficIdentityResolver): Bucket {
    const minute = Math.floor(this.now() / MINUTE_MS) * MINUTE_MS;
    const key = `${port}:${minute}`;
    let b = this.buckets.get(key);
    if (!b) {
      // Identity at first use: the port may be reassigned before the next drain.
      let identity: TrafficIdentity | null = null;
      try {
        identity = resolve?.(port) || null;
      } catch {
        identity = null;
      }
      b = { port, minute, counters: emptyCounters(), identity };
      this.buckets.set(key, b);
      while (this.buckets.size > this.maxBuckets) {
        const oldest = this.buckets.keys().next().value;
        if (oldest === undefined) break;
        this.buckets.delete(oldest);
        this.dropped += 1;
      }
    }
    return b;
  }

  /** Records one finished (or failed) request. `status: null` = upstream network error. */
  record(
    port: number,
    sample: { status: number | null; latencyMs: number; bytesIn?: number; bytesOut?: number },
    resolve?: TrafficIdentityResolver
  ): void {
    if (!(port > 0)) return;
    const c = this.bucket(port, resolve).counters;
    const latency = Math.max(0, Number.isFinite(sample.latencyMs) ? sample.latencyMs : 0);
    c.requests += 1;
    c[statusClass(sample.status)] += 1;
    c.bytesIn += Math.max(0, sample.bytesIn || 0);
    c.bytesOut += Math.max(0, sample.bytesOut || 0);
    c.latencySumMs += latency;
    if (latency > c.latencyMaxMs) c.latencyMaxMs = latency;
    c[latencyBucket(latency)] += 1;
  }

  /** Adds response bytes to the port's current minute (long responses span minutes). */
  addBytesOut(port: number, bytes: number, resolve?: TrafficIdentityResolver): void {
    if (!(port > 0) || !(bytes > 0)) return;
    this.bucket(port, resolve).counters.bytesOut += bytes;
  }

  /** Starts tracking one proxied request. */
  track(port: number, bytesIn: number, resolve?: TrafficIdentityResolver): ProxyTrafficTracker {
    const started = process.hrtime.bigint();
    let recorded = false;
    const elapsedMs = () => Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100;
    return {
      response: (status: number) => {
        if (recorded) return;
        recorded = true;
        this.record(port, { status, latencyMs: elapsedMs(), bytesIn }, resolve);
      },
      bytesOut: (bytes: number) => this.addBytesOut(port, bytes, resolve),
      failed: () => {
        if (recorded) return;
        recorded = true;
        this.record(port, { status: null, latencyMs: elapsedMs(), bytesIn }, resolve);
      },
    };
  }

  /**
   * Returns every bucket counted since the last drain and clears them. Identity comes from the
   * moment the bucket was opened, else from `resolve` now.
   */
  drain(resolve?: TrafficIdentityResolver): TrafficDrain {
    const drainedAt = this.now();
    const entries: TrafficEntry[] = [];
    for (const b of this.buckets.values()) {
      let id = b.identity;
      if (!id || (!id.containerId && !id.jobId && !id.deploymentId)) {
        try {
          id = resolve?.(b.port) || id;
        } catch {
          // keep what we have
        }
      }
      entries.push({
        port: b.port,
        bucketStart: new Date(b.minute).toISOString(),
        containerId: id?.containerId ?? null,
        jobId: id?.jobId ?? null,
        deploymentId: id?.deploymentId ?? null,
        serviceId: id?.serviceId ?? null,
        ...b.counters,
        latencySumMs: Math.round(b.counters.latencySumMs * 100) / 100,
        latencyMaxMs: Math.round(b.counters.latencyMaxMs * 100) / 100,
      });
    }
    const result: TrafficDrain = {
      since: new Date(this.lastDrainAt).toISOString(),
      drainedAt: new Date(drainedAt).toISOString(),
      entries,
      droppedBuckets: this.dropped,
    };
    this.buckets.clear();
    this.dropped = 0;
    this.lastDrainAt = drainedAt;
    return result;
  }
}

/**
 * Process-wide store, shared by every module instance (the daemon, and the control plane's
 * in-process drain for the local driver), so in-process counters are drained the same way.
 */
export function getDefaultTrafficStats(): TrafficStats {
  const g = globalThis as typeof globalThis & { __syncbay_traffic_stats?: TrafficStats };
  g.__syncbay_traffic_stats ??= new TrafficStats();
  return g.__syncbay_traffic_stats;
}

interface JobLike {
  jobId: string;
  status: string;
  containerId?: string;
  assignedPort?: number;
  deploymentId?: string;
  serviceId?: string;
}

/** Job that currently owns `port` (an ACTIVE job wins over a stopped or failed one). */
export function identityForPort(jobs: Iterable<JobLike>, port: number): TrafficIdentity | null {
  let best: JobLike | null = null;
  for (const job of jobs) {
    if (job.assignedPort !== port) continue;
    if (!best || (job.status === "ACTIVE" && best.status !== "ACTIVE")) best = job;
  }
  if (!best) return null;
  return {
    containerId: best.containerId ?? null,
    jobId: best.jobId,
    deploymentId: best.deploymentId ?? null,
    serviceId: best.serviceId ?? null,
  };
}

type SignatureVerifier = (payload: string, signature: string | undefined, timestamp: string | undefined) => boolean;

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

/**
 * Handles `POST /api/traffic/drain`. Returns true when the request was for this route
 * (whether it succeeded or not).
 */
export function handleTrafficRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  body: string,
  stats: TrafficStats,
  verify: SignatureVerifier,
  resolve?: TrafficIdentityResolver
): boolean {
  if (pathname !== "/api/traffic/drain") return false;
  if ((req.method || "GET").toUpperCase() !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return true;
  }
  const signature = req.headers["x-syncbay-signature"] as string | undefined;
  const timestamp = req.headers["x-syncbay-timestamp"] as string | undefined;
  if (!verify(body, signature, timestamp)) {
    sendJson(res, 401, { error: "Unauthorized: Invalid or missing HMAC signature" });
    return true;
  }
  sendJson(res, 200, stats.drain(resolve));
  return true;
}
