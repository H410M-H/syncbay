/**
 * Syncbay PaaS — WAF enforcement for `src/proxy.ts`
 *
 * `enforceWaf(req, host)` returns a 403/429 response for a blocked request and
 * null otherwise. Rules come from `getEdgePolicy` (15 s cache). Rate limits use
 * fixed one-minute windows in Upstash Redis (`INCR` + `EXPIRE` over REST) when
 * `UPSTASH_REDIS_REST_URL`/`_TOKEN` are set, else an in-process sliding window
 * (per instance). Hits are batched and flushed to `WafRule.hitCount`.
 */

import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getEdgePolicy } from "@/lib/edge/edge-policy";
import { inspectRequest, memoryRateCounter, type RateCounter, type WafDecision } from "@/lib/devops/waf-engine";

const RATE_KEY_PREFIX = "syncbay:waf:rl:";

/** Fixed-window counter in Upstash Redis over its REST API. */
export class UpstashRateCounter implements RateCounter {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 800
  ) {}

  async hit(key: string, _limit: number, windowMs: number): Promise<{ count: number; resetSec: number }> {
    const windowSec = Math.max(1, Math.round(windowMs / 1000));
    const nowSec = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(nowSec / windowSec);
    const redisKey = `${RATE_KEY_PREFIX}${key}:${bucket}`;
    const res = await globalThis.fetch(`${this.baseUrl.replace(/\/$/, "")}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify([
        ["INCR", redisKey],
        ["EXPIRE", redisKey, String(windowSec + 5)],
      ]),
      cache: "no-store",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Upstash REST HTTP ${res.status}`);
    const json = (await res.json()) as Array<{ result?: unknown; error?: string }>;
    const first = Array.isArray(json) ? json[0] : null;
    if (!first || first.error) throw new Error(`Upstash REST error: ${first?.error || "empty reply"}`);
    return { count: Number(first.result) || 0, resetSec: Math.max(1, (bucket + 1) * windowSec - nowSec) };
  }
}

function getRateCounter(): RateCounter {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return memoryRateCounter;
  const upstash = new UpstashRateCounter(url, token);
  // Upstash outage: fall back to the per-instance window instead of failing open completely.
  return {
    hit: (key, limit, windowMs) => upstash.hit(key, limit, windowMs).catch(() => memoryRateCounter.hit(key, limit, windowMs)),
  };
}

/** Client IP as seen by the edge: Cloudflare, then the platform's forwarding headers. */
export function clientIpFrom(headers: Headers): string {
  const direct = headers.get("cf-connecting-ip") || headers.get("x-real-ip");
  if (direct) return direct.trim();
  const forwarded = headers.get("x-forwarded-for");
  return forwarded ? forwarded.split(",")[0].trim() : "";
}

// ─── Hit counters (batched writes) ───────────────────────────────────────────

const pendingHits = new Map<string, { count: number; ip: string; path: string; at: Date }>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function recordHit(ruleId: string, ip: string, path: string): void {
  const entry = pendingHits.get(ruleId);
  if (entry) {
    entry.count++;
    entry.ip = ip;
    entry.path = path;
    entry.at = new Date();
  } else {
    pendingHits.set(ruleId, { count: 1, ip, path, at: new Date() });
  }
  if (!flushTimer) {
    flushTimer = setTimeout(() => void flushWafHits(), 2_000);
    (flushTimer as { unref?: () => void }).unref?.();
  }
}

/** Writes accumulated hit counts to `WafRule` rows. Never throws. */
export async function flushWafHits(): Promise<void> {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  const batch = Array.from(pendingHits.entries());
  pendingHits.clear();
  await Promise.all(
    batch.map(([id, hit]) =>
      db.wafRule
        .update({
          where: { id },
          data: { hitCount: { increment: hit.count }, lastHitAt: hit.at, lastHitIp: hit.ip.slice(0, 64), lastHitPath: hit.path.slice(0, 512) },
        })
        .catch(() => null)
    )
  );
}

// ─── Proxy hook ───────────────────────────────────────────────────────────────

function blockedResponse(decision: WafDecision): NextResponse {
  const headers: Record<string, string> = { "x-syncbay-waf": decision.ruleType || "BLOCK" };
  if (decision.retryAfterSec) headers["Retry-After"] = String(decision.retryAfterSec);
  return NextResponse.json(
    { error: decision.status === 429 ? "Too Many Requests" : "Forbidden", message: decision.reason },
    { status: decision.status, headers }
  );
}

/** Returns a block response when the host's WAF rules reject the request, else null. */
export async function enforceWaf(req: NextRequest, host: string): Promise<NextResponse | null> {
  const policy = await getEdgePolicy(host);
  if (!policy || policy.wafRules.length === 0) return null;
  const ip = clientIpFrom(req.headers);
  const path = req.nextUrl.pathname;
  const countryCode = req.headers.get("x-vercel-ip-country") || req.headers.get("cf-ipcountry") || undefined;
  let decision: WafDecision;
  try {
    decision = await inspectRequest(policy.wafRules, { ip, path, countryCode }, getRateCounter());
  } catch {
    return null;
  }
  if (decision.allowed) return null;
  if (decision.ruleId) recordHit(decision.ruleId, ip, path);
  return blockedResponse(decision);
}
