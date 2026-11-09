"use client";

/**
 * Live dashboard analytics (Team B, v1.2). Polls the analytics router every 15 s while the tab
 * is visible (react-query refetchInterval; paused when hidden) and shows when it last updated.
 * Every number comes from the API; anything not measured renders as "—".
 */

import Link from "next/link";
import { useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { BarChart } from "@/components/charts/bar-chart";
import { Sparkline } from "@/components/charts/sparkline";
import { DEPLOY_COLORS, SERIES_BLUE, STATUS_COLORS, type ChartSeries } from "@/components/charts/chart-utils";
import {
  DASH,
  bucketLabel,
  formatBytes,
  formatCents,
  formatCount,
  formatMb,
  formatMs,
  formatPercent,
  timeAgo,
  useDocumentVisible,
  useNow,
} from "./format";

const POLL_MS = 15_000;

const DEPLOY_SERIES: ChartSeries[] = [
  { key: "succeeded", label: "Succeeded", color: DEPLOY_COLORS.succeeded },
  { key: "inProgress", label: "In progress", color: DEPLOY_COLORS.inProgress },
  { key: "failed", label: "Failed", color: DEPLOY_COLORS.failed },
  { key: "cancelled", label: "Cancelled", color: DEPLOY_COLORS.cancelled },
];

export const TRAFFIC_SERIES: ChartSeries[] = [
  { key: "s2xx", label: "2xx", color: STATUS_COLORS.good },
  { key: "s3xx", label: "3xx", color: SERIES_BLUE },
  { key: "s4xx", label: "4xx", color: STATUS_COLORS.warning },
  { key: "s5xx", label: "5xx", color: STATUS_COLORS.critical },
  { key: "errors", label: "Network errors", color: STATUS_COLORS.serious },
];

function deploymentBadge(status: string): string {
  switch (status) {
    case "ACTIVE":
      return "badge badge-active";
    case "BUILDING":
    case "DEPLOYING":
      return "badge badge-building";
    case "FAILED":
      return "badge badge-failed";
    case "CRASHED":
      return "badge badge-crashed";
    case "SLEEPING":
      return "badge badge-sleeping";
    default:
      return "badge badge-queued";
  }
}

function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} style={{ display: "flex", gap: "6px" }}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={`btn btn-sm ${value === o.value ? "btn-primary" : "btn-secondary"}`}
          style={{ fontSize: "0.75rem", padding: "4px 10px" }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function StatusChip({ dot, label, value }: { dot: string; label: string; value: number | string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
      <span className={`status-dot status-dot-${dot}`} aria-hidden="true" />
      <strong style={{ color: "var(--text-primary)" }}>{value}</strong> {label}
    </span>
  );
}

function Card({ label, children, footer }: { label: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <section className="stat-card" aria-label={label} style={{ minHeight: "150px" }}>
      <div className="stat-label">{label}</div>
      {children}
      {footer && <div style={{ marginTop: "auto" }}>{footer}</div>}
    </section>
  );
}

export function DashboardAnalytics({ workspaces }: { workspaces: Array<{ id: string; name: string }> }) {
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [days, setDays] = useState<7 | 30>(7);
  const [period, setPeriod] = useState<"1h" | "24h" | "7d">("24h");
  const visible = useDocumentVisible();
  const now = useNow(1000);
  const poll = { refetchInterval: visible ? POLL_MS : (false as const), refetchIntervalInBackground: false };
  const scope = workspaceId ? { workspaceId } : {};

  const overview = trpc.analytics.overview.useQuery(scope, poll);
  const timeline = trpc.analytics.deploymentTimeline.useQuery({ ...scope, days }, poll);
  const traffic24 = trpc.analytics.traffic.useQuery({ ...scope, period: "24h" }, poll);
  const trafficChart = trpc.analytics.traffic.useQuery({ ...scope, period }, poll);
  const activity = trpc.analytics.recentActivity.useQuery({ ...scope, limit: 12 }, poll);

  const ov = overview.data;
  const t24 = traffic24.data;
  const updatedAt = overview.dataUpdatedAt || 0;
  const runner = ov?.runner;
  const runnerProblem = runner?.config.problem;
  const runnerOffline = runner && !runnerProblem && !runner.health.online;
  const toolchain = runner?.health.online ? runner.health.toolchain : undefined;
  const buildxMissing = toolchain?.docker === true && !toolchain.buildx;
  const d24 = ov?.deploys["24h"];
  const cap = ov?.usage.nearestCap;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px", marginBottom: "32px" }}>
      {/* Live indicator + scope */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        <div aria-live="polite" style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "0.8125rem", color: "var(--text-secondary)" }}>
          <span className={`status-dot ${!visible ? "status-dot-queued" : overview.isError ? "status-dot-failed" : "status-dot-active"}`} aria-hidden="true" />
          {overview.isError
            ? `Live updates failing: ${overview.error.message}`
            : !visible
            ? "Paused while this tab is hidden"
            : updatedAt
            ? `Live · updated ${timeAgo(new Date(updatedAt), now)}`
            : "Loading live data…"}
        </div>
        {workspaces.length > 1 && (
          <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "0.8125rem", color: "var(--text-secondary)" }}>
            Scope
            <select className="input" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} style={{ padding: "6px 10px", width: "auto" }}>
              <option value="">All workspaces</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {runnerProblem && (
        <div role="alert" className="card" style={{ borderColor: "rgba(239,68,68,0.45)", background: "rgba(239,68,68,0.08)", padding: "14px 18px" }}>
          <strong style={{ color: "#fca5a5" }}>⚠ {runnerProblem}</strong>
          <p style={{ fontSize: "0.8125rem", marginTop: "4px" }}>
            Deployments cannot run until this is fixed. The runner setup is described in <code>deploy/alibaba-ecs/AGENT_PROMPT.md</code>.
          </p>
        </div>
      )}
      {runnerOffline && (
        <div role="alert" className="card" style={{ borderColor: "rgba(245,158,11,0.45)", background: "rgba(245,158,11,0.08)", padding: "14px 18px" }}>
          <strong style={{ color: "#fbbf24" }}>⚠ Runner offline{runner.config.urlHost ? ` (${runner.config.urlHost})` : ""}: {runner.health.error || "no response"}</strong>
          <p style={{ fontSize: "0.8125rem", marginTop: "4px" }}>New deployments will fail until the runner answers its /health endpoint.</p>
        </div>
      )}
      {buildxMissing && (
        <div role="alert" className="card" style={{ borderColor: "rgba(245,158,11,0.45)", background: "rgba(245,158,11,0.08)", padding: "14px 18px" }}>
          <strong style={{ color: "#fbbf24" }}>⚠ Runner cannot build images: docker buildx is missing</strong>
          <p style={{ fontSize: "0.8125rem", marginTop: "4px" }}>
            Docker and Nixpacks builds will fail. Update the runner on its host:{" "}
            <code>cd /opt/syncbay &amp;&amp; git pull &amp;&amp; docker compose -f deploy/alibaba-ecs/docker-compose.yml up -d --build</code>
          </p>
        </div>
      )}

      {/* Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: "16px" }}>
        <Card label="Services" footer={ov && <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{ov.projects} project{ov.projects === 1 ? "" : "s"} · {ov.workspaces} workspace{ov.workspaces === 1 ? "" : "s"}</div>}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
            <span className="stat-value">{ov ? ov.services.live : DASH}</span>
            <span style={{ color: "var(--text-secondary)", fontSize: "0.875rem" }}>live of {ov ? ov.services.total : DASH}</span>
          </div>
          {ov && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px" }}>
              <StatusChip dot="sleeping" label="sleeping" value={ov.services.sleeping} />
              <StatusChip dot="failed" label="failed" value={ov.services.failed} />
              <StatusChip dot="building" label="building" value={ov.services.building} />
              <StatusChip dot="queued" label="paused" value={ov.services.paused} />
            </div>
          )}
        </Card>

        <Card label="Deploys (24h)" footer={ov && <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>7d success {formatPercent(ov.deploys["7d"].successRate)} · {ov.deploys["7d"].total} deploys</div>}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
            <span className="stat-value">{d24 ? formatPercent(d24.successRate, 0) : DASH}</span>
            <span style={{ color: "var(--text-secondary)", fontSize: "0.875rem" }}>success</span>
          </div>
          {d24 && (
            <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
              {d24.total} deploys · {d24.succeeded} ok · {d24.failed} failed{d24.inProgress ? ` · ${d24.inProgress} running` : ""}
              <br />
              Avg build → live: <strong style={{ color: "var(--text-primary)" }}>{formatMs(d24.avgBuildMs)}</strong>
            </div>
          )}
        </Card>

        <Card label="Requests (24h)" footer={<Sparkline values={(t24?.points || []).map((p) => p.requests)} />}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
            <span className="stat-value">{t24 ? formatCount(t24.totals.requests) : DASH}</span>
            <span style={{ color: "var(--text-secondary)", fontSize: "0.875rem" }}>requests</span>
          </div>
          {t24 && (
            <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
              5xx error rate <strong style={{ color: "var(--text-primary)" }}>{formatPercent(t24.totals.errorRatePercent, 2)}</strong> · out {formatBytes(t24.totals.bytesOut)}
              {!t24.hasData && <div style={{ color: "var(--text-muted)" }}>No proxied traffic recorded yet</div>}
            </div>
          )}
        </Card>

        <Card
          label="Month-to-date cost"
          footer={
            cap ? (
              <div>
                <div style={{ height: 6, background: "var(--bg-overlay)", borderRadius: 99, overflow: "hidden" }} aria-hidden="true">
                  <div
                    style={{
                      width: `${Math.min(100, cap.capPercent ?? 0)}%`,
                      height: "100%",
                      background: (cap.capPercent ?? 0) >= 100 ? STATUS_COLORS.critical : (cap.capPercent ?? 0) >= 80 ? STATUS_COLORS.warning : SERIES_BLUE,
                    }}
                  />
                </div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 4 }}>
                  {cap.capReached ? "⛔ Cap reached · " : (cap.capPercent ?? 0) >= 80 ? "⚠ " : ""}
                  {formatPercent(cap.capPercent, 0)} of {formatCents(cap.spendingCapCents)} cap{ov && ov.usage.workspaces.length > 1 ? ` (${cap.name})` : ""}
                </div>
              </div>
            ) : (
              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{ov ? "No spending cap set" : ""}</div>
            )
          }
        >
          <span className="stat-value">{ov ? formatCents(ov.usage.estimatedCostCents) : DASH}</span>
          <Link href="/dashboard/usage" style={{ fontSize: "0.8rem" }}>
            Usage &amp; billing →
          </Link>
        </Card>

        <Card
          label="Live resources"
          footer={ov && <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{ov.resources.sampledServices} of {ov.resources.liveServices} live services sampled (last 10 min)</div>}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
            <span className="stat-value">{ov ? formatPercent(ov.resources.cpuPercentAvg) : DASH}</span>
            <span style={{ color: "var(--text-secondary)", fontSize: "0.875rem" }}>avg CPU</span>
          </div>
          <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
            Memory <strong style={{ color: "var(--text-primary)" }}>{formatMb(ov?.resources.memoryUsedMb)}</strong>
            {ov?.resources.memoryLimitMb != null ? ` / ${formatMb(ov.resources.memoryLimitMb)}` : ""}
          </div>
        </Card>

        <Card
          label="Runner"
          footer={
            runner && (
              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                {runner.config.mode}
                {runner.config.urlHost ? ` · ${runner.config.urlHost}` : ""}
                {runner.config.secretConfigured ? " · secret set" : " · no secret"}
              </div>
            )
          }
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span className={`status-dot ${!runner ? "status-dot-queued" : runnerProblem ? "status-dot-failed" : runner.health.online ? "status-dot-active" : "status-dot-failed"}`} aria-hidden="true" />
            <span className="stat-value" style={{ fontSize: "1.5rem" }}>
              {!runner ? DASH : runnerProblem ? "Not configured" : runner.health.online ? "Online" : "Offline"}
            </span>
          </div>
          {runner && (
            <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
              Latency <strong style={{ color: "var(--text-primary)" }}>{runner.health.latencyMs != null ? `${runner.health.latencyMs} ms` : DASH}</strong> · active jobs{" "}
              <strong style={{ color: "var(--text-primary)" }}>{runner.health.activeJobs ?? DASH}</strong>
              {runner.health.uptime != null && <> · up {formatMs(runner.health.uptime * 1000)}</>}
              {toolchain && (
                <>
                  {" "}· buildx <strong style={{ color: toolchain.buildx ? "var(--text-primary)" : "#fbbf24" }}>{toolchain.buildx ? "ok" : "missing"}</strong>
                </>
              )}
            </div>
          )}
        </Card>
      </div>

      {/* Charts */}
      <div className="grid-2">
        <section className="card" aria-labelledby="deploys-chart-title" style={{ minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", gap: 8, flexWrap: "wrap" }}>
            <div>
              <h3 id="deploys-chart-title" style={{ fontSize: "1rem" }}>Deploys per day</h3>
              <p style={{ fontSize: "0.75rem" }}>
                {timeline.data ? `${timeline.data.totals.total} deploys · success ${formatPercent(timeline.data.totals.successRate)} · UTC days` : "Loading…"}
              </p>
            </div>
            <Segmented label="Timeline range" value={days} onChange={setDays} options={[{ value: 7, label: "7d" }, { value: 30, label: "30d" }]} />
          </div>
          <BarChart
            ariaLabel={`Deployments per day by outcome, last ${days} days`}
            series={DEPLOY_SERIES}
            data={(timeline.data?.series || []).map((d) => ({
              label: d.day.slice(5),
              title: d.day,
              values: { succeeded: d.succeeded, inProgress: d.inProgress, failed: d.failed, cancelled: d.cancelled },
            }))}
            emptyMessage="No deployments in this range"
          />
        </section>

        <section className="card" aria-labelledby="traffic-chart-title" style={{ minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", gap: 8, flexWrap: "wrap" }}>
            <div>
              <h3 id="traffic-chart-title" style={{ fontSize: "1rem" }}>Requests over time</h3>
              <p style={{ fontSize: "0.75rem" }}>
                {trafficChart.data
                  ? `${formatCount(trafficChart.data.totals.requests)} requests · ${formatPercent(trafficChart.data.totals.errorRatePercent, 2)} errors · avg ${formatMs(trafficChart.data.totals.latencyAvgMs)}`
                  : "Loading…"}
              </p>
            </div>
            <Segmented label="Traffic range" value={period} onChange={setPeriod} options={[{ value: "1h", label: "1h" }, { value: "24h", label: "24h" }, { value: "7d", label: "7d" }]} />
          </div>
          <BarChart
            ariaLabel={`Requests by status class, last ${period}`}
            series={TRAFFIC_SERIES}
            formatValue={formatCount}
            data={(trafficChart.data?.points || []).map((p) => {
              const { label, title } = bucketLabel(p.timestamp, trafficChart.data!.bucketSecs);
              return { label, title, values: { s2xx: p.s2xx, s3xx: p.s3xx, s4xx: p.s4xx, s5xx: p.s5xx, errors: p.errors } };
            })}
            emptyMessage={trafficChart.data?.hasData ? "No requests in this range" : "No proxied traffic recorded yet"}
          />
        </section>
      </div>

      <div className="grid-2">
        <section className="card" aria-labelledby="top-services-title" style={{ minWidth: 0 }}>
          <h3 id="top-services-title" style={{ fontSize: "1rem", marginBottom: "12px" }}>
            Top services by requests ({period})
          </h3>
          {trafficChart.data && trafficChart.data.topServices.length > 0 ? (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Service</th>
                    <th scope="col" style={{ textAlign: "right" }}>Requests</th>
                    <th scope="col" style={{ textAlign: "right" }}>Errors</th>
                    <th scope="col" style={{ textAlign: "right" }}>Avg</th>
                    <th scope="col" style={{ textAlign: "right" }}>Out</th>
                  </tr>
                </thead>
                <tbody>
                  {trafficChart.data.topServices.map((s) => (
                    <tr key={s.serviceId}>
                      <td style={{ padding: "8px 12px" }}>
                        <Link href={`/dashboard/projects/${s.projectId}?tab=metrics`} style={{ fontWeight: 600 }}>
                          {s.name}
                        </Link>
                        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{s.projectName}</div>
                      </td>
                      <td style={{ padding: "8px 12px", textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{formatCount(s.requests)}</td>
                      <td style={{ padding: "8px 12px", textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{formatPercent(s.errorRatePercent, 2)}</td>
                      <td style={{ padding: "8px 12px", textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{formatMs(s.latencyAvgMs)}</td>
                      <td style={{ padding: "8px 12px", textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{formatBytes(s.bytesOut)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p style={{ fontSize: "0.875rem" }}>{trafficChart.isLoading ? "Loading…" : "No requests recorded in this range."}</p>
          )}
        </section>

        <section className="card" aria-labelledby="activity-title" style={{ minWidth: 0 }}>
          <h3 id="activity-title" style={{ fontSize: "1rem", marginBottom: "12px" }}>
            Recent activity
          </h3>
          {activity.data && activity.data.items.length > 0 ? (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "10px" }}>
              {activity.data.items.map((item) =>
                item.kind === "deployment" ? (
                  <li key={`d-${item.id}`} style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
                    <span className={deploymentBadge(item.status)} style={{ flexShrink: 0, minWidth: 74, justifyContent: "center" }}>
                      {item.status.toLowerCase()}
                    </span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: "0.8125rem" }}>
                        <Link href={`/dashboard/projects/${item.projectId}?tab=deployments`} style={{ fontWeight: 600 }}>
                          {item.serviceName}
                        </Link>{" "}
                        <span style={{ color: "var(--text-muted)" }}>
                          {item.projectName} · {timeAgo(item.at, now)}
                          {item.commitSha ? ` · ${item.commitSha}` : ""}
                          {item.durationMs != null ? ` · ${formatMs(item.durationMs)}` : ""}
                        </span>
                      </div>
                      {item.errorMessage && (
                        <div style={{ fontSize: "0.75rem", color: "#fca5a5", fontFamily: "var(--font-mono, monospace)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={item.errorMessage}>
                          {item.errorMessage}
                        </div>
                      )}
                    </div>
                  </li>
                ) : (
                  <li key={`a-${item.id}`} style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
                    <span className="badge badge-queued" style={{ flexShrink: 0, minWidth: 74, justifyContent: "center" }}>
                      audit
                    </span>
                    <div style={{ fontSize: "0.8125rem" }}>
                      <code>{item.action}</code>{" "}
                      <span style={{ color: "var(--text-muted)" }}>
                        {item.actor ? `by ${item.actor} · ` : ""}
                        {timeAgo(item.at, now)}
                      </span>
                    </div>
                  </li>
                )
              )}
            </ul>
          ) : (
            <p style={{ fontSize: "0.875rem" }}>{activity.isLoading ? "Loading…" : "No deployments yet."}</p>
          )}
        </section>
      </div>
    </div>
  );
}
