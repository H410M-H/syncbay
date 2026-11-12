"use client";

import Link from "next/link";
import { Suspense, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { QueryState } from "@/components/admin/query-state";
import { formatDate, humanize } from "@/components/admin/format";
import type { WorkspaceRow } from "@/components/admin/types";
import styles from "@/components/admin/admin.module.css";

type Filter = "all" | "suspended" | "paying";
const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "suspended", label: "Suspended" },
  { value: "paying", label: "Paying" },
];

function WorkspacesList() {
  const params = useSearchParams();
  const initialFilter = params.get("filter");
  const [draft, setDraft] = useState(params.get("q") ?? "");
  const [q, setQ] = useState(params.get("q") ?? "");
  const [filter, setFilter] = useState<Filter>(initialFilter === "suspended" || initialFilter === "paying" ? initialFilter : "all");

  const query = trpc.admin.workspaces.useInfiniteQuery(
    { q: q || undefined, filter },
    { getNextPageParam: (last) => last.nextCursor ?? undefined }
  );
  const rows = (query.data?.pages.flatMap((p) => p.items) ?? []) as WorkspaceRow[];

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    setQ(draft.trim());
  };

  return (
    <div className="fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Workspaces</h1>
          <p className="page-subtitle">Find a customer by email, workspace slug, hostname or Stripe customer id.</p>
        </div>
      </div>

      <form className={styles.toolbar} onSubmit={onSearch} role="search">
        <div className={`field ${styles.grow}`}>
          <label htmlFor="ws-search">Search</label>
          <input
            id="ws-search"
            className="input"
            type="search"
            value={draft}
            maxLength={200}
            placeholder="owner@example.com, acme, app.example.com, cus_…"
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="ws-filter">Show</label>
          <select id="ws-filter" className="input" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
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

      <QueryState isLoading={query.isLoading} error={query.error} label="workspaces" />

      {query.data && (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th scope="col">Workspace</th>
                <th scope="col">Owner</th>
                <th scope="col">Created</th>
                <th scope="col">Lifecycle</th>
                <th scope="col">Tags</th>
                <th scope="col">Status</th>
                <th scope="col">Members</th>
                <th scope="col">Projects</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className={styles.empty}>
                    No workspaces match.
                  </td>
                </tr>
              )}
              {rows.map((w) => (
                <tr key={w.id}>
                  <td>
                    <Link href={`/admin/workspaces/${w.id}`} style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                      {w.name}
                    </Link>
                    <div className={styles.muted}>
                      {w.slug}
                      {w.isPersonal ? " · personal" : ""}
                    </div>
                  </td>
                  <td className={styles.secondary}>{w.ownerEmail ?? "—"}</td>
                  <td className={`${styles.secondary} ${styles.cellNowrap}`}>{formatDate(w.createdAt)}</td>
                  <td className={styles.secondary}>{w.lifecycleStage ? humanize(w.lifecycleStage) : "—"}</td>
                  <td>
                    {w.staffTags.length ? (
                      <span className={styles.chips}>
                        {w.staffTags.map((t) => (
                          <span key={t} className={styles.chip}>
                            {t}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className={styles.muted}>—</span>
                    )}
                  </td>
                  <td>{w.suspendedAt ? <span className="badge badge-failed">Suspended</span> : <span className="badge badge-active">Active</span>}</td>
                  <td>{w._count.members}</td>
                  <td>{w._count.projects}</td>
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

export default function AdminWorkspacesPage() {
  return (
    <Suspense fallback={null}>
      <WorkspacesList />
    </Suspense>
  );
}
