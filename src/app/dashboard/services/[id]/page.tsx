"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import { trpc } from "@/lib/trpc-client";
import { useDashboard } from "../../dashboard-shell";

export default function ServiceDetailsPage(props: { params: Promise<{ id: string }> }) {
  const params = use(props.params);
  const serviceId = params.id;
  const dashboard = useDashboard();
  
  const {
    data: service,
    isLoading,
    refetch,
  } = trpc.service.byId.useQuery({ serviceId }, { enabled: !!serviceId });

  const [viewLogsDeployId, setViewLogsDeployId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div style={{ textAlign: "center", padding: "64px" }}>
        <div className="loading-bar" style={{ width: "200px", margin: "0 auto 16px" }} />
        <p style={{ color: "var(--text-muted)" }}>Loading service details...</p>
      </div>
    );
  }

  if (!service) {
    return (
      <div className="empty-state card" style={{ padding: "48px 24px", textAlign: "center" }}>
        <div className="empty-icon" style={{ fontSize: "42px", marginBottom: "12px" }}>⚠️</div>
        <h3 style={{ fontSize: "1.25rem", marginBottom: "8px" }}>Service Not Found</h3>
        <p style={{ color: "var(--text-secondary)" }}>
          The requested service could not be found or you don't have access.
        </p>
        <Link href="/dashboard/services" className="btn btn-primary" style={{ marginTop: "20px" }}>
          Back to Services
        </Link>
      </div>
    );
  }

  const primaryDomain = service.domains?.[0]?.hostname || `${service.name}.syncbay.run`;

  return (
    <div className="fade-in">
      <div className="page-header" style={{ marginBottom: "24px" }}>
        <div>
          <Link href="/dashboard/services" style={{ color: "var(--text-muted)", fontSize: "0.875rem", textDecoration: "none", marginBottom: "8px", display: "inline-block" }}>
            ← Back to Services
          </Link>
          <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            {service.name}
            <span className={`badge ${service.isPaused ? "badge-queued" : "badge-active"}`} style={{ fontSize: "0.75rem", verticalAlign: "middle" }}>
              {service.isPaused ? "SLEEPING" : "ACTIVE"}
            </span>
          </h1>
          <p className="page-subtitle">
            Project: {service.environment?.project?.name} | Source: {service.sourceType}
          </p>
        </div>
      </div>

      <div style={{ display: "grid", gap: "24px", gridTemplateColumns: "1fr" }}>
        {/* Overview Card */}
        <div className="card" style={{ padding: "24px" }}>
          <h2 style={{ fontSize: "1.25rem", marginBottom: "16px", borderBottom: "1px solid var(--border-subtle)", paddingBottom: "12px" }}>Overview</h2>
          
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "20px", marginBottom: "20px" }}>
            <div>
              <div style={{ color: "var(--text-muted)", fontSize: "0.875rem", marginBottom: "4px" }}>Edge Endpoint</div>
              <div>
                <a href={`https://${primaryDomain}`} target="_blank" rel="noreferrer" style={{ color: "var(--brand-accent)", textDecoration: "underline" }}>
                  https://{primaryDomain}
                </a>
              </div>
            </div>
            
            <div>
              <div style={{ color: "var(--text-muted)", fontSize: "0.875rem", marginBottom: "4px" }}>Port</div>
              <div>{service.port || "Dynamic"}</div>
            </div>

            <div>
              <div style={{ color: "var(--text-muted)", fontSize: "0.875rem", marginBottom: "4px" }}>Instance Type</div>
              <div>{service.instanceType} ({service.scaleToZero ? "0ms Cold-Start" : "Always-On"})</div>
            </div>

            <div>
              <div style={{ color: "var(--text-muted)", fontSize: "0.875rem", marginBottom: "4px" }}>Repository</div>
              <div>{service.repoUrl || "N/A"} ({service.branch || "N/A"})</div>
            </div>
          </div>
        </div>

        {/* Deployments & Builds Card */}
        <div className="card" style={{ padding: "24px" }}>
          <h2 style={{ fontSize: "1.25rem", marginBottom: "16px", borderBottom: "1px solid var(--border-subtle)", paddingBottom: "12px" }}>Recent Deployments</h2>
          
          {!service.deployments || service.deployments.length === 0 ? (
            <p style={{ color: "var(--text-muted)", fontStyle: "italic" }}>No deployments yet.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {service.deployments.map((dep: any) => (
                <div key={dep.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px", background: "var(--bg-overlay)", borderRadius: "var(--radius-md)", border: "1px solid var(--border-subtle)" }}>
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: "4px" }}>
                      Deploy #{dep.id.slice(0, 8)} 
                      <span className={`badge ${dep.status === "ACTIVE" || dep.status === "SUCCESS" ? "badge-active" : dep.status === "FAILED" ? "badge-danger" : "badge-queued"}`} style={{ marginLeft: "8px", fontSize: "0.65rem" }}>
                        {dep.status}
                      </span>
                    </div>
                    <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                      {new Date(dep.createdAt).toLocaleString()} 
                      {dep.errorMessage && (
                        <div style={{ color: "#ff7b72", marginTop: "4px" }}>Error: {dep.errorMessage}</div>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => setViewLogsDeployId(dep.id)}
                    className="btn btn-ghost btn-sm"
                  >
                    View Logs
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Builds (if applicable) */}
        {service.builds && service.builds.length > 0 && (
          <div className="card" style={{ padding: "24px" }}>
            <h2 style={{ fontSize: "1.25rem", marginBottom: "16px", borderBottom: "1px solid var(--border-subtle)", paddingBottom: "12px" }}>Recent Builds</h2>
            
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {service.builds.map((bld: any) => (
                <div key={bld.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px", background: "var(--bg-overlay)", borderRadius: "var(--radius-md)", border: "1px solid var(--border-subtle)" }}>
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: "4px" }}>
                      Build #{bld.id.slice(0, 8)} 
                      <span className={`badge ${bld.status === "ACTIVE" || bld.status === "SUCCEEDED" ? "badge-active" : bld.status === "FAILED" ? "badge-danger" : "badge-queued"}`} style={{ marginLeft: "8px", fontSize: "0.65rem" }}>
                        {bld.status}
                      </span>
                    </div>
                    <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                      {new Date(bld.createdAt).toLocaleString()} 
                      {bld.errorMessage && (
                        <div style={{ color: "#ff7b72", marginTop: "4px" }}>Error: {bld.errorMessage}</div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

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
