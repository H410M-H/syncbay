/**
 * Syncbay PaaS — Edge WAF rules engine
 *
 * Rules are `WafRule` rows (one per IP/CIDR, path pattern, country or rate
 * limit). This module holds the pure evaluation logic (IPv4/IPv6 CIDR
 * matching, glob path patterns, precedence) plus the DB helpers the devops
 * router uses. Enforcement happens in `src/proxy.ts` via `src/lib/edge/waf.ts`.
 *
 * Precedence: IP_ALLOW > IP_BLOCK > GEO_BLOCK > PATH_BLOCK > RATE_LIMIT.
 */

import type { PrismaClient } from "@prisma/client";

export const WAF_RULE_TYPES = ["IP_BLOCK", "IP_ALLOW", "PATH_BLOCK", "GEO_BLOCK", "RATE_LIMIT"] as const;
export type WafRuleType = (typeof WAF_RULE_TYPES)[number];

/** The subset of a `WafRule` row needed to evaluate a request. */
export interface WafRuleLike {
  id: string;
  type: WafRuleType | string;
  value: string;
  rateLimitRpm?: number | null;
  enabled: boolean;
}

export interface WafRequest {
  ip: string;
  path: string;
  countryCode?: string;
}

export interface WafDecision {
  allowed: boolean;
  status: number;
  reason?: string;
  ruleId?: string;
  ruleType?: WafRuleType;
  retryAfterSec?: number;
}

/** Counter used by RATE_LIMIT rules: records a hit and returns the window count. */
export interface RateCounter {
  hit(key: string, limit: number, windowMs: number): Promise<{ count: number; resetSec: number }>;
}

/** Aggregated view used by the dashboard (backed by rule rows). */
export interface WafConfig {
  serviceId: string;
  enabled: boolean;
  rateLimitRpm: number | null;
  ipBlocklist: string[];
  ipAllowlist: string[];
  geoBlockCountries: string[];
  pathBlocklist: string[];
  ruleCount: number;
  updatedAt: string | null;
}

/** A rule that has matched real traffic (from the hit counters the proxy flushes). */
export interface SecurityEvent {
  id: string;
  serviceId: string;
  timestamp: string;
  clientIp: string;
  countryCode: string;
  actionTaken: "BLOCKED_429" | "BLOCKED_IP" | "BLOCKED_GEO" | "BLOCKED_PATH";
  ruleMatched: string;
  popRegion: string;
  path: string;
  hitCount: number;
}

// In-memory sliding window rate tracker: key -> timestamps[]
const rateWindowMap: Map<string, number[]> = new Map();

function parseIpv4ToInt(ip: string): number | null {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  let num = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = parseInt(p, 10);
    if (n < 0 || n > 255) return null;
    num = (num << 8) | n;
  }
  return num >>> 0;
}

function matchIpv4Cidr(ip: string, subnet: string, prefix: number): boolean {
  if (prefix < 0 || prefix > 32) return false;
  const ipInt = parseIpv4ToInt(ip);
  const subInt = parseIpv4ToInt(subnet);
  if (ipInt === null || subInt === null) return false;
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : ((-1 << (32 - prefix)) >>> 0);
  return (ipInt & mask) === (subInt & mask);
}

function parseIpv6ToBigInt(ip: string): bigint | null {
  const clean = ip.trim().split("%")[0];
  if (!clean.includes(":")) return null;
  if (clean.includes(":::")) return null;
  if (clean.startsWith(":") && !clean.startsWith("::")) return null;
  if (clean.endsWith(":") && !clean.endsWith("::")) return null;

  const parts = clean.split("::");
  if (parts.length > 2) return null;

  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];

  if (head.some((w) => w === "") || tail.some((w) => w === "")) return null;

  // Handle embedded IPv4 at the end (e.g. ::ffff:192.168.1.1 or ::192.168.1.1)
  const target = parts.length === 2 ? tail : head;
  if (target.length > 0 && target[target.length - 1].includes(".")) {
    const ipv4 = target.pop()!;
    const v4Parts = ipv4.split(".");
    if (v4Parts.length !== 4) return null;
    for (const p of v4Parts) {
      if (!/^\d+$/.test(p)) return null;
      const n = parseInt(p, 10);
      if (n < 0 || n > 255) return null;
    }
    const n0 = parseInt(v4Parts[0], 10);
    const n1 = parseInt(v4Parts[1], 10);
    const n2 = parseInt(v4Parts[2], 10);
    const n3 = parseInt(v4Parts[3], 10);
    target.push(((n0 << 8) | n1).toString(16));
    target.push(((n2 << 8) | n3).toString(16));
  }

  // If compressed with ::, total words cannot exceed 7 (:: must compress at least one word)
  if (parts.length === 2 && head.length + tail.length > 7) return null;

  const missing = 8 - (head.length + tail.length);
  if (missing < 0) return null;
  const middle = parts.length === 2 ? new Array(missing).fill("0") : [];
  const fullWords = [...head, ...middle, ...tail];
  if (fullWords.length !== 8) return null;

  let result = BigInt(0);
  for (const word of fullWords) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(word)) return null;
    const num = parseInt(word, 16);
    result = (result << BigInt(16)) | BigInt(num);
  }
  return result;
}

