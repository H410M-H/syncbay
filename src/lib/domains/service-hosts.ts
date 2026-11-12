/**
 * Which hostnames belong to a service.
 *
 * A service answers on its own `Domain` rows: one generated platform host
 * (`<service>-<env>.syncbay.app`, suffixed when another service already owns that name) plus its
 * custom domains. Hostnames are never derived from the service name alone once a row exists:
 * two services called `web` in `production` would otherwise route, sleep and fail each other's
 * address. This module is pure (no database, no Node APIs), so client components can use it.
 */

export const PLATFORM_DOMAIN = "syncbay.app";

/** Normalizes a string into a DNS-safe label (RFC 1123). */
export function slugifyHostPart(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** `<service>-<env>[-suffix].syncbay.app`. */
export function generateDefaultSubdomain(serviceName: string, envName: string, suffix?: string): string {
  const serviceSlug = slugifyHostPart(serviceName) || "service";
  const envSlug = slugifyHostPart(envName) || "production";
  return `${serviceSlug}-${envSlug}${suffix ? `-${suffix}` : ""}.${PLATFORM_DOMAIN}`;
}

export interface HostSource {
  name?: string | null;
  environment?: { name?: string | null; isPrEnv?: boolean | null; prNumber?: number | null } | null;
  domains?: Array<{ hostname?: string | null; isGenerated?: boolean | null }> | null;
}

function isPlatformHost(hostname: string): boolean {
  return hostname.endsWith(`.${PLATFORM_DOMAIN}`);
}

/** The service's own platform hostnames (generated rows; a legacy service without one gets the computed default). */
export function platformHostnames(service: HostSource): string[] {
  const own = (service.domains || [])
    .filter((d) => d.hostname && (d.isGenerated || isPlatformHost(d.hostname.toLowerCase())))
    .map((d) => d.hostname!.toLowerCase());
  if (own.length > 0) return [...new Set(own)];
  return [generateDefaultSubdomain(service.name || "web", service.environment?.name || "production")];
}

/** The address shown to users and used for service-to-service calls. */
export function primaryServiceHostname(service: HostSource): string {
  const generated = (service.domains || []).find((d) => d.isGenerated && d.hostname);
  return generated?.hostname?.toLowerCase() || platformHostnames(service)[0];
}

/**
 * Every hostname routed to a service: platform hosts (with their `<sub>.localhost` and bare
 * `<sub>` aliases for local development), custom domains and the PR preview host.
 */
export function resolveServiceHostnames(service: HostSource): string[] {
  const hosts = new Set<string>();
  const addPlatform = (host: string) => {
    hosts.add(host);
    if (isPlatformHost(host)) {
      const sub = host.slice(0, -`.${PLATFORM_DOMAIN}`.length);
      hosts.add(`${sub}.localhost`);
      hosts.add(sub);
    }
  };
  for (const host of platformHostnames(service)) addPlatform(host);
  for (const d of service.domains || []) if (d.hostname) addPlatform(d.hostname.toLowerCase());
  if (service.environment?.isPrEnv && service.environment.prNumber) {
    const serviceName = service.name || "web";
    hosts.add(`${serviceName}-pr-${service.environment.prNumber}.${PLATFORM_DOMAIN}`);
    hosts.add(`${serviceName}-pr-${service.environment.prNumber}.localhost`);
  }
  return [...hosts];
}
