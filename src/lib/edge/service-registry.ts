/**
 * Syncbay PaaS — Edge Service Registry (two-tier)
 *
 * L1: per-process in-memory Map with a short TTL (15s for ACTIVE routes, 2s for
 *     every other status so BUILDING → ACTIVE is picked up quickly) plus a 5s
 *     negative cache for unknown hosts.
 * L2: a shared `L2Store` — Upstash Redis over REST when configured, the Prisma
 *     resolver (`resolveServiceRouteFromDb`) when `DATABASE_URL` is set, or an
 *     in-process memory store as the last resort.
 *
 * `proxy.ts`, route handlers and the orchestrator run in separate module
 * instances, so a process-local Map alone never propagates writes. Writers call
 * `registerServiceRouteAsync` / `removeServiceRouteAsync` (write-through to L2);
 * the proxy calls `resolveServiceRoute` (L1, hydrating from L2 on a miss).
 * The sync exports are L1-only (plus the in-process memory store) and kept for
 * backwards compatibility.
 */

export type ServiceRouteStatus =
  | "ACTIVE"
  | "QUEUED"
  | "BUILDING"
  | "DEPLOYING"
  | "SLEEPING"
  | "FAILED"
  | "CRASHED"
  | "CANCELLED"
  | string;

export interface ServiceRouteEntry {
  hostname: string;
  targetPort?: number;
  status: ServiceRouteStatus;
  upstreamUrl?: string;
  isLocal?: boolean;
  updatedAt: number;
}

/**
 * Normalizes a hostname to ensure consistent case-insensitive routing.
 * Strips protocol and port if included.
 */
export function normalizeHostname(hostname: string): string {
  if (!hostname || typeof hostname !== "string") return "";
  let clean = hostname.trim().toLowerCase();
  // Strip protocol if present
  if (clean.includes("://")) {
    clean = clean.split("://")[1];
  }
  // Strip path if present
  if (clean.includes("/")) {
    clean = clean.split("/")[0];
  }
  // Strip port if present
  if (clean.includes(":")) {
    clean = clean.split(":")[0];
  }
  return clean;
}

// ─── TTLs ─────────────────────────────────────────────────────────────────────
const L1_ACTIVE_TTL_MS = 15_000;
const L1_TRANSIENT_TTL_MS = 2_000;
const L1_NEGATIVE_TTL_MS = 5_000;
const L2_TTL_SECS = 7 * 24 * 60 * 60;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function l1TtlFor(status: ServiceRouteStatus): number {
  return status === "ACTIVE" ? L1_ACTIVE_TTL_MS : L1_TRANSIENT_TTL_MS;
}

/**
 * Standalone Edge Service Registry instance class (the L1 tier).
 */
export class EdgeServiceRegistry {
  private routes = new Map<string, ServiceRouteEntry>();
  private expiresAt = new Map<string, number>();

  /**
   * Registers or updates a service route.
   */
  registerServiceRoute(
    hostname: string,
    targetPort?: number,
    status: ServiceRouteStatus = "ACTIVE",
    upstreamUrl?: string,
    isLocal?: boolean
  ): ServiceRouteEntry | null {
    const normalized = normalizeHostname(hostname);
    if (!normalized) return null;

    const resolvedUpstream =
      upstreamUrl || (targetPort !== undefined ? `http://localhost:${targetPort}` : undefined);

    const entry: ServiceRouteEntry = {
      hostname: normalized,
      targetPort,
      status,
      upstreamUrl: resolvedUpstream,
      isLocal,
      updatedAt: Date.now(),
    };
    this.setEntry(normalized, entry);
    return { ...entry };
  }

  /**
   * Stores an entry verbatim under `hostname` with a status-dependent TTL.
   */
  setEntry(hostname: string, entry: ServiceRouteEntry, ttlMs = l1TtlFor(entry.status)): void {
    const normalized = normalizeHostname(hostname);
    if (!normalized) return;
    this.routes.set(normalized, { ...entry });
    this.expiresAt.set(normalized, Date.now() + ttlMs);
  }

  private findKey(normalized: string): string | null {
    if (!normalized) return null;
    if (this.routes.has(normalized)) return normalized;

    // Fallback: Check if .localhost alias maps to .syncbay.app or direct name
    if (normalized.endsWith(".localhost")) {
      const prefix = normalized.slice(0, -".localhost".length);
      if (this.routes.has(`${prefix}.syncbay.app`)) return `${prefix}.syncbay.app`;
      if (this.routes.has(prefix)) return prefix;
    }

    // Fallback: Check first subdomain label
    if (normalized.includes(".")) {
      const firstLabel = normalized.split(".")[0];
      if (this.routes.has(firstLabel)) return firstLabel;
    }

    return null;
  }

