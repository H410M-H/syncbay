"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { ToastStack, useToasts } from "@/components/ui/toast";
import { ReasonDialog } from "@/components/admin/reason-dialog";
import { QueryState } from "@/components/admin/query-state";
import { useStaff } from "@/components/admin/staff-context";
import { useActionDialog } from "@/components/admin/use-action-dialog";
import { errorMessage, formatDateTime, humanize, reportStatusBadgeClass } from "@/components/admin/format";
import { abuseCategoryLabel, NCMEC_REPORT_URL } from "@/components/admin/abuse-categories";
import { REPORT_STATUSES, type ReportRow, type ReportStatus } from "@/components/admin/types";
import styles from "@/components/admin/admin.module.css";

type ResolveAction = "DISMISS" | "NOTE_ONLY" | "TAKEDOWN_SERVICE" | "SUSPEND_WORKSPACE";

interface DialogTarget {
  report: ReportRow;
  action: ResolveAction;
  /** Name to type for take-down (service name) and suspend (workspace slug). */
  confirmText?: string;
}

const ACTION_COPY: Record<ResolveAction, { title: string; description: string; label: string; danger: boolean }> = {
  DISMISS: { title: "Dismiss this report?", description: "No action is taken against the customer. The report is closed as dismissed.", label: "Dismiss", danger: false },
  NOTE_ONLY: {
    title: "Close with a note only?",
    description: "The report is closed as actioned with your note; nothing is stopped.",
    label: "Close with note",
    danger: false,
  },
  TAKEDOWN_SERVICE: {
    title: "Take down the reported service?",
    description: "The service is stopped and locked until staff restore it. The report is closed as actioned.",
    label: "Take down service",
    danger: true,
  },
  SUSPEND_WORKSPACE: {
    title: "Suspend the reported workspace?",
    description: "Every service in the workspace is stopped and nothing can deploy or wake until the suspension is lifted. The report is closed as actioned.",
    label: "Suspend workspace",
    danger: true,
  },
};

const PRIORITY_BADGE = ["badge badge-failed", "badge badge-building", "badge badge-queued", "badge badge-queued"];

