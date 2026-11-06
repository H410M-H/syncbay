import { NextRequest, NextResponse, type NextFetchEvent } from "next/server";
import { resolveServiceRoute } from "@/lib/edge/service-registry";
import { recordServiceRequest } from "@/lib/scale/activity";
import { enforceWaf } from "@/lib/edge/waf";
import { selectCanaryUpstream } from "@/lib/edge/canary";

/**
 * Syncbay edge proxy (Next 16 `proxy.ts`, Node.js runtime).
 *
 * Service hosts are `*.syncbay.app`, `*.localhost` and hosts that resolve as
 * registered custom domains. Routes come from the two-tier registry: a short
 * TTL L1 cache hydrated from the shared L2 store (Upstash / Postgres) on a miss.
 */

// Control-plane paths that are never rewritten, on any host.
const BYPASS_PREFIXES = [
  "/api/trpc",
  "/api/auth",
  "/api/webhooks",
  "/api/deployments",
  "/api/v1/services/edge-resolve",
  "/api/v1/services/edge-register",
  "/api/v1/services/wake",
  "/service-preview",
];

const CONTROL_PLANE_HOSTS = new Set(["syncbay.app", "www.syncbay.app", "cname.syncbay.app", "localhost"]);

/** Lower-cased host without port; IPv6 literals keep their brackets. */
function extractHost(raw: string): string {
  const value = raw.split(",")[0].trim().toLowerCase();
  if (value.startsWith("[")) return value.slice(0, value.indexOf("]") + 1);
  return value.split(":")[0];
}

