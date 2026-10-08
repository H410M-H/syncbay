/**
 * Syncbay PaaS — Unified Runner Driver Subsystem
 *
 * Implements extensible runner drivers for hybrid compute execution:
 * 1. WebhookRunnerDriver: Authenticated HTTP/SSE dispatch with HMAC SHA-256 verification.
 * 2. QueueRunnerDriver: Asynchronous DB/Prisma job queue for long-running builds without serverless timeouts.
 * 3. SshRunnerDriver: Remote command execution and container process management on custom Linux nodes.
 * 4. LocalRunnerDriver: In-process simulated runner for fast local testing.
 * 5. RunnerDriverFactory: Pluggable factory for instantiating drivers by type.
 */

import crypto from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// ─── ERROR TYPES ─────────────────────────────────────────────────────────────

export class RunnerDriverError extends Error {
  public readonly code: string;
  public readonly driverType?: RunnerDriverType;

  constructor(message: string, codeOrDriverType: string = "RUNNER_DRIVER_ERROR", driverType?: RunnerDriverType) {
    super(message);
    this.name = "RunnerDriverError";
    if (["webhook", "queue", "ssh"].includes(codeOrDriverType)) {
      this.code = "RUNNER_DRIVER_ERROR";
      this.driverType = codeOrDriverType as RunnerDriverType;
    } else {
      this.code = codeOrDriverType;
      this.driverType = driverType;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AuthenticationError extends RunnerDriverError {
  constructor(message: string = "HMAC authentication verification failed") {
    super(message, "AUTHENTICATION_ERROR");
    this.name = "AuthenticationError";
  }
}

export class TimeoutError extends RunnerDriverError {
  constructor(message: string = "Operation timed out") {
    super(message, "TIMEOUT_ERROR");
    this.name = "TimeoutError";
  }
}

// ─── CORE INTERFACE TYPES ────────────────────────────────────────────────────

export type RunnerDriverType = "webhook" | "queue" | "ssh" | "local";

export type RunnerBuildStatus =
  | "QUEUED"
  | "BUILDING"
  | "DEPLOYING"
  | "ACTIVE"
  | "FAILED"
  | "CANCELLED";

export interface BuildDispatchParams {
  deploymentId: string;
  buildId: string;
  serviceId: string;
  serviceName: string;
  repoUrl?: string;
  branch?: string;
  commitSha?: string;
  commitMessage?: string;
  rootDir?: string;
  buildCommand?: string;
  startCommand?: string;
  dockerfile?: string;
  port?: number;
  hostPort?: number;
  containerPort?: number;
  environmentVariables?: Record<string, string>;
  subdomain?: string;
  callbackUrl?: string;
}

export interface BuildDispatchResult {
  jobId: string;
  driverType: RunnerDriverType;
  status: RunnerBuildStatus;
  streamUrl?: string;
  containerId?: string;
  assignedPort?: number;
  metadata?: Record<string, any>;
}

export interface BuildStatusResult {
  jobId: string;
  status: RunnerBuildStatus;
  exitCode?: number;
  containerId?: string;
  port?: number;
  url?: string;
  startedAt?: Date | string;
  completedAt?: Date | string;
  errorMessage?: string;
  logs?: string[];
}

export interface StopContainerParams {
  containerId: string;
  serviceId?: string;
  signal?: "SIGTERM" | "SIGKILL";
  timeoutSeconds?: number;
}

export interface StopContainerResult {
  containerId: string;
  stopped: boolean;
  releasedPort?: number;
  durationMs?: number;
  message?: string;
}

export interface RunnerDriver {
  readonly type: RunnerDriverType;
  dispatchBuild(params: BuildDispatchParams): Promise<BuildDispatchResult>;
  checkStatus(jobId: string): Promise<BuildStatusResult>;
  stopContainer(containerId: string, options?: Partial<StopContainerParams>): Promise<StopContainerResult>;
}

// ─── HMAC CRYPTOGRAPHIC UTILITIES ───────────────────────────────────────────

export interface HmacSignatureResult {
  signature: string;
  timestamp: string;
  headerValue: string;
}

export interface HmacVerificationOptions {
  timestamp?: string | number;
  toleranceMs?: number; // Defaults to 300,000 ms (5 minutes)
}

/**
 * Normalizes payload string for HMAC hashing.
 */
function canonicalizePayload(payload: string | object): string {
  if (typeof payload === "string") {
    return payload;
  }
  return JSON.stringify(payload);
}

/**
 * Generates an HMAC SHA-256 signature for runner requests.
 * Format: sha256=<hex_digest>
 * Signed content: `${timestamp}.${payload}`
 */
export function generateHmacSignature(
  payload: string | object,
  secret: string,
  timestampInput?: string | number
): HmacSignatureResult {
  if (!secret) {
    throw new RunnerDriverError("HMAC secret must not be empty", "INVALID_CONFIG");
  }

  const timestamp = timestampInput !== undefined ? String(timestampInput) : Date.now().toString();
  const rawBody = canonicalizePayload(payload);
  const dataToSign = `${timestamp}.${rawBody}`;

  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(dataToSign);
  const signature = hmac.digest("hex");

  return {
    signature,
    timestamp,
    headerValue: `sha256=${signature}`,
  };
}

/**
 * Verifies an HMAC SHA-256 signature using timing-safe equal comparison.
 * Protects against timing attacks and replay attacks (via timestamp tolerance).
 */
export function verifyHmacSignature(
  payload: string | object,
  signatureHeader: string,
  secret: string,
  options: HmacVerificationOptions = {}
): boolean {
  if (!signatureHeader || !secret) {
    return false;
  }

  const toleranceMs = options.toleranceMs ?? 300000; // 5 min default

  // Extract raw hex from "sha256=<hex>" or plain "<hex>"
  let providedHex = signatureHeader.trim();
  if (providedHex.startsWith("sha256=")) {
    providedHex = providedHex.slice(7).trim();
  }

  // Validate hex format
  if (!/^[0-9a-fA-F]{64}$/.test(providedHex)) {
    return false;
  }

  // Verify timestamp tolerance if timestamp provided
  if (options.timestamp !== undefined) {
    const tsNumber = Number(options.timestamp);
    if (isNaN(tsNumber)) {
      return false;
    }
    const age = Math.abs(Date.now() - tsNumber);
    if (age > toleranceMs) {
      return false; // Expired / replay attack defense
    }
  }

  const timestampStr = options.timestamp !== undefined ? String(options.timestamp) : "";
  const rawBody = canonicalizePayload(payload);

  // If timestamp was provided, sign `${timestamp}.${rawBody}`
  // If no timestamp was provided, fall back to signing `${rawBody}` or checking both
  let expectedHex: string;
  if (timestampStr) {
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(`${timestampStr}.${rawBody}`);
    expectedHex = hmac.digest("hex");
  } else {
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(rawBody);
    expectedHex = hmac.digest("hex");
  }

  try {
    const bufProvided = Buffer.from(providedHex, "hex");
    const bufExpected = Buffer.from(expectedHex, "hex");

    if (bufProvided.length !== bufExpected.length) {
      return false;
    }

    return crypto.timingSafeEqual(bufProvided, bufExpected);
  } catch {
    return false;
  }
}

// ─── STATUS MAPPING HELPERS ──────────────────────────────────────────────────

export function mapWebhookStatus(statusStr: string): RunnerBuildStatus {
  const s = String(statusStr || "").toUpperCase();
  switch (s) {
    case "QUEUED":
    case "PENDING":
      return "QUEUED";
    case "BUILDING":
    case "RUNNING":
      return "BUILDING";
    case "DEPLOYING":
    case "PROVISIONING":
      return "DEPLOYING";
    case "ACTIVE":
    case "SUCCEEDED":
    case "SUCCESS":
    case "READY":
      return "ACTIVE";
    case "FAILED":
    case "ERROR":
    case "CRASHED":
      return "FAILED";
    case "CANCELLED":
    case "STOPPED":
    case "SUPERSEDED":
      return "CANCELLED";
    default:
      return "BUILDING";
  }
}

export function mapPrismaBuildStatus(statusStr: string): RunnerBuildStatus {
  const s = String(statusStr || "").toUpperCase();
  switch (s) {
    case "QUEUED":
      return "QUEUED";
    case "RUNNING":
    case "BUILDING":
      return "BUILDING";
    case "DEPLOYING":
      return "DEPLOYING";
    case "SUCCEEDED":
    case "ACTIVE":
      return "ACTIVE";
    case "FAILED":
    case "CRASHED":
      return "FAILED";
    case "CANCELLED":
    case "SUPERSEDED":
    case "SLEEPING":
      return "CANCELLED";
    default:
      return "QUEUED";
  }
}

export function mapDockerStatus(state: {
  Status?: string;
  Running?: boolean;
  ExitCode?: number;
  Dead?: boolean;
  OOMKilled?: boolean;
}): RunnerBuildStatus {
  if (!state) return "FAILED";
  if (state.Dead || state.OOMKilled) return "FAILED";

  const status = (state.Status || "").toLowerCase();

  if (state.Running || status === "running") {
    return "ACTIVE";
  }
  if (status === "created" || status === "restarting") {
    return "DEPLOYING";
  }
  if (status === "exited") {
    return state.ExitCode === 0 ? "ACTIVE" : "FAILED";
  }
  if (status === "paused" || status === "removing") {
    return "CANCELLED";
  }
  if (status === "dead") {
    return "FAILED";
  }

  return "FAILED";
}

// ─── 1. REST WEBHOOK RUNNER DRIVER ───────────────────────────────────────────

export interface WebhookRunnerDriverConfig {
  runnerUrl: string;
  webhookSecret: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  statusPollingIntervalMs?: number;
}

export class WebhookRunnerDriver implements RunnerDriver {
  public readonly type: RunnerDriverType = "webhook";
  public readonly runnerUrl: string;
  public readonly webhookSecret: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(config: WebhookRunnerDriverConfig) {
    if (!config?.runnerUrl) {
      throw new RunnerDriverError("runnerUrl is required for WebhookRunnerDriver", "INVALID_CONFIG", "webhook");
    }
    if (!config?.webhookSecret) {
      throw new RunnerDriverError("webhookSecret is required for WebhookRunnerDriver", "INVALID_CONFIG", "webhook");
    }

    this.runnerUrl = config.runnerUrl.replace(/\/+$/, "");
    this.webhookSecret = config.webhookSecret;
    this.timeoutMs = config.timeoutMs ?? 15000;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
  }

  public serializePayload(params: BuildDispatchParams): Record<string, any> {
    const jobId = params.buildId || params.deploymentId;
    return {
      jobId,
      deploymentId: params.deploymentId,
      buildId: params.buildId,
      serviceId: params.serviceId,
      serviceName: params.serviceName,
      repoUrl: params.repoUrl,
      branch: params.branch,
      commitSha: params.commitSha,
      commitMessage: params.commitMessage,
      rootDir: params.rootDir,
      buildCommand: params.buildCommand,
      startCommand: params.startCommand,
      dockerfile: params.dockerfile,
      port: params.port,
      environmentVariables: params.environmentVariables,
      subdomain: params.subdomain,
      callbackUrl: params.callbackUrl,
    };
  }

  public async dispatchBuild(params: BuildDispatchParams): Promise<BuildDispatchResult> {
    const payload = this.serializePayload(params);
    const bodyStr = JSON.stringify(payload);
    const now = Date.now().toString();
    const { headerValue } = generateHmacSignature(bodyStr, this.webhookSecret, now);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(`${this.runnerUrl}/api/builds`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Syncbay-Signature": headerValue,
          "X-Syncbay-Timestamp": now,
        },
        body: bodyStr,
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new AuthenticationError(`Runner rejected HMAC authentication (HTTP ${response.status})`);
        }
        const errText = await response.text().catch(() => "");
        throw new RunnerDriverError(
          `Runner dispatch failed (HTTP ${response.status}): ${errText}`,
          "DISPATCH_FAILED",
          "webhook"
        );
      }

      const data = await response.json().catch(() => ({}));
      const jobId = data.jobId || payload.jobId;
      const status = mapWebhookStatus(data.status || "BUILDING");

      return {
        jobId,
        driverType: "webhook",
        status,
        streamUrl: data.streamUrl || `${this.runnerUrl}/api/builds/${jobId}/logs`,
        containerId: data.containerId,
        assignedPort: data.assignedPort || data.port,
        metadata: data.metadata || { runnerUrl: this.runnerUrl },
      };
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new TimeoutError(`Webhook dispatch timed out after ${this.timeoutMs}ms`);
      }
      if (err instanceof RunnerDriverError) {
        throw err;
      }
      throw new RunnerDriverError(`Webhook dispatch error: ${err.message}`, "DISPATCH_FAILED", "webhook");
    } finally {
      clearTimeout(timeout);
    }
  }

  public async checkStatus(jobId: string): Promise<BuildStatusResult> {
    const now = Date.now().toString();
    const { headerValue } = generateHmacSignature({ jobId }, this.webhookSecret, now);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(`${this.runnerUrl}/api/builds/${encodeURIComponent(jobId)}`, {
        method: "GET",
        headers: {
          "X-Syncbay-Signature": headerValue,
          "X-Syncbay-Timestamp": now,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new AuthenticationError(`Runner rejected HMAC authentication (HTTP ${response.status})`);
        }
        throw new RunnerDriverError(
          `Failed to check build status (HTTP ${response.status})`,
          "STATUS_CHECK_FAILED",
          "webhook"
        );
      }

      const data = await response.json();
      return {
        jobId,
        status: mapWebhookStatus(data.status),
        exitCode: data.exitCode,
        containerId: data.containerId,
        port: data.assignedPort || data.port,
        url: data.url,
        startedAt: data.startedAt,
        completedAt: data.completedAt,
        errorMessage: data.errorMessage || data.error,
        logs: data.logs,
      };
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new TimeoutError(`Status check timed out after ${this.timeoutMs}ms`);
      }
      if (err instanceof RunnerDriverError) {
        throw err;
      }
      throw new RunnerDriverError(`Status check failed: ${err.message}`, "STATUS_CHECK_FAILED", "webhook");
    } finally {
      clearTimeout(timeout);
    }
  }

  public async stopContainer(
    containerId: string,
    options: Partial<StopContainerParams> = {}
  ): Promise<StopContainerResult> {
    const bodyObj = {
      containerId,
      signal: options.signal || "SIGTERM",
      timeoutSeconds: options.timeoutSeconds || 10,
    };
    const bodyStr = JSON.stringify(bodyObj);
    const now = Date.now().toString();
    const { headerValue } = generateHmacSignature(bodyStr, this.webhookSecret, now);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(
        `${this.runnerUrl}/api/containers/${encodeURIComponent(containerId)}/stop`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Syncbay-Signature": headerValue,
            "X-Syncbay-Timestamp": now,
          },
          body: bodyStr,
          signal: controller.signal,
        }
      );

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        return {
          containerId,
          stopped: false,
          message: `Stop container failed (HTTP ${response.status}): ${errText}`,
        };
      }

      const data = await response.json().catch(() => ({}));
      return {
        containerId,
        stopped: data.stopped !== false,
        message: data.message || "Container stopped successfully",
      };
    } catch (err: any) {
      return {
        containerId,
        stopped: false,
        message: err.message,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ─── 2. QUEUE / DB POLLING RUNNER DRIVER ─────────────────────────────────────

export interface QueueRunnerDriverConfig {
  dbClient?: any;
  pollIntervalMs?: number;
}

export class QueueRunnerDriver implements RunnerDriver {
  public readonly type: RunnerDriverType = "queue";
  private readonly dbClient: any;
  private readonly inMemoryQueue: Map<string, { params: BuildDispatchParams; status: RunnerBuildStatus; updatedAt: Date }>;

  constructor(config: QueueRunnerDriverConfig = {}) {
    this.dbClient = config.dbClient || null;
    this.inMemoryQueue = new Map();
  }

  public async dispatchBuild(params: BuildDispatchParams): Promise<BuildDispatchResult> {
    const jobId = params.buildId || params.deploymentId;

    // Persist to database if dbClient is provided
    if (this.dbClient) {
      try {
        if (this.dbClient.build?.update) {
          await this.dbClient.build.update({
            where: { id: params.buildId },
            data: {
              status: "QUEUED",
              startedAt: null,
              completedAt: null,
            },
          }).catch(() => null);
        }

        if (this.dbClient.deployment?.update) {
          await this.dbClient.deployment.update({
            where: { id: params.deploymentId },
            data: {
              status: "QUEUED",
            },
          }).catch(() => null);
        }
      } catch (err: any) {
        throw new RunnerDriverError(`Queue dispatch DB error: ${err.message}`, "DB_ERROR", "queue");
      }
    }

    // Always maintain state in inMemoryQueue for deterministic queries
    this.inMemoryQueue.set(jobId, {
      params,
      status: "QUEUED",
      updatedAt: new Date(),
    });

    return {
      jobId,
      driverType: "queue",
      status: "QUEUED",
      metadata: {
        enqueuedAt: new Date().toISOString(),
        deploymentId: params.deploymentId,
        serviceId: params.serviceId,
      },
    };
  }

  public async checkStatus(jobId: string): Promise<BuildStatusResult> {
    if (this.dbClient) {
      try {
        let buildRecord: any = null;
        if (this.dbClient.build?.findUnique) {
          buildRecord = await this.dbClient.build.findUnique({
            where: { id: jobId },
            include: { deployments: true },
          }).catch(() => null);
        }

        if (buildRecord) {
          const status = mapPrismaBuildStatus(buildRecord.status);
          const activeDep = buildRecord.deployments?.[0];
          return {
            jobId,
            status,
            containerId: activeDep?.cfContainerId,
            startedAt: buildRecord.startedAt,
            completedAt: buildRecord.completedAt,
          };
        }

        let depRecord: any = null;
        if (this.dbClient.deployment?.findUnique) {
          depRecord = await this.dbClient.deployment.findUnique({
            where: { id: jobId },
          }).catch(() => null);
        }

        if (depRecord) {
          const status = mapPrismaBuildStatus(depRecord.status);
          return {
            jobId,
            status,
            containerId: depRecord.cfContainerId,
            startedAt: depRecord.startedAt,
            completedAt: depRecord.completedAt,
          };
        }
      } catch (err: any) {
        throw new RunnerDriverError(`Queue checkStatus DB error: ${err.message}`, "DB_ERROR", "queue");
      }
    }

    // Fallback to in-memory queue state
    const entry = this.inMemoryQueue.get(jobId);
    if (!entry) {
      return {
        jobId,
        status: "FAILED",
        errorMessage: `Job ${jobId} not found in build queue`,
      };
    }

    return {
      jobId,
      status: entry.status,
      startedAt: entry.updatedAt,
    };
  }

  public updateJobStatus(jobId: string, status: RunnerBuildStatus): void {
    const entry = this.inMemoryQueue.get(jobId);
    if (entry) {
      entry.status = status;
      entry.updatedAt = new Date();
    }
  }

  public async stopContainer(
    containerId: string,
    _options: Partial<StopContainerParams> = {}
  ): Promise<StopContainerResult> {
    // In queue driver, cancellation halts pending and running jobs
    if (this.dbClient) {
      try {
        if (this.dbClient.deployment?.updateMany) {
          await this.dbClient.deployment.updateMany({
            where: {
              OR: [{ id: containerId }, { cfContainerId: containerId }],
            },
            data: { status: "CANCELLED" },
          }).catch(() => null);
        }
      } catch {
        // ignore
      }
    }

    // Update in-memory queue
    for (const [id, item] of this.inMemoryQueue.entries()) {
      if (id === containerId || item.params.deploymentId === containerId) {
        item.status = "CANCELLED";
      }
    }

    return {
      containerId,
      stopped: true,
      message: `Job ${containerId} cancelled in queue`,
    };
  }
}

// ─── 3. SSH REMOTE RUNNER DRIVER ─────────────────────────────────────────────

export interface SshExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SshClient {
  execute(command: string): Promise<SshExecResult>;
  close?(): Promise<void> | void;
}

/**
 * System CLI SSH Client executing commands via system ssh binary.
 */
export class CliSshClient implements SshClient {
  private readonly host: string;
  private readonly port: number;
  private readonly username: string;
  private readonly privateKeyPath?: string;

  constructor(options: { host: string; port?: number; username: string; privateKeyPath?: string }) {
    this.host = options.host;
    this.port = options.port || 22;
    this.username = options.username;
    this.privateKeyPath = options.privateKeyPath;
  }

  /**
   * Escapes shell metacharacters (quotes, $, `, ;, &, |, \) so command arguments
   * cannot trigger unintended shell expansion or arbitrary execution.
   */
  private escapeShellCommand(cmd: string): string {
    return cmd
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\$/g, "\\$")
      .replace(/`/g, "\\`")
      .replace(/;/g, "\\;")
      .replace(/&/g, "\\&")
      .replace(/\|/g, "\\|");
  }

  public async execute(command: string): Promise<SshExecResult> {
    const keyFlag = this.privateKeyPath ? `-i "${this.privateKeyPath.replace(/"/g, '\\"')}"` : "";
    const safeHost = this.host.replace(/[^a-zA-Z0-9._-]/g, "");
    const safeUser = this.username.replace(/[^a-zA-Z0-9._-]/g, "");
    const safePort = Number.isInteger(this.port) && this.port > 0 && this.port <= 65535 ? this.port : 22;
    const escapedCmd = this.escapeShellCommand(command);
    const sshCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${safePort} ${keyFlag} ${safeUser}@${safeHost} "${escapedCmd}"`;

    try {
      const { stdout, stderr } = await execAsync(sshCmd);
      return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
    } catch (err: any) {
      return {
        stdout: (err.stdout || "").trim(),
        stderr: (err.stderr || err.message || "").trim(),
        exitCode: typeof err.code === "number" ? err.code : 1,
      };
    }
  }
}

/**
 * Deterministic in-memory Mock SSH Client for testing and simulation.
 */
export class MockSshClient implements SshClient {
  public history: Array<{ command: string; timestamp: number }> = [];
  private handlers: Array<{ pattern: RegExp; handler: (cmd: string) => SshExecResult }> = [];
  public containers: Map<string, { status: string; exitCode: number; port: number }> = new Map();

  constructor() {
    this.initDefaultHandlers();
  }

  private initDefaultHandlers(): void {
    // Node provisioning & health checks
    this.addHandler(/which docker/, () => ({ stdout: "/usr/bin/docker\n", stderr: "", exitCode: 0 }));
    this.addHandler(/which nixpacks/, () => ({ stdout: "/usr/local/bin/nixpacks\n", stderr: "", exitCode: 0 }));
    this.addHandler(/which git/, () => ({ stdout: "/usr/bin/git\n", stderr: "", exitCode: 0 }));
    this.addHandler(/docker info/, () => ({
      stdout: "Server Version: 24.0.7\nOperating System: Ubuntu 22.04 LTS\nContainers: 2\n",
      stderr: "",
      exitCode: 0,
    }));
    this.addHandler(/free -m/, () => ({
      stdout: "              total        used        free      shared  buff/cache   available\nMem:          16000        3500       12500           0           0       12500\n",
      stderr: "",
      exitCode: 0,
    }));
    this.addHandler(/uptime/, () => ({
      stdout: " 09:30:00 up 12 days, 4:15,  1 user,  load average: 0.15, 0.10, 0.05\n",
      stderr: "",
      exitCode: 0,
    }));

    // Docker run
    this.addHandler(/docker run/, (cmd) => {
      const containerId = "c_" + crypto.randomBytes(6).toString("hex");
      let assignedPort = 3000;
      const portMatch = cmd.match(/-p\s+(\d+):/);
      if (portMatch) {
        assignedPort = parseInt(portMatch[1], 10);
      }
      this.containers.set(containerId, { status: "running", exitCode: 0, port: assignedPort });
      return { stdout: containerId, stderr: "", exitCode: 0 };
    });

    // Docker inspect
    this.addHandler(/docker inspect\s+([^\s]+)/, (cmd) => {
      const match = cmd.match(/docker inspect\s+([^\s]+)/);
      const containerId = match ? match[1] : "";
      const container = this.containers.get(containerId) || { status: "running", exitCode: 0, port: 3000 };

      const inspectJson = [
        {
          Id: containerId,
          State: {
            Status: container.status,
            Running: container.status === "running",
            ExitCode: container.exitCode,
            StartedAt: new Date().toISOString(),
          },
          NetworkSettings: {
            Ports: {
              "3000/tcp": [{ HostIp: "0.0.0.0", HostPort: String(container.port) }],
            },
          },
        },
      ];
      return { stdout: JSON.stringify(inspectJson), stderr: "", exitCode: 0 };
    });

    // Docker stop
    this.addHandler(/docker stop/, (cmd) => {
      const match = cmd.match(/docker stop(?:\s+-t\s+\d+)?\s+([^\s]+)/);
      const containerId = match ? match[1] : "";
      const container = this.containers.get(containerId);
      if (container) {
        container.status = "exited";
        container.exitCode = 0;
      }
      return { stdout: containerId, stderr: "", exitCode: 0 };
    });

    // Docker rm
    this.addHandler(/docker rm/, () => ({ stdout: "ok", stderr: "", exitCode: 0 }));
  }

  public addHandler(pattern: RegExp, handler: (cmd: string) => SshExecResult): void {
    this.handlers.unshift({ pattern, handler });
  }

  public async execute(command: string): Promise<SshExecResult> {
    this.history.push({ command, timestamp: Date.now() });

    for (const h of this.handlers) {
      if (h.pattern.test(command)) {
        return h.handler(command);
      }
    }

    return { stdout: "", stderr: `Unknown command: ${command}`, exitCode: 1 };
  }
}

export interface SshRunnerDriverConfig {
  host: string;
  port?: number;
  username: string;
  privateKey?: string;
  privateKeyPath?: string;
  sshClient?: SshClient;
  workDir?: string;
}

export class SshRunnerDriver implements RunnerDriver {
  public readonly type: RunnerDriverType = "ssh";
  public readonly host: string;
  public readonly port: number;
  public readonly username: string;
  public readonly sshClient: SshClient;
  public readonly workDir: string;

  constructor(config: SshRunnerDriverConfig) {
    if (!config?.host) {
      throw new RunnerDriverError("host is required for SshRunnerDriver", "INVALID_CONFIG", "ssh");
    }
    if (!config?.username) {
      throw new RunnerDriverError("username is required for SshRunnerDriver", "INVALID_CONFIG", "ssh");
    }

    this.host = config.host;
    this.port = config.port || 22;
    this.username = config.username;
    this.workDir = config.workDir || "/var/syncbay";
    this.sshClient =
      config.sshClient ||
      new CliSshClient({
        host: this.host,
        port: this.port,
        username: this.username,
        privateKeyPath: config.privateKeyPath,
      });
  }

  /**
   * Remote server provisioning: verifies presence of Docker, Nixpacks, and Git.
   */
  public async provisionNode(): Promise<{
    success: boolean;
    installed: { docker: boolean; nixpacks: boolean; git: boolean };
    message?: string;
  }> {
    const checkDocker = await this.sshClient.execute("which docker");
    const checkNixpacks = await this.sshClient.execute("which nixpacks");
    const checkGit = await this.sshClient.execute("which git");

    const installed = {
      docker: checkDocker.exitCode === 0,
      nixpacks: checkNixpacks.exitCode === 0,
      git: checkGit.exitCode === 0,
    };

    const success = installed.docker && installed.git;
    return {
      success,
      installed,
      message: success
        ? "Node provisioned and ready for runner execution"
        : "Node missing required binaries (Docker and Git required)",
    };
  }

  /**
   * Health check on remote Linux node: verifies Docker daemon, memory, and load.
   */
  public async checkNodeHealth(): Promise<{
    healthy: boolean;
    dockerRunning: boolean;
    memoryFreeMb?: number;
    uptime?: string;
  }> {
    const dockerInfo = await this.sshClient.execute("docker info");
    const freeMem = await this.sshClient.execute("free -m");
    const uptime = await this.sshClient.execute("uptime");

    const dockerRunning = dockerInfo.exitCode === 0;

    let memoryFreeMb: number | undefined;
    const memMatch = freeMem.stdout.match(/Mem:\s+\d+\s+\d+\s+(\d+)/);
    if (memMatch) {
      memoryFreeMb = parseInt(memMatch[1], 10);
    }

    return {
      healthy: dockerRunning,
      dockerRunning,
      memoryFreeMb,
      uptime: uptime.stdout.trim(),
    };
  }

  public serializeCommand(params: BuildDispatchParams): string {
    const rawServiceName = params.serviceName || "service";
    const sanitizedServiceName = rawServiceName.replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase() || "service";
    const commitSha = params.commitSha ? params.commitSha.replace(/[^a-zA-Z0-9]/g, "").slice(0, 7) : "latest";
    const tag = `syncbay-${sanitizedServiceName}:${commitSha || "latest"}`;
    const buildOrDepId = (params.buildId || params.deploymentId || "build").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 8);
    const name = `syncbay-${sanitizedServiceName}-${buildOrDepId}`;

    const containerPort = params.containerPort || params.port || 3000;
    const hostPort = params.hostPort || params.port || 3000;
    const safeHostPort = Number.isInteger(hostPort) && hostPort > 0 && hostPort <= 65535 ? hostPort : 3000;
    const safeContainerPort = Number.isInteger(containerPort) && containerPort > 0 && containerPort <= 65535 ? containerPort : 3000;

    const envFlags: string[] = [];
    if (params.environmentVariables) {
      for (const [k, v] of Object.entries(params.environmentVariables)) {
        const safeKey = k.replace(/[^a-zA-Z0-9_]/g, "");
        if (!safeKey) continue;
        envFlags.push(`-e ${safeKey}='${String(v).replace(/'/g, "'\\''")}'`);
      }
    }

    return `docker run -d --name ${name} --restart unless-stopped -p ${safeHostPort}:${safeContainerPort} ${envFlags.join(" ")} ${tag}`.trim();
  }

  public async dispatchBuild(params: BuildDispatchParams): Promise<BuildDispatchResult> {
    const jobId = params.buildId || params.deploymentId;
    const runCmd = this.serializeCommand(params);

    const execResult = await this.sshClient.execute(runCmd);
    if (execResult.exitCode !== 0) {
      throw new RunnerDriverError(
        `SSH remote container dispatch failed: ${execResult.stderr || execResult.stdout}`,
        "DISPATCH_FAILED",
        "ssh"
      );
    }

    const containerId = execResult.stdout.trim().split("\n").pop() || jobId;
    const assignedPort = params.hostPort || params.port || 3000;

    return {
      jobId,
      driverType: "ssh",
      status: "ACTIVE",
      containerId,
      assignedPort,
      metadata: {
        host: this.host,
        executedCommand: runCmd,
      },
    };
  }

  public async checkStatus(jobId: string): Promise<BuildStatusResult> {
    const sanitizedJobId = jobId.replace(/[^a-zA-Z0-9_.-]/g, "");
    if (!sanitizedJobId) {
      return {
        jobId,
        status: "FAILED",
        errorMessage: "Invalid job identifier provided",
      };
    }
    const inspectResult = await this.sshClient.execute(`docker inspect ${sanitizedJobId}`);

    if (inspectResult.exitCode !== 0) {
      return {
        jobId,
        status: "FAILED",
        errorMessage: `Failed to inspect container: ${inspectResult.stderr}`,
      };
    }

    try {
      const parsed = JSON.parse(inspectResult.stdout);
      const container = Array.isArray(parsed) ? parsed[0] : parsed;
      const state = container?.State || {};
      const status = mapDockerStatus(state);

      let port: number | undefined;
      const portBindings = container?.NetworkSettings?.Ports;
      if (portBindings) {
        for (const key of Object.keys(portBindings)) {
          const binding = portBindings[key]?.[0];
          if (binding?.HostPort) {
            port = parseInt(binding.HostPort, 10);
            break;
          }
        }
      }

      return {
        jobId,
        status,
        exitCode: state.ExitCode,
        containerId: container?.Id || jobId,
        port,
        startedAt: state.StartedAt,
        completedAt: state.FinishedAt,
      };
    } catch (err: any) {
      throw new RunnerDriverError(`Failed to parse docker inspect output: ${err.message}`, "PARSE_ERROR", "ssh");
    }
  }

  public async stopContainer(
    containerId: string,
    options: Partial<StopContainerParams> = {}
  ): Promise<StopContainerResult> {
    const sanitizedContainerId = containerId.replace(/[^a-zA-Z0-9_.-]/g, "");
    if (!sanitizedContainerId) {
      return {
        containerId,
        stopped: false,
        message: "Invalid container identifier provided",
      };
    }
    const timeout = typeof options.timeoutSeconds === "number" && options.timeoutSeconds >= 0 ? options.timeoutSeconds : 10;
    const stopCmd = `docker stop -t ${timeout} ${sanitizedContainerId}`;
    const rmCmd = `docker rm -f ${sanitizedContainerId}`;

    const stopRes = await this.sshClient.execute(stopCmd);
    await this.sshClient.execute(rmCmd).catch(() => null);

    const stopped = stopRes.exitCode === 0;
    return {
      containerId,
      stopped,
      message: stopped
        ? "Container stopped and removed successfully via SSH"
        : `Failed to stop container: ${stopRes.stderr}`,
    };
  }
}

