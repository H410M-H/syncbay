/**
 * Syncbay PaaS — keeps the edge tunnel's ingress in step with the database.
 *
 * `requestTunnelReload(reason)` is called after anything that changes which hostnames
 * should reach which port: a deploy going ACTIVE, a deployment being stopped/removed, a
 * custom domain verified or deleted. It:
 * - is a no-op when no tunnel is configured (API mode: CLOUDFLARE_TUNNEL_ID +
 *   CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN; local mode: CLOUDFLARE_TUNNEL_ID +
 *   TUNNEL_CONFIG_FILE);
 * - debounces bursts in this process (TUNNEL_RELOAD_DEBOUNCE_MS, default 300 ms) into one run;
 * - serialises runs across instances with a Postgres transaction-level advisory lock, and
 *   rebuilds the FULL table from the DB after taking the lock, so the last writer always
 *   publishes the latest state;
 * - never throws: failures come back as `{ status: "error" }` and are logged.
 *
 * The table: every non-deleted, non-paused service that has an ACTIVE deployment and a
 * port, under its default `<svc>-<env>.syncbay.app` host plus each of its ACTIVE domains,
 * mapped to `http://127.0.0.1:<port>` on the tunnel host. Anything else falls through to
 * TUNNEL_FALLBACK_SERVICE (default `http_status:404`).
 */

import { db } from "@/lib/db";
import { platformHostnames } from "@/lib/domains/service-hosts";
import { reloadTunnel, validateHostname, type ReloadTunnelOptions, type RouteMapping } from "@/lib/tunnel/tunnel-config";

/** Advisory lock key shared by every control-plane instance ("SYNC" + 3). */
const TUNNEL_LOCK_KEY = 0x53594e43_0003;

export type TunnelSyncMode = "api" | "local";

export interface TunnelSyncResult {
  status: "applied" | "skipped" | "error";
  mode?: TunnelSyncMode;
  ruleCount?: number;
  hostnames?: string[];
  reasons: string[];
  error?: string;
}

export function getTunnelSyncMode(env: NodeJS.ProcessEnv = process.env): TunnelSyncMode | null {
  if (!env.CLOUDFLARE_TUNNEL_ID) return null;
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) return "api";
  if (env.TUNNEL_CONFIG_FILE) return "local";
  return null;
}

type RouteDb = Pick<typeof db, "service">;

/** Builds the full ingress table from ACTIVE services and domains. */
export async function buildIngressRoutesFromDb(client: RouteDb = db): Promise<RouteMapping[]> {
  const services = await client.service.findMany({
    where: {
      deletedAt: null,
      isPaused: false,
      deployments: { some: { status: "ACTIVE" } },
      environment: { project: { deletedAt: null } },
    },
    select: {
      name: true,
      port: true,
      environment: { select: { name: true } },
      // The service's own hostnames: its generated platform host and verified custom domains.
      domains: { where: { status: "ACTIVE" }, select: { hostname: true, isGenerated: true } },
      // The live instance's host port on the runner.
      deployments: {
        where: { status: "ACTIVE", assignedPort: { not: null } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { assignedPort: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const routes = new Map<string, RouteMapping>();
  for (const svc of services) {
    const targetPort = svc.deployments?.[0]?.assignedPort ?? svc.port;
    if (!targetPort) continue;
    const hosts = [...platformHostnames(svc), ...svc.domains.map((d) => d.hostname)];
    for (const raw of hosts) {
      const hostname = raw.trim().toLowerCase();
      if (!validateHostname(hostname) || routes.has(hostname)) continue;
      routes.set(hostname, { hostname, targetPort, targetHost: "127.0.0.1" });
    }
  }
  return [...routes.values()];
}

/**
 * Takes the advisory lock, rebuilds the table and applies it. Throws on failure; callers
 * normally use `requestTunnelReload`.
 */
export async function syncTunnelIngress(
  reasons: string[] = [],
  options: ReloadTunnelOptions = {}
): Promise<TunnelSyncResult> {
  const mode = getTunnelSyncMode();
  if (!mode) return { status: "skipped", reasons, error: "tunnel not configured" };

  const apply = async (client: RouteDb): Promise<TunnelSyncResult> => {
    const routes = await buildIngressRoutesFromDb(client);
    const result = await reloadTunnel(
      { routes, catchAllService: process.env.TUNNEL_FALLBACK_SERVICE || "http_status:404" },
      options
    );
    return { status: "applied", mode: result.mode, ruleCount: result.ruleCount, hostnames: routes.map((r) => r.hostname), reasons };
  };

  if (typeof (db as any).$transaction !== "function") return apply(db);
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${TUNNEL_LOCK_KEY}::bigint)`;
      return apply(tx);
    },
    { maxWait: 10000, timeout: 60000 }
  );
}

interface PendingBatch {
  reasons: string[];
  promise: Promise<TunnelSyncResult>;
}

const state = globalThis as unknown as { __syncbayTunnelBatch?: PendingBatch | null; __syncbayTunnelRun?: Promise<unknown> };

/**
 * Debounced, never-throwing tunnel reload. Calls within the debounce window share one run
 * (and one result). Resolves immediately with `skipped` when no tunnel is configured.
 */
export function requestTunnelReload(reason: string, options: ReloadTunnelOptions & { debounceMs?: number } = {}): Promise<TunnelSyncResult> {
  if (!getTunnelSyncMode()) {
    return Promise.resolve({ status: "skipped", reasons: [reason], error: "tunnel not configured" });
  }
  const pending = state.__syncbayTunnelBatch;
  if (pending) {
    pending.reasons.push(reason);
    return pending.promise;
  }

  const delay = options.debounceMs ?? Number(process.env.TUNNEL_RELOAD_DEBOUNCE_MS || 300);
  const reasons = [reason];
  const promise = new Promise<TunnelSyncResult>((resolve) => {
    setTimeout(() => {
      // Close the batch before running so later calls schedule a fresh reload of newer state.
      state.__syncbayTunnelBatch = null;
      const previous = state.__syncbayTunnelRun || Promise.resolve();
      const run = previous
        .catch(() => null)
        .then(() => syncTunnelIngress(reasons, options))
        .catch((err: any): TunnelSyncResult => {
          console.warn(`[tunnel-sync] reload failed (${reasons.join(", ")}): ${err?.message || err}`);
          return { status: "error", reasons, error: err?.message || String(err) };
        });
      state.__syncbayTunnelRun = run;
      run.then(resolve);
    }, Math.max(0, delay));
  });
  state.__syncbayTunnelBatch = { reasons, promise };
  return promise;
}
