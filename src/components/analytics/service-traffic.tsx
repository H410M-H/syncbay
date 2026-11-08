"use client";

/**
 * Per-service live gauges and HTTP traffic panel for the project page (Team B, v1.2).
 * Gauges read `metrics.live` (runner reading, else the newest MetricSample); traffic reads
 * `analytics.traffic({ serviceId })` (TrafficSample from the runner proxy). Unmeasured → "—".
 */

import { useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { BarChart } from "@/components/charts/bar-chart";
import { LineChart } from "@/components/charts/line-chart";
import { SERIES_BLUE, SERIES_ORANGE } from "@/components/charts/chart-utils";
import { TRAFFIC_SERIES } from "./dashboard-analytics";
import { DASH, bucketLabel, formatBytes, formatCount, formatMs, formatPercent, timeAgo, useDocumentVisible, useNow } from "./format";

const POLL_MS = 15_000;

const gaugeLabel: React.CSSProperties = { color: "var(--text-muted)", fontSize: "0.6875rem", textTransform: "uppercase" };
const gaugeValue: React.CSSProperties = { fontWeight: 700, color: "var(--text-primary)", marginTop: "2px" };
const gaugeSub: React.CSSProperties = { fontWeight: 400, color: "var(--text-muted)", fontSize: "0.6875rem", marginLeft: "4px" };

/** Compact live numbers for one service card. */
export function ServiceLiveGauges({ serviceId, isPaused }: { serviceId: string; isPaused: boolean }) {
  const visible = useDocumentVisible();
  const now = useNow(5000);
  const poll = { refetchInterval: visible ? POLL_MS : (false as const), refetchIntervalInBackground: false };
  const live = trpc.metrics.live.useQuery({ serviceId }, poll);
  const traffic = trpc.analytics.traffic.useQuery({ serviceId, period: "1h" }, poll);
  const point = isPaused ? null : live.data?.point ?? null;
  const source = live.data?.source;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
        gap: "10px",
        margin: "14px 0",
        padding: "10px 14px",
        background: "rgba(10, 10, 18, 0.6)",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--border-subtle)",
        fontSize: "0.75rem",
      }}
    >
      <div>
        <div style={gaugeLabel}>CPU</div>
        <div style={gaugeValue}>
          {point ? formatPercent(point.cpuPercent) : DASH}
          <span style={gaugeSub}>of one core</span>
        </div>
      </div>
      <div>
        <div style={gaugeLabel}>Memory</div>
        <div style={gaugeValue}>
          {point ? `${formatCount(point.memoryUsedMb)} MB` : DASH}
          <span style={gaugeSub}>{point?.memoryLimitMb ? `/ ${formatCount(point.memoryLimitMb)} MB` : point ? "no limit reported" : ""}</span>
        </div>
      </div>
      <div>
        <div style={gaugeLabel}>Network egress</div>
        <div style={gaugeValue}>
          {point?.networkEgressKb != null ? `${point.networkEgressKb} KB/s` : DASH}
          {point && point.networkEgressKb == null && <span style={gaugeSub}>not measured</span>}
        </div>
      </div>
      <div>
        <div style={gaugeLabel}>Requests (1h)</div>
        <div style={gaugeValue}>
          {traffic.data?.hasData ? formatCount(traffic.data.totals.requests) : DASH}
          {traffic.data?.hasData && <span style={gaugeSub}>{formatPercent(traffic.data.totals.errorRatePercent, 1)} errors</span>}
        </div>
      </div>
      <div style={{ gridColumn: "1 / -1", color: "var(--text-muted)", fontSize: "0.6875rem" }}>
        {isPaused
          ? "Paused: no instance is running."
          : source === "docker" || source === "proc"
          ? `Live reading from the runner (${source === "proc" ? "native process" : "container"})`
          : source === "sample"
          ? `Last sample ${timeAgo(point?.timestamp, now)}`
          : live.isLoading
          ? "Loading…"
          : "No resource samples recorded yet."}
      </div>
    </div>
  );
}

