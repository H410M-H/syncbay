/**
 * Cloudflare Tunnel Ingress Configuration Generator (M3 Core)
 * Generates valid cloudflared YAML mapping container hostnames to internal container ports.
 * Adheres strictly to RFC 1123 hostname validation, port bounds (1..65535), and ingress ordering rules.
 *
 * Also emits the JSON shape of the Cloudflare API
 * (`PUT /accounts/{account}/cfd_tunnel/{tunnel}/configurations`), writes YAML atomically,
 * and reloads a tunnel either remotely (API) or by restarting the local cloudflared.
 */

import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { CloudflareApiClient } from "./cloudflare-api";

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

/** Body of `PUT /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations`. */
export interface CloudflareTunnelConfigurationBody {
  config: {
    ingress: IngressRule[];
  };
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
/** Validates every route and orders specific hostnames before wildcards. */
function validateAndSortRoutes(routes: RouteMapping[]): RouteMapping[] {
  for (const r of routes) {
    if (!validateHostname(r.hostname)) {
      throw new Error(`Invalid route hostname: ${r.hostname}`);
    }
    if (!validatePort(r.targetPort)) {
      throw new Error(`Target port out of range (1..65535): ${r.targetPort}`);
    }
  }
  return [...routes].sort((a, b) => {
    const aWild = a.hostname.startsWith("*");
    const bWild = b.hostname.startsWith("*");
    if (aWild && !bWild) return 1;
    if (!aWild && bWild) return -1;
    return a.hostname.localeCompare(b.hostname);
  });
}

export function generateTunnelConfig(params: TunnelConfigParams): string {
  if (!params.tunnelId || typeof params.tunnelId !== "string" || params.tunnelId.trim() === "") {
    throw new Error("tunnelId is required for tunnel configuration");
  }

  const credsFile = params.credentialsFile || `/etc/cloudflared/${params.tunnelId}.json`;
  const catchAll = params.catchAllService || "http_status:404";

  // Validate all routes upfront; specific hostnames first, wildcard hostnames last
  const sortedRoutes = validateAndSortRoutes(params.routes);

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

// ─── CLOUDFLARE API (REMOTELY-MANAGED) JSON CONFIG ───────────────────────────

const DURATION_KEYS = new Set(["connectTimeout", "keepAliveTimeout", "tcpKeepAlive"]);

/** The API expects durations as integer seconds; YAML accepts Go durations like "30s" / "1m30s". */
function durationToSeconds(value: string): number | string {
  const parts = value.trim().match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!parts || !value.trim()) return value;
  return Number(parts[1] || 0) * 3600 + Number(parts[2] || 0) * 60 + Number(parts[3] || 0);
}

function toApiOriginRequest(originRequest: IngressOriginRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(originRequest)) {
    if (value === undefined) continue;
    out[key] = DURATION_KEYS.has(key) && typeof value === "string" ? durationToSeconds(value) : value;
  }
  return out;
}

/**
 * Generates the remotely-managed tunnel configuration body for
 * `PUT /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations`, with the same rule
 * ordering as the YAML (specific → wildcard → control-plane fallback → catch-all).
 * `tunnelId` / `credentialsFile` are not part of the API body and are ignored.
 */
export function generateTunnelConfigJson(
  params: Omit<TunnelConfigParams, "tunnelId"> & { tunnelId?: string }
): CloudflareTunnelConfigurationBody {
  const sortedRoutes = validateAndSortRoutes(params.routes);
  const ingress: IngressRule[] = sortedRoutes.map((r) => {
    const rule: IngressRule = {
      hostname: r.hostname,
      service: `http://${r.targetHost || "localhost"}:${r.targetPort}`,
    };
    if (r.path) rule.path = r.path;
    const originReq = r.originRequest || params.defaultOriginRequest;
    if (originReq) rule.originRequest = toApiOriginRequest(originReq) as IngressOriginRequest;
    return rule;
  });

  if (params.controlPlaneFallback && !sortedRoutes.some((r) => r.hostname.startsWith("*"))) {
    ingress.push({ hostname: "*.syncbay.app", service: params.controlPlaneFallback });
  }
  ingress.push({ service: params.catchAllService || "http_status:404" });

  return { config: { ingress } };
}

// ─── WRITE + RELOAD ──────────────────────────────────────────────────────────

/** Atomically writes cloudflared YAML to `filePath` (sibling temp file + rename). */
export async function writeTunnelConfig(filePath: string, config: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, config, { encoding: "utf8", mode: 0o644 });
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => null);
    throw err;
  }
}

export interface ReloadTunnelOptions {
  /** Local config path (default: TUNNEL_CONFIG_FILE or /etc/cloudflared/config.yml). */
  configPath?: string;
  /** Command that restarts the local cloudflared (default: TUNNEL_RESTART_COMMAND or `systemctl restart cloudflared`). */
  restartCommand?: string;
  /** Injected for tests. */
  apiClient?: Pick<CloudflareApiClient, "updateTunnelConfiguration">;
  runCommand?: (command: string) => Promise<unknown>;
}

export interface ReloadTunnelResult {
  mode: "api" | "local";
  ruleCount: number;
  configPath?: string;
  version?: number;
}

/**
 * Applies ingress routes to the edge tunnel.
 * - API mode (CLOUDFLARE_TUNNEL_ID + CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN set): PUTs the
 *   remotely-managed configuration; connected cloudflared replicas pick it up without a restart.
 * - Local mode: writes the YAML atomically and restarts the local cloudflared, which has no
 *   SIGHUP/hot reload for locally-managed config.
 */
export async function reloadTunnel(
  params: Omit<TunnelConfigParams, "tunnelId"> & { tunnelId?: string },
  options: ReloadTunnelOptions = {}
): Promise<ReloadTunnelResult> {
  const tunnelId = params.tunnelId || process.env.CLOUDFLARE_TUNNEL_ID;
  const apiConfigured = Boolean(
    process.env.CLOUDFLARE_TUNNEL_ID && process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN
  );

  if (apiConfigured && tunnelId) {
    const body = generateTunnelConfigJson(params);
    const client = options.apiClient || new CloudflareApiClient();
    const result = await client.updateTunnelConfiguration(tunnelId, body);
    return { mode: "api", ruleCount: body.config.ingress.length, version: result.version };
  }

  if (!tunnelId) {
    throw new Error("reloadTunnel requires a tunnelId (or CLOUDFLARE_TUNNEL_ID) for a locally-managed config");
  }
  const configPath = options.configPath || process.env.TUNNEL_CONFIG_FILE || "/etc/cloudflared/config.yml";
  const yaml = generateTunnelConfig({ ...params, tunnelId });
  await writeTunnelConfig(configPath, yaml + "\n");

  const restartCommand = options.restartCommand || process.env.TUNNEL_RESTART_COMMAND || "systemctl restart cloudflared";
  const runCommand = options.runCommand || ((cmd: string) => promisify(exec)(cmd));
  await runCommand(restartCommand);

  return { mode: "local", ruleCount: yaml.split("\n").filter((l) => l.startsWith("  - ")).length, configPath };
}
