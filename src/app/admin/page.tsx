"use client";

import Link from "next/link";
import { trpc } from "@/lib/trpc-client";
import { formatCount, formatPercent, timeAgo, useNow } from "@/components/analytics/format";
import { QueryState } from "@/components/admin/query-state";
import { dollars, formatDateTime } from "@/components/admin/format";
import type { ActivityItem, RecentFailure } from "@/components/admin/types";
import styles from "@/components/admin/admin.module.css";

const ACTIVITY_BADGE: Record<string, string> = {
  workspace: "badge badge-queued",
  deploy: "badge badge-building",
  signup: "badge badge-active",
  staff: "badge badge-sleeping",
};

function Stat({ label, value, hint, href, tone }: { label: string; value: string; hint?: string; href?: string; tone?: "warn" | "bad" }) {
  const color = tone === "bad" ? "#f87171" : tone === "warn" ? "#fbbf24" : undefined;
  const body = (
    <>
      <span className="stat-label">{label}</span>
      <span className="stat-value" style={color ? { color } : undefined}>
        {value}
      </span>
      {hint && <span className="stat-change">{hint}</span>}
    </>
  );
  return href ? (
    <Link href={href} className="stat-card" style={{ textDecoration: "none", color: "inherit" }}>
      {body}
    </Link>
  ) : (
    <div className="stat-card">{body}</div>
  );
}

