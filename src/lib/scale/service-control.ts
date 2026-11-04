/**
 * Syncbay PaaS — Stop a running service for scale-to-zero or the spending cap.
 *
 * Stops the container through the runner driver, marks the latest deployment
 * SLEEPING (optionally pausing the service), registers every hostname of the
 * service as SLEEPING so the edge proxy serves the wake splash, and asks for a
 * tunnel ingress reload.
 */

import { db } from "@/lib/db";
import { generateDefaultSubdomain } from "@/lib/domain-service";
import { registerServiceRouteAsync } from "@/lib/edge/service-registry";
import { getRunnerDriver } from "@/lib/orchestrator/runner-driver";
import { logEventBus } from "@/lib/telemetry/event-bus";
import { requestTunnelReload } from "@/lib/tunnel/tunnel-sync";

export interface HostnameSource {
  name: string;
  domains?: Array<{ hostname: string | null }>;
  environment?: { name: string; isPrEnv?: boolean | null; prNumber?: number | null } | null;
}

/** Every hostname the engine registers for a service (mirrors executeDeployment()). */
export function serviceHostnames(service: HostnameSource): string[] {
  const hosts = new Set<string>();
  const addWithAliases = (host: string) => {
    hosts.add(host);
    if (host.endsWith(".syncbay.app")) {
      const sub = host.slice(0, -".syncbay.app".length);
      hosts.add(`${sub}.localhost`);
      hosts.add(sub);
    }
  };
  addWithAliases(generateDefaultSubdomain(service.name || "web", service.environment?.name || "production"));
  for (const d of service.domains || []) {
    if (d.hostname) addWithAliases(d.hostname.toLowerCase());
  }
  if (service.environment?.isPrEnv && service.environment.prNumber) {
    hosts.add(`${service.name}-pr-${service.environment.prNumber}.syncbay.app`);
    hosts.add(`${service.name}-pr-${service.environment.prNumber}.localhost`);
  }
  return [...hosts];
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

  if (deployment.cfContainerId) {
    try {
      const res = await getRunnerDriver().stopContainer(deployment.cfContainerId);
      result.containerStopped = Boolean(res.stopped);
      log(`[scale-to-zero] Container ${deployment.cfContainerId} ${res.stopped ? "stopped" : "was not running"}`);
    } catch (err) {
      result.error = (err as Error)?.message || String(err);
      log(`[scale-to-zero] Failed to stop container ${deployment.cfContainerId}: ${result.error}`, "stderr");
    }
  }

  await db.deployment.update({ where: { id: deployment.id }, data: { status: "SLEEPING" } });
  if (options.pause) {
    await db.service.update({ where: { id: service.id }, data: { isPaused: true } });
  }
  for (const host of serviceHostnames(service)) {
    await registerServiceRouteAsync(host, undefined, "SLEEPING");
  }
  // Drop the stopped port from the tunnel ingress (no-op unless a tunnel is configured).
  await requestTunnelReload(`sleep:${service.id}`);
  await logEventBus.flush();
  return result;
}