function isIpAddress(host: string): boolean {
  return host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function deploymentHosts(): string[] {
  return [
    process.env.NEXTAUTH_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.VERCEL_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
  ]
    .filter((v): v is string => Boolean(v))
    .map((v) => extractHost(v.replace(/^https?:\/\//i, "")));
}

function isControlPlaneHost(host: string): boolean {
  return (
    !host ||
    CONTROL_PLANE_HOSTS.has(host) ||
    isIpAddress(host) ||
    host.endsWith(".vercel.app") ||
    deploymentHosts().includes(host)
  );
}

/** `<sub>` for `<sub>.syncbay.app` / `<sub>.localhost`, otherwise null. */
function platformSubdomain(host: string): string | null {
  for (const suffix of [".syncbay.app", ".localhost"]) {
    if (host.endsWith(suffix) && host.length > suffix.length) return host.slice(0, -suffix.length);
  }
  return null;
}

function passThrough(req: NextRequest) {
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-pathname", req.nextUrl.pathname);
  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
}

export async function proxy(req: NextRequest, event?: NextFetchEvent) {
  const host = extractHost(req.headers.get("x-forwarded-host") || req.headers.get("host") || "");
  const { pathname } = req.nextUrl;

  // Static assets and internal endpoints should never be rewritten
  if (BYPASS_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  if (isControlPlaneHost(host)) {
    if (pathname.startsWith("/_next") || pathname === "/favicon.ico") {
      return NextResponse.next();
    }
    return passThrough(req);
  }

  const platformSub = platformSubdomain(host);
  // Custom domains are service hosts only when they resolve to a registered route
  const route = await resolveServiceRoute(host);
  if (platformSub === null && !route) {
    return passThrough(req);
  }

  const subdomain = platformSub ?? host;

  // Return health check response for container probes reflecting real service status
  if (pathname === "/health" || pathname === "/healthz") {
    if (route && (route.status === "FAILED" || route.status === "CRASHED")) {
      return NextResponse.json(
        {
          error: "Bad Gateway",
          message: `Service is in ${route.status} state`,
          subdomain,
          timestamp: new Date().toISOString(),
        },
        { status: 502 }
      );
    }

    // If the service is booting, building, deploying, sleeping, or not yet registered,
    // return HTTP 503 to prevent premature splash screen redirect reload loops.
    if (!route || route.status !== "ACTIVE") {
      const currentStatus = route ? route.status : "BOOTING";
      const isReconnecting = currentStatus === "RECONNECTING";
      return NextResponse.json(
        {
          status: isReconnecting ? "reconnecting" : "starting",
          serviceStatus: currentStatus,
          subdomain,
          message: isReconnecting
            ? "Edge tunnel ingress is reconnecting. Restoring connection."
            : `Service is currently ${currentStatus}. Container probe warming up.`,
          runtime: "Syncbay Edge Container Fabric",
          edgePop: "iad1",
          timestamp: new Date().toISOString(),
        },
        { status: 503 }
      );
    }

    return NextResponse.json({
      status: "healthy",
      subdomain,
      runtime: "Syncbay Edge Container Fabric",
      edgePop: "iad1",
      protocol: "HTTP/2",
      timestamp: new Date().toISOString(),
    });
  }

  const wafBlock = await enforceWaf(req, host);
  if (wafBlock) return wafBlock;

  // Return 502 Bad Gateway if service has crashed or failed
  if (route && (route.status === "FAILED" || route.status === "CRASHED")) {
    return NextResponse.json(
      {
        error: "Bad Gateway",
        message: `Service is in ${route.status} state`,
        subdomain,
        timestamp: new Date().toISOString(),
      },
      { status: 502 }
    );
  }

  // If active: transparently proxy/forward to upstream origin container
  if (route && route.status === "ACTIVE") {
    const activity = recordServiceRequest(host); // scale-to-zero last-request (debounced 30 s, never throws)
    if (activity) event?.waitUntil(activity);
    let upstreamBase = route.upstreamUrl || (route.targetPort ? `http://127.0.0.1:${route.targetPort}` : undefined);
    let targetPort = route.targetPort;
    const canary = await selectCanaryUpstream(req, host, upstreamBase);
    if (canary) [upstreamBase, targetPort] = [canary.upstreamUrl, canary.targetPort];
    const runnerUrl = process.env.RUNNER_URL;

    if (upstreamBase && upstreamBase.includes("127.0.0.1") && runnerUrl && !route.isLocal && process.env.RUNNER_FORCE_LOCAL !== "true") {
       if (!targetPort) {
          const portMatch = upstreamBase.match(/:(\d+)/);
          if (portMatch) targetPort = parseInt(portMatch[1], 10);
       }
       upstreamBase = runnerUrl.replace(/\/$/, '');
    }

    if (upstreamBase) {
      try {
        const upstream = new URL(upstreamBase);
        const target = new URL(req.url);
        target.protocol = upstream.protocol;
        target.hostname = upstream.hostname;
        target.port = upstream.port;
        target.pathname = pathname;
        target.search = req.nextUrl.search;

        const requestHeaders = new Headers(req.headers);
        requestHeaders.set("x-forwarded-host", host);
        requestHeaders.set("x-pathname", pathname);
        requestHeaders.set("x-syncbay-upstream", upstreamBase);
        if (targetPort) {
          requestHeaders.set("x-target-port", String(targetPort));
          requestHeaders.set("x-syncbay-port", String(targetPort));
          target.searchParams.set("__sb_port", String(targetPort));
        }

        const rewritten = NextResponse.rewrite(target, {
          request: {
            headers: requestHeaders,
          },
        });
        return canary ? canary.applyCookie(rewritten) : rewritten;
      } catch {
        // If URL parsing fails, pass-through
        return NextResponse.next();
      }
    }

    // If active without specific upstream URL, pass-through
    return NextResponse.next();
  }

  // Static assets for the service preview page
  if (pathname.startsWith("/_next") || pathname === "/favicon.ico") {
    return NextResponse.next();
  }

  // If service status is not ACTIVE (QUEUED, BUILDING, DEPLOYING, SLEEPING, or unknown):
  // rewrite customer traffic to the dynamic service preview container route
  const url = req.nextUrl.clone();
  url.pathname = `/service-preview/${subdomain}`;
  if (route && route.status) {
    url.searchParams.set("status", route.status);
  }
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: ["/:path*"],
};
