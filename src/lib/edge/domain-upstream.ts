/**
 * Syncbay PaaS — where a verified custom domain should route.
 *
 * A custom host must reach exactly what the service's platform host reaches, so the route
 * is copied from the live registry entry of `<svc>-<env>.syncbay.app` (upstream URL, port,
 * isLocal). When the registry has nothing, the DB resolver (same lookup the proxy uses) is
 * the fallback. A paused service routes as SLEEPING so the splash/wake page answers.
 */

import { generateDefaultSubdomain } from "@/lib/domain-service";
import { resolveServiceRoute, type ServiceRouteStatus } from "@/lib/edge/service-registry";
import { resolveServiceRouteFromDb } from "@/lib/edge/resolve";

export interface DomainUpstream {
  targetPort?: number;
  upstreamUrl?: string;
  isLocal?: boolean;
  status: ServiceRouteStatus;
  source: "live-route" | "database" | "none";
}

export async function resolveDomainUpstream(service: {
  id: string;
  name: string;
  port?: number | null;
  isPaused?: boolean;
  deployments?: Array<{ status: string }>;
  environment?: { name: string } | null;
}): Promise<DomainUpstream> {
  const platformHost = generateDefaultSubdomain(service.name, service.environment?.name || "production");
  const live = await resolveServiceRoute(platformHost).catch(() => null);
  const route = live ?? (await resolveServiceRouteFromDb(service.id).catch(() => null));
  const pausedStatus = service.isPaused ? ("SLEEPING" as ServiceRouteStatus) : undefined;

  if (route) {
    return {
      targetPort: route.targetPort,
      upstreamUrl: route.upstreamUrl,
      isLocal: route.isLocal,
      status: pausedStatus ?? route.status,
      source: live ? "live-route" : "database",
    };
  }
  return {
    targetPort: service.port ?? undefined,
    status: pausedStatus ?? ((service.deployments?.[0]?.status as ServiceRouteStatus) || "NOT_FOUND"),
    source: "none",
  };
}
