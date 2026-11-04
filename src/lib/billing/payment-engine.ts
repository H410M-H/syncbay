/**
 * Syncbay — Stripe payment engine.
 *
 * PCI scope: Syncbay never receives, validates, logs or stores card numbers or
 * security codes. Cards are collected by Stripe Elements in the browser and
 * confirmed against a SetupIntent directly with Stripe. The server only stores
 * the Stripe PaymentMethod id plus the brand / last4 / expiry that Stripe
 * itself returns, and only after verifying the PaymentMethod belongs to the
 * workspace's Stripe Customer.
 *
 * Money movement:
 *   - Prepaid credit top-ups are PaymentIntents. Credits are granted only once
 *     Stripe reports `succeeded` (webhook or explicit sync), exactly once per
 *     PaymentIntent.
 *   - Monthly usage invoices are Stripe Invoices (see invoicing.ts).
 */

import type { PrismaClient } from "@prisma/client";
import type Stripe from "stripe";

type Db = PrismaClient;

export type BillingErrorCode = "NOT_FOUND" | "BAD_REQUEST" | "FORBIDDEN" | "PRECONDITION_FAILED" | "CONFLICT";

export class BillingError extends Error {
  constructor(
    message: string,
    readonly code: BillingErrorCode = "BAD_REQUEST"
  ) {
    super(message);
    this.name = "BillingError";
  }
}

export const MIN_TOP_UP_CENTS = 500;
export const MAX_TOP_UP_CENTS = 1_000_000;
export const BILLING_CURRENCY = "usd";

function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

async function audit(db: Db, workspaceId: string, actorUserId: string | null, action: string, metadata: Record<string, unknown>) {
  await db.auditLogEntry.create({
    data: { workspaceId, actorUserId, action, metadata: metadata as object },
  });
}

// ─── CUSTOMERS ────────────────────────────────────────────────────────────────

/** Returns the workspace's Stripe Customer id, creating the Customer on first use. */
export async function ensureStripeCustomer(db: Db, stripe: Stripe, workspaceId: string): Promise<string> {
  const ws = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true, slug: true, stripeCustomerId: true },
  });
  if (!ws) throw new BillingError("Workspace not found", "NOT_FOUND");
  if (ws.stripeCustomerId) return ws.stripeCustomerId;

  const customer = await stripe.customers.create(
    { name: ws.name, metadata: { workspaceId: ws.id, workspaceSlug: ws.slug } },
    { idempotencyKey: `syncbay-customer-${ws.id}` }
  );

  // Only the first writer wins; a concurrent caller re-reads the stored id.
  const res = await db.workspace.updateMany({
    where: { id: ws.id, stripeCustomerId: null },
    data: { stripeCustomerId: customer.id },
  });
  if (res.count === 0) {
    const fresh = await db.workspace.findUnique({ where: { id: ws.id }, select: { stripeCustomerId: true } });
    if (fresh?.stripeCustomerId) return fresh.stripeCustomerId;
  }
  return customer.id;
}

// ─── SETUP INTENTS (ADD CARD) ─────────────────────────────────────────────────

export async function createSetupIntent(db: Db, stripe: Stripe, workspaceId: string, userId: string) {
  const customer = await ensureStripeCustomer(db, stripe, workspaceId);
  const si = await stripe.setupIntents.create({
    customer,
    usage: "off_session",
    allowed_payment_method_types: ["card"],
    metadata: { workspaceId, userId },
  });
  if (!si.client_secret) throw new BillingError("Stripe did not return a SetupIntent client secret");
  return { setupIntentId: si.id, clientSecret: si.client_secret };
}

/**
 * Records the card saved by a succeeded SetupIntent. Called by the client after
 * `stripe.confirmSetup()` and by the `setup_intent.succeeded` webhook; both are idempotent.
 */
export async function completeSetupIntent(
  db: Db,
  stripe: Stripe,
  params: { workspaceId: string; userId: string | null; setupIntentId: string; setAsDefault?: boolean }
) {
  const ws = await db.workspace.findUnique({ where: { id: params.workspaceId }, select: { stripeCustomerId: true } });
  if (!ws) throw new BillingError("Workspace not found", "NOT_FOUND");
  if (!ws.stripeCustomerId) throw new BillingError("This workspace has no Stripe customer yet", "PRECONDITION_FAILED");

  const si = await stripe.setupIntents.retrieve(params.setupIntentId);
  if (idOf(si.customer) !== ws.stripeCustomerId) {
    throw new BillingError("SetupIntent does not belong to this workspace", "FORBIDDEN");
  }
  if (si.status !== "succeeded") {
    throw new BillingError(`Card setup is not complete (status: ${si.status})`, "PRECONDITION_FAILED");
  }
  const pmId = idOf(si.payment_method);
  if (!pmId) throw new BillingError("SetupIntent has no payment method", "PRECONDITION_FAILED");

  return upsertPaymentMethodFromStripe(db, stripe, {
    workspaceId: params.workspaceId,
    customerId: ws.stripeCustomerId,
    stripePaymentMethodId: pmId,
    setAsDefault: params.setAsDefault ?? false,
    actorUserId: params.userId,
  });
}

