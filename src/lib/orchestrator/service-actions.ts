/**
 * Service-level actions shared by the routers and the REST API (Team A, v1.2):
 * - `redeployFromDeployment()`: the fast redeploy / clean rebuild of a previous deployment
 *   (`deployment.redeploy`, `project.redeployAll`, `POST /api/v1/deployments`).
 * - `setServicePaused()`: pause (stop instances, route to the sleeping splash) or resume (wake the
 *   sleeping deployment) one service (`service.setPaused`, `project.pauseAll` / `resumeAll`).
 * Both schedule work through `scheduleDeployment()`; callers check access and preflight the runner.
 */

import { scheduleDeployment } from "./schedule";
import { resolveHeadCommitSha } from "./pr-manager";
import { stopServiceInstances, type StopReport } from "./lifecycle";
import { assertRunnerConfigured } from "./runner-config";

type Client = any;

const LIVE_OR_IN_FLIGHT = ["ACTIVE", "CRASHED", "QUEUED", "BUILDING", "DEPLOYING"];

export interface RedeploySource {
  id: string;
  serviceId: string;
  buildId: string;
  build?: { status?: string | null; commitSha?: string | null; commitMessage?: string | null } | null;
  service: { repoUrl?: string | null; branch?: string | null; environment: { projectId: string } };
}

/** A missing or failed build cannot be reused, so the redeploy has to rebuild. */
export function needsRebuild(prev: { build?: { status?: string | null } | null }): boolean {
  return !prev.build || prev.build.status === "FAILED";
}

/**
 * Redeploys `prev` as a new deployment. `rebuild: false` reuses its build (caches kept);
 * `rebuild: true` creates a new Build and sends `cleanBuild: true`. No commit SHA is invented:
 * a rebuild without one resolves the branch HEAD or leaves it null.
 */
export async function redeployFromDeployment(
  client: Client,
  prev: RedeploySource,
  opts: { rebuild: boolean; userId?: string; triggeredBy?: string }
): Promise<{ deployment: any; buildId: string; rebuild: boolean }> {
  const triggeredBy = opts.triggeredBy ?? opts.userId;
  let buildId = prev.buildId;

  if (opts.rebuild) {
    const build = await client.build.create({
      data: {
        serviceId: prev.serviceId,
        commitSha:
          prev.build?.commitSha ||
          (await resolveHeadCommitSha(prev.service.repoUrl, prev.service.branch, {
            projectId: prev.service.environment.projectId,
            userId: opts.userId,
          })),
        commitMessage: prev.build?.commitMessage
          ? `Rebuild: ${prev.build.commitMessage}`
          : `Redeploy with fresh build of ${prev.id.slice(0, 8)}`,
        triggeredBy,
        status: "QUEUED",
      },
    });
    buildId = build.id;
  }

  const deployment = await client.deployment.create({
    data: { serviceId: prev.serviceId, buildId, triggeredBy, status: "QUEUED" },
  });

  await scheduleDeployment(deployment.id, buildId, prev.serviceId, {
    serviceId: prev.serviceId,
    commitSha: prev.build?.commitSha || undefined,
    commitMessage: opts.rebuild
      ? `Clean rebuild of deployment ${prev.id.slice(0, 8)}`
      : `Fast redeploy of deployment ${prev.id.slice(0, 8)}`,
    cleanBuild: opts.rebuild,
    userId: opts.userId,
  });

  return { deployment, buildId, rebuild: opts.rebuild };
}

export interface PauseOutcome {
  service: any;
  lifecycle?: StopReport;
  wokeDeploymentId: string | null;
}

/**
 * Pause: stop every live instance on its runner (`stopServiceInstances(…, "pause")`: SLEEPING,
 * sleeping splash, tunnel reload), then set `isPaused`. A runner configuration error throws
 * `RunnerConfigError` before anything is marked stopped.
 *
 * Resume: clear `isPaused` and, unless the service is already live or deploying, wake its most
 * recent SLEEPING deployment by re-running it through the durable scheduler. Waking is a deploy,
 * so it preflights the runner configuration first and changes nothing when that fails.
 */
export async function setServicePaused(
  client: Client,
  serviceId: string,
  paused: boolean,
  userId?: string
): Promise<PauseOutcome> {
  if (paused) {
    const lifecycle = await stopServiceInstances(serviceId, "pause", client);
    const service = await client.service.update({ where: { id: serviceId }, data: { isPaused: true } });
    return { service, lifecycle, wokeDeploymentId: null };
  }

  const latest = await client.deployment.findFirst({
    where: { serviceId },
    orderBy: { createdAt: "desc" },
    select: { status: true },
  });
  const running = Boolean(latest && LIVE_OR_IN_FLIGHT.includes(latest.status));
  const sleeping = running
    ? null
    : await client.deployment.findFirst({
        where: { serviceId, status: "SLEEPING" },
        orderBy: { createdAt: "desc" },
        include: { build: true },
      });
  if (sleeping) assertRunnerConfigured();

  const service = await client.service.update({ where: { id: serviceId }, data: { isPaused: false } });
  if (sleeping) {
    await client.deployment.update({ where: { id: sleeping.id }, data: { status: "QUEUED" } });
    await scheduleDeployment(sleeping.id, sleeping.buildId, serviceId, {
      serviceId,
      commitSha: sleeping.build?.commitSha || undefined,
      commitMessage: `Resume paused service (deployment ${sleeping.id.slice(0, 8)})`,
      userId,
    });
  }
  return { service, wokeDeploymentId: sleeping?.id ?? null };
}
