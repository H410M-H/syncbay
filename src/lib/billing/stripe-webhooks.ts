/**
 * Syncbay — Stripe webhook event processing (signature verification happens in
 * src/app/api/webhooks/stripe/route.ts before anything here runs).
 *
 * Idempotency: each Stripe event id is recorded in `stripe_events`. A redelivery
 * of a PROCESSED event is acknowledged without side effects; a failed attempt
 * removes its claim so Stripe's retry can process it again. The handlers are
 * themselves idempotent (conditional status flips), so a crash between the side
 * effect and marking PROCESSED is also safe.
 */

import type { PrismaClient } from "@prisma/client";
import type Stripe from "stripe";
import { applyPaymentIntent, applyStripeInvoice, completeSetupIntent } from "./payment-engine";

type Db = PrismaClient;

/** A PROCESSING claim older than this is treated as abandoned (crashed worker). */
const STALE_CLAIM_MS = 5 * 60 * 1000;

export interface StripeEventResult {
  status: "processed" | "duplicate" | "in_progress" | "ignored";
  detail?: unknown;
}

async function claimEvent(db: Db, event: Stripe.Event): Promise<"claimed" | "duplicate" | "in_progress"> {
  try {
    await db.stripeEvent.create({ data: { id: event.id, type: event.type, status: "PROCESSING" } });
    return "claimed";
  } catch (err) {
    if ((err as { code?: string }).code !== "P2002") throw err;
  }
  const existing = await db.stripeEvent.findUnique({ where: { id: event.id } });
  if (!existing) return claimEvent(db, event);
  if (existing.status === "PROCESSED") return "duplicate";
  const takeover = await db.stripeEvent.updateMany({
    where: { id: event.id, status: "PROCESSING", receivedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) } },
    data: { receivedAt: new Date() },
  });
  return takeover.count === 1 ? "claimed" : "in_progress";
}

async function dispatch(db: Db, stripe: Stripe, event: Stripe.Event): Promise<StripeEventResult> {
  switch (event.type) {
    case "payment_intent.succeeded":
    case "payment_intent.payment_failed":
    case "payment_intent.canceled": {
      const pi = event.data.object as Stripe.PaymentIntent;
      const res = await applyPaymentIntent(db, stripe, pi);
      return { status: res.matched ? "processed" : "ignored", detail: res };
    }
    case "setup_intent.succeeded": {
      const si = event.data.object as Stripe.SetupIntent;
      const workspaceId = si.metadata?.workspaceId;
      if (!workspaceId) return { status: "ignored", detail: "no workspaceId metadata" };
      // completeSetupIntent re-retrieves the SetupIntent and verifies it belongs
      // to the workspace's Stripe customer before storing anything.
      const row = await completeSetupIntent(db, stripe, { workspaceId, userId: null, setupIntentId: si.id });
      return { status: "processed", detail: { paymentMethodId: row.id } };
    }
    case "invoice.paid":
    case "invoice.payment_succeeded": {
      const res = await applyStripeInvoice(db, event.data.object as Stripe.Invoice, "paid");
      return { status: res.matched ? "processed" : "ignored", detail: res };
    }
    case "invoice.payment_failed": {
      const res = await applyStripeInvoice(db, event.data.object as Stripe.Invoice, "payment_failed");
      return { status: res.matched ? "processed" : "ignored", detail: res };
    }
    default:
      return { status: "ignored", detail: `unhandled event type ${event.type}` };
  }
}

export async function processStripeEvent(db: Db, stripe: Stripe, event: Stripe.Event): Promise<StripeEventResult> {
  const claim = await claimEvent(db, event);
  if (claim === "duplicate") return { status: "duplicate" };
  if (claim === "in_progress") return { status: "in_progress" };

  try {
    const result = await dispatch(db, stripe, event);
    await db.stripeEvent.update({ where: { id: event.id }, data: { status: "PROCESSED", processedAt: new Date() } });
    return result;
  } catch (err) {
    await db.stripeEvent.delete({ where: { id: event.id } }).catch(() => undefined);
    throw err;
  }
}
