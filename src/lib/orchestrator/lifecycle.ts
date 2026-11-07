/**
 * Deployment lifecycle (Team A): what happens to running instances after a deploy and on
 * pause / delete / restart / rollback. Everything here acts on the runner (stop/restart the
 * container or process) as well as the DB and the edge route registry.
 *
 * `engine.ts` calls `onDeploymentActive` / `onDeploymentFailed`; the routers and
 * `instant-rollback.ts` call the service-level helpers. Bookkeeping failures are logged and
 * swallowed so they never turn a healthy deploy into a failed one.
 */

import { db } from "@/lib/db";
import { generateDefaultSubdomain } from "@/lib/domain-service";
import { registerServiceRouteAsync, removeServiceRouteAsync } from "@/lib/edge/service-registry";
import { getRunnerDriver, type RestartContainerResult, type RunnerDriver, type RunnerDriverType } from "./runner-driver";
import { cancelDeploymentJob, completeDeploymentJob } from "./job-queue";
import { requestTunnelReload } from "@/lib/tunnel/tunnel-sync";
import { isRemoteRunnerConfigured, isRunnerConfigError, RunnerConfigError } from "./runner-config";

type Client = any;
type PreviewState = "pending" | "success" | "failure";

const LIVE_STATUSES = ["ACTIVE", "CRASHED"];
const IN_FLIGHT_STATUSES = ["QUEUED", "BUILDING", "DEPLOYING"];

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** Every hostname the engine routes for a service (default subdomain, domains, PR host, *.localhost aliases). */
export function resolveServiceHostnames(service: {
  name?: string | null;
  environment?: { name?: string | null; isPrEnv?: boolean | null; prNumber?: number | null } | null;
  domains?: Array<{ hostname?: string | null }> | null;
}): string[] {
  const hosts = new Set<string>();
  const serviceName = service.name || "web";
  const addPlatform = (host: string) => {
    hosts.add(host);
    if (host.endsWith(".syncbay.app")) {
      const sub = host.slice(0, -".syncbay.app".length);
      hosts.add(`${sub}.localhost`);
      hosts.add(sub);
    }
  };
  addPlatform(generateDefaultSubdomain(serviceName, service.environment?.name || "production"));
  for (const d of service.domains || []) if (d.hostname) addPlatform(d.hostname.toLowerCase());
  if (service.environment?.isPrEnv && service.environment.prNumber) {
    hosts.add(`${serviceName}-pr-${service.environment.prNumber}.syncbay.app`);
    hosts.add(`${serviceName}-pr-${service.environment.prNumber}.localhost`);
  }
  return [...hosts];
}

/**
 * The driver that hosts a deployment's instance (falls back to the configured default).
 * Falls back to the in-process driver only when no remote runner is configured and the instance
 * did not run on one. Otherwise a configuration error (missing RUNNER_SECRET, RUNNER_URL …) is
 * thrown as `RunnerConfigError`: acting on the wrong driver would report "stopped" while the
 * remote instance keeps running.
 */
export function driverFor(runnerDriver?: string | null, fallback?: RunnerDriver): RunnerDriver {
  if (fallback && (!runnerDriver || runnerDriver === fallback.type)) return fallback;
  try {
    return getRunnerDriver((runnerDriver as RunnerDriverType) || undefined);
  } catch (err: any) {
    const ranRemotely = Boolean(runnerDriver && runnerDriver !== "local");
    if (isRemoteRunnerConfigured() || ranRemotely || isRunnerConfigError(err)) {
      throw isRunnerConfigError(err) ? err : new RunnerConfigError(err?.message || String(err));
    }
    return fallback || getRunnerDriver("local");
  }
}

/**
 * Where the control plane probes a freshly started instance: through the runner daemon's
 * reverse proxy (webhook + RUNNER_URL), the SSH host, or loopback for local/in-process runs.
 */
export function resolveProbeTargets(
  driver: RunnerDriver,
  metadata: Record<string, any> | undefined,
  port: number,
  healthPath: string
): { primaryProbeUrl: string; rootProbeUrl: string; probeHeaders?: Record<string, string> } {
  const runnerUrl = (driver as any).runnerUrl || process.env.RUNNER_URL;
  if (driver.type === "webhook" && runnerUrl) {
    const base = String(runnerUrl).replace(/\/$/, "");
    return {
      primaryProbeUrl: `${base}${healthPath}`,
      rootProbeUrl: `${base}/`,
      probeHeaders: { "x-target-port": String(port) },
    };
  }
  const host = driver.type === "ssh" && typeof metadata?.host === "string" ? metadata.host : "127.0.0.1";
  return { primaryProbeUrl: `http://${host}:${port}${healthPath}`, rootProbeUrl: `http://${host}:${port}/` };
}

