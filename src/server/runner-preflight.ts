/**
 * tRPC side of the runner preflight (Team A, v1.2). Routers call `requireRunnerReady()` before
 * they create a deployment row, and wrap instance control (stop / restart / rollback) in
 * `surfaceRunnerConfigErrors()`, so a misconfigured runner is a PRECONDITION_FAILED with the
 * actionable message from `runner-config.ts` instead of a FAILED deployment or a false "stopped".
 */

import { TRPCError } from "@trpc/server";
import { assertRunnerConfigured, isRunnerConfigError } from "@/lib/orchestrator/runner-config";

function preconditionFailed(err: Error): TRPCError {
  return new TRPCError({ code: "PRECONDITION_FAILED", message: err.message, cause: err });
}

/** Throws PRECONDITION_FAILED when deploys cannot work with the current runner configuration. */
export function requireRunnerReady(): void {
  try {
    assertRunnerConfigured();
  } catch (err) {
    throw preconditionFailed(err as Error);
  }
}

/** Runs `fn`, turning a runner configuration error into PRECONDITION_FAILED. */
export async function surfaceRunnerConfigErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isRunnerConfigError(err)) throw preconditionFailed(err);
    throw err;
  }
}
