"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import { trpc } from "@/lib/trpc-client";
import { useDashboard } from "../../dashboard-shell";
import { BackButton } from "@/components/ui/back-button";

export default function ServiceDetailsPage(props: { params: Promise<{ id: string }> }) {
  const params = use(props.params);
  const serviceId = params.id;
  const dashboard = useDashboard();
  
  const {
    data: service,
    isLoading,
    refetch,
  } = trpc.service.byId.useQuery({ serviceId }, { enabled: !!serviceId });

  const redeployMutation = trpc.deployment.redeploy.useMutation();
  const [viewLogsDeployId, setViewLogsDeployId] = useState<string | null>(null);

  const { data: domainsList, refetch: refetchDomains } = trpc.domain.list.useQuery(
    { serviceId },
    { enabled: !!serviceId }
  );
  const createDomainMutation = trpc.domain.create.useMutation();
  const verifyDomainMutation = trpc.domain.verify.useMutation();
  const deleteDomainMutation = trpc.domain.delete.useMutation();

  const [newHostname, setNewHostname] = useState("");
  const [addingDomain, setAddingDomain] = useState(false);
  const [selectedDomainInstructions, setSelectedDomainInstructions] = useState<string | null>(null);
  const [verifyingDomainId, setVerifyingDomainId] = useState<string | null>(null);

  const handleAddDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newHostname.trim()) return;
    try {
      setAddingDomain(true);
      await createDomainMutation.mutateAsync({ serviceId, hostname: newHostname.trim() });
      setNewHostname("");
      refetchDomains();
      refetch();
    } catch (err: any) {
      alert(`Failed to add custom domain: ${err.message}`);
    } finally {
      setAddingDomain(false);
    }
  };

  const handleVerifyDomain = async (domainId: string) => {
    try {
      setVerifyingDomainId(domainId);
      const res = await verifyDomainMutation.mutateAsync({ domainId });
      refetchDomains();
      if (res.status === "ACTIVE") {
        alert("Domain verified successfully! SSL certificate is active.");
      } else {
        alert(`Domain status: ${res.status}. Please check your DNS records and try again in a few moments.`);
      }
    } catch (err: any) {
      alert(`Verification failed: ${err.message}`);
    } finally {
      setVerifyingDomainId(null);
    }
  };

  const handleDeleteDomain = async (domainId: string, hostname: string) => {
    if (!confirm(`Are you sure you want to remove ${hostname}?`)) return;
    try {
      await deleteDomainMutation.mutateAsync({ domainId });
      refetchDomains();
      refetch();
    } catch (err: any) {
      alert(`Failed to remove domain: ${err.message}`);
    }
  };

  const handleRedeploy = async (deploymentId: string, rebuild: boolean = false) => {
    try {
      await redeployMutation.mutateAsync({ deploymentId, rebuild });
      refetch();
      setViewLogsDeployId(deploymentId);
    } catch (e: any) {
      alert(`Redeploy failed: ${e.message}`);
    }
  };

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
          <BackButton fallbackUrl="/dashboard/services" label="Back to Services" />
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

        {/* Custom Domains & Ingress Card */}
        <div className="card" style={{ padding: "24px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", borderBottom: "1px solid var(--border-subtle)", paddingBottom: "12px", flexWrap: "wrap", gap: "10px" }}>
            <div>
              <h2 style={{ fontSize: "1.25rem", margin: 0 }}>Domains & Edge Ingress</h2>
              <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", margin: "4px 0 0 0" }}>
                Traffic multiplexed through Cloudflare Tunnels & Global Edge Ingress with auto-managed SSL/TLS.
              </p>
            </div>
          </div>

          {/* Add Custom Domain Form */}
          <form onSubmit={handleAddDomain} style={{ display: "flex", gap: "10px", marginBottom: "20px", flexWrap: "wrap" }}>
            <input
              type="text"
              placeholder="e.g. api.yourcompany.com"
              value={newHostname}
              onChange={(e) => setNewHostname(e.target.value)}
              className="input"
              style={{ flex: 1, minWidth: "220px" }}
              disabled={addingDomain}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={addingDomain || !newHostname.trim()}
            >
              {addingDomain ? "Adding Domain..." : "+ Add Custom Domain"}
            </button>
          </form>

          {/* Domain List */}
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {/* Generated Subdomain */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", background: "var(--bg-overlay)", borderRadius: "var(--radius-md)", border: "1px solid var(--border-subtle)", flexWrap: "wrap", gap: "12px" }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <a href={`https://${primaryDomain}`} target="_blank" rel="noreferrer" style={{ fontWeight: 600, color: "var(--brand-accent)", textDecoration: "underline" }}>
                    https://{primaryDomain}
                  </a>
                  <span className="badge badge-active" style={{ fontSize: "0.65rem" }}>
                    ACTIVE · Wildcard SSL (TLSv1.3)
                  </span>
                </div>
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "4px" }}>
                  Default platform edge route · Instant live ingress
                </div>
              </div>
            </div>

            {/* Custom Domains */}
            {domainsList && domainsList.filter((d: any) => !d.isGenerated).map((dom: any) => {
              const isSelected = selectedDomainInstructions === dom.id;
              const isVerifying = verifyingDomainId === dom.id;
              return (
                <div key={dom.id} style={{ display: "flex", flexDirection: "column", padding: "14px 16px", background: "var(--bg-overlay)", borderRadius: "var(--radius-md)", border: "1px solid var(--border-subtle)", gap: "12px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span style={{ fontWeight: 600, fontSize: "0.95rem" }}>{dom.hostname}</span>
                        <span className={`badge ${dom.status === "ACTIVE" ? "badge-active" : dom.status === "FAILED" ? "badge-danger" : "badge-queued"}`} style={{ fontSize: "0.65rem" }}>
                          {dom.status === "ACTIVE" ? "ACTIVE · Cloudflare Managed SSL" : dom.status === "FAILED" ? "FAILED" : "PENDING DNS VERIFICATION"}
                        </span>
                      </div>
                      <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "4px" }}>
                        {dom.status === "ACTIVE" ? `Verified ${dom.verifiedAt ? new Date(dom.verifiedAt).toLocaleDateString() : "Active"}` : "Requires DNS configuration"}
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                      <button
                        type="button"
                        onClick={() => setSelectedDomainInstructions(isSelected ? null : dom.id)}
                        className="btn btn-ghost btn-sm"
                      >
                        {isSelected ? "Hide DNS Checklist" : "DNS Checklist"}
                      </button>

                      {dom.status !== "ACTIVE" && (
                        <button
                          type="button"
                          onClick={() => handleVerifyDomain(dom.id)}
                          className="btn btn-secondary btn-sm"
                          disabled={isVerifying}
                        >
                          {isVerifying ? "Verifying..." : "⚡ Verify DNS & SSL"}
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => handleDeleteDomain(dom.id, dom.hostname)}
                        className="btn btn-ghost btn-sm"
                        style={{ color: "#f87171" }}
                      >
                        ✕ Remove
                      </button>
                    </div>
                  </div>

                  {/* Verification DNS Checklist */}
                  {isSelected && dom.verificationRecords && (
                    <div style={{ marginTop: "8px", padding: "12px 14px", background: "#09090b", borderRadius: "8px", border: "1px solid var(--border-subtle)" }}>
                      <div style={{ fontWeight: 600, fontSize: "0.825rem", color: "var(--text-secondary)", marginBottom: "8px" }}>
                        DNS Configuration Instructions:
                      </div>
                      <div style={{ display: "grid", gap: "8px", fontSize: "0.8rem", fontFamily: "monospace" }}>
                        <div style={{ padding: "8px", background: "#18181b", borderRadius: "6px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "6px" }}>
                          <div>
                            <span style={{ color: "#38bdf8", fontWeight: 600 }}>CNAME</span> {dom.hostname} → <span style={{ color: "#22c55e" }}>{dom.verificationRecords.cnameTarget}</span>
                          </div>
                          <span style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>Traffic Routing</span>
                        </div>
                        <div style={{ padding: "8px", background: "#18181b", borderRadius: "6px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "6px" }}>
                          <div>
                            <span style={{ color: "#fbbf24", fontWeight: 600 }}>TXT</span> {dom.verificationRecords.txtHost} → <span style={{ color: "#22c55e" }}>{dom.verificationRecords.txtRecord}</span>
                          </div>
                          <span style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>SSL & Ownership Verification</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
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
                  <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                    <button
                      onClick={() => setViewLogsDeployId(dep.id)}
                      className="btn btn-ghost btn-sm"
                    >
                      View Logs
                    </button>
                    <button
                      onClick={() => handleRedeploy(dep.id, false)}
                      className="btn btn-ghost btn-sm"
                      title="Fast Redeploy with cached build"
                    >
                      ↺ Redeploy
                    </button>
                    <button
                      onClick={() => handleRedeploy(dep.id, true)}
                      className="btn btn-secondary btn-sm"
                      title="Clean Rebuild from source"
                    >
                      ⚡ Rebuild
                    </button>
                  </div>
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
        <LogsModal
          deployId={viewLogsDeployId}
          onClose={() => setViewLogsDeployId(null)}
          onRedeploy={handleRedeploy}
        />
      )}
    </div>
  );
}

function LogsModal({
  deployId,
  onClose,
  onRedeploy,
}: {
  deployId: string;
  onClose: () => void;
  onRedeploy?: (deploymentId: string, rebuild: boolean) => void;
}) {
  const [logs, setLogs] = useState<any[]>([]);
  const [filterStream, setFilterStream] = useState<"all" | "stderr" | "system" | "stdout">("all");
  const [searchFilter, setSearchFilter] = useState("");
  const { data: initialLogs } = trpc.deployment.logs.useQuery({ deploymentId: deployId });
  const { data: deployment } = trpc.deployment.byId.useQuery({ deploymentId: deployId });

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

  const buildError =
    deployment?.errorMessage ||
    logs.find((l) => l.message.includes("[build:error]") || l.message.includes("[error] Deployment failed"))?.message?.replace(/^\[.*?\]\s*/, "");

  const filteredLogs = logs.filter((l) => {
    if (filterStream !== "all" && l.stream !== filterStream) return false;
    if (searchFilter.trim() && !l.message.toLowerCase().includes(searchFilter.toLowerCase())) return false;
    return true;
  });

  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
      background: "rgba(0,0,0,0.7)", zIndex: 1000,
      display: "flex", justifyContent: "center", alignItems: "center",
      padding: "20px"
    }}>
      <div className="card" style={{
        width: "100%", maxWidth: "960px", height: "85vh",
        display: "flex", flexDirection: "column",
        background: "var(--bg-card)",
        border: "1px solid var(--border-subtle)",
        overflow: "hidden"
      }}>
        {/* Modal Header */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border-subtle)", display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--bg-elevated)", flexWrap: "wrap", gap: "10px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <h3 style={{ margin: 0, fontSize: "1.1rem" }}>Deployment Logs ({deployId.slice(0, 8)})</h3>
            {deployment && (
              <span className={`badge ${deployment.status === "ACTIVE" ? "badge-active" : deployment.status === "FAILED" ? "badge-failed" : "badge-building"}`} style={{ fontSize: "0.7rem" }}>
                {deployment.status}
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            {onRedeploy && (
              <>
                <button className="btn btn-ghost btn-sm" onClick={() => onRedeploy(deployId, false)} title="Fast Redeploy">
                  ↺ Fast Redeploy
                </button>
                <button className="btn btn-primary btn-sm" onClick={() => onRedeploy(deployId, true)} title="Clean Rebuild">
                  ⚡ Clean Rebuild
                </button>
              </>
            )}
            <button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
          </div>
        </div>

        {/* Build Error Banner */}
        {buildError && (
          <div style={{ padding: "12px 20px", background: "rgba(239, 68, 68, 0.1)", borderBottom: "1px solid rgba(239, 68, 68, 0.3)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "#f87171", fontWeight: 600, fontSize: "0.875rem", marginBottom: "6px" }}>
              <span>⚠️ Build / Deployment Error</span>
            </div>
            <pre style={{
              background: "#08080c",
              color: "#f87171",
              padding: "8px 12px",
              borderRadius: "4px",
              fontFamily: "monospace",
              fontSize: "0.8rem",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              margin: 0,
              maxHeight: "120px",
              overflowY: "auto"
            }}>
              {buildError}
            </pre>
          </div>
        )}

        {/* Filters Toolbar */}
        <div style={{ padding: "10px 20px", borderBottom: "1px solid var(--border-subtle)", background: "var(--bg-elevated)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <input
              type="text"
              placeholder="Search logs..."
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              className="input"
              style={{ width: "160px", padding: "4px 8px", fontSize: "0.75rem", height: "auto" }}
            />
            <div style={{ display: "flex", borderRadius: "4px", overflow: "hidden", border: "1px solid var(--border-subtle)" }}>
              {(["all", "stderr", "system", "stdout"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setFilterStream(s)}
                  style={{
                    padding: "3px 8px",
                    fontSize: "0.7rem",
                    border: "none",
                    background: filterStream === s ? "var(--brand-accent)" : "transparent",
                    color: filterStream === s ? "#fff" : "var(--text-muted)",
                    cursor: "pointer",
                  }}
                >
                  {s === "all" ? "All" : s === "stderr" ? "Errors" : s === "system" ? "System" : "App"}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={() => {
              const text = filteredLogs.map((l) => `[${l.timestamp}] [${l.stream}] ${l.message}`).join("\n");
              navigator.clipboard.writeText(text);
              alert("Copied logs to clipboard");
            }}
            className="btn btn-ghost btn-sm"
            style={{ fontSize: "0.75rem" }}
          >
            Copy Logs
          </button>
        </div>

        {/* Logs Terminal Area */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px", background: "#08080c", color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace", fontSize: "0.8125rem", lineHeight: 1.5 }}>
          {filteredLogs.map((log, i) => {
            const isError = log.message.includes("[build:error]") || (log.stream === "stderr" && log.message.toLowerCase().includes("error"));
            return (
              <div key={log.id || i} style={{ display: "flex", gap: "8px", marginBottom: "3px", background: isError ? "rgba(239, 68, 68, 0.08)" : undefined }}>
                <span style={{ color: "#475569", flexShrink: 0 }}>[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                <span style={{ color: isError ? "#f87171" : log.stream === "stderr" ? "#f87171" : log.stream === "system" ? "#60a5fa" : "#4ade80", width: "54px", flexShrink: 0, fontWeight: 600 }}>
                  [{isError ? "error" : log.stream}]
                </span>
                <span style={{ color: isError ? "#fca5a5" : "inherit", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                  {log.message}
                </span>
              </div>
            );
          })}
          {filteredLogs.length === 0 && <div style={{ color: "var(--text-muted)", padding: "16px 0" }}>No log lines to display.</div>}
        </div>
      </div>
    </div>
  );
}