/** Mirrors one Stripe card PaymentMethod (brand/last4/expiry only) into the DB. */
async function upsertPaymentMethodFromStripe(
  db: Db,
  stripe: Stripe,
  params: {
    workspaceId: string;
    customerId: string;
    stripePaymentMethodId: string;
    setAsDefault: boolean;
    actorUserId: string | null;
    pm?: Stripe.PaymentMethod;
  }
) {
  const pm = params.pm ?? (await stripe.paymentMethods.retrieve(params.stripePaymentMethodId));
  if (idOf(pm.customer) !== params.customerId) {
    throw new BillingError("Payment method is not attached to this workspace's Stripe customer", "FORBIDDEN");
  }
  if (pm.type !== "card" || !pm.card) {
    throw new BillingError("Only card payment methods are supported", "BAD_REQUEST");
  }

  const existing = await db.paymentMethod.findUnique({ where: { stripePaymentMethodId: pm.id } });
  if (existing && existing.workspaceId !== params.workspaceId) {
    throw new BillingError("Payment method belongs to another workspace", "FORBIDDEN");
  }

  const others = await db.paymentMethod.count({
    where: { workspaceId: params.workspaceId, NOT: { stripePaymentMethodId: pm.id } },
  });
  const makeDefault = params.setAsDefault || others === 0 || !!existing?.isDefault;

  const data = {
    brand: pm.card.brand,
    last4: pm.card.last4,
    expMonth: pm.card.exp_month,
    expYear: pm.card.exp_year,
    cardholderName: pm.billing_details?.name ?? null,
  };

  const row = await db.$transaction(async (tx) => {
    if (makeDefault) {
      await tx.paymentMethod.updateMany({
        where: { workspaceId: params.workspaceId, isDefault: true, NOT: { stripePaymentMethodId: pm.id } },
        data: { isDefault: false },
      });
    }
    return tx.paymentMethod.upsert({
      where: { stripePaymentMethodId: pm.id },
      create: { ...data, workspaceId: params.workspaceId, stripePaymentMethodId: pm.id, isDefault: makeDefault },
      update: { ...data, isDefault: makeDefault },
    });
  });

  if (makeDefault) {
    await stripe.customers.update(params.customerId, { invoice_settings: { default_payment_method: pm.id } });
  }
  if (!existing) {
    await audit(db, params.workspaceId, params.actorUserId, "billing.payment_method_added", {
      paymentMethodId: row.id,
      stripePaymentMethodId: pm.id,
      brand: data.brand,
      last4: data.last4,
      isDefault: makeDefault,
    });
  }
  return row;
}

// ─── PAYMENT METHODS ──────────────────────────────────────────────────────────

/**
 * Lists the workspace's cards from Stripe and reconciles the local mirror:
 * cards detached in Stripe (or legacy rows that never were Stripe objects) are removed.
 */
