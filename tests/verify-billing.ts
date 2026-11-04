/**
 * Verifies Syncbay's Stripe billing end to end.
 *
 * REAL: Postgres (TEST_DATABASE_URL) for every DB write: customers, cards,
 *   invoices, credit balance, webhook idempotency rows, concurrency.
 * REAL webhook crypto: signatures come from stripe.webhooks.generateTestHeaderString
 *   and are verified by the actual POST /api/webhooks/stripe handler on the raw body.
 * MOCKED Stripe HTTP (api.stripe.com is blocked here), two ways:
 *   [A] stripe-mock (TEST_STRIPE_MOCK_URL, Docker image stripe/stripe-mock): the
 *       official stateless mock, which validates every request against Stripe's
 *       OpenAPI spec. Proves each SDK call Syncbay makes has valid parameters.
 *   [B] tests/harness/stripe-emulator.ts: a small stateful local emulator, for
 *       flows that read back state (SetupIntent → card → top-up → webhook).
 *
 * Usage: npm run test:billing
 */

import crypto from "node:crypto";
import Stripe from "stripe";
import { PrismaClient } from "@prisma/client";
import { startStripeEmulator, type StripeEmulator } from "./harness/stripe-emulator";

let passed = 0;
let failed = 0;
let skipped = 0;
function ok(cond: unknown, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ✔ ${msg}`);
  } else {
    failed++;
    console.error(`  ✘ ${msg}`);
  }
}
async function rejects(fn: () => Promise<unknown>, msg: string, check?: (e: any) => boolean) {
  try {
    await fn();
    ok(false, `${msg} (did not throw)`);
  } catch (e: any) {
    const good = !check || check(e);
    ok(good, good ? msg : `${msg} (got ${e?.code ?? ""} ${e?.message})`);
  }
}

const DB_URL = process.env.TEST_DATABASE_URL;
const STRIPE_MOCK_URL = process.env.TEST_STRIPE_MOCK_URL;
const WEBHOOK_SECRET = "whsec_verify_billing_only";
const suffix = crypto.randomBytes(3).toString("hex");

const createdWorkspaces: string[] = [];
const createdUsers: string[] = [];
const createdEvents: string[] = [];

async function seedWorkspace(prisma: PrismaClient, label: string, credit = 0) {
  const owner = await prisma.user.create({ data: { email: `bill-${label}-${suffix}@syncbay.test`, name: `Owner ${label}` } });
  const ws = await prisma.workspace.create({
    data: { name: `Billing ${label}`, slug: `bill-${label}-${suffix}`, creditBalanceCents: credit, members: { create: { userId: owner.id, role: "OWNER" } } },
  });
  createdUsers.push(owner.id);
  createdWorkspaces.push(ws.id);
  return { ws, owner };
}

async function cleanup(prisma: PrismaClient) {
  await prisma.invoice.deleteMany({ where: { workspaceId: { in: createdWorkspaces } } });
  await prisma.usageRecord.deleteMany({ where: { workspaceId: { in: createdWorkspaces } } });
  await prisma.auditLogEntry.deleteMany({ where: { workspaceId: { in: createdWorkspaces } } });
  await prisma.paymentMethod.deleteMany({ where: { workspaceId: { in: createdWorkspaces } } });
  await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: createdWorkspaces } } });
  await prisma.workspace.deleteMany({ where: { id: { in: createdWorkspaces } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  await prisma.stripeEvent.deleteMany({ where: { id: { in: createdEvents } } });
}

// ─── [A] stripe-mock: request-shape validation of every Stripe call ────────────
async function sectionStripeMock(prisma: PrismaClient) {
  console.log("\n[A] Stripe SDK calls validated by stripe-mock (MOCKED Stripe, REAL Postgres)");
  if (!STRIPE_MOCK_URL) {
    skipped++;
    console.log("  - SKIPPED: set TEST_STRIPE_MOCK_URL (docker run -p 44111:12111 stripe/stripe-mock)");
    return;
  }
  const { createStripeClient } = await import("../src/lib/billing/stripe-client");
  const engine = await import("../src/lib/billing/payment-engine");
  const { buildMonthlyInvoices } = await import("../src/lib/billing/invoicing");
  const stripe = createStripeClient({ secretKey: "sk_test_123", apiBase: STRIPE_MOCK_URL });
  const { ws, owner } = await seedWorkspace(prisma, "mock", 300);

  const customerId = await engine.ensureStripeCustomer(prisma, stripe, ws.id);
  ok(/^cus_/.test(customerId) && (await prisma.workspace.findUnique({ where: { id: ws.id } }))?.stripeCustomerId === customerId, "customers.create accepted; customer id stored on the workspace");

  const si = await engine.createSetupIntent(prisma, stripe, ws.id, owner.id);
  ok(/^seti_/.test(si.setupIntentId) && si.clientSecret.includes("_secret_"), "setupIntents.create (usage=off_session, allowed_payment_method_types=[card]) accepted");

  await rejects(
    () => engine.completeSetupIntent(prisma, stripe, { workspaceId: ws.id, userId: owner.id, setupIntentId: "seti_foreign" }),
    "a SetupIntent whose customer is not this workspace's is refused (FORBIDDEN)",
    (e) => e.code === "FORBIDDEN"
  );

  const card = await prisma.paymentMethod.create({
    data: { workspaceId: ws.id, brand: "visa", last4: "4242", expMonth: 12, expYear: 2034, stripePaymentMethodId: `pm_mock_${suffix}`, isDefault: true },
  });
  const topUp = await engine.createTopUp(prisma, stripe, { workspaceId: ws.id, userId: owner.id, amountCents: 1500 });
  ok(/^pi_/.test(topUp.paymentIntentId) && !!topUp.clientSecret, "paymentIntents.create (customer, saved card, metadata, idempotency key) accepted");
  ok((await prisma.workspace.findUnique({ where: { id: ws.id } }))?.creditBalanceCents === 300, "creating a top-up grants no credits by itself");

  await engine.setDefaultPaymentMethod(prisma, stripe, ws.id, owner.id, card.id);
  ok(true, "customers.update(invoice_settings.default_payment_method) accepted");

  await prisma.usageRecord.create({
    data: { workspaceId: ws.id, serviceId: "svc_mock", resourceType: "EGRESS_GB", quantity: 100, periodStart: new Date(Date.UTC(2026, 9, 3)), periodEnd: new Date(Date.UTC(2026, 9, 4)) },
  });
  const warn = console.warn;
  console.warn = () => undefined; // stripe-mock returns a fixture amount_due, so the cross-check warning is expected here
  const run = await buildMonthlyInvoices(new Date(Date.UTC(2026, 9, 15)), { db: prisma, stripe, workspaceIds: [ws.id] });
  console.warn = warn;
  const out = run.invoices[0];
  ok(out?.status === "created" && !out.stripeError && /^in_/.test(out.stripeInvoiceId ?? ""), "invoices.create + invoiceItems.create (incl. negative credit line) + finalizeInvoice accepted");
  const inv = await prisma.invoice.findUnique({ where: { id: out.invoiceId! } });
  // stripe-mock's finalize fixture has hosted_invoice_url: null; the hosted URL itself is asserted in [B].
  ok(inv?.stripeInvoiceId === out.stripeInvoiceId && inv?.pdfUrl === null, "local invoice stores the Stripe invoice id; pdfUrl mirrors Stripe's hosted_invoice_url (null in the fixture), never a made-up route");

  const paid = await engine.payInvoice(prisma, stripe, { workspaceId: ws.id, userId: owner.id, invoiceId: inv!.id });
  ok(!!paid.stripeStatus, "invoices.pay(payment_method) accepted");

  const listed = await engine.listPaymentMethods(prisma, stripe, ws.id);
  ok(Array.isArray(listed), "customers.listPaymentMethods(type=card) + customers.retrieve accepted");
  const anyRow = await prisma.paymentMethod.findFirst({ where: { workspaceId: ws.id } });
  if (anyRow) {
    await engine.deletePaymentMethod(prisma, stripe, ws.id, owner.id, anyRow.id);
    ok(true, "paymentMethods.detach accepted");
  }
}

// ─── [B] Stateful flows: emulator + real Postgres + real webhook handler ───────
async function sectionFlows(prisma: PrismaClient, emu: StripeEmulator) {
  console.log("\n[B] Card / top-up / invoice flows (MOCKED stateful Stripe, REAL Postgres, REAL webhook signatures)");
  Object.assign(process.env, {
    STRIPE_SECRET_KEY: "sk_test_emulator",
    STRIPE_API_BASE: emu.apiBase,
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_emulator",
  });
  (globalThis as any).prisma = prisma;
  const { billingRouter } = await import("../src/server/routers/billing");
  const { POST } = await import("../src/app/api/webhooks/stripe/route");
  const { buildMonthlyInvoices } = await import("../src/lib/billing/invoicing");
  const { getStripe } = await import("../src/lib/billing/stripe-client");
  const signer = new Stripe("sk_test_signer_only");

  const caller = (userId: string) =>
    billingRouter.createCaller({ db: prisma, session: { user: { id: userId }, expires: new Date(Date.now() + 3600_000).toISOString() }, headers: new Headers() } as any);

  let evtSeq = 0;
  async function deliver(type: string, object: unknown, opts: { id?: string; secret?: string; tamper?: boolean } = {}) {
    const id = opts.id ?? `evt_verify_${suffix}_${++evtSeq}`;
    createdEvents.push(id);
    const payload = JSON.stringify({ id, object: "event", api_version: "2026-10-28.endive", created: Math.floor(Date.now() / 1000), livemode: false, type, data: { object } });
    const header = signer.webhooks.generateTestHeaderString({ payload, secret: opts.secret ?? WEBHOOK_SECRET });
    const res = await POST(
      new Request("http://localhost/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": header, "content-type": "application/json" },
        body: opts.tamper ? payload.replace('"livemode":false', '"livemode":true') : payload,
      })
    );
    return { status: res.status, body: (await res.json()) as any, id };
  }

  const A = await seedWorkspace(prisma, "a");
  const B = await seedWorkspace(prisma, "b");
  const a = caller(A.owner.id);
  const b = caller(B.owner.id);

  // Config
  const cfg = await a.getConfig({ workspaceId: A.ws.id });
  ok(cfg.configured && cfg.mode === "test" && cfg.publishableKey === "pk_test_emulator", "getConfig reports configured test mode with the publishable key");

  // Add a card via SetupIntent
  const si1 = await a.createSetupIntent({ workspaceId: A.ws.id });
  const si1b = await a.createSetupIntent({ workspaceId: A.ws.id });
  const wsA = await prisma.workspace.findUnique({ where: { id: A.ws.id } });
  ok(!!wsA?.stripeCustomerId && emu.state.customers.size === 1, "one Stripe customer is created per workspace and reused");
  ok(emu.state.setupIntents.get(si1.setupIntentId)?.customer === wsA?.stripeCustomerId && si1b.setupIntentId !== si1.setupIntentId, "SetupIntents are created for the workspace customer");
  await rejects(() => a.confirmSetupIntent({ workspaceId: A.ws.id, setupIntentId: si1.setupIntentId }), "confirming an unconfirmed SetupIntent is refused", (e) => e.code === "PRECONDITION_FAILED");

  emu.succeedSetupIntent(si1.setupIntentId, { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2031, name: "Ada Lovelace" });
  const card1 = await a.confirmSetupIntent({ workspaceId: A.ws.id, setupIntentId: si1.setupIntentId });
  ok(card1.brand === "visa" && card1.last4 === "4242" && card1.expYear === 2031 && card1.isDefault && /^pm_emu/.test(card1.stripePaymentMethodId ?? ""), "card stored with Stripe's pm id + brand/last4/expiry only; first card is default");
  ok(emu.state.customers.get(wsA!.stripeCustomerId!)!.invoice_settings.default_payment_method === card1.stripePaymentMethodId, "default card is set on the Stripe customer");
  const cols = Object.keys(card1);
  ok(!cols.some((c) => /number|cvc|cvv|pan/i.test(c)), "the payment_methods row has no card-number/CVC columns");

  const replay = await deliver("setup_intent.succeeded", emu.state.setupIntents.get(si1.setupIntentId));
  ok(replay.status === 200 && (await prisma.paymentMethod.count({ where: { workspaceId: A.ws.id } })) === 1, "setup_intent.succeeded webhook is idempotent with the client confirmation (still 1 card)");

  // Cross-workspace attack: A tries to claim B's SetupIntent
  const siB = await b.createSetupIntent({ workspaceId: B.ws.id });
  emu.succeedSetupIntent(siB.setupIntentId, { brand: "amex", last4: "0005" });
  await rejects(() => a.confirmSetupIntent({ workspaceId: A.ws.id, setupIntentId: siB.setupIntentId }), "workspace A cannot attach workspace B's SetupIntent/card", (e) => e.code === "FORBIDDEN");
  const cardB = await b.confirmSetupIntent({ workspaceId: B.ws.id, setupIntentId: siB.setupIntentId });
  ok(cardB.brand === "amex", "workspace B saves its own card");

  // Second card, made default
  const si2 = await a.createSetupIntent({ workspaceId: A.ws.id });
  emu.succeedSetupIntent(si2.setupIntentId, { brand: "mastercard", last4: "4444" });
  await a.confirmSetupIntent({ workspaceId: A.ws.id, setupIntentId: si2.setupIntentId, setAsDefault: true });
  await prisma.paymentMethod.create({ data: { workspaceId: A.ws.id, brand: "visa", last4: "1111", expMonth: 1, expYear: 2030, stripePaymentMethodId: `pm_card_visa_1111_legacy_${suffix}` } });
  const listed = await a.listPaymentMethods({ workspaceId: A.ws.id });
  ok(listed.length === 2 && listed[0].last4 === "4444" && listed[0].isDefault && !listed.some((p) => p.last4 === "1111"), "cards are listed from Stripe; default follows Stripe; legacy fake rows are purged");

  // Top-up success: credits granted exactly once
  const startBalance = (await prisma.workspace.findUnique({ where: { id: A.ws.id } }))!.creditBalanceCents;
  const top = await a.createTopUp({ workspaceId: A.ws.id, amountCents: 2500 });
  const pi = emu.state.paymentIntents.get(top.paymentIntentId)!;
  ok(pi.amount === 2500 && pi.currency === "usd" && pi.customer === wsA!.stripeCustomerId && pi.payment_method === listed[0].stripePaymentMethodId, "top-up PaymentIntent: $25.00 USD, workspace customer, default saved card");
  const pre = await a.syncTopUp({ workspaceId: A.ws.id, invoiceId: top.invoiceId });
  ok(pre.invoiceStatus === "OPEN" && !pre.credited && pre.newBalanceCents === startBalance, "before Stripe confirms, no credits are granted");

  emu.succeedPaymentIntent(top.paymentIntentId);
  const piObj = emu.state.paymentIntents.get(top.paymentIntentId);
  const results = await Promise.all([
    deliver("payment_intent.succeeded", piObj),
    a.syncTopUp({ workspaceId: A.ws.id, invoiceId: top.invoiceId }),
    a.syncTopUp({ workspaceId: A.ws.id, invoiceId: top.invoiceId }),
    deliver("payment_intent.succeeded", piObj),
    a.syncTopUp({ workspaceId: A.ws.id, invoiceId: top.invoiceId }),
  ]);
  const balance = (await prisma.workspace.findUnique({ where: { id: A.ws.id } }))!.creditBalanceCents;
  ok(balance === startBalance + 2500, `5 concurrent confirmations (2 webhooks + 3 syncs) credit exactly once (${startBalance} → ${balance})`);
  ok(results.filter((r: any) => r.credited === true).length + 0 <= 1, "at most one caller reports crediting");
  const topInv = await prisma.invoice.findUnique({ where: { id: top.invoiceId } });
  ok(topInv?.status === "PAID" && topInv.kind === "TOP_UP" && topInv.pdfUrl?.startsWith("https://pay.stripe.com/receipts/"), "top-up invoice is PAID with the Stripe receipt URL");
  ok((await prisma.auditLogEntry.count({ where: { workspaceId: A.ws.id, action: "billing.credits_purchased" } })) === 1, "exactly one credits_purchased audit entry");

  const first = results[0] as { id: string };
  const dup = await deliver("payment_intent.succeeded", piObj, { id: first.id });
  ok(dup.status === 200 && dup.body.status === "duplicate", "redelivery of the same event id is acknowledged as duplicate");
  ok((await prisma.stripeEvent.findUnique({ where: { id: first.id } }))?.status === "PROCESSED", "processed event id is recorded in stripe_events");

  // Signature failures never reach the DB
  const forged = await deliver("payment_intent.succeeded", piObj, { secret: "whsec_attacker" });
  const tampered = await deliver("payment_intent.succeeded", piObj, { tamper: true });
  ok(forged.status === 400 && tampered.status === 400, "forged secret and tampered body are rejected (400)");
  ok((await prisma.stripeEvent.count({ where: { id: { in: [forged.id, tampered.id] } } })) === 0, "rejected deliveries leave no stripe_events rows");

  // Failed processing releases the claim so Stripe's retry can succeed
  const bad = await deliver("payment_intent.succeeded", { ...piObj, amount_received: 1, currency: "eur" });
  ok(bad.status === 500 && (await prisma.stripeEvent.count({ where: { id: bad.id } })) === 0, "a handler failure returns 500 and releases the event id for retry");

  // Top-up failure
  const top2 = await a.createTopUp({ workspaceId: A.ws.id, amountCents: 1000 });
  emu.failPaymentIntent(top2.paymentIntentId);
  const failRes = await deliver("payment_intent.payment_failed", emu.state.paymentIntents.get(top2.paymentIntentId));
  const top2Inv = await prisma.invoice.findUnique({ where: { id: top2.invoiceId } });
  ok(failRes.status === 200 && top2Inv?.status === "VOID" && /declined/.test(top2Inv.failureMessage ?? ""), "payment_intent.payment_failed voids the top-up with Stripe's decline message");
  ok((await prisma.workspace.findUnique({ where: { id: A.ws.id } }))!.creditBalanceCents === balance, "a declined top-up grants no credits");

  // Monthly invoices from UsageRecord
  const oct = (d: number) => new Date(Date.UTC(2026, 9, d));
  await prisma.usageRecord.createMany({
    data: [
      { workspaceId: A.ws.id, serviceId: "svc_a", resourceType: "CPU_ACTIVE_SECONDS", quantity: 1_000_000, periodStart: oct(2), periodEnd: oct(3) },
      { workspaceId: A.ws.id, serviceId: "svc_a", resourceType: "EGRESS_GB", quantity: 10, periodStart: oct(20), periodEnd: oct(21) },
      { workspaceId: A.ws.id, serviceId: "svc_a", resourceType: "EGRESS_GB", quantity: 999, periodStart: new Date(Date.UTC(2026, 10, 1)), periodEnd: new Date(Date.UTC(2026, 10, 2)) },
      { workspaceId: B.ws.id, serviceId: "svc_b", resourceType: "MEMORY_GIB_HOURS", quantity: 6000, periodStart: oct(5), periodEnd: oct(6) },
    ],
  });
  const stripe = getStripe();
  const run1 = await buildMonthlyInvoices(new Date(Date.UTC(2026, 9, 1)), { db: prisma, stripe, workspaceIds: [A.ws.id, B.ws.id] });
  const outA = run1.invoices.find((o) => o.workspaceId === A.ws.id)!;
  const outB = run1.invoices.find((o) => o.workspaceId === B.ws.id)!;
  ok(run1.periodKey === "usage:2026-10" && outA.totalCents === 2090, "workspace A October usage = $20.00 CPU + $0.90 egress (November usage excluded)");
  ok(outA.creditAppliedCents === 2090 && outA.amountDueCents === 0 && outA.stripeInvoiceId === null, "A's prepaid credits cover the invoice; nothing is sent to Stripe");
  const invA = await prisma.invoice.findUnique({ where: { id: outA.invoiceId! } });
  ok(invA?.status === "PAID" && (await prisma.workspace.findUnique({ where: { id: A.ws.id } }))!.creditBalanceCents === balance - 2090, "A's invoice is PAID and its credit balance is drawn down");
  ok(outB.totalCents === 3000 && outB.amountDueCents === 3000 && /^in_emu/.test(outB.stripeInvoiceId ?? ""), "B (no credits) gets a $30.00 Stripe invoice");
  const stripeInvB = emu.state.invoices.get(outB.stripeInvoiceId!)!;
  ok(stripeInvB.status === "open" && stripeInvB.amount_due === 3000 && stripeInvB.collection_method === "charge_automatically", "Stripe invoice finalized, charge_automatically, amount_due matches");
  const invB = await prisma.invoice.findUnique({ where: { id: outB.invoiceId! } });
  ok(invB?.pdfUrl === stripeInvB.hosted_invoice_url && invB.status === "OPEN", "B's invoice pdfUrl is the Stripe hosted invoice URL");

  const itemsBefore = emu.state.invoiceItems.length;
  const run2 = await buildMonthlyInvoices(new Date(Date.UTC(2026, 9, 28)), { db: prisma, stripe, workspaceIds: [A.ws.id, B.ws.id] });
  ok(run2.invoices.every((o) => o.status === "exists") && emu.state.invoiceItems.length === itemsBefore && emu.state.invoices.size === 1, "re-running the month is idempotent (no new invoices or Stripe items)");
  ok((await prisma.workspace.findUnique({ where: { id: A.ws.id } }))!.creditBalanceCents === balance - 2090, "credits are not applied twice");

  // Invoice webhooks + payInvoice
  const failedInv = await deliver("invoice.payment_failed", stripeInvB);
  ok(failedInv.status === 200 && (await prisma.invoice.findUnique({ where: { id: invB!.id } }))?.status === "PAST_DUE", "invoice.payment_failed marks the invoice PAST_DUE");
  const payRes = await b.payInvoice({ workspaceId: B.ws.id, invoiceId: invB!.id });
  ok(payRes.stripeStatus === "paid" && (await prisma.invoice.findUnique({ where: { id: invB!.id } }))?.status === "PAID", "payInvoice pays through Stripe and marks it PAID");
  const paidHook = await deliver("invoice.paid", { ...stripeInvB, status: "paid" });
  ok(paidHook.status === 200 && (await prisma.auditLogEntry.count({ where: { workspaceId: B.ws.id, action: "billing.invoice_paid" } })) === 1, "a later invoice.paid webhook is a no-op (single invoice_paid audit entry)");
  await rejects(() => b.payInvoice({ workspaceId: B.ws.id, invoiceId: invB!.id }), "paying a PAID invoice is refused", (e) => e.code === "BAD_REQUEST");
  await rejects(() => a.payInvoice({ workspaceId: A.ws.id, invoiceId: invB!.id }), "a workspace cannot pay another workspace's invoice", (e) => e.code === "NOT_FOUND");

  // Remove the default card → detached in Stripe, other card promoted
  const def = listed[0];
  await a.removeCard({ workspaceId: A.ws.id, paymentMethodId: def.id });
  const remaining = await prisma.paymentMethod.findMany({ where: { workspaceId: A.ws.id } });
  ok(emu.state.paymentMethods.get(def.stripePaymentMethodId!)!.customer === null, "removeCard detaches the PaymentMethod in Stripe");
  ok(remaining.length === 1 && remaining[0].isDefault && emu.state.customers.get(wsA!.stripeCustomerId!)!.invoice_settings.default_payment_method === remaining[0].stripePaymentMethodId, "remaining card is promoted to default locally and in Stripe");

  // Nothing Syncbay sent to Stripe looked like card data
  ok(!emu.requests.some((r) => /\b\d{13,19}\b/.test(JSON.stringify(r.body)) || /cvc|card\[number\]/i.test(JSON.stringify(r.body))), `none of the ${emu.requests.length} requests Syncbay sent to Stripe contained card numbers or CVCs`);
}

async function main() {
  if (!DB_URL) {
    console.log("SKIPPED: set TEST_DATABASE_URL to a migrated Postgres database");
    process.exit(0);
  }
  process.env.DATABASE_URL = DB_URL;
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const emu = await startStripeEmulator(Number(process.env.TEST_STRIPE_EMULATOR_PORT || 0));
  try {
    await sectionStripeMock(prisma);
    await sectionFlows(prisma, emu);
  } finally {
    await cleanup(prisma).catch((e) => console.error("cleanup failed:", e.message));
    await emu.close();
    await prisma.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
