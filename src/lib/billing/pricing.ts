/**
 * Syncbay usage rate card, in US cents per unit of each UsageResourceType.
 * Mirrors the estimate shown by metrics.workspaceUsage.
 */

export const USAGE_RATES_CENTS: Record<string, { cents: number; unit: string; label: string }> = {
  CPU_ACTIVE_SECONDS: { cents: 0.002, unit: "vCPU-second", label: "Compute (active vCPU seconds)" },
  MEMORY_GIB_HOURS: { cents: 0.5, unit: "GiB-hour", label: "Memory (GiB-hours)" },
  DISK_GB_HOURS: { cents: 0.01, unit: "GB-hour", label: "Disk (GB-hours)" },
  EGRESS_GB: { cents: 9, unit: "GB", label: "Network egress (GB)" },
  DB_STORAGE_GB: { cents: 2, unit: "GB", label: "Managed database storage (GB)" },
  BUCKET_STORAGE_GB: { cents: 1.5, unit: "GB", label: "Object storage (GB)" },
};

export interface PricedLine {
  resourceType: string;
  label: string;
  quantity: number;
  unit: string;
  rateCents: number;
  amountCents: number;
}

/** Prices aggregated usage. Each line is rounded to whole cents; the total is the sum of the lines. */
export function priceUsage(totals: Record<string, number>): { lines: PricedLine[]; totalCents: number } {
  const lines: PricedLine[] = [];
  for (const [resourceType, quantity] of Object.entries(totals)) {
    const rate = USAGE_RATES_CENTS[resourceType];
    if (!rate || !Number.isFinite(quantity) || quantity <= 0) continue;
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