export async function listPaymentMethods(db: Db, stripe: Stripe, workspaceId: string) {
  const ws = await db.workspace.findUnique({ where: { id: workspaceId }, select: { stripeCustomerId: true } });
  if (!ws) throw new BillingError("Workspace not found", "NOT_FOUND");

  if (!ws.stripeCustomerId) {
    await db.paymentMethod.deleteMany({ where: { workspaceId } });
    return [];
  }

  const [list, customer] = await Promise.all([
    stripe.customers.listPaymentMethods(ws.stripeCustomerId, { type: "card", limit: 100 }),
    stripe.customers.retrieve(ws.stripeCustomerId),
  ]);
  const stripeDefault =
    !("deleted" in customer && customer.deleted) && "invoice_settings" in customer
      ? idOf(customer.invoice_settings?.default_payment_method ?? null)
      : null;

  const ids = list.data.map((pm) => pm.id);
  await db.paymentMethod.deleteMany({
    where: { workspaceId, OR: [{ stripePaymentMethodId: null }, { stripePaymentMethodId: { notIn: ids } }] },
  });

  for (const pm of list.data) {
    if (!pm.card) continue;
    await db.paymentMethod.upsert({
      where: { stripePaymentMethodId: pm.id },
      create: {
        workspaceId,
        stripePaymentMethodId: pm.id,
        brand: pm.card.brand,
        last4: pm.card.last4,
        expMonth: pm.card.exp_month,
        expYear: pm.card.exp_year,
        cardholderName: pm.billing_details?.name ?? null,
        isDefault: false,
      },
      update: {
        brand: pm.card.brand,
        last4: pm.card.last4,
        expMonth: pm.card.exp_month,
        expYear: pm.card.exp_year,
        cardholderName: pm.billing_details?.name ?? null,
      },
    });
  }

  if (stripeDefault && ids.includes(stripeDefault)) {
    await db.paymentMethod.updateMany({ where: { workspaceId }, data: { isDefault: false } });
    await db.paymentMethod.updateMany({ where: { workspaceId, stripePaymentMethodId: stripeDefault }, data: { isDefault: true } });
  }

  return db.paymentMethod.findMany({
    where: { workspaceId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
  });
}

export async function setDefaultPaymentMethod(db: Db, stripe: Stripe, workspaceId: string, userId: string, paymentMethodId: string) {
  const method = await db.paymentMethod.findFirst({ where: { id: paymentMethodId, workspaceId } });
  if (!method?.stripePaymentMethodId) throw new BillingError("Payment method not found", "NOT_FOUND");
  const customerId = await ensureStripeCustomer(db, stripe, workspaceId);

  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: method.stripePaymentMethodId },
  });

  const updated = await db.$transaction(async (tx) => {
    await tx.paymentMethod.updateMany({ where: { workspaceId }, data: { isDefault: false } });
    return tx.paymentMethod.update({ where: { id: method.id }, data: { isDefault: true } });
  });

  await audit(db, workspaceId, userId, "billing.payment_method_default_set", { paymentMethodId, last4: method.last4 });
  return updated;
}

export async function deletePaymentMethod(db: Db, stripe: Stripe, workspaceId: string, userId: string, paymentMethodId: string) {
  const method = await db.paymentMethod.findFirst({ where: { id: paymentMethodId, workspaceId } });
  if (!method) throw new BillingError("Payment method not found", "NOT_FOUND");

  if (method.stripePaymentMethodId) {
    try {
      await stripe.paymentMethods.detach(method.stripePaymentMethodId);
    } catch (err) {
      // Already detached / deleted in Stripe: the local mirror is simply stale.
      if ((err as { code?: string }).code !== "resource_missing") throw err;
    }
  }

  await db.paymentMethod.delete({ where: { id: method.id } });

  if (method.isDefault) {
    const next = await db.paymentMethod.findFirst({ where: { workspaceId }, orderBy: { createdAt: "desc" } });
    if (next?.stripePaymentMethodId) {
      await db.paymentMethod.update({ where: { id: next.id }, data: { isDefault: true } });
      const ws = await db.workspace.findUnique({ where: { id: workspaceId }, select: { stripeCustomerId: true } });
      if (ws?.stripeCustomerId) {
        await stripe.customers.update(ws.stripeCustomerId, {
          invoice_settings: { default_payment_method: next.stripePaymentMethodId },
        });
      }
    }
  }

  await audit(db, workspaceId, userId, "billing.payment_method_deleted", { paymentMethodId, last4: method.last4 });
  return { success: true, deletedId: paymentMethodId };
}

async function resolveCard(db: Db, workspaceId: string, paymentMethodId?: string) {
  const card = paymentMethodId
    ? await db.paymentMethod.findFirst({ where: { id: paymentMethodId, workspaceId } })
    : ((await db.paymentMethod.findFirst({ where: { workspaceId, isDefault: true } })) ??
      (await db.paymentMethod.findFirst({ where: { workspaceId }, orderBy: { createdAt: "desc" } })));
  if (!card?.stripePaymentMethodId) {
    throw new BillingError("No payment card on file for this workspace. Add a card first.", "PRECONDITION_FAILED");
  }
  return card as typeof card & { stripePaymentMethodId: string };
}

// ─── TOP-UPS (PAYMENT INTENTS) ────────────────────────────────────────────────

/**
 * Starts a prepaid credit top-up: records an OPEN TOP_UP invoice and creates a
 * PaymentIntent for the saved card. The browser confirms it (handling 3-D Secure)
 * with the returned client secret. Credits are NOT granted here.
 */
