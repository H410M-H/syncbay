"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useState } from "react";
import { trpc } from "@/lib/trpc-client";

const statusClass = (status: string) =>
  status === "ACTIVE" ? "badge-active" :
  status === "BUILDING" || status === "DEPLOYING" ? "badge-building" :
  status === "FAILED" || status === "CRASHED" ? "badge-failed" :
  status === "QUEUED" ? "badge-queued" : "badge-sleeping";

export default function DeploymentDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const deploymentId = params.id as string;
  const [menuOpen, setMenuOpen] = useState(false);
  const deploymentQuery = trpc.deployment.byId.useQuery({ deploymentId });
  const logsQuery = trpc.deployment.logs.useQuery({ deploymentId });
  const redeployMutation = trpc.deployment.redeploy.useMutation();
  const rollbackMutation = trpc.deployment.instantRollback.useMutation();
  const cancelMutation = trpc.deployment.cancel.useMutation();
  const [notice, setNotice] = useState<string | null>(null);

  const runAction = async (action: () => Promise<unknown>, message: string) => {
    try {
      await action();
      setNotice(message);
      setMenuOpen(false);
      await deploymentQuery.refetch();
    } catch (error: any) {
      setNotice(error?.message || "Action failed");
    }
  };

  if (deploymentQuery.isLoading) return <main className="dashboard-page"><div className="card">Loading deployment…</div></main>;
  if (deploymentQuery.error || !deploymentQuery.data) return <main className="dashboard-page"><div className="card"><h2>Deployment not found</h2><Link href="/dashboard" className="btn btn-secondary">Back to dashboard</Link></div></main>;

  const deployment = deploymentQuery.data;
  const logs = logsQuery.data || [];
  const showLogs = searchParams.get("view") === "logs";
  const isRunning = ["QUEUED", "BUILDING", "DEPLOYING"].includes(deployment.status);

  return (
    <main className="dashboard-page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "16px", flexWrap: "wrap", marginBottom: "20px" }}>
        <div>
          <Link href="/dashboard" style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>Dashboard</Link>
          <h1 style={{ margin: "8px 0 4px" }}>Deployment {deployment.id.slice(0, 8)}</h1>
          <p style={{ margin: 0, color: "var(--text-secondary)" }}>{deployment.service.name} · {deployment.service.environment.name}</p>
        </div>
        <div style={{ position: "relative" }}>
          <button type="button" className="btn btn-primary" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>Deployment actions</button>
          {menuOpen && (
            <div role="menu" style={{ position: "absolute", right: 0, top: "calc(100% + 8px)", zIndex: 10, minWidth: "210px", padding: "6px", border: "1px solid var(--border-subtle)", borderRadius: "10px", background: "var(--bg-elevated)", boxShadow: "var(--shadow-lg)" }}>
              <Link href={`/dashboard/deployments/${deployment.id}?view=logs`} role="menuitem" className="btn btn-ghost btn-sm" style={{ display: "block", width: "100%", textAlign: "left" }} onClick={() => setMenuOpen(false)}>View logs</Link>
              {isRunning ? (
                <button type="button" role="menuitem" className="btn btn-ghost btn-sm" style={{ display: "block", width: "100%", textAlign: "left" }} onClick={() => runAction(() => cancelMutation.mutateAsync({ deploymentId }), "Deployment cancelled")}>Cancel deployment</button>
              ) : (
                <>
                  <button type="button" role="menuitem" className="btn btn-ghost btn-sm" style={{ display: "block", width: "100%", textAlign: "left" }} onClick={() => runAction(() => redeployMutation.mutateAsync({ deploymentId, rebuild: false }), "Redeploy started")}>Redeploy</button>
                  <button type="button" role="menuitem" className="btn btn-ghost btn-sm" style={{ display: "block", width: "100%", textAlign: "left" }} onClick={() => runAction(() => redeployMutation.mutateAsync({ deploymentId, rebuild: true }), "Clean rebuild started")}>Clean rebuild</button>
                  <button type="button" role="menuitem" className="btn btn-ghost btn-sm" style={{ display: "block", width: "100%", textAlign: "left" }} onClick={() => runAction(() => rollbackMutation.mutateAsync({ deploymentId }), "Traffic rolled back")}>Roll back to this</button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {notice && <div className="card" role="status" style={{ marginBottom: "16px" }}>{notice}</div>}
      <section className="card" style={{ marginBottom: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "18px" }}>
          <span className={`badge ${statusClass(deployment.status)}`}>{deployment.status}</span>
          <span className="badge badge-queued">{deployment.service.environment.name}</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "16px" }}>
          <div><small>Commit</small><div><code>{deployment.build?.commitSha?.slice(0, 7) || "manual"}</code></div></div>
          <div><small>Created</small><div>{new Date(deployment.createdAt).toLocaleString()}</div></div>
          <div><small>Triggered by</small><div>{deployment.triggeredBy || "Console"}</div></div>
        </div>
        <p style={{ color: "var(--text-secondary)", marginBottom: 0 }}>{deployment.build?.commitMessage || "Triggered via console"}</p>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>{showLogs ? "Deployment logs" : "Deployment overview"}</h2>
        {showLogs ? (
          <pre style={{ maxHeight: "560px", overflow: "auto", padding: "16px", borderRadius: "8px", background: "var(--bg-base)", whiteSpace: "pre-wrap" }}>{logs.length ? logs.map((log: any) => `[${new Date(log.timestamp).toLocaleTimeString()}] ${log.message}`).join("\n") : "No logs available yet."}</pre>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <p style={{ color: "var(--text-secondary)" }}>Use the deployment actions menu to redeploy, roll back traffic, cancel an active deployment, or inspect live logs.</p>
            <Link href={`/dashboard/deployments/${deployment.id}?view=logs`} className="btn btn-secondary" style={{ width: "fit-content" }}>View logs</Link>
          </div>
        )}
      </section>
    </main>
  );
}
