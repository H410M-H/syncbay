/**
 * Syncbay — monthly usage invoicing.
 *
 * `buildMonthlyInvoices(periodStart)` aggregates UsageRecord rows for one
 * calendar month (UTC) per workspace, prices them with the rate card, applies
 * prepaid credits, and records one USAGE invoice per workspace. When Stripe is
 * configured, every invoice with an amount due is issued as a finalized Stripe
 * Invoice (charged automatically to the customer's default card) and its
 * hosted invoice URL becomes the invoice's `pdfUrl`.
 *
 * Idempotent: invoices are unique on (workspaceId, periodKey), credits are
 * applied in the same transaction that creates the invoice, and all Stripe
 * writes carry idempotency keys derived from the local invoice id. Re-running a
 * month only retries Stripe issuance for invoices that are not yet in Stripe.
 *
 * Scheduled by `runMonthlyInvoicingIfDue()` from the 15-minute sweep cron
 * (src/app/api/cron/sweep/route.ts).
 */

import type { Invoice, PrismaClient } from "@prisma/client";
import type Stripe from "stripe";
import { priceUsage, type PricedLine } from "./pricing";
import { BILLING_CURRENCY, ensureStripeCustomer } from "./payment-engine";
import { getStripe } from "./stripe-client";

export interface MonthlyInvoiceOutcome {
  workspaceId: string;
  invoiceId: string | null;
  status: "created" | "exists" | "skipped_zero";
  totalCents: number;
  creditAppliedCents: number;
  amountDueCents: number;
  stripeInvoiceId: string | null;
  stripeError?: string;
}

export interface MonthlyInvoiceRun {
  periodKey: string;
  periodStart: Date;
  periodEnd: Date;
  stripeConfigured: boolean;
  invoices: MonthlyInvoiceOutcome[];
}