export default function AdminOverviewPage() {
  const now = useNow(30_000);
  const overview = trpc.admin.overview.useQuery(undefined, { refetchInterval: 30_000 });
  const activity = trpc.admin.activity.useQuery({ limit: 40 }, { refetchInterval: 30_000 });
  const o = overview.data;
  const failures = (o?.recentFailures ?? []) as RecentFailure[];
  const feed = (activity.data ?? []) as ActivityItem[];

  return (
    <div className="fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Overview</h1>
          <p className="page-subtitle">Platform health, growth and the latest activity.</p>
        </div>
      </div>

      <QueryState isLoading={overview.isLoading} error={overview.error} label="the overview" />

      {o && (
        <>
          <div className={styles.statGrid}>
            <Stat label="Workspaces" value={formatCount(o.workspaces)} href="/admin/workspaces" />
            <Stat label="Suspended" value={formatCount(o.suspended)} tone={o.suspended ? "warn" : undefined} href="/admin/workspaces?filter=suspended" />
            <Stat label="Users" value={formatCount(o.users)} href="/admin/users" />
            <Stat label="New users (7d)" value={formatCount(o.newUsers7d)} />
            <Stat label="Live services" value={formatCount(o.liveServices)} />
            <Stat label="Deploys (24h)" value={formatCount(o.deploys24h)} hint={`${formatCount(o.failed24h)} failed`} />
            <Stat
              label="Failure rate (24h)"
              value={o.deploys24h ? formatPercent(o.failureRate24h * 100) : "—"}
              tone={o.failureRate24h > 0.25 ? "bad" : o.failureRate24h > 0.1 ? "warn" : undefined}
            />
            <Stat label="Open reports" value={formatCount(o.openReports)} tone={o.openReports ? "warn" : undefined} href="/admin/moderation" />
            <Stat label="Staff" value={formatCount(o.staff)} />
          </div>

          <div className="grid-2" style={{ marginBottom: "24px", alignItems: "start" }}>
            {o.revenue && (
              <section className="card" aria-labelledby="revenue-title">
                <h2 id="revenue-title" className={styles.sectionTitle}>
                  Revenue
                </h2>
                <div className={styles.statGrid} style={{ marginBottom: "12px" }}>
                  <div>
                    <div className="stat-label">MRR</div>
                    <div className="stat-value">{dollars(o.revenue.mrrCents)}</div>
                    <div className="stat-change">
                      {o.revenue.months.length ? `Average of the last ${o.revenue.months.length} billed month${o.revenue.months.length === 1 ? "" : "s"}` : "No billed months yet"}
                    </div>
                  </div>
                  <div>
                    <div className="stat-label">Month to date</div>
                    <div className="stat-value">{dollars(o.revenue.monthToDateCents)}</div>
                    <div className="stat-change">Estimate from metered usage</div>
                  </div>
                </div>
                {o.revenue.months.length > 0 && (
                  <ul className={styles.list} aria-label="Billed months">
                    {o.revenue.months.map((m) => (
                      <li key={m.month} className={styles.listItem}>
                        <span className={styles.secondary}>{m.month}</span>
                        <span>{dollars(m.cents)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            <section className="card" aria-labelledby="runner-title">
              <h2 id="runner-title" className={styles.sectionTitle}>
                Runner
              </h2>
              <div className={styles.row} style={{ marginBottom: "10px" }}>
                <span
                  className={
                    o.runner.problem ? "badge badge-failed" : o.runner.health?.online ? "badge badge-active" : o.runner.health ? "badge badge-failed" : "badge badge-queued"
                  }
                >
                  {o.runner.problem ? "Not configured" : o.runner.health?.online ? "Online" : o.runner.health ? "Offline" : "Unknown"}
                </span>
                <span className={styles.secondary}>
                  Mode <strong>{o.runner.mode}</strong>
                  {o.runner.host ? (
                    <>
                      {" "}
                      · <span className={styles.mono}>{o.runner.host}</span>
                    </>
                  ) : null}
                </span>
              </div>
              {o.runner.problem && (
                <div role="alert" className={styles.callout} style={{ marginBottom: "10px" }}>
                  {o.runner.problem}
                </div>
              )}
              {o.runner.health && (
                <ul className={styles.list}>
                  {o.runner.health.latencyMs !== undefined && (
                    <li className={styles.listItem}>
                      <span className={styles.secondary}>Latency</span>
                      <span>{o.runner.health.latencyMs} ms</span>
                    </li>
                  )}
                  {o.runner.health.activeJobs !== undefined && (
                    <li className={styles.listItem}>
                      <span className={styles.secondary}>Active jobs</span>
                      <span>{o.runner.health.activeJobs}</span>
                    </li>
                  )}
                  {o.runner.health.toolchain && (
                    <li className={styles.listItem}>
                      <span className={styles.secondary}>Toolchain</span>
                      <span className={styles.chips}>
                        <span className={styles.chip}>docker {o.runner.health.toolchain.docker ? "✓" : "✗"}</span>
                        <span className={styles.chip}>buildx {o.runner.health.toolchain.buildx ?? "missing"}</span>
                        <span className={styles.chip}>nixpacks {o.runner.health.toolchain.nixpacks ?? "missing"}</span>
                      </span>
                    </li>
                  )}
                  {o.runner.health.error && (
                    <li className={styles.listItem}>
                      <span className={styles.secondary}>Error</span>
                      <span>{o.runner.health.error}</span>
                    </li>
                  )}
                </ul>
              )}
            </section>
          </div>

          <section className={`card ${styles.section}`} aria-labelledby="failures-title">
            <h2 id="failures-title" className={styles.sectionTitle}>
              Recent deploy failures (24h)
            </h2>
            {failures.length === 0 ? (
              <p className={styles.muted}>No failed deployments in the last 24 hours.</p>
            ) : (
              <ul className={styles.list}>
                {failures.map((f) => (
                  <li key={f.id} className={styles.listItem}>
                    <div style={{ minWidth: 0, flex: "1 1 320px" }}>
                      <div className={styles.row}>
                        <strong>{f.serviceName ?? "service"}</strong>
                        {f.workspaceId && (
                          <Link href={`/admin/workspaces/${f.workspaceId}`} className={styles.secondary}>
                            {f.workspaceSlug ?? f.workspaceId}
                          </Link>
                        )}
                      </div>
                      {f.error && <div className={`${styles.mono} ${styles.muted}`}>{f.error}</div>}
                    </div>
                    <span className={styles.muted} title={formatDateTime(f.createdAt)}>
                      {timeAgo(f.createdAt, now)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <section className="card" aria-labelledby="activity-title">
        <h2 id="activity-title" className={styles.sectionTitle}>
          Activity
        </h2>
        <QueryState isLoading={activity.isLoading} error={activity.error} label="activity" />
        {activity.data && feed.length === 0 && <p className={styles.muted}>Nothing yet.</p>}
        {feed.length > 0 && (
          <ul className={styles.list}>
            {feed.map((item) => (
              <li key={`${item.kind}-${item.id}`} className={styles.listItem}>
                <div className={styles.row} style={{ minWidth: 0, flex: "1 1 320px" }}>
                  <span className={ACTIVITY_BADGE[item.kind] ?? "badge badge-queued"}>{item.kind}</span>
                  <span style={{ wordBreak: "break-word" }}>{item.text}</span>
                  {item.workspaceId && (
                    <Link href={`/admin/workspaces/${item.workspaceId}`} className={styles.secondary}>
                      {item.workspaceSlug ?? "workspace"}
                    </Link>
                  )}
                </div>
                <span className={styles.muted} title={formatDateTime(item.at)}>
                  {timeAgo(item.at, now)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
