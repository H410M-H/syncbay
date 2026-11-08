/**
 * Shared bits for the hand-rolled SVG charts (no chart dependency).
 *
 * Colors were checked with the dataviz palette validator against the card surface (#0f0f1f):
 * - DEPLOY_COLORS stack order (succeeded, in progress, failed, cancelled) passes every check.
 * - STATUS_COLORS are the fixed status palette (good/warning/serious/critical) plus blue for
 *   3xx; adjacent pairs clear the CVD floor, and every chart also has a legend, a tooltip and a
 *   table view, so identity never rests on color alone.
 */

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
}

export const CHART_SURFACE = "#0f0f1f";
export const GRID_COLOR = "rgba(255,255,255,0.08)";
export const AXIS_TEXT = "#94a3b8";

export const SERIES_BLUE = "#3987e5";
export const SERIES_ORANGE = "#d95926";

export const STATUS_COLORS = {
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
} as const;

export const DEPLOY_COLORS = {
  succeeded: STATUS_COLORS.good,
  inProgress: SERIES_BLUE,
  failed: STATUS_COLORS.critical,
  cancelled: "#9085e9",
} as const;

/** Rounds up to 1 / 2 / 2.5 / 5 × 10^n so axis ticks read cleanly. */
export function niceMax(value: number): number {
  if (!(value > 0)) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(value)));
  const f = value / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

/** Width of an element, tracked with ResizeObserver (0 before the first layout). */
export function useElementWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === "number") setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Path of a rect with rounded top corners (data end) and a square base. */
export function roundedTopRect(x: number, y: number, w: number, h: number, r = 4): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}

/** Every k-th x label so labels never collide (about one per `minPx`). */
export function labelStride(count: number, plotWidth: number, minPx = 56): number {
  if (count <= 1 || plotWidth <= 0) return 1;
  return Math.max(1, Math.ceil(count / Math.max(1, Math.floor(plotWidth / minPx))));
}

export const legendStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "12px",
  fontSize: "0.75rem",
  color: "var(--text-secondary)",
  marginBottom: "8px",
};

export const tooltipStyle: CSSProperties = {
  position: "absolute",
  pointerEvents: "none",
  background: "var(--bg-elevated)",
  border: "1px solid var(--border-default)",
  borderRadius: "8px",
  padding: "8px 10px",
  fontSize: "0.75rem",
  color: "var(--text-primary)",
  boxShadow: "var(--shadow-md)",
  zIndex: 5,
  minWidth: "140px",
  whiteSpace: "nowrap",
};
