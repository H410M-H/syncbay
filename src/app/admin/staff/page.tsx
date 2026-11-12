"use client";

import { useState, type FormEvent } from "react";
import { trpc } from "@/lib/trpc-client";
import { PRIVILEGED_ROLES, ROLE_RANK, STAFF_ROLES, type StaffRoleName } from "@/lib/admin/permissions";
import { ToastStack, useToasts } from "@/components/ui/toast";
import { ReasonDialog, MIN_REASON_LENGTH } from "@/components/admin/reason-dialog";
import { QueryState } from "@/components/admin/query-state";
import { useStaff } from "@/components/admin/staff-context";
import { useActionDialog } from "@/components/admin/use-action-dialog";
import { errorMessage, formatDate, humanize, roleBadgeClass } from "@/components/admin/format";
import type { StaffRow } from "@/components/admin/types";
import styles from "@/components/admin/admin.module.css";

export default function AdminStaffPage() {
  const staff = useStaff();
  const utils = trpc.useUtils();
  const allowed = staff.can("staff.read");
  const query = trpc.admin.staff.useQuery(undefined, { enabled: allowed });
  const rows = (query.data ?? []) as StaffRow[];
  const { toasts, push, dismiss } = useToasts();
  const revokeDialog = useActionDialog<StaffRow>();
  const revoke = trpc.admin.revokeStaff.useMutation();

  /** Pinned super admins, yourself and (unless you are a super admin) admins cannot be revoked here. */
  const mayRevoke = (m: StaffRow) =>
    staff.can("staff.revoke") && !m.revokedAt && !m.pinned && m.user.id !== staff.userId && (!PRIVILEGED_ROLES.includes(m.role) || staff.role === "SUPER_ADMIN");

  if (!allowed) {
    return <div className={`card ${styles.empty}`}>Your role cannot manage staff.</div>;
  }

  const target = revokeDialog.target;

  return (
    <div className="fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Staff</h1>
          <p className="page-subtitle">Who can use this console, and with which role.</p>
        </div>
      </div>

      {staff.can("staff.grant") && (
        <GrantForm
          callerRole={staff.role}
          onGranted={async (email, role) => {
            push("success", `${email} is now ${humanize(role)}`);
            await utils.admin.staff.invalidate();
          }}
        />
      )}

      <QueryState isLoading={query.isLoading} error={query.error} label="staff" />

      {query.data && (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col">Role</th>
                <th scope="col">Granted</th>
                <th scope="col">Status</th>
                <th scope="col">Note</th>
                <th scope="col">
                  <span className={styles.srOnly}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} style={m.revokedAt ? { opacity: 0.6 } : undefined}>
                  <td>
                    <div style={{ wordBreak: "break-all" }}>{m.user.email}</div>
                    {m.user.name && <div className={styles.muted}>{m.user.name}</div>}
                  </td>
                  <td>
                    <span className={styles.row}>
                      <span className={roleBadgeClass(m.role)}>{humanize(m.role)}</span>
                      {m.pinned && (
                        <span className={styles.chip} title="Set by SUPER_ADMIN_EMAILS; cannot be changed here">
                          pinned
                        </span>
                      )}
                    </span>
                  </td>
                  <td className={`${styles.secondary} ${styles.cellNowrap}`}>{formatDate(m.createdAt)}</td>
                  <td>{m.revokedAt ? <span className="badge badge-queued">Revoked {formatDate(m.revokedAt)}</span> : <span className="badge badge-active">Active</span>}</td>
                  <td className={styles.secondary} style={{ maxWidth: "280px" }}>
                    {m.note ?? "—"}
                  </td>
                  <td>
                    {mayRevoke(m) && (
                      <button type="button" className="btn btn-danger btn-sm" onClick={() => revokeDialog.open(m)} aria-label={`Revoke staff access of ${m.user.email}`}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ReasonDialog
        open={target !== null}
        danger
        title={target ? `Revoke staff access of ${target.user.email}?` : ""}
        description="Their console access ends with their next request. Their customer account is not affected."
        requireText={target?.user.email ?? ""}
        confirmLabel="Revoke access"
        busy={revokeDialog.busy}
        error={revokeDialog.error}
        onCancel={revokeDialog.close}
        onConfirm={({ reason, confirm }) => {
          if (!target) return;
          void revokeDialog.run(async () => {
            await revoke.mutateAsync({ userId: target.user.id, reason, confirm });
            push("success", `Revoked staff access of ${target.user.email}`);
            await utils.admin.staff.invalidate();
          });
        }}
      />
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

function GrantForm({ callerRole, onGranted }: { callerRole: StaffRoleName; onGranted: (email: string, role: StaffRoleName) => Promise<void> }) {
  // Never above your own role; ADMIN and SUPER_ADMIN only for super admins.
  const grantable = STAFF_ROLES.filter((r) => ROLE_RANK[r] <= ROLE_RANK[callerRole] && (!PRIVILEGED_ROLES.includes(r) || callerRole === "SUPER_ADMIN"));
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<StaffRoleName>(grantable.includes("VIEWER") ? "VIEWER" : grantable[grantable.length - 1]);
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const grant = trpc.admin.grantStaff.useMutation();

  const privileged = PRIVILEGED_ROLES.includes(role);
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const reasonOk = reason.trim().length >= MIN_REASON_LENGTH;
  const confirmOk = !privileged || confirm.trim().toLowerCase() === email.trim().toLowerCase();
  const canSubmit = emailOk && reasonOk && confirmOk && !grant.isPending;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    const target = email.trim().toLowerCase();
    try {
      await grant.mutateAsync({ email: target, role, reason: reason.trim(), confirm: privileged ? confirm.trim() : undefined });
      setEmail("");
      setReason("");
      setConfirm("");
      await onGranted(target, role);
    } catch (err) {
      setError(errorMessage(err, "Could not grant the role"));
    }
  };

  return (
    <section className={`card ${styles.section}`} aria-labelledby="grant-title">
      <h2 id="grant-title" className={styles.sectionTitle}>
        Grant or change a role
      </h2>
      <p className={styles.muted} style={{ marginBottom: "12px" }}>
        The person must have signed in to Syncbay once. Granting a role to an existing staff member replaces their role.
      </p>
      <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <div className={styles.toolbar} style={{ marginBottom: 0 }}>
          <div className={`field ${styles.grow}`}>
            <label htmlFor="grant-email">Email</label>
            <input id="grant-email" className="input" type="email" autoComplete="off" value={email} maxLength={200} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="grant-role">Role</label>
            <select id="grant-role" className="input" value={role} onChange={(e) => setRole(e.target.value as StaffRoleName)}>
              {grantable.map((r) => (
                <option key={r} value={r}>
                  {humanize(r)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="grant-reason">Reason (recorded in the staff audit log)</label>
          <textarea
            id="grant-reason"
            className="input"
            rows={2}
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-describedby="grant-reason-hint"
            style={{ resize: "vertical" }}
          />
          <span id="grant-reason-hint" className="field-hint">
            At least {MIN_REASON_LENGTH} characters.
          </span>
        </div>
        {privileged && (
          <div className="field">
            <label htmlFor="grant-confirm">
              {humanize(role)} is a privileged role. Type the email again to confirm
            </label>
            <input id="grant-confirm" className="input" autoComplete="off" spellCheck={false} value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={email || "email"} />
          </div>
        )}
        {error && (
          <div role="alert" className={styles.callout}>
            {error}
          </div>
        )}
        <div>
          <button type="submit" className={privileged ? "btn btn-danger" : "btn btn-primary"} disabled={!canSubmit}>
            {grant.isPending ? "Granting…" : `Grant ${humanize(role)}`}
          </button>
        </div>
      </form>
    </section>
  );
}