export async function createTopUp(
  db: Db,
  stripe: Stripe,
  params: { workspaceId: string; userId: string; amountCents: number; paymentMethodId?: string }
) {
  const { workspaceId, userId, amountCents } = params;
  if (!Number.isInteger(amountCents) || amountCents < MIN_TOP_UP_CENTS) {
    throw new BillingError("Minimum credit purchase is $5.00 (500 cents)");
  }
  if (amountCents > MAX_TOP_UP_CENTS) {
    throw new BillingError("Maximum single credit purchase is $10,000.00");
  }

  const customer = await ensureStripeCustomer(db, stripe, workspaceId);
  const card = await resolveCard(db, workspaceId, params.paymentMethodId);
  const now = new Date();
  const description = `Syncbay compute credits (+$${(amountCents / 100).toFixed(2)})`;

  const invoice = await db.invoice.create({
    data: {
      workspaceId,
      kind: "TOP_UP",
      periodStart: now,
      periodEnd: now,
      amountCents,
      infraCostCents: 0,
      status: "OPEN",
      description,
      paymentMethodId: card.id,
    },
  });

  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.create(
      {
        amount: amountCents,
        currency: BILLING_CURRENCY,
        customer,
        payment_method: card.stripePaymentMethodId,
        allowed_payment_method_types: ["card"],
        description,
        metadata: { workspaceId, invoiceId: invoice.id, kind: "TOP_UP", userId },
      },
      { idempotencyKey: `syncbay-topup-${invoice.id}` }
    );
  } catch (err) {
    await db.invoice.update({
      where: { id: invoice.id },
      data: { status: "VOID", failureMessage: (err as Error).message?.slice(0, 500) ?? "PaymentIntent creation failed" },
    });
    throw err;
  }

  await db.invoice.update({ where: { id: invoice.id }, data: { stripePaymentIntentId: pi.id } });
  await audit(db, workspaceId, userId, "billing.top_up_started", { invoiceId: invoice.id, paymentIntentId: pi.id, amountCents });

  return {
    invoiceId: invoice.id,
    paymentIntentId: pi.id,
    clientSecret: pi.client_secret,
    status: pi.status,
    stripePaymentMethodId: card.stripePaymentMethodId,
  };
}

async function receiptUrlFor(stripe: Stripe, pi: Stripe.PaymentIntent): Promise<string | null> {
  const charge = pi.latest_charge;
  if (!charge) return null;
  if (typeof charge !== "string") return charge.receipt_url ?? null;
  try {
    return (await stripe.charges.retrieve(charge)).receipt_url ?? null;
  } catch {
    return null;
  }
}

/**
 * Applies a PaymentIntent's state to its TOP_UP invoice. Exactly-once: the
 * invoice flips to PAID with a conditional update, and only the caller that
 * flipped it increments the credit balance (same DB transaction).
 */
export async function applyPaymentIntent(db: Db, stripe: Stripe, pi: Stripe.PaymentIntent) {
  const invoice = await db.invoice.findUnique({ where: { stripePaymentIntentId: pi.id } });
  if (!invoice) return { matched: false as const };

  if (pi.status === "succeeded") {
    if (pi.amount_received < invoice.amountCents || pi.currency !== BILLING_CURRENCY) {
      throw new BillingError(`PaymentIntent ${pi.id} amount/currency does not match invoice ${invoice.id}`, "CONFLICT");
    }
    const pdfUrl = invoice.pdfUrl ?? (await receiptUrlFor(stripe, pi));
    const credited = await db.$transaction(async (tx) => {
      const flipped = await tx.invoice.updateMany({
        where: { id: invoice.id, status: { not: "PAID" } },
        data: { status: "PAID", paidAt: new Date(), pdfUrl, failureMessage: null },
      });
      if (flipped.count === 0) return false;
      if (invoice.kind === "TOP_UP") {
        await tx.workspace.update({
          where: { id: invoice.workspaceId },
          data: { creditBalanceCents: { increment: invoice.amountCents } },
        });
      }
      await tx.auditLogEntry.create({
        data: {
          workspaceId: invoice.workspaceId,
          actorUserId: null,
          action: invoice.kind === "TOP_UP" ? "billing.credits_purchased" : "billing.invoice_paid",
          metadata: { invoiceId: invoice.id, paymentIntentId: pi.id, amountCents: invoice.amountCents },
        },
      });
      return true;
    });
    return { matched: true as const, invoiceId: invoice.id, status: "PAID" as const, credited };
  }

  if (pi.status === "canceled" || (pi.status === "requires_payment_method" && pi.last_payment_error)) {
    const message = pi.last_payment_error?.message ?? (pi.status === "canceled" ? "Payment canceled" : "Payment failed");
    await db.invoice.updateMany({
      where: { id: invoice.id, status: "OPEN" },
      data: { status: "VOID", failureMessage: message.slice(0, 500) },
    });
    return { matched: true as const, invoiceId: invoice.id, status: "VOID" as const, credited: false };
  }

  return { matched: true as const, invoiceId: invoice.id, status: invoice.status, credited: false };
}

