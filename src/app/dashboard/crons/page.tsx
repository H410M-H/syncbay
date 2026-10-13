"use client";

import { useState } from "react";
import Link from "next/link";
import { trpc } from "@/lib/trpc-client";
import { useDashboard } from "../dashboard-shell";
import { BackButton } from "@/components/ui/back-button";

export default function CronsPage() {
  const dashboard = useDashboard();
  const { data: workspaces, isLoading: wsLoading } = trpc.workspace.list.useQuery();
  const [selectedWsId, setSelectedWsId] = useState<string>("");

  const activeWorkspace =
    workspaces?.find((w) => w.id === (selectedWsId || dashboard?.currentWorkspace?.id)) ||
    dashboard?.currentWorkspace ||
    workspaces?.[0];

  const workspaceId = activeWorkspace?.id;

  const { data: services, isLoading: servicesLoading } = trpc.service.list.useQuery(
    { workspaceId },
    { enabled: !!workspaceId }
  );

  const [selectedServiceId, setSelectedServiceId] = useState<string>("");
  const activeService =
    services?.find((s) => s.id === (selectedServiceId || services?.[0]?.id)) ||
    services?.[0];
  const serviceId = activeService?.id || "svc_default_edge";

  const {
    data: crons,
    isLoading: cronsLoading,
    refetch: refetchCrons,
  } = trpc.devops.listCrons.useQuery(
    { serviceId },
    { enabled: !!serviceId }
  );

  const [triggeringId, setTriggeringId] = useState<string | null>(null);
  const [triggerResult, setTriggerResult] = useState<any | null>(null);
  const [selectedCronForLogs, setSelectedCronForLogs] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  // New Cron Form
  const [newCronName, setNewCronName] = useState("");
  const [newCronSchedule, setNewCronSchedule] = useState("0 0 * * *");
  const [newCronPath, setNewCronPath] = useState("/api/cron/maintenance");
  const [newCronMethod, setNewCronMethod] = useState<"GET" | "POST">("POST");
  const [creatingCron, setCreatingCron] = useState(false);
  const [createError, setCreateError] = useState("");

  const triggerMutation = trpc.devops.triggerCron.useMutation();
  const toggleMutation = trpc.devops.toggleCron.useMutation();
  const deleteMutation = trpc.devops.deleteCron.useMutation();
  const createMutation = trpc.devops.createCron.useMutation();

  const { data: cronLogs, isLoading: logsLoading } = trpc.devops.getCronLogs.useQuery(
    { cronId: selectedCronForLogs! },
    { enabled: !!selectedCronForLogs }
  );

  const handleTrigger = async (cronId: string) => {
    setTriggeringId(cronId);
    setTriggerResult(null);
    try {
      const res = await triggerMutation.mutateAsync({ cronId });
      setTriggerResult(res);
      await refetchCrons();
    } catch (err: any) {
      alert(err.message || "Failed to trigger cron job");
    } finally {
      setTriggeringId(null);
    }
  };

  const handleToggle = async (cronId: string, currentEnabled: boolean) => {
    try {
      await toggleMutation.mutateAsync({ cronId, enabled: !currentEnabled });
      await refetchCrons();
    } catch (err: any) {
      alert(err.message || "Failed to update cron job");
    }
  };

  const handleDelete = async (cronId: string) => {
    if (!confirm("Are you sure you want to delete this scheduled cron task?")) return;
    try {
      await deleteMutation.mutateAsync({ cronId });
      await refetchCrons();
    } catch (err: any) {
      alert(err.message || "Failed to delete cron job");
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!serviceId) return;
    setCreateError("");
    setCreatingCron(true);
    try {
      await createMutation.mutateAsync({
        serviceId,
        name: newCronName.trim(),
        schedule: newCronSchedule.trim(),
        path: newCronPath.trim(),
        method: newCronMethod,
      });
      await refetchCrons();
      setShowCreateModal(false);
      setNewCronName("");
    } catch (err: any) {
      setCreateError(err.message || "Failed to create cron job");
    } finally {
      setCreatingCron(false);
    }
  };

  return (
    <div className="fade-in">
      <div style={{ marginBottom: "16px" }}>
        <BackButton fallbackUrl="/dashboard" label="Back to Dashboard" />
      </div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Smart Crons &amp; Edge Schedulers</h1>
          <p className="page-subtitle">
            Autonomous scheduled tasks for customer acquisition, backup verification, and telemetry prune.
          </p>
        </div>
        <div style={{ display: "flex", gap: "10px" }}>
          <button
            onClick={() => setShowCreateModal(true)}
            className="btn btn-primary"
            disabled={!serviceId}
          >
            ＋ New Cron Task
          </button>
        </div>
      </div>

      {/* Service Selector */}
      <div
        style={{
          display: "flex",
          gap: "12px",
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: "24px",
          borderBottom: "1px solid var(--border-subtle)",
          paddingBottom: "16px",
        }}
      >
        <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>Target Service:</span>
        {services?.map((svc) => (
          <button
            key={svc.id}
            onClick={() => setSelectedServiceId(svc.id)}
            className={`btn btn-sm ${
              (selectedServiceId || services?.[0]?.id) === svc.id ? "btn-secondary" : "btn-ghost"
            }`}
            style={
              (selectedServiceId || services?.[0]?.id) === svc.id
                ? { borderColor: "var(--brand-primary)" }
                : {}
            }
          >
            ⚡ {svc.name}
          </button>
        ))}
      </div>

      {/* Trigger Notification Toast */}
      {triggerResult && (
        <div
          className="card fade-in"
          style={{
            marginBottom: "20px",
            borderLeft: "4px solid #10b981",
            padding: "16px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontWeight: 700, color: "#10b981", fontSize: "0.875rem" }}>
              ✓ Cron Executed Successfully (HTTP {triggerResult.statusCode})
            </div>
            <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginTop: "4px" }}>
              Duration: {triggerResult.durationMs}ms • Snippet: {triggerResult.responseSnippet}
            </div>
          </div>
          <button
            onClick={() => setTriggerResult(null)}
            className="btn btn-ghost btn-sm"
            style={{ fontSize: "0.75rem" }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Crons List */}
      {cronsLoading || servicesLoading ? (
        <div style={{ textAlign: "center", padding: "64px" }}>
          <div className="loading-bar" style={{ width: "200px", margin: "0 auto 16px" }} />
          <p style={{ color: "var(--text-muted)" }}>Loading scheduled cron jobs...</p>
        </div>
      ) : !crons || crons.length === 0 ? (
        <div className="empty-state card" style={{ padding: "48px 24px", textAlign: "center" }}>
          <div className="empty-icon" style={{ fontSize: "42px", marginBottom: "12px" }}>
            ⏱️
          </div>
          <h3 style={{ fontSize: "1.25rem", marginBottom: "8px" }}>No Scheduled Crons</h3>
          <p style={{ color: "var(--text-secondary)", maxWidth: "480px", margin: "0 auto 20px" }}>
            Set up autonomous cron jobs to call your HTTP routes on a periodic schedule without
            keeping long-running servers awake.
          </p>
          <button onClick={() => setShowCreateModal(true)} className="btn btn-primary">
            Schedule First Cron Job
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {crons.map((cron) => {
            const isEnabled = cron.enabled;

            return (
              <div
                key={cron.id}
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
                        background: isEnabled ? "rgba(16,185,129,0.15)" : "rgba(100,116,139,0.15)",
                        color: isEnabled ? "#34d399" : "#94a3b8",
                        display: "grid",
                        placeItems: "center",
                        fontSize: "20px",
                      }}
                    >
                      ⏱️
                    </div>

                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <h3 style={{ fontSize: "1.05rem", fontWeight: 700 }}>{cron.name}</h3>
                        <span
                          className={`badge ${isEnabled ? "badge-active" : "badge-queued"}`}
                          style={{ fontSize: "0.7rem" }}
                        >
                          {isEnabled ? "ACTIVE" : "DISABLED"}
                        </span>
                        <span
                          className="badge badge-secondary"
                          style={{ fontSize: "0.7rem", fontFamily: "var(--font-mono)" }}
                        >
                          {cron.schedule}
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
                        <span>Target: {cron.method} {cron.path}</span>
                        <span>•</span>
                        <span>Next Run: {new Date(cron.nextRunAt).toLocaleTimeString()}</span>
                        {cron.lastRunAt && (
                          <>
                            <span>•</span>
                            <span>Last Status: {cron.lastStatus} ({cron.lastDurationMs}ms)</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <button
                      onClick={() => handleTrigger(cron.id)}
                      disabled={triggeringId === cron.id}
                      className="btn btn-secondary btn-sm"
                      style={{ fontSize: "0.75rem" }}
                    >
                      {triggeringId === cron.id ? "Dispatching..." : "⚡ Run Now"}
                    </button>
                    <button
                      onClick={() => handleToggle(cron.id, isEnabled)}
                      className="btn btn-ghost btn-sm"
                      style={{ fontSize: "0.75rem" }}
                    >
                      {isEnabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      onClick={() => setSelectedCronForLogs(cron.id)}
                      className="btn btn-ghost btn-sm"
                      style={{ fontSize: "0.75rem" }}
                    >
                      📜 Logs
                    </button>
                    <button
                      onClick={() => handleDelete(cron.id)}
                      className="btn btn-danger btn-sm"
                      style={{ fontSize: "0.75rem" }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Logs Modal */}
      {selectedCronForLogs && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.75)",
            backdropFilter: "blur(6px)",
            display: "grid",
            placeItems: "center",
            zIndex: 1000,
            padding: "20px",
          }}
        >
          <div className="card fade-in" style={{ width: "100%", maxWidth: "600px", padding: "28px" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "16px",
              }}
            >
              <h3 style={{ fontSize: "1.1rem", fontWeight: 700 }}>Cron Execution History</h3>
              <button
                onClick={() => setSelectedCronForLogs(null)}
                className="btn btn-ghost btn-sm"
              >
                ✕
              </button>
            </div>

            {logsLoading ? (
              <p style={{ color: "var(--text-muted)" }}>Loading run logs...</p>
            ) : !cronLogs || cronLogs.length === 0 ? (
              <p style={{ color: "var(--text-muted)" }}>No execution history recorded yet.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "300px", overflowY: "auto" }}>
                {cronLogs.map((log) => (
                  <div
                    key={log.id}
                    style={{
                      background: "var(--bg-overlay)",
                      border: "1px solid var(--border-subtle)",
                      borderRadius: "var(--radius-sm)",
                      padding: "10px",
                      fontSize: "0.8rem",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <div>
                      <span style={{ color: log.status === "SUCCESS" ? "#34d399" : "#f87171", fontWeight: 700 }}>
                        {log.status} ({log.statusCode})
                      </span>
                      <span style={{ color: "var(--text-muted)", marginLeft: "8px" }}>
                        {new Date(log.executedAt).toLocaleString()}
                      </span>
                    </div>
                    <span style={{ fontFamily: "var(--font-mono)", color: "var(--brand-accent)" }}>
                      {log.durationMs}ms
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Create Cron Modal */}
      {showCreateModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.75)",
            backdropFilter: "blur(6px)",
            display: "grid",
            placeItems: "center",
            zIndex: 1000,
            padding: "20px",
          }}
        >
          <div className="card fade-in" style={{ width: "100%", maxWidth: "500px", padding: "28px" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "16px",
              }}
            >
              <h3 style={{ fontSize: "1.15rem", fontWeight: 700 }}>Schedule New Cron Task</h3>
              <button
                onClick={() => setShowCreateModal(false)}
                className="btn btn-ghost btn-sm"
              >
                ✕
              </button>
            </div>

            {createError && (
              <div
                style={{
                  padding: "10px",
                  borderRadius: "var(--radius-sm)",
                  background: "rgba(239,68,68,0.15)",
                  color: "#f87171",
                  fontSize: "0.8rem",
                  marginBottom: "12px",
                }}
              >
                {createError}
              </div>
            )}

            <form onSubmit={handleCreate} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              <div>
                <label style={{ fontSize: "0.8rem", color: "var(--text-secondary)", display: "block", marginBottom: "4px" }}>
                  Task Name
                </label>
                <input
                  type="text"
                  value={newCronName}
                  onChange={(e) => setNewCronName(e.target.value)}
                  placeholder="e.g. Nightly Database Snapshot"
                  className="input"
                  style={{ width: "100%" }}
                  required
                />
              </div>

              <div>
                <label style={{ fontSize: "0.8rem", color: "var(--text-secondary)", display: "block", marginBottom: "4px" }}>
                  Schedule (Standard 5-field Cron)
                </label>
                <input
                  type="text"
                  value={newCronSchedule}
                  onChange={(e) => setNewCronSchedule(e.target.value)}
                  placeholder="*/15 * * * *"
                  className="input"
                  style={{ width: "100%", fontFamily: "var(--font-mono)" }}
                  required
                />
                <div style={{ display: "flex", gap: "6px", marginTop: "6px" }}>
                  {[
                    { label: "Every 5m", exp: "*/5 * * * *" },
                    { label: "Hourly", exp: "0 * * * *" },
                    { label: "Daily (2am)", exp: "0 2 * * *" },
                    { label: "Weekly", exp: "0 0 * * 0" },
                  ].map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => setNewCronSchedule(preset.exp)}
                      className="btn btn-ghost btn-sm"
                      style={{ fontSize: "0.7rem", padding: "2px 6px" }}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "10px" }}>
                <div>
                  <label style={{ fontSize: "0.8rem", color: "var(--text-secondary)", display: "block", marginBottom: "4px" }}>
                    Method
                  </label>
                  <select
                    value={newCronMethod}
                    onChange={(e: any) => setNewCronMethod(e.target.value)}
                    className="input"
                    style={{ width: "100%" }}
                  >
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                  </select>
                </div>

                <div>
                  <label style={{ fontSize: "0.8rem", color: "var(--text-secondary)", display: "block", marginBottom: "4px" }}>
                    HTTP Path
                  </label>
                  <input
                    type="text"
                    value={newCronPath}
                    onChange={(e) => setNewCronPath(e.target.value)}
                    placeholder="/api/cron/tasks"
                    className="input"
                    style={{ width: "100%" }}
                    required
                  />
                </div>
              </div>

              <button
                type="submit"
                className="btn btn-primary"
                disabled={creatingCron}
                style={{ width: "100%", justifyContent: "center", marginTop: "8px" }}
              >
                {creatingCron ? "Creating..." : "Save Scheduled Task"}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