function ModerationQueue() {
  const params = useSearchParams();
  const initialStatus = params.get("status");
  const staff = useStaff();
  const utils = trpc.useUtils();
  const [status, setStatus] = useState<ReportStatus | "">(REPORT_STATUSES.includes(initialStatus as ReportStatus) ? (initialStatus as ReportStatus) : "");
  const [mine, setMine] = useState(false);
  const [preparing, setPreparing] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);
  const { toasts, push, dismiss } = useToasts();
  const dialog = useActionDialog<DialogTarget>();

  const query = trpc.admin.reports.useQuery({ status: status || undefined, mine: mine || undefined });
  const reports = (query.data ?? []) as ReportRow[];
  const assign = trpc.admin.assignReport.useMutation();
  const resolve = trpc.admin.resolveReport.useMutation();

  const canAssign = staff.can("moderation.report.assign");
  const canResolve = staff.can("moderation.report.resolve");
  const canTakedown = staff.can("service.takedown");
  const canSuspend = staff.can("workspace.suspend");

  const onAssign = async (report: ReportRow) => {
    setAssigning(report.id);
    try {
      await assign.mutateAsync({ reportId: report.id, assigneeId: "me" });
      push("success", "Assigned to you");
      await utils.admin.reports.invalidate();
    } catch (err) {
      push("error", errorMessage(err, "Could not assign the report"));
    } finally {
      setAssigning(null);
    }
  };

  /** Opens the dialog; take-down and suspend first look up the name the API wants typed. */
  const openAction = async (report: ReportRow, action: ResolveAction) => {
    if (action === "DISMISS" || action === "NOTE_ONLY") return dialog.open({ report, action });
    if (action === "TAKEDOWN_SERVICE" && report.service?.name) return dialog.open({ report, action, confirmText: report.service.name });
    if (!report.workspaceId) {
      push("error", "This report is not linked to a workspace");
      return;
    }
    setPreparing(`${report.id}:${action}`);
    try {
      const ws = await utils.admin.workspace.fetch({ id: report.workspaceId });
      const confirmText =
        action === "SUSPEND_WORKSPACE"
          ? ws.slug
          : ws.projects.flatMap((p) => p.environments.flatMap((e) => e.services)).find((s) => s.id === report.serviceId)?.name;
      if (!confirmText) {
        push("error", "Could not find the linked service");
        return;
      }
      dialog.open({ report, action, confirmText });
    } catch (err) {
      push("error", errorMessage(err, "Could not load the linked workspace"));
    } finally {
      setPreparing(null);
    }
  };

  const target = dialog.target;
  const copy = target ? ACTION_COPY[target.action] : null;

  return (
    <div className="fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Moderation</h1>
          <p className="page-subtitle">Abuse reports, most urgent first. Reported URLs are shown as text, not links.</p>
        </div>
      </div>

      <div className={styles.toolbar}>
        <div className="field">
          <label htmlFor="report-status">Status</label>
          <select id="report-status" className="input" value={status} onChange={(e) => setStatus(e.target.value as ReportStatus | "")}>
            <option value="">Open and in review</option>
            {REPORT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </select>
        </div>
        <label className={styles.row} style={{ fontSize: "0.875rem", cursor: "pointer", paddingBottom: "10px" }}>
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Assigned to me
        </label>
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} label="reports" />
      {query.data && reports.length === 0 && <div className={`card ${styles.empty}`}>The queue is empty.</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {reports.map((r) => {
          const open = r.status === "OPEN" || r.status === "IN_REVIEW";
          const isPreparing = (a: ResolveAction) => preparing === `${r.id}:${a}`;
          return (
            <article key={r.id} className="card" aria-labelledby={`report-${r.id}`}>
              <div className={styles.row} style={{ justifyContent: "space-between", marginBottom: "8px" }}>
                <div className={styles.row}>
                  <span className={PRIORITY_BADGE[r.priority] ?? "badge badge-queued"}>P{r.priority}</span>
                  <h2 id={`report-${r.id}`} style={{ fontSize: "0.95rem", margin: 0 }}>
                    {abuseCategoryLabel(r.category)}
                  </h2>
                  <span className={reportStatusBadgeClass(r.status)}>{humanize(r.status)}</span>
                </div>
                <span className={styles.muted}>
                  {formatDateTime(r.createdAt)} · <span className={styles.mono}>{r.id}</span>
                </span>
              </div>

              {r.category === "CSAM" && (
                <div className={styles.callout} style={{ marginBottom: "10px" }}>
                  CSAM: do not view or download the content. Preserve the report and file a CyberTipline report with NCMEC ({NCMEC_REPORT_URL}) as required.
                </div>
              )}

              <dl style={{ display: "grid", gridTemplateColumns: "minmax(90px, max-content) minmax(0, 1fr)", gap: "6px 12px", margin: "0 0 10px", fontSize: "0.875rem" }}>
                <dt className={styles.muted}>URL</dt>
                <dd style={{ margin: 0 }}>
                  <code className={styles.mono}>{r.url ?? "—"}</code>
                </dd>
                <dt className={styles.muted}>Service</dt>
                <dd style={{ margin: 0 }}>
                  {r.service ? (
                    <span className={styles.row}>
                      {r.service.name}
                      {r.service.moderationLockedAt && <span className="badge badge-failed">Taken down</span>}
                    </span>
                  ) : (
                    <span className={styles.muted}>Not linked{r.targetHost ? ` (${r.targetHost})` : ""}</span>
                  )}
                </dd>
                <dt className={styles.muted}>Workspace</dt>
                <dd style={{ margin: 0 }}>
                  {r.workspaceId ? <Link href={`/admin/workspaces/${r.workspaceId}`}>Open customer 360</Link> : <span className={styles.muted}>Not linked</span>}
                </dd>
                <dt className={styles.muted}>Reporter</dt>
                <dd style={{ margin: 0 }}>{r.reporterEmail ?? <span className={styles.muted}>anonymous</span>}</dd>
                <dt className={styles.muted}>Assignee</dt>
                <dd style={{ margin: 0 }}>{r.assigneeId ? (r.assigneeId === staff.userId ? "You" : <span className={styles.mono}>{r.assigneeId}</span>) : <span className={styles.muted}>Unassigned</span>}</dd>
                {r.resolution && (
                  <>
                    <dt className={styles.muted}>Resolution</dt>
                    <dd style={{ margin: 0 }}>
                      {r.resolution}
                      {r.resolvedAt ? <span className={styles.muted}> · {formatDateTime(r.resolvedAt)}</span> : null}
                    </dd>
                  </>
                )}
              </dl>

              <div className={styles.preWrap} style={{ padding: "10px 12px", borderRadius: "var(--radius-md)", background: "var(--bg-overlay)", fontSize: "0.875rem", marginBottom: "12px" }}>
                {r.description}
              </div>

              {open && (
                <div className={styles.actions}>
                  {canAssign && r.assigneeId !== staff.userId && (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => void onAssign(r)} disabled={assigning === r.id}>
                      {assigning === r.id ? "Assigning…" : "Assign to me"}
                    </button>
                  )}
                  {canResolve && (
                    <>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openAction(r, "DISMISS")}>
                        Dismiss
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openAction(r, "NOTE_ONLY")}>
                        Note only
                      </button>
                      {canTakedown && r.serviceId && !r.service?.moderationLockedAt && (
                        <button type="button" className="btn btn-danger btn-sm" onClick={() => void openAction(r, "TAKEDOWN_SERVICE")} disabled={isPreparing("TAKEDOWN_SERVICE")}>
                          {isPreparing("TAKEDOWN_SERVICE") ? "Loading…" : "Take down service"}
                        </button>
                      )}
                      {canSuspend && r.workspaceId && (
                        <button type="button" className="btn btn-danger btn-sm" onClick={() => void openAction(r, "SUSPEND_WORKSPACE")} disabled={isPreparing("SUSPEND_WORKSPACE")}>
                          {isPreparing("SUSPEND_WORKSPACE") ? "Loading…" : "Suspend workspace"}
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>

      {target && copy && (
        <ReasonDialog
          open
          title={copy.title}
          description={copy.description}
          confirmLabel={copy.label}
          danger={copy.danger}
          requireText={target.confirmText}
          busy={dialog.busy}
          error={dialog.error}
          onCancel={dialog.close}
          onConfirm={({ reason, confirm }) => {
            void dialog.run(async () => {
              const res = await resolve.mutateAsync({ reportId: target.report.id, action: target.action, reason, confirm: target.confirmText ? confirm : undefined });
              push("success", `Report ${humanize(res.status).toLowerCase()}`);
              await Promise.all([utils.admin.reports.invalidate(), target.report.workspaceId ? utils.admin.workspace.invalidate({ id: target.report.workspaceId }) : null]);
            });
          }}
        />
      )}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

export default function AdminModerationPage() {
  return (
    <Suspense fallback={null}>
      <ModerationQueue />
    </Suspense>
  );
}
