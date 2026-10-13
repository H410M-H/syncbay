"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { trpc } from "@/lib/trpc-client";
import { BackButton } from "@/components/ui/back-button";

function NewServiceWizardContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialProjectId = searchParams.get("projectId") || "";

  // If initialProjectId is provided, fetch project directly to lock parent workspace
  const { data: initialProject } = trpc.project.byId.useQuery(
    { projectId: initialProjectId },
    { enabled: !!initialProjectId }
  );

  // Workspaces & Projects
  const { data: workspaces, isLoading: wsLoading } = trpc.workspace.list.useQuery();
  const [selectedWsId, setSelectedWsId] = useState<string>("");

  useEffect(() => {
    if (initialProject?.workspaceId) {
      setSelectedWsId(initialProject.workspaceId);
    }
  }, [initialProject?.workspaceId]);

  const activeWsId = selectedWsId || workspaces?.[0]?.id;

  const { data: projects, isLoading: projectsLoading } = trpc.project.list.useQuery(
    { workspaceId: activeWsId! },
    { enabled: !!activeWsId }
  );

  const [selectedProjectId, setSelectedProjectId] = useState<string>(initialProjectId);

  // When projects load, ensure selectedProjectId is set if not already
  useEffect(() => {
    if (initialProjectId) {
      setSelectedProjectId(initialProjectId);
    } else if (projects && projects.length > 0 && !selectedProjectId) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, initialProjectId, selectedProjectId]);

  const activeProject = projects?.find((p) => p.id === selectedProjectId) || projects?.[0];
  const defaultEnv = activeProject?.environments?.find((e) => e.isDefault) || activeProject?.environments?.[0];

  // GitHub Repos
  const { data: repos, isLoading: reposLoading } = trpc.github.listRepos.useQuery();

  // Wizard form state
  const [serviceName, setServiceName] = useState("web");
  const [sourceType, setSourceType] = useState<"github" | "docker" | "empty">("github");
  const [selectedRepoUrl, setSelectedRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [dockerImage, setDockerImage] = useState("node:20-alpine");
  const [rootDir, setRootDir] = useState("");
  const [buildCommand, setBuildCommand] = useState("");
  const [startCommand, setStartCommand] = useState("");
  const [port, setPort] = useState(3000);
  const [instanceType, setInstanceType] = useState<"lite" | "standard-1" | "standard-2" | "standard-4">("lite");
  const [scaleToZero, setScaleToZero] = useState(true);
  const [deployImmediately, setDeployImmediately] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const createServiceMutation = trpc.service.create.useMutation();
  const triggerDeployMutation = trpc.deployment.trigger.useMutation();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!defaultEnv?.id) {
      setErrorMsg("Please select a project with a valid environment.");
      return;
    }
    if (!serviceName.trim()) {
      setErrorMsg("Please enter a service name.");
      return;
    }

    setErrorMsg("");
    setSubmitting(true);

    try {
      const createdService = await createServiceMutation.mutateAsync({
        environmentId: defaultEnv.id,
        name: serviceName.trim(),
        sourceType,
        repoUrl: sourceType === "github" ? selectedRepoUrl || undefined : undefined,
        branch: sourceType === "github" ? branch || "main" : undefined,
        dockerImage: sourceType === "docker" ? dockerImage || undefined : undefined,
        rootDir: rootDir.trim() || undefined,
        buildCommand: buildCommand.trim() || undefined,
        startCommand: startCommand.trim() || undefined,
        port: port || 3000,
        instanceType,
        scaleToZero,
      });

      if (deployImmediately) {
        await triggerDeployMutation.mutateAsync({
          serviceId: createdService.id,
          commitMessage: "Initial deployment from Syncbay wizard",
        });
      }

      router.push(`/dashboard/projects/${selectedProjectId}?tab=services`);
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to create service");
      setSubmitting(false);
    }
  };

  return (
    <div className="fade-in" style={{ maxWidth: "760px", margin: "0 auto" }}>
      {/* ── Header ── */}
      <div style={{ marginBottom: "28px" }}>
        <BackButton
          fallbackUrl={selectedProjectId ? `/dashboard/projects/${selectedProjectId}` : "/dashboard/projects"}
          label="Back to Project"
        />
        <h1 className="page-title">Create a New Service</h1>
        <p className="page-subtitle">
          Configure a web application, API server, or background container to run on Syncbay.
        </p>
      </div>

      {errorMsg && (
        <div
          style={{
            padding: "12px 16px",
            borderRadius: "var(--radius-md)",
            background: "rgba(239,68,68,0.15)",
            border: "1px solid rgba(239,68,68,0.3)",
            color: "#f87171",
            fontSize: "0.875rem",
            marginBottom: "20px",
          }}
        >
          {errorMsg}
        </div>
      )}

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
        {/* ── Target Project & Workspace ── */}
        <div className="card">
          <h3 style={{ marginBottom: "16px" }}>Destination</h3>

          <div className="grid-2" style={{ gap: "16px" }}>
            <div className="field">
              <label>Workspace</label>
              <select
                className="input"
                value={activeWsId}
                onChange={(e) => setSelectedWsId(e.target.value)}
                disabled={wsLoading}
              >
                {workspaces?.map((ws) => (
                  <option key={ws.id} value={ws.id}>
                    {ws.name} ({ws.slug})
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label>Project</label>
              <select
                className="input"
                value={selectedProjectId}
                onChange={(e) => setSelectedProjectId(e.target.value)}
                disabled={projectsLoading || !projects?.length}
              >
                {projects?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* ── Source Type & Configuration ── */}
        <div className="card">
          <h3 style={{ marginBottom: "16px" }}>Deployment Source</h3>

          {/* Source Type Selector Buttons */}
          <div style={{ display: "flex", gap: "10px", marginBottom: "20px" }}>
            {[
              { id: "github", label: "GitHub Repo", icon: "🐙" },
              { id: "docker", label: "Docker Image", icon: "🐳" },
              { id: "empty", label: "Empty / Blank", icon: "⚡" },
            ].map((st) => (
              <button
                type="button"
                key={st.id}
                onClick={() => setSourceType(st.id as any)}
                className={`btn ${sourceType === st.id ? "btn-primary" : "btn-secondary"}`}
                style={{ flex: 1, justifyContent: "center" }}
              >
                <span>{st.icon}</span> {st.label}
              </button>
            ))}
          </div>

          {/* GitHub Repo Configuration */}
          {sourceType === "github" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <div className="field">
                <label>Select Repository</label>
                {repos && repos.length > 0 ? (
                  <select
                    className="input"
                    value={selectedRepoUrl}
                    onChange={(e) => {
                      setSelectedRepoUrl(e.target.value);
                      const r = repos.find((repo) => repo.htmlUrl === e.target.value);
                      if (r) {
                        setServiceName(r.name);
                        setBranch(r.defaultBranch || "main");
                      }
                    }}
                  >
                    <option value="">-- Choose from your GitHub repositories --</option>
                    {repos.map((r) => (
                      <option key={r.id} value={r.htmlUrl}>
                        {r.fullName} ({r.defaultBranch})
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="url"
                    className="input"
                    placeholder="https://github.com/org/repo"
                    value={selectedRepoUrl}
                    onChange={(e) => setSelectedRepoUrl(e.target.value)}
                    required
                  />
                )}
              </div>

              <div className="field">
                <label>Branch</label>
                <input
                  type="text"
                  className="input"
                  placeholder="main"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  required
                />
              </div>
            </div>
          )}

          {/* Docker Image Configuration */}
          {sourceType === "docker" && (
            <div className="field">
              <label>Docker Image Reference</label>
              <input
                type="text"
                className="input"
                placeholder="node:20-alpine or ghcr.io/org/app:latest"
                value={dockerImage}
                onChange={(e) => setDockerImage(e.target.value)}
                required
              />
              <span className="field-hint">
                Pulls public images from Docker Hub, GitHub Container Registry, or Quay.
              </span>
            </div>
          )}

          {/* Empty Template */}
          {sourceType === "empty" && (
            <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>
              Creates an empty placeholder container service. You can attach volumes, domains, or link code later.
            </p>
          )}
        </div>

        {/* ── Service Configuration & Commands ── */}
        <div className="card">
          <h3 style={{ marginBottom: "16px" }}>Service Specs &amp; Commands</h3>

          <div className="grid-2" style={{ gap: "16px", marginBottom: "16px" }}>
            <div className="field">
              <label>Service Name</label>
              <input
                type="text"
                className="input"
                placeholder="web"
                value={serviceName}
                onChange={(e) => setServiceName(e.target.value)}
                required
              />
            </div>

            <div className="field">
              <label>HTTP Port</label>
              <input
                type="number"
                min="1"
                max="65535"
                className="input"
                value={port}
                onChange={(e) => setPort(parseInt(e.target.value, 10) || 3000)}
                required
              />
            </div>
          </div>

          <div className="grid-2" style={{ gap: "16px", marginBottom: "16px" }}>
            <div className="field">
              <label>Build Command (optional)</label>
              <input
                type="text"
                className="input"
                placeholder="npm run build"
                value={buildCommand}
                onChange={(e) => setBuildCommand(e.target.value)}
              />
            </div>

            <div className="field">
              <label>Start Command (optional)</label>
              <input
                type="text"
                className="input"
                placeholder="npm start"
                value={startCommand}
                onChange={(e) => setStartCommand(e.target.value)}
              />
            </div>
          </div>

          <div className="field">
            <label>Root Directory (optional)</label>
            <input
              type="text"
              className="input"
              placeholder="/"
              value={rootDir}
              onChange={(e) => setRootDir(e.target.value)}
            />
            <span className="field-hint">
              Path within repository if using a monorepo structure.
            </span>
          </div>
        </div>

        {/* ── Compute Sizing & Scaling ── */}
        <div className="card">
          <h3 style={{ marginBottom: "16px" }}>Compute Instance Sizing</h3>

          <div className="field" style={{ marginBottom: "16px" }}>
            <label>Instance Tier</label>
            <select
              className="input"
              value={instanceType}
              onChange={(e) => setInstanceType(e.target.value as any)}
            >
              <option value="lite">lite — 0.25 vCPU, 512 MB RAM ($0.00002/s)</option>
              <option value="standard-1">standard-1 — 1.0 vCPU, 2 GB RAM</option>
              <option value="standard-2">standard-2 — 2.0 vCPU, 4 GB RAM</option>
              <option value="standard-4">standard-4 — 4.0 vCPU, 8 GB RAM</option>
            </select>
          </div>

          <label
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "10px",
              padding: "12px",
              background: "var(--bg-overlay)",
              borderRadius: "var(--radius-md)",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={scaleToZero}
              onChange={(e) => setScaleToZero(e.target.checked)}
              style={{ marginTop: "3px" }}
            />
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>Enable Scale-to-Zero</div>
              <div style={{ fontSize: "0.8125rem", color: "var(--text-muted)", marginTop: "2px" }}>
                Powers down container when idle for 300 seconds to conserve compute credits. Wakes up upon next request in ~250ms.
              </div>
            </div>
          </label>

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              marginTop: "12px",
              cursor: "pointer",
              fontSize: "0.875rem",
            }}
          >
            <input
              type="checkbox"
              checked={deployImmediately}
              onChange={(e) => setDeployImmediately(e.target.checked)}
            />
            <span>Trigger initial deployment immediately after creation</span>
          </label>
        </div>

        {/* ── Submit Buttons ── */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginTop: "8px" }}>
          <Link
            href={selectedProjectId ? `/dashboard/projects/${selectedProjectId}` : "/dashboard/projects"}
            className="btn btn-secondary"
          >
            Cancel
          </Link>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting}
          >
            {submitting ? "Creating Service..." : "Create & Launch Service"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function NewServicePage() {
  return (
    <Suspense
      fallback={
        <div style={{ textAlign: "center", padding: "64px" }}>
          <div className="loading-bar" style={{ width: "200px", margin: "0 auto 16px" }} />
          <p style={{ color: "var(--text-muted)" }}>Loading wizard...</p>
        </div>
      }
    >
      <NewServiceWizardContent />
    </Suspense>
  );
}
