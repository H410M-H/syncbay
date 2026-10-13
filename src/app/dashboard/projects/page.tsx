"use client";

import { trpc } from "@/lib/trpc-client";
import Link from "next/link";
import { useState } from "react";
import { BackButton } from "@/components/ui/back-button";

export default function ProjectsPage() {
  const { data: workspaces, isLoading: wsLoading } = trpc.workspace.list.useQuery();
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(null);

  const workspaceId = activeWorkspace || workspaces?.[0]?.id;

  const { data: projects, isLoading: projectsLoading } = trpc.project.list.useQuery(
    { workspaceId: workspaceId! },
    { enabled: !!workspaceId }
  );

  return (
    <div className="fade-in">
      <div style={{ marginBottom: "16px" }}>
        <BackButton fallbackUrl="/dashboard" label="Back to Dashboard" />
      </div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Projects</h1>
          <p className="page-subtitle">Manage your applications and databases.</p>
        </div>
        <Link href="/dashboard/projects/new" className="btn btn-primary">
          ＋ New Project
        </Link>
      </div>

      <div style={{ marginBottom: "24px", display: "flex", gap: "12px", borderBottom: "1px solid var(--border-subtle)", paddingBottom: "16px" }}>
        {workspaces?.map(ws => (
          <button 
            key={ws.id}
            onClick={() => setActiveWorkspace(ws.id)}
            className={`btn ${workspaceId === ws.id ? 'btn-secondary' : 'btn-ghost'}`}
            style={workspaceId === ws.id ? { borderColor: "var(--brand-primary)" } : {}}
          >
            {ws.name}
          </button>
        ))}
      </div>

      {projectsLoading || wsLoading ? (
        <div style={{ textAlign: "center", padding: "64px" }}>
          <div className="loading-bar" style={{ width: "200px", margin: "0 auto 16px" }}></div>
          <p style={{ color: "var(--text-muted)" }}>Loading projects...</p>
        </div>
      ) : projects?.length === 0 ? (
        <div className="empty-state card">
          <div className="empty-icon">📂</div>
          <h3>No projects found</h3>
          <p>Get started by deploying a template or linking a GitHub repository.</p>
          <Link href="/dashboard/projects/new" className="btn btn-primary" style={{ marginTop: "16px" }}>
            Deploy a Project
          </Link>
        </div>
      ) : (
        <div className="grid-3">
          {projects?.map(project => (
            <Link 
              href={`/dashboard/projects/${project.id}`} 
              key={project.id} 
              className="card"
              style={{ display: "flex", flexDirection: "column", textDecoration: "none" }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "16px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <div style={{ 
                    width: "40px", height: "40px", 
                    background: "var(--bg-overlay)", 
                    borderRadius: "var(--radius-sm)", 
                    border: "1px solid var(--border-subtle)",
                    display: "grid", placeItems: "center", fontSize: "18px"
                  }}>
                    📦
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{project.name}</div>
                    <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "2px" }}>
                      {project.environments?.length || 0} envs
                    </div>
                  </div>
                </div>
              </div>
              
              <div style={{ marginTop: "auto", paddingTop: "16px", borderTop: "1px solid var(--border-subtle)", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                Updated {new Date(project.updatedAt).toLocaleDateString()}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
