"use client";

import Link from "next/link";
import { useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { QueryState } from "@/components/admin/query-state";
import { useStaff } from "@/components/admin/staff-context";
import { formatDateTime, humanize, outcomeBadgeClass } from "@/components/admin/format";
import { AUDIT_OUTCOMES, type AuditOutcome, type AuditRow } from "@/components/admin/types";
import styles from "@/components/admin/admin.module.css";

export default function AdminAuditPage() {
  const staff = useStaff();
  const [outcome, setOutcome] = useState<AuditOutcome | "">("");
  const allowed = staff.can("audit.read_own");

  const query = trpc.admin.audit.useInfiniteQuery(
    { outcome: outcome || undefined },
    { enabled: allowed, getNextPageParam: (last) => last.nextCursor ?? undefined }
  );
  const rows = (query.data?.pages.flatMap((p) => p.items) ?? []) as AuditRow[];
  const scope = query.data?.pages[0]?.scope;

  if (!allowed) {
    return <div className={`card ${styles.empty}`}>Your role cannot read the staff audit log.</div>;
  }

  return (
    <div className="fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Audit log</h1>
          <p className="page-subtitle">
            {scope === "own" ? "Your own staff actions (allowed, denied and failed)." : "Every staff action: allowed, denied and failed. The log is append-only."}
          </p>
        </div>
      </div>

      <div className={styles.toolbar}>
        <div className="field">
          <label htmlFor="audit-outcome">Outcome</label>
          <select id="audit-outcome" className="input" value={outcome} onChange={(e) => setOutcome(e.target.value as AuditOutcome | "")}>
            <option value="">All outcomes</option>
            {AUDIT_OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {humanize(o)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} label="the audit log" />

      {query.data && (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
                <th scope="col">Outcome</th>
                <th scope="col">Target</th>
                <th scope="col">Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className={styles.empty}>
                    No events.
                  </td>
                </tr>
              )}
              {rows.map((e) => (
                <tr key={e.id}>
                  <td className={`${styles.secondary} ${styles.cellNowrap}`}>{formatDateTime(e.createdAt)}</td>
                  <td>
                    <div style={{ wordBreak: "break-all" }}>{e.actorEmail ?? (e.actorUserId ? <span className={styles.mono}>{e.actorUserId}</span> : "system")}</div>
                    {e.actorRole && <div className={styles.muted}>{humanize(e.actorRole)}</div>}
                  </td>
                  <td>
                    <span className={styles.mono}>{e.action}</span>
                    {e.permission && e.permission !== e.action && <div className={styles.muted}>{e.permission}</div>}
                  </td>
                  <td>
                    <span className={outcomeBadgeClass(e.outcome)}>{humanize(e.outcome)}</span>
                  </td>
                  <td>
                    {e.targetType ? (
                      <div>
                        <span className={styles.secondary}>{e.targetType}</span>{" "}
                        {e.targetType === "workspace" && e.targetId ? (
                          <Link href={`/admin/workspaces/${e.targetId}`} className={styles.mono}>
                            {e.targetId}
                          </Link>
                        ) : (
                          <span className={styles.mono}>{e.targetId}</span>
                        )}
                      </div>
                    ) : (
                      <span className={styles.muted}>—</span>
                    )}
                    {e.workspaceId && e.targetType !== "workspace" && (
                      <Link href={`/admin/workspaces/${e.workspaceId}`} className={styles.muted}>
                        workspace
                      </Link>
                    )}
                  </td>
                  <td className={styles.preWrap} style={{ maxWidth: "320px" }}>
                    {e.reason ?? <span className={styles.muted}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {query.hasNextPage && (
        <div style={{ marginTop: "16px", textAlign: "center" }}>
          <button type="button" className="btn btn-secondary" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
