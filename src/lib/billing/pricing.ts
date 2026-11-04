/**
 * Syncbay usage rate card: the single source of truth for usage prices.
 * Used by monthly invoicing (invoicing.ts), month-to-date estimates and
 * spending caps (src/lib/usage/metering.ts → metrics.workspaceUsage), and the
 * usage dashboard. Browser-safe (type-only Prisma import).
 */

import type { UsageResourceType } from "@prisma/client";

export const USAGE_RATE_CARD: Record<UsageResourceType, { cents: number; unit: string; label: string }> = {
  CPU_ACTIVE_SECONDS: { cents: 0.002, unit: "vCPU-second", label: "Compute (active vCPU seconds)" },
  MEMORY_GIB_HOURS: { cents: 0.5, unit: "GiB-hour", label: "Memory (GiB-hours)" },
  DISK_GB_HOURS: { cents: 0.01, unit: "GB-hour", label: "Disk (GB-hours)" },
  EGRESS_GB: { cents: 9, unit: "GB", label: "Network egress (GB)" },
  DB_STORAGE_GB: { cents: 2, unit: "GB", label: "Managed database storage (GB)" },
  BUCKET_STORAGE_GB: { cents: 1.5, unit: "GB", label: "Object storage (GB)" },
};

/** Cents per unit, by resource type. */
export const USAGE_RATES_CENTS = Object.fromEntries(
  Object.entries(USAGE_RATE_CARD).map(([type, rate]) => [type, rate.cents])
) as Record<UsageResourceType, number>;

/** Rate in US dollars per unit, formatted for display (e.g. "$0.00002"). */
export function formatRateDollars(type: UsageResourceType): string {
  return `$${+(USAGE_RATE_CARD[type].cents / 100).toPrecision(6)}`;
}

export interface PricedLine {
  resourceType: string;
  label: string;
  quantity: number;
  unit: string;
  rateCents: number;
  amountCents: number;
}

/** Prices aggregated usage. Each line is rounded to whole cents; the total is the sum of the lines. */
export function priceUsage(totals: Partial<Record<string, number>>): { lines: PricedLine[]; totalCents: number } {
  const lines: PricedLine[] = [];
  for (const [resourceType, quantity] of Object.entries(totals)) {
    const rate = USAGE_RATE_CARD[resourceType as UsageResourceType];
    if (!rate || quantity === undefined || !Number.isFinite(quantity) || quantity <= 0) continue;
    const amountCents = Math.round(quantity * rate.cents);
    lines.push({
      resourceType,
      label: rate.label,
      quantity: Math.round(quantity * 1e6) / 1e6,
      unit: rate.unit,
      rateCents: rate.cents,
      amountCents,
    });
  }
  return { lines, totalCents: lines.reduce((s, l) => s + l.amountCents, 0) };
}

/**
 * Cost in cents of aggregated usage, computed exactly as an invoice would bill
 * it (per-line rounding), so spending caps and invoices never disagree.
 */
export function estimateCostCents(totals: Partial<Record<string, number>>): number {
  return priceUsage(totals).totalCents;
}
