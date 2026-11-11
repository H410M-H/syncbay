/**
 * Syncbay PaaS — Cron runner
 *
 * `runDueCronJobs(now)` claims every enabled `CronJob` whose `nextRunAt` has
 * passed, calls the service over real HTTP (per-attempt timeout, retries with
 * exponential backoff on network errors / timeouts / 5xx / 429) and records a
 * `CronRun`. Claiming advances `nextRunAt` and sets a `lockedUntil` lease in a
 * single conditional update, so overlapping invocations (several cron ticks,
 * several instances) never execute the same occurrence twice.
 *
 * The target is the service's own upstream: the edge registry route for its
 * default hostname (direct when local, via `RUNNER_URL` + `x-target-port`
 * otherwise), falling back to the public `https://<svc>-<env>.syncbay.app`.
 */

import { db as defaultDb } from "@/lib/db";
import { primaryServiceHostname } from "@/lib/domains/service-hosts";
import { resolveServiceRoute } from "@/lib/edge/service-registry";
import {
  assertValidCronPath,
  calculateNextRun,
  toCronRunLog,
  type CronDb,
  type CronRunLog,
  type CronRunStatus,
} from "./cron-engine";
import type { PrismaClient } from "@prisma/client";

type RunnerDb = CronDb & Pick<PrismaClient, "service">;

export interface CronTarget {
  url: string;
  headers?: Record<string, string>;
}

export interface CronRunnerOptions {
  db?: RunnerDb;
  fetchImpl?: typeof fetch;
  /** Overrides target resolution (tests, custom routing). */
  resolveTarget?: (job: { id: string; serviceId: string; path: string }) => Promise<CronTarget | null>;
  /** Max jobs executed in parallel by one invocation (default 5). */
  concurrency?: number;
  /** Max jobs claimed by one invocation (default 50). */
  batchSize?: number;
  /** Base backoff between attempts in ms (default 500, doubled per retry, capped at 4 s). */
  retryBaseMs?: number;
}

export interface CronExecutionResult extends CronRunLog {
  jobId: string;
}

export interface RunDueSummary {
  checkedAt: string;
  due: number;
  claimed: number;
  succeeded: number;
  failed: number;
  results: CronExecutionResult[];
}

const SNIPPET_LIMIT = 500;
const USER_AGENT = "Syncbay-Cron/1.1";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves the base URL a service's cron requests are sent to. */
async function defaultResolveTarget(db: RunnerDb, job: { serviceId: string; path: string }): Promise<CronTarget | null> {
  const service = await db.service.findUnique({
    where: { id: job.serviceId },
    include: { environment: true, domains: { select: { hostname: true, isGenerated: true } } },
  });
  if (!service || service.deletedAt) return null;

  const host = primaryServiceHostname(service);
  const route = await resolveServiceRoute(host);
  if (route && route.status === "ACTIVE") {
    const runnerUrl = process.env.RUNNER_URL;
    const upstream = route.upstreamUrl || (route.targetPort ? `http://127.0.0.1:${route.targetPort}` : "");
    const viaRunner = Boolean(runnerUrl && !route.isLocal && /127\.0\.0\.1|localhost/.test(upstream));
    if (viaRunner) {
      const port = route.targetPort || Number(upstream.match(/:(\d+)/)?.[1] || 0);
      return {
        url: new URL(job.path, runnerUrl!.replace(/\/$/, "") + "/").toString(),
        headers: port ? { "x-target-port": String(port), "x-forwarded-host": host } : { "x-forwarded-host": host },
      };
    }
    if (upstream) return { url: new URL(job.path, upstream.replace(/\/$/, "") + "/").toString() };
  }
  return { url: `https://${host}${job.path}` };
}

function isRetryable(status: number | null): boolean {
  return status === null || status === 429 || status >= 500;
}

interface AttemptOutcome {
  status: CronRunStatus;
  statusCode: number | null;
  snippet?: string;
  error?: string;
}

async function attemptRequest(
  fetchImpl: typeof fetch,
  target: CronTarget,
  job: { id: string; method: string; headers: unknown; body: string | null; timeoutMs: number }
): Promise<AttemptOutcome> {
  const userHeaders =
    job.headers && typeof job.headers === "object" && !Array.isArray(job.headers)
      ? (job.headers as Record<string, string>)
      : {};
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    ...userHeaders,
    ...(target.headers || {}),
    "x-syncbay-cron-job": job.id,
  };
  const method = job.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD" && job.body != null;
  if (hasBody && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
    headers["Content-Type"] = "application/json";
  }

  try {
    const res = await fetchImpl(target.url, {
      method,
      headers,
      body: hasBody ? job.body! : undefined,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(job.timeoutMs),
    });
    let text = "";
    try {
      text = (await res.text()).slice(0, SNIPPET_LIMIT);
    } catch {
      // body read errors don't change the outcome
    }
    const ok = res.status >= 200 && res.status < 400;
    return {
      status: ok ? "SUCCESS" : "FAILED",
      statusCode: res.status,
      snippet: text || undefined,
      error: ok ? undefined : `HTTP ${res.status}`,
    };
  } catch (err: any) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return {
      status: timedOut ? "TIMEOUT" : "FAILED",
      statusCode: null,
      error: timedOut ? `Timed out after ${job.timeoutMs} ms` : String(err?.cause?.message || err?.message || err),
    };
  }
}

