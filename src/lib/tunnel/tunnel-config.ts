/**
 * Cloudflare Tunnel Ingress Configuration Generator (M3 Core)
 * Generates valid cloudflared YAML mapping container hostnames to internal container ports.
 * Adheres strictly to RFC 1123 hostname validation, port bounds (1..65535), and ingress ordering rules.
 */

export interface IngressOriginRequest {
  connectTimeout?: string;
  noTLSVerify?: boolean;
  http2Origin?: boolean;
  httpHostHeader?: string;
  originServerName?: string;
  caPool?: string;
  proxyType?: string;
  disableChunkedEncoding?: boolean;
  bastionMode?: boolean;
  keepAliveConnections?: number;
  keepAliveTimeout?: string;
  tcpKeepAlive?: string;
}

export interface IngressRule {
  hostname?: string;
  path?: string;
  service: string;
  originRequest?: IngressOriginRequest;
}

export interface CloudflareTunnelConfig {
  tunnel: string;
  credentialsFile?: string;
  ingress: IngressRule[];
}

export interface RouteMapping {
  hostname: string;
  targetPort: number;
  path?: string;
  targetHost?: string; // Defaults to "localhost", supports "127.0.0.1"
  originRequest?: IngressOriginRequest;
}

export interface TunnelConfigParams {
  tunnelId: string;
  credentialsFile?: string;
  routes: RouteMapping[];
  controlPlaneFallback?: string; // e.g. "http://localhost:3000"
  catchAllService?: string;      // Defaults to "http_status:404"
  defaultOriginRequest?: IngressOriginRequest;
}

/**
 * Validates whether a hostname adheres to RFC 1123 specifications.
 * Allows wildcard prefix (*.domain.tld).
 * Rejects URI schemes, invalid characters, and out-of-spec label lengths.
 */
export function validateHostname(hostname: string): boolean {
  if (!hostname || typeof hostname !== "string") return false;
  if (hostname.length > 253) return false;

  // Disallow URI schemes (e.g., http://, https://)
  if (hostname.includes("://") || hostname.includes("/") || hostname.includes(":")) {
    return false;
  }

  // Allow wildcard prefix *.syncbay.app
  const testHost = hostname.startsWith("*.") ? hostname.slice(2) : hostname;

  // RFC 1123 / RFC 952 label syntax:
  // Each label consists of alphanumeric characters and hyphens, 1-63 chars, cannot start or end with hyphen
  const regex = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
  return regex.test(testHost);
}

/**
 * Validates a TCP port number (must be an integer between 1 and 65535).
 */
export function validatePort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Generates valid cloudflared YAML configuration.
 *
 * Enforces rule ordering:
 * 1. Specific subdomains (web-production-*.syncbay.app, web-pr-*.syncbay.app, etc.)
 * 2. Wildcard fallback (*.syncbay.app -> controlPlaneFallback)
 * 3. Mandatory final catch-all rule (service: http_status:404)
 */
export function generateTunnelConfig(params: TunnelConfigParams): string {
  if (!params.tunnelId || typeof params.tunnelId !== "string" || params.tunnelId.trim() === "") {
    throw new Error("tunnelId is required for tunnel configuration");
  }

  const credsFile = params.credentialsFile || `/etc/cloudflared/${params.tunnelId}.json`;
  const catchAll = params.catchAllService || "http_status:404";

  // Validate all routes upfront
  for (const r of params.routes) {
    if (!validateHostname(r.hostname)) {
      throw new Error(`Invalid route hostname: ${r.hostname}`);
    }
    if (!validatePort(r.targetPort)) {
      throw new Error(`Target port out of range (1..65535): ${r.targetPort}`);
    }
  }

  // Sort routes: specific hostnames first, wildcard hostnames last
  const sortedRoutes = [...params.routes].sort((a, b) => {
    const aWild = a.hostname.startsWith("*");
    const bWild = b.hostname.startsWith("*");
    if (aWild && !bWild) return 1;
    if (!aWild && bWild) return -1;
    return a.hostname.localeCompare(b.hostname);
  });

  const ingressLines: string[] = [];

  for (const r of sortedRoutes) {
    const lines: string[] = [];
    lines.push(`  - hostname: ${r.hostname}`);
    if (r.path) {
      lines.push(`    path: ${r.path}`);
    }

    const host = r.targetHost || "localhost";
    lines.push(`    service: http://${host}:${r.targetPort}`);

    const originReq = r.originRequest || params.defaultOriginRequest;
    if (originReq) {
      lines.push(`    originRequest:`);
      if (originReq.noTLSVerify !== undefined) {
        lines.push(`      noTLSVerify: ${originReq.noTLSVerify}`);
      }
      if (originReq.connectTimeout) {
        lines.push(`      connectTimeout: ${originReq.connectTimeout}`);
      }
      if (originReq.http2Origin !== undefined) {
        lines.push(`      http2Origin: ${originReq.http2Origin}`);
      }
      if (originReq.httpHostHeader) {
        lines.push(`      httpHostHeader: ${originReq.httpHostHeader}`);
      }
      if (originReq.originServerName) {
        lines.push(`      originServerName: ${originReq.originServerName}`);
      }
      if (originReq.caPool) {
        lines.push(`      caPool: ${originReq.caPool}`);
      }
      if (originReq.proxyType) {
        lines.push(`      proxyType: ${originReq.proxyType}`);
      }
      if (originReq.disableChunkedEncoding !== undefined) {
        lines.push(`      disableChunkedEncoding: ${originReq.disableChunkedEncoding}`);
      }
      if (originReq.bastionMode !== undefined) {
        lines.push(`      bastionMode: ${originReq.bastionMode}`);
      }
      if (originReq.keepAliveConnections !== undefined) {
        lines.push(`      keepAliveConnections: ${originReq.keepAliveConnections}`);
      }
      if (originReq.keepAliveTimeout) {
        lines.push(`      keepAliveTimeout: ${originReq.keepAliveTimeout}`);
      }
      if (originReq.tcpKeepAlive) {
        lines.push(`      tcpKeepAlive: ${originReq.tcpKeepAlive}`);
      }
    }

    ingressLines.push(lines.join("\n"));
  }

  // If controlPlaneFallback is provided and not already covered by a wildcard in routes
  if (params.controlPlaneFallback && !sortedRoutes.some((r) => r.hostname.startsWith("*"))) {
    ingressLines.push(`  - hostname: "*.syncbay.app"\n    service: ${params.controlPlaneFallback}`);
  }

  // Mandatory final catch-all rule
  ingressLines.push(`  - service: ${catchAll}`);

  return [
    `tunnel: ${params.tunnelId}`,
    `credentials-file: ${credsFile}`,
    `ingress:`,
    ...ingressLines,
  ].join("\n");
}
