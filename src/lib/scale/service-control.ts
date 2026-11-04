/**
 * Syncbay PaaS — Stop a running service for scale-to-zero or the spending cap.
 *
 * Stops the container through the runner driver, marks the latest deployment
 * SLEEPING (optionally pausing the service), registers every hostname of the
 * service as SLEEPING so the edge proxy serves the wake splash, and asks for a
 * tunnel ingress reload.
 */

import { db } from "@/lib/db";
import { resolveServiceHostnames, stopServiceInstances } from "@/lib/orchestrator/lifecycle";
import { logEventBus } from "@/lib/telemetry/event-bus";

export interface HostnameSource {
  name: string;
  domains?: Array<{ hostname: string | null }>;
  environment?: { name: string; isPrEnv?: boolean | null; prNumber?: number | null } | null;
}

/** Every hostname the engine registers for a service (shared with the deploy lifecycle). */
export function serviceHostnames(service: HostnameSource): string[] {
  return resolveServiceHostnames(service);
}

export interface StopForSleepResult {
  serviceId: string;
  deploymentId: string;
  containerStopped: boolean;
  error?: string;
}

/**
 * Puts a service to sleep. `pause: true` also sets `Service.isPaused` (used by the
 * spending cap, so only a user action resumes it).
 *
 * The stop itself is the deploy lifecycle's `stopServiceInstances(…, "pause")`: it stops every
 * live instance through the driver that runs it, marks them (and `deployment`) SLEEPING, routes
 * every hostname SLEEPING and reloads the tunnel ingress. In-flight deploys are left alone.
 */
export async function stopServiceToSleep(
  service: HostnameSource & { id: string },
  deployment: { id: string; cfContainerId: string | null },
  options: { reason: string; pause?: boolean }
): Promise<StopForSleepResult> {
  const result: StopForSleepResult = { serviceId: service.id, deploymentId: deployment.id, containerStopped: false };
  const log = (message: string, stream: "system" | "stderr" = "system") =>
    logEventBus.publish(deployment.id, { stream, message, timestamp: new Date().toISOString() });

  log(`[scale-to-zero] ${options.reason}`);

  try {
    await stopServiceInstances(service.id, "pause", db, {
      cancelInFlight: false,
      include: [deployment.id],
      reason: `sleep:${service.id}`,
      onInstance: (depId, containerId, res) => {
        if (!containerId) return;
        if (depId === deployment.id) {
          result.containerStopped = Boolean(res.stopped);
          if (!res.stopped && !res.queued && res.message && res.message !== "no instance") result.error = res.message;
        }
        logEventBus.publish(depId, {
          stream: res.stopped || res.queued ? "system" : "stderr",
          message: `[scale-to-zero] Container ${containerId} ${res.stopped ? "stopped" : res.queued ? "stop queued for its runner" : `was not running${res.message ? ` (${res.message})` : ""}`}`,
          timestamp: new Date().toISOString(),
        });
      },
    });
  } catch (err) {
    result.error = (err as Error)?.message || String(err);
    log(`[scale-to-zero] Failed to stop service ${service.id}: ${result.error}`, "stderr");
  }

  if (options.pause) {
    await db.service.update({ where: { id: service.id }, data: { isPaused: true } });
  }
  await logEventBus.flush();
  return result;
}
