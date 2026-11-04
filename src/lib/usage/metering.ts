/**
 * Syncbay PaaS — Usage metering and spending-cap enforcement.
 *
 * `writeUsageRecords()` (15-minute cron) turns `MetricSample`s into one
 * `UsageRecord` per service, resource and completed hour (idempotent upsert):
 * - CPU_ACTIVE_SECONDS: vCPU-seconds used (Σ cpu% / 100 × sample interval).
 * - MEMORY_GIB_HOURS:   Σ memory GiB × sample interval / 3600.
 * - EGRESS_GB:          outbound bytes (docker NetIO deltas; native processes have no counter).
 * `enforceSpendingCaps()` compares month-to-date cost with `Workspace.spendingCapCents`:
 * at 80 % it sends the usage-warning email, at 100 % it pauses every running
 * service and sends the billing-alert email (each once per calendar month).
 */

import type { UsageResourceType } from "@prisma/client";
import { db } from "@/lib/db";
import { EmailService } from "@/lib/email/service";
import { SAMPLE_INTERVAL_SECS } from "@/lib/telemetry/metrics-sampler";
import { stopServiceToSleep } from "@/lib/scale/service-control";
import { estimateCostCents } from "@/lib/billing/pricing"; // single rate card shared with invoicing

const HOUR_MS = 3_600_000;
export const USAGE_WARNING_RATIO = 0.8;

export type UsageTotals = Record<UsageResourceType, number>;

export function emptyTotals(): UsageTotals {
  return {
    CPU_ACTIVE_SECONDS: 0,
    MEMORY_GIB_HOURS: 0,
    DISK_GB_HOURS: 0,
    EGRESS_GB: 0,
    DB_STORAGE_GB: 0,
    BUCKET_STORAGE_GB: 0,
  };
}

/** First instant of the UTC calendar month containing `at`. */
export function billingPeriodStart(at = new Date()): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

function sameBillingPeriod(a: Date | null | undefined, now: Date): boolean {
  return Boolean(a) && billingPeriodStart(a!).getTime() === billingPeriodStart(now).getTime();
}

/** Month-to-date totals and cost for a workspace. */
export async function workspaceUsageTotals(workspaceId: string, now = new Date()) {
  const periodStart = billingPeriodStart(now);
  const grouped = await db.usageRecord.groupBy({
    by: ["resourceType"],
    where: { workspaceId, periodStart: { gte: periodStart } },
    _sum: { quantity: true },
  });
  const totals = emptyTotals();
  for (const g of grouped) totals[g.resourceType] = g._sum.quantity ?? 0;
  return { periodStart, totals, estimatedCostCents: estimateCostCents(totals) };
}

interface HourAggregate {
  serviceId: string;
  hour: Date;
  cpu_seconds: number | null;
  mem_gib_hours: number | null;
  egress_gb: number | null;
}

export interface UsageWriteReport {
  hours: number;
  records: number;
  services: number;
}

/**
 * Upserts usage for every completed hour in the last `lookbackHours`. Re-running
 * recomputes the same rows, so missed or repeated cron runs are harmless.
 */