/** Pulls the current PaymentIntent state from Stripe for a workspace's top-up invoice. */
export async function syncTopUp(db: Db, stripe: Stripe, workspaceId: string, invoiceId: string) {
  const invoice = await db.invoice.findFirst({ where: { id: invoiceId, workspaceId, kind: "TOP_UP" } });
  if (!invoice?.stripePaymentIntentId) throw new BillingError("Top-up not found", "NOT_FOUND");
  const pi = await stripe.paymentIntents.retrieve(invoice.stripePaymentIntentId);
  if (pi.metadata?.workspaceId && pi.metadata.workspaceId !== workspaceId) {
    throw new BillingError("PaymentIntent does not belong to this workspace", "FORBIDDEN");
  }
  const applied = await applyPaymentIntent(db, stripe, pi);
  const fresh = await db.workspace.findUnique({ where: { id: workspaceId }, select: { creditBalanceCents: true } });
  return {
    invoiceId,
    paymentIntentStatus: pi.status,
    invoiceStatus: applied.matched ? applied.status : invoice.status,
    credited: applied.matched ? applied.credited : false,
    newBalanceCents: fresh?.creditBalanceCents ?? 0,
  };
}

// ─── STRIPE INVOICES ──────────────────────────────────────────────────────────

/** Applies a Stripe Invoice's paid / failed state to the matching local invoice. */
export async function applyStripeInvoice(db: Db, inv: Stripe.Invoice, outcome: "paid" | "payment_failed") {
  if (!inv.id) return { matched: false as const };
  const invoice = await db.invoice.findFirst({ where: { stripeInvoiceId: inv.id } });
  if (!invoice) return { matched: false as const };

  if (outcome === "paid") {
    const flipped = await db.invoice.updateMany({
      where: { id: invoice.id, status: { not: "PAID" } },
      data: { status: "PAID", paidAt: new Date(), pdfUrl: inv.hosted_invoice_url ?? invoice.pdfUrl, failureMessage: null },
    });
    if (flipped.count > 0) {
      await audit(db, invoice.workspaceId, null, "billing.invoice_paid", { invoiceId: invoice.id, stripeInvoiceId: inv.id });
    }
    return { matched: true as const, invoiceId: invoice.id, status: "PAID" as const };
  }

  await db.invoice.updateMany({
    where: { id: invoice.id, status: { notIn: ["PAID", "VOID"] } },
    data: { status: "PAST_DUE", pdfUrl: inv.hosted_invoice_url ?? invoice.pdfUrl, failureMessage: "Stripe could not collect payment for this invoice" },
  });
  return { matched: true as const, invoiceId: invoice.id, status: "PAST_DUE" as const };
}

/** Pays an issued usage invoice through Stripe with a saved card. */
export async function payInvoice(
  db: Db,
  stripe: Stripe,
  params: { workspaceId: string; userId: string; invoiceId: string; paymentMethodId?: string }
) {
  const invoice = await db.invoice.findFirst({ where: { id: params.invoiceId, workspaceId: params.workspaceId } });
  if (!invoice) throw new BillingError("Invoice not found", "NOT_FOUND");
  if (invoice.status === "PAID") throw new BillingError("This invoice is already paid");
  if (invoice.status === "VOID") throw new BillingError("This invoice is void");
  if (invoice.kind !== "USAGE") throw new BillingError("Top-ups are paid when they are created");
  if (!invoice.stripeInvoiceId) {
    throw new BillingError("This invoice has not been issued in Stripe yet", "PRECONDITION_FAILED");
  }

  const card = await resolveCard(db, params.workspaceId, params.paymentMethodId);
  const paid = await stripe.invoices.pay(invoice.stripeInvoiceId, { payment_method: card.stripePaymentMethodId });
  if (paid.status === "paid") await applyStripeInvoice(db, paid, "paid");
  await db.invoice.update({ where: { id: invoice.id }, data: { paymentMethodId: card.id } });

  return {
    invoiceId: invoice.id,
    stripeStatus: paid.status,
    hostedInvoiceUrl: paid.hosted_invoice_url ?? null,
  };
}
