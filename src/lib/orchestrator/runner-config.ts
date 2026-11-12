/**
 * Runner configuration status, deploy preflight and health (Team A, v1.2).
 *
 * `getRunnerConfigStatus()` mirrors `getRunnerDriver()`'s choice from the environment and says
 * which runner mode deploys will use and what, if anything, is missing. It never returns a
 * secret value: only whether one is set, and the host of the runner URL.
 * `assertRunnerConfigured()` is the deploy preflight. Routers call it before they create a
 * deployment row, so a misconfigured runner is a PRECONDITION_FAILED instead of a FAILED deployment.
 * `checkRunnerHealth()` probes the runner daemon's unauthenticated `GET /health`.
 *
 * This module reads only the environment (no imports), so `runner-driver.ts` can use its
 * messages without an import cycle.
 */

export type RunnerMode = "webhook" | "ssh" | "queue" | "local" | "simulated";

export interface RunnerConfigStatus {
  mode: RunnerMode;
  /** Host (and port) of RUNNER_URL, or the SSH host. Never a path, credentials or secret. */
  urlHost: string | null;
  secretConfigured: boolean;
  /** Set when deploys cannot work with this configuration; an actionable message. */
  problem?: string;
}

export interface RunnerHealth {
  online: boolean;
  latencyMs?: number;
  uptime?: number;
  activeJobs?: number;
  error?: string;
  /** Build toolchain the runner reports on /health (absent on runners older than the buildx self-install). */
  toolchain?: RunnerToolchain;
  /** Runner release from /health; null for runners older than 1.4.0, which did not report one. */
  version?: string | null;
  /** True when the runner is older than MIN_RUNNER_VERSION: the host must update its image. */
  outdated?: boolean;
}

/** Oldest runner release this control plane is written for (see runner/src/version.ts). */
export const MIN_RUNNER_VERSION = "1.4.0";

/** Compares dotted versions ("1.3.0" < "1.4.0"); a missing version counts as older. */
export function isRunnerOutdated(version: string | null | undefined, min = MIN_RUNNER_VERSION): boolean {
  if (!version) return true;
  const a = version.split(".").map((n) => parseInt(n, 10) || 0);
  const b = min.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

export interface RunnerToolchain {
  docker: boolean;
  buildx: string | null;
  nixpacks: string | null;
}

function parseToolchain(raw: unknown): RunnerToolchain | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 120) : null);
  return { docker: t.docker === true, buildx: str(t.buildx), nixpacks: str(t.nixpacks) };
}

const RUNNER_NOT_CONFIGURED = "RUNNER_NOT_CONFIGURED";
const HEALTH_TIMEOUT_MS = 3000;
const ENV_FILE = "deploy/alibaba-ecs/.env";

/** A runner configuration problem: deploys and instance control cannot work until it is fixed. */
export class RunnerConfigError extends Error {
  readonly code = RUNNER_NOT_CONFIGURED;