async function loadServiceForRouting(serviceId: string, client: Client) {
  return client.service.findUnique({
    where: { id: serviceId },
    include: { domains: true, environment: true },
  });
}

/** DB edge resolution (`resolveServiceRouteFromDb`) reads `service.port` as the live port. */
async function setServicePort(client: Client, serviceId: string, port?: number): Promise<void> {
  if (!port || typeof client.service?.update !== "function") return;
  await client.service.update({ where: { id: serviceId }, data: { port } }).catch(() => null);
}

async function setRoutes(hosts: string[], status: string, port?: number, isLocal?: boolean): Promise<void> {
  for (const host of hosts) {
    await registerServiceRouteAsync(host, port, status, port ? `http://127.0.0.1:${port}` : undefined, isLocal);
  }
}

async function reportPreview(deploymentId: string, state: PreviewState, client: Client): Promise<void> {
  try {
    const { reportPreviewDeploymentStatus } = await import("./pr-manager");
    await reportPreviewDeploymentStatus(deploymentId, state, client);
  } catch (err: any) {
    console.warn(`[lifecycle] Preview status update failed for ${deploymentId}: ${err?.message}`);
  }
}

async function stopInstance(
  dep: { id: string; cfContainerId?: string | null; runnerDriver?: string | null },
  fallback?: RunnerDriver
): Promise<{ stopped: boolean; queued?: boolean; message?: string }> {
  if (!dep.cfContainerId) return { stopped: false, message: "no instance" };
  try {
    const res = await driverFor(dep.runnerDriver, fallback).stopContainer(dep.cfContainerId);
    return { stopped: res.stopped, queued: res.queued, message: res.message };
  } catch (err: any) {
    return { stopped: false, message: err?.message };
  }
}

// ─── Engine hooks ────────────────────────────────────────────────────────────

export interface ActiveDeploymentContext {
  deploymentId: string;
  serviceId: string;
  containerId?: string;
  port: number;
  driver: RunnerDriver;
  hosts: string[];
  isLocal: boolean;
  simulated?: boolean;
  log?: (line: string) => void;
}

/**
 * After a deployment goes ACTIVE: persist where it runs, close its job, supersede (and stop)
 * older live deployments of the service, and report the PR preview status.
 * If a *newer* deployment of the service is already live, this one is the stale one: it is
 * superseded and stopped instead, and the routes are pointed back at the newer instance.
 */
export async function onDeploymentActive(ctx: ActiveDeploymentContext, client: Client = db): Promise<void> {
  const log = ctx.log || (() => {});
  try {
    await client.deployment
      .update({ where: { id: ctx.deploymentId }, data: { assignedPort: ctx.port, runnerDriver: ctx.driver.type } })
      .catch(() => null);
    await completeDeploymentJob(
      ctx.deploymentId,
      "SUCCEEDED",
      { exitCode: 0, result: { containerId: ctx.containerId, port: ctx.port, simulated: Boolean(ctx.simulated) } },
      client
    );

    if (typeof client.deployment?.findMany === "function") {
      const current = await client.deployment.findUnique({ where: { id: ctx.deploymentId }, select: { createdAt: true } });
      const others: any[] = await client.deployment.findMany({
        where: { serviceId: ctx.serviceId, id: { not: ctx.deploymentId }, status: { in: LIVE_STATUSES } },
        select: { id: true, cfContainerId: true, createdAt: true, assignedPort: true, runnerDriver: true },
        orderBy: { createdAt: "desc" },
      });
      const createdAt = current?.createdAt ? new Date(current.createdAt).getTime() : Date.now();
      const newer = others.find((o) => new Date(o.createdAt).getTime() > createdAt);

      if (newer) {
        log(`[deploy] A newer deployment ${newer.id} is already live; superseding this one`);
        await client.deployment.update({ where: { id: ctx.deploymentId }, data: { status: "SUPERSEDED" } });
        if (ctx.containerId && ctx.containerId !== newer.cfContainerId) {
          await ctx.driver.stopContainer(ctx.containerId).catch(() => null);
        }
        if (newer.assignedPort) {
          await setRoutes(ctx.hosts, "ACTIVE", newer.assignedPort, newer.runnerDriver === "local");
          await setServicePort(client, ctx.serviceId, newer.assignedPort);
        }
      } else {
        for (const old of others) {
          const res = await client.deployment.updateMany({
            where: { id: old.id, status: { in: LIVE_STATUSES } },
            data: { status: "SUPERSEDED" },
          });
          if (res.count === 0) continue;
          if (old.cfContainerId && old.cfContainerId !== ctx.containerId) {
            const stop = await stopInstance(old, ctx.driver);
            log(
              `[deploy] Superseded deployment ${old.id}; ${stop.stopped ? "stopped" : stop.queued ? "stop queued for" : "could not stop"} instance ${old.cfContainerId}${
                stop.stopped || stop.queued ? "" : ` (${stop.message})`
              }`
            );
          } else {
            log(`[deploy] Superseded deployment ${old.id}`);
          }
        }
      }
    }
  } catch (err: any) {
    console.warn(`[lifecycle] onDeploymentActive bookkeeping failed for ${ctx.deploymentId}: ${err?.message}`);
  }
  await reportPreview(ctx.deploymentId, "success", client);
}