// ─── 4. LOCAL SIMULATED RUNNER DRIVER ────────────────────────────────────────

export class LocalRunnerDriver implements RunnerDriver {
  public readonly type: RunnerDriverType = "local";
  private containers: Map<string, { status: RunnerBuildStatus; port: number }> = new Map();

  public async dispatchBuild(params: BuildDispatchParams): Promise<BuildDispatchResult> {
    const jobId = params.buildId || params.deploymentId;
    const containerId = "c_local_" + jobId.slice(0, 8);
    const assignedPort = params.port || 3000;

    this.containers.set(jobId, { status: "ACTIVE", port: assignedPort });
    this.containers.set(containerId, { status: "ACTIVE", port: assignedPort });

    return {
      jobId,
      driverType: "local",
      status: "ACTIVE",
      containerId,
      assignedPort,
      streamUrl: `/api/deployments/${params.deploymentId}/logs/stream`,
    };
  }

  public async checkStatus(jobId: string): Promise<BuildStatusResult> {
    const item = this.containers.get(jobId);
    if (!item) {
      return {
        jobId,
        status: "FAILED",
        errorMessage: "Local container not found",
      };
    }

    return {
      jobId,
      status: item.status,
      port: item.port,
    };
  }

  public async stopContainer(
    containerId: string,
    _options: Partial<StopContainerParams> = {}
  ): Promise<StopContainerResult> {
    const item = this.containers.get(containerId);
    if (item) {
      item.status = "CANCELLED";
    }

    return {
      containerId,
      stopped: true,
      message: "Local simulated container stopped",
    };
  }
}