export function monthBounds(periodStart: Date) {
  const start = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth(), 1));
  const end = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1));
  const periodKey = `usage:${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
  return { start, end, periodKey };
}

async function defaultDb(): Promise<PrismaClient> {
  const { db } = await import("@/lib/db");
  return db as PrismaClient;
}

function isUniqueViolation(err: unknown) {
  return (err as { code?: string })?.code === "P2002";
}

/** Issues (creates, itemizes and finalizes) the Stripe Invoice for a local USAGE invoice. */
async function issueStripeInvoice(db: PrismaClient, stripe: Stripe, invoice: Invoice): Promise<string> {
  const customer = await ensureStripeCustomer(db, stripe, invoice.workspaceId);
  const lines = (invoice.lineItems as unknown as PricedLine[] | null) ?? [];
  const label = invoice.periodKey?.replace("usage:", "") ?? invoice.periodStart.toISOString().slice(0, 7);

  const draft = await stripe.invoices.create(
    {
      customer,
      currency: BILLING_CURRENCY,
      collection_method: "charge_automatically",
      auto_advance: true,
      pending_invoice_items_behavior: "exclude",
      description: `Syncbay usage for ${label}`,
      metadata: { workspaceId: invoice.workspaceId, invoiceId: invoice.id, periodKey: invoice.periodKey ?? "" },
    },
    { idempotencyKey: `syncbay-invoice-${invoice.id}` }
  );
  if (!draft.id) throw new Error("Stripe did not return an invoice id");

  for (const line of lines) {
    if (line.amountCents <= 0) continue;
    await stripe.invoiceItems.create(
      {
        customer,
        invoice: draft.id,
        currency: BILLING_CURRENCY,
        amount: line.amountCents,
        description: `${line.label}: ${line.quantity} ${line.unit}`,
        metadata: { resourceType: line.resourceType },
      },
      { idempotencyKey: `syncbay-ii-${invoice.id}-${line.resourceType}` }
    );
  }
  if (invoice.creditAppliedCents > 0) {
    await stripe.invoiceItems.create(
      {
        customer,
        invoice: draft.id,
        currency: BILLING_CURRENCY,
        amount: -invoice.creditAppliedCents,
        description: "Prepaid Syncbay credits applied",
      },
      { idempotencyKey: `syncbay-ii-${invoice.id}-credits` }
    );
  }

  const finalized = await stripe.invoices.finalizeInvoice(draft.id, { auto_advance: true });
  if (typeof finalized.amount_due === "number" && finalized.amount_due !== invoice.amountCents) {
    console.warn(
      `[billing] Stripe invoice ${draft.id} amount_due ${finalized.amount_due} != local ${invoice.amountCents} (invoice ${invoice.id})`
    );
  }
  await db.invoice.update({
    where: { id: invoice.id },
    data: { stripeInvoiceId: draft.id, pdfUrl: finalized.hosted_invoice_url ?? null },
  });
  return draft.id;
}

export async function buildMonthlyInvoices(
  periodStart: Date,
  options: { db?: PrismaClient; stripe?: Stripe | null; workspaceIds?: string[] } = {}
): Promise<MonthlyInvoiceRun> {
  const db = options.db ?? (await defaultDb());
  const stripe = options.stripe === undefined ? getStripe() : options.stripe;
  const { start, end, periodKey } = monthBounds(periodStart);

  const groups = await db.usageRecord.groupBy({
    by: ["workspaceId", "resourceType"],
    where: {
      periodStart: { gte: start, lt: end },
      ...(options.workspaceIds ? { workspaceId: { in: options.workspaceIds } } : {}),
    },
    _sum: { quantity: true },
  });

  const totalsByWorkspace = new Map<string, Record<string, number>>();
  for (const g of groups) {
    const totals = totalsByWorkspace.get(g.workspaceId) ?? {};
    totals[g.resourceType] = (totals[g.resourceType] ?? 0) + (g._sum.quantity ?? 0);
    totalsByWorkspace.set(g.workspaceId, totals);
  }

  const outcomes: MonthlyInvoiceOutcome[] = [];
  for (const [workspaceId, totals] of totalsByWorkspace) {
    const { lines, totalCents } = priceUsage(totals);
    if (totalCents <= 0) {
      outcomes.push({ workspaceId, invoiceId: null, status: "skipped_zero", totalCents: 0, creditAppliedCents: 0, amountDueCents: 0, stripeInvoiceId: null });
      continue;
    }

    let invoice: Invoice | null = await db.invoice.findUnique({ where: { workspaceId_periodKey: { workspaceId, periodKey } } });
    let status: MonthlyInvoiceOutcome["status"] = "exists";

    if (!invoice) {
      try {
        invoice = await db.$transaction(async (tx) => {
          const ws = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { creditBalanceCents: true } });
          if (!ws) throw new Error(`Workspace ${workspaceId} not found`);
          const creditAppliedCents = Math.max(0, Math.min(ws.creditBalanceCents, totalCents));
          if (creditAppliedCents > 0) {
            const debited = await tx.workspace.updateMany({
              where: { id: workspaceId, creditBalanceCents: { gte: creditAppliedCents } },
              data: { creditBalanceCents: { decrement: creditAppliedCents } },
            });
            if (debited.count !== 1) throw new Error("Credit balance changed concurrently; retry");
          }
          const amountCents = totalCents - creditAppliedCents;
          const created = await tx.invoice.create({
            data: {
              workspaceId,
              kind: "USAGE",
              periodKey,
              periodStart: start,
              periodEnd: end,
              infraCostCents: totalCents,
              creditAppliedCents,
              amountCents,
              lineItems: lines as unknown as object,
              description: `Usage for ${periodKey.replace("usage:", "")}`,
              status: amountCents === 0 ? "PAID" : "OPEN",
              paidAt: amountCents === 0 ? new Date() : null,
            },
          });
          await tx.auditLogEntry.create({
            data: {
              workspaceId,
              actorUserId: null,
              action: "billing.usage_invoice_created",
              metadata: { invoiceId: created.id, periodKey, totalCents, creditAppliedCents, amountCents },
            },
          });
          return created;
        });
        status = "created";
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        invoice = await db.invoice.findUnique({ where: { workspaceId_periodKey: { workspaceId, periodKey } } });
      }
    }
    if (!invoice) continue;

    const outcome: MonthlyInvoiceOutcome = {
      workspaceId,
      invoiceId: invoice.id,
      status,
      totalCents: invoice.infraCostCents,
      creditAppliedCents: invoice.creditAppliedCents,
      amountDueCents: invoice.amountCents,
      stripeInvoiceId: invoice.stripeInvoiceId,
    };

    if (stripe && invoice.amountCents > 0 && !invoice.stripeInvoiceId && invoice.status !== "VOID") {
      try {
        outcome.stripeInvoiceId = await issueStripeInvoice(db, stripe, invoice);
      } catch (err) {
        outcome.stripeError = (err as Error).message;
        console.error(`[billing] Failed to issue Stripe invoice for ${invoice.id}: ${outcome.stripeError}`);
      }
    }
    outcomes.push(outcome);
  }

  return { periodKey, periodStart: start, periodEnd: end, stripeConfigured: !!stripe, invoices: outcomes };
}

/** Invoicing for the previous month runs on day 1 (UTC) from this hour on, after the last hour's usage is written. */
const MONTHLY_INVOICE_START_HOUR_UTC = 2;

/**
 * Cron entry point: on the 1st of each month (UTC, from 02:00) builds the
 * previous month's invoices. Every sweep that day re-runs it, which is safe:
 * existing invoices are skipped and only failed Stripe issuance is retried.
 * Any other time it is a no-op.
 */
export async function runMonthlyInvoicingIfDue(now = new Date(), options: Parameters<typeof buildMonthlyInvoices>[1] = {}) {
  if (now.getUTCDate() !== 1 || now.getUTCHours() < MONTHLY_INVOICE_START_HOUR_UTC) {
    return { due: false as const };
  }
  const previousMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const run = await buildMonthlyInvoices(previousMonth, options);
  return {
    due: true as const,
    periodKey: run.periodKey,
    stripeConfigured: run.stripeConfigured,
    created: run.invoices.filter((i) => i.status === "created").length,
    existing: run.invoices.filter((i) => i.status === "exists").length,
    stripeErrors: run.invoices.filter((i) => i.stripeError).length,
  };
}