/** HTTP traffic of one service: requests by status class, error rate, bandwidth and latency. */
export function ServiceTrafficPanel({ serviceId, serviceName }: { serviceId: string; serviceName: string }) {
  const [period, setPeriod] = useState<"1h" | "24h" | "7d">("1h");
  const visible = useDocumentVisible();
  const now = useNow(5000);
  const { data, isLoading, error } = trpc.analytics.traffic.useQuery(
    { serviceId, period },
    { refetchInterval: visible ? POLL_MS : false, refetchIntervalInBackground: false }
  );
  const t = data?.totals;
  const hist = data?.histogram;
  const histTotal = hist ? hist.lt50 + hist.lt200 + hist.lt1000 + hist.ge1000 : 0;
  const labels = (data?.points || []).map((p) => bucketLabel(p.timestamp, data!.bucketSecs));

  return (
    <div className="card" style={{ marginTop: "24px" }} aria-labelledby="traffic-panel-title">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px", marginBottom: "16px" }}>
        <div>
          <h4 id="traffic-panel-title">HTTP traffic · {serviceName}</h4>
          <p style={{ fontSize: "0.8125rem" }}>
            Counted by the runner&apos;s reverse proxy and collected every minute.
            {data?.lastSampleAt ? ` Last traffic ${timeAgo(data.lastSampleAt, now)}.` : ""}
          </p>
        </div>
        <div role="group" aria-label="Traffic range" style={{ display: "flex", gap: "8px" }}>
          {(["1h", "24h", "7d"] as const).map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={period === p}
              onClick={() => setPeriod(p)}
              className={`btn btn-sm ${period === p ? "btn-primary" : "btn-secondary"}`}
              style={{ fontSize: "0.75rem" }}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p style={{ color: "#fca5a5" }}>Could not load traffic: {error.message}</p>
      ) : (
        <>
          <div className="grid-4" style={{ marginBottom: "20px" }}>
            <div className="stat-card">
              <span className="stat-label">Requests</span>
              <div className="stat-value">{t ? formatCount(t.requests) : DASH}</div>
              <div className="stat-change">
                {t ? `${formatCount(t.s2xx)} 2xx · ${formatCount(t.s3xx)} 3xx · ${formatCount(t.s4xx)} 4xx` : ""}
              </div>
            </div>
            <div className="stat-card">
              <span className="stat-label">Error rate</span>
              <div className="stat-value">{t ? formatPercent(t.errorRatePercent, 2) : DASH}</div>
              <div className="stat-change">{t ? `${formatCount(t.s5xx)} 5xx · ${formatCount(t.errors)} network errors` : ""}</div>
            </div>
            <div className="stat-card">
              <span className="stat-label">Bandwidth</span>
              <div className="stat-value" style={{ fontSize: "1.5rem" }}>{t ? formatBytes(t.bytesOut) : DASH}</div>
              <div className="stat-change">{t ? `out · ${formatBytes(t.bytesIn)} in (bodies)` : ""}</div>
            </div>
            <div className="stat-card">
              <span className="stat-label">Latency</span>
              <div className="stat-value" style={{ fontSize: "1.5rem" }}>{t ? formatMs(t.latencyAvgMs) : DASH}</div>
              <div className="stat-change">{t ? `avg · max ${formatMs(t.latencyMaxMs)} (to first byte)` : ""}</div>
            </div>
          </div>

          {!isLoading && data && !data.hasData ? (
            <p style={{ fontSize: "0.875rem" }}>
              No proxied traffic recorded for this service yet. Requests are counted when they reach the app through the runner (edge proxy or tunnel).
            </p>
          ) : (
            <div className="grid-2">
              <div>
                <h5 style={{ fontSize: "0.8125rem", marginBottom: "8px", color: "var(--text-secondary)" }}>Requests by status</h5>
                <BarChart
                  ariaLabel={`Requests by status class for ${serviceName}, last ${period}`}
                  series={TRAFFIC_SERIES}
                  formatValue={formatCount}
                  height={170}
                  data={(data?.points || []).map((p, i) => ({
                    ...labels[i],
                    values: { s2xx: p.s2xx, s3xx: p.s3xx, s4xx: p.s4xx, s5xx: p.s5xx, errors: p.errors },
                  }))}
                  emptyMessage="No requests in this range"
                />
              </div>
              <div>
                <h5 style={{ fontSize: "0.8125rem", marginBottom: "8px", color: "var(--text-secondary)" }}>Latency (ms)</h5>
                <LineChart
                  ariaLabel={`Average and maximum latency for ${serviceName}, last ${period}`}
                  series={[
                    { key: "avg", label: "Average", color: SERIES_BLUE },
                    { key: "max", label: "Max", color: SERIES_ORANGE },
                  ]}
                  formatValue={(n) => formatMs(n)}
                  height={170}
                  points={(data?.points || []).map((p, i) => ({ ...labels[i], values: { avg: p.latencyAvgMs, max: p.latencyMaxMs } }))}
                  emptyMessage="No requests in this range"
                />
              </div>
              <div>
                <h5 style={{ fontSize: "0.8125rem", marginBottom: "8px", color: "var(--text-secondary)" }}>Bandwidth</h5>
                <LineChart
                  ariaLabel={`Response and request body bytes for ${serviceName}, last ${period}`}
                  series={[
                    { key: "out", label: "Out", color: SERIES_BLUE },
                    { key: "in", label: "In", color: SERIES_ORANGE },
                  ]}
                  formatValue={formatBytes}
                  height={150}
                  area
                  points={(data?.points || []).map((p, i) => ({ ...labels[i], values: { out: p.bytesOut, in: p.bytesIn } }))}
                />
              </div>
              <div>
                <h5 style={{ fontSize: "0.8125rem", marginBottom: "8px", color: "var(--text-secondary)" }}>Latency distribution</h5>
                <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "10px" }}>
                  {hist &&
                    ([
                      ["< 50 ms", hist.lt50],
                      ["50–200 ms", hist.lt200],
                      ["200 ms – 1 s", hist.lt1000],
                      ["≥ 1 s", hist.ge1000],
                    ] as const).map(([label, n]) => {
                      const pct = histTotal ? (n / histTotal) * 100 : 0;
                      return (
                        <li key={label} style={{ fontSize: "0.8125rem" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", color: "var(--text-secondary)" }}>
                            <span>{label}</span>
                            <span>
                              <strong style={{ color: "var(--text-primary)" }}>{formatCount(n)}</strong> · {formatPercent(histTotal ? pct : null, 0)}
                            </span>
                          </div>
                          <div style={{ height: 6, background: "var(--bg-overlay)", borderRadius: 99, overflow: "hidden", marginTop: 4 }} aria-hidden="true">
                            <div style={{ width: `${pct}%`, height: "100%", background: SERIES_BLUE, borderRadius: 99 }} />
                          </div>
                        </li>
                      );
                    })}
                </ul>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