  constructor(message: string) {
    super(message);
    this.name = "RunnerConfigError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isRunnerConfigError(err: unknown): err is RunnerConfigError {
  return err instanceof RunnerConfigError || (err as { code?: unknown } | null)?.code === RUNNER_NOT_CONFIGURED;
}

const isProduction = () => process.env.NODE_ENV === "production";
const onVercel = () => Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
const isServerless = () => onVercel() || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
const where = () => (onVercel() ? "in Vercel" : "in the control plane's environment");
const apply = () => (onVercel() ? "and redeploy." : "and restart the control plane.");

export function runnerSecretConfigured(): boolean {
  return Boolean(process.env.RUNNER_WEBHOOK_SECRET || process.env.RUNNER_SECRET || process.env.SYNCBAY_WEBHOOK_SECRET);
}

/** Same precedence as `getRunnerDriver()` with no explicit driver type. `mock` is the local driver with a mock pipeline. */
function selectedDriver(): "webhook" | "ssh" | "queue" | "local" | "mock" {
  const normalized = (process.env.RUNNER_DRIVER || "").toLowerCase();
  if (normalized === "mock") return "mock";
  if (normalized === "local" || process.env.RUNNER_FORCE_LOCAL === "true") return "local";
  const queueMode = (process.env.RUNNER_QUEUE_MODE || "").toLowerCase();
  const pullMode = queueMode === "pull" || queueMode === "true";
  if (normalized === "webhook" || (process.env.RUNNER_URL && !pullMode && normalized !== "queue" && normalized !== "ssh")) {
    return "webhook";
  }
  if (normalized === "queue" || (pullMode && normalized !== "ssh")) return "queue";
  if (normalized === "ssh") return "ssh";
  return "local";
}

/** True when deploys go to a remote runner (webhook, SSH or pull queue), not the in-process driver. */
export function isRemoteRunnerConfigured(): boolean {
  const driver = selectedDriver();
  return driver === "webhook" || driver === "ssh" || driver === "queue";
}

/** RUNNER_URL with a scheme and without trailing slashes (same normalisation as `runner-client.ts`), or null. */
function runnerBaseUrl(): string | null {
  const raw = process.env.RUNNER_URL?.trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw)
    ? raw
    : /^(localhost|127\.|0\.0\.0\.0)/.test(raw)
    ? `http://${raw}`
    : `https://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

function runnerUrlHost(): string | null | undefined {
  const base = runnerBaseUrl();
  if (!base) return null;
  try {
    const url = new URL(base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.host : undefined;
  } catch {
    return undefined; // set but unparseable
  }
}

function missingSecretMessage(driver: ReturnType<typeof selectedDriver>): string {
  const fix = `Set it to the runner host's RUNNER_SECRET (${ENV_FILE}) ${apply()}`;
  if (driver === "webhook") {
    const lead = process.env.RUNNER_URL ? "RUNNER_URL is set" : "RUNNER_DRIVER=webhook is set";
    return `Runner not configured: ${lead} but RUNNER_SECRET is missing ${where()}. ${fix}`;
  }
  if (driver === "ssh") return `Runner not configured: RUNNER_DRIVER=ssh is set but RUNNER_SECRET is missing ${where()}. ${fix}`;
  if (driver === "queue") {
    return `Runner not configured: pull-mode runners (RUNNER_QUEUE_MODE=pull) are enabled but RUNNER_SECRET is missing ${where()}, so no runner can authenticate to claim jobs. ${fix}`;
  }
  return `Runner not configured: RUNNER_SECRET is missing ${where()}, so runner requests cannot be signed in production. ${fix}`;
}

/** The message `resolveRunnerSecret()` throws in production when no runner secret is set. */
export function missingRunnerSecretMessage(): string {
  return missingSecretMessage(selectedDriver());
}

/** The message `getRunnerDriver()` throws in production for a webhook runner without RUNNER_URL. */
export function missingRunnerUrlMessage(): string {
  return `Runner not configured: RUNNER_DRIVER=webhook is set but RUNNER_URL is missing ${where()}. Set RUNNER_URL to the runner's public URL (https://<RUNNER_DOMAIN> from ${ENV_FILE}) ${apply()}`;
}

/**
 * Which runner deploys will use, and why they cannot work if they cannot. No secret values.
 * Problems are only reported where the code refuses to run: a missing secret or URL matters in
 * production; outside production the drivers fall back to dev defaults.
 */
