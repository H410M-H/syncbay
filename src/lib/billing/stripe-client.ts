/**
 * Syncbay — Stripe client factory.
 *
 * Card data never touches Syncbay servers: the browser collects it with Stripe
 * Elements and confirms SetupIntents / PaymentIntents directly with Stripe.
 * The server only ever sees Stripe object ids (pm_…, seti_…, pi_…, in_…).
 *
 * Env:
 *   STRIPE_SECRET_KEY                  server key (sk_live_… / sk_test_… / rk_…)
 *   STRIPE_WEBHOOK_SECRET              signing secret for /api/webhooks/stripe (whsec_…)
 *   NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY browser key for Stripe Elements (pk_…)
 *   STRIPE_API_BASE                    optional API base override, e.g. http://localhost:12111
 *                                      for stripe-mock in tests. Unset = api.stripe.com.
 */

import Stripe from "stripe";

export class StripeNotConfiguredError extends Error {
  readonly code = "STRIPE_NOT_CONFIGURED";
  constructor(message = "Stripe is not configured on this deployment (STRIPE_SECRET_KEY is unset). Card payments are disabled.") {
    super(message);
    this.name = "StripeNotConfiguredError";
  }
}

export type StripeMode = "live" | "test" | "unconfigured";

export interface StripeClientConfig {
  secretKey: string;
  /** Full base URL override, e.g. "http://localhost:12111". */
  apiBase?: string;
}

let cached: { key: string; base: string; client: Stripe } | null = null;

function buildStripe(config: StripeClientConfig): Stripe {
  const options: ConstructorParameters<typeof Stripe>[1] = {
    maxNetworkRetries: 2,
    timeout: 20_000,
    appInfo: { name: "Syncbay", url: "https://syncbay.app" },
  };
  if (config.apiBase) {
    const url = new URL(config.apiBase);
    options.host = url.hostname;
    options.port = url.port || (url.protocol === "http:" ? "80" : "443");
    options.protocol = url.protocol === "http:" ? "http" : "https";
  }
  return new Stripe(config.secretKey, options);
}

/** Creates a Stripe client for an explicit config (used by tests and scripts). */
export function createStripeClient(config: StripeClientConfig): Stripe {
  return buildStripe(config);
}

/** Returns the process-wide Stripe client, or null when STRIPE_SECRET_KEY is unset. */
export function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  const base = process.env.STRIPE_API_BASE?.trim() || "";
  if (!cached || cached.key !== key || cached.base !== base) {
    cached = { key, base, client: buildStripe({ secretKey: key, apiBase: base || undefined }) };
  }
  return cached.client;
}

/** Like getStripe(), but throws StripeNotConfiguredError instead of returning null. */
export function requireStripe(): Stripe {
  const stripe = getStripe();
  if (!stripe) throw new StripeNotConfiguredError();
  return stripe;
}

export function getStripeMode(): StripeMode {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return "unconfigured";
  return key.includes("_live_") ? "live" : "test";
}

/** Public (browser-safe) Stripe settings for the billing UI. */
export function getPublicStripeConfig() {
  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.trim() || null;
  const mode = getStripeMode();
  return {
    mode,
    /** Server can talk to Stripe AND the browser can mount Elements. */
    configured: mode !== "unconfigured" && !!publishableKey,
    publishableKey: mode === "unconfigured" ? null : publishableKey,
    webhookConfigured: !!process.env.STRIPE_WEBHOOK_SECRET?.trim(),
  };
}

export type { Stripe };
