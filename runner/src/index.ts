/**
 * Syncbay Runner Agent Daemon — Entrypoint
 *
 * Provides:
 * 1. HTTP Server for REST Webhook Dispatch with HMAC SHA-256 verification.
 * 2. Real-time Server-Sent Events (SSE) log streaming (/api/builds/:jobId/logs).
 * 3. Container lifecycle management (/api/containers/:containerId/stop).
 * 4. Asynchronous Queue Poller loop for long-running builds.
 * 5. Daemon health monitoring (/health).
 */

import * as http from "node:http";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { BuildPipeline, type PipelineResult } from "./pipeline.ts";
import { PortManager, defaultPortManager } from "./port-manager.ts";
import { createTunnelDriver, type TunnelDriver, type TunnelDriverConfig } from "./tunnel-driver.ts";
import { isValidIngressHostname } from "./tunnel-config.ts";
import { NonceCache, verifyAndConsume, verifyCanonicalSignature } from "./request-auth.ts";
import { JobPullConsumer } from "./job-consumer.ts";

/** Max clock skew / replay window for signed requests. */
/** Dev-only fallback secret; the daemon refuses to start without RUNNER_SECRET in production. */
const DEV_RUNNER_SECRET = "syncbay-runner-secret";

function resolveDaemonSecret(explicit?: string): string {
  const secret = explicit || process.env.RUNNER_WEBHOOK_SECRET || process.env.RUNNER_SECRET || process.env.SYNCBAY_WEBHOOK_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("[runner-daemon] RUNNER_SECRET must be set in production");
  }
  return DEV_RUNNER_SECRET;
}
import { RunnerServices } from "./services.ts";
import { handleMetricsRequest } from "./metrics.ts";
import { sanitizeVolumes } from "./volumes.ts";

export interface DaemonConfig {
  port?: number;
  host?: string;
  webhookSecret?: string;
  queueMode?: boolean;
  pollIntervalMs?: number;
  portManager?: PortManager;
  pipeline?: BuildPipeline;
  tunnelConfig?: TunnelDriverConfig;
  tunnelDriver?: TunnelDriver;
  services?: RunnerServices;
}

export interface JobState {
  jobId: string;
  status: "QUEUED" | "BUILDING" | "ACTIVE" | "FAILED" | "CANCELLED";
  logs: string[];
  containerId?: string;
  assignedPort?: number;
  strategy?: "dockerfile" | "nixpacks";
  startedAt: string;
  completedAt?: string;
  error?: string;
  exitCode?: number;
  /** Public hostnames routed to this job's port through the tunnel ingress. */
  hostnames?: string[];
  /** True when the pipeline ran with a mock executor (no real process). */
  simulated?: boolean;
  sseClients: Set<http.ServerResponse>;
}

export class RunnerDaemon {
  public readonly port: number;
  public readonly host: string;
  public readonly webhookSecret: string;
  public readonly queueMode: boolean;
  public readonly pollIntervalMs: number;
  public readonly tunnelDriver: TunnelDriver;
  private readonly portManager: PortManager;
  private readonly pipeline: BuildPipeline;
  private readonly services: RunnerServices;

  private server: http.Server | null = null;
  private jobs: Map<string, JobState> = new Map();
  private pollTimer: NodeJS.Timeout | null = null;
  private pullConsumer: JobPullConsumer | null = null;
  private isShuttingDown: boolean = false;
  /** Nonces of accepted signed requests (all methods); see runner/src/request-auth.ts. */
  private readonly nonces = new NonceCache();
  /** Tunnel ingress: hostname → { port, jobId, containerId }. */
  private ingressRoutes: Map<string, { port: number; jobId: string; containerId?: string }> = new Map();

  constructor(config: DaemonConfig = {}) {
    this.port = config.port ?? parseInt(process.env.RUNNER_PORT || "8080", 10);
    this.host = config.host || process.env.RUNNER_HOST || "0.0.0.0";
    this.webhookSecret = resolveDaemonSecret(config.webhookSecret);
    const queueEnv = (process.env.RUNNER_QUEUE_MODE || "").toLowerCase();
    this.queueMode = config.queueMode ?? (queueEnv === "pull" || queueEnv === "true");
    this.pollIntervalMs = config.pollIntervalMs ?? (parseInt(process.env.RUNNER_POLL_INTERVAL_MS || "", 10) || 5000);
    this.portManager = config.portManager || defaultPortManager;
    this.pipeline = config.pipeline || new BuildPipeline({ portManager: this.portManager });
    this.services = config.services || new RunnerServices({ portManager: this.portManager });
    this.tunnelDriver = config.tunnelDriver || createTunnelDriver(config.tunnelConfig || {
      ingressUrl: `http://${this.host === "0.0.0.0" ? "127.0.0.1" : this.host}:${this.port}`,
    });
  }

