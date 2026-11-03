/**
 * Syncbay PaaS — Database-backed edge route resolution.
 *
 * Shared by `/api/v1/services/edge-resolve` and the `DbResolveStore` L2 tier of
 * the edge service registry, so the proxy can hydrate routes straight from
 * Postgres without self-fetching an API route.
 */

import { db } from "@/lib/db";
import type { ServiceRouteEntry } from "@/lib/edge/service-registry";

interface ResolveOptions {
  /**
   * Only match a `Domain` row whose hostname equals the input exactly and is
   * verified (`ACTIVE`). Used for custom domains so arbitrary hosts never
   * fuzzy-match a service by name.
   */
  exactHostname?: boolean;
}

/**
 * Resolves a subdomain (`web-production`), platform hostname or custom domain to
 * a route entry using the latest deployment of the matching service.
 * Returns `null` when no service matches.
 */
export async function resolveServiceRouteFromDb(
  subdomainOrHost: string,
  options: ResolveOptions = {}
): Promise<ServiceRouteEntry | null> {
  const subdomain = (subdomainOrHost || "").trim().toLowerCase();
  if (!subdomain) return null;

  const serviceInclude = {
    deployments: { orderBy: { createdAt: "desc" as const }, take: 1 },
  };

  // 1. Resolve exact registered Domain record first (excluding deleted services)
  const domain = await db.domain.findFirst({
    where: options.exactHostname
      ? { hostname: subdomain, status: "ACTIVE", service: { deletedAt: null } }
      : {
          OR: [
            { hostname: subdomain },
            { hostname: `${subdomain}.syncbay.app` },
            { hostname: { startsWith: `${subdomain}.` } },
          ],
          service: { deletedAt: null },
        },
    include: { service: { include: serviceInclude } },
  });

  let service = domain?.service ?? null;

  // 2. Fall back to service-name heuristics for platform subdomains only
  if (!service && !options.exactHostname) {
    const serviceSlug = subdomain.split("-")[0];
    service = await db.service.findFirst({
      where: {
        deletedAt: null,
        OR: [
          { id: subdomain },
          { name: subdomain },
          { name: serviceSlug },
          { name: { startsWith: `${serviceSlug}-` } },
        ],
      },
      orderBy: { createdAt: "desc" },
      include: serviceInclude,
    });
  }

  if (!service) return null;

  const latest = service.deployments?.[0];
  const status = service.isPaused ? "SLEEPING" : latest?.status || "NOT_FOUND";
  const targetPort = service.port || 3000;
  const isLocal = Boolean(
    latest?.cfContainerId?.startsWith("c_local_") ||
      latest?.cfContainerId?.startsWith("proc_") ||
      process.env.RUNNER_FORCE_LOCAL === "true"
  );

  return {
    hostname: subdomain,
    targetPort,
    status,
    upstreamUrl: `http://127.0.0.1:${targetPort}`,
    isLocal,
    updatedAt: Date.now(),
  };
}
