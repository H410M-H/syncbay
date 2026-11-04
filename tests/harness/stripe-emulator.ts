/**
 * A small STATEFUL Stripe API emulator (local HTTP) for billing flow tests.
 * stripe-mock validates request shapes but is stateless, so flows that read
 * back what they wrote (SetupIntent → PaymentMethod → Customer) need state.
 *
 * Implements only the endpoints Syncbay uses. `/_test/*` routes stand in for
 * what the browser does with Stripe.js (confirming a SetupIntent/PaymentIntent).
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

type Obj = Record<string, any>;

/** Parses Stripe's form encoding (a[b]=1, a[0]=x) into nested objects/arrays. */
function parseForm(body: string): Obj {
  const out: Obj = {};
  for (const [rawKey, value] of new URLSearchParams(body)) {
    const parts = rawKey.split(/\[|\]\[|\]/).filter((p) => p !== "");
    let cur: any = out;
    parts.forEach((p, i) => {
      const last = i === parts.length - 1;
      const nextIsIndex = !last && /^\d+$/.test(parts[i + 1]);
      if (last) cur[p] = value;
      else cur = cur[p] ??= nextIsIndex ? [] : {};
    });
  }
  return out;
}

export interface StripeEmulator {
  apiBase: string;
  requests: Array<{ method: string; path: string; body: Obj }>;
  state: { customers: Map<string, Obj>; paymentMethods: Map<string, Obj>; setupIntents: Map<string, Obj>; paymentIntents: Map<string, Obj>; invoices: Map<string, Obj>; invoiceItems: Obj[] };
  /** Emulates stripe.confirmSetup() in the browser: creates and attaches a card PaymentMethod. */
  succeedSetupIntent(id: string, card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number; name?: string }): Obj;
  succeedPaymentIntent(id: string): Obj;
  failPaymentIntent(id: string, message?: string): Obj;
  close(): Promise<void>;
}