function matchIpv6Cidr(ip: string, subnet: string, prefix: number): boolean {
  if (prefix < 0 || prefix > 128) return false;
  const ipBig = parseIpv6ToBigInt(ip);
  const subBig = parseIpv6ToBigInt(subnet);
  if (ipBig === null || subBig === null) return false;
  if (prefix === 0) return true;
  if (prefix === 128) return ipBig === subBig;
  const mask = ((BigInt(1) << BigInt(128)) - BigInt(1)) ^ ((BigInt(1) << BigInt(128 - prefix)) - BigInt(1));
  return (ipBig & mask) === (subBig & mask);
}

// Max tracked IPs before triggering eviction sweep to prevent memory leak
const MAX_RATE_WINDOW_ENTRIES = 5000;

export function cleanupExpiredRateLimits(nowMs: number = Date.now(), windowMs: number = 60000) {
  const cutoff = nowMs - windowMs;
  for (const [keyIp, timestamps] of rateWindowMap.entries()) {
    const valid = timestamps.filter((t) => t > cutoff);
    if (valid.length === 0) {
      rateWindowMap.delete(keyIp);
    } else {
      rateWindowMap.set(keyIp, valid);
    }
  }
}

/**
 * Checks if an IP matches an exact IP or CIDR block (supports arbitrary IPv4 /0-32 and IPv6 /0-128)
 */
export function isIpInList(ip: string, list: string[]): boolean {
  if (!list || list.length === 0) return false;
  const cleanIp = ip.trim();
  const ipV4 = parseIpv4ToInt(cleanIp);
  const ipV6 = parseIpv6ToBigInt(cleanIp);

  for (const entry of list) {
    const cleanEntry = entry.trim();
    if (!cleanEntry) continue;
    if (cleanEntry === cleanIp) return true;

    // Check IPv6 exact match with different zero representation
    if (ipV6 !== null && !cleanEntry.includes("/")) {
      const entryV6 = parseIpv6ToBigInt(cleanEntry);
      if (entryV6 !== null && entryV6 === ipV6) return true;
    }

    if (cleanEntry.includes("/")) {
      const [subnet, prefixStr] = cleanEntry.split("/");
      const prefix = parseInt(prefixStr, 10);
      if (isNaN(prefix)) continue;

      if (ipV4 !== null && subnet.includes(".")) {
        if (matchIpv4Cidr(cleanIp, subnet, prefix)) return true;
      }

      if (ipV6 !== null && subnet.includes(":")) {
        if (matchIpv6Cidr(cleanIp, subnet, prefix)) return true;
      }
    }
  }
  return false;
}

/**
 * Evaluates sliding window rate limiting
 */
export function evaluateRateLimit(
  ip: string,
  limitRpm: number,
  windowMs: number = 60000,
  nowMs: number = Date.now()
): { allowed: boolean; currentCount: number; remaining: number; resetSec: number } {
  if (rateWindowMap.size > MAX_RATE_WINDOW_ENTRIES) {
    cleanupExpiredRateLimits(nowMs, windowMs);
  }

  const cutoff = nowMs - windowMs;
  let timestamps = rateWindowMap.get(ip) || [];

  // Remove timestamps outside window
  timestamps = timestamps.filter((t) => t > cutoff);

  if (timestamps.length >= limitRpm) {
    rateWindowMap.set(ip, timestamps);
    const oldest = timestamps[0] || nowMs;
    const resetSec = Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000));
    return {
      allowed: false,
      currentCount: timestamps.length,
      remaining: 0,
      resetSec,
    };
  }

  timestamps.push(nowMs);
  rateWindowMap.set(ip, timestamps);

  return {
    allowed: true,
    currentCount: timestamps.length,
    remaining: Math.max(0, limitRpm - timestamps.length),
    resetSec: 60,
  };
}