/**
 * Executes one cron job now (HTTP with retries) and records the run.
 * Does not touch `nextRunAt` — scheduled claims advance it in `runDueCronJobs`.
 */
export async function executeCronJob(
  cronId: string,
  options: CronRunnerOptions & { trigger?: "schedule" | "manual" } = {}
): Promise<CronExecutionResult> {
  const db = options.db || (defaultDb as unknown as RunnerDb);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const job = await db.cronJob.findUnique({ where: { id: cronId } });
  if (!job) throw new Error(`Cron job not found: ${cronId}`);
  assertValidCronPath(job.path);

  const startedAt = Date.now();
  const target = options.resolveTarget
    ? await options.resolveTarget(job)
    : await defaultResolveTarget(db, job);

  let outcome: AttemptOutcome;
  let attempts = 0;
  if (!target) {
    outcome = { status: "FAILED", statusCode: null, error: "Service not found or deleted" };
  } else {
    const base = options.retryBaseMs ?? 500;
    for (;;) {
      attempts++;
      outcome = await attemptRequest(fetchImpl, target, job);
      if (outcome.status === "SUCCESS" || !isRetryable(outcome.statusCode) || attempts > job.maxRetries) break;
      await sleep(Math.min(base * 2 ** (attempts - 1), 4_000));
    }
  }

  const durationMs = Date.now() - startedAt;
  const run = await db.cronRun.create({
    data: {
      cronJobId: job.id,
      trigger: options.trigger || "manual",
      status: outcome.status,
      statusCode: outcome.statusCode,
      durationMs,
      attempts: Math.max(attempts, 1),
      url: target?.url || "",
      responseSnippet: outcome.snippet ?? null,
      error: outcome.error ?? null,
    },
  });
  await db.cronJob.update({
    where: { id: job.id },
    data: {
      lastRunAt: run.executedAt,
      lastStatus: outcome.status,
      lastDurationMs: durationMs,
      lockedUntil: null,
    },
  });

  return { ...toCronRunLog(run), jobId: job.id };
}

/**
 * Claims and executes all due cron jobs. Intended to be called once a minute
 * (the platform cron route). Safe to call concurrently.
 */
export async function runDueCronJobs(now: Date = new Date(), options: CronRunnerOptions = {}): Promise<RunDueSummary> {
  const db = options.db || (defaultDb as unknown as RunnerDb);
  const due = await db.cronJob.findMany({
    where: {
      enabled: true,
      nextRunAt: { lte: now },
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      service: { deletedAt: null },
    },
    orderBy: { nextRunAt: "asc" },
    take: options.batchSize ?? 50,
  });

  const claimed: string[] = [];
  for (const job of due) {
    let nextRunAt: Date;
    try {
      nextRunAt = calculateNextRun(job.schedule, now);
    } catch {
      // Unparseable schedule (edited outside the API): disable rather than spin.
      await db.cronJob.update({ where: { id: job.id }, data: { enabled: false } });
      continue;
    }
    const leaseMs = job.timeoutMs * (job.maxRetries + 1) + 30_000;
    const result = await db.cronJob.updateMany({
      where: {
        id: job.id,
        nextRunAt: job.nextRunAt,
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
      data: { nextRunAt, lockedUntil: new Date(now.getTime() + leaseMs) },
    });
    if (result.count === 1) claimed.push(job.id);
  }

  const results: CronExecutionResult[] = [];
  const concurrency = Math.max(1, options.concurrency ?? 5);
  let cursor = 0;
  const worker = async () => {
    while (cursor < claimed.length) {
      const id = claimed[cursor++];
      try {
        results.push(await executeCronJob(id, { ...options, db, trigger: "schedule" }));
      } catch (err: any) {
        await db.cronJob.update({ where: { id }, data: { lockedUntil: null } }).catch(() => null);
        results.push({
          id: "",
          jobId: id,
          cronId: id,
          executedAt: new Date().toISOString(),
          trigger: "schedule",
          status: "FAILED",
          durationMs: 0,
          statusCode: null,
          attempts: 0,
          url: "",
          error: err?.message || String(err),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, claimed.length) }, worker));

  return {
    checkedAt: now.toISOString(),
    due: due.length,
    claimed: claimed.length,
    succeeded: results.filter((r) => r.status === "SUCCESS").length,
    failed: results.filter((r) => r.status !== "SUCCESS").length,
    results,
  };
}