export async function onDeploymentFailed(
  ctx: { deploymentId: string; error: string; exitCode?: number },
  client: Client = db
): Promise<void> {
  await completeDeploymentJob(ctx.deploymentId, "FAILED", { errorMessage: ctx.error, exitCode: ctx.exitCode ?? 1 }, client);
  await reportPreview(ctx.deploymentId, "failure", client);
}

// ─── Service-level operations (routers) ──────────────────────────────────────

export interface StopReport {
  stopped: string[];
  queued: string[];
  failed: Array<{ deploymentId: string; message?: string }>;
  cancelled: string[];
  hosts: string[];
}

export interface StopOptions {
  /** Cancel QUEUED/BUILDING/DEPLOYING deployments too (default true; scale-to-zero passes false). */
  cancelInFlight?: boolean;
  /** Also stop and mark these deployments, whatever their status (scale-to-zero / spending cap target). */
  include?: string[];
  /** Per-instance callback, e.g. to write the outcome into the deployment's log. */
  onInstance?: (deploymentId: string, containerId: string | null, res: { stopped: boolean; queued?: boolean; message?: string }) => void;
  /** Tunnel reload reason (default `<mode>:<serviceId>`). */
  reason?: string;
}

/**
 * The one stop implementation, shared by the routers, PR previews and scale-to-zero
 * (`src/lib/scale/service-control.ts`).
 * `pause`: stop live instances, mark them SLEEPING and route every host to the sleeping splash.
 * `delete`: stop live and sleeping instances, mark them CANCELLED and remove every route.
 * The runner's stop endpoint frees the port and drops the instance's tunnel ingress, and the
 * control-plane tunnel config is reloaded afterwards.
 */
export async function stopServiceInstances(
  serviceId: string,
  mode: "pause" | "delete",
  client: Client = db,
  opts: StopOptions = {}
): Promise<StopReport> {
  const report: StopReport = { stopped: [], queued: [], failed: [], cancelled: [], hosts: [] };
  const service = await loadServiceForRouting(serviceId, client);
  if (!service) return report;

  const statuses = mode === "pause" ? LIVE_STATUSES : [...LIVE_STATUSES, "SLEEPING"];
  const include = (opts.include || []).filter(Boolean);
  const live: any[] = await client.deployment.findMany({
    where: { serviceId, OR: [{ status: { in: statuses } }, ...(include.length ? [{ id: { in: include } }] : [])] },
    select: { id: true, cfContainerId: true, runnerDriver: true },
  });
  // Resolve every hosting driver first: a runner configuration error throws here, before any
  // deployment is marked stopped, so the caller reports the failure instead of a false "stopped".
  const drivers = new Map<string, RunnerDriver>();
  for (const dep of live) if (dep.cfContainerId) drivers.set(dep.id, driverFor(dep.runnerDriver));
  for (const dep of live) {
    const res = await stopInstance(dep, drivers.get(dep.id));
    if (res.stopped) report.stopped.push(dep.id);
    else if (res.queued) report.queued.push(dep.id);
    else if (dep.cfContainerId) report.failed.push({ deploymentId: dep.id, message: res.message });
    opts.onInstance?.(dep.id, dep.cfContainerId ?? null, res);
    await client.deployment.update({
      where: { id: dep.id },
      data: { status: mode === "pause" ? "SLEEPING" : "CANCELLED" },
    });
  }

  if (opts.cancelInFlight !== false) {
    const inFlight: any[] = await client.deployment.findMany({
      where: { serviceId, status: { in: IN_FLIGHT_STATUSES }, id: { notIn: include } },
      select: { id: true },
    });
    for (const dep of inFlight) {
      await cancelDeploymentJob(dep.id, client);
      await client.deployment.update({ where: { id: dep.id }, data: { status: "CANCELLED", completedAt: new Date() } });
      report.cancelled.push(dep.id);
    }
  }

  report.hosts = resolveServiceHostnames(service);
  if (mode === "pause") await setRoutes(report.hosts, "SLEEPING");
  else for (const host of report.hosts) await removeServiceRouteAsync(host);
  // Drop the stopped ports from the tunnel ingress (no-op unless a tunnel is configured; never throws).
  await requestTunnelReload(opts.reason || `${mode}:${serviceId}`);
  return report;
}

