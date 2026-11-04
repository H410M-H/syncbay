/**
 * Durable deployment scheduling (Team A).
 *
 * Request handlers call `scheduleDeployment()` instead of firing `executeDeployment()` and
 * forgetting it. The `DeploymentJob` row is written before the response, and the work runs in
 * Next's `after()`, which keeps the serverless function alive for the route's `maxDuration`
 * (300 s on every route that deploys). If the function still dies, or the build outlives the
 * engine's poll budget, the orchestrator lease lapses and `recoverStaleDeployments()` picks the
 * deployment up from the cron.
 */

import { after } from "next/server";
import { executeDeployment, type TriggerOptions } from "./engine";
import { acquireOrchestratorLease, enqueueDeploymentJob } from "./job-queue";

/**
 * Runs `task` after the response is sent. Outside a request scope (scripts, tests, the
 * runner) `after()` throws, so the task just runs in the background.
 */
export function runAfterResponse(task: () => Promise<unknown>, label: string): void {
  const run = () =>
    task().catch((err) => {
      console.error(`[schedule] ${label} failed:`, err?.message || err);
    });
  try {
    after(run);
  } catch {
    void run();
  }
}

export async function scheduleDeployment(
  deploymentId: string,
  buildId: string,
  serviceId: string,
  options: TriggerOptions = { serviceId }
): Promise<void> {
  const { serviceId: _sid, ...persisted } = options;
  await enqueueDeploymentJob({ deploymentId, buildId, serviceId, options: persisted as Record<string, unknown> });
  runAfterResponse(async () => {
    // Someone else (a recovery sweep) may already own it.
    if (!(await acquireOrchestratorLease(deploymentId))) return;
    await executeDeployment(deploymentId, buildId, serviceId, options);
  }, `deployment ${deploymentId}`);
}
