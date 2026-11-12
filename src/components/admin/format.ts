/** Display helpers shared by the staff console pages. */

import type { StaffRoleName } from "@/lib/admin/permissions";

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Cents → "$1,234.56"; "—" when missing. */
export function dollars(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "—";
  return USD.format(cents / 100);
}

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** The message of a thrown tRPC/fetch error. */
export function errorMessage(err: unknown, fallback = "Something went wrong"): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message || fallback;
  }
  return fallback;
}

export function deploymentBadgeClass(status: string | null | undefined): string {
  switch (status) {
    case "ACTIVE":
      return "badge badge-active";
    case "BUILDING":
    case "DEPLOYING":
    case "QUEUED":
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

export function reportStatusBadgeClass(status: string): string {
  switch (status) {
    case "OPEN":
      return "badge badge-failed";
    case "IN_REVIEW":
      return "badge badge-building";
    case "ACTIONED":
      return "badge badge-active";
    default:
      return "badge badge-queued";
  }
}

export function outcomeBadgeClass(outcome: string): string {
  if (outcome === "ALLOWED") return "badge badge-active";
  if (outcome === "DENIED") return "badge badge-building";
  return "badge badge-failed";
}

export function roleBadgeClass(role: StaffRoleName): string {
  switch (role) {
    case "SUPER_ADMIN":
      return "badge badge-failed";
    case "ADMIN":
      return "badge badge-sleeping";
    case "MODERATOR":
      return "badge badge-building";
    case "BILLING":
    case "SUPPORT":
      return "badge badge-active";
    default:
      return "badge badge-queued";
  }
}

/** "SUPER_ADMIN" → "Super admin". */
export function humanize(value: string): string {
  const s = value.toLowerCase().replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
