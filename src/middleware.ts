import { NextRequest, NextResponse } from "next/server";

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

  // Check if this is a platform service subdomain (e.g. web-production-nuu9.syncbay.app)
  const isSyncbaySubdomain =
    host.endsWith(".syncbay.app") &&
    host !== "syncbay.app" &&
    host !== "www.syncbay.app" &&
    host !== "cname.syncbay.app";

  if (isSyncbaySubdomain) {
    const subdomain = host.replace(".syncbay.app", "");

    // Return instant HTTP 200 health check response for container probes
    if (pathname === "/health" || pathname === "/healthz") {
      return NextResponse.json({
        status: "healthy",
        subdomain,
        runtime: "Syncbay Edge Container Fabric",
        edgePop: "iad1",
        protocol: "HTTP/2",
        timestamp: new Date().toISOString(),
      });
    }

    // Rewrite customer traffic to the dynamic service preview container route
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
