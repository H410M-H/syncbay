"use client";

import { trpc } from "@/lib/trpc-client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { BackButton } from "@/components/ui/back-button";
import { ActionMenu } from "@/components/ui/action-menu";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ToastStack, useToasts } from "@/components/ui/toast";

type Counts = { services: number; live: number; sleeping: number; failed: number; building: number; paused: number };
type ServiceResult = { serviceName: string; status: string; reason?: string; stopFailures?: number };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function statusBadge(counts: Counts): { text: string; className: string } {
  if (counts.services === 0) return { text: "No services", className: "badge-queued" };
  const parts = [
    counts.live && `${counts.live} live`,
    counts.building && `${counts.building} building`,
    counts.sleeping && `${counts.sleeping} ${counts.paused === counts.sleeping ? "paused" : "sleeping"}`,
    counts.failed && `${counts.failed} failed`,
  ].filter(Boolean) as string[];
  const className = counts.failed
    ? "badge-failed"
    : counts.building
    ? "badge-building"
    : counts.live
    ? "badge-active"
    : counts.sleeping
    ? "badge-sleeping"
    : "badge-queued";
  return { text: parts.join(" · ") || plural(counts.services, "service") + " · not deployed", className };
}

function timeAgo(date: Date | string | null | undefined, now: number): string {
  if (!date) return "Never deployed";
  const seconds = Math.max(0, Math.round((now - new Date(date).getTime()) / 1000));
  if (seconds < 60) return "Deployed just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Deployed ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Deployed ${hours}h ago`;
  return `Deployed ${new Date(date).toLocaleDateString()}`;
}

