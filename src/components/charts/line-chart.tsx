"use client";

/**
 * Line chart (hand-rolled SVG, one y-axis). 2 px lines with round joins, optional 10 % area
 * wash under the first series, end dots (r 4) with a 2 px surface ring, hairline grid, a
 * crosshair that snaps to the nearest x and a tooltip listing every series, a legend for ≥ 2
 * series and a table view. Null values break the line instead of being drawn as zero.
 */

import { useState } from "react";
import { ChartTable } from "./bar-chart";
import {
  AXIS_TEXT,
  CHART_SURFACE,
  GRID_COLOR,
  labelStride,
  legendStyle,
  niceMax,
  tooltipStyle,
  useElementWidth,
  type ChartSeries,
} from "./chart-utils";

export interface LinePoint {
  label: string;
  title?: string;
  values: Record<string, number | null>;
}

interface LineChartProps {
  points: LinePoint[];
  series: ChartSeries[];
  height?: number;
  ariaLabel: string;
  formatValue?: (n: number) => string;
  /** Fixed y maximum (e.g. 100 for percentages); otherwise derived from the data. */
  yMax?: number;
  area?: boolean;
  emptyMessage?: string;
}

const PAD = { top: 10, right: 12, bottom: 22, left: 48 };

export function LineChart({
  points,
  series,
  height = 180,
  ariaLabel,
  formatValue = (n) => n.toLocaleString(),
  yMax,
  area = false,
  emptyMessage = "No data yet",
}: LineChartProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const all = points.flatMap((p) => series.map((s) => p.values[s.key])).filter((v): v is number => typeof v === "number");
  const max = yMax ?? niceMax(Math.max(0, ...all));
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const n = points.length;
  const x = (i: number) => PAD.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - (Math.min(max, Math.max(0, v)) / max) * plotH;
  const stride = labelStride(n, plotW, 64);
  const isEmpty = all.length === 0;

  const pathFor = (key: string) => {
    let d = "";
    let pen = false;
    points.forEach((p, i) => {
      const v = p.values[key];
      if (typeof v !== "number") {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };
  const lastIndex = (key: string) => {
    for (let i = n - 1; i >= 0; i--) if (typeof points[i].values[key] === "number") return i;
    return -1;
  };
  const onMove = (clientX: number, rect: DOMRect) => {
    if (n === 0) return;
    const rel = clientX - rect.left - PAD.left;
    const idx = n <= 1 ? 0 : Math.round((rel / Math.max(1, plotW)) * (n - 1));
    setActive(Math.max(0, Math.min(n - 1, idx)));
  };

  return (
    <div>
      {series.length > 1 && (
        <div style={legendStyle} aria-hidden="true">
          {series.map((s) => (
            <span key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
              <span style={{ width: 14, height: 2, borderRadius: 1, background: s.color, display: "inline-block" }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <div ref={ref} style={{ position: "relative", width: "100%", height }}>
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={ariaLabel}
            tabIndex={0}
            style={{ display: "block", outline: "none" }}
            onPointerMove={(e) => onMove(e.clientX, (e.currentTarget as SVGSVGElement).getBoundingClientRect())}
            onPointerLeave={() => setActive(null)}
            onFocus={() => setActive(n - 1)}
            onBlur={() => setActive(null)}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") setActive((a) => Math.max(0, (a ?? n - 1) - 1));
              if (e.key === "ArrowRight") setActive((a) => Math.min(n - 1, (a ?? 0) + 1));
            }}
          >
            {[0, 0.5, 1].map((f) => (
              <g key={f}>
                <line x1={PAD.left} x2={PAD.left + plotW} y1={y(max * f)} y2={y(max * f)} stroke={GRID_COLOR} strokeWidth={1} />
                <text x={PAD.left - 6} y={y(max * f)} fill={AXIS_TEXT} fontSize={10} textAnchor="end" dominantBaseline="middle">
                  {formatValue(max * f)}
                </text>
              </g>
            ))}
            {points.map((p, i) =>
              i % stride === 0 ? (
                <text key={p.label + i} x={x(i)} y={height - 6} fill={AXIS_TEXT} fontSize={10} textAnchor={i === 0 && n > 1 ? "start" : "middle"}>
                  {p.label}
                </text>
              ) : null
            )}
            {area && series[0] && pathFor(series[0].key) && (
              <path
                d={`${pathFor(series[0].key)} L${x(lastIndex(series[0].key)).toFixed(1)},${y(0)} L${x(points.findIndex((p) => typeof p.values[series[0].key] === "number")).toFixed(1)},${y(0)} Z`}
                fill={series[0].color}
                opacity={0.1}
              />
            )}
            {series.map((s) => (
              <path key={s.key} d={pathFor(s.key)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {/* End dots (or the single point) with a surface ring */}
            {series.map((s) => {
              const i = lastIndex(s.key);
              if (i < 0 || active !== null) return null;
              return <circle key={s.key} cx={x(i)} cy={y(points[i].values[s.key] as number)} r={4} fill={s.color} stroke={CHART_SURFACE} strokeWidth={2} />;
            })}
            {active !== null && points[active] && (
              <g>
                <line x1={x(active)} x2={x(active)} y1={PAD.top} y2={PAD.top + plotH} stroke="rgba(255,255,255,0.25)" strokeWidth={1} />
                {series.map((s) => {
                  const v = points[active].values[s.key];
                  return typeof v === "number" ? <circle key={s.key} cx={x(active)} cy={y(v)} r={4} fill={s.color} stroke={CHART_SURFACE} strokeWidth={2} /> : null;
                })}
              </g>
            )}
            {isEmpty && (
              <text x={PAD.left + plotW / 2} y={PAD.top + plotH / 2} fill={AXIS_TEXT} fontSize={12} textAnchor="middle">
                {emptyMessage}
              </text>
            )}
          </svg>
        )}
        {active !== null && points[active] && !isEmpty && (
          <div style={{ ...tooltipStyle, top: 0, left: Math.min(Math.max(0, x(active) - 70), Math.max(0, width - 160)) }}>
            <div style={{ color: "var(--text-secondary)", marginBottom: 4 }}>{points[active].title || points[active].label}</div>
            {series.map((s) => {
              const v = points[active].values[s.key];
              return (
                <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "space-between" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text-secondary)" }}>
                    <span style={{ width: 10, height: 2, background: s.color, display: "inline-block", borderRadius: 1 }} />
                    {s.label}
                  </span>
                  <strong>{typeof v === "number" ? formatValue(v) : "—"}</strong>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <ChartTable caption={ariaLabel} columns={series} rows={points.map((p) => ({ label: p.title || p.label, values: p.values }))} formatValue={formatValue} />
    </div>
  );
}
