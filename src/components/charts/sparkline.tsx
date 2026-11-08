"use client";

/**
 * Sparkline for stat tiles: one series, no axes, 2 px line (non-scaling) with a 10 % wash and
 * no markers (the box is stretched). It is decoration next to a number that carries the value, so it is aria-hidden.
 */

import { SERIES_BLUE } from "./chart-utils";

export function Sparkline({ values, color = SERIES_BLUE, height = 28 }: { values: number[]; color?: string; height?: number }) {
  if (values.length < 2 || values.every((v) => v === 0)) {
    return <div style={{ height }} aria-hidden="true" />;
  }
  const W = 100;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * W, height - 3 - (Math.max(0, v) / max) * (height - 6)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" aria-hidden="true" style={{ display: "block", overflow: "visible" }}>
      <path d={`${line} L${W},${height} L0,${height} Z`} fill={color} opacity={0.1} />
      <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
