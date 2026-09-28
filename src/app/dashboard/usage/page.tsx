"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc-client";
import Link from "next/link";
import { useDashboard } from "../dashboard-shell";
import {
  detectCardBrand,
  formatCardNumber,
  formatExpiry,
  getBrandMetadata,
  type CardBrand,
} from "@/lib/billing/payment-engine";

export default function UsagePage() {
  const dashboard = useDashboard();
  const { data: fetchedWorkspaces } = trpc.workspace.list.useQuery();
  const workspaces = dashboard?.workspaces || fetchedWorkspaces;
  const [selectedWsId, setSelectedWsId] = useState<string>("");

  const activeWorkspace =
    workspaces?.find((w) => w.id === (selectedWsId || dashboard?.currentWorkspace?.id)) ||
    dashboard?.currentWorkspace ||
    workspaces?.[0];

  const workspaceId = activeWorkspace?.id;

  // Usage Telemetry Query
  const {
    data: usage,
    isLoading: usageLoading,
  } = trpc.metrics.workspaceUsage.useQuery(
    { workspaceId: workspaceId! },
    { enabled: !!workspaceId }
  );

  // Billing & Payment Queries
  const {
    data: billingSummary,
    refetch: refetchBillingSummary,
    isLoading: summaryLoading,
  } = trpc.billing.getBillingSummary.useQuery(
    { workspaceId: workspaceId! },
    { enabled: !!workspaceId }
  );

  const {
    data: paymentMethods,
    refetch: refetchPaymentMethods,
    isLoading: methodsLoading,
  } = trpc.billing.listPaymentMethods.useQuery(
    { workspaceId: workspaceId! },
    { enabled: !!workspaceId }
  );

  const {
    data: invoices,
    refetch: refetchInvoices,
    isLoading: invoicesLoading,
  } = trpc.billing.listInvoices.useQuery(
    { workspaceId: workspaceId! },
    { enabled: !!workspaceId }
  );

  // Billing Mutations
  const addCardMutation = trpc.billing.addCard.useMutation();
  const setDefaultMutation = trpc.billing.setDefaultCard.useMutation();
  const removeCardMutation = trpc.billing.removeCard.useMutation();
  const addCreditsMutation = trpc.billing.addCredits.useMutation();
  const payInvoiceMutation = trpc.billing.payInvoice.useMutation();

  // Role check
  const currentMember = activeWorkspace?.members?.find((m: any) => m.userId === dashboard?.user?.id);
  const userRole = currentMember?.role || (activeWorkspace?.isPersonal ? "OWNER" : "MEMBER");
  const canManageBilling = userRole === "OWNER" || userRole === "ADMIN";

  // Modal & interaction state
  const [showAddCardModal, setShowAddCardModal] = useState(false);
  const [showTopUpModal, setShowTopUpModal] = useState(false);
  const [topUpAmountDollars, setTopUpAmountDollars] = useState(25);
  const [customTopUpInput, setCustomTopUpInput] = useState("");
  const [selectedPaymentMethodId, setSelectedPaymentMethodId] = useState<string>("");
  const [billingNotice, setBillingNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // Add Card form state
  const [cardholderName, setCardholderName] = useState("");
  const [cardNumberRaw, setCardNumberRaw] = useState("");
  const [expMonth, setExpMonth] = useState<number>(new Date().getMonth() + 1);
  const [expYear, setExpYear] = useState<number>(new Date().getFullYear());
  const [cvc, setCvc] = useState("");
  const [billingZip, setBillingZip] = useState("");
  const [setAsDefault, setSetAsDefault] = useState(true);
  const [formError, setFormError] = useState("");

  // Invoice payment loading state
  const [payingInvoiceId, setPayingInvoiceId] = useState<string | null>(null);

  const costDollars = (usage?.estimatedCostCents ?? 0) / 100;
  const capDollars = activeWorkspace?.spendingCapCents ? activeWorkspace.spendingCapCents / 100 : null;
  const spendPercent = capDollars && capDollars > 0 ? Math.min(100, (costDollars / capDollars) * 100) : 0;
  const isNearCap = capDollars ? spendPercent >= 80 : false;

  const totals = usage?.totals || {
    CPU_ACTIVE_SECONDS: 0,
    MEMORY_GIB_HOURS: 0,
    DISK_GB_HOURS: 0,
    EGRESS_GB: 0,
    DB_STORAGE_GB: 0,
    BUCKET_STORAGE_GB: 0,
  };

  const cpuCost = (totals.CPU_ACTIVE_SECONDS * 0.00002).toFixed(2);
  const memCost = (totals.MEMORY_GIB_HOURS * 0.005).toFixed(2);
  const diskCost = (totals.DISK_GB_HOURS * 0.0001).toFixed(2);
  const egressCost = (totals.EGRESS_GB * 0.09).toFixed(2);
  const dbCost = (totals.DB_STORAGE_GB * 0.02).toFixed(2);
  const bucketCost = (totals.BUCKET_STORAGE_GB * 0.015).toFixed(2);

  const creditBalanceDollars = ((billingSummary?.creditBalanceCents ?? 0) / 100).toFixed(2);

  // Card validation on client for live preview
  const detectedBrand = detectCardBrand(cardNumberRaw);
  const brandMeta = getBrandMetadata(detectedBrand);
  const displayFormattedCardNumber = formatCardNumber(cardNumberRaw) || "•••• •••• •••• ••••";

  // Handlers
  const handleAddCard = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspaceId) return;
    setFormError("");

    try {
      await addCardMutation.mutateAsync({
        workspaceId,
        cardNumber: cardNumberRaw,
        expMonth,
        expYear,
        cvc,
        cardholderName,
        billingZip: billingZip || undefined,
        setAsDefault,
      });

      setBillingNotice({
        type: "success",
        message: `Card ending in ${cardNumberRaw.slice(-4)} added successfully!`,
      });
      setTimeout(() => setBillingNotice(null), 5000);

      // Reset form
      setShowAddCardModal(false);
      setCardholderName("");
      setCardNumberRaw("");
      setCvc("");
      setBillingZip("");

      // Refetch
      await refetchPaymentMethods();
      await refetchBillingSummary();
    } catch (err: any) {
      setFormError(err.message || "Failed to add card. Please check your details.");
    }
  };

  const handleSetDefaultCard = async (methodId: string) => {
    if (!workspaceId) return;
    try {
      await setDefaultMutation.mutateAsync({ workspaceId, paymentMethodId: methodId });
      setBillingNotice({ type: "success", message: "Default payment card updated." });
      setTimeout(() => setBillingNotice(null), 4000);
      await refetchPaymentMethods();
      await refetchBillingSummary();
    } catch (err: any) {
      setBillingNotice({ type: "error", message: err.message || "Failed to update default card." });
    }
  };

  const handleRemoveCard = async (methodId: string, last4: string) => {
    if (!workspaceId) return;
    if (!confirm(`Are you sure you want to remove card ending in •••• ${last4}?`)) return;

    try {
      await removeCardMutation.mutateAsync({ workspaceId, paymentMethodId: methodId });
      setBillingNotice({ type: "success", message: `Card ending in •••• ${last4} removed.` });
      setTimeout(() => setBillingNotice(null), 4000);
      await refetchPaymentMethods();
      await refetchBillingSummary();
    } catch (err: any) {
      setBillingNotice({ type: "error", message: err.message || "Failed to remove card." });
    }
  };

  const handleExecuteTopUp = async () => {
    if (!workspaceId) return;
    const amount = customTopUpInput ? Math.round(parseFloat(customTopUpInput) * 100) : topUpAmountDollars * 100;
    if (isNaN(amount) || amount < 500) {
      setBillingNotice({ type: "error", message: "Minimum top-up is $5.00." });
      return;
    }

    try {
      const res = await addCreditsMutation.mutateAsync({
        workspaceId,
        amountCents: amount,
        paymentMethodId: selectedPaymentMethodId || undefined,
      });

      setShowTopUpModal(false);
      setCustomTopUpInput("");
      setBillingNotice({
        type: "success",
        message: `Successfully purchased $${(amount / 100).toFixed(2)} in compute credits! Receipt: ${res.charge.receiptNumber}`,
      });
      setTimeout(() => setBillingNotice(null), 6000);

      await refetchBillingSummary();
      await refetchInvoices();
    } catch (err: any) {
      setBillingNotice({ type: "error", message: err.message || "Top-up failed. Please check your card." });
    }
  };

  const handlePayInvoice = async (invoiceId: string) => {
    if (!workspaceId) return;
    setPayingInvoiceId(invoiceId);

    try {
      const res = await payInvoiceMutation.mutateAsync({
        workspaceId,
        invoiceId,
      });

      setBillingNotice({
        type: "success",
        message: `Invoice #${invoiceId.slice(0, 8)} paid successfully! Receipt: ${res.receiptNumber}`,
      });
      setTimeout(() => setBillingNotice(null), 6000);

      await refetchInvoices();
      await refetchBillingSummary();
    } catch (err: any) {
      setBillingNotice({
        type: "error",
        message: err.message || "Failed to pay invoice. Please try another card.",
      });
    } finally {
      setPayingInvoiceId(null);
    }
  };

  return (
    <div className="fade-in" style={{ maxWidth: "1000px", margin: "0 auto", paddingBottom: "40px" }}>
      {/* ── Page Header ── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Usage &amp; Billing</h1>
          <p className="page-subtitle">
            Real-time infrastructure compute telemetry, credit top-up, card payments, and invoices.
          </p>
        </div>

        {/* Workspace selector */}
        {workspaces && workspaces.length > 1 && (
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>Workspace:</span>
            <select
              className="input"
              style={{ width: "auto", padding: "6px 12px", fontSize: "0.875rem" }}
              value={selectedWsId || activeWorkspace?.id}
              onChange={(e) => {
                setSelectedWsId(e.target.value);
                dashboard?.setCurrentWorkspaceId(e.target.value);
              }}
            >
              {workspaces.map((ws) => (
                <option key={ws.id} value={ws.id}>
                  {ws.name} ({ws.slug})
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* ── Global Billing Notification Banner ── */}
      {billingNotice && (
        <div
          style={{
            marginBottom: "20px",
            padding: "14px 18px",
            borderRadius: "var(--radius-md)",
            background:
              billingNotice.type === "success"
                ? "rgba(34, 197, 94, 0.15)"
                : "rgba(239, 68, 68, 0.15)",
            border: `1px solid ${
              billingNotice.type === "success"
                ? "rgba(34, 197, 94, 0.4)"
                : "rgba(239, 68, 68, 0.4)"
            }`,
            color: billingNotice.type === "success" ? "#4ade80" : "#f87171",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: "0.875rem",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span>{billingNotice.type === "success" ? "✅" : "⚠️"}</span>
            <span>{billingNotice.message}</span>
          </div>
          <button
            onClick={() => setBillingNotice(null)}
            className="btn btn-ghost btn-sm"
            style={{ padding: "2px 8px", color: "inherit" }}
          >
            ✕
          </button>
        </div>
      )}

      {/* ── Plans & Fair Value Banner ── */}
      <div
        className="card"
        style={{
          marginBottom: "24px",
          background: "linear-gradient(135deg, rgba(99,102,241,0.12), rgba(6,182,212,0.12))",
          borderColor: "var(--border-emphasis)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "16px",
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <span style={{ fontSize: "20px" }}>💎</span>
            <h3 style={{ fontSize: "1.1rem", fontWeight: 700, margin: 0 }}>
              Syncbay Fair Value Cloud Guarantee
            </h3>
            <span className="badge badge-active" style={{ fontSize: "0.65rem" }}>
              Zero Seat Tax
            </span>
          </div>
          <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", margin: 0 }}>
            Save $1,200+/yr vs Vercel Pro and avoid Railway compute markups. Unlimited team seats included free on Pro ($18/mo).
          </p>
        </div>

        <Link href="/pricing" className="btn btn-primary btn-sm">
          Compare All Plans &amp; Tiers →
        </Link>
      </div>

      {/* ── Spending Cap Gauge Card with 80% Alert Threshold ── */}
      <div
        className="card"
        style={{
          marginBottom: "24px",
          background: isNearCap ? "rgba(239, 68, 68, 0.08)" : "var(--bg-card)",
          borderColor: isNearCap ? "rgba(239, 68, 68, 0.4)" : "var(--border-subtle)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px" }}>
          <div>
            <h3 style={{ fontSize: "1.2rem", fontWeight: 700 }}>
              Monthly Spending Cap
            </h3>
            <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", marginTop: "4px" }}>
              Enforces hard limits to protect against runaway container compute or egress bills.
            </p>
          </div>

          <Link href="/dashboard/settings" className="btn btn-secondary btn-sm">
            ⚙️ Edit Cap in Settings
          </Link>
        </div>

        {capDollars ? (
          <div>
            <div style={{ display: "flex", alignItems: "baseline", gap: "12px", marginBottom: "12px" }}>
              <span style={{ fontSize: "2.25rem", fontWeight: 800, color: isNearCap ? "#f87171" : "var(--text-primary)" }}>
                ${costDollars.toFixed(2)}
              </span>
              <span style={{ color: "var(--text-muted)", fontSize: "1rem" }}>
                of ${capDollars.toFixed(2)} budget limit ({spendPercent.toFixed(1)}%)
              </span>
            </div>

            {/* Visual Gauge Progress Bar */}
            <div
              style={{
                width: "100%",
                height: "16px",
                background: "var(--bg-overlay)",
                borderRadius: "999px",
                overflow: "hidden",
                border: "1px solid var(--border-subtle)",
                marginBottom: "12px",
              }}
            >
              <div
                style={{
                  width: `${spendPercent}%`,
                  height: "100%",
                  background: isNearCap
                    ? "linear-gradient(90deg, #f59e0b, #ef4444)"
                    : "linear-gradient(90deg, var(--brand-primary), var(--brand-accent))",
                  borderRadius: "999px",
                  transition: "width 0.4s ease",
                }}
              />
            </div>

            {/* 80% Threshold Warning Banner */}
            {isNearCap ? (
              <div
                style={{
                  padding: "14px 16px",
                  borderRadius: "var(--radius-md)",
                  background: "rgba(239, 68, 68, 0.15)",
                  border: "1px solid rgba(239, 68, 68, 0.35)",
                  color: "#fca5a5",
                  fontSize: "0.875rem",
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                }}
              >
                <span style={{ fontSize: "20px" }}>🚨</span>
                <div>
                  <strong>Spending Cap Alert (80%+ Threshold Exceeded):</strong> This workspace has reached{" "}
                  <strong>{spendPercent.toFixed(1)}%</strong> of its monthly limit. When 100% is reached, services will
                  scale to zero and reject incoming requests until the next billing cycle or until the cap is increased.
                </div>
              </div>
            ) : (
              <div style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>
                Healthy status: Workspace is operating comfortably within its monthly budget limit.
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: "1.75rem", fontWeight: 800 }}>${costDollars.toFixed(2)}</div>
              <p style={{ fontSize: "0.8125rem", color: "var(--text-muted)", marginTop: "2px" }}>
                No spending cap set. Compute resources will scale according to demand.
              </p>
            </div>
            <Link href="/dashboard/settings" className="btn btn-primary btn-sm">
              Set Spending Cap
            </Link>
          </div>
        )}
      </div>

      {/* ── Section: Prepaid Cloud Credits & Payment Cards on File ── */}
      <div className="grid-2" style={{ gap: "20px", marginBottom: "28px" }}>
        {/* Prepaid Cloud Balance Card */}
        <div className="card" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "12px" }}>
              <div>
                <h3 style={{ fontSize: "1.1rem", fontWeight: 700, margin: 0 }}>
                  Prepaid Compute Credits
                </h3>
                <p style={{ fontSize: "0.8125rem", color: "var(--text-secondary)", marginTop: "2px" }}>
                  Drawn down automatically for container CPU, RAM, and databases.
                </p>
              </div>
              <span className="badge badge-active" style={{ fontSize: "0.7rem" }}>
                Active Balance
              </span>
            </div>

            <div style={{ margin: "16px 0" }}>
              <div style={{ fontSize: "2.25rem", fontWeight: 800, color: "var(--brand-primary)", letterSpacing: "-0.03em" }}>
                ${creditBalanceDollars}
              </div>
              <div style={{ fontSize: "0.8125rem", color: "var(--text-muted)", marginTop: "4px" }}>
                Zero interest, non-expiring prepaid cloud balance.
              </div>
            </div>

            {/* Quick Top-up amount buttons */}
            <div style={{ marginTop: "16px" }}>
              <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)", textTransform: "uppercase", fontWeight: 600 }}>
                Instant Top-Up Presets:
              </span>
              <div style={{ display: "flex", gap: "8px", marginTop: "8px", flexWrap: "wrap" }}>
                {[10, 25, 50, 100].map((amt) => (
                  <button
                    key={amt}
                    type="button"
                    onClick={() => {
                      setTopUpAmountDollars(amt);
                      setCustomTopUpInput("");
                      setShowTopUpModal(true);
                    }}
                    disabled={!canManageBilling}
                    className="btn btn-secondary btn-sm"
                    style={{ flex: 1, minWidth: "60px", justifyContent: "center", fontWeight: 700 }}
                  >
                    +${amt}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div style={{ marginTop: "20px", paddingTop: "14px", borderTop: "1px solid var(--border-subtle)" }}>
            <button
              onClick={() => {
                setShowTopUpModal(true);
              }}
              disabled={!canManageBilling}
              className="btn btn-primary btn-sm"
              style={{ width: "100%", justifyContent: "center" }}
            >
              💳 Add Cloud Credits with Card →
            </button>
            {!canManageBilling && (
              <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", textAlign: "center", marginTop: "6px" }}>
                Only workspace Owners and Admins can purchase credits.
              </p>
            )}
          </div>
        </div>

        {/* Payment Methods & Cards Card */}
        <div className="card" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "12px" }}>
              <div>
                <h3 style={{ fontSize: "1.1rem", fontWeight: 700, margin: 0 }}>
                  Payment Cards on File
                </h3>
                <p style={{ fontSize: "0.8125rem", color: "var(--text-secondary)", marginTop: "2px" }}>
                  Securely stored for automated settlement and top-ups.
                </p>
              </div>

              {canManageBilling && (
                <button
                  onClick={() => setShowAddCardModal(true)}
                  className="btn btn-secondary btn-sm"
                >
                  ＋ Add Card
                </button>
              )}
            </div>

            {methodsLoading ? (
              <div style={{ padding: "24px 0", textAlign: "center" }}>
                <div className="loading-bar" style={{ width: "120px", margin: "0 auto 8px" }} />
                <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>Loading cards...</span>
              </div>
            ) : !paymentMethods || paymentMethods.length === 0 ? (
              <div style={{ padding: "20px 12px", background: "var(--bg-overlay)", borderRadius: "var(--radius-md)", border: "1px dashed var(--border-default)", textAlign: "center" }}>
                <div style={{ fontSize: "24px", marginBottom: "6px" }}>💳</div>
                <div style={{ fontWeight: 600, fontSize: "0.875rem", color: "var(--text-primary)" }}>
                  No Payment Card on File
                </div>
                <div style={{ fontSize: "0.8125rem", color: "var(--text-secondary)", marginTop: "4px" }}>
                  Add a Visa, Mastercard, American Express, or Discover card to enable instant top-up.
                </div>
                {canManageBilling && (
                  <button
                    onClick={() => setShowAddCardModal(true)}
                    className="btn btn-primary btn-sm"
                    style={{ marginTop: "12px" }}
                  >
                    Add Credit or Debit Card
                  </button>
                )}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {paymentMethods.map((pm: any) => {
                  const bMeta = getBrandMetadata(pm.brand as CardBrand);
                  return (
                    <div
                      key={pm.id}
                      style={{
                        padding: "10px 14px",
                        background: "var(--bg-overlay)",
                        borderRadius: "var(--radius-md)",
                        border: pm.isDefault ? "1px solid var(--border-emphasis)" : "1px solid var(--border-subtle)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        flexWrap: "wrap",
                        gap: "10px",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                        <span
                          style={{
                            padding: "4px 8px",
                            borderRadius: "6px",
                            background: bMeta.color,
                            color: "#fff",
                            fontSize: "0.75rem",
                            fontWeight: 700,
                            letterSpacing: "0.05em",
                          }}
                        >
                          {bMeta.name.toUpperCase()}
                        </span>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: "0.875rem", fontFamily: "monospace" }}>
                            •••• {pm.last4}
                          </div>
                          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                            Exp: {formatExpiry(pm.expMonth, pm.expYear)} · {pm.cardholderName}
                          </div>
                        </div>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        {pm.isDefault ? (
                          <span className="badge badge-active" style={{ fontSize: "0.65rem" }}>
                            Default
                          </span>
                        ) : canManageBilling ? (
                          <button
                            type="button"
                            onClick={() => handleSetDefaultCard(pm.id)}
                            disabled={setDefaultMutation.isPending}
                            className="btn btn-ghost btn-sm"
                            style={{ fontSize: "0.75rem", padding: "4px 8px" }}
                          >
                            Set Default
                          </button>
                        ) : null}

                        {canManageBilling && (
                          <button
                            type="button"
                            onClick={() => handleRemoveCard(pm.id, pm.last4)}
                            disabled={removeCardMutation.isPending}
                            className="btn btn-ghost btn-sm"
                            style={{ color: "var(--status-crashed)", fontSize: "0.75rem", padding: "4px 8px" }}
                            title="Remove card"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div style={{ marginTop: "16px", fontSize: "0.75rem", color: "var(--text-muted)", display: "flex", alignItems: "center", gap: "6px" }}>
            <span>🔒</span>
            <span>PCI-DSS compliant tokenization. Raw numbers are never stored in database.</span>
          </div>
        </div>
      </div>

      {/* ── Resource Breakdown Grid ── */}
      <h3 style={{ marginBottom: "16px" }}>Telemetry Breakdown by Resource</h3>

      {usageLoading ? (
        <div style={{ textAlign: "center", padding: "48px" }}>
          <div className="loading-bar" style={{ width: "200px", margin: "0 auto 16px" }} />
          <p style={{ color: "var(--text-muted)" }}>Loading telemetry data...</p>
        </div>
      ) : (
        <div className="grid-3" style={{ marginBottom: "36px" }}>
          {/* CPU Active Seconds */}
          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
              <span className="stat-label">Compute (vCPU)</span>
              <span style={{ fontSize: "18px" }}>⚡</span>
            </div>
            <div className="stat-value" style={{ fontSize: "1.6rem" }}>
              {totals.CPU_ACTIVE_SECONDS.toLocaleString()} s
            </div>
            <div style={{ fontSize: "0.8125rem", color: "var(--text-muted)", marginTop: "4px" }}>
              Rate: $0.00002 / active-sec
            </div>
            <div style={{ marginTop: "12px", paddingTop: "10px", borderTop: "1px solid var(--border-subtle)", display: "flex", justifyContent: "space-between", fontWeight: 600 }}>
              <span style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>Est. Cost:</span>
              <span style={{ color: "var(--brand-accent)" }}>${cpuCost}</span>
            </div>
          </div>

          {/* Memory GiB-Hours */}
          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
              <span className="stat-label">Memory (RAM)</span>
              <span style={{ fontSize: "18px" }}>🧠</span>
            </div>
            <div className="stat-value" style={{ fontSize: "1.6rem" }}>
              {totals.MEMORY_GIB_HOURS.toFixed(2)} GiB-h
            </div>
            <div style={{ fontSize: "0.8125rem", color: "var(--text-muted)", marginTop: "4px" }}>
              Rate: $0.005 / GiB-hour
            </div>
            <div style={{ marginTop: "12px", paddingTop: "10px", borderTop: "1px solid var(--border-subtle)", display: "flex", justifyContent: "space-between", fontWeight: 600 }}>
              <span style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>Est. Cost:</span>
              <span style={{ color: "var(--brand-accent)" }}>${memCost}</span>
            </div>
          </div>

          {/* Disk GB-Hours */}
          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
              <span className="stat-label">Persistent Volumes</span>
              <span style={{ fontSize: "18px" }}>💾</span>
            </div>
            <div className="stat-value" style={{ fontSize: "1.6rem" }}>
              {totals.DISK_GB_HOURS.toFixed(2)} GB-h
            </div>
            <div style={{ fontSize: "0.8125rem", color: "var(--text-muted)", marginTop: "4px" }}>
              Rate: $0.0001 / GB-hour
            </div>
            <div style={{ marginTop: "12px", paddingTop: "10px", borderTop: "1px solid var(--border-subtle)", display: "flex", justifyContent: "space-between", fontWeight: 600 }}>
              <span style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>Est. Cost:</span>
              <span style={{ color: "var(--brand-accent)" }}>${diskCost}</span>
            </div>
          </div>

          {/* Network Egress */}
          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
              <span className="stat-label">Network Egress</span>
              <span style={{ fontSize: "18px" }}>🌐</span>
            </div>
            <div className="stat-value" style={{ fontSize: "1.6rem" }}>
              {totals.EGRESS_GB.toFixed(2)} GB
            </div>
            <div style={{ fontSize: "0.8125rem", color: "var(--text-muted)", marginTop: "4px" }}>
              Rate: $0.09 / GB (Cloudflare edge)
            </div>
            <div style={{ marginTop: "12px", paddingTop: "10px", borderTop: "1px solid var(--border-subtle)", display: "flex", justifyContent: "space-between", fontWeight: 600 }}>
              <span style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>Est. Cost:</span>
              <span style={{ color: "var(--brand-accent)" }}>${egressCost}</span>
            </div>
          </div>

          {/* Managed DB Storage */}
          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
              <span className="stat-label">Managed Databases</span>
              <span style={{ fontSize: "18px" }}>🐘</span>
            </div>
            <div className="stat-value" style={{ fontSize: "1.6rem" }}>
              {totals.DB_STORAGE_GB.toFixed(2)} GB
            </div>
            <div style={{ fontSize: "0.8125rem", color: "var(--text-muted)", marginTop: "4px" }}>
              Rate: $0.02 / GB-month
            </div>
            <div style={{ marginTop: "12px", paddingTop: "10px", borderTop: "1px solid var(--border-subtle)", display: "flex", justifyContent: "space-between", fontWeight: 600 }}>
              <span style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>Est. Cost:</span>
              <span style={{ color: "var(--brand-accent)" }}>${dbCost}</span>
            </div>
          </div>

          {/* Object Storage */}
          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
              <span className="stat-label">R2 Object Buckets</span>
              <span style={{ fontSize: "18px" }}>🪣</span>
            </div>
            <div className="stat-value" style={{ fontSize: "1.6rem" }}>
              {totals.BUCKET_STORAGE_GB.toFixed(2)} GB
            </div>
            <div style={{ fontSize: "0.8125rem", color: "var(--text-muted)", marginTop: "4px" }}>
              Rate: $0.015 / GB-month (Zero egress fees)
            </div>
            <div style={{ marginTop: "12px", paddingTop: "10px", borderTop: "1px solid var(--border-subtle)", display: "flex", justifyContent: "space-between", fontWeight: 600 }}>
              <span style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>Est. Cost:</span>
              <span style={{ color: "var(--brand-accent)" }}>${bucketCost}</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Scale to Zero Callout ── */}
      <div
        className="card"
        style={{
          marginBottom: "32px",
          background: "linear-gradient(135deg, rgba(99,102,241,0.06), rgba(6,182,212,0.06))",
          borderColor: "var(--border-emphasis)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "8px" }}>
          <span style={{ fontSize: "24px" }}>💡</span>
          <h4 style={{ fontSize: "1.05rem" }}>Syncbay Scale-to-Zero Architecture</h4>
        </div>
        <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>
          Services with <code>scaleToZero: true</code> automatically power down to 0 active replicas when idle for
          over 300 seconds. When idle, CPU and memory usage drops to zero, saving up to 85% on your monthly bill.
          Incoming HTTPS requests wake containers up in ~250ms via Cloudflare container routing.
        </p>
      </div>

      {/* ── Usage Records Table ── */}
      <div className="card" style={{ marginBottom: "28px" }}>
        <h3 style={{ marginBottom: "6px" }}>Usage Records &amp; Metering</h3>
        <p style={{ fontSize: "0.875rem", marginBottom: "16px" }}>
          Recent metered telemetry records aggregated for this billing cycle.
        </p>

        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Resource Dimension</th>
                <th>Quantity</th>
                <th>Pricing Unit</th>
                <th style={{ textAlign: "right" }}>Calculated Charge</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <div style={{ fontWeight: 600 }}>CPU Active Compute Time</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Worker execution &amp; web serving</div>
                </td>
                <td>{totals.CPU_ACTIVE_SECONDS.toLocaleString()} sec</td>
                <td>$0.00002 / s</td>
                <td style={{ textAlign: "right", fontWeight: 600 }}>${cpuCost}</td>
              </tr>
              <tr>
                <td>
                  <div style={{ fontWeight: 600 }}>Container Memory Allocation</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>RAM provisioned during active state</div>
                </td>
                <td>{totals.MEMORY_GIB_HOURS.toFixed(2)} GiB-hours</td>
                <td>$0.005 / GiB-h</td>
                <td style={{ textAlign: "right", fontWeight: 600 }}>${memCost}</td>
              </tr>
              <tr>
                <td>
                  <div style={{ fontWeight: 600 }}>Persistent Volume Storage</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Mounted disk capacity</div>
                </td>
                <td>{totals.DISK_GB_HOURS.toFixed(2)} GB-hours</td>
                <td>$0.0001 / GB-h</td>
                <td style={{ textAlign: "right", fontWeight: 600 }}>${diskCost}</td>
              </tr>
              <tr>
                <td>
                  <div style={{ fontWeight: 600 }}>Outbound Network Bandwidth</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Traffic to clients via Edge CDN</div>
                </td>
                <td>{totals.EGRESS_GB.toFixed(2)} GB</td>
                <td>$0.09 / GB</td>
                <td style={{ textAlign: "right", fontWeight: 600 }}>${egressCost}</td>
              </tr>
              <tr>
                <td>
                  <div style={{ fontWeight: 600 }}>Managed Database Storage</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Postgres, Redis, MySQL instances</div>
                </td>
                <td>{totals.DB_STORAGE_GB.toFixed(2)} GB</td>
                <td>$0.02 / GB-mo</td>
                <td style={{ textAlign: "right", fontWeight: 600 }}>${dbCost}</td>
              </tr>
              <tr>
                <td>
                  <div style={{ fontWeight: 600 }}>R2 Object Storage Buckets</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>S3-compatible bucket assets</div>
                </td>
                <td>{totals.BUCKET_STORAGE_GB.toFixed(2)} GB</td>
                <td>$0.015 / GB-mo</td>
                <td style={{ textAlign: "right", fontWeight: 600 }}>${bucketCost}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Individual metered usage event records */}
        {usage?.records && usage.records.length > 0 && (
          <div style={{ marginTop: "24px" }}>
            <h4 style={{ marginBottom: "8px", fontSize: "0.9375rem" }}>Recent Metered Ingestion Events</h4>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Timestamp</th>
                    <th>Resource Type</th>
                    <th>Measured Quantity</th>
                    <th style={{ textAlign: "right" }}>Period Window</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.records.map((rec: any) => (
                    <tr key={rec.id}>
                      <td style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>
                        {new Date(rec.createdAt).toLocaleString()}
                      </td>
                      <td>
                        <span className="badge badge-queued" style={{ fontSize: "0.7rem" }}>
                          {rec.resourceType}
                        </span>
                      </td>
                      <td style={{ fontWeight: 600 }}>
                        {rec.quantity.toLocaleString()}{" "}
                        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", fontWeight: 400 }}>
                          {rec.resourceType.includes("SECONDS")
                            ? "sec"
                            : rec.resourceType.includes("GIB") || rec.resourceType.includes("GB")
                            ? "GB"
                            : "units"}
                        </span>
                      </td>
                      <td style={{ textAlign: "right", fontSize: "0.75rem", color: "var(--text-muted)" }}>
                        {new Date(rec.periodStart).toLocaleDateString()} – {new Date(rec.periodEnd).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* ── Section: Invoices & Settlement Table ── */}
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
          <h3 style={{ margin: 0 }}>Invoices &amp; Payment Receipts</h3>
          <span className="badge badge-queued" style={{ fontSize: "0.7rem" }}>
            {invoices?.length || 0} Invoices
          </span>
        </div>
        <p style={{ fontSize: "0.875rem", marginBottom: "16px" }}>
          Itemized monthly billing invoices and prepaid credit receipts.
        </p>

        {invoicesLoading ? (
          <div style={{ padding: "32px 0", textAlign: "center" }}>
            <div className="loading-bar" style={{ width: "160px", margin: "0 auto 8px" }} />
            <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>Loading invoices...</span>
          </div>
        ) : !invoices || invoices.length === 0 ? (
          <div style={{ padding: "32px 16px", textAlign: "center", background: "var(--bg-overlay)", borderRadius: "var(--radius-md)" }}>
            <div style={{ fontSize: "28px", marginBottom: "8px" }}>🧾</div>
            <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>No Invoices Yet</div>
            <p style={{ fontSize: "0.8125rem", color: "var(--text-secondary)", marginTop: "4px" }}>
              Invoices will be automatically generated at the end of each billing cycle or when credits are purchased.
            </p>
          </div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Invoice ID</th>
                  <th>Date &amp; Period</th>
                  <th>Amount ($ USD)</th>
                  <th>Status</th>
                  <th>Payment Settlement</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv: any) => {
                  const isPaid = inv.status === "PAID";
                  const isVoid = inv.status === "VOID";
                  const statusClass = isPaid ? "badge-active" : isVoid ? "badge-queued" : "badge-building";

                  return (
                    <tr key={inv.id}>
                      <td>
                        <div style={{ fontWeight: 700, fontFamily: "monospace", fontSize: "0.875rem" }}>
                          #{inv.id.slice(0, 8).toUpperCase()}
                        </div>
                        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                          {new Date(inv.createdAt).toLocaleDateString()}
                        </div>
                      </td>
                      <td>
                        <div style={{ fontSize: "0.8125rem" }}>
                          {new Date(inv.periodStart).toLocaleDateString()} – {new Date(inv.periodEnd).toLocaleDateString()}
                        </div>
                      </td>
                      <td>
                        <div style={{ fontWeight: 700, fontSize: "0.9375rem" }}>
                          ${(inv.amountCents / 100).toFixed(2)}
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${statusClass}`} style={{ fontSize: "0.7rem" }}>
                          {inv.status}
                        </span>
                      </td>
                      <td>
                        {isPaid ? (
                          <div style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>
                            Paid on {inv.paidAt ? new Date(inv.paidAt).toLocaleDateString() : "settled"}
                          </div>
                        ) : (
                          <div style={{ fontSize: "0.8125rem", color: "var(--status-building)" }}>
                            Awaiting settlement
                          </div>
                        )}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        {!isPaid && canManageBilling ? (
                          <button
                            type="button"
                            onClick={() => handlePayInvoice(inv.id)}
                            disabled={payingInvoiceId === inv.id}
                            className="btn btn-primary btn-sm"
                          >
                            {payingInvoiceId === inv.id ? "Processing..." : "💳 Pay Now"}
                          </button>
                        ) : (
                          <a
                            href={inv.pdfUrl || "#"}
                            target="_blank"
                            rel="noreferrer"
                            className="btn btn-ghost btn-sm"
                            style={{ fontSize: "0.75rem" }}
                          >
                            📄 View Receipt
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── MODAL: Add Payment Card ── */}
      {showAddCardModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.78)",
            backdropFilter: "blur(6px)",
            display: "grid",
            placeItems: "center",
            zIndex: 9999,
            padding: "20px",
          }}
          onClick={() => setShowAddCardModal(false)}
        >
          <div
            className="card"
            style={{ width: "100%", maxWidth: "500px", background: "var(--bg-elevated)", border: "1px solid var(--border-emphasis)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <h3 style={{ margin: 0, fontSize: "1.2rem" }}>Add Credit or Debit Card</h3>
              <button
                type="button"
                onClick={() => setShowAddCardModal(false)}
                className="btn btn-ghost btn-sm"
              >
                ✕
              </button>
            </div>

            {/* Live Credit Card Visual Simulation */}
            <div
              style={{
                width: "100%",
                height: "170px",
                borderRadius: "16px",
                background:
                  detectedBrand === "visa"
                    ? "linear-gradient(135deg, #1e3a8a, #3b82f6)"
                    : detectedBrand === "mastercard"
                    ? "linear-gradient(135deg, #7c2d12, #ea580c)"
                    : detectedBrand === "amex"
                    ? "linear-gradient(135deg, #0369a1, #06b6d4)"
                    : detectedBrand === "discover"
                    ? "linear-gradient(135deg, #b45309, #f59e0b)"
                    : "linear-gradient(135deg, #1e293b, #0f172a)",
                boxShadow: "0 10px 25px -5px rgba(0,0,0,0.5)",
                border: "1px solid rgba(255,255,255,0.15)",
                padding: "18px 22px",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                marginBottom: "20px",
                color: "#fff",
                position: "relative",
                overflow: "hidden",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontSize: "24px" }}>💳</span>
                  <span style={{ fontSize: "0.75rem", letterSpacing: "0.1em", opacity: 0.8, textTransform: "uppercase" }}>
                    Syncbay Cloud Pass
                  </span>
                </div>
                <div style={{ fontWeight: 800, fontSize: "1rem", letterSpacing: "0.08em" }}>
                  {brandMeta.name.toUpperCase()}
                </div>
              </div>

              <div style={{ fontFamily: "monospace", fontSize: "1.25rem", letterSpacing: "0.15em", textAlign: "center" }}>
                {displayFormattedCardNumber}
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
                <div>
                  <div style={{ fontSize: "0.65rem", opacity: 0.7, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    Cardholder
                  </div>
                  <div style={{ fontSize: "0.875rem", fontWeight: 600, textTransform: "uppercase", maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {cardholderName.trim() || "YOUR NAME"}
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: "0.65rem", opacity: 0.7, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    Expires
                  </div>
                  <div style={{ fontSize: "0.875rem", fontWeight: 600, fontFamily: "monospace" }}>
                    {formatExpiry(expMonth, expYear)}
                  </div>
                </div>
              </div>
            </div>

            {formError && (
              <div
                style={{
                  padding: "10px 14px",
                  borderRadius: "var(--radius-sm)",
                  background: "rgba(239, 68, 68, 0.15)",
                  border: "1px solid rgba(239, 68, 68, 0.35)",
                  color: "#fca5a5",
                  fontSize: "0.8125rem",
                  marginBottom: "16px",
                }}
              >
                {formError}
              </div>
            )}

            <form onSubmit={handleAddCard} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              <div className="field">
                <label>Cardholder Name</label>
                <input
                  type="text"
                  className="input"
                  placeholder="e.g. Satoshi Nakamoto"
                  value={cardholderName}
                  onChange={(e) => setCardholderName(e.target.value)}
                  required
                />
              </div>

              <div className="field">
                <label>Card Number</label>
                <input
                  type="text"
                  className="input"
                  placeholder="4111 2222 3333 4444"
                  maxLength={19}
                  value={cardNumberRaw}
                  onChange={(e) => setCardNumberRaw(e.target.value.replace(/\D/g, ""))}
                  required
                  style={{ fontFamily: "monospace", fontSize: "0.9375rem" }}
                />
                <span className="field-hint">
                  Supports Visa, Mastercard, American Express, and Discover.
                </span>
              </div>

              <div className="grid-3" style={{ gap: "10px" }}>
                <div className="field">
                  <label>Exp Month</label>
                  <select
                    className="input"
                    value={expMonth}
                    onChange={(e) => setExpMonth(parseInt(e.target.value, 10))}
                  >
                    {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                      <option key={m} value={m}>
                        {String(m).padStart(2, "0")}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label>Exp Year</label>
                  <select
                    className="input"
                    value={expYear}
                    onChange={(e) => setExpYear(parseInt(e.target.value, 10))}
                  >
                    {Array.from({ length: 15 }, (_, i) => new Date().getFullYear() + i).map((y) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label>CVC / CVV</label>
                  <input
                    type="password"
                    className="input"
                    placeholder="123"
                    maxLength={4}
                    value={cvc}
                    onChange={(e) => setCvc(e.target.value.replace(/\D/g, ""))}
                    required
                    style={{ fontFamily: "monospace" }}
                  />
                </div>
              </div>

              <div className="grid-2" style={{ gap: "10px" }}>
                <div className="field">
                  <label>Postal / ZIP Code</label>
                  <input
                    type="text"
                    className="input"
                    placeholder="e.g. 94104"
                    value={billingZip}
                    onChange={(e) => setBillingZip(e.target.value)}
                  />
                </div>

                <div className="field">
                  <label>Country</label>
                  <select className="input" defaultValue="US">
                    <option value="US">United States (USD)</option>
                    <option value="CA">Canada (CAD)</option>
                    <option value="GB">United Kingdom (GBP)</option>
                    <option value="EU">European Union (EUR)</option>
                    <option value="OTHER">International</option>
                  </select>
                </div>
              </div>

              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.8125rem", cursor: "pointer", marginTop: "4px" }}>
                <input
                  type="checkbox"
                  checked={setAsDefault}
                  onChange={(e) => setSetAsDefault(e.target.checked)}
                />
                <span>Set as default payment method for this workspace</span>
              </label>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "12px" }}>
                <button
                  type="button"
                  onClick={() => setShowAddCardModal(false)}
                  className="btn btn-secondary"
                  disabled={addCardMutation.isPending}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={addCardMutation.isPending || !cardNumberRaw || !cardholderName || !cvc}
                >
                  {addCardMutation.isPending ? "Validating & Tokenizing..." : "Save Card"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── MODAL: Top-Up Compute Credits ── */}
      {showTopUpModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.78)",
            backdropFilter: "blur(6px)",
            display: "grid",
            placeItems: "center",
            zIndex: 9999,
            padding: "20px",
          }}
          onClick={() => setShowTopUpModal(false)}
        >
          <div
            className="card"
            style={{ width: "100%", maxWidth: "460px", background: "var(--bg-elevated)", border: "1px solid var(--border-emphasis)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <h3 style={{ margin: 0, fontSize: "1.2rem" }}>Purchase Cloud Credits</h3>
              <button
                type="button"
                onClick={() => setShowTopUpModal(false)}
                className="btn btn-ghost btn-sm"
              >
                ✕
              </button>
            </div>

            <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", marginBottom: "20px" }}>
              Prepay for container CPU seconds, memory GiB-hours, and databases. Never worry about card overdrafts.
            </p>

            {/* Amount Selection */}
            <div style={{ marginBottom: "18px" }}>
              <label style={{ display: "block", fontSize: "0.8125rem", fontWeight: 600, marginBottom: "8px" }}>
                Select Top-Up Amount
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "8px", marginBottom: "10px" }}>
                {[10, 25, 50, 100].map((amt) => (
                  <button
                    key={amt}
                    type="button"
                    onClick={() => {
                      setTopUpAmountDollars(amt);
                      setCustomTopUpInput("");
                    }}
                    className={`btn ${topUpAmountDollars === amt && !customTopUpInput ? "btn-primary" : "btn-secondary"}`}
                    style={{ justifyContent: "center", fontWeight: 700 }}
                  >
                    ${amt}
                  </button>
                ))}
              </div>

              <div className="field">
                <input
                  type="number"
                  min="5"
                  step="1"
                  className="input"
                  placeholder="Or enter custom amount ($5 minimum)"
                  value={customTopUpInput}
                  onChange={(e) => {
                    setCustomTopUpInput(e.target.value);
                  }}
                />
              </div>
            </div>

            {/* Card Selection */}
            <div style={{ marginBottom: "24px" }}>
              <label style={{ display: "block", fontSize: "0.8125rem", fontWeight: 600, marginBottom: "8px" }}>
                Charge To Card
              </label>
              {!paymentMethods || paymentMethods.length === 0 ? (
                <div style={{ padding: "12px", background: "var(--bg-overlay)", borderRadius: "var(--radius-sm)", border: "1px dashed var(--border-default)" }}>
                  <p style={{ fontSize: "0.8125rem", color: "var(--text-secondary)", margin: 0 }}>
                    No payment card registered yet.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setShowTopUpModal(false);
                      setShowAddCardModal(true);
                    }}
                    className="btn btn-secondary btn-sm"
                    style={{ marginTop: "8px" }}
                  >
                    ＋ Add Card First
                  </button>
                </div>
              ) : (
                <select
                  className="input"
                  value={selectedPaymentMethodId || paymentMethods.find((p: any) => p.isDefault)?.id || paymentMethods[0]?.id}
                  onChange={(e) => setSelectedPaymentMethodId(e.target.value)}
                >
                  {paymentMethods.map((pm: any) => (
                    <option key={pm.id} value={pm.id}>
                      {pm.brand.toUpperCase()} •••• {pm.last4} ({pm.cardholderName}) {pm.isDefault ? "[DEFAULT]" : ""}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
              <button
                type="button"
                onClick={() => setShowTopUpModal(false)}
                className="btn btn-secondary"
                disabled={addCreditsMutation.isPending}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleExecuteTopUp}
                disabled={addCreditsMutation.isPending || !paymentMethods || paymentMethods.length === 0}
                className="btn btn-primary"
              >
                {addCreditsMutation.isPending
                  ? "Charging Card..."
                  : `Pay $${customTopUpInput || topUpAmountDollars} & Add Credits`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
