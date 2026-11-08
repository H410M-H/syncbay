"use client";

import { useRef, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { BackButton } from "@/components/ui/back-button";

interface WizardProgress {
  key: string;
  workspaceId: string;
  projectId: string;
  environmentId: string;
  serviceId?: string;
}

export default function NewProjectPage() {
  const router = useRouter();
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"github" | "custom">("github");

  // Custom Git URL state
  const [customRepoUrl, setCustomRepoUrl] = useState("");
  const [customBranch, setCustomBranch] = useState("main");
  const [customProjectName, setCustomProjectName] = useState("");
  const [isDeployingCustom, setIsDeployingCustom] = useState(false);

  // Fetch workspaces (to know where to put the project)
  const { data: workspaces, isLoading: loadingWs } = trpc.workspace.list.useQuery();

  // Fetch user's GitHub repos & connection status
  const { data: repos, isLoading: loadingRepos, error: reposError, refetch: refetchRepos } = trpc.github.listRepos.useQuery();
  const { data: ghStatus, isLoading: loadingGhStatus, refetch: refetchGhStatus } = trpc.github.getConnectionStatus.useQuery();

  // PAT connection state
  const connectPatMutation = trpc.github.connectPersonalAccessToken.useMutation();
  const [patInput, setPatInput] = useState("");
  const [patError, setPatError] = useState("");
  const [isConnectingPat, setIsConnectingPat] = useState(false);
  const [showPatInline, setShowPatInline] = useState(false);

  // Mutations
  const createProject = trpc.project.create.useMutation();
  const setupWebhook = trpc.github.setupWebhook.useMutation();
  const createService = trpc.service.create.useMutation();
  const triggerDeploy = trpc.deployment.trigger.useMutation();

  const [workspaceId, setWorkspaceId] = useState<string>("");
  const utils = trpc.useUtils();
  const runnerStatus = trpc.deployment.runnerStatus.useQuery(undefined, { staleTime: 30_000 });
  const runnerProblem = runnerStatus.data?.problem;

  // What this wizard already created, so a retry reuses it instead of creating a duplicate project.
  const progressRef = useRef<WizardProgress | null>(null);
  const inFlight = useRef(false);
  const [wizardError, setWizardError] = useState<{ message: string; existingProjectId?: string } | null>(null);

  /**
   * Preflight the runner, create (or reuse) the project and service, then trigger the first deploy.
   * Returns false when nothing was created and the form should be re-enabled. Once the project
   * exists, any later failure opens that project with the error instead of offering "create" again.
   */
  const runWizard = async (plan: {
    key: string;
    workspaceId: string;
    projectName: string;
    service: { name: string; sourceType: "github"; repoUrl: string; branch: string };
    commitMessage: string;
    afterProjectCreated?: () => Promise<void>;
  }): Promise<boolean> => {
    if (inFlight.current) return true;
    inFlight.current = true;
    setWizardError(null);
    let projectId: string | null = null;
    try {
      // 0. Preflight: a misconfigured runner fails here, before anything is created
      const status = await utils.deployment.runnerStatus.fetch(undefined, { staleTime: 0 });
      if (status.problem) {
        setWizardError({ message: status.problem });
        return false;
      }

      // 1. Project (reused when retrying the same source into the same workspace)
      const remembered = progressRef.current;
      let progress = remembered && remembered.key === plan.key && remembered.workspaceId === plan.workspaceId ? remembered : null;
      if (!progress) {
        const project = await createProject.mutateAsync({ workspaceId: plan.workspaceId, name: plan.projectName });
        progress = { key: plan.key, workspaceId: plan.workspaceId, projectId: project.id, environmentId: project.environments[0].id };
        progressRef.current = progress;
        await plan.afterProjectCreated?.();
      }
      projectId = progress.projectId;

      // 2. Service (reused on retry)
      if (!progress.serviceId) {
        const service = await createService.mutateAsync({ environmentId: progress.environmentId, ...plan.service });
        progress.serviceId = service.id;
      }

      // 3. Initial deployment
      await triggerDeploy.mutateAsync({ serviceId: progress.serviceId, commitMessage: plan.commitMessage });
      progressRef.current = null;
      router.push(`/dashboard/projects/${projectId}`);
      return true;
    } catch (error) {
      const err = error as { message?: string; data?: { code?: string; details?: { existingProjectId?: unknown } | null } };
      const message = err?.message || "Deployment setup failed";
      console.error(error);
      if (projectId) {
        router.push(`/dashboard/projects/${projectId}?tab=services&setupError=${encodeURIComponent(message)}`);
        return true;
      }
      const existing = err?.data?.code === "CONFLICT" ? err.data.details?.existingProjectId : undefined;
      setWizardError({ message, existingProjectId: typeof existing === "string" ? existing : undefined });
      return false;
    } finally {
      inFlight.current = false;
    }
  };

  const handleDeploy = async (repoFullName: string) => {
    const targetWs = workspaceId || workspaces?.[0]?.id;
    if (!targetWs) {
      setWizardError({ message: "Please select a target workspace" });
      return;
    }

    const repo = repos?.find((r) => r.fullName === repoFullName);
    if (!repo) return;

    setSelectedRepo(repoFullName);
    const keepGoing = await runWizard({
      key: `github:${repo.fullName}`,
      workspaceId: targetWs,
      projectName: repo.name,
      service: { name: "web", sourceType: "github", repoUrl: repo.htmlUrl, branch: repo.defaultBranch || "main" },
      commitMessage: "Initial deployment from Syncbay",
      // Setup GitHub Webhook (gracefully skipped if GitHub account not linked)
      afterProjectCreated: async () => {
        const [owner, repoName] = repo.fullName.split("/");
        if (!owner || !repoName) return;
        // Non-blocking: starter templates or unlinked accounts don't need a real webhook
        await setupWebhook.mutateAsync({ owner, repo: repoName }).catch(() => null);
      },
    });
    if (!keepGoing) setSelectedRepo(null);
  };

  const handleDeployCustom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customRepoUrl) {
      setWizardError({ message: "Please enter a repository URL" });
      return;
    }

    const targetWs = workspaceId || workspaces?.[0]?.id;
    if (!targetWs) {
      setWizardError({ message: "Please select a target workspace" });
      return;
    }

    // Auto-derive project name if empty
    const derivedName =
      customProjectName.trim() ||
      customRepoUrl.replace(/\/$/, "").split("/").pop()?.replace(/\.git$/, "") ||
      "web-app";
    const repoUrl = customRepoUrl.trim();
    const branch = customBranch.trim() || "main";

    setIsDeployingCustom(true);
    const keepGoing = await runWizard({
      key: `custom:${repoUrl}#${branch}:${derivedName}`,
      workspaceId: targetWs,
      projectName: derivedName,
      service: { name: "web", sourceType: "github", repoUrl, branch },
      commitMessage: "Initial deployment from custom Git URL",
    });
    if (!keepGoing) setIsDeployingCustom(false);
  };

  return (
    <div className="fade-in" style={{ maxWidth: "800px", margin: "0 auto" }}>
      <div style={{ marginBottom: "32px" }}>
        <BackButton fallbackUrl="/dashboard" label="Back to Dashboard" />
        <h1 className="page-title">Deploy a new project</h1>
        <p className="page-subtitle">
          Import a repository from GitHub or deploy from any public Git URL.
        </p>
      </div>

      {/* Target Workspace Selector */}
      <div className="card" style={{ marginBottom: "24px" }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label style={{ display: "block", marginBottom: "8px", fontWeight: 500 }}>
            Target Workspace
          </label>
          <select
            className="input"
            value={workspaceId || workspaces?.[0]?.id || ""}
            onChange={(e) => setWorkspaceId(e.target.value)}
            disabled={loadingWs}
            style={{ width: "100%", padding: "10px 12px" }}
          >
            {loadingWs ? (
              <option>Loading workspaces...</option>
            ) : (
              workspaces?.map((ws) => (
                <option key={ws.id} value={ws.id}>
                  {ws.name} ({ws.slug}) {ws.isPersonal ? "• Personal" : "• Team"}
                </option>
              ))
            )}
          </select>
        </div>
      </div>

      {runnerProblem && (
        <div
          role="alert"
          className="card"
          style={{ marginBottom: "16px", borderColor: "rgba(239,68,68,0.45)", color: "#fca5a5", fontSize: "0.875rem", padding: "14px 18px" }}
        >
          <strong style={{ color: "#f87171" }}>Deploys are blocked.</strong> {runnerProblem}
        </div>
      )}

      {wizardError && (
        <div
          role="alert"
          className="card"
          style={{ marginBottom: "16px", borderColor: "rgba(239,68,68,0.45)", padding: "14px 18px", display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}
        >
          <span style={{ color: "#fca5a5", fontSize: "0.875rem", flex: 1, minWidth: "200px" }}>{wizardError.message}</span>
          {wizardError.existingProjectId && (
            <Link href={`/dashboard/projects/${wizardError.existingProjectId}`} className="btn btn-secondary btn-sm">
              Open existing project
            </Link>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setWizardError(null)} aria-label="Dismiss error">
            ×
          </button>
        </div>
      )}

      {/* Mode Tabs */}
      <div
        style={{
          display: "flex",
          gap: "8px",
          marginBottom: "16px",
          borderBottom: "1px solid var(--border-subtle)",
          paddingBottom: "8px",
        }}
      >
        <button
          onClick={() => setActiveTab("github")}
          className={`btn ${activeTab === "github" ? "btn-secondary" : "btn-ghost"}`}
          style={{
            fontWeight: 600,
            borderColor: activeTab === "github" ? "var(--brand-primary)" : "transparent",
          }}
        >
          🐙 GitHub Repositories
        </button>
        <button
          onClick={() => setActiveTab("custom")}
          className={`btn ${activeTab === "custom" ? "btn-secondary" : "btn-ghost"}`}
          style={{
            fontWeight: 600,
            borderColor: activeTab === "custom" ? "var(--brand-primary)" : "transparent",
          }}
        >
          🔗 Custom Git Repository URL
        </button>
      </div>

      {activeTab === "github" ? (
        <div className="card">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "16px",
            }}
          >
            <h3 style={{ display: "flex", alignItems: "center", gap: "8px", margin: 0 }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
              </svg>
              GitHub Repositories
            </h3>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              {loadingGhStatus ? (
                <span className="badge badge-queued">Checking...</span>
              ) : ghStatus?.isConnected ? (
                <span className="badge badge-active" style={{ fontSize: "0.75rem", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                  <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#10b981", display: "inline-block" }}></span>
                  @{ghStatus.username}
                </span>
              ) : null}
              <Link
                href="/dashboard/settings"
                className="btn btn-ghost btn-sm"
                style={{ fontSize: "0.75rem" }}
              >
                GitHub Settings ↗
              </Link>
            </div>
          </div>

          <div
            style={{
              padding: "10px 14px",
              background: "rgba(99, 102, 241, 0.08)",
              border: "1px solid var(--border-emphasis)",
              borderRadius: "var(--radius-sm)",
              fontSize: "0.8125rem",
              color: "var(--text-secondary)",
              marginBottom: "16px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "8px",
            }}
          >
            <span>
              {ghStatus?.isConnected
                ? `Showing repositories for @${ghStatus.username}. Click deploy to provision a project.`
                : "Import a repository from your connected GitHub account to build and deploy with Syncbay."}
            </span>
            <button
              type="button"
              onClick={() => setShowPatInline(!showPatInline)}
              className="btn btn-ghost btn-sm"
              style={{ fontSize: "0.75rem", padding: "2px 8px" }}
            >
              {showPatInline ? "Hide Token Input" : "Paste GitHub Token (PAT)"}
            </button>
          </div>

          {showPatInline && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!patInput.trim()) return;
                setPatError("");
                setIsConnectingPat(true);
                try {
                  await connectPatMutation.mutateAsync({ token: patInput.trim() });
                  setPatInput("");
                  setShowPatInline(false);
                  await refetchGhStatus();
                  await refetchRepos();
                } catch (err: any) {
                  setPatError(err.message || "Failed to validate GitHub token.");
                } finally {
                  setIsConnectingPat(false);
                }
              }}
              style={{
                marginBottom: "16px",
                padding: "14px",
                background: "var(--bg-overlay)",
                border: "1px solid var(--border-emphasis)",
                borderRadius: "var(--radius-md)",
              }}
            >
              <div style={{ fontWeight: 600, fontSize: "0.875rem", marginBottom: "4px" }}>
                Connect via GitHub Personal Access Token (PAT)
              </div>
              <p style={{ fontSize: "0.8125rem", color: "var(--text-secondary)", marginBottom: "10px" }}>
                Provide a GitHub PAT with <code>repo</code> permissions to instantly fetch and import your repositories.
              </p>
              {patError && (
                <div style={{ padding: "8px 12px", background: "rgba(239, 68, 68, 0.15)", border: "1px solid rgba(239, 68, 68, 0.35)", color: "#fca5a5", borderRadius: "var(--radius-sm)", fontSize: "0.8125rem", marginBottom: "10px" }}>
                  {patError}
                </div>
              )}
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  type="password"
                  className="input"
                  placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                  value={patInput}
                  onChange={(e) => setPatInput(e.target.value)}
                  style={{ flex: 1, fontFamily: "monospace", fontSize: "0.875rem" }}
                />
                <button
                  type="submit"
                  disabled={isConnectingPat || !patInput.trim()}
                  className="btn btn-primary btn-sm"
                  style={{ minWidth: "120px", justifyContent: "center" }}
                >
                  {isConnectingPat ? "Verifying..." : "Save & Fetch"}
                </button>
              </div>
            </form>
          )}

          {loadingRepos ? (
            <div style={{ textAlign: "center", padding: "40px" }}>
              <div className="loading-bar" style={{ width: "100px", margin: "0 auto 16px" }}></div>
              <p style={{ color: "var(--text-muted)" }}>Loading repositories...</p>
            </div>
          ) : repos?.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">🐙</div>
              <h3>No GitHub repositories found</h3>
              <p style={{ color: "var(--text-secondary)", marginBottom: "16px" }}>
                {ghStatus?.isConnected
                  ? "Your GitHub account is connected but no repositories were found, or the token needs repo permissions."
                  : "Connect your GitHub account or paste a Personal Access Token to list your repositories."}
              </p>
              <div style={{ display: "flex", gap: "12px", justifyContent: "center", flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => signIn("github", { callbackUrl: typeof window !== "undefined" ? window.location.href : "/dashboard/projects/new" })}
                  className="btn btn-secondary btn-sm"
                >
                  Connect with GitHub (OAuth)
                </button>
                <button
                  type="button"
                  onClick={() => setShowPatInline(true)}
                  className="btn btn-secondary btn-sm"
                >
                  Enter GitHub Token (PAT)
                </button>
                <button onClick={() => setActiveTab("custom")} className="btn btn-primary btn-sm">
                  Deploy Custom Git URL
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {repos?.map((repo) => (
                <div
                  key={repo.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "16px",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "var(--radius-md)",
                    background: "var(--bg-overlay)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <div style={{ fontSize: "20px" }}>
                      {repo.name.includes("next")
                        ? "▲"
                        : repo.name.includes("fastapi") || repo.name.includes("python")
                        ? "🐍"
                        : repo.name.includes("go")
                        ? "🐹"
                        : repo.name.includes("rust")
                        ? "🦀"
                        : "📦"}
                    </div>
                    <div>
                      <div style={{ fontWeight: 600 }}>{repo.name}</div>
                      <div
                        style={{
                          fontSize: "0.8rem",
                          color: "var(--text-muted)",
                          marginTop: "2px",
                        }}
                      >
                        {repo.fullName} · branch: {repo.defaultBranch}
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={() => handleDeploy(repo.fullName)}
                    disabled={selectedRepo !== null || Boolean(runnerProblem)}
                    title={runnerProblem}
                    className="btn btn-primary btn-sm"
                    style={{ minWidth: "90px", justifyContent: "center" }}
                  >
                    {selectedRepo === repo.fullName ? (
                      <span className="loading-bar" style={{ width: "40px" }}></span>
                    ) : (
                      "Deploy"
                    )}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="card">
          <h3 style={{ marginBottom: "16px" }}>Deploy from Public Git URL</h3>
          <p style={{ fontSize: "0.875rem", color: "var(--text-muted)", marginBottom: "20px" }}>
            Enter any public Git repository URL. Syncbay will auto-detect the runtime language and
            framework (Node.js, Python, Go, Rust, Ruby, or Dockerfile).
          </p>

          <form onSubmit={handleDeployCustom} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div className="field">
              <label>Git Repository URL *</label>
              <input
                type="url"
                required
                className="input"
                placeholder="https://github.com/vercel/next.js"
                value={customRepoUrl}
                onChange={(e) => setCustomRepoUrl(e.target.value)}
              />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
              <div className="field">
                <label>Branch</label>
                <input
                  type="text"
                  className="input"
                  placeholder="main"
                  value={customBranch}
                  onChange={(e) => setCustomBranch(e.target.value)}
                />
              </div>

              <div className="field">
                <label>Project Name (optional)</label>
                <input
                  type="text"
                  className="input"
                  placeholder="my-awesome-app"
                  value={customProjectName}
                  onChange={(e) => setCustomProjectName(e.target.value)}
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={isDeployingCustom || Boolean(runnerProblem)}
              title={runnerProblem}
              className="btn btn-primary"
              style={{ marginTop: "8px", alignSelf: "flex-start" }}
            >
              {isDeployingCustom ? "Creating & Deploying..." : "🚀 Deploy Custom Repository"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
