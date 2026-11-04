import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/crons/cron-auth";
import { sleepIdleServices } from "@/lib/scale/idle-sleeper";
import { enforceSpendingCaps, writeUsageRecords } from "@/lib/usage/metering";
import { purgeOldLogs } from "@/lib/telemetry/log-store";
import { purgeOldSamples } from "@/lib/telemetry/metrics-sampler";
import { runMonthlyInvoicingIfDue } from "@/lib/billing/invoicing";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const LOG_RETENTION_DAYS = 30;
const METRIC_RETENTION_DAYS = 35;

async function step<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (err) {
    return { error: (err as Error)?.message || String(err) };
  }
}

/** Every 15 minutes (vercel.json): idle sleep, hourly usage records, spending caps, monthly invoices, retention. */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const idle = await step(() => sleepIdleServices());
  const usage = await step(() => writeUsageRecords());
  const spendingCaps = await step(() => enforceSpendingCaps());
  const invoicing = await step(() => runMonthlyInvoicingIfDue()); // Team D: previous month, on day 1 (UTC)
  const retention = await step(async () => ({
    logs: await purgeOldLogs(LOG_RETENTION_DAYS),
    samples: await purgeOldSamples(METRIC_RETENTION_DAYS),
  }));
  return NextResponse.json({ ok: true, at: new Date().toISOString(), idle, usage, spendingCaps, invoicing, retention });
}
