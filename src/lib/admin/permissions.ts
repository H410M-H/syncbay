/**
 * Staff console permissions. Roles are stored per user (`StaffMember.role`); what a role may do
 * lives here, in code, so changes are reviewed. Pure module: safe for client components.
 *
 * Gate levels: "allow" = no extra input; "reason" = a written reason is required and audited;
 * "confirm" = reason plus typing the target's name.
 */

export const STAFF_ROLES = ["SUPER_ADMIN", "ADMIN", "SUPPORT", "MODERATOR", "BILLING", "VIEWER"] as const;
export type StaffRoleName = (typeof STAFF_ROLES)[number];

export type Gate = "allow" | "reason" | "confirm";

/** permission → gate per role (absent = denied). */
const MATRIX = {
  "admin.access": { SUPER_ADMIN: "allow", ADMIN: "allow", SUPPORT: "allow", MODERATOR: "allow", BILLING: "allow", VIEWER: "allow" },
  "ops.read": { SUPER_ADMIN: "allow", ADMIN: "allow", SUPPORT: "allow", MODERATOR: "allow", BILLING: "allow", VIEWER: "allow" },
  "ops.revenue.read": { SUPER_ADMIN: "allow", ADMIN: "allow", BILLING: "allow", VIEWER: "allow" },
  "workspace.read": { SUPER_ADMIN: "allow", ADMIN: "allow", SUPPORT: "allow", MODERATOR: "allow", BILLING: "allow", VIEWER: "allow" },
  "workspace.note.write": { SUPER_ADMIN: "allow", ADMIN: "allow", SUPPORT: "allow", MODERATOR: "allow", BILLING: "allow" },
  "workspace.tags.write": { SUPER_ADMIN: "allow", ADMIN: "allow", SUPPORT: "allow", BILLING: "allow" },
  "workspace.suspend": { SUPER_ADMIN: "confirm", ADMIN: "confirm", MODERATOR: "confirm", BILLING: "confirm" },
  "workspace.unsuspend": { SUPER_ADMIN: "reason", ADMIN: "reason", MODERATOR: "reason", BILLING: "reason" },
  "workspace.spend_cap.set": { SUPER_ADMIN: "reason", ADMIN: "reason", BILLING: "reason" },
  "user.read": { SUPER_ADMIN: "allow", ADMIN: "allow", SUPPORT: "allow", MODERATOR: "allow", BILLING: "allow", VIEWER: "allow" },
  "user.suspend": { SUPER_ADMIN: "confirm", ADMIN: "confirm", MODERATOR: "confirm" },
  "user.unsuspend": { SUPER_ADMIN: "reason", ADMIN: "reason", MODERATOR: "reason" },
  "service.read": { SUPER_ADMIN: "allow", ADMIN: "allow", SUPPORT: "allow", MODERATOR: "allow", VIEWER: "allow" },
  "service.takedown": { SUPER_ADMIN: "confirm", ADMIN: "confirm", MODERATOR: "confirm" },
  "service.restore": { SUPER_ADMIN: "reason", ADMIN: "reason", MODERATOR: "reason" },
  "moderation.report.read": { SUPER_ADMIN: "allow", ADMIN: "allow", SUPPORT: "allow", MODERATOR: "allow", VIEWER: "allow" },
  "moderation.report.assign": { SUPER_ADMIN: "allow", ADMIN: "allow", MODERATOR: "allow" },
  "moderation.report.resolve": { SUPER_ADMIN: "reason", ADMIN: "reason", MODERATOR: "reason" },
  "billing.read": { SUPER_ADMIN: "allow", ADMIN: "allow", SUPPORT: "allow", BILLING: "allow", VIEWER: "allow" },
  "staff.read": { SUPER_ADMIN: "allow", ADMIN: "allow" },
  "staff.grant": { SUPER_ADMIN: "reason", ADMIN: "reason" },
  "staff.grant_admin": { SUPER_ADMIN: "confirm" },
  "staff.revoke": { SUPER_ADMIN: "confirm", ADMIN: "confirm" },
  "audit.read": { SUPER_ADMIN: "allow", ADMIN: "allow" },
  "audit.read_own": { SUPER_ADMIN: "allow", ADMIN: "allow", SUPPORT: "allow", MODERATOR: "allow", BILLING: "allow" },
} as const satisfies Record<string, Partial<Record<StaffRoleName, Gate>>>;

export type Permission = keyof typeof MATRIX;
export const PERMISSIONS = Object.keys(MATRIX) as Permission[];

/** The gate for `role` on `permission`, or null when the role may not do it. */
export function gateFor(role: StaffRoleName | null | undefined, permission: Permission): Gate | null {
  if (!role) return null;
  return ((MATRIX[permission] as Partial<Record<StaffRoleName, Gate>>)[role] ?? null) as Gate | null;
}

export function can(role: StaffRoleName | null | undefined, permission: Permission): boolean {
  return gateFor(role, permission) !== null;
}

/** Every permission a role holds (for the UI). */
export function permissionsOf(role: StaffRoleName | null | undefined): Permission[] {
  return PERMISSIONS.filter((p) => can(role, p));
}

/** Roles that only a SUPER_ADMIN may grant or revoke. */
export const PRIVILEGED_ROLES: StaffRoleName[] = ["SUPER_ADMIN", "ADMIN"];

/** Rank used for "you cannot grant a role above your own". */
export const ROLE_RANK: Record<StaffRoleName, number> = { SUPER_ADMIN: 5, ADMIN: 4, MODERATOR: 3, BILLING: 3, SUPPORT: 2, VIEWER: 1 };

/** Abuse categories and their triage priority (0 = most urgent). */
export const ABUSE_CATEGORIES = {
  CSAM: 0,
  PHISHING: 0,
  MALWARE: 0,
  FRAUD: 1,
  CRYPTO_MINING: 1,
  ILLEGAL: 1,
  SPAM: 2,
  COPYRIGHT: 3,
  OTHER: 2,
} as const;
export type AbuseCategory = keyof typeof ABUSE_CATEGORIES;
