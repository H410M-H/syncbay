/**
 * Syncbay PaaS — Scheduled HTTP Cron Jobs (DB-backed)
 *
 * Jobs and their run history live in Postgres (`CronJob` / `CronRun`). This
 * module holds the cron expression parser and the CRUD helpers used by the
 * devops router; `cron-runner.ts` executes due jobs as real HTTP calls.
 * Schedules are standard 5-field expressions evaluated in UTC.
 */

import type { PrismaClient } from "@prisma/client";

export type CronRunStatus = "SUCCESS" | "FAILED" | "TIMEOUT";
export type CronMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** API shape of a cron job (dates as ISO strings). */
export interface CronJob {
  id: string;
  serviceId: string;
  name: string;
  schedule: string;
  path: string;
  method: CronMethod;
  headers?: Record<string, string>;
  timeoutMs: number;
  maxRetries: number;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastStatus?: CronRunStatus;
  lastDurationMs?: number;
  nextRunAt: string;
}

/** API shape of one recorded execution. */
export interface CronRunLog {
  id: string;
  cronId: string;
  executedAt: string;
  trigger: string;
  status: CronRunStatus;
  durationMs: number;
  statusCode: number | null;
  attempts: number;
  url: string;
  responseSnippet?: string;
  error?: string;
}

export type CronDb = Pick<PrismaClient, "cronJob" | "cronRun">;

// ─── Cron expression parsing ──────────────────────────────────────────────────

const FIELD_BOUNDS: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 are Sunday)
];

/** Expands one cron field into its allowed values, or null when malformed. */
function parseField(field: string, min: number, max: number): Set<number> | null {
  if (!field) return null;
  const values = new Set<number>();
  for (const segment of field.split(",")) {
    if (!segment) return null;
    const [rangePart, stepPart, extra] = segment.split("/");
    if (extra !== undefined) return null;
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) return null;
      step = parseInt(stepPart, 10);
      if (step <= 0 || step > max) return null;
    }
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (/^\d+-\d+$/.test(rangePart)) {
      const [a, b] = rangePart.split("-").map((n) => parseInt(n, 10));
      if (a < min || b > max || a > b) return null;
      start = a;
      end = b;
    } else if (/^\d+$/.test(rangePart)) {
      const n = parseInt(rangePart, 10);
      if (n < min || n > max) return null;
      start = n;
      // "5/15" means "from 5 every 15"
      end = stepPart !== undefined ? max : n;
    } else {
      return null;
    }
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values;
}

interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseCron(expression: string): ParsedCron | null {
  if (!expression || typeof expression !== "string") return null;
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = parts.map((p, i) => parseField(p, FIELD_BOUNDS[i][0], FIELD_BOUNDS[i][1]));
  if (sets.some((s) => s === null)) return null;
  const [minutes, hours, daysOfMonth, months, dow] = sets as Set<number>[];
  const daysOfWeek = new Set(Array.from(dow).map((d) => (d === 7 ? 0 : d)));
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
}

/**
 * Validates a standard 5-field cron expression:
 * minute (0-59), hour (0-23), day of month (1-31), month (1-12), day of week (0-7).
 * Supports `*`, lists, ranges and steps (`*\/5`, `1-10/2`, `5/15`).
 */
export function isValidCronExpression(expression: string): boolean {
  return parseCron(expression) !== null;
}

function dayMatches(cron: ParsedCron, date: Date): boolean {
  const domOk = cron.daysOfMonth.has(date.getUTCDate());
  const dowOk = cron.daysOfWeek.has(date.getUTCDay());
  // POSIX semantics: when both day fields are restricted, either may match.
  if (cron.domRestricted && cron.dowRestricted) return domOk || dowOk;
  if (cron.domRestricted) return domOk;
  if (cron.dowRestricted) return dowOk;
  return true;
}

/**
 * Returns the first minute strictly after `fromDate` that matches the expression (UTC).
 */
