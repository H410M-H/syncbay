"use client";

/**
 * Stripe Elements integration for the billing page.
 * Card details are entered into Stripe-hosted iframes (PaymentElement) and sent
 * straight to Stripe; Syncbay only receives the resulting SetupIntent id.
 */

import { useEffect, useState } from "react";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { trpc } from "@/lib/trpc-client";

const stripePromises = new Map<string, Promise<StripeJs | null>>();

function getStripeJs(publishableKey: string) {
  let p = stripePromises.get(publishableKey);
  if (!p) {
    p = loadStripe(publishableKey);
    stripePromises.set(publishableKey, p);
  }
  return p;
}

/**
 * Confirms a top-up PaymentIntent with the saved card, including any 3-D Secure
 * challenge. Returns the PaymentIntent status reported by Stripe.
 */
export async function confirmTopUpPayment(publishableKey: string, clientSecret: string, stripePaymentMethodId: string) {
  const stripe = await getStripeJs(publishableKey);
  if (!stripe) throw new Error("Stripe.js failed to load");
  const { error, paymentIntent } = await stripe.confirmCardPayment(clientSecret, { payment_method: stripePaymentMethodId });
  if (error) throw new Error(error.message || "Payment failed");
  return paymentIntent?.status ?? "unknown";
}

function SetupForm(props: {
  workspaceId: string;
  setupIntentId: string;
  setAsDefault: boolean;
  onSaved: (card: { brand: string; last4: string }) => void;
  onCancel: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const confirmMutation = trpc.billing.confirmSetupIntent.useMutation();
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError("");
    try {
      const { error: stripeError, setupIntent } = await stripe.confirmSetup({
        elements,
        redirect: "if_required",
        confirmParams: { return_url: window.location.href },
      });
      if (stripeError) throw new Error(stripeError.message || "Card could not be saved");
      if (setupIntent?.status !== "succeeded") throw new Error(`Card setup is ${setupIntent?.status ?? "incomplete"}`);
      const row = await confirmMutation.mutateAsync({
        workspaceId: props.workspaceId,
        setupIntentId: props.setupIntentId,
        setAsDefault: props.setAsDefault,
      });
      props.onSaved({ brand: row.brand, last4: row.last4 });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <PaymentElement options={{ layout: "tabs" }} />
      {error && (
        <div style={{ marginTop: "12px", color: "var(--status-crashed)", fontSize: "0.8125rem" }} role="alert">
          {error}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "18px" }}>
        <button type="button" onClick={props.onCancel} className="btn btn-secondary" disabled={submitting}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={!stripe || !elements || submitting}>
          {submitting ? "Saving with Stripe..." : "Save Card"}
        </button>
      </div>
    </form>
  );
}

/** Creates a SetupIntent and renders Stripe's PaymentElement for it. */
export function StripeCardSetup(props: {
  workspaceId: string;
  publishableKey: string;
  setAsDefault: boolean;
  onSaved: (card: { brand: string; last4: string }) => void;
  onCancel: () => void;
}) {
  const createSetupIntent = trpc.billing.createSetupIntent.useMutation();
  const [intent, setIntent] = useState<{ setupIntentId: string; clientSecret: string } | null>(null);
  const [error, setError] = useState("");
  const { workspaceId } = props;
  const { mutateAsync } = createSetupIntent;

  useEffect(() => {
    let cancelled = false;
    mutateAsync({ workspaceId })
      .then((res) => !cancelled && setIntent(res))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [workspaceId, mutateAsync]);

  if (error) {
    return (
      <div style={{ color: "var(--status-crashed)", fontSize: "0.875rem" }} role="alert">
        {error}
      </div>
    );
  }
  if (!intent) {
    return (
      <div style={{ padding: "24px 0", textAlign: "center", fontSize: "0.8125rem", color: "var(--text-muted)" }}>
        Connecting to Stripe...
      </div>
    );
  }
  return (
    <Elements stripe={getStripeJs(props.publishableKey)} options={{ clientSecret: intent.clientSecret, appearance: { theme: "night" } }}>
      <SetupForm
        workspaceId={props.workspaceId}
        setupIntentId={intent.setupIntentId}
        setAsDefault={props.setAsDefault}
        onSaved={props.onSaved}
        onCancel={props.onCancel}
      />
    </Elements>
  );
}