export function getRunnerConfigStatus(): RunnerConfigStatus {
  const driver = selectedDriver();
  const secretConfigured = runnerSecretConfigured();
  const prod = isProduction();
  const host = runnerUrlHost();
  const urlHost = host ?? null;

  if (driver === "mock") return { mode: "simulated", urlHost, secretConfigured };
  if (driver === "local") {
    // The in-process pipeline uses MockPipelineExecutor on serverless hosts without RUNNER_URL.
    const simulated = isServerless() && !process.env.RUNNER_URL;
    return { mode: simulated ? "simulated" : "local", urlHost, secretConfigured };
  }

  if (driver === "webhook") {
    const status: RunnerConfigStatus = { mode: "webhook", urlHost, secretConfigured };
    if (host === undefined) {
      status.problem = `Runner not configured: RUNNER_URL ${where()} is not a valid http(s) URL. Set it to the runner's public URL (https://<RUNNER_DOMAIN> from ${ENV_FILE}) ${apply()}`;
    } else if (prod && !process.env.RUNNER_URL && !secretConfigured) {
      status.problem = `Runner not configured: RUNNER_DRIVER=webhook is set but RUNNER_URL and RUNNER_SECRET are missing ${where()}. Set RUNNER_URL to the runner's public URL and RUNNER_SECRET to the runner host's RUNNER_SECRET (${ENV_FILE}) ${apply()}`;
    } else if (prod && !process.env.RUNNER_URL) {
      status.problem = missingRunnerUrlMessage();
    } else if (prod && !secretConfigured) {
      status.problem = missingSecretMessage(driver);
    }
    return status;
  }

  if (driver === "ssh") {
    const sshHost = process.env.RUNNER_SSH_HOST?.trim() || null;
    const status: RunnerConfigStatus = { mode: "ssh", urlHost: sshHost, secretConfigured };
    if (prod && !sshHost) {
      status.problem = `Runner not configured: RUNNER_DRIVER=ssh is set but RUNNER_SSH_HOST is missing ${where()}. Set RUNNER_SSH_HOST (and RUNNER_SSH_USER / RUNNER_SSH_KEY_PATH) to the runner host ${apply()}`;
    } else if (prod && !secretConfigured) {
      status.problem = missingSecretMessage(driver);
    }
    return status;
  }

  // Pull queue: runners claim jobs from the control plane with HMAC-signed requests.
  const status: RunnerConfigStatus = { mode: "queue", urlHost, secretConfigured };
  if (prod && !secretConfigured) status.problem = missingSecretMessage(driver);
  return status;
}

/** Deploy preflight: throws `RunnerConfigError` (with the actionable message) when deploys cannot work. */
export function assertRunnerConfigured(): RunnerConfigStatus {
  const status = getRunnerConfigStatus();
  if (status.problem) throw new RunnerConfigError(status.problem);
  return status;
}

const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * Probes the runner daemon's unauthenticated `GET {RUNNER_URL}/health` (3 s timeout).
 * Without RUNNER_URL there is nothing to probe: the in-process driver counts as online, every
 * other mode reports why it cannot be checked.
 */
export async function checkRunnerHealth(): Promise<RunnerHealth> {
  const base = runnerBaseUrl();
  if (!base) {
    const { mode } = getRunnerConfigStatus();
    if (mode === "local") return { online: true };
    if (mode === "simulated") return { online: false, error: "No runner configured: deployments are simulated" };
    if (mode === "queue") return { online: false, error: "Pull-mode runners connect to the control plane; set RUNNER_URL to probe one" };
    if (mode === "ssh") return { online: false, error: "SSH runners have no HTTP health endpoint; set RUNNER_URL to probe one" };
    return { online: false, error: "RUNNER_URL is not set" };
  }
  if (runnerUrlHost() === undefined) return { online: false, error: "RUNNER_URL is not a valid http(s) URL" };

  const started = Date.now();
  try {
    const res = await fetch(`${base}/health`, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const hint = res.status === 530 ? " (Cloudflare tunnel is not connected)" : res.status === 502 || res.status === 503 ? " (runner daemon is not answering)" : "";
      return { online: false, latencyMs, error: `Runner /health returned HTTP ${res.status}${hint}` };
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || body.status !== "ok") return { online: false, latencyMs, error: "Runner /health did not answer like a Syncbay runner" };
    const version = typeof body.version === "string" ? body.version.slice(0, 32) : null;
    return {
      online: true,
      latencyMs,
      uptime: finite(body.uptime),
      activeJobs: finite(body.activeJobs),
      toolchain: parseToolchain(body.toolchain),
      version,
      outdated: isRunnerOutdated(version),
    };
  } catch (err) {
    const e = err as { name?: string; message?: string; cause?: { code?: string } };
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    return {
      online: false,
      latencyMs: Date.now() - started,
      error: timedOut ? `Runner /health timed out after ${HEALTH_TIMEOUT_MS} ms` : `Runner unreachable: ${e?.cause?.code || e?.message || String(err)}`,
    };
  }
}
