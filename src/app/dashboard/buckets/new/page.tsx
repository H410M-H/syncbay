"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { trpc } from "@/lib/trpc-client";
import { BackButton } from "@/components/ui/back-button";

function NewBucketWizardContent() {
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

  // Form State
  const [bucketName, setBucketName] = useState("user-assets");
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const createBucketMutation = trpc.bucket.create.useMutation();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProjectId) {
      setErrorMsg("Please select a project.");
      return;
    }
    const cleanName = bucketName.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
    if (!cleanName) {
      setErrorMsg("Please enter a valid bucket name.");
      return;
    }

    setErrorMsg("");
    setSubmitting(true);

    try {
      await createBucketMutation.mutateAsync({
        projectId: selectedProjectId,
        name: cleanName,
      });

      router.push(`/dashboard/projects/${selectedProjectId}?tab=databases`);
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to create bucket");
      setSubmitting(false);
    }
  };

  return (
    <div className="fade-in" style={{ maxWidth: "760px", margin: "0 auto" }}>
      {/* ── Header ── */}
      <div style={{ marginBottom: "28px" }}>
        <BackButton
          fallbackUrl={selectedProjectId ? `/dashboard/projects/${selectedProjectId}?tab=databases` : "/dashboard/projects"}
          label="Back to Project"
        />
        <h1 className="page-title">Create an Object Storage Bucket</h1>
        <p className="page-subtitle">
          S3-compatible blob storage powered by Cloudflare R2 with zero egress fees and global edge distribution.
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

        {/* ── Bucket Configuration ── */}
        <div className="card">
          <h3 style={{ marginBottom: "16px" }}>Bucket Details</h3>

          <div className="field" style={{ marginBottom: "16px" }}>
            <label>Bucket Name</label>
            <input
              type="text"
              className="input"
              placeholder="user-uploads"
              value={bucketName}
              onChange={(e) => setBucketName(e.target.value)}
              required
            />
            <span className="field-hint">
              Use lowercase letters, numbers, and hyphens (3-63 characters).
            </span>
          </div>

          <div className="grid-3" style={{ gap: "12px", marginTop: "16px" }}>
            <div
              style={{
                padding: "14px",
                background: "var(--bg-overlay)",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--border-subtle)",
              }}
            >
              <div style={{ fontSize: "20px", marginBottom: "6px" }}>🌐</div>
              <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>Zero Egress Fees</div>
              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "2px" }}>
                $0.00 / GB bandwidth across the global Cloudflare network.
              </div>
            </div>

            <div
              style={{
                padding: "14px",
                background: "var(--bg-overlay)",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--border-subtle)",
              }}
            >
              <div style={{ fontSize: "20px", marginBottom: "6px" }}>⚡</div>
              <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>S3 Compatibility</div>
              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "2px" }}>
                Drop-in compatible with AWS SDK, MinIO, and presigned URLs.
              </div>
            </div>

            <div
              style={{
                padding: "14px",
                background: "var(--bg-overlay)",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--border-subtle)",
              }}
            >
              <div style={{ fontSize: "20px", marginBottom: "6px" }}>🔒</div>
              <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>Durable Storage</div>
              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "2px" }}>
                99.999999999% (11 9&apos;s) annual durability guarantee.
              </div>
            </div>
          </div>
        </div>

        {/* ── Callout Notice ── */}
        <div
          className="card"
          style={{
            background: "linear-gradient(135deg, rgba(99,102,241,0.06), rgba(6,182,212,0.06))",
            borderColor: "var(--border-emphasis)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
            <span style={{ fontSize: "20px" }}>🪣</span>
            <h4 style={{ fontSize: "0.9375rem" }}>Object Storage Integration</h4>
          </div>
          <p style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>
            Once provisioned, your bucket will be assigned an S3 endpoint and access credentials. You can generate
            time-limited presigned URLs directly from the Project Console or upload assets securely from your backend
            services.
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
            {submitting ? "Creating Bucket..." : "Create Object Bucket"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function NewBucketPage() {
  return (
    <Suspense
      fallback={
        <div style={{ textAlign: "center", padding: "64px" }}>
          <div className="loading-bar" style={{ width: "200px", margin: "0 auto 16px" }} />
          <p style={{ color: "var(--text-muted)" }}>Loading wizard...</p>
        </div>
      }
    >
      <NewBucketWizardContent />
    </Suspense>
  );
}
