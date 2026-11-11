/**
 * Syncbay PaaS — always-on reconciler (run by the every-minute cron).
 *
 * A service runs around the clock unless its owner turned on scale-to-zero. If such a service
 * is found SLEEPING (it was put to sleep before scale-to-zero was switched off, or by an older
 * default), its latest deployment is started again. Paused services and workspaces over their
 * spending cap are left alone: only the owner resumes those.
 */

import { db } from "@/lib/db";
import { scheduleDeployment } from "@/lib/orchestrator/schedule";
import { getRunnerConfigStatus } from "@/lib/orchestrator/runner-config";
import { isWorkspaceOverSpendingCap } from "@/lib/usage/metering";

export interface AlwaysOnReport {
  checked: number;
  woken: Array<{ serviceId: string; deploymentId: string }>;
  skipped: Array<{ serviceId: string; reason: string }>;
}

const LIVE_OR_IN_FLIGHT = new Set(["ACTIVE", "QUEUED", "BUILDING", "DEPLOYING"]);

export async function wakeAlwaysOnServices(options: { limit?: number } = {}): Promise<AlwaysOnReport> {
  const report: AlwaysOnReport = { checked: 0, woken: [], skipped: [] };
  // Nothing can be started without a runner; waking would only produce failed deployments.
  if (getRunnerConfigStatus().problem) return report;

  const services = await db.service.findMany({
    where: {
      deletedAt: null,
      isPaused: false,
      scaleToZero: false,
      environment: { project: { deletedAt: null } },
      deployments: { some: { status: "SLEEPING" } },
    },
    select: {
      id: true,
      name: true,
      environment: { select: { project: { select: { workspaceId: true } } } },
      deployments: {
        orderBy: { createdAt: "desc" },
        take: 8,
        select: { id: true, status: true, buildId: true, build: { select: { commitSha: true } } },
      },
    },
    take: 50,
  });

  const limit = options.limit ?? 3;
  for (const service of services) {
    // Nothing to do while a version is live or on its way. Otherwise the newest sleeping
    // deployment is the one to bring back (a newer failed build does not change that).
    if (service.deployments.some((d) => LIVE_OR_IN_FLIGHT.has(d.status))) continue;
    const latest = service.deployments.find((d) => d.status === "SLEEPING");
    if (!latest) continue;
    report.checked += 1;
    if (report.woken.length >= limit) {
      report.skipped.push({ serviceId: service.id, reason: "wake limit for this run reached" });
      continue;
    }
    const workspaceId = service.environment?.project?.workspaceId;
    if (workspaceId && (await isWorkspaceOverSpendingCap(workspaceId))) {
      report.skipped.push({ serviceId: service.id, reason: "workspace spending cap reached" });
      continue;
    }
    // Conditional flip, so two overlapping cron runs cannot both start it.
    const claimed = await db.deployment.updateMany({ where: { id: latest.id, status: "SLEEPING" }, data: { status: "QUEUED" } });
    if (claimed.count === 0) continue;
    await scheduleDeployment(latest.id, latest.buildId, service.id, {
      serviceId: service.id,
      commitSha: latest.build?.commitSha || undefined,
      commitMessage: `Always-on: starting ${service.name} again (deployment ${latest.id.slice(0, 8)})`,
    });
    report.woken.push({ serviceId: service.id, deploymentId: latest.id });
  }
  return report;
}
