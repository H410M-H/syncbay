import { timingSafeEqual } from "node:crypto";

/**
 * Checks `Authorization: Bearer <secret>` / `x-runner-secret` against
 * RUNNER_SECRET (or SYNCBAY_WEBHOOK_SECRET). Returns false when no secret is
 * configured; callers decide whether an unset secret is acceptable.
 */
export function hasValidRunnerSecret(headers: Headers): boolean {
  const configured = process.env.RUNNER_SECRET || process.env.SYNCBAY_WEBHOOK_SECRET;
  if (!configured) return false;
  const raw = headers.get("authorization") || headers.get("x-runner-secret");
  if (!raw) return false;
  const token = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
  const a = Buffer.from(token);
  const b = Buffer.from(configured);
  return a.length === b.length && timingSafeEqual(a, b);
}
