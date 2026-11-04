/**
 * Syncbay PaaS — Multi-Region Edge Networking & Cloud Container Proxy (M5 Core)
 * Coordinates geo-distributed routing across global edge POPs with instant health-gated failover.
 *
 * NOTE: the six regions below are an ILLUSTRATIVE static model (coordinates, latencies,
 * container counts) used for routing demos and the dashboard globe. Syncbay does not run
 * these POPs; real traffic enters through Cloudflare. API responses carry
 * `illustrative: true`. Cache purge, by contrast, is a real Cloudflare call (see below).
 */

export interface EdgeRegion {
  id: string;
  name: string;
  location: string;
  latitude: number;
  longitude: number;
  provider: string;
  status: "HEALTHY" | "DEGRADED" | "OUTAGE";
  activeContainers: number;
  averageLatencyMs: number;
  tlsVersion: string;
  http3Enabled: boolean;
  /** Always true: the region list is a static model, not live infrastructure. */
  illustrative?: true;
}

export interface RoutingDecision {
  clientIp: string;
  detectedCountry: string;
  detectedCity: string;
  primaryRegion: EdgeRegion;
  activeRegion: EdgeRegion;
  isFailover: boolean;
  failoverReason?: string;
  distanceKm: number;
  estimatedLatencyMs: number;
  timestamp: string;
}

export interface CustomDomainTlsStatus {
  domain: string;
  status: "ACTIVE" | "PENDING" | "ISSUING" | "FAILED";
  edgePop: string;
  tlsVersion: string;
  cipherSuite: string;
  certificateIssuer: string;
  expiresAt: string;
  autoRenew: boolean;
  http3Support: boolean;
}

// 6 Tier-1 Global Edge POPs
export const EDGE_REGIONS: Record<string, EdgeRegion> = {
  iad1: {
    id: "iad1",
    name: "US East",
    location: "N. Virginia, USA",
    latitude: 38.9072,
    longitude: -77.0369,
    provider: "Cloudflare Containers (US-EAST)",
    status: "HEALTHY",
    activeContainers: 48,
    averageLatencyMs: 14,
    tlsVersion: "TLSv1.3",
    http3Enabled: true,
  },
  sfo1: {
    id: "sfo1",
    name: "US West",
    location: "San Francisco, USA",
    latitude: 37.7749,
    longitude: -122.4194,
    provider: "Cloudflare Containers (US-WEST)",
    status: "HEALTHY",
    activeContainers: 34,
    averageLatencyMs: 18,
    tlsVersion: "TLSv1.3",
    http3Enabled: true,
  },
  fra1: {
    id: "fra1",
    name: "Europe Central",
    location: "Frankfurt, Germany",
    latitude: 50.1109,
    longitude: 8.6821,
    provider: "Cloudflare Containers (EU-CENTRAL)",
    status: "HEALTHY",
    activeContainers: 41,
    averageLatencyMs: 16,
    tlsVersion: "TLSv1.3",
    http3Enabled: true,
  },
  lhr1: {
    id: "lhr1",
    name: "Europe West",
    location: "London, United Kingdom",
    latitude: 51.5074,
    longitude: -0.1278,
    provider: "Cloudflare Containers (EU-WEST)",
    status: "HEALTHY",
    activeContainers: 37,
    averageLatencyMs: 15,
    tlsVersion: "TLSv1.3",
    http3Enabled: true,
  },
  sin1: {
    id: "sin1",
    name: "Asia Southeast",
    location: "Singapore",
    latitude: 1.3521,
    longitude: 103.8198,
    provider: "Cloudflare Containers (AP-SOUTHEAST)",
    status: "HEALTHY",
    activeContainers: 29,
    averageLatencyMs: 22,
    tlsVersion: "TLSv1.3",
    http3Enabled: true,
  },
  syd1: {
    id: "syd1",
    name: "Oceania",
    location: "Sydney, Australia",
    latitude: -33.8688,
    longitude: 151.2093,
    provider: "Cloudflare Containers (AP-SOUTHEAST-2)",
    status: "HEALTHY",
    activeContainers: 19,
    averageLatencyMs: 28,
    tlsVersion: "TLSv1.3",
    http3Enabled: true,
  },
};

// Track runtime region health overrides for failover testing
const regionOverrides: Map<string, "HEALTHY" | "DEGRADED" | "OUTAGE"> = new Map();

/**
 * Calculates Great-Circle distance using Haversine formula
 */
export function calculateDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

/**
 * Maps country code to representative coordinates
 */