export async function writeUsageRecords(options: { now?: Date; lookbackHours?: number } = {}): Promise<UsageWriteReport> {
  const now = options.now ?? new Date();
  const to = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  const lookback = Math.max(1, options.lookbackHours ?? 3);
  const from = new Date(to.getTime() - lookback * HOUR_MS);
  // Include a few minutes before `from` so the first egress delta has a predecessor.
  const lead = new Date(from.getTime() - 10 * 60_000);
  const ts = (d: Date) => d.toISOString().replace("Z", "");

  const rows = await db.$queryRaw<HourAggregate[]>`
    WITH s AS (
      SELECT "serviceId", "sampledAt", "cpuPercent", "memoryMb", "netTxBytes",
             "netTxBytes" - LAG("netTxBytes") OVER (PARTITION BY "containerId" ORDER BY "sampledAt") AS dtx
      FROM "metric_samples"
      WHERE "sampledAt" >= ${ts(lead)}::timestamp AND "sampledAt" < ${ts(to)}::timestamp
    )
    SELECT "serviceId", date_trunc('hour', "sampledAt") AS hour,
           (SUM("cpuPercent") / 100.0 * ${SAMPLE_INTERVAL_SECS})::float8 AS cpu_seconds,
           (SUM("memoryMb") / 1024.0 * ${SAMPLE_INTERVAL_SECS} / 3600.0)::float8 AS mem_gib_hours,
           (SUM(CASE WHEN dtx > 0 THEN dtx WHEN dtx < 0 THEN "netTxBytes" ELSE 0 END) / 1e9)::float8 AS egress_gb
    FROM s
    WHERE "sampledAt" >= ${ts(from)}::timestamp
    GROUP BY 1, 2
    ORDER BY 2`;

  const report: UsageWriteReport = { hours: lookback, records: 0, services: 0 };
  if (rows.length === 0) return report;

  const serviceIds = [...new Set(rows.map((r) => r.serviceId))];
  const services = await db.service.findMany({
    where: { id: { in: serviceIds } },
    select: { id: true, environment: { select: { project: { select: { workspaceId: true } } } } },
  });
  const workspaceOf = new Map(services.map((s) => [s.id, s.environment?.project?.workspaceId]));
  report.services = services.length;

  for (const row of rows) {
    const workspaceId = workspaceOf.get(row.serviceId);
    if (!workspaceId) continue;
    const periodStart = new Date(row.hour);
    const periodEnd = new Date(periodStart.getTime() + HOUR_MS);
    const quantities: Array<[UsageResourceType, number]> = [
      ["CPU_ACTIVE_SECONDS", row.cpu_seconds ?? 0],
      ["MEMORY_GIB_HOURS", row.mem_gib_hours ?? 0],
      ["EGRESS_GB", row.egress_gb ?? 0],
    ];
    for (const [resourceType, quantity] of quantities) {
      await db.usageRecord.upsert({
        where: { serviceId_resourceType_periodStart: { serviceId: row.serviceId, resourceType, periodStart } },
        create: { serviceId: row.serviceId, workspaceId, resourceType, quantity, periodStart, periodEnd },
        update: { quantity, periodEnd },
      });
      report.records += 1;
    }
  }
  return report;
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function appUrl(): string {
  return (process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || "https://syncbay.app").replace(/\/$/, "");
}

export interface SpendCapReport {
  workspaceId: string;
  costCents: number;
  capCents: number;
  warned: boolean;
  capReached: boolean;
  alerted: boolean;
  paused: string[];
}

/** Applies the 80 % warning and the 100 % pause to every workspace with a cap. */
export async function enforceSpendingCaps(options: { now?: Date } = {}): Promise<SpendCapReport[]> {
  const now = options.now ?? new Date();
  const workspaces = await db.workspace.findMany({
    where: { spendingCapCents: { not: null } },
    include: {
      members: { where: { role: { in: ["OWNER", "ADMIN"] } }, include: { user: { select: { email: true } } } },
    },
  });

  const reports: SpendCapReport[] = [];
  for (const ws of workspaces) {
    const capCents = ws.spendingCapCents ?? 0;
    const { estimatedCostCents } = await workspaceUsageTotals(ws.id, now);
    const recipients = ws.members.map((m) => m.user?.email).filter((e): e is string => Boolean(e));
    const report: SpendCapReport = {
      workspaceId: ws.id,
      costCents: estimatedCostCents,
      capCents,
      warned: false,
      // A $0 cap allows no paid usage at all.
      capReached: capCents > 0 ? estimatedCostCents >= capCents : estimatedCostCents > 0,
      alerted: false,
      paused: [],
    };

    if (report.capReached) {
      const services = await db.service.findMany({
        where: { deletedAt: null, isPaused: false, environment: { project: { workspaceId: ws.id } } },
        include: {
          domains: { select: { hostname: true } },
          environment: { select: { name: true, isPrEnv: true, prNumber: true } },
          deployments: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      });
      for (const svc of services) {
        const latest = svc.deployments[0];
        if (latest) {
          await stopServiceToSleep(svc, latest, {
            reason: `Workspace spending cap ${dollars(capCents)} reached (month to date ${dollars(estimatedCostCents)}); pausing service`,
            pause: true,
          });
        } else {
          await db.service.update({ where: { id: svc.id }, data: { isPaused: true } });
        }
        report.paused.push(svc.id);
      }
      if (!sameBillingPeriod(ws.spendCapReachedAt, now)) {
        if (recipients.length) {
          await EmailService.sendBillingAlert({
            to: recipients,
            amount: dollars(estimatedCostCents),
            invoiceUrl: `${appUrl()}/dashboard/usage`,
            description: `Spending cap of ${dollars(capCents)} reached for ${ws.name}. ${report.paused.length} service(s) were paused; raise the cap to resume them.`,
            date: now.toISOString().slice(0, 10),
          });
          report.alerted = true;
        }
        await db.workspace.update({ where: { id: ws.id }, data: { spendCapReachedAt: now } });
      }
    } else {
      if (ws.spendCapReachedAt && sameBillingPeriod(ws.spendCapReachedAt, now)) {
        // The cap was raised above the current spend: allow waking again.
        await db.workspace.update({ where: { id: ws.id }, data: { spendCapReachedAt: null } });
      }
      if (capCents > 0 && estimatedCostCents >= capCents * USAGE_WARNING_RATIO && !sameBillingPeriod(ws.usageWarnedAt, now)) {
        if (recipients.length) {
          await EmailService.sendUsageWarning({
            to: recipients,
            percentage: Math.floor((estimatedCostCents / capCents) * 100),
            metricName: "Monthly spend",
            limit: dollars(capCents),
            currentUsage: dollars(estimatedCostCents),
            upgradeUrl: `${appUrl()}/dashboard/usage`,
          });
          report.warned = true;
        }
        await db.workspace.update({ where: { id: ws.id }, data: { usageWarnedAt: now } });
      }
    }
    reports.push(report);
  }
  return reports;
}

/** True while the workspace is over its cap this month (wake is refused). */
export async function isWorkspaceOverSpendingCap(workspaceId: string, now = new Date()): Promise<boolean> {
  const ws = await db.workspace
    .findUnique({ where: { id: workspaceId }, select: { spendingCapCents: true, spendCapReachedAt: true } })
    .catch(() => null);
  return Boolean(ws && ws.spendingCapCents !== null && sameBillingPeriod(ws.spendCapReachedAt, now));
}
