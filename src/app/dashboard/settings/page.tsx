"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { trpc } from "@/lib/trpc-client";
import { ApiTokenScope } from "@prisma/client";
import { useDashboard } from "../dashboard-shell";
import { signIn } from "next-auth/react";

export default function SettingsPage() {
  const dashboard = useDashboard();
  const { data: fetchedWorkspaces, isLoading: wsLoading } = trpc.workspace.list.useQuery();
  const workspaces = dashboard?.workspaces || fetchedWorkspaces;
  const [selectedWsId, setSelectedWsId] = useState<string>("");

  // GitHub connection status & PAT state
  const { data: ghStatus, isLoading: ghLoading, refetch: refetchGhStatus } = trpc.github.getConnectionStatus.useQuery();
  const connectPatMutation = trpc.github.connectPersonalAccessToken.useMutation();
  const disconnectGhMutation = trpc.github.disconnect.useMutation();
  const [patInput, setPatInput] = useState("");
  const [patError, setPatError] = useState("");
  const [patSuccess, setPatSuccess] = useState("");
  const [showPatInput, setShowPatInput] = useState(false);
  const [isConnectingPat, setIsConnectingPat] = useState(false);

  const activeWorkspace =
    workspaces?.find((w) => w.id === (selectedWsId || dashboard?.currentWorkspace?.id)) ||
    dashboard?.currentWorkspace ||
    workspaces?.[0];

  const workspaceId = activeWorkspace?.id;

  // Fetch API tokens for this workspace
  const {
    data: tokens,
    isLoading: tokensLoading,
    refetch: refetchTokens,
  } = trpc.token.list.useQuery(
    { workspaceId: workspaceId! },
    { enabled: !!workspaceId }
  );

  // Fetch billing overview for payment method preview
  const { data: billingSummary } = trpc.billing.getBillingSummary.useQuery(
    { workspaceId: workspaceId! },
    { enabled: !!workspaceId }
  );

  // Mutations
  const createTokenMutation = trpc.token.create.useMutation();
  const revokeTokenMutation = trpc.token.revoke.useMutation();
  const updateCapMutation = trpc.workspace.updateSpendingCap.useMutation();

  // Token creation modal & newly generated token state
  const [showCreateTokenModal, setShowCreateTokenModal] = useState(false);
  const [newTokenName, setNewTokenName] = useState("");
  const [newTokenScope, setNewTokenScope] = useState<ApiTokenScope>(ApiTokenScope.DEPLOY_ONLY);
  const [createdRawToken, setCreatedRawToken] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState(false);
  const [tokenError, setTokenError] = useState("");

  // Spending cap state
  const [capDollars, setCapDollars] = useState<string>("");

  useEffect(() => {
    if (activeWorkspace) {
      setCapDollars(
        activeWorkspace.spendingCapCents != null
          ? (activeWorkspace.spendingCapCents / 100).toString()
          : ""
      );
    }
  }, [activeWorkspace?.id, activeWorkspace?.spendingCapCents]);

  const [capSuccessMsg, setCapSuccessMsg] = useState("");
  const [capErrorMsg, setCapErrorMsg] = useState("");

  const handleCreateToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspaceId || !newTokenName.trim()) return;
    setTokenError("");
    try {
      const res = await createTokenMutation.mutateAsync({
        workspaceId,
        name: newTokenName.trim(),
        scope: newTokenScope,
      });
      setCreatedRawToken(res.rawToken);
      setNewTokenName("");
      await refetchTokens();
    } catch (err: any) {
      setTokenError(err.message || "Failed to create API token");
    }
  };

  const handleRevokeToken = async (tokenId: string) => {
    if (!confirm("Are you sure you want to revoke this API token? Any integrations using it will immediately lose access.")) return;
    try {
      await revokeTokenMutation.mutateAsync({ tokenId });
      await refetchTokens();
    } catch (err: any) {
      alert(`Failed to revoke token: ${err.message}`);
    }
  };

  const handleUpdateSpendingCap = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspaceId) return;
    setCapErrorMsg("");
    setCapSuccessMsg("");
    try {
      const cents = capDollars.trim() === "" ? null : Math.round(parseFloat(capDollars) * 100);
      if (cents !== null && (isNaN(cents) || cents < 0)) {
        setCapErrorMsg("Please enter a valid positive dollar amount or leave empty for unlimited.");
        return;
      }
      await updateCapMutation.mutateAsync({
        workspaceId,
        spendingCapCents: cents,
      });
      setCapSuccessMsg("Spending cap updated successfully.");
      setTimeout(() => setCapSuccessMsg(""), 4000);
    } catch (err: any) {
      setCapErrorMsg(err.message || "Failed to update spending cap. Ensure you have OWNER role.");
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedToken(true);
    setTimeout(() => setCopiedToken(false), 2500);
  };

  return (
    <div className="fade-in" style={{ maxWidth: "960px", margin: "0 auto" }}>
      {/* ── Page Header ── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">
            Configure access tokens, GitHub connection, user profile, and billing spending caps.
          </p>
        </div>

        {/* Workspace selector if multiple exist */}
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

      {/* ── Section 1: User Profile & Security ── */}
      <div className="card" style={{ marginBottom: "28px" }}>
        <h3 style={{ marginBottom: "6px" }}>User Profile</h3>
        <p style={{ fontSize: "0.875rem", marginBottom: "20px" }}>
          Your personal account details and authentication configuration.
        </p>

        {(() => {
          const currentMember = activeWorkspace?.members?.find((m: any) => m.userId === dashboard?.user?.id);
          const userName = dashboard?.user?.name || currentMember?.user?.name || "Developer";
          const userEmail = dashboard?.user?.email || currentMember?.user?.email || "developer@syncbay.local";
          const userRole = currentMember?.role || (activeWorkspace?.isPersonal ? "OWNER" : "MEMBER");

          return (
            <>
              <div className="grid-2" style={{ gap: "20px" }}>
                <div className="field">
                  <label>Name</label>
                  <input
                    type="text"
                    className="input"
                    value={userName}
                    disabled
                  />
                </div>

                <div className="field">
                  <label>Email Address</label>
                  <input
                    type="email"
                    className="input"
                    value={userEmail}
                    disabled
                  />
                </div>
              </div>

              <div
                style={{
                  marginTop: "20px",
                  padding: "12px 16px",
                  background: "var(--bg-overlay)",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--border-subtle)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>Role in {activeWorkspace?.name}</div>
                  <div style={{ fontSize: "0.8125rem", color: "var(--text-muted)", marginTop: "2px" }}>
                    {userRole === "OWNER"
                      ? "Grants full administrative permissions across services, secrets, billing, and team members."
                      : userRole === "ADMIN"
                      ? "Grants administrative permissions to manage services, deployments, and team collaborators."
                      : userRole === "MEMBER"
                      ? "Grants operational permissions to build, deploy, and configure services and databases."
                      : "Read-only access to view logs, metrics, and deployment statuses."}
                  </div>
                </div>
                <span className={`badge ${userRole === "OWNER" ? "badge-sleeping" : userRole === "ADMIN" ? "badge-building" : userRole === "MEMBER" ? "badge-active" : "badge-queued"}`}>
                  {userRole}
                </span>
              </div>
            </>
          );
        })()}
      </div>

      {/* ── Section 2: GitHub Connection ── */}
      <div className="card" style={{ marginBottom: "28px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px" }}>
          <div>
            <h3 style={{ marginBottom: "6px" }}>GitHub Integration</h3>
            <p style={{ fontSize: "0.875rem" }}>
              Connect your GitHub account to import repositories, auto-trigger deployments via webhooks, and preview pull requests.
            </p>
          </div>
          {ghLoading ? (
            <span className="badge badge-queued">Checking...</span>
          ) : ghStatus?.isConnected ? (
            <span className="badge badge-active" style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#10b981", display: "inline-block" }}></span>
              Connected as @{ghStatus.username}
            </span>
          ) : (
            <span className="badge badge-failed">Not Connected</span>
          )}
        </div>

        {patSuccess && (
          <div style={{ padding: "10px 14px", background: "rgba(16, 185, 129, 0.15)", border: "1px solid rgba(16, 185, 129, 0.35)", color: "#6ee7b7", borderRadius: "var(--radius-sm)", fontSize: "0.875rem", marginBottom: "16px" }}>
            {patSuccess}
          </div>
        )}

        {patError && (
          <div style={{ padding: "10px 14px", background: "rgba(239, 68, 68, 0.15)", border: "1px solid rgba(239, 68, 68, 0.35)", color: "#fca5a5", borderRadius: "var(--radius-sm)", fontSize: "0.875rem", marginBottom: "16px" }}>
            {patError}
          </div>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px",
            background: "var(--bg-overlay)",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--border-subtle)",
            flexWrap: "wrap",
            gap: "12px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            {ghStatus?.avatarUrl ? (
              <img
                src={ghStatus.avatarUrl}
                alt={ghStatus.username || "GitHub Avatar"}
                style={{ width: "36px", height: "36px", borderRadius: "50%", border: "1px solid var(--border-subtle)" }}
              />
            ) : (
              <div style={{ fontSize: "28px" }}>🐙</div>
            )}
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.9375rem" }}>
                {ghStatus?.isConnected ? `GitHub Account: @${ghStatus.username}` : "GitHub Not Connected"}
              </div>
              <div style={{ fontSize: "0.8125rem", color: "var(--text-secondary)", marginTop: "2px" }}>
                {ghStatus?.isConnected
                  ? `Repository access authorized (${ghStatus.hasRepoScope ? "Full Repo Scope" : "User Scope"}). Automatic push webhooks active.`
                  : "Connect your GitHub account or paste a Personal Access Token (PAT) with repo access."}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => signIn("github", { callbackUrl: typeof window !== "undefined" ? window.location.href : "/dashboard/settings" })}
              className="btn btn-secondary btn-sm"
            >
              {ghStatus?.isConnected ? "Reconnect OAuth" : "Connect with OAuth"}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowPatInput(!showPatInput);
                setPatError("");
                setPatSuccess("");
              }}
              className="btn btn-ghost btn-sm"
            >
              {showPatInput ? "Cancel" : "Use Access Token (PAT)"}
            </button>
            {ghStatus?.isConnected && (
              <button
                type="button"
                onClick={async () => {
                  if (confirm("Disconnect GitHub account? Stored tokens will be removed.")) {
                    await disconnectGhMutation.mutateAsync();
                    await refetchGhStatus();
                  }
                }}
                disabled={disconnectGhMutation.isPending}
                className="btn btn-ghost btn-sm"
                style={{ color: "var(--status-crashed)" }}
              >
                Disconnect
              </button>
            )}
          </div>
        </div>

        {showPatInput && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!patInput.trim()) return;
              setPatError("");
              setPatSuccess("");
              setIsConnectingPat(true);
              try {
                const res = await connectPatMutation.mutateAsync({ token: patInput.trim() });
                setPatSuccess(`Successfully connected to GitHub as @${res.username}!`);
                setPatInput("");
                setShowPatInput(false);
                await refetchGhStatus();
              } catch (err: any) {
                setPatError(err.message || "Failed to validate GitHub token.");
              } finally {
                setIsConnectingPat(false);
              }
            }}
            style={{
              marginTop: "16px",
              padding: "16px",
              background: "var(--bg-surface)",
              border: "1px solid var(--border-emphasis)",
              borderRadius: "var(--radius-md)",
            }}
          >
            <label style={{ display: "block", fontSize: "0.875rem", fontWeight: 600, marginBottom: "6px" }}>
              GitHub Personal Access Token (Classic or Fine-Grained)
            </label>
            <p style={{ fontSize: "0.8125rem", color: "var(--text-secondary)", marginBottom: "12px" }}>
              Create a token in{" "}
              <a
                href="https://github.com/settings/tokens"
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--brand-primary)", textDecoration: "underline" }}
              >
                GitHub Settings → Developer Settings → Personal access tokens
              </a>{" "}
              with the <code>repo</code> and <code>read:user</code> permissions.
            </p>
            <div style={{ display: "flex", gap: "10px" }}>
              <input
                type="password"
                className="input"
                placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                value={patInput}
                onChange={(e) => setPatInput(e.target.value)}
                style={{ flex: 1, fontFamily: "monospace", fontSize: "0.875rem" }}
              />
              <button
                type="submit"
                disabled={isConnectingPat || !patInput.trim()}
                className="btn btn-primary btn-sm"
                style={{ minWidth: "120px", justifyContent: "center" }}
              >
                {isConnectingPat ? "Verifying..." : "Save Token"}
              </button>
            </div>
          </form>
        )}
      </div>

      {/* ── Section 3: API Access Tokens ── */}
      <div className="card" style={{ marginBottom: "28px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px" }}>
          <div>
            <h3 style={{ marginBottom: "6px" }}>API Access Tokens</h3>
            <p style={{ fontSize: "0.875rem" }}>
              Tokens allow automated CLI, GitHub Actions, and external agents to authenticate with Syncbay.
            </p>
          </div>
          <button
            onClick={() => {
              setShowCreateTokenModal(true);
              setCreatedRawToken(null);
              setTokenError("");
            }}
            className="btn btn-primary btn-sm"
          >
            ＋ Create New Token
          </button>
        </div>

        {tokensLoading ? (
          <div style={{ textAlign: "center", padding: "32px" }}>
            <div className="loading-bar" style={{ width: "160px", margin: "0 auto 12px" }} />
            <p style={{ color: "var(--text-muted)", fontSize: "0.8125rem" }}>Loading tokens...</p>
          </div>
        ) : tokens?.length === 0 ? (
          <div className="empty-state" style={{ padding: "32px 16px" }}>
            <div style={{ fontSize: "24px", marginBottom: "8px" }}>🔑</div>
            <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>
              No API access tokens created yet for this workspace.
            </p>
          </div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Token Name</th>
                  <th>Scope</th>
                  <th>Prefix</th>
                  <th>Created</th>
                  <th>Status</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {tokens?.map((tok) => {
                  const scopeBadgeClass =
                    tok.scope === "FULL_ACCESS"
                      ? "badge-sleeping"
                      : tok.scope === "DEPLOY_ONLY"
                      ? "badge-active"
                      : "badge-queued";

                  const isRevoked = !!tok.revokedAt;

                  return (
                    <tr key={tok.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{tok.name}</div>
                        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                          {tok.user?.email || "Workspace token"}
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${scopeBadgeClass}`} style={{ fontSize: "0.6875rem" }}>
                          {tok.scope}
                        </span>
                      </td>
                      <td>
                        <code style={{ fontSize: "0.8125rem", color: "var(--brand-accent)" }}>
                          {tok.tokenPrefix}
                        </code>
                      </td>
                      <td style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>
                        {new Date(tok.createdAt).toLocaleDateString()}
                      </td>
                      <td>
                        {isRevoked ? (
                          <span className="badge badge-failed" style={{ fontSize: "0.6875rem" }}>
                            Revoked
                          </span>
                        ) : (
                          <span className="badge badge-active" style={{ fontSize: "0.6875rem" }}>
                            Active
                          </span>
                        )}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        {!isRevoked && (
                          <button
                            onClick={() => handleRevokeToken(tok.id)}
                            className="btn btn-danger btn-sm"
                            disabled={revokeTokenMutation.isPending}
                          >
                            Revoke
                          </button>
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

      {/* ── Section 4: Billing & Spending Cap ── */}
      <div className="card">
        <h3 style={{ marginBottom: "6px" }}>Workspace Spending Cap</h3>
        <p style={{ fontSize: "0.875rem", marginBottom: "20px" }}>
          Set a monthly financial budget cap in USD for this workspace. When usage approaches 80%, an alert is flagged.
          At 100%, services scale to zero to stop further charges.
        </p>

        {capSuccessMsg && (
          <div
            style={{
              padding: "10px 14px",
              borderRadius: "var(--radius-md)",
              background: "rgba(34,197,94,0.15)",
              border: "1px solid rgba(34,197,94,0.3)",
              color: "#4ade80",
              fontSize: "0.8125rem",
              marginBottom: "16px",
            }}
          >
            {capSuccessMsg}
          </div>
        )}

        {capErrorMsg && (
          <div
            style={{
              padding: "10px 14px",
              borderRadius: "var(--radius-md)",
              background: "rgba(239,68,68,0.15)",
              border: "1px solid rgba(239,68,68,0.3)",
              color: "#f87171",
              fontSize: "0.8125rem",
              marginBottom: "16px",
            }}
          >
            {capErrorMsg}
          </div>
        )}

        <form onSubmit={handleUpdateSpendingCap} style={{ maxWidth: "480px" }}>
          <div className="field" style={{ marginBottom: "16px" }}>
            <label>Monthly Spending Cap ($ USD)</label>
            <div style={{ position: "relative" }}>
              <span
                style={{
                  position: "absolute",
                  left: "12px",
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "var(--text-muted)",
                  fontWeight: 600,
                }}
              >
                $
              </span>
              <input
                type="number"
                step="1"
                min="0"
                className="input"
                style={{ paddingLeft: "28px" }}
                placeholder="e.g. 50 (leave blank for unlimited)"
                value={capDollars}
                onChange={(e) => setCapDollars(e.target.value)}
              />
            </div>
            <span className="field-hint">
              Leave blank or set to 0 for unlimited compute spend.
            </span>
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            disabled={updateCapMutation.isPending}
          >
            {updateCapMutation.isPending ? "Saving..." : "Save Spending Cap"}
          </button>
        </form>

        {/* Payment Card & Prepaid Balance Summary Widget */}
        <div
          style={{
            marginTop: "24px",
            paddingTop: "20px",
            borderTop: "1px solid var(--border-subtle)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "16px",
          }}
        >
          <div>
            <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", textTransform: "uppercase", fontWeight: 600 }}>
              Payment Method &amp; Prepaid Balance
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "4px" }}>
              <span style={{ fontSize: "1.25rem" }}>💳</span>
              <div>
                <span style={{ fontWeight: 600, fontSize: "0.875rem" }}>
                  {billingSummary?.defaultCard
                    ? `${billingSummary.defaultCard.brand.toUpperCase()} ending in •••• ${billingSummary.defaultCard.last4}`
                    : "No payment card on file"}
                </span>
                <span style={{ color: "var(--text-muted)", fontSize: "0.8125rem", marginLeft: "8px" }}>
                  · Cloud Balance: ${( (billingSummary?.creditBalanceCents ?? 0) / 100 ).toFixed(2)}
                </span>
              </div>
            </div>
          </div>

          <Link href="/dashboard/usage" className="btn btn-secondary btn-sm">
            Manage Cards, Invoices &amp; Top-Up →
          </Link>
        </div>
      </div>

      {/* ── Official American Company & Cloud Compliance Card ── */}
      <div className="card" style={{ marginBottom: "28px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "20px" }}>🇺🇸</span>
            <h3 style={{ margin: 0 }}>Corporate Identity &amp; US Compliance</h3>
          </div>
          <span className="badge badge-active" style={{ fontSize: "0.7rem" }}>
            US Infrastructure
          </span>
        </div>

        <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", marginBottom: "16px" }}>
          Syncbay is an American cloud platform operated by <strong>Syncbay Technologies Inc.</strong> All control-plane
          metadata, database instances, and user access policies are protected under United States data privacy and SOC2
          regulatory standards.
        </p>

        <div className="grid-2" style={{ gap: "12px", marginBottom: "16px" }}>
          <div style={{ padding: "12px", background: "var(--bg-overlay)", borderRadius: "var(--radius-md)", border: "1px solid var(--border-subtle)" }}>
            <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: "4px" }}>
              Corporate Headquarters
            </div>
            <div style={{ fontWeight: 700, fontSize: "0.875rem", color: "var(--text-primary)" }}>
              Syncbay Technologies Inc.
            </div>
            <div style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>
              548 Market St, Suite 82194<br />
              San Francisco, CA 94104, United States
            </div>
          </div>

          <div style={{ padding: "12px", background: "var(--bg-overlay)", borderRadius: "var(--radius-md)", border: "1px solid var(--border-subtle)" }}>
            <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: "4px" }}>
              Legal Jurisdiction &amp; Governance
            </div>
            <div style={{ fontWeight: 700, fontSize: "0.875rem", color: "var(--text-primary)" }}>
              State of Delaware (C-Corp)
            </div>
            <div style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>
              US Data Sovereignty · Cloudflare Edge Backbone<br />
              Zero-Cloud-Tax Guarantee
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <Link href="/pricing" className="btn btn-secondary btn-sm">
            💎 View Plans &amp; Competitor Comparison
          </Link>
          <a href="mailto:compliance@syncbay.app" className="btn btn-ghost btn-sm" style={{ color: "var(--text-muted)" }}>
            Request Compliance Packet ↗
          </a>
        </div>
      </div>

      {/* Create Token Modal */}
      {showCreateTokenModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.75)",
            backdropFilter: "blur(4px)",
            display: "grid",
            placeItems: "center",
            zIndex: 9999,
            padding: "20px",
          }}
          onClick={() => {
            if (!createdRawToken) setShowCreateTokenModal(false);
          }}
        >
          <div
            className="card"
            style={{ width: "100%", maxWidth: "480px" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginBottom: "8px" }}>Create API Access Token</h3>

            {createdRawToken ? (
              <div>
                <p style={{ fontSize: "0.875rem", marginBottom: "16px", color: "var(--status-building)" }}>
                  ⚠️ Make sure to copy your API access token now. You will not be able to view it again!
                </p>

                <div
                  style={{
                    padding: "12px",
                    background: "var(--bg-base)",
                    borderRadius: "var(--radius-md)",
                    border: "1px solid var(--border-emphasis)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: "20px",
                    wordBreak: "break-all",
                  }}
                >
                  <code style={{ fontSize: "0.875rem", color: "var(--brand-accent)" }}>
                    {createdRawToken}
                  </code>
                  <button
                    onClick={() => copyToClipboard(createdRawToken)}
                    className="btn btn-secondary btn-sm"
                    style={{ flexShrink: 0, marginLeft: "10px" }}
                  >
                    {copiedToken ? "Copied! ✓" : "Copy"}
                  </button>
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      setShowCreateTokenModal(false);
                      setCreatedRawToken(null);
                    }}
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleCreateToken} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                <p style={{ fontSize: "0.875rem" }}>
                  Generate an API token for {activeWorkspace?.name}.
                </p>

                {tokenError && (
                  <div
                    style={{
                      padding: "10px 14px",
                      borderRadius: "var(--radius-md)",
                      background: "rgba(239,68,68,0.15)",
                      color: "#f87171",
                      fontSize: "0.8125rem",
                      border: "1px solid rgba(239,68,68,0.3)",
                    }}
                  >
                    {tokenError}
                  </div>
                )}

                <div className="field">
                  <label>Token Description</label>
                  <input
                    type="text"
                    className="input"
                    placeholder="e.g. GitHub Actions CI/CD"
                    value={newTokenName}
                    onChange={(e) => setNewTokenName(e.target.value)}
                    required
                  />
                </div>

                <div className="field">
                  <label>Access Scope</label>
                  <select
                    className="input"
                    value={newTokenScope}
                    onChange={(e) => setNewTokenScope(e.target.value as ApiTokenScope)}
                  >
                    <option value={ApiTokenScope.READ_ONLY}>
                      READ_ONLY — Read metrics, logs, and workspace metadata
                    </option>
                    <option value={ApiTokenScope.DEPLOY_ONLY}>
                      DEPLOY_ONLY — Trigger deployments and update environment variables
                    </option>
                    <option value={ApiTokenScope.FULL_ACCESS}>
                      FULL_ACCESS — Full administrative control across the workspace
                    </option>
                  </select>
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginTop: "8px" }}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setShowCreateTokenModal(false)}
                    disabled={createTokenMutation.isPending}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={createTokenMutation.isPending || !newTokenName.trim()}
                  >
                    {createTokenMutation.isPending ? "Generating..." : "Generate Token"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
