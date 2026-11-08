"use client";

/**
 * Stacked bar chart (hand-rolled SVG). Bars ≤ 24 px with a 4 px rounded data end and a square
 * base, 2 px surface gaps between segments, hairline grid, a legend, a per-bar hover/focus
 * tooltip listing every segment, and a table view. Text uses text tokens, never series colors.
 */

import { useState } from "react";
import {
  AXIS_TEXT,
  GRID_COLOR,
  labelStride,
  legendStyle,
  niceMax,
  roundedTopRect,
  tooltipStyle,
  useElementWidth,
  type ChartSeries,
} from "./chart-utils";

export interface BarDatum {
  /** Short axis label. */
  label: string;
  /** Longer label for the tooltip and table (defaults to `label`). */
  title?: string;
  values: Record<string, number>;
}

interface BarChartProps {
  data: BarDatum[];
  series: ChartSeries[];
  height?: number;
  ariaLabel: string;
  formatValue?: (n: number) => string;
  emptyMessage?: string;
}

const PAD = { top: 8, right: 8, bottom: 22, left: 44 };
const GAP = 2;

export function BarChart({ data, series, height = 180, ariaLabel, formatValue = (n) => n.toLocaleString(), emptyMessage = "No data yet" }: BarChartProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const totals = data.map((d) => series.reduce((n, s) => n + (d.values[s.key] || 0), 0));
  const max = niceMax(Math.max(0, ...totals));
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const band = data.length ? plotW / data.length : 0;
  const barW = Math.max(2, Math.min(24, band * 0.7));
  const stride = labelStride(data.length, plotW);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const isEmpty = totals.every((t) => t === 0);

  return (
    <div>
      {series.length > 1 && (
        <div style={legendStyle} aria-hidden="true">
          {series.map((s) => (
            <span key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: s.color, display: "inline-block" }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <div ref={ref} style={{ position: "relative", width: "100%", height }}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={ariaLabel} style={{ display: "block" }}>
            {[0, 0.5, 1].map((f) => (
              <g key={f}>
                <line x1={PAD.left} x2={PAD.left + plotW} y1={y(max * f)} y2={y(max * f)} stroke={GRID_COLOR} strokeWidth={1} />
                <text x={PAD.left - 6} y={y(max * f)} fill={AXIS_TEXT} fontSize={10} textAnchor="end" dominantBaseline="middle">
                  {formatValue(max * f)}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const x = PAD.left + i * band + (band - barW) / 2;
              let cursor = y(0);
              const segs = series.filter((s) => (d.values[s.key] || 0) > 0);
              return (
                <g key={d.label + i} opacity={active === null || active === i ? 1 : 0.55}>
                  {segs.map((s, si) => {
                    const h = ((d.values[s.key] || 0) / max) * plotH;
                    const top = cursor - h;
                    const isTop = si === segs.length - 1;
                    // 2 px surface gap above every segment that has another one on top of it.
                    const drawH = Math.max(0.5, isTop ? h : h - GAP);
                    const drawY = isTop ? top : top + GAP;
                    cursor = top;
                    return isTop ? (
                      <path key={s.key} d={roundedTopRect(x, drawY, barW, drawH)} fill={s.color} />
                    ) : (
                      <rect key={s.key} x={x} y={drawY} width={barW} height={drawH} fill={s.color} />
                    );
                  })}
                  {i % stride === 0 && (
                    <text x={x + barW / 2} y={height - 6} fill={AXIS_TEXT} fontSize={10} textAnchor="middle">
                      {d.label}
                    </text>
                  )}
                  {/* Hit target: the whole band, not just the painted pixels. */}
                  <rect
                    x={PAD.left + i * band}
                    y={PAD.top}
                    width={Math.max(1, band)}
                    height={plotH}
                    fill="transparent"
                    tabIndex={0}
                    aria-label={`${d.title || d.label}: ${series.map((s) => `${s.label} ${formatValue(d.values[s.key] || 0)}`).join(", ")}`}
                    onPointerEnter={() => setActive(i)}
                    onPointerLeave={() => setActive(null)}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive(null)}
                    style={{ outline: "none", cursor: "default" }}
                  />
                </g>
              );
            })}
            <line x1={PAD.left} x2={PAD.left + plotW} y1={y(0)} y2={y(0)} stroke="rgba(255,255,255,0.18)" strokeWidth={1} />
            {isEmpty && (
              <text x={PAD.left + plotW / 2} y={PAD.top + plotH / 2} fill={AXIS_TEXT} fontSize={12} textAnchor="middle">
                {emptyMessage}
              </text>
            )}
          </svg>
        )}
        {active !== null && data[active] && (
          <div
            style={{
              ...tooltipStyle,
              top: 0,
              left: Math.min(Math.max(0, PAD.left + active * band + band / 2 - 70), Math.max(0, width - 160)),
            }}
          >
            <div style={{ color: "var(--text-secondary)", marginBottom: 4 }}>{data[active].title || data[active].label}</div>
            {series.map((s) => (
              <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "space-between" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text-secondary)" }}>
                  <span style={{ width: 10, height: 2, background: s.color, display: "inline-block", borderRadius: 1 }} />
                  {s.label}
                </span>
                <strong>{formatValue(data[active].values[s.key] || 0)}</strong>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--border-default)", marginTop: 4, paddingTop: 4 }}>
              <span style={{ color: "var(--text-secondary)" }}>Total</span>
              <strong>{formatValue(totals[active])}</strong>
            </div>
          </div>
        )}
      </div>
      <ChartTable
        caption={ariaLabel}
        columns={series}
        rows={data.map((d, i) => ({ label: d.title || d.label, values: d.values, total: totals[i] }))}
        formatValue={formatValue}
      />
    </div>
  );
}

/** Collapsible table view of a chart's data (the non-visual path to every value). */
export function ChartTable({
  caption,
  columns,
  rows,
  formatValue,
}: {
  caption: string;
  columns: ChartSeries[];
  rows: Array<{ label: string; values: Record<string, number | null>; total?: number }>;
  formatValue: (n: number) => string;
}) {
  const hasTotal = rows.some((r) => r.total !== undefined);
  return (
    <details style={{ marginTop: 6 }}>
      <summary style={{ fontSize: "0.75rem", color: "var(--text-secondary)", cursor: "pointer" }}>View as table</summary>
      <div className="table-wrapper" style={{ marginTop: 6, maxHeight: 260, overflowY: "auto" }}>
        <table>
          <caption style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Period</th>
              {columns.map((c) => (
                <th key={c.key} scope="col" style={{ textAlign: "right" }}>
                  {c.label}
                </th>
              ))}
              {hasTotal && (
                <th scope="col" style={{ textAlign: "right" }}>
                  Total
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.label + i}>
                <td style={{ padding: "6px 12px" }}>{r.label}</td>
                {columns.map((c) => (
                  <td key={c.key} style={{ padding: "6px 12px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {r.values[c.key] === null || r.values[c.key] === undefined ? "—" : formatValue(r.values[c.key] as number)}
                  </td>
                ))}
                {hasTotal && (
                  <td style={{ padding: "6px 12px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatValue(r.total ?? 0)}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