  /**
   * Retrieves a service route by hostname (case-insensitive), ignoring TTL.
   */
  getServiceRoute(hostname: string): ServiceRouteEntry | null {
    const key = this.findKey(normalizeHostname(hostname));
    const entry = key ? this.routes.get(key) : undefined;
    return entry ? { ...entry } : null;
  }

  /**
   * Retrieves a service route only if its L1 TTL has not expired.
   */
  getFreshServiceRoute(hostname: string): ServiceRouteEntry | null {
    const key = this.findKey(normalizeHostname(hostname));
    if (!key) return null;
    if ((this.expiresAt.get(key) ?? 0) <= Date.now()) return null;
    const entry = this.routes.get(key);
    return entry ? { ...entry } : null;
  }

  /**
   * Removes a service route by hostname. Returns true if removed, false otherwise.
   */
  removeServiceRoute(hostname: string): boolean {
    const normalized = normalizeHostname(hostname);
    if (!normalized) return false;
    this.expiresAt.delete(normalized);
    return this.routes.delete(normalized);
  }

  /**
   * Clears all registered service routes. Safe no-op on empty registry.
   */
  clearServiceRoutes(): void {
    this.routes.clear();
    this.expiresAt.clear();
  }

  /**
   * Lists all currently registered service routes.
   */
  listRoutes(): ServiceRouteEntry[] {
    return Array.from(this.routes.values()).map((entry) => ({ ...entry }));
  }
}

// ─── L2 Stores ────────────────────────────────────────────────────────────────

/** Shared, cross-process route store behind the L1 cache. */
export interface L2Store {
  readonly kind: string;
  get(hostname: string): Promise<ServiceRouteEntry | null>;
  set(hostname: string, entry: ServiceRouteEntry): Promise<void>;
  delete(hostname: string): Promise<void>;
}

/** Hostname variants to try in key/value stores (mirrors the L1 alias rules). */
function candidateKeys(normalized: string): string[] {
  const keys = [normalized];
  if (normalized.endsWith(".localhost")) {
    const prefix = normalized.slice(0, -".localhost".length);
    keys.push(`${prefix}.syncbay.app`, prefix);
  }
  return keys;
}

/** In-process store; only useful in single-process dev/tests. */
export class MemoryStore implements L2Store {
  readonly kind = "memory";
  private readonly map = new Map<string, ServiceRouteEntry>();

  getSync(hostname: string): ServiceRouteEntry | null {
    for (const key of candidateKeys(normalizeHostname(hostname))) {
      const hit = this.map.get(key);
      if (hit) return { ...hit };
    }
    return null;
  }
  setSync(hostname: string, entry: ServiceRouteEntry): void {
    const key = normalizeHostname(hostname);
    if (key) this.map.set(key, { ...entry });
  }
  deleteSync(hostname: string): void {
    this.map.delete(normalizeHostname(hostname));
  }
  clear(): void {
    this.map.clear();
  }

  async get(hostname: string) {
    return this.getSync(hostname);
  }
  async set(hostname: string, entry: ServiceRouteEntry) {
    this.setSync(hostname, entry);
  }
  async delete(hostname: string) {
    this.deleteSync(hostname);
  }
}

/**
 * Upstash Redis over its REST API (plain fetch, no SDK). Each route is stored
 * as JSON under `syncbay:edge:route:<host>`; `syncbay:edge:routes` is a set
 * index of registered hosts so listing never needs SCAN.
 */