  /**
   * Timing-safe HMAC SHA-256 verification of the canonical request string
   * `${ts}.${nonce}.${METHOD}.${path}.${body}` (must match `signRequest()` in the control plane's
   * runner-driver.ts). `path` is the request pathname; for GET routes `body` is the job id.
   * Pure check: it does not consume the nonce (see `verifySignedRequest`).
   */
  public verifySignature(
    method: string,
    pathname: string,
    body: string,
    signatureHeader: string | undefined,
    timestampHeader: string | undefined,
    nonce: string | undefined
  ): boolean {
    return verifyCanonicalSignature(this.webhookSecret, {
      method,
      pathname,
      body,
      signature: signatureHeader,
      timestamp: timestampHeader,
      nonce,
    });
  }

  /** Verifies a signed request and consumes its nonce, so any replay (any method) gets 401. */
  private verifySignedRequest(
    method: string,
    pathname: string,
    body: string,
    signature: string | undefined,
    timestamp: string | undefined,
    nonce: string | undefined
  ): boolean {
    return verifyAndConsume(this.webhookSecret, this.nonces, { method, pathname, body, signature, timestamp, nonce });
  }

  /** Header-signed request (`X-Syncbay-Signature` / `-Timestamp` / `-Nonce`), single-use. */
  private verifySignedHeaders(req: http.IncomingMessage, method: string, pathname: string, body: string): boolean {
    return this.verifySignedRequest(
      method,
      pathname,
      body,
      req.headers["x-syncbay-signature"] as string | undefined,
      req.headers["x-syncbay-timestamp"] as string | undefined,
      req.headers["x-syncbay-nonce"] as string | undefined
    );
  }

  /** Verifies a header-signed POST and rejects a replay. */
  private verifySignedPost(req: http.IncomingMessage, pathname: string, body: string): boolean {
    return this.verifySignedHeaders(req, "POST", pathname, body);
  }

  /**
   * Starts the daemon HTTP server and optional queue poller loop.
   */
  public async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      this.server.on("error", (err) => {
        if (!this.isShuttingDown) reject(err);
      });