/** In-process sliding-window counter (per instance). */
export const memoryRateCounter: RateCounter = {
  async hit(key, limit, windowMs) {
    const res = evaluateRateLimit(key, limit, windowMs);
    return { count: res.allowed ? res.currentCount : limit + 1, resetSec: res.resetSec };
  },
};

// ─── Validation & matching helpers ───────────────────────────────────────────

/** True for a valid IPv4/IPv6 address or CIDR block. */
export function isValidIpOrCidr(entry: string): boolean {
  const value = (entry || "").trim();
  if (!value) return false;
  const [addr, prefixStr, extra] = value.split("/");
  if (extra !== undefined) return false;
  const v4 = parseIpv4ToInt(addr) !== null;
  const v6 = !v4 && parseIpv6ToBigInt(addr) !== null;
  if (!v4 && !v6) return false;
  if (prefixStr === undefined) return true;
  if (!/^\d+$/.test(prefixStr)) return false;
  const prefix = parseInt(prefixStr, 10);
  return v4 ? prefix <= 32 : prefix <= 128;
}

function normalizePath(path: string): string {
  let p = path || "/";
  try {
    p = decodeURIComponent(p);
  } catch {
    // keep raw on malformed escapes
  }
  return p.replace(/\/{2,}/g, "/");
}

const patternCache = new Map<string, RegExp>();

/**
 * Glob path match: `*` matches any run of characters (including `/`).
 * A pattern without `*` matches that exact path. Case-insensitive.
 */
export function matchPathPattern(path: string, pattern: string): boolean {
  const pat = (pattern || "").trim();
  if (!pat) return false;
  if (pat === "*" || pat === "/*") return true;
  let re = patternCache.get(pat);
  if (!re) {
    const escaped = pat.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    re = new RegExp(`^${escaped}$`, "i");
    if (patternCache.size > 1000) patternCache.clear();
    patternCache.set(pat, re);
  }
  return re.test(normalizePath(path));
}

export function validateWafRule(input: { type: string; value: string; rateLimitRpm?: number | null }): void {
  if (!(WAF_RULE_TYPES as readonly string[]).includes(input.type)) {
    throw new Error(`Unknown WAF rule type "${input.type}"`);
  }
  const value = (input.value || "").trim();
  if (!value) throw new Error("WAF rule value is required");
  if ((input.type === "IP_BLOCK" || input.type === "IP_ALLOW") && !isValidIpOrCidr(value)) {
    throw new Error(`"${value}" is not a valid IP address or CIDR block`);
  }
  if (input.type === "GEO_BLOCK" && !/^[A-Za-z]{2}$/.test(value)) {
    throw new Error(`"${value}" is not an ISO 3166-1 alpha-2 country code`);
  }
  if ((input.type === "PATH_BLOCK" || input.type === "RATE_LIMIT") && !value.startsWith("/") && !value.startsWith("*")) {
    throw new Error(`Path pattern must start with "/" or "*"`);
  }
  if (input.type === "RATE_LIMIT") {
    const rpm = input.rateLimitRpm ?? 0;
    if (!Number.isInteger(rpm) || rpm < 1 || rpm > 100000) {
      throw new Error("RATE_LIMIT rules need rateLimitRpm between 1 and 100000");
    }
  }
}

// ─── Evaluation ───────────────────────────────────────────────────────────────

const ALLOWED: WafDecision = { allowed: true, status: 200 };

/**
 * Evaluates a request against a service's rules. Only RATE_LIMIT rules touch
 * the counter; the first matching rule of the highest-precedence type wins.
 */