export function calculateNextRun(expression: string, fromDate: Date = new Date()): Date {
  const cron = parseCron(expression);
  if (!cron) throw new Error(`Invalid cron expression: "${expression}"`);

  const next = new Date(fromDate.getTime());
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(next.getUTCMinutes() + 1);

  // Bounded search (5 years covers every satisfiable expression, e.g. Feb 29).
  const limit = fromDate.getTime() + 5 * 366 * 24 * 60 * 60 * 1000;
  while (next.getTime() <= limit) {
    if (!cron.months.has(next.getUTCMonth() + 1)) {
      next.setUTCMonth(next.getUTCMonth() + 1, 1);
      next.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(cron, next)) {
      next.setUTCDate(next.getUTCDate() + 1);
      next.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!cron.hours.has(next.getUTCHours())) {
      next.setUTCHours(next.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!cron.minutes.has(next.getUTCMinutes())) {
      next.setUTCMinutes(next.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return next;
  }
  throw new Error(`Cron expression "${expression}" never matches`);
}

// ─── Validation ───────────────────────────────────────────────────────────────

/** A cron path is relative to the service origin; protocol-relative paths are rejected. */
export function assertValidCronPath(path: string): void {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new Error(`Cron path must start with a single leading slash, e.g. "/api/cron/tasks"`);
  }
}

// ─── Mapping ──────────────────────────────────────────────────────────────────

type CronJobRow = Awaited<ReturnType<CronDb["cronJob"]["findUniqueOrThrow"]>>;
type CronRunRow = Awaited<ReturnType<CronDb["cronRun"]["findUniqueOrThrow"]>>;

export function toCronJob(row: CronJobRow): CronJob {
  const headers =
    row.headers && typeof row.headers === "object" && !Array.isArray(row.headers)
      ? (row.headers as Record<string, string>)
      : undefined;
  return {
    id: row.id,
    serviceId: row.serviceId,
    name: row.name,
    schedule: row.schedule,
    path: row.path,
    method: row.method as CronMethod,
    headers,
    timeoutMs: row.timeoutMs,
    maxRetries: row.maxRetries,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    lastRunAt: row.lastRunAt?.toISOString(),
    lastStatus: (row.lastStatus as CronRunStatus | null) ?? undefined,
    lastDurationMs: row.lastDurationMs ?? undefined,
    nextRunAt: row.nextRunAt.toISOString(),
  };
}

export function toCronRunLog(row: CronRunRow): CronRunLog {
  return {
    id: row.id,
    cronId: row.cronJobId,
    executedAt: row.executedAt.toISOString(),
    trigger: row.trigger,
    status: row.status as CronRunStatus,
    durationMs: row.durationMs,
    statusCode: row.statusCode,
    attempts: row.attempts,
    url: row.url,
    responseSnippet: row.responseSnippet ?? undefined,
    error: row.error ?? undefined,
  };
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function listCronJobs(db: CronDb, serviceId: string): Promise<CronJob[]> {
  const rows = await db.cronJob.findMany({ where: { serviceId }, orderBy: { createdAt: "asc" } });
  return rows.map(toCronJob);
}

export async function getCronJob(db: CronDb, cronId: string): Promise<CronJob | null> {
  const row = await db.cronJob.findUnique({ where: { id: cronId } });
  return row ? toCronJob(row) : null;
}

export async function createCronJob(
  db: CronDb,
  params: {
    serviceId: string;
    name: string;
    schedule: string;
    path: string;
    method?: CronMethod;
    headers?: Record<string, string>;
    timeoutMs?: number;
    maxRetries?: number;
  },
  now: Date = new Date()
): Promise<CronJob> {
  const schedule = params.schedule.trim();
  if (!isValidCronExpression(schedule)) {
    throw new Error(`Invalid cron schedule: "${params.schedule}". Expected 5 fields e.g. "*/10 * * * *" or "0 0 * * *"`);
  }
  const path = params.path.trim();
  assertValidCronPath(path);

  const row = await db.cronJob.create({
    data: {
      serviceId: params.serviceId,
      name: params.name.trim(),
      schedule,
      path,
      method: params.method || "GET",
      headers: params.headers ?? undefined,
      timeoutMs: Math.min(Math.max(params.timeoutMs ?? 10_000, 1_000), 60_000),
      maxRetries: Math.min(Math.max(params.maxRetries ?? 2, 0), 5),
      nextRunAt: calculateNextRun(schedule, now),
    },
  });
  return toCronJob(row);
}

export async function toggleCronJob(db: CronDb, cronId: string, enabled: boolean, now: Date = new Date()): Promise<CronJob> {
  const existing = await db.cronJob.findUnique({ where: { id: cronId } });
  if (!existing) throw new Error(`Cron job not found: ${cronId}`);
  const row = await db.cronJob.update({
    where: { id: cronId },
    // Re-enabling never fires the runs missed while disabled.
    data: enabled ? { enabled, nextRunAt: calculateNextRun(existing.schedule, now) } : { enabled },
  });
  return toCronJob(row);
}

export async function deleteCronJob(db: CronDb, cronId: string): Promise<boolean> {
  const result = await db.cronJob.deleteMany({ where: { id: cronId } });
  return result.count > 0;
}

export async function listCronRuns(db: CronDb, cronId: string, limit = 20): Promise<CronRunLog[]> {
  const rows = await db.cronRun.findMany({
    where: { cronJobId: cronId },
    orderBy: { executedAt: "desc" },
    take: Math.min(Math.max(limit, 1), 100),
  });
  return rows.map(toCronRunLog);
}
