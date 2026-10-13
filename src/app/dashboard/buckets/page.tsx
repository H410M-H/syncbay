"use client";

import { useState } from "react";
import Link from "next/link";
import { trpc } from "@/lib/trpc-client";
import { useDashboard } from "../dashboard-shell";
import { BackButton } from "@/components/ui/back-button";

export default function BucketsPage() {
  const dashboard = useDashboard();
  const { data: workspaces, isLoading: wsLoading } = trpc.workspace.list.useQuery();
  const [selectedWsId, setSelectedWsId] = useState<string>("");

  const activeWorkspace =
    workspaces?.find((w) => w.id === (selectedWsId || dashboard?.currentWorkspace?.id)) ||
    dashboard?.currentWorkspace ||
    workspaces?.[0];

  const workspaceId = activeWorkspace?.id;

  const {
    data: buckets,
    isLoading: bucketsLoading,
    refetch: refetchBuckets,
  } = trpc.bucket.list.useQuery(
    { workspaceId },
    { enabled: !!workspaceId }
  );

  const [selectedBucketForUrl, setSelectedBucketForUrl] = useState<any | null>(null);
  const [objectKey, setObjectKey] = useState("uploads/asset.png");
  const [urlOperation, setUrlOperation] = useState<"get" | "put">("get");
  const [expiresInSeconds, setExpiresInSeconds] = useState(3600);
  const [generatedPresignedUrl, setGeneratedPresignedUrl] = useState<string | null>(null);
  const [generatingUrl, setGeneratingUrl] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const generateUrlMutation = trpc.bucket.generatePresignedUrl.useMutation();
  const deleteMutation = trpc.bucket.delete.useMutation();

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(id);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleGeneratePresignedUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedBucketForUrl) return;
    setGeneratingUrl(true);
    setGeneratedPresignedUrl(null);
    try {
      const res = await generateUrlMutation.mutateAsync({
        bucketId: selectedBucketForUrl.id,
        key: objectKey.trim(),
        operation: urlOperation,
        expiresInSeconds,
      });
      setGeneratedPresignedUrl(res.url);
    } catch (err: any) {
      alert(err.message || "Failed to generate presigned URL");
    } finally {
      setGeneratingUrl(false);
    }
  };

  const handleDelete = async (bucketId: string) => {
    if (!confirm("Are you sure you want to delete this storage bucket? All files will be purged.")) {
      return;
    }
    setDeletingId(bucketId);
    try {
      await deleteMutation.mutateAsync({ bucketId });
      await refetchBuckets();
    } catch (err: any) {
      alert(err.message || "Failed to delete bucket");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="fade-in">
      <div style={{ marginBottom: "16px" }}>
        <BackButton fallbackUrl="/dashboard" label="Back to Dashboard" />
      </div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Object Storage Buckets</h1>
          <p className="page-subtitle">
            High-durability S3 and Cloudflare R2 compatible object storage with zero egress fees.
          </p>
        </div>
        <Link href="/dashboard/buckets/new" className="btn btn-primary">
          ＋ New Bucket
        </Link>
      </div>

      {/* Workspace Switcher */}
      <div
        style={{
          display: "flex",
          gap: "8px",
          marginBottom: "24px",
          borderBottom: "1px solid var(--border-subtle)",
          paddingBottom: "16px",
          flexWrap: "wrap",
        }}
      >
        {workspaces?.map((ws) => (
          <button
            key={ws.id}
            onClick={() => setSelectedWsId(ws.id)}
            className={`btn btn-sm ${
              (selectedWsId || dashboard?.currentWorkspace?.id) === ws.id
                ? "btn-secondary"
                : "btn-ghost"
            }`}
            style={
              (selectedWsId || dashboard?.currentWorkspace?.id) === ws.id
                ? { borderColor: "var(--brand-primary)" }
                : {}
            }
          >
            <span>{ws.isPersonal ? "👤" : "🏢"}</span> {ws.name}
          </button>
        ))}
      </div>

      {bucketsLoading || wsLoading ? (
        <div style={{ textAlign: "center", padding: "64px" }}>
          <div className="loading-bar" style={{ width: "200px", margin: "0 auto 16px" }} />
          <p style={{ color: "var(--text-muted)" }}>Loading storage buckets...</p>
        </div>
      ) : !buckets || buckets.length === 0 ? (
        <div className="empty-state card" style={{ padding: "48px 24px", textAlign: "center" }}>
          <div className="empty-icon" style={{ fontSize: "42px", marginBottom: "12px" }}>
            🪣
          </div>
          <h3 style={{ fontSize: "1.25rem", marginBottom: "8px" }}>No Storage Buckets</h3>
          <p style={{ color: "var(--text-secondary)", maxWidth: "480px", margin: "0 auto 20px" }}>
            Create an S3 or Cloudflare R2 bucket to store static assets, user uploads, AI model
            checkpoints, and container build caches with low latency.
          </p>
          <Link href="/dashboard/buckets/new" className="btn btn-primary">
            Create Storage Bucket
          </Link>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {buckets.map((b: any) => {
            return (
              <div
                key={b.id}
                className="card"
                style={{
                  padding: "20px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "16px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    flexWrap: "wrap",
                    gap: "12px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <div
                      style={{
                        width: "44px",
                        height: "44px",
                        borderRadius: "var(--radius-md)",
                        background: "rgba(168,85,247,0.15)",
                        color: "#c084fc",
                        display: "grid",
                        placeItems: "center",
                        fontSize: "20px",
                      }}
                    >
                      🪣
                    </div>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <h3 style={{ fontSize: "1.1rem", fontWeight: 700 }}>{b.name}</h3>
                        <span className="badge badge-active" style={{ fontSize: "0.7rem" }}>
                          ACTIVE
                        </span>
                        <span className="badge badge-secondary" style={{ fontSize: "0.7rem" }}>
                          Cloudflare R2
                        </span>
                        <span
                          className="badge badge-queued"
                          style={{ fontSize: "0.7rem", color: "#38bdf8" }}
                        >
                          🌐 Public CDN
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: "0.8rem",
                          color: "var(--text-muted)",
                          display: "flex",
                          gap: "12px",
                          marginTop: "2px",
                        }}
                      >
                        <span>Project: {b.project?.name || "Global"}</span>
                        <span>•</span>
                        <span>R2 Bucket: {b.r2BucketRef}</span>
                        <span>•</span>
                        <span>Endpoint: {b.endpoint}</span>
                      </div>
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <button
                      onClick={() => {
                        setSelectedBucketForUrl(b);
                        setGeneratedPresignedUrl(null);
                      }}
                      className="btn btn-secondary btn-sm"
                      style={{ fontSize: "0.75rem" }}
                    >
                      🔑 Presigned URL
                    </button>
                    <button
                      onClick={() => handleDelete(b.id)}
                      disabled={deletingId === b.id}
                      className="btn btn-danger btn-sm"
                      style={{ fontSize: "0.75rem" }}
                    >
                      {deletingId === b.id ? "Purging..." : "Delete"}
                    </button>
                  </div>
                </div>

                {/* S3 Credentials Box */}
                <div
                  style={{
                    background: "var(--bg-overlay)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "var(--radius-sm)",
                    padding: "10px 14px",
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                    gap: "12px",
                    fontSize: "0.8125rem",
                    fontFamily: "var(--font-mono, monospace)",
                  }}
                >
                  <div>
                    <span style={{ color: "var(--text-muted)" }}>R2_BUCKET: </span>
                    <span style={{ color: "var(--text-primary)" }}>{b.r2BucketRef}</span>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ color: "var(--text-muted)" }}>PUBLIC_URL: </span>
                    <a
                      href={b.publicUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "var(--brand-accent)", textDecoration: "underline" }}
                    >
                      {b.publicUrl}
                    </a>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Presigned URL Generator Dialog */}
      {selectedBucketForUrl && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            backdropFilter: "blur(6px)",
            display: "grid",
            placeItems: "center",
            zIndex: 1000,
            padding: "20px",
          }}
        >
          <div className="card fade-in" style={{ width: "100%", maxWidth: "520px", padding: "28px" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "16px",
              }}
            >
              <h3 style={{ fontSize: "1.15rem", fontWeight: 700 }}>
                Generate Pre-signed URL ({selectedBucketForUrl.name})
              </h3>
              <button
                onClick={() => setSelectedBucketForUrl(null)}
                className="btn btn-ghost btn-sm"
                style={{ fontSize: "1rem" }}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleGeneratePresignedUrl} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              <div>
                <label style={{ fontSize: "0.8rem", color: "var(--text-secondary)", display: "block", marginBottom: "4px" }}>
                  Object Key (Path in Bucket)
                </label>
                <input
                  type="text"
                  value={objectKey}
                  onChange={(e) => setObjectKey(e.target.value)}
                  className="input"
                  style={{ width: "100%" }}
                  required
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                <div>
                  <label style={{ fontSize: "0.8rem", color: "var(--text-secondary)", display: "block", marginBottom: "4px" }}>
                    Operation
                  </label>
                  <select
                    value={urlOperation}
                    onChange={(e: any) => setUrlOperation(e.target.value as "get" | "put")}
                    className="input"
                    style={{ width: "100%" }}
                  >
                    <option value="get">Download (GET)</option>
                    <option value="put">Direct Upload (PUT)</option>
                  </select>
                </div>

                <div>
                  <label style={{ fontSize: "0.8rem", color: "var(--text-secondary)", display: "block", marginBottom: "4px" }}>
                    Expiry (Seconds)
                  </label>
                  <input
                    type="number"
                    value={expiresInSeconds}
                    onChange={(e) => setExpiresInSeconds(parseInt(e.target.value, 10))}
                    className="input"
                    style={{ width: "100%" }}
                    min={60}
                    max={604800}
                  />
                </div>
              </div>

              <button
                type="submit"
                className="btn btn-primary"
                disabled={generatingUrl}
                style={{ width: "100%", justifyContent: "center", marginTop: "8px" }}
              >
                {generatingUrl ? "Signing URL..." : "Generate Signed Link"}
              </button>
            </form>

            {generatedPresignedUrl && (
              <div
                style={{
                  marginTop: "16px",
                  padding: "12px",
                  background: "var(--bg-overlay)",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "4px" }}>
                  Active Presigned URL:
                </div>
                <div
                  style={{
                    fontSize: "0.75rem",
                    fontFamily: "var(--font-mono, monospace)",
                    color: "var(--brand-accent)",
                    wordBreak: "break-all",
                    maxHeight: "80px",
                    overflowY: "auto",
                    marginBottom: "8px",
                  }}
                >
                  {generatedPresignedUrl}
                </div>
                <button
                  onClick={() => copyToClipboard(generatedPresignedUrl, "presigned_url")}
                  className="btn btn-secondary btn-sm"
                  style={{ width: "100%", justifyContent: "center", fontSize: "0.75rem" }}
                >
                  {copiedKey === "presigned_url" ? "✓ Copied to Clipboard" : "Copy Full Signed URL"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