/** Re-runs a deployment's build as a new deployment (fast redeploy, caches kept). */
async function redeployBuild(
  source: { id: string; serviceId: string; buildId: string; build?: { commitSha?: string | null } | null },
  reason: string,
  userId: string | undefined,
  client: Client
): Promise<string> {
  const deployment = await client.deployment.create({
    data: { serviceId: source.serviceId, buildId: source.buildId, triggeredBy: userId, status: "QUEUED" },
  });
  const { scheduleDeployment } = await import("./schedule");
  await scheduleDeployment(deployment.id, source.buildId, source.serviceId, {
    serviceId: source.serviceId,
    commitSha: source.build?.commitSha || undefined,
    commitMessage: `${reason} (from deployment ${source.id.slice(0, 8)})`,
    cleanBuild: false,
    userId,
  });
  return deployment.id;
}

export interface RestartReport {
  mode: "restart" | "queued" | "redeploy" | "none";
  deploymentId?: string;
  containerId?: string;
  port?: number;
  message?: string;
}

/**
 * Restarts the service's live instance in place (runner `POST /api/containers/:id/restart`:
 * stop, then start the same image or process on the same port). Falls back to a fast
 * redeploy of the live build when the runner cannot restart it.
 */
export async function restartServiceInstance(serviceId: string, userId?: string, client: Client = db): Promise<RestartReport> {
  const active = await client.deployment.findFirst({
    where: { serviceId, status: { in: LIVE_STATUSES } },
    orderBy: { createdAt: "desc" },
    include: { build: true },
  });
  if (!active) {
    const latest = await client.deployment.findFirst({
      where: { serviceId, build: { status: "SUCCEEDED" } },
      orderBy: { createdAt: "desc" },
      include: { build: true },
    });
    if (!latest) return { mode: "none", message: "Service has no successful deployment to restart" };
    return { mode: "redeploy", deploymentId: await redeployBuild(latest, "Restart", userId, client) };
  }

  const driver = driverFor(active.runnerDriver);
  if (active.cfContainerId && typeof driver.restartContainer === "function") {
    const res: RestartContainerResult = await driver.restartContainer(active.cfContainerId).catch((err: any) => ({
      restarted: false,
      containerId: active.cfContainerId,
      message: err?.message,
    }));
    if (res.restarted) {
      const port = res.port || active.assignedPort || undefined;
      await client.deployment.update({
        where: { id: active.id },
        data: { status: "ACTIVE", cfContainerId: res.containerId, ...(port ? { assignedPort: port } : {}) },
      });
      const service = await loadServiceForRouting(serviceId, client);
      if (service && port) await setRoutes(resolveServiceHostnames(service), "ACTIVE", port, driver.type === "local");
      await setServicePort(client, serviceId, port);
      await requestTunnelReload(`restart:${serviceId}`);
      return { mode: "restart", deploymentId: active.id, containerId: res.containerId, port };
    }
    if (res.queued) return { mode: "queued", deploymentId: active.id, message: res.message };
  }
  return { mode: "redeploy", deploymentId: await redeployBuild(active, "Restart", userId, client) };
}

/** Restarts a superseded deployment's instance and moves traffic to it, or redeploys its build. */
export async function rollbackToDeployment(
  target: { id: string; serviceId: string; buildId: string; cfContainerId?: string | null; runnerDriver?: string | null; assignedPort?: number | null; build?: { commitSha?: string | null } | null },
  currentActive: { id: string; cfContainerId?: string | null; runnerDriver?: string | null } | null,
  userId: string,
  client: Client = db
): Promise<RestartReport> {
  const driver = driverFor(target.runnerDriver);
  if (target.cfContainerId && driver.type !== "queue" && typeof driver.restartContainer === "function") {
    const res = await driver.restartContainer(target.cfContainerId).catch(() => null);
    const port = res?.port || target.assignedPort || undefined;
    if (res?.restarted && port) {
      const service = await loadServiceForRouting(target.serviceId, client);
      if (service) await setRoutes(resolveServiceHostnames(service), "ACTIVE", port, driver.type === "local");
      await setServicePort(client, target.serviceId, port);
      await client.deployment.update({
        where: { id: target.id },
        data: { status: "ACTIVE", cfContainerId: res.containerId, assignedPort: port, completedAt: new Date() },
      });
      if (currentActive) {
        await client.deployment.update({ where: { id: currentActive.id }, data: { status: "SUPERSEDED" } });
        if (currentActive.cfContainerId && currentActive.cfContainerId !== res.containerId) await stopInstance(currentActive, driver);
      }
      await requestTunnelReload(`rollback:${target.id}`);
      return { mode: "restart", deploymentId: target.id, containerId: res.containerId, port };
    }
  }
  // The instance is gone (or lives on a pull-mode runner): rebuild from the target's build.
  // The current deployment keeps serving until the new one is ACTIVE and supersedes it.
  return { mode: "redeploy", deploymentId: await redeployBuild(target, "Rollback", userId, client) };
}
