/**
 * Syncbay Runner — locally-managed cloudflared ingress config.
 *
 * Mirrors the subset of `src/lib/tunnel/tunnel-config.ts` the runner needs (the runner is
 * a separate package and cannot import from the control plane). Generates the
 * `cloudflared tunnel --config <file> run` YAML and writes it atomically (tmp + rename).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface TunnelIngressRoute {
  hostname: string;
  port: number;
}

export interface RunnerTunnelConfigParams {
  tunnelId: string;
  credentialsFile?: string;
  routes: TunnelIngressRoute[];
  /** Final catch-all service (e.g. the runner daemon itself). Defaults to http_status:404. */
  catchAllService?: string;
}

const HOSTNAME_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

export function isValidIngressHostname(hostname: string): boolean {
  return typeof hostname === "string" && hostname.length <= 253 && HOSTNAME_RE.test(hostname);
}

/** Routes each hostname to http://127.0.0.1:<port>; specific hosts first, wildcards last, catch-all at the end. */
export function generateRunnerTunnelYaml(params: RunnerTunnelConfigParams): string {
  if (!params.tunnelId?.trim()) {
    throw new Error("tunnelId is required for a locally-managed cloudflared config");
  }
  const routes = params.routes
    .filter((r) => isValidIngressHostname(r.hostname) && Number.isInteger(r.port) && r.port >= 1 && r.port <= 65535)
    .sort((a, b) => {
      const aw = a.hostname.startsWith("*");
      const bw = b.hostname.startsWith("*");
      if (aw !== bw) return aw ? 1 : -1;
      return a.hostname.localeCompare(b.hostname);
    });

  const lines = [
    `tunnel: ${params.tunnelId}`,
    `credentials-file: ${params.credentialsFile || `/etc/cloudflared/${params.tunnelId}.json`}`,
    `ingress:`,
  ];
  for (const r of routes) {
    lines.push(`  - hostname: ${JSON.stringify(r.hostname.toLowerCase())}`);
    lines.push(`    service: http://127.0.0.1:${r.port}`);
  }
  lines.push(`  - service: ${params.catchAllService || "http_status:404"}`);
  return lines.join("\n") + "\n";
}

/** Writes `content` to `filePath` atomically: a sibling temp file is written, then renamed over the target. */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => null);
    throw err;
  }
}
