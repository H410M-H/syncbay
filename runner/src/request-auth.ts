/**
 * Syncbay Runner Agent — signed-request verification.
 *
 * Canonical string (must match `signRequest()` in src/lib/orchestrator/runner-driver.ts):
 *
 *   `${ts}.${nonce}.${METHOD}.${path}.${body}`
 *
 * - `ts`    milliseconds since the epoch (`X-Syncbay-Timestamp`), accepted within ±5 min.
 * - `nonce` 16 random bytes, hex (`X-Syncbay-Nonce`; the SSE log route also takes `?nonce=`).
 * - Every accepted nonce is remembered until its timestamp leaves the window, so a signed
 *   request of ANY method is single-use: a replay, or a second request reusing the nonce, gets 401.
 *   Two legitimate requests signed in the same millisecond differ by nonce, so they never collide.
 */

import * as crypto from "node:crypto";

export const SIGNATURE_TOLERANCE_MS = 300000;
const NONCE_PATTERN = /^[a-f0-9]{32}$/i;
const DEFAULT_MAX_NONCES = 200000;

export interface SignedRequestParts {
  method: string;
  pathname: string;
  body: string;
  signature: string | undefined;
  timestamp: string | undefined;
  nonce: string | undefined;
}

/** Pure check of signature, timestamp window and nonce format. Does not consume the nonce. */
export function verifyCanonicalSignature(secret: string, parts: SignedRequestParts, now: number = Date.now()): boolean {
  const { signature, timestamp, nonce } = parts;
  if (!secret || !signature || !timestamp || !nonce) return false;
  if (!/^\d+$/.test(timestamp) || !NONCE_PATTERN.test(nonce)) return false;
  const ts = Number(timestamp);
  if (!Number.isSafeInteger(ts) || Math.abs(now - ts) > SIGNATURE_TOLERANCE_MS) return false;

  const provided = signature.replace(/^sha256=/, "").trim();
  if (!/^[a-f0-9]{64}$/i.test(provided)) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${nonce}.${parts.method.toUpperCase()}.${parts.pathname}.${parts.body}`)
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
}

/**
 * TTL set of accepted nonces. Entries expire when their request timestamp leaves the
 * tolerance window (after which the timestamp check alone rejects a replay). The set is
 * bounded; past `maxEntries` the oldest entries are evicted first.
 */
export class NonceCache {
  private readonly entries = new Map<string, number>();
  constructor(private readonly maxEntries: number = DEFAULT_MAX_NONCES) {}

  /** Records `nonce`; returns false when it was already used. */
  consume(nonce: string, timestampMs: number, now: number = Date.now()): boolean {
    this.sweep(now);
    const key = nonce.toLowerCase();
    if (this.entries.has(key)) return false;
    this.entries.set(key, timestampMs + SIGNATURE_TOLERANCE_MS);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return true;
  }

  get size(): number {
    return this.entries.size;
  }

  private sweep(now: number): void {
    for (const [key, expiry] of this.entries) {
      if (expiry <= now) this.entries.delete(key);
    }
  }
}

/** Verifies the signature, then consumes the nonce (only authentic requests can burn a nonce). */
export function verifyAndConsume(secret: string, cache: NonceCache, parts: SignedRequestParts): boolean {
  if (!verifyCanonicalSignature(secret, parts)) return false;
  return cache.consume(parts.nonce!, Number(parts.timestamp));
}