export function getCoordinatesForCountry(countryCode?: string): { lat: number; lon: number } {
  const code = (countryCode || "US").toUpperCase();
  const COUNTRY_COORDS: Record<string, { lat: number; lon: number }> = {
    US: { lat: 37.0902, lon: -95.7129 },
    CA: { lat: 56.1304, lon: -106.3468 },
    GB: { lat: 55.3781, lon: -3.436 },
    DE: { lat: 51.1657, lon: 10.4515 },
    FR: { lat: 46.2276, lon: 2.2137 },
    NL: { lat: 52.1326, lon: 5.2913 },
    IE: { lat: 53.4129, lon: -8.2439 },
    ES: { lat: 40.4637, lon: -3.7492 },
    IT: { lat: 41.8719, lon: 12.5674 },
    PL: { lat: 51.9194, lon: 19.1451 },
    SE: { lat: 60.1282, lon: 18.6435 },
    CH: { lat: 46.8182, lon: 8.2275 },
    SG: { lat: 1.3521, lon: 103.8198 },
    JP: { lat: 36.2048, lon: 138.2529 },
    KR: { lat: 35.9078, lon: 127.7669 },
    IN: { lat: 20.5937, lon: 78.9629 },
    PK: { lat: 30.3753, lon: 69.3451 },
    ID: { lat: -0.7893, lon: 113.9213 },
    MY: { lat: 4.2105, lon: 101.9758 },
    TH: { lat: 15.87, lon: 100.9925 },
    VN: { lat: 14.0583, lon: 108.2772 },
    PH: { lat: 12.8797, lon: 121.774 },
    AU: { lat: -25.2744, lon: 133.7751 },
    NZ: { lat: -40.9006, lon: 174.886 },
    BR: { lat: -14.235, lon: -51.9253 },
    MX: { lat: 23.6345, lon: -102.5528 },
    AR: { lat: -38.4161, lon: -63.6167 },
    ZA: { lat: -30.5595, lon: 22.9375 },
    NG: { lat: 9.082, lon: 8.6753 },
    EG: { lat: 26.8206, lon: 30.8025 },
    AE: { lat: 23.4241, lon: 53.8478 },
    TR: { lat: 38.9637, lon: 35.2433 },
  };

  return COUNTRY_COORDS[code] || { lat: 38.9, lon: -77.4 }; // fallback to US East
}

/**
 * Returns the current active list of regions including simulated overrides
 */
export function getEdgeRegions(): EdgeRegion[] {
  return Object.values(EDGE_REGIONS).map((region) => ({
    ...region,
    status: regionOverrides.get(region.id) || region.status,
    illustrative: true as const,
  }));
}

/**
 * Allows toggling a region's health for simulated chaos testing / failover verification
 */
export function setRegionStatusOverride(
  regionId: string,
  status: "HEALTHY" | "DEGRADED" | "OUTAGE" | "RESET"
): void {
  if (status === "RESET") {
    regionOverrides.delete(regionId);
  } else {
    regionOverrides.set(regionId, status);
  }
}

/**
 * Selects the optimal edge POP based on client geo coordinates and region health
 */
