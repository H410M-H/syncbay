/**
 * Who is Syncbay staff, and the audit trail of what they do.
 *
 * - A user is staff while they have a `StaffMember` row without `revokedAt`. The role is read
 *   from the database on every request, so revoking it takes effect at once.
 * - `SUPER_ADMIN_EMAILS` (comma-separated) bootstraps the first super admins. An address listed
 *   there only counts when the account has a GitHub or Google sign-in linked (an email verified
 *   by the provider), never for a password-only account, and it cannot be revoked in the console.
 * - Every staff action writes a `StaffAuditEvent` (allowed, denied or failed). The table is
 *   append-only in the database.
 */

import { db } from "@/lib/db";
import type { StaffRoleName } from "./permissions";

type Client = any;

export interface StaffIdentity {
  userId: string;
  role: StaffRoleName;
  /** Listed in SUPER_ADMIN_EMAILS: cannot be revoked or demoted from the console. */
  pinned: boolean;
}

export function superAdminEmails(env: NodeJS.ProcessEnv = process.env): string[] {
  return String(env.SUPER_ADMIN_EMAILS || "")
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes("@"));
}

/** The caller's staff role, bootstrapping a SUPER_ADMIN_EMAILS account on first use. */
export async function getStaffIdentity(userId: string | null | undefined, client: Client = db): Promise<StaffIdentity | null> {
  if (!userId) return null;
  const user = await client.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      suspendedAt: true,
      staffMember: { select: { role: true, revokedAt: true } },
      accounts: { where: { provider: { in: ["github", "google"] } }, select: { provider: true } },
    },
  });
  if (!user || user.suspendedAt) return null;

  const pinned = superAdminEmails().includes(String(user.email).toLowerCase()) && user.accounts.length > 0;
  if (pinned) {
    if (!user.staffMember || user.staffMember.revokedAt || user.staffMember.role !== "SUPER_ADMIN") {
      await client.staffMember.upsert({
        where: { userId: user.id },
        create: { userId: user.id, role: "SUPER_ADMIN", note: "Bootstrapped from SUPER_ADMIN_EMAILS" },
        update: { role: "SUPER_ADMIN", revokedAt: null, note: "Bootstrapped from SUPER_ADMIN_EMAILS" },
      });
      await recordStaffEvent(
        { userId: user.id, role: "SUPER_ADMIN" },
        { action: "staff.bootstrap", outcome: "ALLOWED", targetType: "user", targetId: user.id, reason: "SUPER_ADMIN_EMAILS" },
        client
      );
    }
    return { userId: user.id, role: "SUPER_ADMIN", pinned: true };
  }
  if (!user.staffMember || user.staffMember.revokedAt) return null;
  return { userId: user.id, role: user.staffMember.role as StaffRoleName, pinned: false };
}

export interface StaffEvent {
  action: string;
  outcome: "ALLOWED" | "DENIED" | "FAILED";
  permission?: string;
  targetType?: string;
  targetId?: string;
  workspaceId?: string | null;
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

/** Appends one row to the staff audit log. Never throws: an audit failure is logged loudly. */
export async function recordStaffEvent(
  actor: { userId: string | null; role: string | null },
  event: StaffEvent,
  client: Client = db
): Promise<void> {
  try {
    await client.staffAuditEvent.create({
      data: {
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: event.action,
        outcome: event.outcome,
        permission: event.permission ?? null,
        targetType: event.targetType ?? null,
        targetId: event.targetId ?? null,
        workspaceId: event.workspaceId ?? null,
        reason: event.reason ?? null,
        ip: event.ip ?? null,
        userAgent: event.userAgent ? event.userAgent.slice(0, 300) : null,
        metadata: (event.metadata as any) ?? undefined,
      },
    });
  } catch (err) {
    console.error("[staff-audit] FAILED to record staff event", event.action, (err as Error)?.message);
  }
}
