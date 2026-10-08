/**
 * Syncbay PaaS — Edge Service Registry (M3 Core)
 *
 * Edge Runtime compliant in-memory route registry for zero-latency lookups.
 * Strictly avoids Node.js native packages (fs, child_process, net, path, @prisma/client)
 * to maintain 100% compatibility with Next.js Edge Middleware and V8 isolates.
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

/**
 * Standalone Edge Service Registry instance class
 */
export class EdgeServiceRegistry {
  private routes = new Map<string, ServiceRouteEntry>();

  /**
   * Registers or updates a service route.
   */
  registerServiceRoute(
    hostname: string,
    targetPort?: number,
    status: ServiceRouteStatus = "ACTIVE",
    upstreamUrl?: string
  ): void {
    const normalized = normalizeHostname(hostname);
    if (!normalized) return;

    const resolvedUpstream =
      upstreamUrl || (targetPort !== undefined ? `http://localhost:${targetPort}` : undefined);

    this.routes.set(normalized, {
      hostname: normalized,
      targetPort,
      status,
      upstreamUrl: resolvedUpstream,
      updatedAt: Date.now(),
    });
  }

  /**
   * Retrieves a service route by hostname (case-insensitive).
   */
  getServiceRoute(hostname: string): ServiceRouteEntry | null {
    const normalized = normalizeHostname(hostname);
    if (!normalized) return null;
    const entry = this.routes.get(normalized);
    if (entry) return { ...entry };

    // Fallback: Check if .localhost alias maps to .syncbay.app or direct name
    if (normalized.endsWith(".localhost")) {
      const prefix = normalized.slice(0, -".localhost".length);
      const alias = this.routes.get(`${prefix}.syncbay.app`) || this.routes.get(prefix);
      if (alias) return { ...alias };
    }

    // Fallback: Check first subdomain label
    if (normalized.includes(".")) {
      const firstLabel = normalized.split(".")[0];
      const direct = this.routes.get(firstLabel);
      if (direct) return { ...direct };
    }

    return null;
  }

  /**
   * Removes a service route by hostname. Returns true if removed, false otherwise.
   */
  removeServiceRoute(hostname: string): boolean {
    const normalized = normalizeHostname(hostname);
    if (!normalized) return false;
    return this.routes.delete(normalized);
  }

  /**
   * Clears all registered service routes. Safe no-op on empty registry.
   */
  clearServiceRoutes(): void {
    this.routes.clear();
  }

  /**
   * Lists all currently registered service routes.
   */
  listRoutes(): ServiceRouteEntry[] {
    return Array.from(this.routes.values()).map((entry) => ({ ...entry }));
  }
}

// ─── Default Edge Singleton Registry ──────────────────────────────────────────
const globalForRegistry = globalThis as unknown as {
  __syncbay_edge_registry?: EdgeServiceRegistry;
};
const defaultRegistry = globalForRegistry.__syncbay_edge_registry ?? new EdgeServiceRegistry();
globalForRegistry.__syncbay_edge_registry = defaultRegistry;

/**
 * Registers a service route in the default Edge registry.
 */
export function registerServiceRoute(
  hostname: string,
  targetPort?: number,
  status: ServiceRouteStatus = "ACTIVE",
  upstreamUrl?: string
): void {
  defaultRegistry.registerServiceRoute(hostname, targetPort, status, upstreamUrl);
}

/**
 * Retrieves a service route from the default Edge registry.
 */
export function getServiceRoute(hostname: string): ServiceRouteEntry | null {
  return defaultRegistry.getServiceRoute(hostname);
}

/**
 * Removes a service route from the default Edge registry.
 */
export function removeServiceRoute(hostname: string): boolean {
  return defaultRegistry.removeServiceRoute(hostname);
}

/**
 * Clears all service routes in the default Edge registry.
 */
export function clearServiceRoutes(): void {
  defaultRegistry.clearServiceRoutes();
}

/**
 * Lists all service routes in the default Edge registry.
 */
export function listRoutes(): ServiceRouteEntry[] {
  return defaultRegistry.listRoutes();
}

/**
 * Factory function to create an isolated Edge Service Registry.
 */
export function createEdgeRegistry(): EdgeServiceRegistry {
  return new EdgeServiceRegistry();
}