export function routeClientRequest(params: {
  country?: string;
  city?: string;
  clientIp?: string;
  latitude?: number;
  longitude?: number;
}): RoutingDecision {
  let coords: { lat: number; lon: number };
  if (
    params.latitude !== undefined &&
    params.longitude !== undefined &&
    typeof params.latitude === "number" &&
    typeof params.longitude === "number" &&
    !isNaN(params.latitude) &&
    !isNaN(params.longitude)
  ) {
    const lat = Math.max(-90, Math.min(90, params.latitude));
    const lon = Math.max(-180, Math.min(180, params.longitude));
    coords = { lat, lon };
  } else {
    coords = getCoordinatesForCountry(params.country);
  }

  const allRegions = getEdgeRegions();

  // Rank regions by physical distance
  const sorted = [...allRegions]
    .map((reg) => {
      const dist = calculateDistanceKm(coords.lat, coords.lon, reg.latitude, reg.longitude);
      return { region: reg, distance: dist };
    })
    .sort((a, b) => a.distance - b.distance);

  const primaryCandidate = sorted[0].region;
  let activeCandidate = primaryCandidate;
  let isFailover = false;
  let failoverReason: string | undefined = undefined;

  // If primary is down, failover cascade: HEALTHY first, then DEGRADED
  if (primaryCandidate.status === "OUTAGE") {
    const healthyFallback = sorted.find((s) => s.region.status === "HEALTHY");
    const degradedFallback = sorted.find((s) => s.region.status === "DEGRADED");
    const fallback = healthyFallback || degradedFallback;
    if (fallback && fallback.region.id !== primaryCandidate.id) {
      activeCandidate = fallback.region;
      isFailover = true;
      const statusNote = fallback.region.status === "HEALTHY" ? "healthy" : "degraded (active standby)";
      failoverReason = `Primary POP ${primaryCandidate.id.toUpperCase()} is undergoing an outage. Traffic automatically rerouted to nearest ${statusNote} edge node ${fallback.region.id.toUpperCase()}.`;
    } else {
      isFailover = true;
      failoverReason = `All edge POPs are experiencing severe degradation or outage. Routing to nearest available POP ${primaryCandidate.id.toUpperCase()}.`;
    }
  }

  const finalDist = calculateDistanceKm(
    coords.lat,
    coords.lon,
    activeCandidate.latitude,
    activeCandidate.longitude
  );

  // Speed of light in fiber approx ~5ms per 1000km + 8ms base edge dispatch
  const estimatedLatencyMs = Math.max(
    5,
    Math.round(activeCandidate.averageLatencyMs + (finalDist / 1000) * 4.8)
  );

  return {
    clientIp: params.clientIp || "127.0.0.1",
    detectedCountry: params.country || "US",
    detectedCity: params.city || "Edge Ingress",
    primaryRegion: primaryCandidate,
    activeRegion: activeCandidate,
    isFailover,
    failoverReason,
    distanceKm: finalDist,
    estimatedLatencyMs,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Generates custom hostname TLS status details
 */
export function getCustomDomainTlsStatus(domain: string): CustomDomainTlsStatus {
  const cleanDomain = domain.toLowerCase().trim();
  const hash = Array.from(cleanDomain).reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const pops = ["iad1", "fra1", "sin1", "sfo1", "lhr1", "syd1"];
  const assignedPop = pops[hash % pops.length];

  const expiry = new Date();
  expiry.setMonth(expiry.getMonth() + 3);

  return {
    domain: cleanDomain,
    status: cleanDomain.includes("fail") ? "FAILED" : "ACTIVE",
    edgePop: assignedPop,
    tlsVersion: "TLSv1.3",
    cipherSuite: "TLS_AES_256_GCM_SHA384",
    certificateIssuer: "Cloudflare Managed CA (Let's Encrypt / Google Trust Services)",
    expiresAt: expiry.toISOString(),
    autoRenew: true,
    http3Support: true,
  };
}

export interface PurgeCacheOptions {
  serviceId?: string;
  domain?: string;
  path?: string;
  tag?: string;
  all?: boolean;
}

export interface PurgeCacheResult {
  success: boolean;
  /** False when CLOUDFLARE_ZONE_ID / CLOUDFLARE_API_TOKEN are unset: nothing was purged. */
  configured: boolean;
  provider: "cloudflare" | "none";
  /** `["cloudflare:global"]` after a real purge (Cloudflare purges every edge); empty otherwise. */
  purgedPops: string[];
  scope: string;
  timestamp: string;
  durationMs: number;
  message: string;
  cloudflarePurgeId?: string;
}

/** Builds the Cloudflare `purge_cache` body for the requested scope, or an error message. */
function purgeBody(options: PurgeCacheOptions): { scope: string; body?: Record<string, unknown>; error?: string } {
  if (options.all) return { scope: "ALL", body: { purge_everything: true } };
  if (options.tag) return { scope: `TAG:${options.tag}`, body: { tags: [options.tag] } };
  if (options.path) {
    if (!options.domain) return { scope: `PATH:${options.path}`, error: "A path purge needs a domain (purge by URL)" };
    const path = options.path.startsWith("/") ? options.path : `/${options.path}`;
    return { scope: `PATH:${options.path}`, body: { files: [`https://${options.domain}${path}`] } };
  }
  if (options.domain) return { scope: `DOMAIN:${options.domain}`, body: { hosts: [options.domain] } };
  return { scope: "UNKNOWN", error: "Nothing to purge: pass all, tag, domain or domain + path" };
}

/**
 * Purges the Cloudflare edge cache (`POST /zones/{zone}/purge_cache`) when CLOUDFLARE_ZONE_ID
 * and CLOUDFLARE_API_TOKEN are set. Otherwise it reports `configured: false` and
 * `success: false` instead of pretending to purge.
 */
export async function purgeEdgeCache(
  options: PurgeCacheOptions = { all: true },
  deps: { fetchFn?: typeof fetch; zoneId?: string; apiToken?: string } = {}
): Promise<PurgeCacheResult> {
  const startTime = Date.now();
  const zoneId = deps.zoneId ?? process.env.CLOUDFLARE_ZONE_ID;
  const apiToken = deps.apiToken ?? process.env.CLOUDFLARE_API_TOKEN;
  const { scope, body, error } = purgeBody(options);
  const result = (fields: Partial<PurgeCacheResult> & Pick<PurgeCacheResult, "success" | "message">): PurgeCacheResult => ({
    configured: Boolean(zoneId && apiToken),
    provider: zoneId && apiToken ? "cloudflare" : "none",
    purgedPops: [],
    scope,
    timestamp: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - startTime),
    ...fields,
  });

  if (!zoneId || !apiToken) {
    return result({ success: false, message: "Edge cache purge is not configured (set CLOUDFLARE_ZONE_ID and CLOUDFLARE_API_TOKEN); nothing was purged" });
  }
  if (error || !body) return result({ success: false, message: error || "Invalid purge scope" });

  try {
    const res = await (deps.fetchFn ?? fetch)(`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/purge_cache`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json?.success === false) {
      const detail = Array.isArray(json?.errors) && json.errors.length ? json.errors.map((e: any) => e?.message || String(e)).join("; ") : `HTTP ${res.status}`;
      return result({ success: false, message: `Cloudflare purge failed: ${detail}` });
    }
    return result({ success: true, purgedPops: ["cloudflare:global"], message: "Cloudflare cache purged", cloudflarePurgeId: json?.result?.id });
  } catch (err: any) {
    return result({ success: false, message: `Cloudflare purge failed: ${err?.message || err}` });
  }
}