export async function startStripeEmulator(port = 0): Promise<StripeEmulator> {
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}_emu${(++seq).toString().padStart(6, "0")}`;
  const now = () => Math.floor(Date.now() / 1000);
  const state = {
    customers: new Map<string, Obj>(),
    paymentMethods: new Map<string, Obj>(),
    setupIntents: new Map<string, Obj>(),
    paymentIntents: new Map<string, Obj>(),
    invoices: new Map<string, Obj>(),
    charges: new Map<string, Obj>(),
    invoiceItems: [] as Obj[],
  };
  const requests: StripeEmulator["requests"] = [];
  const idempotency = new Map<string, Obj>();

  const notFound = (what: string, id: string) => ({
    status: 404,
    body: { error: { type: "invalid_request_error", code: "resource_missing", message: `No such ${what}: '${id}'` } },
  });

  function route(method: string, path: string, body: Obj): { status: number; body: Obj } {
    let m: RegExpMatchArray | null;
    if (method === "POST" && path === "/v1/customers") {
      const c = { id: nextId("cus"), object: "customer", name: body.name ?? null, metadata: body.metadata ?? {}, invoice_settings: { default_payment_method: null }, created: now() };
      state.customers.set(c.id, c);
      return { status: 200, body: c };
    }
    if ((m = path.match(/^\/v1\/customers\/([^/]+)$/))) {
      const c = state.customers.get(m[1]);
      if (!c) return notFound("customer", m[1]);
      if (method === "POST" && body.invoice_settings?.default_payment_method !== undefined) {
        const pm = state.paymentMethods.get(body.invoice_settings.default_payment_method);
        if (!pm || pm.customer !== c.id) return { status: 400, body: { error: { type: "invalid_request_error", message: "PaymentMethod not attached to customer" } } };
        c.invoice_settings.default_payment_method = pm.id;
      }
      return { status: 200, body: c };
    }
    if (method === "GET" && (m = path.match(/^\/v1\/customers\/([^/]+)\/payment_methods$/))) {
      const data = [...state.paymentMethods.values()].filter((pm) => pm.customer === m![1]);
      return { status: 200, body: { object: "list", data, has_more: false, url: path } };
    }
    if (method === "POST" && path === "/v1/setup_intents") {
      const si = { id: nextId("seti"), object: "setup_intent", customer: body.customer ?? null, status: "requires_payment_method", usage: body.usage, payment_method: null, metadata: body.metadata ?? {}, allowed_payment_method_types: body.allowed_payment_method_types };
      (si as Obj).client_secret = `${si.id}_secret_${Math.random().toString(36).slice(2)}`;
      state.setupIntents.set(si.id, si);
      return { status: 200, body: si };
    }
    if (method === "GET" && (m = path.match(/^\/v1\/setup_intents\/([^/]+)$/))) {
      const si = state.setupIntents.get(m[1]);
      return si ? { status: 200, body: si } : notFound("setup_intent", m[1]);
    }
    if ((m = path.match(/^\/v1\/payment_methods\/([^/]+)(\/detach)?$/))) {
      const pm = state.paymentMethods.get(m[1]);
      if (!pm) return notFound("payment_method", m[1]);
      if (method === "POST" && m[2]) {
        pm.customer = null;
        for (const c of state.customers.values()) if (c.invoice_settings.default_payment_method === pm.id) c.invoice_settings.default_payment_method = null;
      }
      return { status: 200, body: pm };
    }
    if (method === "POST" && path === "/v1/payment_intents") {
      const pm = body.payment_method ? state.paymentMethods.get(body.payment_method) : null;
      if (body.payment_method && (!pm || pm.customer !== body.customer)) {
        return { status: 400, body: { error: { type: "invalid_request_error", message: "PaymentMethod does not belong to customer" } } };
      }
      const pi = { id: nextId("pi"), object: "payment_intent", amount: Number(body.amount), amount_received: 0, currency: body.currency, customer: body.customer ?? null, payment_method: body.payment_method ?? null, status: "requires_confirmation", metadata: body.metadata ?? {}, latest_charge: null, last_payment_error: null, description: body.description ?? null };
      (pi as Obj).client_secret = `${pi.id}_secret_${Math.random().toString(36).slice(2)}`;
      state.paymentIntents.set(pi.id, pi);
      return { status: 200, body: pi };
    }
    if (method === "GET" && (m = path.match(/^\/v1\/payment_intents\/([^/]+)$/))) {
      const pi = state.paymentIntents.get(m[1]);
      return pi ? { status: 200, body: pi } : notFound("payment_intent", m[1]);
    }
    if (method === "GET" && (m = path.match(/^\/v1\/charges\/([^/]+)$/))) {
      const ch = state.charges.get(m[1]);
      return ch ? { status: 200, body: ch } : notFound("charge", m[1]);
    }
    if (method === "POST" && path === "/v1/invoices") {
      const inv = { id: nextId("in"), object: "invoice", customer: body.customer, status: "draft", currency: body.currency, collection_method: body.collection_method, auto_advance: body.auto_advance === "true", metadata: body.metadata ?? {}, amount_due: 0, hosted_invoice_url: null, description: body.description ?? null };
      state.invoices.set(inv.id, inv);
      return { status: 200, body: inv };
    }
    if (method === "POST" && path === "/v1/invoiceitems") {
      const inv = state.invoices.get(body.invoice);
      if (!inv || inv.status !== "draft") return { status: 400, body: { error: { type: "invalid_request_error", message: "Invoice is not a draft" } } };
      const item = { id: nextId("ii"), object: "invoiceitem", invoice: body.invoice, customer: body.customer, amount: Number(body.amount), currency: body.currency, description: body.description };
      state.invoiceItems.push(item);
      return { status: 200, body: item };
    }
    if (method === "POST" && (m = path.match(/^\/v1\/invoices\/([^/]+)\/(finalize|pay)$/))) {
      const inv = state.invoices.get(m[1]);
      if (!inv) return notFound("invoice", m[1]);
      if (m[2] === "finalize") {
        inv.amount_due = state.invoiceItems.filter((i) => i.invoice === inv.id).reduce((s, i) => s + i.amount, 0);
        inv.status = "open";
        inv.hosted_invoice_url = `https://invoice.stripe.com/i/acct_emu/${inv.id}`;
      } else {
        const pm = state.paymentMethods.get(body.payment_method);
        if (!pm || pm.customer !== inv.customer) return { status: 402, body: { error: { type: "card_error", code: "card_declined", message: "Your card was declined." } } };
        inv.status = "paid";
      }
      return { status: 200, body: inv };
    }
    return { status: 404, body: { error: { type: "invalid_request_error", message: `Unrecognized request URL (${method}: ${path})` } } };
  }

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url!, "http://x");
      const body = parseForm(raw);
      requests.push({ method: req.method!, path: url.pathname, body });
      const send = (status: number, payload: Obj) => {
        res.writeHead(status, { "content-type": "application/json", "request-id": `req_${seq}` });
        res.end(JSON.stringify(payload));
      };
      if (!String(req.headers.authorization || "").startsWith("Bearer sk_test_")) {
        return send(401, { error: { type: "invalid_request_error", message: "Invalid API Key provided" } });
      }
      const idemKey = req.headers["idempotency-key"] as string | undefined;
      if (idemKey && req.method === "POST" && idempotency.has(idemKey)) {
        const cached = idempotency.get(idemKey)!;
        return send(cached.status, cached.body);
      }
      const out = route(req.method!, url.pathname, body);
      if (idemKey && req.method === "POST" && out.status < 500) idempotency.set(idemKey, out);
      send(out.status, out.body);
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const actualPort = (server.address() as AddressInfo).port;

  return {
    apiBase: `http://127.0.0.1:${actualPort}`,
    requests,
    state,
    succeedSetupIntent(id, card = {}) {
      const si = state.setupIntents.get(id)!;
      const pm = {
        id: nextId("pm"),
        object: "payment_method",
        type: "card",
        customer: si.customer,
        billing_details: { name: card.name ?? null },
        card: { brand: card.brand ?? "visa", last4: card.last4 ?? "4242", exp_month: card.exp_month ?? 12, exp_year: card.exp_year ?? 2034 },
      };
      state.paymentMethods.set(pm.id, pm);
      si.payment_method = pm.id;
      si.status = "succeeded";
      return si;
    },
    succeedPaymentIntent(id) {
      const pi = state.paymentIntents.get(id)!;
      const ch = { id: nextId("ch"), object: "charge", receipt_url: `https://pay.stripe.com/receipts/emu/${pi.id}` };
      state.charges.set(ch.id, ch);
      Object.assign(pi, { status: "succeeded", amount_received: pi.amount, latest_charge: ch.id, last_payment_error: null });
      return pi;
    },
    failPaymentIntent(id, message = "Your card was declined.") {
      const pi = state.paymentIntents.get(id)!;
      Object.assign(pi, { status: "requires_payment_method", last_payment_error: { type: "card_error", code: "card_declined", message } });
      return pi;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
