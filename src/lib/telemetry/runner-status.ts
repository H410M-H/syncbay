/**
 * Syncbay PaaS — runner configuration + health for the dashboard (adapter).
 *
 * INTEGRATION NOTE: Team A owns `src/lib/orchestrator/runner-config.ts`, which provides the same
 * two functions. At merge this file becomes a one-line re-export:
 *
 *   export { getRunnerConfigStatus, checkRunnerHealth } from "@/lib/orchestrator/runner-config";
 *
 * Until then it is a minimal, compatible implementation. It never exposes secret values or the
 * full runner URL (host only).
 */

import { getRunnerBaseUrl } from "@/lib/runner-client";

export type RunnerMode = "webhook" | "ssh" | "queue" | "local" | "simulated";

export interface RunnerConfigStatus {
  mode: RunnerMode;
  urlHost: string | null;
  secretConfigured: boolean;
  problem?: string;
}

export interface RunnerHealth {
  online: boolean;
  latencyMs?: number;
  uptime?: number;
  activeJobs?: number;
  error?: string;
}

function isServerless(): boolean {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

/** Which driver `getRunnerDriver()` would pick, and what (if anything) blocks it. */
export function getRunnerConfigStatus(): RunnerConfigStatus {
  const base = getRunnerBaseUrl();
  let urlHost: string | null = null;
  try {
    urlHost = base ? new URL(base).host : null;
  } catch {
    urlHost = null;
  }
  const secretConfigured = Boolean(process.env.RUNNER_WEBHOOK_SECRET || process.env.RUNNER_SECRET || process.env.SYNCBAY_WEBHOOK_SECRET);
  const production = process.env.NODE_ENV === "production";
  const driver = (process.env.RUNNER_DRIVER || "").toLowerCase();
  const queueEnv = (process.env.RUNNER_QUEUE_MODE || "").toLowerCase();
  const pullMode = queueEnv === "pull" || queueEnv === "true";
  const missingSecret = production && !secretConfigured;

  if (driver === "mock") {
    return { mode: "simulated", urlHost, secretConfigured, problem: production ? "RUNNER_DRIVER=mock: deployments are simulated, nothing runs." : undefined };
  }
  if (driver === "local" || process.env.RUNNER_FORCE_LOCAL === "true") {
    if (isServerless()) {
      return {
        mode: "simulated",
        urlHost,
        secretConfigured,
        problem: "The local driver cannot run apps on a serverless control plane. Set RUNNER_URL and RUNNER_SECRET to a runner host.",
      };
    }
    return { mode: "local", urlHost, secretConfigured };
  }
  if (driver === "webhook" || (base && !pullMode && driver !== "queue" && driver !== "ssh")) {
    if (!base) {
      return {
        mode: "webhook",
        urlHost,
        secretConfigured,
        problem: "Runner not configured: RUNNER_DRIVER=webhook but RUNNER_URL is not set. Set RUNNER_URL to the runner host (e.g. https://runner.syncbay.app).",
      };
    }
    return {
      mode: "webhook",
      urlHost,
      secretConfigured,
      problem: missingSecret
        ? "Runner not configured: RUNNER_URL is set but RUNNER_SECRET is missing. Set it to the runner host's RUNNER_SECRET (deploy/alibaba-ecs/.env) and redeploy."
        : undefined,
    };
  }
  if (driver === "queue" || (pullMode && driver !== "ssh")) {
    return {
      mode: "queue",
      urlHost,
      secretConfigured,
      problem: missingSecret ? "Runner not configured: pull-mode runners need RUNNER_SECRET to sign job claims." : undefined,
    };
  }
  if (driver === "ssh") {
    const problem = !process.env.RUNNER_SSH_HOST
      ? "Runner not configured: RUNNER_DRIVER=ssh but RUNNER_SSH_HOST is not set."
      : missingSecret
      ? "Runner not configured: RUNNER_SECRET is missing for the SSH runner."
      : undefined;
    return { mode: "ssh", urlHost, secretConfigured, problem };
  }
  if (isServerless()) {
    return {
      mode: "simulated",
      urlHost,
      secretConfigured,
      problem: "No runner configured: deployments are simulated. Set RUNNER_URL, RUNNER_DRIVER=webhook and RUNNER_SECRET (deploy/alibaba-ecs/AGENT_PROMPT.md).",
    };
  }
  return { mode: "local", urlHost, secretConfigured };
}

/** Unsigned `GET {RUNNER_URL}/health` with a 3 s timeout. */
export async function checkRunnerHealth(): Promise<RunnerHealth> {
  const base = getRunnerBaseUrl();
  if (!base) {
    const { mode } = getRunnerConfigStatus();
    return mode === "local"
      ? { online: true, latencyMs: 0, error: undefined }
      : { online: false, error: "RUNNER_URL is not set" };
  }
  const started = Date.now();
  try {
    const res = await fetch(`${base}/health`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
    const latencyMs = Date.now() - started;
    if (!res.ok) return { online: false, latencyMs, error: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => ({}))) as { uptime?: unknown; activeJobs?: unknown };
    return {
      online: true,
      latencyMs,
      uptime: typeof body.uptime === "number" ? body.uptime : undefined,
      activeJobs: typeof body.activeJobs === "number" ? body.activeJobs : undefined,
    };
  } catch (err) {
    const e = err as Error;
    return { online: false, latencyMs: Date.now() - started, error: e?.name === "TimeoutError" ? "Timed out after 3 s" : e?.message || String(err) };
  }
}
