"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { trpc } from "@/lib/trpc-client";
import { BrandLogo } from "@/components/ui/brand-logo";

function InviteContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get("token") || "";
  const { data: session, status } = useSession();
  const isAuthenticated = status === "authenticated" || !!session;

  const [accepting, setAccepting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const {
    data: invite,
    isLoading,
    error,
  } = trpc.workspace.getInvite.useQuery(
    { token },
    { enabled: !!token, retry: false }
  );

  const acceptMutation = trpc.workspace.acceptInvite.useMutation();

  const handleAccept = async () => {
    if (!token) return;
    setErrorMsg("");
    setAccepting(true);
    try {
      const res = await acceptMutation.mutateAsync({ token });
      router.push(`/dashboard/${res.workspaceSlug}`);
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to accept invitation");
      setAccepting(false);
    }
  };

  if (!token) {
    return (
      <div className="empty-state card" style={{ maxWidth: "480px", margin: "64px auto", padding: "40px 24px" }}>
        <div className="empty-icon">⚠️</div>
        <h3>Missing Invitation Token</h3>
        <p>This invitation link appears to be invalid or incomplete.</p>
        <Link href="/dashboard" className="btn btn-primary" style={{ marginTop: "16px" }}>
          Go to Dashboard
        </Link>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div style={{ textAlign: "center", padding: "80px 20px" }}>
        <div className="loading-bar" style={{ width: "200px", margin: "0 auto 16px" }} />
        <p style={{ color: "var(--text-muted)" }}>Validating workspace invitation...</p>
      </div>
    );
  }

  if (error || !invite) {
    return (
      <div className="empty-state card" style={{ maxWidth: "480px", margin: "64px auto", padding: "40px 24px" }}>
        <div className="empty-icon">❌</div>
        <h3>Invitation Not Found</h3>
        <p>{error?.message || "This invitation does not exist or may have been revoked."}</p>
        <Link href="/dashboard" className="btn btn-secondary" style={{ marginTop: "16px" }}>
          Back to Dashboard
        </Link>
      </div>
    );
  }

  if (invite.isExpired) {
    return (
      <div className="empty-state card" style={{ maxWidth: "480px", margin: "64px auto", padding: "40px 24px" }}>
        <div className="empty-icon">⏳</div>
        <h3>Invitation Expired</h3>
        <p>This invitation link has expired. Please request a new invitation from the workspace owner.</p>
        <Link href="/dashboard" className="btn btn-secondary" style={{ marginTop: "16px" }}>
          Back to Dashboard
        </Link>
      </div>
    );
  }

  if (invite.isAccepted) {
    return (
      <div className="card" style={{ maxWidth: "480px", margin: "64px auto", textAlign: "center", padding: "40px 24px" }}>
        <div style={{ fontSize: "36px", marginBottom: "12px" }}>✓</div>
        <h3>Invitation Already Accepted</h3>
        <p style={{ marginBottom: "20px" }}>
          You or another member have already accepted this invitation to <strong>{invite.workspaceName}</strong>.
        </p>
        <Link href={`/dashboard/${invite.workspaceSlug}`} className="btn btn-primary">
          Open Workspace Console
        </Link>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "24px" }}>
      <div className="card fade-in" style={{ width: "100%", maxWidth: "480px", padding: "36px" }}>
        <div style={{ textAlign: "center", marginBottom: "24px" }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: "16px" }}>
            <BrandLogo size="lg" showText={false} href="/" />
          </div>
          <h2 style={{ fontSize: "1.5rem", marginBottom: "6px" }}>Workspace Invitation</h2>
          <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>
            You have been invited to collaborate on Syncbay.
          </p>
        </div>

        {errorMsg && (
          <div
            style={{
              padding: "12px 14px",
              borderRadius: "var(--radius-md)",
              background: "rgba(239,68,68,0.15)",
              border: "1px solid rgba(239,68,68,0.3)",
              color: "#f87171",
              fontSize: "0.8125rem",
              marginBottom: "20px",
            }}
          >
            {errorMsg}
          </div>
        )}

        <div
          style={{
            padding: "16px",
            background: "var(--bg-overlay)",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--border-subtle)",
            marginBottom: "24px",
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>Target Workspace:</span>
            <strong style={{ color: "var(--text-primary)" }}>{invite.workspaceName}</strong>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>Assigned Role:</span>
            <span className="badge badge-active">{invite.role}</span>
          </div>

          {invite.email && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>Invited Email:</span>
              <span style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>{invite.email}</span>
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {!isAuthenticated ? (
            <Link
              href={`/auth/signin?callbackUrl=/invite/${encodeURIComponent(token)}`}
              className="btn btn-primary"
              style={{ width: "100%", justifyContent: "center", padding: "12px", minHeight: "44px", display: "flex", alignItems: "center" }}
            >
              Sign in to Accept
            </Link>
          ) : (
            <button
              onClick={handleAccept}
              className="btn btn-primary"
              style={{ width: "100%", justifyContent: "center", padding: "12px", minHeight: "44px" }}
              disabled={accepting}
            >
              {accepting ? "Joining Workspace..." : `Accept & Join ${invite.workspaceName}`}
            </button>
          )}
          <Link href="/dashboard" className="btn btn-ghost" style={{ width: "100%", justifyContent: "center", minHeight: "44px", display: "flex", alignItems: "center" }}>
            Decline / Later
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function InvitePage() {
  return (
    <Suspense
      fallback={
        <div style={{ textAlign: "center", padding: "80px 20px" }}>
          <div className="loading-bar" style={{ width: "200px", margin: "0 auto 16px" }} />
          <p style={{ color: "var(--text-muted)" }}>Loading invitation...</p>
        </div>
      }
    >
      <InviteContent />
    </Suspense>
  );
}
