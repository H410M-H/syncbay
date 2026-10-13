"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { useDashboard } from "../dashboard-shell";
import { BackButton } from "@/components/ui/back-button";

export default function AuditPage() {
  const dashboard = useDashboard();
  const { data: fetchedWorkspaces, isLoading: wsLoading } = trpc.workspace.list.useQuery();
  const workspaces = dashboard?.workspaces || fetchedWorkspaces;
  const [selectedWsId, setSelectedWsId] = useState<string>("");
  const [filterQuery, setFilterQuery] = useState("");
  const [selectedActionCategory, setSelectedActionCategory] = useState("ALL");
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);

  const activeWorkspace =
    workspaces?.find((w) => w.id === (selectedWsId || dashboard?.currentWorkspace?.id)) ||
    dashboard?.currentWorkspace ||
    workspaces?.[0];

  const workspaceId = activeWorkspace?.id;

  const {
    data: auditLogs,
    isLoading: logsLoading,
    error: logsError,
  } = trpc.workspace.auditLog.useQuery(
    { workspaceId: workspaceId!, limit: 100 },
    { enabled: !!workspaceId, retry: false }
  );

  const filteredLogs = auditLogs?.filter((log) => {
    const matchesQuery =
      log.action.toLowerCase().includes(filterQuery.toLowerCase()) ||
      (log.actor?.email && log.actor.email.toLowerCase().includes(filterQuery.toLowerCase())) ||
      (log.actor?.name && log.actor.name.toLowerCase().includes(filterQuery.toLowerCase()));

    if (!matchesQuery) return false;

    if (selectedActionCategory === "ALL") return true;
    if (selectedActionCategory === "TOKEN") return log.action.startsWith("token.");
    if (selectedActionCategory === "MEMBER") return log.action.startsWith("member.");
    if (selectedActionCategory === "WORKSPACE") return log.action.startsWith("workspace.");
    if (selectedActionCategory === "DEPLOYMENT") return log.action.startsWith("deployment.");
    if (selectedActionCategory === "DOMAIN") return log.action.startsWith("domain.");
    if (selectedActionCategory === "SERVICE") return log.action.startsWith("service.");
    if (selectedActionCategory === "AUTH") return log.action.startsWith("auth.");
    return true;
  });

  const getActionBadgeClass = (action: string) => {
    if (action.startsWith("token.")) return "badge-sleeping";
    if (action.startsWith("member.")) return "badge-active";
    if (action.startsWith("workspace.")) return "badge-sleeping";
    if (action.startsWith("deployment.")) return "badge-building";
    if (action.startsWith("domain.")) return "badge-active";
    if (action.includes("deleted") || action.includes("revoked")) return "badge-failed";
    return "badge-queued";
  };

  return (
    <div className="fade-in" style={{ maxWidth: "1000px", margin: "0 auto" }}>
      <div style={{ marginBottom: "16px" }}>
        <BackButton fallbackUrl="/dashboard" label="Back to Dashboard" />
      </div>

      {/* ── Page Header ── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Audit Log</h1>
          <p className="page-subtitle">
            Immutable timeline of security events, administrative changes, and platform actions.
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

      {/* ── Filter Bar ── */}
      <div className="card" style={{ marginBottom: "24px", padding: "16px 20px" }}>
        <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ flex: 1, minWidth: "240px" }}>
            <input
              type="text"
              className="input"
              placeholder="Filter by action or actor email..."
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
            />
          </div>

          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {["ALL", "WORKSPACE", "MEMBER", "TOKEN", "DEPLOYMENT", "DOMAIN", "SERVICE", "AUTH"].map((cat) => (
              <button
                key={cat}
                onClick={() => setSelectedActionCategory(cat)}
                className={`btn btn-sm ${selectedActionCategory === cat ? "btn-secondary" : "btn-ghost"}`}
                style={{
                  fontSize: "0.75rem",
                  borderColor: selectedActionCategory === cat ? "var(--brand-primary)" : "transparent",
                }}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Main Audit Stream ── */}
      {logsError ? (
        <div className="empty-state card">
          <div className="empty-icon">🔒</div>
          <h3>Restricted Access</h3>
          <p>
            Audit logs are only accessible to workspace owners. Please request Owner permissions from your workspace
            administrator.
          </p>
        </div>
      ) : logsLoading ? (
        <div style={{ textAlign: "center", padding: "48px" }}>
          <div className="loading-bar" style={{ width: "200px", margin: "0 auto 16px" }} />
          <p style={{ color: "var(--text-muted)" }}>Loading audit events...</p>
        </div>
      ) : filteredLogs?.length === 0 ? (
        <div className="empty-state card">
          <div className="empty-icon">⊟</div>
          <h3>No audit records found</h3>
          <p>
            {filterQuery
              ? `No events matching "${filterQuery}"`
              : "Administrative actions performed in this workspace will be recorded here."}
          </p>
        </div>
      ) : (
        <div className="card" style={{ padding: "8px" }}>
          <div className="table-wrapper" style={{ border: "none" }}>
            <table>
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Action</th>
                  <th>Actor</th>
                  <th style={{ textAlign: "right" }}>Metadata</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs?.map((entry) => {
                  const isExpanded = expandedLogId === entry.id;
                  const date = new Date(entry.createdAt);

                  return (
                    <tr key={entry.id} style={{ verticalAlign: "top" }}>
                      <td style={{ whiteSpace: "nowrap", width: "180px" }}>
                        <div style={{ fontWeight: 600, fontSize: "0.8125rem", color: "var(--text-primary)" }}>
                          {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                        </div>
                        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                          {date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}
                        </div>
                      </td>

                      <td>
                        <span className={`badge ${getActionBadgeClass(entry.action)}`} style={{ fontSize: "0.75rem" }}>
                          {entry.action}
                        </span>
                      </td>

                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <div
                            style={{
                              width: "24px",
                              height: "24px",
                              borderRadius: "50%",
                              background: entry.actor ? "var(--bg-overlay)" : "var(--bg-hover)",
                              border: "1px solid var(--border-subtle)",
                              display: "grid",
                              placeItems: "center",
                              fontSize: "11px",
                              fontWeight: 700,
                              color: "var(--brand-accent)",
                              flexShrink: 0,
                            }}
                          >
                            {entry.actor?.name?.slice(0, 1).toUpperCase() || entry.actor?.email?.slice(0, 1).toUpperCase() || "⚙"}
                          </div>
                          <div>
                            <div style={{ fontSize: "0.8125rem", fontWeight: 600, color: "var(--text-primary)" }}>
                              {entry.actor?.name || entry.actor?.email?.split("@")[0] || "System Engine"}
                            </div>
                            {entry.actor?.email && (
                              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                                {entry.actor.email}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>

                      <td style={{ textAlign: "right" }}>
                        {entry.metadata && Object.keys(entry.metadata as object).length > 0 ? (
                          <div>
                            <button
                              onClick={() => setExpandedLogId(isExpanded ? null : entry.id)}
                              className="btn btn-ghost btn-sm"
                              style={{ fontSize: "0.75rem", padding: "4px 8px" }}
                            >
                              {isExpanded ? "Hide Metadata ▲" : "Inspect Payload ▼"}
                            </button>

                            {isExpanded && (
                              <div
                                style={{
                                  marginTop: "8px",
                                  textAlign: "left",
                                  background: "var(--bg-base)",
                                  padding: "10px 12px",
                                  borderRadius: "var(--radius-sm)",
                                  border: "1px solid var(--border-emphasis)",
                                  fontSize: "0.75rem",
                                  maxWidth: "400px",
                                  marginLeft: "auto",
                                  overflowX: "auto",
                                }}
                              >
                                <pre style={{ margin: 0, color: "var(--text-secondary)" }}>
                                  {JSON.stringify(entry.metadata, null, 2)}
                                </pre>
                              </div>
                            )}
                          </div>
                        ) : (
                          <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