export class UpstashRestStore implements L2Store {
  readonly kind = "upstash";
  static readonly KEY_PREFIX = "syncbay:edge:route:";
  static readonly INDEX_KEY = "syncbay:edge:routes";

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 1_000
  ) {}

  private async call(path: string, body: unknown): Promise<unknown> {
    const res = await globalThis.fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Upstash REST HTTP ${res.status}`);
    type Reply = { result?: unknown; error?: string } | null;
    const json = (await res.json()) as Reply | Reply[];
    if (Array.isArray(json)) {
      const failed = json.find((r) => r?.error);
      if (failed) throw new Error(`Upstash REST error: ${failed.error}`);
      return json.map((r) => r?.result);
    }
    if (json?.error) throw new Error(`Upstash REST error: ${json.error}`);
    return json?.result;
  }

  async get(hostname: string): Promise<ServiceRouteEntry | null> {
    const keys = candidateKeys(normalizeHostname(hostname)).map((k) => UpstashRestStore.KEY_PREFIX + k);
    const values = ((await this.call("", ["MGET", ...keys])) as Array<string | null> | null) || [];
    for (const raw of values) {
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as ServiceRouteEntry;
        if (parsed && typeof parsed.status === "string") return parsed;
      } catch {
        // skip corrupt value
      }
    }
    return null;
  }

  async set(hostname: string, entry: ServiceRouteEntry): Promise<void> {
    const host = normalizeHostname(hostname);
    await this.call("/pipeline", [
      ["SET", UpstashRestStore.KEY_PREFIX + host, JSON.stringify(entry), "EX", String(L2_TTL_SECS)],
      ["SADD", UpstashRestStore.INDEX_KEY, host],
    ]);
  }

  async delete(hostname: string): Promise<void> {
    const host = normalizeHostname(hostname);
    await this.call("/pipeline", [
      ["DEL", UpstashRestStore.KEY_PREFIX + host],
      ["SREM", UpstashRestStore.INDEX_KEY, host],
    ]);
  }
}

const PLATFORM_SUFFIXES = [".syncbay.app", ".localhost"];

/**
 * Read-only store backed by Postgres via `resolveServiceRouteFromDb`. Writes are
 * no-ops: deployment rows are already the source of truth. Platform hosts use
 * the subdomain heuristics; any other host must match a verified Domain exactly.
 */
export class DbResolveStore implements L2Store {
  readonly kind = "db";

  async get(hostname: string): Promise<ServiceRouteEntry | null> {
    const host = normalizeHostname(hostname);
    if (!host) return null;
    const suffix = PLATFORM_SUFFIXES.find((s) => host.endsWith(s));
    const { resolveServiceRouteFromDb } = await import("./resolve");
    const entry = suffix
      ? await resolveServiceRouteFromDb(host.slice(0, -suffix.length))
      : await resolveServiceRouteFromDb(host, { exactHostname: host.includes(".") });
    return entry ? { ...entry, hostname: host } : null;
  }
  async set(): Promise<void> {}
  async delete(): Promise<void> {}
}

/** Tries each store in order on read; writes go to every store. */
class ChainedStore implements L2Store {
  readonly kind: string;
  constructor(private readonly stores: L2Store[]) {
    this.kind = stores.map((s) => s.kind).join("+");
  }
  async get(hostname: string): Promise<ServiceRouteEntry | null> {
    let lastError: unknown = null;
    for (const store of this.stores) {
      try {
        const hit = await store.get(hostname);
        if (hit) return hit;
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError) throw lastError;
    return null;
  }
  async set(hostname: string, entry: ServiceRouteEntry): Promise<void> {
    await Promise.all(this.stores.map((s) => s.set(hostname, entry)));
  }
  async delete(hostname: string): Promise<void> {
    await Promise.all(this.stores.map((s) => s.delete(hostname)));
  }
}

// ─── Default Singletons ───────────────────────────────────────────────────────
const globalForRegistry = globalThis as unknown as {
  __syncbay_edge_registry?: EdgeServiceRegistry;
  __syncbay_edge_memory_store?: MemoryStore;
};
const defaultRegistry = globalForRegistry.__syncbay_edge_registry ?? new EdgeServiceRegistry();
globalForRegistry.__syncbay_edge_registry = defaultRegistry;
const memoryStore = globalForRegistry.__syncbay_edge_memory_store ?? new MemoryStore();
globalForRegistry.__syncbay_edge_memory_store = memoryStore;

const negativeCache = new Map<string, number>();
const inflight = new Map<string, Promise<ServiceRouteEntry | null>>();

let cachedStore: { key: string; store: L2Store } | null = null;

/**
 * Returns the L2 store for the current environment:
 * Upstash (+ DB fallback) → DB → memory.
 */
export function getL2Store(): L2Store {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const hasDb = Boolean(process.env.DATABASE_URL);
  const key = `${url || ""}|${token ? "t" : ""}|${hasDb ? "db" : ""}`;
  if (cachedStore?.key === key) return cachedStore.store;

  const stores: L2Store[] = [];
  if (url && token) stores.push(new UpstashRestStore(url, token));
  if (hasDb) stores.push(new DbResolveStore());
  const store = stores.length === 0 ? memoryStore : stores.length === 1 ? stores[0] : new ChainedStore(stores);
  cachedStore = { key, store };
  return store;
}

/**
 * Registers a service route in L1 only (plus the in-process memory store).
 * Prefer `registerServiceRouteAsync`, which also writes through to L2.
 */
export function registerServiceRoute(
  hostname: string,
  targetPort?: number,
  status: ServiceRouteStatus = "ACTIVE",
  upstreamUrl?: string,
  isLocal?: boolean
): void {
  const entry = defaultRegistry.registerServiceRoute(hostname, targetPort, status, upstreamUrl, isLocal);
  if (entry) {
    negativeCache.delete(entry.hostname);
    memoryStore.setSync(entry.hostname, entry);
  }
}

/**
 * Retrieves a service route from L1 (ignores TTL; never touches L2).
 */
export function getServiceRoute(hostname: string): ServiceRouteEntry | null {
  return defaultRegistry.getServiceRoute(hostname);
}

/**
 * Removes a service route from L1 only. Prefer `removeServiceRouteAsync`.
 */
export function removeServiceRoute(hostname: string): boolean {
  memoryStore.deleteSync(hostname);
  return defaultRegistry.removeServiceRoute(hostname);
}

/**
 * Clears L1, the negative cache and the in-process memory store.
 */
export function clearServiceRoutes(): void {
  defaultRegistry.clearServiceRoutes();
  memoryStore.clear();
  negativeCache.clear();
  inflight.clear();
}

/**
 * Registers a route in L1 and writes it through to L2. Never throws: an L2
 * failure is logged and the L1 entry still serves this process.
 */
export async function registerServiceRouteAsync(
  hostname: string,
  targetPort?: number,
  status: ServiceRouteStatus = "ACTIVE",
  upstreamUrl?: string,
  isLocal?: boolean
): Promise<ServiceRouteEntry | null> {
  registerServiceRoute(hostname, targetPort, status, upstreamUrl, isLocal);
  const entry = defaultRegistry.getServiceRoute(hostname);
  if (!entry) return null;
  const store = getL2Store();
  if (store !== memoryStore) {
    try {
      await store.set(entry.hostname, entry);
    } catch (err) {
      console.warn(`[edge-registry] L2 (${store.kind}) write failed for ${entry.hostname}: ${errorMessage(err)}`);
    }
  }
  return entry;
}

/**
 * Removes a route from L1 and L2. Never throws.
 */
export async function removeServiceRouteAsync(hostname: string): Promise<boolean> {
  const removed = removeServiceRoute(hostname);
  const host = normalizeHostname(hostname);
  if (host) negativeCache.set(host, Date.now() + L1_NEGATIVE_TTL_MS);
  const store = getL2Store();
  if (store !== memoryStore && host) {
    try {
      await store.delete(host);
    } catch (err) {
      console.warn(`[edge-registry] L2 (${store.kind}) delete failed for ${host}: ${errorMessage(err)}`);
    }
  }
  return removed;
}

/**
 * Resolves a route: fresh L1 hit → negative cache → L2 (hydrating L1).
 * On an L2 error a stale L1 entry is served (and re-cached briefly).
 */
export async function resolveServiceRoute(hostname: string): Promise<ServiceRouteEntry | null> {
  const host = normalizeHostname(hostname);
  if (!host) return null;

  const fresh = defaultRegistry.getFreshServiceRoute(host);
  if (fresh) return fresh;

  const negativeUntil = negativeCache.get(host);
  if (negativeUntil !== undefined) {
    if (negativeUntil > Date.now()) return null;
    negativeCache.delete(host);
  }

  const pending = inflight.get(host);
  if (pending) return pending;

  const lookup = (async () => {
    const store = getL2Store();
    try {
      const hit = await store.get(host);
      if (hit) {
        defaultRegistry.setEntry(host, hit);
        return defaultRegistry.getServiceRoute(host);
      }
      const stale = defaultRegistry.getServiceRoute(host);
      if (stale && store === memoryStore) {
        // No shared store configured: L1 is as authoritative as it gets.
        defaultRegistry.setEntry(host, stale);
        return stale;
      }
      defaultRegistry.removeServiceRoute(host);
      negativeCache.set(host, Date.now() + L1_NEGATIVE_TTL_MS);
      return null;
    } catch (err) {
      const stale = defaultRegistry.getServiceRoute(host);
      console.warn(`[edge-registry] L2 (${store.kind}) lookup failed for ${host}: ${errorMessage(err)}`);
      if (stale) {
        defaultRegistry.setEntry(host, stale, L1_TRANSIENT_TTL_MS);
        return stale;
      }
      negativeCache.set(host, Date.now() + L1_NEGATIVE_TTL_MS);
      return null;
    } finally {
      inflight.delete(host);
    }
  })();
  inflight.set(host, lookup);
  return lookup;
}

/**
 * Factory function to create an isolated Edge Service Registry.
 */
export function createEdgeRegistry(): EdgeServiceRegistry {
  return new EdgeServiceRegistry();
}
