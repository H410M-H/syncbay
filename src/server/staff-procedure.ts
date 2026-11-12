/**
 * `staffProcedure(permission)` — the only way into the staff console's API.
 *
 * - Not staff (or staff access revoked): NOT_FOUND, so the console's existence is not confirmed.
 * - Staff without the permission: FORBIDDEN, and a DENIED row in the staff audit log.
 * - Permissions gated "reason" or "confirm" require `input.reason` (at least 8 characters);
 *   "confirm" also requires `input.confirm` to match the target's name (checked by the handler
 *   with `ctx.staff.assertConfirmed`).
 * - `ctx.staff.audit()` appends an ALLOWED/FAILED row carrying the caller's IP and user agent.
 */

import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "./trpc";
import { gateFor, type Gate, type Permission, type StaffRoleName } from "@/lib/admin/permissions";
import { getStaffIdentity, recordStaffEvent, type StaffEvent } from "@/lib/admin/staff";

export interface StaffContext {
  userId: string;
  role: StaffRoleName;
  pinned: boolean;
  gate: Gate;
  permission: Permission;
  reason: string | null;
  audit: (event: Omit<StaffEvent, "permission" | "reason" | "ip" | "userAgent"> & { reason?: string | null }) => Promise<void>;
  /** Checks `input.confirm` against `expected`. Applies to "confirm" gates, or always with `required`. */
  assertConfirmed: (expected: string, required?: boolean) => void;
}

const MIN_REASON = 8;

export function staffProcedure(permission: Permission) {
  return protectedProcedure.use(async ({ ctx, next, getRawInput }) => {
    const userId = (ctx.session.user as { id?: string }).id;
    const identity = await getStaffIdentity(userId, ctx.db);
    if (!identity) throw new TRPCError({ code: "NOT_FOUND" });

    const ip = ctx.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || ctx.headers.get("x-real-ip") || null;
    const userAgent = ctx.headers.get("user-agent");
    const actor = { userId: identity.userId, role: identity.role };
    const gate = gateFor(identity.role, permission);
    if (!gate) {
      await recordStaffEvent(actor, { action: `denied:${permission}`, outcome: "DENIED", permission, ip, userAgent }, ctx.db);
      throw new TRPCError({ code: "FORBIDDEN", message: `Your role (${identity.role}) does not allow ${permission}.` });
    }

    const raw = ((await getRawInput().catch(() => undefined)) ?? {}) as { reason?: unknown; confirm?: unknown };
    const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
    if (gate !== "allow" && reason.length < MIN_REASON) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `A reason of at least ${MIN_REASON} characters is required for ${permission}.` });
    }
    const confirm = typeof raw.confirm === "string" ? raw.confirm.trim() : "";

    const staff: StaffContext = {
      ...identity,
      gate,
      permission,
      reason: reason || null,
      audit: (event) =>
        recordStaffEvent(actor, { ...event, permission, reason: event.reason ?? (reason || null), ip, userAgent }, ctx.db),
      assertConfirmed: (expected, required = false) => {
        if (gate !== "confirm" && !required) return;
        if (!expected || confirm.toLowerCase() !== expected.trim().toLowerCase()) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `Type "${expected}" to confirm.` });
        }
      },
    };
    return next({ ctx: { staff } });
  });
}

