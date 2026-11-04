/**
 * Verifies HMAC-signed runner → control plane requests (pull-mode job claim / events).
 * Same canonical string and headers as control plane → runner (`signRequest()`), checked
 * timing-safe within a 5 minute window. Accepted signatures are remembered per instance so a
 * replay to the same instance is rejected; the job lease (`leaseOwner`) bounds what a replay
 * to another instance could do.
 */

import crypto from "node:crypto";
import { resolveRunnerSecret, signRequest } from "./runner-driver";

const TOLERANCE_MS = 300_000;
const seen = new Map<string, number>();

export function verifyRunnerRequest(headers: Headers, method: string, pathname: string, body: string): boolean {
  let secret: string;
  try {
    secret = resolveRunnerSecret();
  } catch {
    return false; // production without RUNNER_SECRET
  }
  const signature = (headers.get("x-syncbay-signature") || "").replace(/^sha256=/, "").trim().toLowerCase();
  const timestamp = headers.get("x-syncbay-timestamp") || "";
  if (!/^[a-f0-9]{64}$/.test(signature) || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(Date.now() - Number(timestamp)) > TOLERANCE_MS) return false;

  const expected = signRequest(secret, method, pathname, body, timestamp).signature;
  if (!crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) return false;

  const now = Date.now();
  for (const [sig, exp] of seen) if (exp <= now) seen.delete(sig);
  if (seen.has(signature)) return false;
  seen.set(signature, Number(timestamp) + TOLERANCE_MS);
  return true;
}
