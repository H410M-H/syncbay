/**
 * Syncbay PaaS — Tier 8 E2E Test Suite
 * Card payments through Stripe: no raw card data anywhere on Syncbay servers,
 * SetupIntent / PaymentIntent flows, explicit "Stripe not configured" state,
 * webhook signature verification and event idempotency.
 *
 * Offline: no Stripe network calls are made here. Full flows against a Stripe
 * HTTP server and a real Postgres run in tests/verify-billing.ts.
 */

import Stripe from "stripe";
import { registerTest, assertTrue, assertFalse, assertEqual, assertIncludes } from "../harness";

import * as paymentEngine from "../../src/lib/billing/payment-engine";
import { formatExpiry, getBrandMetadata } from "../../src/lib/billing/card-display";
import { getPublicStripeConfig, getStripe } from "../../src/lib/billing/stripe-client";
import { processStripeEvent } from "../../src/lib/billing/stripe-webhooks";
import { priceUsage } from "../../src/lib/billing/pricing";
import { appRouter } from "../../src/server/root";
import { billingRouter } from "../../src/server/routers/billing";
import { POST as stripeWebhookPOST } from "../../src/app/api/webhooks/stripe/route";

const STRIPE_ENV = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "STRIPE_API_BASE"] as const;

async function withEnv<T>(values: Partial<Record<(typeof STRIPE_ENV)[number], string>>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(STRIPE_ENV.map((k) => [k, process.env[k]]));
  for (const k of STRIPE_ENV) delete process.env[k];
  Object.assign(process.env, values);
  try {
    return await fn();
  } finally {
    for (const k of STRIPE_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** Minimal in-memory DB: one workspace with an OWNER, a MEMBER, and a legacy (non-Stripe) card row. */
function createMockBillingDb() {
  const members = [
    { workspaceId: "ws-1", userId: "owner-1", role: "OWNER" },
    { workspaceId: "ws-1", userId: "member-1", role: "MEMBER" },
  ];
  const stripeEvents = new Map<string, any>();
  const calls: string[] = [];
  return {
    calls,
    workspaceMember: {
      async findUnique({ where }: any) {
        const k = where.workspaceId_userId;
        return members.find((m) => m.workspaceId === k.workspaceId && m.userId === k.userId) ?? null;
      },
    },
    workspace: {
      async findUnique({ where }: any) {
        calls.push("workspace.findUnique");
        if (where.id !== "ws-1") return null;
        return {
          id: "ws-1",
          name: "Acme",
          slug: "acme",
          stripeCustomerId: null,
          creditBalanceCents: 5000,
          spendingCapCents: null,
          paymentMethods: [
            { id: "legacy", brand: "visa", last4: "1111", isDefault: true, stripePaymentMethodId: "pm_card_visa_1111_legacy" },
          ],
          invoices: [],
        };
      },
    },
    invoice: {
      async findMany() {
        return [];
      },
      async findUnique() {
        return null;
      },
      async findFirst() {
        return null;
      },
    },
    stripeEvent: {
      async create({ data }: any) {
        if (stripeEvents.has(data.id)) {
          const err: any = new Error("Unique constraint failed");
          err.code = "P2002";
          throw err;
        }
        stripeEvents.set(data.id, { ...data, receivedAt: new Date() });
        return data;
      },
      async findUnique({ where }: any) {
        return stripeEvents.get(where.id) ?? null;
      },
      async update({ where, data }: any) {
        Object.assign(stripeEvents.get(where.id), data);
      },
      async updateMany() {
        return { count: 0 };
      },
      async delete({ where }: any) {
        stripeEvents.delete(where.id);
      },
    },
    _events: stripeEvents,
  };
}

function caller(db: any, userId: string) {
  return billingRouter.createCaller({
    db,
    session: { user: { id: userId }, expires: new Date(Date.now() + 3600_000).toISOString() },
    headers: new Headers(),
  } as any);
}

async function expectTrpcError(fn: () => Promise<unknown>, code: string, messageIncludes?: string) {
  try {
    await fn();
  } catch (err: any) {
    assertEqual(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    if (messageIncludes) assertIncludes(err.message, messageIncludes);
    return;
  }
  throw new Error(`Expected TRPC error ${code}, but the call succeeded`);
}

// ─── 1. NO RAW CARD DATA (PCI) ────────────────────────────────────────────────

registerTest("PAY-01", "CARD_PAYMENTS", 8, "Payment engine exposes no PAN/CVC handling or simulated charges", () => {
  const exported = Object.keys(paymentEngine);
  for (const forbidden of [
    "luhnCheck",
    "detectCardBrand",
    "validateCard",
    "validateCvc",
    "formatCardNumber",
    "tokenizeCard",
    "addPaymentMethod",
    "executeCardCharge",
    "addPrepaidCredits",
  ]) {
    assertFalse(exported.includes(forbidden), `payment-engine must not export ${forbidden}`);
  }
  for (const required of ["createSetupIntent", "completeSetupIntent", "createTopUp", "applyPaymentIntent", "payInvoice"]) {
    assertTrue(exported.includes(required), `payment-engine must export ${required}`);
  }
});

registerTest("PAY-02", "CARD_PAYMENTS", 8, "Billing router has no card-number procedure and every input schema rejects card fields", async () => {
  const procs = (appRouter._def.record as any).billing;
  assertTrue(!!procs, "billingRouter must be registered on appRouter");
  assertFalse(!!procs.addCard, "addCard (raw PAN intake) must not exist");
  assertFalse(!!procs.addCredits, "addCredits (simulated charge) must not exist");
  for (const p of [
    "getConfig",
    "listPaymentMethods",
    "createSetupIntent",
    "confirmSetupIntent",
    "setDefaultCard",
    "removeCard",
    "createTopUp",
    "syncTopUp",
    "payInvoice",
    "listInvoices",
    "getBillingSummary",
  ]) {
    assertTrue(!!procs[p], `${p} procedure exists`);
  }

  const db = createMockBillingDb();
  const owner = caller(db, "owner-1") as any;
  const pan = { cardNumber: "4242424242424242", cvc: "123", expMonth: 12, expYear: 2030 };
  const payloads: Record<string, any> = {
    createSetupIntent: { workspaceId: "ws-1", ...pan },
    confirmSetupIntent: { workspaceId: "ws-1", setupIntentId: "seti_123", ...pan },
    createTopUp: { workspaceId: "ws-1", amountCents: 1000, ...pan },
    payInvoice: { workspaceId: "ws-1", invoiceId: "inv_1", cvc: "123" },
    setDefaultCard: { workspaceId: "ws-1", paymentMethodId: "x", cardNumber: "4242424242424242" },
    listPaymentMethods: { workspaceId: "ws-1", number: "4242424242424242" },
  };
  for (const [name, payload] of Object.entries(payloads)) {
    const fn = owner[name];
    await expectTrpcError(() => fn(payload), "BAD_REQUEST");
  }
});

registerTest("PAY-03", "CARD_PAYMENTS", 8, "Only Stripe ids are accepted: confirmSetupIntent rejects non-seti ids", async () => {
  const owner = caller(createMockBillingDb(), "owner-1");
  await expectTrpcError(() => owner.confirmSetupIntent({ workspaceId: "ws-1", setupIntentId: "4242424242424242" }), "BAD_REQUEST");
});

// ─── 2. "STRIPE NOT CONFIGURED" STATE ────────────────────────────────────────

registerTest("PAY-04", "CARD_PAYMENTS", 8, "Without Stripe keys billing is explicitly disabled and never falls back to local charges", async () => {
  await withEnv({}, async () => {
    assertEqual(getStripe(), null);
    const cfg = getPublicStripeConfig();
    assertEqual(cfg.mode, "unconfigured");
    assertFalse(cfg.configured);
    assertEqual(cfg.publishableKey, null);

    const db = createMockBillingDb();
    const owner = caller(db, "owner-1");
    const config = await owner.getConfig({ workspaceId: "ws-1" });
    assertFalse(config.configured);

    await expectTrpcError(() => owner.createSetupIntent({ workspaceId: "ws-1" }), "PRECONDITION_FAILED", "Stripe is not configured");
    await expectTrpcError(() => owner.createTopUp({ workspaceId: "ws-1", amountCents: 2500 }), "PRECONDITION_FAILED", "Stripe is not configured");
    await expectTrpcError(() => owner.payInvoice({ workspaceId: "ws-1", invoiceId: "inv_1" }), "PRECONDITION_FAILED");

    const cards = await owner.listPaymentMethods({ workspaceId: "ws-1" });
    assertEqual(cards.length, 0, "No cards are listed without Stripe");
    const summary = await owner.getBillingSummary({ workspaceId: "ws-1" });
    assertEqual(summary.defaultCard, null, "Legacy non-Stripe card rows are never surfaced");
    assertEqual(summary.stripe.mode, "unconfigured");
  });
});

registerTest("PAY-05", "CARD_PAYMENTS", 8, "Publishable key alone does not enable payments; test vs live mode is detected", async () => {
  await withEnv({ NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_x" }, async () => {
    const cfg = getPublicStripeConfig();
    assertFalse(cfg.configured);
    assertEqual(cfg.publishableKey, null);
  });
  await withEnv({ STRIPE_SECRET_KEY: "sk_test_x", NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_x" }, async () => {
    const cfg = getPublicStripeConfig();
    assertTrue(cfg.configured);
    assertEqual(cfg.mode, "test");
    assertEqual(cfg.publishableKey, "pk_test_x");
  });
});

// ─── 3. ACCESS CONTROL ───────────────────────────────────────────────────────

registerTest("PAY-06", "CARD_PAYMENTS", 8, "Members cannot manage cards; outsiders cannot read billing summaries", async () => {
  await withEnv({ STRIPE_SECRET_KEY: "sk_test_offline" }, async () => {
    const db = createMockBillingDb();
    await expectTrpcError(() => caller(db, "member-1").createSetupIntent({ workspaceId: "ws-1" }), "FORBIDDEN");
    await expectTrpcError(() => caller(db, "member-1").createTopUp({ workspaceId: "ws-1", amountCents: 1000 }), "FORBIDDEN");
    await expectTrpcError(() => caller(db, "outsider").getBillingSummary({ workspaceId: "ws-1" }), "FORBIDDEN");
    await expectTrpcError(() => caller(db, "outsider").listInvoices({ workspaceId: "ws-1" }), "FORBIDDEN");
    assertFalse(db.calls.includes("workspace.findUnique"), "No workspace billing data is read before authorization");
  });
});

registerTest("PAY-07", "CARD_PAYMENTS", 8, "Top-up amount bounds are enforced before any Stripe call", async () => {
  await withEnv({ STRIPE_SECRET_KEY: "sk_test_offline" }, async () => {
    const owner = caller(createMockBillingDb(), "owner-1");
    await expectTrpcError(() => owner.createTopUp({ workspaceId: "ws-1", amountCents: 499 }), "BAD_REQUEST");
    await expectTrpcError(() => owner.createTopUp({ workspaceId: "ws-1", amountCents: 1_000_001 }), "BAD_REQUEST");
    await expectTrpcError(() => owner.createTopUp({ workspaceId: "ws-1", amountCents: 10.5 }), "BAD_REQUEST");
  });
});

// ─── 4. WEBHOOKS ─────────────────────────────────────────────────────────────

function webhookRequest(body: string, signature?: string) {
  return new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers: signature ? { "stripe-signature": signature, "content-type": "application/json" } : { "content-type": "application/json" },
    body,
  });
}

registerTest("PAY-08", "CARD_PAYMENTS", 8, "Stripe webhook fails closed without secrets and rejects bad or missing signatures", async () => {
  const payload = JSON.stringify({ id: "evt_1", object: "event", type: "payment_intent.succeeded", data: { object: {} } });
  await withEnv({}, async () => {
    const res = await stripeWebhookPOST(webhookRequest(payload, "t=1,v1=abc"));
    assertEqual(res.status, 503);
  });
  await withEnv({ STRIPE_SECRET_KEY: "sk_test_offline", STRIPE_WEBHOOK_SECRET: "whsec_e2e_test" }, async () => {
    assertEqual((await stripeWebhookPOST(webhookRequest(payload))).status, 400, "missing signature");
    assertEqual((await stripeWebhookPOST(webhookRequest(payload, "t=1,v1=deadbeef"))).status, 400, "forged signature");

    const stripe = new Stripe("sk_test_offline");
    const wrongSecret = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_other" });
    assertEqual((await stripeWebhookPOST(webhookRequest(payload, wrongSecret))).status, 400, "signed with another secret");

    const good = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_e2e_test" });
    const tampered = payload.replace("evt_1", "evt_2");
    assertEqual((await stripeWebhookPOST(webhookRequest(tampered, good))).status, 400, "body modified after signing");
  });
});

registerTest("PAY-09", "CARD_PAYMENTS", 8, "Webhook events are processed once per Stripe event id", async () => {
  const stripe = new Stripe("sk_test_offline");
  const db = createMockBillingDb();
  const payload = JSON.stringify({
    id: "evt_dup_1",
    object: "event",
    type: "customer.created",
    data: { object: { id: "cus_1", object: "customer" } },
  });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_e2e" });
  const event = stripe.webhooks.constructEvent(payload, header, "whsec_e2e");

  const first = await processStripeEvent(db as any, stripe, event);
  assertEqual(first.status, "ignored", "unhandled event types are acknowledged");
  assertEqual(db._events.get("evt_dup_1")?.status, "PROCESSED");
  const second = await processStripeEvent(db as any, stripe, event);
  assertEqual(second.status, "duplicate");
});

// ─── 5. DISPLAY & PRICING ────────────────────────────────────────────────────

registerTest("PAY-10", "CARD_PAYMENTS", 8, "Card display helpers only format Stripe-returned brand / expiry", () => {
  assertEqual(formatExpiry(5, 2028), "05/28");
  assertEqual(getBrandMetadata("visa").name, "Visa");
  assertEqual(getBrandMetadata("amex").name, "American Express");
  assertEqual(getBrandMetadata("jcb").name, "Jcb");
});

registerTest("PAY-11", "CARD_PAYMENTS", 8, "Usage pricing rounds per line and totals the lines", () => {
  const { lines, totalCents } = priceUsage({ CPU_ACTIVE_SECONDS: 100_000, EGRESS_GB: 2.5, MEMORY_GIB_HOURS: 0, UNKNOWN: 5 });
  assertEqual(lines.length, 2);
  assertEqual(lines.find((l) => l.resourceType === "CPU_ACTIVE_SECONDS")!.amountCents, 200);
  assertEqual(lines.find((l) => l.resourceType === "EGRESS_GB")!.amountCents, 23);
  assertEqual(totalCents, 223);
});
