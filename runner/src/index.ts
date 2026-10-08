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
import { BuildPipeline, type PipelineResult } from "./pipeline";
import { PortManager, defaultPortManager } from "./port-manager";

export interface DaemonConfig {
  port?: number;
  host?: string;
  webhookSecret?: string;
  queueMode?: boolean;
  pollIntervalMs?: number;
  portManager?: PortManager;
  pipeline?: BuildPipeline;
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
  sseClients: Set<http.ServerResponse>;
}

export class RunnerDaemon {
  public readonly port: number;
  public readonly host: string;
  public readonly webhookSecret: string;
  public readonly queueMode: boolean;
  public readonly pollIntervalMs: number;
  private readonly portManager: PortManager;
  private readonly pipeline: BuildPipeline;

  private server: http.Server | null = null;
  private jobs: Map<string, JobState> = new Map();
  private pollTimer: NodeJS.Timeout | null = null;
  private isShuttingDown: boolean = false;

  constructor(config: DaemonConfig = {}) {
    this.port = config.port ?? parseInt(process.env.RUNNER_PORT || "8080", 10);
    this.host = config.host || process.env.RUNNER_HOST || "0.0.0.0";
    this.webhookSecret = config.webhookSecret || process.env.RUNNER_SECRET || process.env.SYNCBAY_WEBHOOK_SECRET || "syncbay-runner-secret";
    this.queueMode = config.queueMode ?? (process.env.RUNNER_QUEUE_MODE === "true");
    this.pollIntervalMs = config.pollIntervalMs ?? 5000;
    this.portManager = config.portManager || defaultPortManager;
    this.pipeline = config.pipeline || new BuildPipeline({ portManager: this.portManager });
  }

  /**
   * Timing-safe HMAC SHA-256 signature verification.
   */
  public verifySignature(
    body: string,
    signatureHeader: string | undefined,
    timestampHeader: string | undefined
  ): boolean {
    if (!signatureHeader || !this.webhookSecret) {
      return false;
    }

    // Enforce strict numeric validation for timestamp (missing, non-numeric, or expired is rejected)
    if (!timestampHeader) {
      return false;
    }
    const ts = Number(timestampHeader);
    if (isNaN(ts) || Math.abs(Date.now() - ts) > 300000) {
      return false;
    }

    let providedHex = signatureHeader.trim();
    if (providedHex.startsWith("sha256=")) {
      providedHex = providedHex.slice(7).trim();
    }

    if (!/^[0-9a-fA-F]{64}$/.test(providedHex)) {
      return false;
    }

    const hmac = crypto.createHmac("sha256", this.webhookSecret);
    hmac.update(`${timestampHeader}.${body}`);
    const expectedHex = hmac.digest("hex");

    try {
      const bufA = Buffer.from(providedHex, "hex");
      const bufB = Buffer.from(expectedHex, "hex");
      if (bufA.length !== bufB.length) return false;
      return crypto.timingSafeEqual(bufA, bufB);
    } catch {
      return false;
    }
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
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Syncbay-Signature, X-Syncbay-Timestamp");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
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
        })
      );
      return;
    }

    // Read full request body
    const body = await this.readBody(req);

    // POST /api/builds: Dispatch new build
    if (pathname === "/api/builds" && method === "POST") {
      await this.handleDispatchBuild(req, res, body);
      return;
    }

    // GET /api/builds/:jobId: Check status
    const buildMatch = pathname.match(/^\/api\/builds\/([^\/]+)$/);
    if (buildMatch && method === "GET") {
      const jobId = decodeURIComponent(buildMatch[1]);
      const signature = (req.headers["x-syncbay-signature"] || url.searchParams.get("signature") || url.searchParams.get("sig")) as string | undefined;
      const timestamp = (req.headers["x-syncbay-timestamp"] || url.searchParams.get("timestamp") || url.searchParams.get("ts")) as string | undefined;

      const isAuthed =
        this.verifySignature(JSON.stringify({ jobId }), signature, timestamp) ||
        this.verifySignature(jobId, signature, timestamp) ||
        this.verifySignature("", signature, timestamp) ||
        this.verifySignature(pathname, signature, timestamp);

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
      const signature = (req.headers["x-syncbay-signature"] || url.searchParams.get("signature") || url.searchParams.get("sig")) as string | undefined;
      const timestamp = (req.headers["x-syncbay-timestamp"] || url.searchParams.get("timestamp") || url.searchParams.get("ts")) as string | undefined;

      const isAuthed =
        this.verifySignature(JSON.stringify({ jobId }), signature, timestamp) ||
        this.verifySignature(jobId, signature, timestamp) ||
        this.verifySignature("", signature, timestamp) ||
        this.verifySignature(pathname, signature, timestamp);

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
      await this.handleStopContainer(req, res, decodeURIComponent(stopMatch[1]), body);
      return;
    }

    // 404 Not Found fallback
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Route not found", path: pathname }));
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
    const signature = req.headers["x-syncbay-signature"] as string | undefined;
    const timestamp = req.headers["x-syncbay-timestamp"] as string | undefined;

    // Verify HMAC Authentication
    if (!this.verifySignature(body, signature, timestamp)) {
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

    // Return 202 Accepted with stream URL
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jobId,
        status: "BUILDING",
        streamUrl: `/api/builds/${jobId}/logs`,
      })
    );

    // Asynchronously launch pipeline
    this.runJobPipeline(jobId, params);
  }

  private async runJobPipeline(jobId: string, params: any): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    const log = (msg: string) => {
      job.logs.push(msg);
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
        environmentVariables: params.environmentVariables,
        onLog: log,
      });

      job.completedAt = new Date().toISOString();
      if (result.success) {
        job.status = "ACTIVE";
        job.containerId = result.containerId;
        job.assignedPort = result.assignedPort;
        job.strategy = result.strategy;
        log(`[runner] Job ${jobId} succeeded. Container: ${result.containerId}, Port: ${result.assignedPort}`);
      } else {
        job.status = "FAILED";
        job.error = result.error;
        log(`[runner] Job ${jobId} failed: ${result.error}`);
      }
    } catch (err: any) {
      job.status = "FAILED";
      job.error = err.message;
      job.completedAt = new Date().toISOString();
      log(`[runner] Pipeline error: ${err.message}`);
    } finally {
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
    const job = this.jobs.get(jobId);
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
      })
    );
  }

  private handleStreamLogs(jobId: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    const job = this.jobs.get(jobId);
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
    body: string
  ): Promise<void> {
    const signature = req.headers["x-syncbay-signature"] as string | undefined;
    const timestamp = req.headers["x-syncbay-timestamp"] as string | undefined;

    if (!this.verifySignature(body, signature, timestamp)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized: Invalid HMAC signature" }));
      return;
    }

    // Release port associated with container/service
    this.portManager.releaseJobPort(containerId);

    // Stop container or process via pipeline
    await this.pipeline.stopContainer(containerId).catch(() => null);

    // Mark job cancelled if found
    for (const job of this.jobs.values()) {
      if (job.containerId === containerId || job.jobId === containerId) {
        job.status = "CANCELLED";
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ containerId, stopped: true, message: "Container stop signaled" }));
  }

  private startQueuePoller(): void {
    this.pollTimer = setInterval(async () => {
      // Queue poller hook: checks for QUEUED builds and triggers pipeline
      // In standalone runner daemon, pending queue jobs are processed sequentially
      for (const [id, job] of this.jobs.entries()) {
        if (job.status === "QUEUED") {
          job.status = "BUILDING";
          this.runJobPipeline(id, { jobId: id });
          break; // process one job at a time
        }
      }
    }, this.pollIntervalMs);
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
