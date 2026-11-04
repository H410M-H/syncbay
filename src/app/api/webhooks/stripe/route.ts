/**
 * Stripe webhook endpoint: POST /api/webhooks/stripe
 *
 * The signature is verified against the exact raw request body with
 * STRIPE_WEBHOOK_SECRET before any processing. Without the secret (or without
 * STRIPE_SECRET_KEY) the endpoint fails closed with 503.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getStripe } from "@/lib/billing/stripe-client";
import { processStripeEvent } from "@/lib/billing/stripe-webhooks";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  const stripe = getStripe();
  if (!secret || !stripe) {
    return NextResponse.json({ error: "Stripe webhooks are not configured" }, { status: 503 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing Stripe-Signature header" }, { status: 400 });
  }

  const rawBody = await req.text();
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    const result = await processStripeEvent(db, stripe, event);
    if (result.status === "in_progress") {
      // Another delivery of this event is being processed; ask Stripe to retry later.
      return NextResponse.json({ received: true, status: result.status }, { status: 409 });
    }
    return NextResponse.json({ received: true, status: result.status });
  } catch (err) {
    console.error(`[stripe-webhook] ${event.type} ${event.id} failed: ${(err as Error).message}`);
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}
