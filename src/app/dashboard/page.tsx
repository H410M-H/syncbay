import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import Link from "next/link";
import { redirect } from "next/navigation";

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;

  if (!userId) redirect("/auth/signin");

  // Load workspaces for the current user
  const workspaces = await db.workspace.findMany({
    where: {
      members: { some: { userId } },
    },
    include: {
      _count: { select: { projects: true } },
      members: true,
    },
    orderBy: { createdAt: "asc" },
  });

  // Count active services across all workspaces
  const activeDeployments = await db.deployment.count({
    where: {
      status: "ACTIVE",
      service: {
        environment: {
          project: {
            workspace: {
              members: { some: { userId } },
            },
          },
        },
      },
    },
  });

  const totalProjects = workspaces.reduce(
    (sum, ws) => sum + ws._count.projects,
    0
  );

  return (
    <div className="fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">
            Good {getGreeting()}, {session?.user?.name?.split(" ")[0] ?? "there"} 👋
          </h1>
          <p className="page-subtitle">
            Here&apos;s what&apos;s running across your workspaces.
          </p>
        </div>
        <Link href="/dashboard/projects/new" className="btn btn-primary">
          ＋ New Project
        </Link>
      </div>

      {/* Stats row */}
      <div className="grid-4" style={{ marginBottom: "32px" }}>
        <div className="stat-card">
          <div className="stat-label">Workspaces</div>
          <div className="stat-value">{workspaces.length}</div>
          <div className="stat-change">personal + team</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Projects</div>
          <div className="stat-value">{totalProjects}</div>
          <div className="stat-change">across all workspaces</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Active Services</div>
          <div className="stat-value" style={{ color: "var(--status-active)" }}>
            {activeDeployments}
          </div>
          <div className="stat-change">serving traffic now</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Platform</div>
          <div className="stat-value" style={{ fontSize: "1.1rem", marginTop: "4px" }}>
            Syncbay v0.1
          </div>
          <div className="stat-change">Phase 0 — skeleton</div>
        </div>
      </div>

      {/* Command center */}
      <section className="card" aria-labelledby="command-center-title" style={{ marginBottom: "32px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px", flexWrap: "wrap", marginBottom: "16px" }}>
          <div>
            <h2 id="command-center-title" style={{ marginBottom: "4px" }}>Command center</h2>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem" }}>Jump into the modules you use to ship, operate, and scale your projects.</p>
          </div>
          <Link href="/dashboard/projects/new" className="btn btn-secondary btn-sm">Deploy from Git</Link>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "10px" }}>
          {[
            ["Projects", "Deployments, environments, and releases", "/dashboard/projects", "◫"],
            ["Services", "Restart, pause, inspect logs", "/dashboard/services", "⚡"],
            ["Databases", "Provision and manage Postgres", "/dashboard/databases", "◉"],
            ["Buckets", "Object storage and file assets", "/dashboard/buckets", "▣"],
            ["Smart Crons", "Automated scheduled jobs", "/dashboard/crons", "◷"],
            ["Usage & Billing", "Spend, limits, and plan", "/dashboard/usage", "◈"],
          ].map(([title, description, href, icon]) => (
            <Link key={href} href={href} className="btn btn-ghost" style={{ display: "flex", alignItems: "flex-start", gap: "10px", textAlign: "left", padding: "14px", border: "1px solid var(--border-subtle)", minHeight: "84px" }}>
              <span aria-hidden="true" style={{ fontSize: "1.15rem", color: "var(--brand-accent)" }}>{icon}</span>
              <span style={{ display: "flex", flexDirection: "column", gap: "4px" }}><strong>{title}</strong><small style={{ color: "var(--text-muted)", lineHeight: 1.35 }}>{description}</small></span>
            </Link>
          ))}
        </div>
      </section>

      {/* Workspaces */}
      <h2 style={{ marginBottom: "16px" }}>Your Workspaces</h2>
      {workspaces.length === 0 ? (
        <div className="empty-state card">
          <div className="empty-icon">⚓</div>
          <h3>No workspaces yet</h3>
          <p>Your personal workspace will appear here once set up.</p>
        </div>
      ) : (
        <div className="grid-2">
          {workspaces.map((ws) => (
            <Link
              key={ws.id}
              href={`/dashboard/${ws.slug}`}
              className="card"
              style={{ textDecoration: "none", cursor: "pointer", display: "block" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
                <div
                  style={{
                    width: "40px", height: "40px",
                    background: "linear-gradient(135deg, var(--brand-primary), var(--brand-secondary))",
                    borderRadius: "var(--radius-sm)",
                    display: "grid", placeItems: "center",
                    fontSize: "18px", flexShrink: 0,
                  }}
                >
                  {ws.isPersonal ? "👤" : "🏢"}
                </div>
                <div>
                  <div style={{ fontWeight: 700, color: "var(--text-primary)" }}>{ws.name}</div>
                  <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                    {ws.isPersonal ? "Personal" : "Team"} · {ws.slug}
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", gap: "16px", fontSize: "0.8125rem", color: "var(--text-secondary)" }}>
                <span>📁 {ws._count.projects} project{ws._count.projects !== 1 ? "s" : ""}</span>
                <span>👥 {ws.members.length} member{ws.members.length !== 1 ? "s" : ""}</span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Getting started card */}
      <div
        className="card"
        style={{
          marginTop: "32px",
          background: "linear-gradient(135deg, rgba(99,102,241,0.08), rgba(139,92,246,0.08))",
          borderColor: "var(--border-emphasis)",
        }}
      >
        <h3 style={{ marginBottom: "8px" }}>🚀 Getting Started</h3>
        <p style={{ marginBottom: "16px", fontSize: "0.9rem" }}>
          Connect a GitHub repository, configure your environment, and have a live
          URL in under 5 minutes.
        </p>
        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
          <Link href="/dashboard/projects/new" className="btn btn-primary btn-sm">
            Deploy from GitHub
          </Link>
          <a
            href="https://github.com"
            target="_blank"
            rel="noreferrer"
            className="btn btn-secondary btn-sm"
          >
            View Docs ↗
          </a>
        </div>
      </div>
    </div>
  );
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}