/** One-line outcome of a bulk action, e.g. "Redeploying 2 services · 1 skipped (Service is paused)". */
function summarize(verb: string, done: number, results: ServiceResult[]): string {
  const skipped = results.filter((r) => r.status === "skipped");
  const failed = results.filter((r) => r.status === "failed");
  const stopFailures = results.reduce((n, r) => n + (r.stopFailures || 0), 0);
  const reasons = (list: ServiceResult[]) => [...new Set(list.map((r) => r.reason).filter(Boolean))].join("; ");
  return [
    `${verb} ${plural(done, "service")}`,
    skipped.length ? `${skipped.length} skipped (${reasons(skipped)})` : "",
    failed.length ? `${failed.length} failed: ${reasons(failed)}` : "",
    stopFailures ? `${plural(stopFailures, "instance")} could not be stopped` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export default function ProjectsPage() {
  const { data: workspaces, isLoading: wsLoading } = trpc.workspace.list.useQuery();
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(null);

  const workspaceId = activeWorkspace || workspaces?.[0]?.id;

  const {
    data: projects,
    isLoading: projectsLoading,
    refetch,
  } = trpc.project.list.useQuery({ workspaceId: workspaceId! }, { enabled: !!workspaceId, refetchInterval: 15_000 });
  const runner = trpc.deployment.runnerStatus.useQuery(undefined, { staleTime: 60_000 });

  const redeployAll = trpc.project.redeployAll.useMutation();
  const pauseAll = trpc.project.pauseAll.useMutation();
  const resumeAll = trpc.project.resumeAll.useMutation();
  const updateProject = trpc.project.update.useMutation();
  const deleteProject = trpc.project.delete.useMutation();

  const { toasts, push, dismiss } = useToasts();
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const runnerProblem = runner.data?.problem;

  const runBulk = async (projectId: string, action: () => Promise<{ text: string; tone: "success" | "info" }>) => {
    setBusyProjectId(projectId);
    try {
      const { text, tone } = await action();
      push(tone, text);
    } catch (e) {
      push("error", (e as Error)?.message || "Action failed");
    } finally {
      setBusyProjectId(null);
      await refetch();
    }
  };

  const onRedeploy = (projectId: string, name: string, rebuild: boolean) =>
    runBulk(projectId, async () => {
      const res = await redeployAll.mutateAsync({ projectId, rebuild });
      const verb = rebuild ? `${name}: clean rebuild started for` : `${name}: redeploying`;
      return { text: summarize(verb, res.scheduled, res.results), tone: res.scheduled ? "success" : "info" };
    });

  const onPause = (projectId: string, name: string) =>
    runBulk(projectId, async () => {
      const res = await pauseAll.mutateAsync({ projectId });
      return { text: summarize(`${name}: paused`, res.paused, res.results), tone: res.paused ? "success" : "info" };
    });

  const onResume = (projectId: string, name: string) =>
    runBulk(projectId, async () => {
      const res = await resumeAll.mutateAsync({ projectId });
      return { text: summarize(`${name}: resumed`, res.resumed, res.results), tone: res.resumed ? "success" : "info" };
    });

  const closeDialogs = () => {
    setRenameTarget(null);
    setDeleteTarget(null);
    setDialogError(null);
    setDialogBusy(false);
  };

  const onRenameConfirm = async (name: string) => {
    if (!renameTarget) return;
    if (name === renameTarget.name) return closeDialogs();
    setDialogBusy(true);
    setDialogError(null);
    try {
      await updateProject.mutateAsync({ projectId: renameTarget.id, name });
      push("success", `Renamed "${renameTarget.name}" to "${name}"`);
      closeDialogs();
      await refetch();
    } catch (e) {
      setDialogBusy(false);
      setDialogError((e as Error)?.message || "Rename failed");
    }
  };

  const onDeleteConfirm = async (confirmName: string) => {
    if (!deleteTarget) return;
    setDialogBusy(true);
    setDialogError(null);
    try {
      const res = await deleteProject.mutateAsync({ projectId: deleteTarget.id, confirmName });
      const stopped = res.teardown.reduce((n, t) => n + t.stopped, 0);
      push("success", `Deleted "${deleteTarget.name}"${stopped ? ` · stopped ${plural(stopped, "instance")}` : ""}`);
      closeDialogs();
      await refetch();
    } catch (e) {
      setDialogBusy(false);
      setDialogError((e as Error)?.message || "Delete failed");
    }
  };

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

      {runnerProblem && (
        <div
          role="alert"
          className="card"
          style={{ marginBottom: "20px", borderColor: "rgba(239,68,68,0.45)", color: "#fca5a5", fontSize: "0.875rem", padding: "14px 18px" }}
        >
          <strong style={{ color: "#f87171" }}>Deploys are blocked.</strong> {runnerProblem}
        </div>
      )}

      <div style={{ marginBottom: "24px", display: "flex", gap: "12px", borderBottom: "1px solid var(--border-subtle)", paddingBottom: "16px" }}>
        {workspaces?.map((ws) => (
          <button
            key={ws.id}
            onClick={() => setActiveWorkspace(ws.id)}
            className={`btn ${workspaceId === ws.id ? "btn-secondary" : "btn-ghost"}`}
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
          {projects?.map((project) => {
            const badge = statusBadge(project.counts);
            const canOperate = project.myRole !== null && project.myRole !== "VIEWER";
            const canDelete = project.myRole === "OWNER" || project.myRole === "ADMIN";
            const busy = busyProjectId === project.id;
            const opsTitle = canOperate ? undefined : "Viewers cannot change projects";
            const hasServices = project.counts.services > 0;
            return (
              <div key={project.id} className="card" style={{ display: "flex", flexDirection: "column" }}>
                {/* Whole-card click target; the name link below is the accessible one */}
                <Link
                  href={`/dashboard/projects/${project.id}`}
                  aria-hidden="true"
                  tabIndex={-1}
                  style={{ position: "absolute", inset: 0, borderRadius: "inherit" }}
                />
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "8px", marginBottom: "14px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0 }}>
                    <div
                      style={{
                        width: "40px",
                        height: "40px",
                        flexShrink: 0,
                        background: "var(--bg-overlay)",
                        borderRadius: "var(--radius-sm)",
                        border: "1px solid var(--border-subtle)",
                        display: "grid",
                        placeItems: "center",
                        fontSize: "18px",
                      }}
                    >
                      📦
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <Link
                        href={`/dashboard/projects/${project.id}`}
                        style={{ position: "relative", fontWeight: 600, color: "var(--text-primary)", textDecoration: "none", wordBreak: "break-word" }}
                      >
                        {project.name}
                      </Link>
                      <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "2px" }}>
                        {plural(project.environments?.length || 0, "env")} · {plural(project.counts.services, "service")}
                      </div>
                    </div>
                  </div>
                  <div style={{ position: "relative" }}>
                    <ActionMenu
                      label={`Actions for project ${project.name}`}
                      minWidth={220}
                      items={[
                        { key: "open", label: "Open", icon: "↗", href: `/dashboard/projects/${project.id}` },
                        {
                          key: "redeploy",
                          label: "Redeploy all (fast)",
                          icon: "🔄",
                          separatorBefore: true,
                          disabled: !canOperate || !hasServices || Boolean(runnerProblem) || busy,
                          title: runnerProblem || opsTitle,
                          onSelect: () => onRedeploy(project.id, project.name, false),
                        },
                        {
                          key: "rebuild",
                          label: "Redeploy all (clean rebuild)",
                          icon: "⚡",
                          disabled: !canOperate || !hasServices || Boolean(runnerProblem) || busy,
                          title: runnerProblem || opsTitle,
                          onSelect: () => onRedeploy(project.id, project.name, true),
                        },
                        {
                          key: "pause",
                          label: "Pause all",
                          icon: "⏸",
                          disabled: !canOperate || !hasServices || busy,
                          title: opsTitle,
                          onSelect: () => onPause(project.id, project.name),
                        },
                        {
                          key: "resume",
                          label: "Resume all",
                          icon: "▶",
                          disabled: !canOperate || project.counts.paused === 0 || busy,
                          title: opsTitle || (project.counts.paused === 0 ? "No paused services" : undefined),
                          onSelect: () => onResume(project.id, project.name),
                        },
                        {
                          key: "rename",
                          label: "Rename",
                          icon: "✎",
                          separatorBefore: true,
                          disabled: !canOperate,
                          title: opsTitle,
                          onSelect: () => setRenameTarget({ id: project.id, name: project.name }),
                        },
                        { key: "settings", label: "Settings & Variables", icon: "⚙", href: `/dashboard/projects/${project.id}?tab=settings` },
                        {
                          key: "delete",
                          label: "Delete project",
                          icon: "🗑",
                          danger: true,
                          separatorBefore: true,
                          disabled: !canDelete,
                          title: canDelete ? undefined : "Only workspace owners and admins can delete projects",
                          onSelect: () => setDeleteTarget({ id: project.id, name: project.name }),
                        },
                      ]}
                    />
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "4px" }}>
                  <span className={`badge ${badge.className}`}>{badge.text}</span>
                  {busy && <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Working…</span>}
                </div>

                <div
                  style={{
                    marginTop: "auto",
                    paddingTop: "16px",
                    borderTop: "1px solid var(--border-subtle)",
                    fontSize: "0.8rem",
                    color: "var(--text-secondary)",
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "8px",
                  }}
                >
                  <span>{timeAgo(project.lastDeployedAt, now)}</span>
                  <span>Updated {new Date(project.updatedAt).toLocaleDateString()}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={renameTarget !== null}
        title="Rename project"
        input={{ label: "Project name", initialValue: renameTarget?.name ?? "", maxLength: 64 }}
        confirmLabel="Rename"
        busy={dialogBusy}
        error={dialogError}
        onConfirm={onRenameConfirm}
        onCancel={closeDialogs}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        danger
        title={`Delete project "${deleteTarget?.name ?? ""}"?`}
        description="Every service's containers are stopped on the runner, its routes and custom domains are removed, and the project is deleted. This cannot be undone."
        requireText={deleteTarget?.name ?? ""}
        confirmLabel="Delete project"
        busy={dialogBusy}
        error={dialogError}
        onConfirm={onDeleteConfirm}
        onCancel={closeDialogs}
      />
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
