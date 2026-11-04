import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Authorizes a cron invocation: `Authorization: Bearer <CRON_SECRET>` (Vercel
 * Cron sends exactly this when CRON_SECRET is set), compared in constant time.
 * No header is trusted on its own and there is no default secret. Only outside
 * production, with CRON_SECRET unset, is an unauthenticated call allowed (local dev).
 */
export function isAuthorizedCronRequest(headers: Headers): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  const header = headers.get("authorization") || "";
  if (!header.startsWith("Bearer ")) return false;
  // Hash both sides so lengths match and nothing leaks through timing.
  const provided = createHash("sha256").update(header.slice(7)).digest();
  const expected = createHash("sha256").update(secret).digest();
  return timingSafeEqual(provided, expected);
}
