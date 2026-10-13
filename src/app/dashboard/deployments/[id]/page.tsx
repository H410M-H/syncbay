"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect, useRef, useMemo } from "react";
import { trpc } from "@/lib/trpc-client";
import { BackButton } from "@/components/ui/back-button";

const statusClass = (status: string) =>
  status === "ACTIVE" ? "badge-active" :
  status === "BUILDING" || status === "DEPLOYING" ? "badge-building" :
  status === "FAILED" || status === "CRASHED" ? "badge-failed" :
  status === "QUEUED" ? "badge-queued" : "badge-sleeping";

interface LogEntry {
  id: string;
  deploymentId: string;
  timestamp: string;
  stream: "stdout" | "stderr" | "system";
  message: string;
}

export default function DeploymentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const deploymentId = params.id as string;

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const logContainerRef = useRef<HTMLPreElement>(null);

  const [autoScroll, setAutoScroll] = useState(true);
  const [copiedNotice, setCopiedNotice] = useState<string | null>(null);
  const [liveLogs, setLiveLogs] = useState<LogEntry[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Queries
  const deploymentQuery = trpc.deployment.byId.useQuery(
    { deploymentId },
    {
      refetchInterval: (data) => {
        const status = data?.state?.data?.status;
        return status === "QUEUED" || status === "BUILDING" || status === "DEPLOYING" ? 2500 : false;
      },
    }
  );

  const isRunning = useMemo(() => {
    const s = deploymentQuery.data?.status;
    return s === "QUEUED" || s === "BUILDING" || s === "DEPLOYING";
  }, [deploymentQuery.data?.status]);

  const logsQuery = trpc.deployment.logs.useQuery(
    { deploymentId },
    {
      refetchInterval: isRunning ? 3000 : false,
    }
  );

  // Mutations
  const redeployMutation = trpc.deployment.redeploy.useMutation();
  const rollbackMutation = trpc.deployment.instantRollback.useMutation();
  const cancelMutation = trpc.deployment.cancel.useMutation();
  const deleteMutation = trpc.deployment.delete.useMutation();

  // Close actions menu on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  // Connect to SSE log stream for live streaming
  useEffect(() => {
    if (!deploymentId) return;

    let eventSource: EventSource | null = null;
    try {
      eventSource = new EventSource(`/api/deployments/${encodeURIComponent(deploymentId)}/logs/stream`);

      eventSource.onmessage = (event) => {
        try {
          if (!event.data || event.data.startsWith(":")) return;
          const parsed = JSON.parse(event.data);
          if (parsed && parsed.message) {
            setLiveLogs((prev) => {
              if (prev.some((l) => l.id === parsed.id || (l.message === parsed.message && l.timestamp === parsed.timestamp))) {
                return prev;
              }
              return [...prev, parsed];
            });
          }
        } catch {
          // ignore non-json keepalives
        }
      };

      eventSource.onerror = () => {
        // SSE will attempt auto-reconnect, fallback polling handles it
      };
    } catch {
      // EventSource fallback to trpc polling
    }

    return () => {
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [deploymentId]);

  // Auto-scroll logs
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [liveLogs, logsQuery.data, autoScroll]);

  // Merge static query logs with live streamed logs
  const allLogs = useMemo(() => {
    const fromQuery = (logsQuery.data || []) as LogEntry[];
    const combined = [...fromQuery];
    const existingMessages = new Set(fromQuery.map((l) => `${l.timestamp}_${l.message}`));

    for (const log of liveLogs) {
      const key = `${log.timestamp}_${log.message}`;
      if (!existingMessages.has(key)) {
        existingMessages.add(key);
        combined.push(log);
      }
    }

    return combined.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }, [logsQuery.data, liveLogs]);

  const runAction = async (action: () => Promise<any>, successMessage: string) => {
    try {
      setMenuOpen(false);
      const res = await action();
      setNotice(successMessage);
      await deploymentQuery.refetch();
      await logsQuery.refetch();

      // If a new deployment was created from redeploy, offer or navigate to it
      if (res && res.id && res.id !== deploymentId) {
        router.push(`/dashboard/deployments/${res.id}?view=logs`);
      }
    } catch (error: any) {
      setNotice(error?.message || "Action failed");
    }
  };

  const handleDeleteDeployment = async () => {
    if (!confirm(`Are you sure you want to permanently delete deployment ${deploymentId.slice(0, 8)}? This cannot be undone.`)) {
      return;
    }
    setIsDeleting(true);
    try {
      await deleteMutation.mutateAsync({ deploymentId });
      setNotice("Deployment deleted successfully.");
      // Navigate to project console or dashboard
      const projectId = deploymentQuery.data?.service?.environment?.projectId;
      if (projectId) {
        router.push(`/dashboard/projects/${projectId}?tab=deployments`);
      } else {
        router.push("/dashboard");
      }
    } catch (err: any) {
      setIsDeleting(false);
      setNotice(err?.message || "Failed to delete deployment");
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopiedNotice(`${label} copied to clipboard!`);
      setTimeout(() => setCopiedNotice(null), 2500);
    }
  };

  if (deploymentQuery.isLoading) {
    return (
      <main className="dashboard-page">
        <BackButton fallbackUrl="/dashboard" />
        <div className="card" style={{ padding: "40px", textAlign: "center" }}>
          <div className="loading-bar" style={{ width: "160px", margin: "0 auto 16px" }} />
          <p style={{ color: "var(--text-muted)" }}>Loading deployment details…</p>
        </div>
      </main>
    );
  }

  if (deploymentQuery.error || !deploymentQuery.data) {
    return (
      <main className="dashboard-page">
        <BackButton fallbackUrl="/dashboard" />
        <div className="card" style={{ padding: "32px", textAlign: "center" }}>
          <h2 style={{ marginBottom: "8px" }}>Deployment Not Found</h2>
          <p style={{ color: "var(--text-secondary)", marginBottom: "20px" }}>
            The requested deployment could not be found or you lack permission.
          </p>
          <Link href="/dashboard" className="btn btn-primary">
            Back to Dashboard
          </Link>
        </div>
      </main>
    );
  }

  const deployment = deploymentQuery.data;
  const showLogs = searchParams.get("view") === "logs" || true; // Default to showing logs directly
  const activeServiceUrl = deployment.status === "ACTIVE"
    ? `https://${deployment.service.name}-${deployment.service.environment.name}.syncbay.app`
    : null;

  return (
    <main className="dashboard-page fade-in">
      {/* ── Top Navigation with Back Arrow Button ── */}
      <div style={{ marginBottom: "12px" }}>
        <BackButton fallbackUrl="/dashboard" label="Back to Dashboard" />
      </div>

      {/* ── Page Header & Action Menu ── */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "16px",
          flexWrap: "wrap",
          marginBottom: "20px",
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <h1 style={{ margin: 0, fontSize: "1.75rem", fontWeight: 700 }}>
              Deployment <code style={{ fontSize: "1.35rem" }}>{deployment.id.slice(0, 8)}</code>
            </h1>
            <span className={`badge ${statusClass(deployment.status)}`}>
              {deployment.status}
            </span>
          </div>
          <p style={{ margin: "6px 0 0", color: "var(--text-secondary)", fontSize: "0.875rem" }}>
            Service: <strong>{deployment.service.name}</strong> · Environment: <strong>{deployment.service.environment.name}</strong>
          </p>
        </div>

        {/* ── Dropdown Actions Menu Button ── */}
        <div style={{ position: "relative" }} ref={menuRef}>
          <button
            type="button"
            className="btn btn-primary"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={() => setMenuOpen((open) => !open)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
              padding: "8px 16px",
              fontWeight: 600,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="1"></circle>
              <circle cx="19" cy="12" r="1"></circle>
              <circle cx="5" cy="12" r="1"></circle>
            </svg>
            <span>Deployment Actions</span>
            <span style={{ fontSize: "10px", marginLeft: "2px", opacity: 0.8 }}>▼</span>
          </button>

          {menuOpen && (
            <div
              role="menu"
              style={{
                position: "absolute",
                right: 0,
                top: "calc(100% + 8px)",
                zIndex: 50,
                minWidth: "240px",
                padding: "6px",
                border: "1px solid var(--border-default)",
                borderRadius: "12px",
                background: "var(--bg-elevated)",
                backdropFilter: "blur(20px)",
                boxShadow: "0 12px 32px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.08)",
                animation: "fadeIn 0.15s ease-out",
              }}
            >
              {/* Live Service URL if ACTIVE */}
              {activeServiceUrl && (
                <a
                  href={activeServiceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  role="menuitem"
                  className="btn btn-ghost btn-sm"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    width: "100%",
                    textAlign: "left",
                    color: "var(--brand-accent)",
                    fontWeight: 600,
                  }}
                  onClick={() => setMenuOpen(false)}
                >
                  <span>🌐</span>
                  <span>Open Live Application</span>
                  <span style={{ marginLeft: "auto", fontSize: "10px" }}>↗</span>
                </a>
              )}

              {/* Running Cancel */}
              {isRunning ? (
                <button
                  type="button"
                  role="menuitem"
                  className="btn btn-ghost btn-sm"
                  style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%", textAlign: "left", color: "#f87171" }}
                  onClick={() => runAction(() => cancelMutation.mutateAsync({ deploymentId }), "Deployment cancelled")}
                >
                  <span>🛑</span>
                  <span>Cancel Deployment</span>
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="btn btn-ghost btn-sm"
                    style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%", textAlign: "left" }}
                    onClick={() => runAction(() => redeployMutation.mutateAsync({ deploymentId, rebuild: false }), "Redeploy triggered")}
                  >
                    <span>🔄</span>
                    <span>Redeploy (Fast)</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="btn btn-ghost btn-sm"
                    style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%", textAlign: "left" }}
                    onClick={() => runAction(() => redeployMutation.mutateAsync({ deploymentId, rebuild: true }), "Clean rebuild triggered")}
                  >
                    <span>⚡</span>
                    <span>Clean Rebuild</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="btn btn-ghost btn-sm"
                    style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%", textAlign: "left" }}
                    onClick={() => runAction(() => rollbackMutation.mutateAsync({ deploymentId }), "Traffic rolled back to this deployment")}
                  >
                    <span>⏪</span>
                    <span>Roll Back Traffic to This</span>
                  </button>
                </>
              )}

              <hr style={{ border: "none", borderTop: "1px solid var(--border-subtle)", margin: "4px 0" }} />

              {/* Copy actions */}
              <button
                type="button"
                role="menuitem"
                className="btn btn-ghost btn-sm"
                style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%", textAlign: "left", fontSize: "0.8125rem" }}
                onClick={() => {
                  copyToClipboard(deployment.id, "Deployment ID");
                  setMenuOpen(false);
                }}
              >
                <span>📋</span>
                <span>Copy Deployment ID</span>
              </button>

              {deployment.build?.commitSha && (
                <button
                  type="button"
                  role="menuitem"
                  className="btn btn-ghost btn-sm"
                  style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%", textAlign: "left", fontSize: "0.8125rem" }}
                  onClick={() => {
                    copyToClipboard(deployment.build!.commitSha!, "Commit SHA");
                    setMenuOpen(false);
                  }}
                >
                  <span>🔀</span>
                  <span>Copy Commit SHA</span>
                </button>
              )}

              <hr style={{ border: "none", borderTop: "1px solid var(--border-subtle)", margin: "4px 0" }} />

              {/* Danger: Delete Deployment */}
              <button
                type="button"
                role="menuitem"
                disabled={isDeleting}
                className="btn btn-ghost btn-sm"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  width: "100%",
                  textAlign: "left",
                  color: "#ef4444",
                  fontWeight: 600,
                }}
                onClick={handleDeleteDeployment}
              >
                <span>🗑️</span>
                <span>{isDeleting ? "Deleting..." : "Delete Deployment"}</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Notices */}
      {notice && (
        <div className="card" role="status" style={{ marginBottom: "16px", borderColor: "var(--brand-primary)" }}>
          {notice}
        </div>
      )}
      {copiedNotice && (
        <div className="card" role="status" style={{ marginBottom: "16px", borderColor: "#10b981", color: "#10b981" }}>
          ✔ {copiedNotice}
        </div>
      )}

      {/* ── Metadata Summary Card ── */}
      <section className="card" style={{ marginBottom: "20px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px" }}>
          <div>
            <small style={{ color: "var(--text-muted)", fontSize: "0.75rem", textTransform: "uppercase" }}>Target Commit</small>
            <div style={{ marginTop: "4px" }}>
              <code>{deployment.build?.commitSha?.slice(0, 7) || "manual"}</code>
            </div>
          </div>
          <div>
            <small style={{ color: "var(--text-muted)", fontSize: "0.75rem", textTransform: "uppercase" }}>Created</small>
            <div style={{ marginTop: "4px", fontSize: "0.875rem" }}>
              {new Date(deployment.createdAt).toLocaleString()}
            </div>
          </div>
          <div>
            <small style={{ color: "var(--text-muted)", fontSize: "0.75rem", textTransform: "uppercase" }}>Triggered By</small>
            <div style={{ marginTop: "4px", fontSize: "0.875rem" }}>
              {deployment.triggeredBy || "Console"}
            </div>
          </div>
          <div>
            <small style={{ color: "var(--text-muted)", fontSize: "0.75rem", textTransform: "uppercase" }}>Runtime Container</small>
            <div style={{ marginTop: "4px" }}>
              <code>{deployment.cfContainerId || (isRunning ? "allocating..." : "idle")}</code>
            </div>
          </div>
        </div>
        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid var(--border-subtle)" }}>
          <p style={{ color: "var(--text-secondary)", margin: 0, fontSize: "0.875rem" }}>
            <strong>Message:</strong> {deployment.build?.commitMessage || "Triggered via console"}
          </p>
        </div>
      </section>

      {/* ── Deployment Logs Section ── */}
      <section className="card">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "12px",
            marginBottom: "14px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <h2 style={{ margin: 0, fontSize: "1.125rem" }}>Deployment Logs</h2>
            {isRunning && (
              <span className="badge badge-building" style={{ fontSize: "0.6875rem" }}>
                ● Live Streaming
              </span>
            )}
            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
              ({allLogs.length} line{allLogs.length === 1 ? "" : "s"})
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.75rem", cursor: "pointer", color: "var(--text-secondary)" }}>
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
              />
              Auto-scroll
            </label>

            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                logsQuery.refetch();
                deploymentQuery.refetch();
              }}
              title="Refresh Logs"
              style={{ fontSize: "0.75rem", padding: "4px 8px" }}
            >
              🔄 Refresh
            </button>

            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                const text = allLogs.map((l) => `[${new Date(l.timestamp).toLocaleTimeString()}] ${l.message}`).join("\n");
                copyToClipboard(text, "Logs");
              }}
              title="Copy All Logs"
              style={{ fontSize: "0.75rem", padding: "4px 8px" }}
            >
              📋 Copy
            </button>
          </div>
        </div>

        {/* ── Log Console Output ── */}
        <pre
          ref={logContainerRef}
          style={{
            minHeight: "260px",
            maxHeight: "580px",
            overflow: "auto",
            padding: "16px",
            borderRadius: "10px",
            background: "#08080f",
            border: "1px solid rgba(255, 255, 255, 0.08)",
            color: "#e2e8f0",
            fontFamily: "var(--font-mono, 'JetBrains Mono', 'Fira Code', monospace)",
            fontSize: "0.8125rem",
            lineHeight: "1.6",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            margin: 0,
          }}
        >
          {allLogs.length > 0 ? (
            allLogs.map((log, idx) => {
              const isError = log.stream === "stderr" || log.message.includes("[error]") || log.message.includes("Error:");
              const isSystem = log.stream === "system" || log.message.startsWith("[syncbay]") || log.message.startsWith("[proxy]") || log.message.startsWith("[deploy]");
              const isHealth = log.message.startsWith("[health]");

              let color = "#e2e8f0";
              if (isError) color = "#f87171";
              else if (isHealth) color = "#34d399";
              else if (isSystem) color = "#38bdf8";

              return (
                <div key={log.id || idx} style={{ display: "flex", gap: "10px", color }}>
                  <span style={{ color: "#64748b", userSelect: "none", flexShrink: 0 }}>
                    [{new Date(log.timestamp).toLocaleTimeString()}]
                  </span>
                  <span>{log.message}</span>
                </div>
              );
            })
          ) : (
            <div style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
              Waiting for runner agent logs...
            </div>
          )}
        </pre>
      </section>
    </main>
  );
}
