"use client";

import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { trpc } from "@/lib/trpc-client";
import { useState } from "react";

export default function WorkspaceSlugPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;
  const [projectSearch, setProjectSearch] = useState("");

  const {
    data: workspace,
    isLoading: wsLoading,
    error: wsError,
  } = trpc.workspace.bySlug.useQuery(
    { slug },
    { enabled: !!slug }
  );

  const {
    data: projects,
    isLoading: projectsLoading,
  } = trpc.project.list.useQuery(
    { workspaceId: workspace?.id! },
    { enabled: !!workspace?.id }
  );

  const {
    data: usage,
  } = trpc.metrics.workspaceUsage.useQuery(
    { workspaceId: workspace?.id! },
    { enabled: !!workspace?.id }
  );

  const {
    data: auditLogs,
  } = trpc.workspace.auditLog.useQuery(
    { workspaceId: workspace?.id!, limit: 10 },
    { enabled: !!workspace?.id, retry: false }
  );

  if (wsLoading) {
    return (
      <div style={{ textAlign: "center", padding: "64px" }}>
        <div className="loading-bar" style={{ width: "200px", margin: "0 auto 16px" }} />
        <p style={{ color: "var(--text-muted)" }}>Loading workspace {slug}...</p>
      </div>
    );
  }

  if (wsError || !workspace) {
    return (
      <div className="empty-state card">
        <div className="empty-icon">⚠️</div>
        <h3>Workspace not found</h3>
        <p>The workspace &quot;{slug}&quot; does not exist or you do not have permission to access it.</p>
        <Link href="/dashboard" className="btn btn-secondary" style={{ marginTop: "16px" }}>
          Back to Overview
        </Link>
      </div>
    );
  }

  // Aggregate active services across all projects in this workspace
  let activeServicesCount = 0;
  let totalServicesCount = 0;
  if (projects) {
    for (const p of projects) {
      for (const env of p.environments || []) {
        for (const svc of env.services || []) {
          totalServicesCount++;
          const latestDeploy = svc.deployments?.[0];
          if (latestDeploy?.status === "ACTIVE") {
            activeServicesCount++;
          }
        }
      }
    }
  }

  // Calculate spending cap metrics
  const costDollars = (usage?.estimatedCostCents ?? 0) / 100;
  const capDollars = workspace.spendingCapCents ? workspace.spendingCapCents / 100 : null;
  const spendPercent = capDollars && capDollars > 0 ? Math.min(100, (costDollars / capDollars) * 100) : 0;
  const isNearCap = capDollars ? spendPercent >= 80 : false;

  const filteredProjects = projects?.filter((p) =>
    p.name.toLowerCase().includes(projectSearch.toLowerCase()) ||
    (p.description && p.description.toLowerCase().includes(projectSearch.toLowerCase()))
  );

  return (
    <div className="fade-in">
      {/* ── Page Header ── */}
      <div className="page-header">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
            <span style={{ fontSize: "28px" }}>{workspace.isPersonal ? "👤" : "🏢"}</span>
            <h1 className="page-title">{workspace.name}</h1>
            <span className="badge badge-queued" style={{ textTransform: "capitalize", fontSize: "0.75rem" }}>
              {workspace.isPersonal ? "Personal Account" : "Team Workspace"}
            </span>
          </div>
          <p className="page-subtitle">
            Slug: <code style={{ color: "var(--brand-accent)" }}>{workspace.slug}</code> · Created on{" "}
            {new Date(workspace.createdAt).toLocaleDateString()}
          </p>
        </div>

        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
          <Link href={`/dashboard/members`} className="btn btn-secondary btn-sm">
            👥 Members ({workspace.members?.length || 1})
          </Link>
          <Link href={`/dashboard/settings`} className="btn btn-secondary btn-sm">
            ⚙️ Workspace Settings
          </Link>
          <Link href={`/dashboard/projects/new`} className="btn btn-primary btn-sm">
            ＋ New Project
          </Link>
        </div>
      </div>

      {/* ── Stat Cards ── */}
      <div className="grid-4" style={{ marginBottom: "28px" }}>
        <div className="stat-card">
          <div className="stat-label">Projects</div>
          <div className="stat-value">{workspace._count?.projects ?? projects?.length ?? 0}</div>
          <div className="stat-change">applications deployed</div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Active Services</div>
          <div className="stat-value" style={{ color: "var(--status-active)" }}>
            {activeServicesCount}
          </div>
          <div className="stat-change">{totalServicesCount} total configured</div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Team Roster</div>
          <div className="stat-value">{workspace.members?.length || 1}</div>
          <div className="stat-change">active members</div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Current Spend</div>
          <div className="stat-value" style={{ color: isNearCap ? "var(--status-failed)" : "var(--text-primary)" }}>
            ${costDollars.toFixed(2)}
          </div>
          <div className="stat-change">
            {capDollars ? `Cap: $${capDollars.toFixed(2)} (${spendPercent.toFixed(0)}%)` : "No limit set"}
          </div>
        </div>
      </div>

      {/* ── Spending Cap Gauge ── */}
      <div
        className="card"
        style={{
          marginBottom: "32px",
          background: isNearCap ? "rgba(239, 68, 68, 0.06)" : "var(--bg-card)",
          borderColor: isNearCap ? "rgba(239, 68, 68, 0.3)" : "var(--border-subtle)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
          <div>
            <h3 style={{ fontSize: "1.05rem", fontWeight: 700 }}>Monthly Spending Cap Gauge</h3>
            <p style={{ fontSize: "0.8125rem", color: "var(--text-muted)", marginTop: "2px" }}>
              Enforces hard limits to prevent unexpected cloud infrastructure bills.
            </p>
          </div>
          <Link href="/dashboard/settings" className="btn btn-secondary btn-sm">
            Adjust Cap
          </Link>
        </div>

        {capDollars ? (
          <div>
            <div
              style={{
                width: "100%",
                height: "12px",
                background: "var(--bg-overlay)",
                borderRadius: "999px",
                overflow: "hidden",
                border: "1px solid var(--border-subtle)",
                marginBottom: "8px",
              }}
            >
              <div
                style={{
                  width: `${spendPercent}%`,
                  height: "100%",
                  background: isNearCap
                    ? "linear-gradient(90deg, #f59e0b, #ef4444)"
                    : "linear-gradient(90deg, var(--brand-primary), var(--brand-secondary))",
                  borderRadius: "999px",
                  transition: "width 0.4s ease",
                }}
              />
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8125rem" }}>
              <span style={{ color: isNearCap ? "#f87171" : "var(--text-secondary)" }}>
                <strong>${costDollars.toFixed(2)}</strong> consumed
              </span>
              <span style={{ color: "var(--text-muted)" }}>
                Cap limit: <strong>${capDollars.toFixed(2)}</strong> ({spendPercent.toFixed(1)}%)
              </span>
            </div>

            {isNearCap && (
              <div
                style={{
                  marginTop: "12px",
                  padding: "10px 14px",
                  borderRadius: "var(--radius-md)",
                  background: "rgba(239,68,68,0.15)",
                  border: "1px solid rgba(239,68,68,0.3)",
                  color: "#fca5a5",
                  fontSize: "0.8125rem",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                <span>⚠️</span>
                <span>
                  <strong>Warning:</strong> This workspace has reached <strong>{spendPercent.toFixed(1)}%</strong> of its
                  spending cap limit. Services will automatically scale to zero when the 100% threshold is reached.
                </span>
              </div>
            )}
          </div>
        ) : (
          <div style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>
            <span>No spending cap configured for this workspace. Estimated spend this cycle is </span>
            <strong style={{ color: "var(--text-primary)" }}>${costDollars.toFixed(2)}</strong>.
            <span style={{ display: "block", marginTop: "4px", color: "var(--text-muted)", fontSize: "0.8125rem" }}>
              Configure a monthly spending limit in Settings to guard against compute and egress spikes.
            </span>
          </div>
        )}
      </div>

      {/* ── Project Listings ── */}
      <div style={{ marginBottom: "36px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "12px" }}>
          <div>
            <h2>Projects</h2>
            <p style={{ fontSize: "0.875rem" }}>Applications and services running in {workspace.name}.</p>
          </div>

          <div style={{ display: "flex", gap: "12px" }}>
            <input
              type="text"
              className="input"
              placeholder="Search projects..."
              value={projectSearch}
              onChange={(e) => setProjectSearch(e.target.value)}
              style={{ width: "220px", padding: "8px 12px" }}
            />
            <Link href="/dashboard/projects/new" className="btn btn-primary btn-sm">
              ＋ Add Project
            </Link>
          </div>
        </div>

        {projectsLoading ? (
          <div style={{ textAlign: "center", padding: "48px" }}>
            <div className="loading-bar" style={{ width: "160px", margin: "0 auto 12px" }} />
            <p style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>Loading projects...</p>
          </div>
        ) : filteredProjects?.length === 0 ? (
          <div className="empty-state card">
            <div className="empty-icon">📦</div>
            <h3>No projects found</h3>
            <p>
              {projectSearch
                ? `No projects matching "${projectSearch}"`
                : "Get started by deploying your first project to this workspace."}
            </p>
            <Link href="/dashboard/projects/new" className="btn btn-primary" style={{ marginTop: "16px" }}>
              Deploy from GitHub
            </Link>
          </div>
        ) : (
          <div className="grid-3">
            {filteredProjects?.map((project) => {
              // Gather latest deployment across all services
              let latestDeployment: any = null;
              let serviceCount = 0;
              for (const env of project.environments || []) {
                for (const svc of env.services || []) {
                  serviceCount++;
                  const dep = svc.deployments?.[0];
                  if (dep && (!latestDeployment || new Date(dep.createdAt) > new Date(latestDeployment.createdAt))) {
                    latestDeployment = dep;
                  }
                }
              }

              const status = latestDeployment?.status || "SLEEPING";
              const badgeClass =
                status === "ACTIVE"
                  ? "badge-active"
                  : status === "BUILDING" || status === "DEPLOYING"
                  ? "badge-building"
                  : status === "FAILED" || status === "CRASHED"
                  ? "badge-failed"
                  : status === "QUEUED"
                  ? "badge-queued"
                  : "badge-sleeping";

              const dotClass =
                status === "ACTIVE"
                  ? "status-dot-active"
                  : status === "BUILDING" || status === "DEPLOYING"
                  ? "status-dot-building"
                  : status === "FAILED" || status === "CRASHED"
                  ? "status-dot-failed"
                  : status === "QUEUED"
                  ? "status-dot-queued"
                  : "status-dot-sleeping";

              return (
                <Link
                  href={`/dashboard/projects/${project.id}`}
                  key={project.id}
                  className="card"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    textDecoration: "none",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "14px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                      <div
                        style={{
                          width: "36px",
                          height: "36px",
                          background: "var(--bg-overlay)",
                          borderRadius: "var(--radius-sm)",
                          border: "1px solid var(--border-subtle)",
                          display: "grid",
                          placeItems: "center",
                          fontSize: "18px",
                          flexShrink: 0,
                        }}
                      >
                        📦
                      </div>
                      <div>
                        <div style={{ fontWeight: 700, color: "var(--text-primary)", fontSize: "1rem" }}>
                          {project.name}
                        </div>
                        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "2px" }}>
                          {project.environments?.length || 1} env · {serviceCount} service{serviceCount !== 1 ? "s" : ""}
                        </div>
                      </div>
                    </div>

                    <span className={`badge ${badgeClass}`} style={{ fontSize: "0.6875rem" }}>
                      <span className={`status-dot ${dotClass}`} />
                      {status}
                    </span>
                  </div>

                  {project.description && (
                    <p style={{ fontSize: "0.8125rem", color: "var(--text-secondary)", marginBottom: "14px", lineClamp: 2 }}>
                      {project.description}
                    </p>
                  )}

                  <div
                    style={{
                      marginTop: "auto",
                      paddingTop: "12px",
                      borderTop: "1px solid var(--border-subtle)",
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: "0.75rem",
                      color: "var(--text-muted)",
                    }}
                  >
                    <span>Updated {new Date(project.updatedAt).toLocaleDateString()}</span>
                    <span style={{ color: "var(--brand-primary)" }}>Open console →</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Two-Column Bottom Grid: Team Members & Audit Log Stream ── */}
      <div className="grid-2" style={{ gap: "24px" }}>
        {/* Team Members Card */}
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <h3>Team Members</h3>
            <Link href="/dashboard/members" className="btn btn-secondary btn-sm">
              Manage Team
            </Link>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {workspace.members?.map((member) => {
              const roleClass =
                member.role === "OWNER"
                  ? "badge-sleeping"
                  : member.role === "ADMIN"
                  ? "badge-deploying"
                  : member.role === "MEMBER"
                  ? "badge-active"
                  : "badge-queued";

              return (
                <div
                  key={member.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "10px 12px",
                    background: "var(--bg-overlay)",
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--border-subtle)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <div
                      style={{
                        width: "30px",
                        height: "30px",
                        borderRadius: "50%",
                        background: "linear-gradient(135deg, var(--brand-primary), var(--brand-secondary))",
                        display: "grid",
                        placeItems: "center",
                        fontSize: "12px",
                        fontWeight: 700,
                        color: "#fff",
                      }}
                    >
                      {member.user?.name?.slice(0, 1).toUpperCase() || member.user?.email?.slice(0, 1).toUpperCase() || "U"}
                    </div>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: "0.875rem", color: "var(--text-primary)" }}>
                        {member.user?.name || "Member"}
                      </div>
                      <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                        {member.user?.email}
                      </div>
                    </div>
                  </div>

                  <span className={`badge ${roleClass}`} style={{ fontSize: "0.6875rem" }}>
                    {member.role}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Audit Log Stream Preview Card */}
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <h3>Recent Activity</h3>
            <Link href="/dashboard/audit" className="btn btn-secondary btn-sm">
              View Audit Log
            </Link>
          </div>

          {auditLogs && auditLogs.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {auditLogs.slice(0, 5).map((log) => (
                <div
                  key={log.id}
                  style={{
                    padding: "10px 12px",
                    background: "var(--bg-overlay)",
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--border-subtle)",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span className="badge badge-queued" style={{ fontSize: "0.6875rem" }}>
                        {log.action}
                      </span>
                      <span style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>
                        by {log.actor?.email?.split("@")[0] || "system"}
                      </span>
                    </div>
                  </div>
                  <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                    {new Date(log.createdAt).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state" style={{ padding: "32px 16px" }}>
              <p style={{ fontSize: "0.875rem", color: "var(--text-muted)" }}>
                No recent activity recorded yet.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
