/** Display helpers for the Data view. */

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/** One table cell as text: NULL marker, JSON for objects, capped length. */
export function cellText(value: unknown): { text: string; isNull: boolean } {
  if (value === null || value === undefined) return { text: "NULL", isNull: true };
  const raw = typeof value === "object" ? JSON.stringify(value) : String(value);
  return { text: raw.length > 500 ? `${raw.slice(0, 500)}…` : raw, isNull: false };
}

/** tRPC/Error message without the JSON noise. */
export function errorText(err: unknown): string {
  return (err as { message?: string })?.message || "Request failed";
}
