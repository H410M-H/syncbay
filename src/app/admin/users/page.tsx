"use client";

import Link from "next/link";
import { Suspense, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { ROLE_RANK } from "@/lib/admin/permissions";
import { ToastStack, useToasts } from "@/components/ui/toast";
import { ReasonDialog } from "@/components/admin/reason-dialog";
import { QueryState } from "@/components/admin/query-state";
import { useStaff } from "@/components/admin/staff-context";
import { useActionDialog } from "@/components/admin/use-action-dialog";
import { formatDate, humanize, roleBadgeClass } from "@/components/admin/format";
import type { UserRow } from "@/components/admin/types";
import styles from "@/components/admin/admin.module.css";

function UsersList() {
  const params = useSearchParams();
  const staff = useStaff();
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState(params.get("q") ?? "");
  const [q, setQ] = useState(params.get("q") ?? "");
  const { toasts, push, dismiss } = useToasts();
  const dialog = useActionDialog<{ user: UserRow; suspend: boolean }>();
  const setSuspended = trpc.admin.setUserSuspended.useMutation();

  const query = trpc.admin.users.useInfiniteQuery({ q: q || undefined }, { getNextPageParam: (last) => last.nextCursor ?? undefined });
  const rows = (query.data?.pages.flatMap((p) => p.items) ?? []) as UserRow[];
  // The API checks `user.suspend` for both directions.
  const canSuspend = staff.can("user.suspend");

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    setQ(draft.trim());
  };

  /** Staff at or above the caller's own role cannot be suspended by them. */
  const mayActOn = (u: UserRow) => u.id !== staff.userId && (!u.staffRole || ROLE_RANK[u.staffRole] < ROLE_RANK[staff.role]);

  const target = dialog.target;

  return (
    <div className="fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Users</h1>
          <p className="page-subtitle">Search by email, name or user id.</p>
        </div>
      </div>

      <form className={styles.toolbar} onSubmit={onSearch} role="search">
        <div className={`field ${styles.grow}`}>
          <label htmlFor="user-search">Search</label>
          <input
            id="user-search"
            className="input"
            type="search"
            value={draft}
            maxLength={200}
            placeholder="someone@example.com"
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
        <button type="submit" className="btn btn-primary">
          Search
        </button>
        {q && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setDraft("");
              setQ("");
            }}
          >
            Clear
          </button>
        )}
      </form>

      <QueryState isLoading={query.isLoading} error={query.error} label="users" />

      {query.data && (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Name</th>
                <th scope="col">Sign-in</th>
                <th scope="col">Workspaces</th>
                <th scope="col">Staff</th>
                <th scope="col">Joined</th>
                <th scope="col">Status</th>
                {canSuspend && (
                  <th scope="col">
                    <span className={styles.srOnly}>Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={canSuspend ? 8 : 7} className={styles.empty}>
                    No users match.
                  </td>
                </tr>
              )}
              {rows.map((u) => (
                <tr key={u.id}>
                  <td style={{ wordBreak: "break-all" }}>{u.email}</td>
                  <td className={styles.secondary}>{u.name ?? "—"}</td>
                  <td className={styles.secondary}>{u.providers.length ? u.providers.join(", ") : "password"}</td>
                  <td>
                    {u.memberships.length ? (
                      <span className={styles.chips}>
                        {u.memberships.map((m) => (
                          <Link key={m.workspace.id} href={`/admin/workspaces/${m.workspace.id}`} className={styles.chip}>
                            {m.workspace.slug} <span className={styles.muted}>({humanize(m.role)})</span>
                          </Link>
                        ))}
                      </span>
                    ) : (
                      <span className={styles.muted}>—</span>
                    )}
                  </td>
                  <td>{u.staffRole ? <span className={roleBadgeClass(u.staffRole)}>{humanize(u.staffRole)}</span> : <span className={styles.muted}>—</span>}</td>
                  <td className={`${styles.secondary} ${styles.cellNowrap}`}>{formatDate(u.createdAt)}</td>
                  <td>{u.suspendedAt ? <span className="badge badge-failed">Suspended</span> : <span className="badge badge-active">Active</span>}</td>
                  {canSuspend && (
                    <td>
                      {mayActOn(u) &&
                        (u.suspendedAt ? (
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => dialog.open({ user: u, suspend: false })} aria-label={`Unsuspend ${u.email}`}>
                            Unsuspend
                          </button>
                        ) : (
                          <button type="button" className="btn btn-danger btn-sm" onClick={() => dialog.open({ user: u, suspend: true })} aria-label={`Suspend ${u.email}`}>
                            Suspend
                          </button>
                        ))}
                    </td>
                  )}
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

      <ReasonDialog
        open={target !== null}
        danger={target?.suspend ?? false}
        title={target ? `${target.suspend ? "Suspend" : "Unsuspend"} ${target.user.email}?` : ""}
        description={
          target?.suspend
            ? "Their sessions are refused within 30 seconds, their API tokens stop working and any staff access they hold is revoked. Their workspaces keep running."
            : "They can sign in again. Staff access is not restored."
        }
        requireText={target?.suspend ? target.user.email : undefined}
        confirmLabel={target?.suspend ? "Suspend user" : "Unsuspend user"}
        busy={dialog.busy}
        error={dialog.error}
        onCancel={dialog.close}
        onConfirm={({ reason, confirm }) => {
          if (!target) return;
          void dialog.run(async () => {
            await setSuspended.mutateAsync({ userId: target.user.id, suspended: target.suspend, reason, confirm: target.suspend ? confirm : undefined });
            push("success", `${target.suspend ? "Suspended" : "Unsuspended"} ${target.user.email}`);
            await utils.admin.users.invalidate();
          });
        }}
      />
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

export default function AdminUsersPage() {
  return (
    <Suspense fallback={null}>
      <UsersList />
    </Suspense>
  );
}
