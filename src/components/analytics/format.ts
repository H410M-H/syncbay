/** Display helpers for the analytics UI. Missing values render as "—", never as a made-up 0. */

import { useEffect, useState } from "react";

export const DASH = "—";

export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return Math.round(n).toLocaleString();
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (Math.abs(v) >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v >= 100 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/** Megabytes, switching to GB from 1024 MB. */
export function formatMb(mb: number | null | undefined): string {
  if (mb === null || mb === undefined || !Number.isFinite(mb)) return DASH;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

export function formatMs(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  if (n >= 60_000) return `${(n / 60_000).toFixed(1)} min`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)} s`;
  return `${Math.round(n)} ms`;
}

export function formatPercent(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return `${n.toFixed(digits)}%`;
}

export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return DASH;
  return `$${(cents / 100).toFixed(cents < 1000 ? 2 : 0)}`;
}

export function timeAgo(iso: string | Date | null | undefined, now = Date.now()): string {
  if (!iso) return DASH;
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** Axis/tooltip label for a bucket start, depending on the bucket size. */
export function bucketLabel(iso: string, bucketSecs: number): { label: string; title: string } {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const day = d.toLocaleDateString([], { month: "short", day: "numeric" });
  if (bucketSecs < 86_400 && bucketSecs <= 3600) return { label: time, title: `${day} ${time}` };
  return { label: bucketSecs >= 86_400 ? day : `${day} ${time}`, title: `${day} ${time}` };
}

/** True while the tab is visible; polling pauses when it is hidden. */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const update = () => setVisible(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/** Re-renders every `ms` (for "updated Xs ago" labels). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