// ─── 5. RUNNER DRIVER FACTORY ────────────────────────────────────────────────

type DriverFactoryFn = (config?: any) => RunnerDriver;

export class RunnerDriverFactory {
  private static registry: Map<RunnerDriverType, DriverFactoryFn> = new Map<RunnerDriverType, DriverFactoryFn>([
    ["webhook", (config) => new WebhookRunnerDriver(config)],
    ["queue", (config) => new QueueRunnerDriver(config)],
    ["ssh", (config) => new SshRunnerDriver(config)],
    ["local", () => new LocalRunnerDriver()],
  ]);

  public static registerDriver(type: RunnerDriverType, factory: DriverFactoryFn): void {
    RunnerDriverFactory.registry.set(type, factory);
  }

  public static createDriver(type: RunnerDriverType, config?: any): RunnerDriver {
    const factory = RunnerDriverFactory.registry.get(type);
    if (!factory) {
      throw new RunnerDriverError(
        `Unsupported runner driver type: "${type}". Supported types: ${Array.from(RunnerDriverFactory.registry.keys()).join(", ")}`,
        "UNSUPPORTED_DRIVER"
      );
    }
    return factory(config);
  }

  public static getAvailableDrivers(): RunnerDriverType[] {
    return Array.from(RunnerDriverFactory.registry.keys());
  }
}
