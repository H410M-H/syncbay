/**
 * Public abuse report intake (no login): validation, spam guards and linking the report to the
 * service that serves the reported host. Spam guards for v1 are a honeypot field, a minimum
 * time on the form, a per-IP rate limit and de-duplication of identical open reports.
 */

import { z } from "zod";
import { db } from "@/lib/db";
import { ABUSE_CATEGORIES, type AbuseCategory } from "./permissions";

export const abuseReportSchema = z
  .object({
    category: z.enum(Object.keys(ABUSE_CATEGORIES) as [AbuseCategory, ...AbuseCategory[]]),
    url: z.string().trim().min(4).max(2000),
    description: z.string().trim().min(10).max(5000),
    reporterEmail: z.string().trim().email().max(200).optional().or(z.literal("")),
    /** Honeypot: humans never fill it. */
    website: z.string().max(200).optional(),
    /** When the form was rendered (ms since epoch). */
    renderedAt: z.number().int().optional(),
  })
  .strict();

const WINDOW_MS = 60 * 60 * 1000;
const PER_IP_LIMIT = 10;
const hits = new Map<string, number[]>();

export function rateLimited(ip: string, now = Date.now()): boolean {
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 10_000) hits.delete(hits.keys().next().value as string);
  return recent.length > PER_IP_LIMIT;
}

/** Hostname of a reported URL ("https://x.syncbay.app/a" → "x.syncbay.app"). */
export function reportedHost(url: string): string | null {
  try {
    return new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export type IntakeResult = { status: "created" | "duplicate" | "ignored"; id?: string };

export async function submitAbuseReport(input: z.infer<typeof abuseReportSchema>, ip: string | null, now = Date.now()): Promise<IntakeResult> {
  // Bots fill the honeypot or submit instantly; answer as if accepted so they learn nothing.
  if (input.website || (input.renderedAt && now - input.renderedAt < 2000)) return { status: "ignored" };

  const host = reportedHost(input.url);
  const domain = host
    ? await db.domain.findUnique({
        where: { hostname: host },
        select: { serviceId: true, service: { select: { environment: { select: { project: { select: { workspaceId: true } } } } } } },
      })
    : null;

  const duplicate = await db.abuseReport.findFirst({
    where: { url: input.url, category: input.category, status: { in: ["OPEN", "IN_REVIEW"] }, createdAt: { gte: new Date(now - 24 * WINDOW_MS) } },
    select: { id: true },
  });
  if (duplicate) return { status: "duplicate", id: duplicate.id };

  const report = await db.abuseReport.create({
    data: {
      category: input.category,
      priority: ABUSE_CATEGORIES[input.category],
      url: input.url,
      targetHost: host,
      serviceId: domain?.serviceId ?? null,
      workspaceId: domain?.service?.environment?.project?.workspaceId ?? null,
      description: input.description,
      reporterEmail: input.reporterEmail || null,
      reporterIp: ip,
    },
    select: { id: true },
  });
  return { status: "created", id: report.id };
}
