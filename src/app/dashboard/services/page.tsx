"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { trpc } from "@/lib/trpc-client";
import { useDashboard } from "../dashboard-shell";

export default function ServicesPage() {
  const dashboard = useDashboard();
  const { data: workspaces, isLoading: wsLoading } = trpc.workspace.list.useQuery();
  const [selectedWsId, setSelectedWsId] = useState<string>("");

  const activeWorkspace =
    workspaces?.find((w) => w.id === (selectedWsId || dashboard?.currentWorkspace?.id)) ||
    dashboard?.currentWorkspace ||
    workspaces?.[0];

  const workspaceId = activeWorkspace?.id;

  const {
    data: services,
    isLoading: servicesLoading,
    refetch: refetchServices,
  } = trpc.service.list.useQuery(
    { workspaceId },
    { enabled: !!workspaceId }
  );

  const [restartingId, setRestartingId] = useState<string | null>(null);
  const [pausingId, setPausingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [viewLogsDeployId, setViewLogsDeployId] = useState<string | null>(null);

  const restartMutation = trpc.service.restart.useMutation();
  const pauseMutation = trpc.service.setPaused.useMutation();
  const deleteMutation = trpc.service.delete.useMutation();

  const handleRestart = async (serviceId: string) => {
    setRestartingId(serviceId);
    try {
      await restartMutation.mutateAsync({ serviceId });
      await refetchServices();
    } catch (err: any) {
      alert(err.message || "Failed to restart service");
    } finally {
      setRestartingId(null);
    }
  };

  const handleTogglePause = async (serviceId: string, currentPaused: boolean) => {
    setPausingId(serviceId);
    try {
      await pauseMutation.mutateAsync({ serviceId, paused: !currentPaused });
      await refetchServices();
    } catch (err: any) {
      alert(err.message || "Failed to toggle service state");
    } finally {
      setPausingId(null);
    }
  };

  const handleDelete = async (serviceId: string) => {
    if (!confirm("Are you sure you want to delete this service? All active edge routes will be deactivated.")) {
      return;
    }
    setDeletingId(serviceId);
    try {
      await deleteMutation.mutateAsync({ serviceId });
      await refetchServices();
    } catch (err: any) {
      alert(err.message || "Failed to delete service");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Edge Microservices</h1>
          <p className="page-subtitle">
            Containerized web services, APIs, and background workers running with 0ms cold starts.
          </p>
        </div>
        <Link href="/dashboard/services/new" className="btn btn-primary">
          ＋ New Service
        </Link>
      </div>

      {/* Workspace Switcher */}
      <div
        style={{
          display: "flex",
          gap: "8px",
          marginBottom: "24px",
          borderBottom: "1px solid var(--border-subtle)",
          paddingBottom: "16px",
          flexWrap: "wrap",
        }}
      >
        {workspaces?.map((ws) => (
          <button
            key={ws.id}
            onClick={() => setSelectedWsId(ws.id)}
            className={`btn btn-sm ${
              (selectedWsId || dashboard?.currentWorkspace?.id) === ws.id
                ? "btn-secondary"
                : "btn-ghost"
            }`}
            style={
              (selectedWsId || dashboard?.currentWorkspace?.id) === ws.id
                ? { borderColor: "var(--brand-primary)" }
                : {}
            }
          >
            <span>{ws.isPersonal ? "👤" : "🏢"}</span> {ws.name}
          </button>
        ))}
      </div>

      {servicesLoading || wsLoading ? (
        <div style={{ textAlign: "center", padding: "64px" }}>
          <div className="loading-bar" style={{ width: "200px", margin: "0 auto 16px" }} />
          <p style={{ color: "var(--text-muted)" }}>Loading microservices...</p>
        </div>
      ) : !services || services.length === 0 ? (
        <div className="empty-state card" style={{ padding: "48px 24px", textAlign: "center" }}>
          <div className="empty-icon" style={{ fontSize: "42px", marginBottom: "12px" }}>
            ⚡
          </div>
          <h3 style={{ fontSize: "1.25rem", marginBottom: "8px" }}>No Microservices Found</h3>
          <p style={{ color: "var(--text-secondary)", maxWidth: "480px", margin: "0 auto 20px" }}>
            Deploy your first service from a Git repository or Dockerfile. Syncbay auto-detects
            Node.js, Python, Go, Rust, Ruby, and container configurations.
          </p>
          <Link href="/dashboard/services/new" className="btn btn-primary">
            Deploy New Service
          </Link>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {services.map((svc: any) => {
            const isPaused = svc.isPaused;
            const primaryDomain = svc.domains?.[0]?.hostname || `${svc.name}.syncbay.run`;

            return (
              <div
                key={svc.id}
                className="card"
                style={{
                  padding: "20px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "14px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    flexWrap: "wrap",
                    gap: "12px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <div
                      style={{
                        width: "44px",
                        height: "44px",
                        borderRadius: "var(--radius-md)",
                        background: "rgba(6,182,212,0.15)",
                        color: "#38bdf8",
                        display: "grid",
                        placeItems: "center",
                        fontSize: "20px",
                      }}
                    >
                      ⚡
                    </div>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <h3 style={{ fontSize: "1.1rem", fontWeight: 700 }}>{svc.name}</h3>
                        <span
                          className={`badge ${isPaused ? "badge-queued" : "badge-active"}`}
                          style={{ fontSize: "0.7rem" }}
                        >
                          {isPaused ? "SLEEPING" : "ACTIVE"}
                        </span>
                        <span className="badge badge-secondary" style={{ fontSize: "0.7rem" }}>
                          {svc.sourceType || "Nixpacks"}
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: "0.8rem",
                          color: "var(--text-muted)",
                          display: "flex",
                          gap: "12px",
                          marginTop: "2px",
                          flexWrap: "wrap",
                        }}
                      >
                        <span>Project: {svc.environment?.project?.name || "Default"}</span>
                        <span>•</span>
                        <span>Scaling: {svc.scaleToZero ? "0ms Cold-Start" : "Always-On"}</span>
                        <span>•</span>
                        <span>Type: {svc.instanceType || "lite"}</span>
                      </div>
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <button
                      onClick={() => handleRestart(svc.id)}
                      disabled={restartingId === svc.id}
                      className="btn btn-secondary btn-sm"
                      style={{ fontSize: "0.75rem" }}
                    >
                      {restartingId === svc.id ? "Restarting..." : "🔄 Restart"}
                    </button>
                    <button
                      onClick={() => handleTogglePause(svc.id, isPaused)}
                      disabled={pausingId === svc.id}
                      className="btn btn-ghost btn-sm"
                      style={{ fontSize: "0.75rem" }}
                    >
                      {pausingId === svc.id ? "Updating..." : isPaused ? "▶ Resume" : "⏸ Pause"}
                    </button>
                    <button
                      onClick={() => setViewLogsDeployId(svc.deployments?.[0]?.id || null)}
                      disabled={!svc.deployments?.[0]?.id}
                      className="btn btn-ghost btn-sm"
                      style={{ fontSize: "0.75rem" }}
                    >
                      Logs
                    </button>
                    {svc.environment?.project?.id && (
                      <Link
                        href={`/dashboard/projects/${svc.environment.project.id}`}
                        className="btn btn-ghost btn-sm"
                        style={{ fontSize: "0.75rem" }}
                      >
                        Console
                      </Link>
                    )}
                    <Link
                      href={`/dashboard/services/${svc.id}`}
                      className="btn btn-secondary btn-sm"
                      style={{ fontSize: "0.75rem" }}
                    >
                      Details →
                    </Link>
                    <button
                      onClick={() => handleDelete(svc.id)}
                      disabled={deletingId === svc.id}
                      className="btn btn-danger btn-sm"
                      style={{ fontSize: "0.75rem" }}
                    >
                      {deletingId === svc.id ? "..." : "Delete"}
                    </button>
                  </div>
                </div>

                {/* Edge Ingress URL */}
                <div
                  style={{
                    background: "var(--bg-overlay)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "var(--radius-sm)",
                    padding: "8px 12px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    fontSize: "0.8125rem",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ color: "var(--text-muted)" }}>Edge Endpoint:</span>
                    <a
                      href={`https://${primaryDomain}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "var(--brand-accent)", textDecoration: "underline" }}
                    >
                      https://{primaryDomain}
                    </a>
                  </div>
                  <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                    Port: {svc.port || 3000}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {viewLogsDeployId && (
        <LogsModal deployId={viewLogsDeployId} onClose={() => setViewLogsDeployId(null)} />
      )}
    </div>
  );
}

function LogsModal({ deployId, onClose }: { deployId: string; onClose: () => void }) {
  const [logs, setLogs] = useState<any[]>([]);
  const { data: initialLogs } = trpc.deployment.logs.useQuery({ deploymentId: deployId });

  useEffect(() => {
    if (initialLogs) setLogs(initialLogs as any[]);
  }, [initialLogs]);

  useEffect(() => {
    const eventSource = new EventSource(`/api/deployments/${deployId}/logs/stream`);
    eventSource.onmessage = (event) => {
      try {
        const entry = JSON.parse(event.data);
        setLogs((prev) => {
          if (prev.some((l) => l.id === entry.id)) return prev;
          return [...prev, entry];
        });
      } catch {}
    };
    return () => eventSource.close();
  }, [deployId]);

  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
      background: "rgba(0,0,0,0.6)", zIndex: 1000,
      display: "flex", justifyContent: "center", alignItems: "center",
      padding: "20px"
    }}>
      <div className="card" style={{
        width: "100%", maxWidth: "900px", height: "80vh",
        display: "flex", flexDirection: "column",
        background: "var(--bg-card)",
      }}>
        <div style={{ padding: "16px", borderBottom: "1px solid var(--border-subtle)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>Deployment Logs</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "16px", background: "#0a0a0a", color: "#d4d4d4", fontFamily: "monospace", fontSize: "13px" }}>
          {logs.map((log, i) => (
            <div key={log.id || i} style={{ marginBottom: "4px" }}>
              <span style={{ color: "#888", marginRight: "8px" }}>[{new Date(log.timestamp).toLocaleTimeString()}]</span>
              <span style={{ color: log.stream === "stderr" ? "#ff7b72" : log.stream === "system" ? "#79c0ff" : "inherit" }}>
                {log.message}
              </span>
            </div>
          ))}
          {logs.length === 0 && <div style={{ color: "#888" }}>Waiting for logs...</div>}
        </div>
      </div>
    </div>
  );
}
