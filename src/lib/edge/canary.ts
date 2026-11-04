/**
 * Syncbay PaaS — Canary traffic split for `src/proxy.ts`
 *
 * While a service's `CanaryConfig` is ACTIVE, each client is assigned to the
 * stable or canary upstream by weight and pinned with the `sb_canary` cookie
 * (`<configId>.<variant>`, 24 h). After a rollback the stable upstream keeps
 * serving only while the live route still points at the canary upstream, so
 * a later deploy is never overridden. Routed-request counts are batched into
 * `CanaryConfig.stableRequests` / `canaryRequests`.
 */

import type { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getEdgePolicy } from "@/lib/edge/edge-policy";
import { pickVariant, type CanaryStatus, type CanaryVariant } from "@/lib/devops/canary-engine";

export const CANARY_COOKIE = "sb_canary";
const COOKIE_MAX_AGE_SECS = 24 * 60 * 60;

export interface CanarySelection {
  variant: CanaryVariant;
  upstreamUrl: string;
  targetPort?: number;
  /** Sets the sticky cookie on the outgoing response (no-op when already pinned). */
  applyCookie(res: NextResponse): NextResponse;
}

function sameOrigin(a: string | undefined, b: string): boolean {
  if (!a) return false;
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function portOf(url: string): number | undefined {
  try {
    const u = new URL(url);
    if (u.port) return parseInt(u.port, 10);
  } catch {
    // ignore
  }
  return undefined;
}

/** Uniform number in [0, 100) from the Web Crypto RNG. */
function randomPercent(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return (buf[0] / 0x1_0000_0000) * 100;
}

// ─── Stats (batched) ─────────────────────────────────────────────────────────

const pendingStats = new Map<string, { stable: number; canary: number }>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function countRequest(configId: string, variant: CanaryVariant): void {
  const entry = pendingStats.get(configId) || { stable: 0, canary: 0 };
  entry[variant]++;
  pendingStats.set(configId, entry);
  if (!flushTimer) {
    flushTimer = setTimeout(() => void flushCanaryStats(), 5_000);
    (flushTimer as { unref?: () => void }).unref?.();
  }
}

/** Writes accumulated routed-request counts to `CanaryConfig`. Never throws. */
export async function flushCanaryStats(): Promise<void> {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  const batch = Array.from(pendingStats.entries());
  pendingStats.clear();
  await Promise.all(
    batch.map(([id, s]) =>
      db.canaryConfig
        .update({ where: { id }, data: { stableRequests: { increment: s.stable }, canaryRequests: { increment: s.canary } } })
        .catch(() => null)
    )
  );
}

// ─── Proxy hook ───────────────────────────────────────────────────────────────

/**
 * Picks the upstream for an ACTIVE route under a canary release, or null to
 * keep the route's own upstream. `liveUpstream` is the route's upstream URL.
 */
export async function selectCanaryUpstream(
  req: NextRequest,
  host: string,
  liveUpstream?: string
): Promise<CanarySelection | null> {
  const policy = await getEdgePolicy(host);
  const canary = policy?.canary;
  if (!canary) return null;

  const status = canary.status as CanaryStatus;
  if (status === "PROMOTED") return null;
  if (status === "ROLLED_BACK" && !sameOrigin(liveUpstream, canary.canaryUpstreamUrl)) return null;

  const raw = req.cookies.get(CANARY_COOKIE)?.value || "";
  const [cookieConfigId, cookieVariant] = raw.split(".");
  const sticky = cookieConfigId === canary.id && (cookieVariant === "stable" || cookieVariant === "canary") ? cookieVariant : null;

  const variant = pickVariant({ status, canaryWeightPercent: canary.weightPercent }, randomPercent(), sticky);
  const upstreamUrl = variant === "canary" ? canary.canaryUpstreamUrl : canary.stableUpstreamUrl;
  if (status === "ACTIVE") countRequest(canary.id, variant);

  const needsCookie = status === "ACTIVE" && sticky !== variant;
  return {
    variant,
    upstreamUrl,
    targetPort: portOf(upstreamUrl),
    applyCookie(res) {
      if (needsCookie) {
        res.cookies.set(CANARY_COOKIE, `${canary.id}.${variant}`, {
          path: "/",
          httpOnly: true,
          sameSite: "lax",
          secure: req.nextUrl.protocol === "https:",
          maxAge: COOKIE_MAX_AGE_SECS,
        });
      }
      return res;
    },
  };
}
