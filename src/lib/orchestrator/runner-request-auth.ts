/**
 * Verifies HMAC-signed runner → control plane requests (pull-mode job claim / events).
 * Same canonical string and headers as control plane → runner (`signRequest()`):
 * `${ts}.${nonce}.${METHOD}.${path}.${body}` in `X-Syncbay-Signature` / `-Timestamp` / `-Nonce`,
 * checked timing-safe within a ±5 minute window. Accepted nonces are remembered per instance
 * so a replay to the same instance gets 401; the job lease (`leaseOwner`) bounds what a replay
 * to another instance could do.
 */

import crypto from "node:crypto";
import { resolveRunnerSecret, signRequest } from "./runner-driver";

const TOLERANCE_MS = 300_000;
const MAX_NONCES = 100_000;
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
  const nonce = (headers.get("x-syncbay-nonce") || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(signature) || !/^\d+$/.test(timestamp) || !/^[a-f0-9]{32}$/.test(nonce)) return false;
  if (Math.abs(Date.now() - Number(timestamp)) > TOLERANCE_MS) return false;

  const expected = signRequest(secret, method, pathname, body, timestamp, nonce).signature;
  if (!crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) return false;

  const now = Date.now();
  for (const [key, exp] of seen) if (exp <= now) seen.delete(key);
  if (seen.has(nonce)) return false;
  seen.set(nonce, Number(timestamp) + TOLERANCE_MS);
  while (seen.size > MAX_NONCES) {
    const oldest = seen.keys().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
  return true;
}
