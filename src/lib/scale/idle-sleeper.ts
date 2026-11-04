/**
 * Syncbay PaaS — Scale-to-zero idle sleeper (run by the 15-minute cron).
 *
 * A service with `scaleToZero` whose latest deployment is ACTIVE is put to sleep
 * when nothing touched it for `idleTimeoutSecs`. Activity is the latest of:
 * - the last routed request (`Service.lastRequestAt`, or Upstash when configured),
 * - the deployment going live (`completedAt`),
 * - inbound network traffic seen in docker metric samples (requests that reach
 *   the runner directly through the tunnel never pass through `proxy.ts`).
 * The wake endpoint (`/api/v1/services/wake`) brings it back.
 */

import { db } from "@/lib/db";
import { readUpstashActivity } from "@/lib/scale/activity";
import { serviceHostnames, stopServiceToSleep, type StopForSleepResult } from "@/lib/scale/service-control";

/** Inbound bytes within the idle window that count as traffic. */
const NETWORK_ACTIVITY_BYTES = 16 * 1024;

async function lastNetworkActivity(deploymentId: string, since: Date): Promise<number | null> {
  const samples = await db.metricSample.findMany({
    where: { deploymentId, sampledAt: { gte: since }, netRxBytes: { not: null } },
    orderBy: { sampledAt: "asc" },
    select: { sampledAt: true, netRxBytes: true },
  });
  let latest: number | null = null;
  for (let i = 1; i < samples.length; i++) {
    const delta = (samples[i].netRxBytes ?? 0) - (samples[i - 1].netRxBytes ?? 0);
    if (delta >= NETWORK_ACTIVITY_BYTES) latest = samples[i].sampledAt.getTime();
  }
  return latest;
}

export interface IdleSleepReport {
  checked: number;
  slept: StopForSleepResult[];
  errors: Array<{ serviceId: string; error: string }>;
}

export async function sleepIdleServices(options: { now?: number } = {}): Promise<IdleSleepReport> {
  const now = options.now ?? Date.now();
  const report: IdleSleepReport = { checked: 0, slept: [], errors: [] };

  const services = await db.service.findMany({
    where: { deletedAt: null, isPaused: false, scaleToZero: true },
    include: {
      domains: { select: { hostname: true } },
      environment: { select: { name: true, isPrEnv: true, prNumber: true } },
      deployments: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  for (const service of services) {
    const latest = service.deployments[0];
    if (!latest || latest.status !== "ACTIVE") continue;
    report.checked += 1;
    try {
      const idleMs = Math.max(60, service.idleTimeoutSecs || 300) * 1000;
      const hosts = serviceHostnames(service);
      let upstashAt: number | null = null;
      try {
        upstashAt = await readUpstashActivity(hosts);
      } catch {
        // Upstash unreachable: do not sleep on incomplete information.
        continue;
      }
      const candidates = [
        service.lastRequestAt?.getTime() ?? null,
        upstashAt,
        (latest.completedAt ?? latest.startedAt ?? latest.createdAt).getTime(),
      ].filter((v): v is number => typeof v === "number");
      let lastActivity = Math.max(...candidates);
      if (now - lastActivity < idleMs) continue;

      const net = await lastNetworkActivity(latest.id, new Date(now - idleMs));
      if (net !== null) lastActivity = Math.max(lastActivity, net);
      if (now - lastActivity < idleMs) continue;

      const idleSecs = Math.round((now - lastActivity) / 1000);
      report.slept.push(
        await stopServiceToSleep(service, latest, {
          reason: `No requests for ${idleSecs}s (idle timeout ${Math.round(idleMs / 1000)}s); putting service ${service.name} to sleep`,
        })
      );
    } catch (err) {
      report.errors.push({ serviceId: service.id, error: (err as Error)?.message || String(err) });
    }
  }
  return report;
}
