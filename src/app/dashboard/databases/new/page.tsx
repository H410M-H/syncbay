"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { trpc } from "@/lib/trpc-client";
import { DatabaseProvider } from "@prisma/client";
import { BackButton } from "@/components/ui/back-button";

function NewDatabaseWizardContent() {
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

  useEffect(() => {
    if (initialProjectId) {
      setSelectedProjectId(initialProjectId);
    } else if (projects && projects.length > 0 && !selectedProjectId) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, initialProjectId, selectedProjectId]);

  const activeProject = projects?.find((p) => p.id === selectedProjectId) || projects?.[0];
  const defaultEnv = activeProject?.environments?.find((e) => e.isDefault) || activeProject?.environments?.[0];

  // Database Form State
  const [provider, setProvider] = useState<DatabaseProvider>(DatabaseProvider.POSTGRES);
  const [name, setName] = useState("main-db");
  const [region, setRegion] = useState("us-east-1");
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const createDatabaseMutation = trpc.database.create.useMutation();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!defaultEnv?.id) {
      setErrorMsg("Please select a project with a valid environment.");
      return;
    }
    if (!name.trim()) {
      setErrorMsg("Please enter a database instance name.");
      return;
    }

    setErrorMsg("");
    setSubmitting(true);

    try {
      await createDatabaseMutation.mutateAsync({
        environmentId: defaultEnv.id,
        name: name.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-"),
        provider,
        region,
      });

      router.push(`/dashboard/projects/${selectedProjectId}?tab=databases`);
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to provision database");
      setSubmitting(false);
    }
  };

  const envVarName = (name || "DB").toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_URL";

  return (
    <div className="fade-in" style={{ maxWidth: "760px", margin: "0 auto" }}>
      {/* ── Header ── */}
      <div style={{ marginBottom: "28px" }}>
        <BackButton
          fallbackUrl={selectedProjectId ? `/dashboard/projects/${selectedProjectId}?tab=databases` : "/dashboard/projects"}
          label="Back to Project"
        />
        <h1 className="page-title">Provision a Managed Database</h1>
        <p className="page-subtitle">
          Dedicated, fully-managed PostgreSQL, Redis, or MySQL instance with automated connection pooling.
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
        {/* ── Destination ── */}
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

        {/* ── Provider Selection ── */}
        <div className="card">
          <h3 style={{ marginBottom: "16px" }}>Select Database Engine</h3>

          <div className="grid-3" style={{ gap: "12px", marginBottom: "16px" }}>
            {[
              {
                id: DatabaseProvider.POSTGRES,
                icon: "🐘",
                name: "PostgreSQL",
                version: "v16",
                desc: "Relational database with pgvector, JSONB & full ACID transactions.",
              },
              {
                id: DatabaseProvider.REDIS,
                icon: "🔴",
                name: "Redis",
                version: "v7.2",
                desc: "In-memory data store for caching, pub/sub queues, and fast sessions.",
              },
              {
                id: DatabaseProvider.MYSQL,
                icon: "🐬",
                name: "MySQL",
                version: "v8.0",
                desc: "Popular open-source relational database with broad ecosystem support.",
              },
            ].map((p) => (
              <div
                key={p.id}
                onClick={() => setProvider(p.id)}
                style={{
                  padding: "16px",
                  borderRadius: "var(--radius-md)",
                  background: provider === p.id ? "rgba(99,102,241,0.12)" : "var(--bg-overlay)",
                  border: provider === p.id ? "2px solid var(--brand-primary)" : "1px solid var(--border-subtle)",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                  transition: "all 0.15s ease",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: "28px" }}>{p.icon}</span>
                  <span className="badge badge-queued" style={{ fontSize: "0.6875rem" }}>
                    {p.version}
                  </span>
                </div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: "1rem", color: "var(--text-primary)" }}>
                    {p.name}
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: "4px" }}>
                    {p.desc}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Instance Details & Region ── */}
        <div className="card">
          <h3 style={{ marginBottom: "16px" }}>Instance Details</h3>

          <div className="grid-2" style={{ gap: "16px", marginBottom: "16px" }}>
            <div className="field">
              <label>Instance Name</label>
              <input
                type="text"
                className="input"
                placeholder="main-db"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
              <span className="field-hint">Used in URLs and environment variables.</span>
            </div>

            <div className="field">
              <label>Deployment Region</label>
              <select
                className="input"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
              >
                <option value="us-east-1">us-east-1 (US East - N. Virginia)</option>
                <option value="us-west-2">us-west-2 (US West - Oregon)</option>
                <option value="eu-west-1">eu-west-1 (Europe - Ireland)</option>
                <option value="ap-southeast-1">ap-southeast-1 (Asia Pacific - Singapore)</option>
              </select>
              <span className="field-hint">Choose region closest to your primary service users.</span>
            </div>
          </div>

          <div className="grid-2" style={{ gap: "16px" }}>
            <div
              style={{
                padding: "12px 14px",
                background: "var(--bg-overlay)",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--border-subtle)",
              }}
            >
              <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>Storage Allocation</div>
              <div style={{ fontSize: "0.8125rem", color: "var(--text-muted)", marginTop: "2px" }}>
                1 GB NVMe SSD (Scalable on demand)
              </div>
            </div>

            <div
              style={{
                padding: "12px 14px",
                background: "var(--bg-overlay)",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--border-subtle)",
              }}
            >
              <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>Automated Backups</div>
              <div style={{ fontSize: "0.8125rem", color: "var(--text-muted)", marginTop: "2px" }}>
                Daily snapshots with 7-day retention
              </div>
            </div>
          </div>
        </div>

        {/* ── Automated Environment Injection Notice ── */}
        <div
          className="card"
          style={{
            background: "linear-gradient(135deg, rgba(99,102,241,0.06), rgba(6,182,212,0.06))",
            borderColor: "var(--border-emphasis)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
            <span style={{ fontSize: "20px" }}>🔗</span>
            <h4 style={{ fontSize: "0.9375rem" }}>Automatic Environment Variable Injection</h4>
          </div>
          <p style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>
            Syncbay will automatically generate and inject{" "}
            <code style={{ color: "var(--brand-accent)", fontWeight: 600 }}>{envVarName}</code> and{" "}
            <code style={{ color: "var(--brand-accent)", fontWeight: 600 }}>${`{{ ${name || "DB"}.URL }}`}</code>{" "}
            into all services in this environment. Your app can read this directly from <code>process.env.{envVarName}</code>.
          </p>
        </div>

        {/* ── Submit Buttons ── */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px" }}>
          <Link
            href={selectedProjectId ? `/dashboard/projects/${selectedProjectId}?tab=databases` : "/dashboard/projects"}
            className="btn btn-secondary"
          >
            Cancel
          </Link>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting}
          >
            {submitting ? "Provisioning Database..." : "Provision Database"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function NewDatabasePage() {
  return (
    <Suspense
      fallback={
        <div style={{ textAlign: "center", padding: "64px" }}>
          <div className="loading-bar" style={{ width: "200px", margin: "0 auto 16px" }} />
          <p style={{ color: "var(--text-muted)" }}>Loading wizard...</p>
        </div>
      }
    >
      <NewDatabaseWizardContent />
    </Suspense>
  );
}
