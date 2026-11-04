/**
 * Deployment recovery sweep (Team A). Team B's cron calls `recoverStaleDeployments()`.
 *
 * 1. Pull-mode runner leases that expired (runner died / lost network) are requeued, or the
 *    job fails once `maxAttempts` is reached.
 * 2. Deployments still QUEUED/BUILDING/DEPLOYING whose orchestrator lease lapsed (the
 *    serverless function died or handed off after its poll budget) are resumed: status
 *    polling restarts against the runner job already building it (`options.resume`), or the
 *    deployment is re-run when it never reached a runner.
 * 3. Legacy in-flight deployments without a job row (created before the queue existed) are
 *    failed after `legacyStaleMs`.
 */

import { db } from "@/lib/db";
import { executeDeployment, type TriggerOptions } from "./engine";
import { orchestratorLeaseMs } from "./job-queue";

type Client = any;

export interface RecoveryOptions {
  client?: Client;
  now?: Date;
  /** Max deployments resumed per sweep (default 5). */
  limit?: number;
  /** Untouched jobs younger than this are left to their original invocation (default 60 s). */
  graceMs?: number;
  /** In-flight deployments without a job row older than this are failed (default 30 min). */
  legacyStaleMs?: number;
  /** Injection point for tests; defaults to `executeDeployment`. */
  execute?: typeof executeDeployment;
}

export interface RecoveryReport {
  requeued: string[];
  resumed: string[];
  rerun: string[];
  failed: string[];
  errors: Array<{ deploymentId: string; message: string }>;
}

const IN_FLIGHT = ["QUEUED", "BUILDING", "DEPLOYING"];

async function failDeployment(client: Client, deploymentId: string, buildId: string | null, message: string) {
  await client.deployment
    .update({ where: { id: deploymentId }, data: { status: "FAILED", completedAt: new Date() } })
    .catch(() => null);
  if (buildId) {
    await client.build
      .updateMany({ where: { id: buildId, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "FAILED", completedAt: new Date() } })
      .catch(() => null);
  }
  await client.deploymentJob
    ?.updateMany({ where: { deploymentId }, data: { status: "FAILED", errorMessage: message, completedAt: new Date(), payload: null } })
    .catch(() => null);
}

export async function recoverStaleDeployments(opts: RecoveryOptions = {}): Promise<RecoveryReport> {
  const client = opts.client || db;
  const now = opts.now || new Date();
  const limit = opts.limit ?? 5;
  const graceMs = opts.graceMs ?? 60_000;
  const legacyStaleMs = opts.legacyStaleMs ?? 30 * 60_000;
  const execute = opts.execute || executeDeployment;
  const report: RecoveryReport = { requeued: [], resumed: [], rerun: [], failed: [], errors: [] };
  const jobs = client.deploymentJob;
  if (!jobs?.findMany) return report;

  // 1. Expired pull-mode runner leases.
  const expired: any[] = await jobs.findMany({
    where: { mode: "pull", status: "RUNNING", leaseExpiresAt: { lt: now } },
    take: 50,
  });
  for (const job of expired) {
    const exhausted = job.attempts >= job.maxAttempts;
    const res = await jobs.updateMany({
      where: { id: job.id, status: "RUNNING", leaseExpiresAt: { lt: now } },
      data: exhausted
        ? { status: "FAILED", errorMessage: `Runner lease expired after ${job.attempts} attempt(s)`, completedAt: now, leaseOwner: null, leaseExpiresAt: null, payload: null }
        : { status: "QUEUED", leaseOwner: null, leaseExpiresAt: null },
    });
    if (res.count > 0) (exhausted ? report.failed : report.requeued).push(job.deploymentId || job.id);
  }

  // 2. Orphaned orchestration.
  const orphans: any[] = await jobs.findMany({
    where: {
      kind: "deploy",
      status: { not: "CANCELLED" },
      updatedAt: { lt: new Date(now.getTime() - graceMs) },
      OR: [{ orchestratorLeaseUntil: null }, { orchestratorLeaseUntil: { lt: now } }],
      deployment: { status: { in: IN_FLIGHT } },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const tasks = orphans.map(async (job) => {
    const deploymentId: string = job.deploymentId;
    // Take the orchestrator lease; a concurrent sweep or a live invocation wins otherwise.
    const claimed = await jobs.updateMany({
      where: { id: job.id, OR: [{ orchestratorLeaseUntil: null }, { orchestratorLeaseUntil: { lt: now } }] },
      data: { orchestratorLeaseUntil: new Date(Date.now() + orchestratorLeaseMs()) },
    });
    if (claimed.count === 0) return;

    const options: TriggerOptions = { ...(job.options || {}), serviceId: job.serviceId };
    const canResume = Boolean(job.runnerJobId) && job.driverType && job.driverType !== "local";
    try {
      if (canResume) {
        report.resumed.push(deploymentId);
        await execute(deploymentId, job.buildId, job.serviceId, {
          ...options,
          resume: { runnerJobId: job.runnerJobId, driverType: job.driverType },
        });
        return;
      }
      if (job.mode === "push" && job.attempts + 1 >= job.maxAttempts) {
        await failDeployment(client, deploymentId, job.buildId, `Deployment orchestration lost ${job.attempts + 1} time(s)`);
        report.failed.push(deploymentId);
        return;
      }
      await jobs.update({ where: { id: job.id }, data: { attempts: { increment: 1 } } });
      report.rerun.push(deploymentId);
      await execute(deploymentId, job.buildId, job.serviceId, options);
    } catch (err: any) {
      report.errors.push({ deploymentId, message: err?.message || String(err) });
    }
  });
  await Promise.allSettled(tasks);

  // 3. Legacy in-flight deployments with no job row.
  const legacy: any[] = await client.deployment
    .findMany({
      where: { status: { in: IN_FLIGHT }, createdAt: { lt: new Date(now.getTime() - legacyStaleMs) }, job: { is: null } },
      select: { id: true, buildId: true },
      take: 50,
    })
    .catch(() => []);
  for (const dep of legacy) {
    await failDeployment(client, dep.id, dep.buildId, "Deployment orchestration lost (no durable job)");
    report.failed.push(dep.id);
  }

  return report;
}
