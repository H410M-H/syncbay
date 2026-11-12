/**
 * Cron hook: runs the deploy-core recovery sweep (`recoverStaleDeployments()` in
 * `src/lib/orchestrator/recovery.ts`) and reports its outcome without ever throwing.
 */

import { recoverStaleDeployments } from "@/lib/orchestrator/recovery";

/** Resumed deployments poll the runner for this long, then hand off again (the cron route allows 300 s). */
const RESUME_POLL_BUDGET_MS = 200_000;

export async function runDeploymentRecovery(): Promise<{ ran: boolean; result?: unknown; error?: string }> {
  try {
    return { ran: true, result: await recoverStaleDeployments({ pollBudgetMs: RESUME_POLL_BUDGET_MS }) };
  } catch (err) {
    return { ran: true, error: (err as Error)?.message || String(err) };
  }
}
