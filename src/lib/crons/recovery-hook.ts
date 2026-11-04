/**
 * Cron hook: runs the deploy-core recovery sweep (`recoverStaleDeployments()` in
 * `src/lib/orchestrator/recovery.ts`) and reports its outcome without ever throwing.
 */

import { recoverStaleDeployments } from "@/lib/orchestrator/recovery";

export async function runDeploymentRecovery(): Promise<{ ran: boolean; result?: unknown; error?: string }> {
  try {
    return { ran: true, result: await recoverStaleDeployments() };
  } catch (err) {
    return { ran: true, error: (err as Error)?.message || String(err) };
  }
}
