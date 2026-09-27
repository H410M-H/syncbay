"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { WorkspaceRole } from "@prisma/client";
import { useDashboard } from "../dashboard-shell";

export default function MembersPage() {
  const dashboard = useDashboard();
  const { data: fetchedWorkspaces, isLoading: wsLoading, refetch: refetchWorkspaces } = trpc.workspace.list.useQuery();
  const workspaces = dashboard?.workspaces || fetchedWorkspaces;
  const [selectedWsId, setSelectedWsId] = useState<string>("");

  const activeWorkspace =
    workspaces?.find((w) => w.id === (selectedWsId || dashboard?.currentWorkspace?.id)) ||
    dashboard?.currentWorkspace ||
    workspaces?.[0];

  const workspaceId = activeWorkspace?.id;

  const currentMember = activeWorkspace?.members?.find((m: any) => m.userId === dashboard?.user?.id);
  const isOwner = currentMember?.role === "OWNER" || activeWorkspace?.isPersonal;
  const canManageMembers = isOwner || currentMember?.role === "ADMIN";

  // Pending invites
  const {
    data: invites,
    isLoading: invitesLoading,
    refetch: refetchInvites,
  } = trpc.workspace.listInvites.useQuery(
    { workspaceId: workspaceId! },
    { enabled: !!workspaceId }
  );

  // Mutations
  const inviteMutation = trpc.workspace.invite.useMutation();
  const updateRoleMutation = trpc.workspace.updateMemberRole.useMutation();
  const removeMemberMutation = trpc.workspace.removeMember.useMutation();
  const revokeInviteMutation = trpc.workspace.revokeInvite.useMutation();

  // Invite form state
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"ADMIN" | "MEMBER" | "VIEWER">("MEMBER");
  const [inviteDays, setInviteDays] = useState(7);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [copiedInviteId, setCopiedInviteId] = useState<string | null>(null);

  const handleSendInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspaceId || !inviteEmail.trim()) return;
    setInviteError(null);
    setInviteSuccess(null);

    try {
      const res = await inviteMutation.mutateAsync({
        workspaceId,
        email: inviteEmail.trim(),
        role: inviteRole,
        expiresInDays: inviteDays,
      });
      setInviteSuccess(`Invitation successfully generated for ${inviteEmail}! Token: ${res.token}`);
      setInviteEmail("");
      await refetchInvites();
    } catch (err: any) {
      setInviteError(err.message || "Failed to send invitation. Verify you have OWNER or ADMIN role.");
    }
  };

  const handleUpdateRole = async (userId: string, newRole: WorkspaceRole) => {
    if (!workspaceId) return;
    try {
      await updateRoleMutation.mutateAsync({
        workspaceId,
        userId,
        role: newRole,
      });
      await refetchWorkspaces();
    } catch (err: any) {
      alert(`Failed to update role: ${err.message}`);
    }
  };

  const handleRemoveMember = async (userId: string, name: string) => {
    if (!workspaceId) return;
    if (!confirm(`Are you sure you want to remove ${name} from ${activeWorkspace?.name}?`)) return;

    try {
      await removeMemberMutation.mutateAsync({
        workspaceId,
        userId,
      });
      await refetchWorkspaces();
    } catch (err: any) {
      alert(`Failed to remove member: ${err.message}`);
    }
  };

  const handleRevokeInvite = async (inviteId: string) => {
    if (!confirm("Are you sure you want to revoke this invitation?")) return;
    try {
      await revokeInviteMutation.mutateAsync({ inviteId });
      await refetchInvites();
    } catch (err: any) {
      alert(`Failed to revoke invitation: ${err.message}`);
    }
  };

  const copyInviteLink = (token: string, inviteId: string) => {
    const link = `${window.location.origin}/invite/${token}`;
    navigator.clipboard.writeText(link);
    setCopiedInviteId(inviteId);
    setTimeout(() => setCopiedInviteId(null), 2500);
  };

  return (
    <div className="fade-in" style={{ maxWidth: "960px", margin: "0 auto" }}>
      {/* ── Page Header ── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Team Members</h1>
          <p className="page-subtitle">
            Manage roles, collaborator permissions, and pending workspace invites.
          </p>
        </div>

        {/* Workspace selector */}
        {workspaces && workspaces.length > 1 && (
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>Workspace:</span>
            <select
              className="input"
              style={{ width: "auto", padding: "6px 12px", fontSize: "0.875rem" }}
              value={selectedWsId || activeWorkspace?.id}
              onChange={(e) => {
                setSelectedWsId(e.target.value);
                dashboard?.setCurrentWorkspaceId(e.target.value);
              }}
            >
              {workspaces.map((ws) => (
                <option key={ws.id} value={ws.id}>
                  {ws.name} ({ws.slug})
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* ── Members Roster ── */}
      <div className="card" style={{ marginBottom: "28px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <div>
            <h3 style={{ marginBottom: "4px" }}>Active Members</h3>
            <p style={{ fontSize: "0.8125rem" }}>
              {activeWorkspace?.members?.length || 0} member{activeWorkspace?.members?.length !== 1 ? "s" : ""} in {activeWorkspace?.name}
            </p>
          </div>
        </div>

        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Joined</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {activeWorkspace?.members?.map((m: any) => {
                const roleClass =
                  m.role === "OWNER"
                    ? "badge-sleeping"
                    : m.role === "ADMIN"
                    ? "badge-building"
                    : m.role === "MEMBER"
                    ? "badge-active"
                    : "badge-queued";

                const isSelf = m.userId === dashboard?.user?.id;

                return (
                  <tr key={m.id}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                        <div
                          style={{
                            width: "32px",
                            height: "32px",
                            borderRadius: "50%",
                            background: "linear-gradient(135deg, var(--brand-primary), var(--brand-secondary))",
                            display: "grid",
                            placeItems: "center",
                            fontSize: "13px",
                            fontWeight: 700,
                            color: "#fff",
                            flexShrink: 0,
                          }}
                        >
                          {m.user?.name?.slice(0, 1).toUpperCase() || m.user?.email?.slice(0, 1).toUpperCase() || "U"}
                        </div>
                        <div>
                          <div style={{ fontWeight: 600, color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "6px" }}>
                            <span>{m.user?.name || "Team Member"}</span>
                            {isSelf && (
                              <span style={{ fontSize: "0.7rem", color: "var(--brand-primary)", fontWeight: 500 }}>
                                (You)
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                            {m.user?.email}
                          </div>
                        </div>
                      </div>
                    </td>

                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span className={`badge ${roleClass}`} style={{ fontSize: "0.75rem" }}>
                          {m.role}
                        </span>

                        {canManageMembers && !isSelf && (m.role !== "OWNER" || isOwner) && (
                          <select
                            className="input"
                            style={{
                              width: "auto",
                              padding: "2px 6px",
                              fontSize: "0.75rem",
                              height: "auto",
                            }}
                            value={m.role}
                            onChange={(e) => handleUpdateRole(m.userId, e.target.value as WorkspaceRole)}
                          >
                            {isOwner && <option value="OWNER">OWNER</option>}
                            <option value="ADMIN">ADMIN</option>
                            <option value="MEMBER">MEMBER</option>
                            <option value="VIEWER">VIEWER</option>
                          </select>
                        )}
                      </div>
                    </td>

                    <td style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>
                      {new Date(m.joinedAt).toLocaleDateString()}
                    </td>

                    <td style={{ textAlign: "right" }}>
                      {!isSelf && canManageMembers && (m.role !== "OWNER" || isOwner) && (
                        <button
                          onClick={() => handleRemoveMember(m.userId, m.user?.name || m.user?.email || "member")}
                          className="btn btn-danger btn-sm"
                          disabled={removeMemberMutation.isPending}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Invite Member Form ── */}
      <div className="card" style={{ marginBottom: "28px" }}>
        <h3 style={{ marginBottom: "6px" }}>Invite New Member</h3>
        <p style={{ fontSize: "0.875rem", marginBottom: "20px" }}>
          Send an invitation to collaborate in {activeWorkspace?.name}. Invitations expire after the configured duration.
        </p>

        {inviteSuccess && (
          <div
            style={{
              padding: "10px 14px",
              borderRadius: "var(--radius-md)",
              background: "rgba(34,197,94,0.15)",
              border: "1px solid rgba(34,197,94,0.3)",
              color: "#4ade80",
              fontSize: "0.8125rem",
              marginBottom: "16px",
            }}
          >
            {inviteSuccess}
          </div>
        )}

        {inviteError && (
          <div
            style={{
              padding: "10px 14px",
              borderRadius: "var(--radius-md)",
              background: "rgba(239,68,68,0.15)",
              border: "1px solid rgba(239,68,68,0.3)",
              color: "#f87171",
              fontSize: "0.8125rem",
              marginBottom: "16px",
            }}
          >
            {inviteError}
          </div>
        )}

        <form onSubmit={handleSendInvite}>
          <div className="grid-3" style={{ gap: "16px", marginBottom: "16px" }}>
            <div className="field" style={{ gridColumn: "span 1" }}>
              <label>Collaborator Email</label>
              <input
                type="email"
                className="input"
                placeholder="colleague@example.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                required
              />
            </div>

            <div className="field">
              <label>Role</label>
              <select
                className="input"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as "ADMIN" | "MEMBER" | "VIEWER")}
              >
                <option value="ADMIN">ADMIN — Full management of team, services &amp; deployments</option>
                <option value="MEMBER">MEMBER — Deploy &amp; manage services</option>
                <option value="VIEWER">VIEWER — Read-only access to metrics &amp; logs</option>
              </select>
            </div>

            <div className="field">
              <label>Expires In</label>
              <select
                className="input"
                value={inviteDays}
                onChange={(e) => setInviteDays(parseInt(e.target.value, 10))}
              >
                <option value={1}>24 hours (1 day)</option>
                <option value={7}>7 days (1 week)</option>
                <option value={14}>14 days (2 weeks)</option>
                <option value={30}>30 days (1 month)</option>
              </select>
            </div>
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            disabled={inviteMutation.isPending || !inviteEmail.trim()}
          >
            {inviteMutation.isPending ? "Sending..." : "Send Invitation"}
          </button>
        </form>
      </div>

      {/* ── Pending Invitations ── */}
      <div className="card">
        <h3 style={{ marginBottom: "6px" }}>Pending Invitations</h3>
        <p style={{ fontSize: "0.875rem", marginBottom: "16px" }}>
          Invitations awaiting acceptance by recipients.
        </p>

        {invitesLoading ? (
          <div style={{ textAlign: "center", padding: "32px" }}>
            <div className="loading-bar" style={{ width: "160px", margin: "0 auto 12px" }} />
            <p style={{ color: "var(--text-muted)", fontSize: "0.8125rem" }}>Loading invites...</p>
          </div>
        ) : invites?.length === 0 ? (
          <div className="empty-state" style={{ padding: "32px 16px" }}>
            <div style={{ fontSize: "24px", marginBottom: "8px" }}>✉️</div>
            <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>
              No pending invitations for this workspace.
            </p>
          </div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Recipient Email</th>
                  <th>Assigned Role</th>
                  <th>Expires</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {invites?.map((inv) => (
                  <tr key={inv.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{inv.email || "Open Invitation"}</div>
                      <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                        Token: <code style={{ color: "var(--brand-accent)" }}>{inv.token.slice(0, 10)}...</code>
                      </div>
                    </td>

                    <td>
                      <span
                        className={`badge ${inv.role === "MEMBER" ? "badge-active" : "badge-queued"}`}
                        style={{ fontSize: "0.6875rem" }}
                      >
                        {inv.role}
                      </span>
                    </td>

                    <td style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>
                      {new Date(inv.expiresAt).toLocaleDateString()}
                    </td>

                    <td style={{ textAlign: "right" }}>
                      <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                        <button
                          onClick={() => copyInviteLink(inv.token, inv.id)}
                          className="btn btn-secondary btn-sm"
                        >
                          {copiedInviteId === inv.id ? "Copied! ✓" : "Copy Link"}
                        </button>
                        <button
                          onClick={() => handleRevokeInvite(inv.id)}
                          className="btn btn-danger btn-sm"
                          disabled={revokeInviteMutation.isPending}
                        >
                          Revoke
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