export async function inspectRequest(
  rules: WafRuleLike[],
  req: WafRequest,
  counter: RateCounter = memoryRateCounter
): Promise<WafDecision> {
  const active = rules.filter((r) => r.enabled);
  if (active.length === 0) return ALLOWED;
  const ip = (req.ip || "").trim();
  const byType = (t: WafRuleType) => active.filter((r) => r.type === t);

  if (ip && byType("IP_ALLOW").some((r) => isIpInList(ip, [r.value]))) return ALLOWED;

  const blockedIp = ip ? byType("IP_BLOCK").find((r) => isIpInList(ip, [r.value])) : undefined;
  if (blockedIp) {
    return { allowed: false, status: 403, reason: "Access Denied by Syncbay Edge Firewall", ruleId: blockedIp.id, ruleType: "IP_BLOCK" };
  }

  const country = (req.countryCode || "").toUpperCase();
  const geo = country ? byType("GEO_BLOCK").find((r) => r.value.toUpperCase() === country) : undefined;
  if (geo) {
    return { allowed: false, status: 403, reason: "Country geo-restricted by administrator policy", ruleId: geo.id, ruleType: "GEO_BLOCK" };
  }

  const pathRule = byType("PATH_BLOCK").find((r) => matchPathPattern(req.path, r.value));
  if (pathRule) {
    return { allowed: false, status: 403, reason: "Path blocked by Syncbay Edge Firewall", ruleId: pathRule.id, ruleType: "PATH_BLOCK" };
  }

  for (const rule of byType("RATE_LIMIT")) {
    const limit = rule.rateLimitRpm || 0;
    if (limit <= 0 || !matchPathPattern(req.path, rule.value)) continue;
    const { count, resetSec } = await counter.hit(`${rule.id}:${ip || "unknown"}`, limit, 60_000);
    if (count > limit) {
      return {
        allowed: false,
        status: 429,
        reason: `Too Many Requests. Retry after ${resetSec} seconds.`,
        ruleId: rule.id,
        ruleType: "RATE_LIMIT",
        retryAfterSec: resetSec,
      };
    }
  }
  return ALLOWED;
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

export type WafDb = Pick<PrismaClient, "wafRule" | "$transaction">;
type WafRuleRow = Awaited<ReturnType<WafDb["wafRule"]["findUniqueOrThrow"]>>;

export async function listWafRules(db: WafDb, serviceId: string): Promise<WafRuleRow[]> {
  return db.wafRule.findMany({ where: { serviceId }, orderBy: { createdAt: "asc" } });
}

export async function createWafRule(
  db: WafDb,
  input: { serviceId: string; type: WafRuleType; value: string; rateLimitRpm?: number | null; description?: string }
): Promise<WafRuleRow> {
  validateWafRule(input);
  return db.wafRule.create({
    data: {
      serviceId: input.serviceId,
      type: input.type,
      value: input.type === "GEO_BLOCK" ? input.value.trim().toUpperCase() : input.value.trim(),
      rateLimitRpm: input.type === "RATE_LIMIT" ? input.rateLimitRpm : null,
      description: input.description,
    },
  });
}

export function buildWafConfig(serviceId: string, rules: WafRuleRow[]): WafConfig {
  const values = (t: WafRuleType) => rules.filter((r) => r.type === t).map((r) => r.value);
  const rate = rules.find((r) => r.type === "RATE_LIMIT" && (r.value === "/*" || r.value === "*"));
  const updated = rules.reduce<Date | null>((acc, r) => (!acc || r.updatedAt > acc ? r.updatedAt : acc), null);
  return {
    serviceId,
    enabled: rules.length === 0 ? true : rules.some((r) => r.enabled),
    rateLimitRpm: rate?.rateLimitRpm ?? null,
    ipBlocklist: values("IP_BLOCK"),
    ipAllowlist: values("IP_ALLOW"),
    geoBlockCountries: values("GEO_BLOCK"),
    pathBlocklist: values("PATH_BLOCK"),
    ruleCount: rules.length,
    updatedAt: updated ? updated.toISOString() : null,
  };
}

export async function getWafConfig(db: WafDb, serviceId: string): Promise<WafConfig> {
  return buildWafConfig(serviceId, await listWafRules(db, serviceId));
}

/**
 * Applies the dashboard's list-style edits: each provided list replaces the
 * rules of that type (rules whose value is unchanged keep their hit counters),
 * `rateLimitRpm` upserts the site-wide `/*` RATE_LIMIT rule (null removes it)
 * and `enabled` toggles every rule of the service.
 */
export async function updateWafConfig(
  db: WafDb,
  serviceId: string,
  partial: {
    enabled?: boolean;
    rateLimitRpm?: number | null;
    ipBlocklist?: string[];
    ipAllowlist?: string[];
    geoBlockCountries?: string[];
    pathBlocklist?: string[];
  }
): Promise<WafConfig> {
  const lists: Array<[WafRuleType, string[] | undefined]> = [
    ["IP_BLOCK", partial.ipBlocklist],
    ["IP_ALLOW", partial.ipAllowlist],
    ["GEO_BLOCK", partial.geoBlockCountries?.map((c) => c.trim().toUpperCase())],
    ["PATH_BLOCK", partial.pathBlocklist],
  ];
  for (const [type, list] of lists) {
    for (const value of list || []) validateWafRule({ type, value });
  }
  if (partial.rateLimitRpm != null) validateWafRule({ type: "RATE_LIMIT", value: "/*", rateLimitRpm: partial.rateLimitRpm });

  await db.$transaction(async (tx) => {
    const existing = await tx.wafRule.findMany({ where: { serviceId } });
    const enabledDefault = existing.length === 0 ? true : existing.some((r) => r.enabled);
    const enabled = partial.enabled ?? enabledDefault;

    for (const [type, list] of lists) {
      if (!list) continue;
      const wanted = new Set(list.map((v) => v.trim()).filter(Boolean));
      const current = existing.filter((r) => r.type === type);
      const stale = current.filter((r) => !wanted.has(r.value)).map((r) => r.id);
      if (stale.length) await tx.wafRule.deleteMany({ where: { id: { in: stale } } });
      const have = new Set(current.map((r) => r.value));
      for (const value of wanted) {
        if (!have.has(value)) await tx.wafRule.create({ data: { serviceId, type, value, enabled } });
      }
    }

    if (partial.rateLimitRpm !== undefined) {
      const site = existing.find((r) => r.type === "RATE_LIMIT" && (r.value === "/*" || r.value === "*"));
      if (partial.rateLimitRpm === null) {
        if (site) await tx.wafRule.delete({ where: { id: site.id } });
      } else if (site) {
        await tx.wafRule.update({ where: { id: site.id }, data: { rateLimitRpm: partial.rateLimitRpm } });
      } else {
        await tx.wafRule.create({
          data: { serviceId, type: "RATE_LIMIT", value: "/*", rateLimitRpm: partial.rateLimitRpm, enabled, description: "Site-wide rate limit" },
        });
      }
    }

    if (partial.enabled !== undefined) {
      await tx.wafRule.updateMany({ where: { serviceId }, data: { enabled: partial.enabled } });
    }
  });

  return getWafConfig(db, serviceId);
}

const ACTION_BY_TYPE: Record<string, SecurityEvent["actionTaken"]> = {
  IP_BLOCK: "BLOCKED_IP",
  GEO_BLOCK: "BLOCKED_GEO",
  PATH_BLOCK: "BLOCKED_PATH",
  RATE_LIMIT: "BLOCKED_429",
};

/** Rules that have blocked real requests, most recent first. */
export async function getSecurityEvents(db: WafDb, serviceId: string, limit = 50): Promise<SecurityEvent[]> {
  const rows = await db.wafRule.findMany({
    where: { serviceId, hitCount: { gt: 0 }, lastHitAt: { not: null } },
    orderBy: { lastHitAt: "desc" },
    take: limit,
  });
  return rows.map((r) => ({
    id: r.id,
    serviceId,
    timestamp: r.lastHitAt!.toISOString(),
    clientIp: r.lastHitIp || "unknown",
    countryCode: r.type === "GEO_BLOCK" ? r.value : "",
    actionTaken: ACTION_BY_TYPE[r.type] || "BLOCKED_IP",
    ruleMatched: r.description || `${r.type} ${r.value}${r.rateLimitRpm ? ` (${r.rateLimitRpm} rpm)` : ""}`,
    popRegion: "edge",
    path: r.lastHitPath || "/",
    hitCount: r.hitCount,
  }));
}
