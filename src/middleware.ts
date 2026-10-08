import { NextRequest, NextResponse } from "next/server";
import { getServiceRoute } from "@/lib/edge/service-registry";

export function middleware(req: NextRequest) {
  const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").toLowerCase().split(":")[0];
  const { pathname } = req.nextUrl;

  // Static assets and internal endpoints should never be rewritten
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api/trpc") ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/webhooks") ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/service-preview")
  ) {
    return NextResponse.next();
  }

  // Check if this is a platform service subdomain or registered customer domain
  const isControlPlane =
    host === "syncbay.app" ||
    host === "www.syncbay.app" ||
    host === "cname.syncbay.app" ||
    host === "localhost" ||
    host === "127.0.0.1";

  const registeredRoute = !isControlPlane ? getServiceRoute(host) : null;
  const isSyncbaySubdomain =
    !isControlPlane &&
    ((host.endsWith(".syncbay.app") &&
      host !== "syncbay.app" &&
      host !== "www.syncbay.app" &&
      host !== "cname.syncbay.app") ||
      !!registeredRoute);

  if (isSyncbaySubdomain) {
    const subdomain = host.endsWith(".syncbay.app")
      ? host.slice(0, -".syncbay.app".length)
      : host.endsWith(".localhost")
      ? host.slice(0, -".localhost".length)
      : host;

    // Resolve service route from Edge-safe registry
    const route = registeredRoute || getServiceRoute(host);

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
        return NextResponse.json(
          {
            status: "starting",
            serviceStatus: currentStatus,
            subdomain,
            message: `Service is currently ${currentStatus}. Container probe warming up.`,
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
      const upstreamBase = route.upstreamUrl || (route.targetPort ? `http://127.0.0.1:${route.targetPort}` : undefined);
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
          if (route.targetPort) {
            requestHeaders.set("x-syncbay-port", String(route.targetPort));
          }

          return NextResponse.rewrite(target, {
            request: {
              headers: requestHeaders,
            },
          });
        } catch {
          // If URL parsing fails, pass-through
          return NextResponse.next();
        }
      }

      // If active without specific upstream URL, pass-through
      return NextResponse.next();
    }

    // If service status is not ACTIVE (QUEUED, BUILDING, DEPLOYING, SLEEPING, or unknown):
    // rewrite customer traffic to the dynamic service preview container route
    const url = req.nextUrl.clone();
    url.pathname = `/service-preview/${subdomain}`;
    return NextResponse.rewrite(url);
  }

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-pathname", req.nextUrl.pathname);
  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