      this.server.listen(this.port, this.host, () => {
        const addr = this.server?.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : this.port;
        console.log(`[runner-daemon] Listening on http://${this.host}:${actualPort}`);

        // Launch edge tunnel driver
        this.tunnelDriver.start().then(() => {
          console.log(`[runner-daemon] Tunnel driver active (${this.tunnelDriver.driverType}: ${this.tunnelDriver.getStatus()})`);
        }).catch((err: any) => {
          console.warn(`[runner-daemon] Tunnel driver warning: ${err.message}`);
        });

        if (this.queueMode) {
          console.log(`[runner-daemon] Starting queue poller loop (interval: ${this.pollIntervalMs}ms)`);
          this.startQueuePoller();
        }

        resolve(actualPort);
      });
    });
  }

  /**
   * Graceful shutdown of the daemon.
   */
  public async stop(): Promise<void> {
    this.isShuttingDown = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    await this.pullConsumer?.stop();

    this.services.shutdown();

    if (this.tunnelDriver) {
      await this.tunnelDriver.stop().catch(() => {});
    }

    // Close all open SSE connections
    for (const job of this.jobs.values()) {
      for (const client of job.sseClients) {
        try {
          client.end();
        } catch {}
      }
      job.sseClients.clear();
    }

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /**
   * Main HTTP request router.
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;
    const method = (req.method || "GET").toUpperCase();

    // CORS & Common Headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Syncbay-Signature, X-Syncbay-Timestamp, X-Syncbay-Nonce");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // A request carrying x-target-port is application traffic (edge proxy, control-plane health
    // probe): proxy it before the daemon's own routes, so `/health` reaches the app, not the daemon.
    const headerTargetPort = parseInt(String(req.headers["x-target-port"] || ""), 10);
    if (headerTargetPort > 0) {
      return this.proxyRequest(req, res, headerTargetPort, await this.readBody(req));
    }

    // Health Check Endpoint
    if (pathname === "/health" && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          uptime: process.uptime(),
          activeJobs: Array.from(this.jobs.values()).filter((j) => j.status === "BUILDING").length,
          allocatedPorts: this.portManager.getAllocatedPorts(),
          tunnel: {
            driver: this.tunnelDriver.driverType,
            status: this.tunnelDriver.getStatus(),
          },
        })
      );
      return;
    }

    // Tunnel Status Endpoint
    if (pathname === "/api/tunnel/status" && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          driver: this.tunnelDriver.driverType,
          status: this.tunnelDriver.getStatus(),
          stats: this.tunnelDriver.getStats(),
        })
      );
      return;
    }

    // Read full request body
    const body = await this.readBody(req);

    // Managed databases & web terminals (runner/src/services.ts)
    if (await this.services.handle(req, res, pathname, body, (p, s, t) => this.verifySignedRequest(method, pathname, p, s, t, req.headers["x-syncbay-nonce"] as string | undefined))) {
      return;
    }

    // Resource metrics: GET /api/metrics/:containerId (runner/src/metrics.ts)
    if (await handleMetricsRequest(req, res, pathname, (p, s, t) => this.verifySignedRequest(method, pathname, p, s, t, req.headers["x-syncbay-nonce"] as string | undefined))) return;

    // POST /api/builds: Dispatch new build
    if (pathname === "/api/builds" && method === "POST") {
      await this.handleDispatchBuild(req, res, body);
      return;
    }

    // GET /api/builds/:jobId: Check status
    const buildMatch = pathname.match(/^\/api\/builds\/([^\/]+)$/);
    if (buildMatch && method === "GET") {
      const jobId = decodeURIComponent(buildMatch[1]);
      // Header-only: query-string credentials are accepted solely on the SSE log route.
      const isAuthed = this.verifySignedHeaders(req, "GET", pathname, jobId);

      if (!isAuthed) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized: Invalid or missing HMAC signature" }));
        return;
      }

      this.handleGetBuild(jobId, res);
      return;
    }

    // GET /api/builds/:jobId/logs: Get or stream logs
    const logsMatch = pathname.match(/^\/api\/builds\/([^\/]+)\/logs$/);
    if (logsMatch && method === "GET") {
      const jobId = decodeURIComponent(logsMatch[1]);
      const headerSig = req.headers["x-syncbay-signature"] as string | undefined;
      // EventSource cannot set headers, so an SSE request may carry `sig`/`ts`/`nonce` in the
      // query string. The signature is still bound to GET + this exact pathname + job id, and
      // the nonce is single-use like every other signed request.
      const isEventStream = String(req.headers["accept"] || "").includes("text/event-stream");
      const useQuery = !headerSig && isEventStream;
      const signature = useQuery ? url.searchParams.get("sig") || undefined : headerSig;
      const timestamp = useQuery
        ? url.searchParams.get("ts") || undefined
        : (req.headers["x-syncbay-timestamp"] as string | undefined);
      const nonce = useQuery
        ? url.searchParams.get("nonce") || undefined
        : (req.headers["x-syncbay-nonce"] as string | undefined);

      const isAuthed = this.verifySignedRequest("GET", pathname, jobId, signature, timestamp, nonce);

      if (!isAuthed) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized: Invalid or missing HMAC signature" }));
        return;
      }

      this.handleStreamLogs(jobId, req, res);
      return;
    }

    // POST /api/containers/:containerId/stop: Stop running container
    const stopMatch = pathname.match(/^\/api\/containers\/([^\/]+)\/stop$/);
    if (stopMatch && method === "POST") {
      await this.handleStopContainer(req, res, decodeURIComponent(stopMatch[1]), pathname, body);
      return;
    }

    // POST /api/containers/:containerId/restart: stop + start the same image/process
    const restartMatch = pathname.match(/^\/api\/containers\/([^\/]+)\/restart$/);
    if (restartMatch && method === "POST") {
      if (!this.verifySignedPost(req, pathname, body)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized: Invalid HMAC signature" }));
        return;
      }
      const result = await this.restartInstance(decodeURIComponent(restartMatch[1]));
      res.writeHead(result.restarted ? 200 : 409, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    // Reverse Proxy for Deployed Applications
    let targetPort: number | undefined;
    const targetPortStr = (req.headers["x-target-port"] || url.searchParams.get("__sb_port")) as string | undefined;
    if (targetPortStr) {
      targetPort = parseInt(targetPortStr, 10);
    }

    if (!targetPort) {
      const allocated = this.portManager.getAllocatedPorts();
      if (allocated.length === 1) {
        targetPort = allocated[0];
      }
    }

    if (targetPort && targetPort > 0) {
      return this.proxyRequest(req, res, targetPort, body);
    }

    // 404 Not Found fallback
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Route not found", path: pathname }));
  }

  private proxyRequest(req: http.IncomingMessage, res: http.ServerResponse, targetPort: number, body: string): void {
    const options = {
      hostname: '127.0.0.1',
      port: targetPort,
      path: req.url,
      method: req.method,
      headers: { ...req.headers }
    };
    // remove headers that might cause issues
    delete options.headers["host"];
    delete options.headers["x-target-port"];

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on("error", (err) => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Bad Gateway", message: err.message, targetPort }));
    });

    if (body) {
      proxyReq.write(body);
    }
    proxyReq.end();
  }

  private async readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
  }

  private async handleDispatchBuild(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: string
  ): Promise<void> {
    console.log(`[runner-daemon] Received POST /api/builds webhook! Body size: ${body.length}`);

    // Verify HMAC Authentication (canonical POST signature, single use)
    if (!this.verifySignedPost(req, "/api/builds", body)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized: Invalid or missing HMAC signature" }));
      return;
    }

    let params: any;
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }

    const { job: jobState } = this.startJob(params);
    const jobId = jobState.jobId;

    // Return 202 Accepted with stream URL
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jobId,
        status: "BUILDING",
        streamUrl: `/api/builds/${jobId}/logs`,
      })
    );
  }

  /** Registers a build job and runs its pipeline in the background (HTTP dispatch and pull consumer). */
  public startJob(params: any): { job: JobState; done: Promise<void> } {
    const jobId = params.jobId || params.buildId || params.deploymentId || "job_" + crypto.randomUUID();

    // Register Job in memory
    const jobState: JobState = {
      jobId,
      status: "BUILDING",
      logs: [`[runner] Build job ${jobId} accepted by runner daemon`],
      startedAt: new Date().toISOString(),
      sseClients: new Set(),
    };
    this.jobs.set(jobId, jobState);
    if (params.deploymentId && params.deploymentId !== jobId) {
      this.jobs.set(params.deploymentId, jobState);
    }
    this.saveJobToDisk(jobId, jobState);
    if (params.deploymentId && params.deploymentId !== jobId) {
      this.saveJobToDisk(params.deploymentId, jobState);
    }

    return { job: jobState, done: this.runJobPipeline(jobId, { ...params, jobId }) };
  }

  private getLogFilePath(jobId: string): string {
    const candidates = [
      path.resolve(process.cwd(), ".runner_logs"),
      path.resolve(process.cwd(), "..", ".runner_logs"),
      path.resolve(process.cwd(), ".runner_workspace", "logs"),
    ];
    for (const dir of candidates) {
      try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        return path.join(dir, `${jobId}.json`);
      } catch {}
    }
    return path.join(process.cwd(), `${jobId}.json`);
  }

  private saveJobToDisk(jobId: string, job: JobState): void {
    try {
      const filePath = this.getLogFilePath(jobId);
      const data = {
        jobId: job.jobId,
        status: job.status,
        containerId: job.containerId,
        assignedPort: job.assignedPort,
        strategy: job.strategy,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        error: job.error,
        exitCode: job.exitCode,
        logs: job.logs,
      };
      fs.writeFileSync(filePath, JSON.stringify(data), "utf8");
    } catch {}
  }

  private loadJobFromDisk(jobId: string): JobState | null {
    try {
      const candidates = [
        path.resolve(process.cwd(), ".runner_logs", `${jobId}.json`),
        path.resolve(process.cwd(), "..", ".runner_logs", `${jobId}.json`),
        path.resolve(process.cwd(), ".runner_workspace", "logs", `${jobId}.json`),
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          const raw = fs.readFileSync(p, "utf8");
          const data = JSON.parse(raw);
          const state: JobState = {
            jobId: data.jobId || jobId,
            status: data.status || "ACTIVE",
            containerId: data.containerId,
            assignedPort: data.assignedPort,
            strategy: data.strategy,
            startedAt: data.startedAt || new Date().toISOString(),
            completedAt: data.completedAt,
            error: data.error,
            exitCode: typeof data.exitCode === "number" ? data.exitCode : undefined,
            logs: data.logs || [],
            sseClients: new Set(),
          };
          this.jobs.set(jobId, state);
          return state;
        }
      }
    } catch {}
    return null;
  }

  private async runJobPipeline(jobId: string, params: any): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    let logCounter = 0;
    const log = (msg: string) => {
      job.logs.push(msg);
      logCounter++;
      if (logCounter % 5 === 0) {
        this.saveJobToDisk(jobId, job);
        if (params.deploymentId && params.deploymentId !== jobId) {
          this.saveJobToDisk(params.deploymentId, job);
        }
      }
      // Stream to active SSE clients
      for (const client of job.sseClients) {
        try {
          client.write(`data: ${JSON.stringify({ message: msg, timestamp: new Date().toISOString() })}\n\n`);
        } catch {}
      }
    };

    try {
      const result: PipelineResult = await this.pipeline.execute({
        jobId,
        deploymentId: params.deploymentId,
        serviceId: params.serviceId,
        serviceName: params.serviceName,
        repoUrl: params.repoUrl,
        branch: params.branch,
        commitSha: params.commitSha,
        rootDir: params.rootDir,
        buildCommand: params.buildCommand,
        startCommand: params.startCommand,
        dockerfile: params.dockerfile,
        targetPort: params.targetPort || params.port || 3000,
        cleanBuild: params.cleanBuild,
        environmentVariables: params.environmentVariables,
        volumes: sanitizeVolumes(params.volumes),
        onLog: log,
      });

      job.completedAt = new Date().toISOString();
      job.exitCode = result.exitCode;
      if (result.success) {
        job.status = "ACTIVE";
        job.containerId = result.containerId;
        job.assignedPort = result.assignedPort;
        job.strategy = result.strategy;
        job.simulated = Boolean(result.simulated);
        log(`[runner] Job ${jobId} succeeded. Container: ${result.containerId}, Port: ${result.assignedPort}`);
        if (result.assignedPort) {
          await this.registerEdgeRoute(params, result.assignedPort, log);
          await this.addTunnelIngress(job, params, result.assignedPort, log);
        }
      } else {
        job.status = "FAILED";
        job.error = result.error;
        log(`[runner] Job ${jobId} failed (exit code ${result.exitCode}): ${result.error}`);
      }
    } catch (err: any) {
      job.status = "FAILED";
      job.error = err.message;
      job.exitCode = 1;
      job.completedAt = new Date().toISOString();
      log(`[runner] Pipeline error: ${err.message}`);
    } finally {
      this.saveJobToDisk(jobId, job);
      if (params.deploymentId && params.deploymentId !== jobId) {
        this.saveJobToDisk(params.deploymentId, job);
      }
      // Send termination event to SSE streams
      for (const client of job.sseClients) {
        try {
          client.write(`event: done\ndata: ${JSON.stringify({ status: job.status })}\n\n`);
          client.end();
        } catch {}
      }
      job.sseClients.clear();
    }
  }

  private handleGetBuild(jobId: string, res: http.ServerResponse): void {
    const job = this.jobs.get(jobId) || this.loadJobFromDisk(jobId);
    if (!job) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Job ${jobId} not found` }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jobId: job.jobId,
        status: job.status,
        containerId: job.containerId,
        assignedPort: job.assignedPort,
        port: job.assignedPort,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        error: job.error,
        errorMessage: job.error,
        exitCode: job.exitCode,
        simulated: Boolean(job.simulated),
        metadata: { simulated: Boolean(job.simulated) },
        logs: job.logs,
      })
    );
  }

  private handleStreamLogs(jobId: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    const job = this.jobs.get(jobId) || this.loadJobFromDisk(jobId);
    if (!job) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Job ${jobId} not found` }));
      return;
    }

    const accept = req.headers["accept"] || "";
    if (accept.includes("text/event-stream")) {
      // Set SSE headers
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });

      // Send existing backlog
      for (const line of job.logs) {
        res.write(`data: ${JSON.stringify({ message: line, timestamp: new Date().toISOString() })}\n\n`);
      }

      // If job is already finished, complete stream
      if (job.status !== "BUILDING" && job.status !== "QUEUED") {
        res.write(`event: done\ndata: ${JSON.stringify({ status: job.status })}\n\n`);
        res.end();
        return;
      }

      // Subscribe client to future log lines
      job.sseClients.add(res);
      req.on("close", () => {
        job.sseClients.delete(res);
      });
    } else {
      // Return JSON array of logs
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ logs: job.logs }));
    }
  }

  private async handleStopContainer(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    containerId: string,
    pathname: string,
    body: string
  ): Promise<void> {
    if (!this.verifySignedPost(req, pathname, body)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized: Invalid HMAC signature" }));
      return;
    }

    const result = await this.stopInstance(containerId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ containerId, ...result, message: "Container stop signaled" }));
  }

  /** Stops an instance, frees its port and drops its tunnel ingress (HTTP route and pull consumer). */
  public async stopInstance(containerId: string): Promise<{ stopped: boolean; releasedPort?: number }> {
    // Stop container or process via pipeline (it releases the port it recorded)
    const res = await this.pipeline.stopContainer(containerId).catch(() => null);
    this.portManager.releaseJobPort(containerId);

    // Mark job cancelled if found
    for (const job of this.jobs.values()) {
      if (job.containerId === containerId || job.jobId === containerId) {
        job.status = "CANCELLED";
      }
    }

    await this.removeTunnelIngress(containerId);
    return { stopped: Boolean(res?.stopped), releasedPort: res?.releasedPort };
  }

  /**
   * Restarts an instance via the pipeline's launch spec and moves the job record and tunnel
   * ingress to the new instance id / port.
   */
  public async restartInstance(
    containerId: string
  ): Promise<{ restarted: boolean; containerId: string; port?: number; error?: string }> {
    const job = Array.from(this.jobs.values()).find((j) => j.containerId === containerId);
    const log = (msg: string) => {
      if (job) job.logs.push(msg);
    };
    const result = await this.pipeline.restartContainer(containerId, log);
    if (result.restarted) {
      if (job) {
        job.containerId = result.containerId;
        job.assignedPort = result.port;
        job.status = "ACTIVE";
        this.saveJobToDisk(job.jobId, job);
      }
      let changed = false;
      for (const [host, r] of this.ingressRoutes) {
        if (r.containerId === containerId) {
          this.ingressRoutes.set(host, { ...r, containerId: result.containerId, port: result.port ?? r.port });
          changed = true;
        }
      }
      // A stopped job's ingress was removed; restore it for its hostnames.
      for (const host of job?.hostnames || []) {
        if (!this.ingressRoutes.has(host.toLowerCase()) && result.port) {
          this.ingressRoutes.set(host.toLowerCase(), { port: result.port, jobId: job!.jobId, containerId: result.containerId });
          changed = true;
        }
      }
      if (changed) await this.syncTunnelIngress();
    }
    return result;
  }

  /** `RUNNER_QUEUE_MODE=pull`: claim jobs from the control plane instead of waiting for webhooks. */
  private startQueuePoller(): void {
    const apiUrl = process.env.SYNCBAY_API_URL;
    if (!apiUrl) {
      console.warn("[runner-daemon] RUNNER_QUEUE_MODE=pull needs SYNCBAY_API_URL; pull consumer not started");
      return;
    }
    this.pullConsumer = new JobPullConsumer({
      apiUrl,
      secret: this.webhookSecret,
      runnerId: process.env.RUNNER_ID,
      pollIntervalMs: this.pollIntervalMs,
      daemon: this,
    });
    this.pullConsumer.start();
  }

  private resolveRouteHostnames(params: any): string[] {
    const hostnames: string[] = [];
    if (params.hostname) hostnames.push(params.hostname);
    if (params.subdomain) hostnames.push(`${params.subdomain}.syncbay.app`);
    if (params.serviceName) {
      hostnames.push(`${params.serviceName}.syncbay.app`);
      hostnames.push(`${params.serviceName}.localhost`);
    }
    if (Array.isArray(params.domains)) {
      for (const d of params.domains) {
        if (typeof d === "string") hostnames.push(d);
        else if (d?.hostname) hostnames.push(d.hostname);
      }
    }

    const uniqueHosts = Array.from(new Set(hostnames.filter(Boolean)));
    if (uniqueHosts.length === 0 && params.jobId) {
      uniqueHosts.push(`${params.jobId}.syncbay.app`);
    }
    return uniqueHosts;
  }

  /** Publishes the current ingress table (hostname → 127.0.0.1:port) to the tunnel driver. */
  private async syncTunnelIngress(log?: (msg: string) => void): Promise<void> {
    if (!this.tunnelDriver.updateIngress) return;
    const routes = Array.from(this.ingressRoutes, ([hostname, r]) => ({ hostname, port: r.port }));
    try {
      const applied = await this.tunnelDriver.updateIngress(routes);
      if (applied) log?.(`[runner-tunnel] Applied ${routes.length} tunnel ingress rule(s)`);
    } catch (err: any) {
      (log || console.warn)(`[runner-tunnel] Tunnel ingress update failed: ${err.message}`);
    }
  }

  /** Post-deploy hook: maps the job's public hostnames to http://127.0.0.1:<port> in the tunnel. */
  private async addTunnelIngress(job: JobState, params: any, port: number, log: (msg: string) => void): Promise<void> {
    const hosts = this.resolveRouteHostnames(params).filter((h) => !h.endsWith(".localhost") && isValidIngressHostname(h));
    job.hostnames = hosts;
    for (const h of hosts) {
      this.ingressRoutes.set(h.toLowerCase(), { port, jobId: job.jobId, containerId: job.containerId });
    }
    await this.syncTunnelIngress(log);
  }

  /** Post-stop hook: drops every ingress rule that pointed at the stopped container/job. */
  private async removeTunnelIngress(containerId: string): Promise<void> {
    let removed = false;
    for (const [host, r] of this.ingressRoutes) {
      if (r.containerId === containerId || r.jobId === containerId) {
        this.ingressRoutes.delete(host);
        removed = true;
      }
    }
    if (removed) await this.syncTunnelIngress();
  }

  public getIngressRoutes(): Array<{ hostname: string; port: number }> {
    return Array.from(this.ingressRoutes, ([hostname, r]) => ({ hostname, port: r.port }));
  }

  private async registerEdgeRoute(params: any, assignedPort: number, log: (msg: string) => void): Promise<void> {
    const uniqueHosts = this.resolveRouteHostnames(params);

    log(`[runner-edge] Registering ${uniqueHosts.length} edge route(s) for port ${assignedPort}...`);

    // 1. In-process global Edge Service Registry if available
    const globalReg = (globalThis as any).__syncbay_edge_registry;
    if (globalReg && typeof globalReg.registerServiceRoute === "function") {
      for (const h of uniqueHosts) {
        globalReg.registerServiceRoute(h, assignedPort, "ACTIVE", `http://127.0.0.1:${assignedPort}`);
      }
    }

    // 2. Control Plane HTTP API endpoint
    const apiUrl = process.env.SYNCBAY_API_URL || "http://127.0.0.1:3000";
    const secret = this.webhookSecret || process.env.RUNNER_SECRET;
    const reqHeaders: Record<string, string> = { "Content-Type": "application/json" };
    if (secret) {
      reqHeaders["Authorization"] = `Bearer ${secret}`;
    }

    for (const h of uniqueHosts) {
      try {
        await fetch(`${apiUrl.replace(/\/$/, "")}/api/v1/services/edge-register`, {
          method: "POST",
          headers: reqHeaders,
          body: JSON.stringify({
            hostname: h,
            targetPort: assignedPort,
            status: "ACTIVE",
            upstreamUrl: `http://127.0.0.1:${assignedPort}`,
          }),
          signal: AbortSignal.timeout(1500),
        }).catch(() => null);
      } catch {}
    }
  }

  public getJob(jobId: string): JobState | undefined {
    return this.jobs.get(jobId);
  }
}

// ─── CLI EXECUTION ENTRYPOINT ────────────────────────────────────────────────

const isDirectRun = process.argv[1] && (process.argv[1].endsWith("index.js") || process.argv[1].endsWith("index.ts"));

if (isDirectRun) {
  const daemon = new RunnerDaemon();
  daemon.start().catch((err) => {
    console.error("[runner-daemon] Fatal startup error:", err);
    process.exit(1);
  });

  const handleSignal = async () => {
    console.log("[runner-daemon] Shutting down...");
    await daemon.stop();
    process.exit(0);
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
}
