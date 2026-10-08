/**
 * Syncbay Runner Agent — Automated Build & Container Pipeline
 *
 * Implements end-to-end execution lifecycle:
 * 1. Git clone & workspace checkout
 * 2. Build detection (Dockerfile vs Nixpacks)
 * 3. Container compilation & image tagging
 * 4. Dynamic port allocation & container launch
 * 5. Health probe verification
 */

import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { PortManager, defaultPortManager } from "./port-manager.ts";

const execAsync = promisify(exec);

// ─── PIPELINE INTERFACES ─────────────────────────────────────────────────────

export interface PipelineCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface PipelineExecutor {
  execute(command: string, options?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<PipelineCommandResult>;
  probeHealth(url: string, timeoutMs?: number): Promise<boolean>;
  fileExists(filePath: string): Promise<boolean>;
}

export interface PipelineOptions {
  jobId: string;
  deploymentId?: string;
  serviceId?: string;
  serviceName?: string;
  repoUrl?: string;
  branch?: string;
  commitSha?: string;
  rootDir?: string;
  buildCommand?: string;
  startCommand?: string;
  dockerfile?: string;
  targetPort?: number;
  environmentVariables?: Record<string, string>;
  workDir?: string;
  portManager?: PortManager;
  executor?: PipelineExecutor;
  healthCheckPath?: string;
  healthCheckTimeoutMs?: number;
  healthCheckIntervalMs?: number;
  onLog?: (line: string) => void;
}

export interface PipelineResult {
  success: boolean;
  jobId: string;
  strategy: "dockerfile" | "nixpacks";
  containerId?: string;
  assignedPort?: number;
  imageTag: string;
  logs: string[];
  durationMs: number;
  error?: string;
}

// ─── DEFAULT SYSTEM EXECUTOR ─────────────────────────────────────────────────

export class DefaultPipelineExecutor implements PipelineExecutor {
  public async execute(
    command: string,
    options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
  ): Promise<PipelineCommandResult> {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        maxBuffer: 10 * 1024 * 1024,
      });
      return {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: 0,
      };
    } catch (err: any) {
      return {
        stdout: (err.stdout || "").trim(),
        stderr: (err.stderr || err.message || "").trim(),
        exitCode: typeof err.code === "number" ? err.code : 1,
      };
    }
  }

  public async probeHealth(url: string, timeoutMs: number = 3000): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
      });
      clearTimeout(timeout);

      return res.status >= 200 && res.status < 400;
    } catch {
      return false;
    }
  }

  public async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.stat(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

// ─── MOCK EXECUTOR (FOR HERMETIC TESTS) ───────────────────────────────────────

export class MockPipelineExecutor implements PipelineExecutor {
  public commands: string[] = [];
  public mockedFiles: Set<string> = new Set();
  public healthProbeSuccess: boolean = true;
  private commandHandlers: Map<RegExp, (cmd: string) => PipelineCommandResult> = new Map();

  constructor() {
    this.initDefaultHandlers();
  }

  private initDefaultHandlers(): void {
    this.commandHandlers.set(/git clone/, () => ({
      stdout: "Cloning into repo...\nDone.",
      stderr: "",
      exitCode: 0,
    }));
    this.commandHandlers.set(/docker build/, () => ({
      stdout: "Step 1/5 : FROM node:20\nSuccessfully built abc123456",
      stderr: "",
      exitCode: 0,
    }));
    this.commandHandlers.set(/nixpacks build/, () => ({
      stdout: "Nixpacks build completed successfully\nGenerated image",
      stderr: "",
      exitCode: 0,
    }));
    this.commandHandlers.set(/docker run/, () => ({
      stdout: "container_" + Math.random().toString(16).slice(2, 10),
      stderr: "",
      exitCode: 0,
    }));
    this.commandHandlers.set(/docker stop/, () => ({
      stdout: "stopped",
      stderr: "",
      exitCode: 0,
    }));
  }

  public setHandler(pattern: RegExp, handler: (cmd: string) => PipelineCommandResult): void {
    this.commandHandlers.set(pattern, handler);
  }

  public async execute(command: string): Promise<PipelineCommandResult> {
    this.commands.push(command);
    for (const [pattern, handler] of this.commandHandlers.entries()) {
      if (pattern.test(command)) {
        return handler(command);
      }
    }
    return { stdout: "ok", stderr: "", exitCode: 0 };
  }

  public async probeHealth(_url: string): Promise<boolean> {
    return this.healthProbeSuccess;
  }

  public async fileExists(filePath: string): Promise<boolean> {
    const normalized = filePath.replace(/\\/g, "/");
    for (const f of this.mockedFiles) {
      if (f.replace(/\\/g, "/") === normalized) {
        return true;
      }
    }
    return false;
  }
}

// ─── BUILD PIPELINE IMPLEMENTATION ───────────────────────────────────────────

export class BuildPipeline {
  private readonly executor: PipelineExecutor;
  private readonly portManager: PortManager;

  constructor(options: { executor?: PipelineExecutor; portManager?: PortManager } = {}) {
    this.executor = options.executor || new DefaultPipelineExecutor();
    this.portManager = options.portManager || defaultPortManager;
  }

  /**
   * Executes the automated container build & deployment pipeline.
   */
  public async execute(options: PipelineOptions): Promise<PipelineResult> {
    const startTime = Date.now();
    const logs: string[] = [];
    const log = (msg: string) => {
      const entry = `[pipeline] ${msg}`;
      logs.push(entry);
      if (options.onLog) {
        options.onLog(entry);
      }
    };

    const jobId = options.jobId;
    const serviceName = (options.serviceName || "service").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    const imageTag = `syncbay-${serviceName}:${jobId.slice(0, 8)}`;
    const containerName = `syncbay-${serviceName}-${jobId.slice(0, 8)}`;
    const targetPort = options.targetPort || 3000;
    const baseWorkDir = options.workDir || path.join(process.cwd(), ".runner_workspace", jobId);

    log(`Initiating automated build pipeline for job ${jobId} (Service: ${serviceName})`);

    let assignedPort: number | undefined;
    let containerId: string | undefined;
    let strategy: "dockerfile" | "nixpacks" = "nixpacks";

    try {
      // Step 1: Workspace setup
      log(`Setting up build workspace at: ${baseWorkDir}`);
      let sourceDir = baseWorkDir;

      // Step 2: Git checkout if repoUrl provided
      if (options.repoUrl) {
        // Sanitize & validate repoUrl
        if (typeof options.repoUrl !== "string" || !options.repoUrl.trim()) {
          throw new Error("Invalid git repoUrl: repository URL must be a non-empty string");
        }
        const trimmedUrl = options.repoUrl.trim();
        if (/[\s;`$|&><'"\\]/.test(trimmedUrl) || trimmedUrl.startsWith("-")) {
          throw new Error(`Invalid git repoUrl "${options.repoUrl}": contains disallowed shell characters or flags`);
        }

        // Sanitize & validate branch
        let branchFlag = "";
        if (options.branch) {
          const trimmedBranch = options.branch.trim();
          if (!/^[a-zA-Z0-9._/-]+$/.test(trimmedBranch) || trimmedBranch.startsWith("-")) {
            throw new Error(`Invalid git branch "${options.branch}": must match ^[a-zA-Z0-9._/-]+$ and not start with '-'`);
          }
          branchFlag = `-b ${trimmedBranch}`;
        }

        // Sanitize & validate commitSha
        if (options.commitSha) {
          const trimmedSha = options.commitSha.trim();
          if (!/^[a-zA-Z0-9._/-]+$/.test(trimmedSha) || trimmedSha.startsWith("-")) {
            throw new Error(`Invalid commit SHA "${options.commitSha}": contains disallowed shell characters or flags`);
          }
        }

        const cloneCmd = `git clone --depth 1 ${branchFlag ? branchFlag + " " : ""}-- "${trimmedUrl}" "${baseWorkDir}"`;
        log(`Cloning repository: ${cloneCmd}`);
        const cloneRes = await this.executor.execute(cloneCmd);
        if (cloneRes.exitCode !== 0) {
          throw new Error(`Git clone failed: ${cloneRes.stderr || cloneRes.stdout}`);
        }

        if (options.commitSha) {
          const safeSha = options.commitSha.trim();
          log(`Checking out target commit: ${safeSha}`);
          await this.executor.execute(`git checkout -- "${safeSha}"`, { cwd: baseWorkDir });
        }
      }

      if (options.rootDir) {
        sourceDir = path.join(baseWorkDir, options.rootDir);
      }

      // Step 3: Determine build strategy (Dockerfile vs Nixpacks)
      const dockerfilePath = options.dockerfile
        ? path.join(sourceDir, options.dockerfile)
        : path.join(sourceDir, "Dockerfile");

      const hasDockerfile = await this.executor.fileExists(dockerfilePath);

      if (hasDockerfile) {
        strategy = "dockerfile";
        log(`Dockerfile detected at ${dockerfilePath} — using Docker build strategy`);

        let buildCmd = `docker build -t ${imageTag} -f "${dockerfilePath}" "${sourceDir}"`;
        if (options.buildCommand) {
          buildCmd += ` --build-arg BUILD_CMD="${options.buildCommand}"`;
        }

        log(`Compiling container image: ${buildCmd}`);
        const buildRes = await this.executor.execute(buildCmd, { cwd: sourceDir });
        if (buildRes.exitCode !== 0) {
          throw new Error(`Docker build failed: ${buildRes.stderr || buildRes.stdout}`);
        }
        log(`Docker build succeeded for image ${imageTag}`);
      } else {
        strategy = "nixpacks";
        log(`No Dockerfile found — using Nixpacks automated runtime detection`);

        let nixpacksCmd = `nixpacks build "${sourceDir}" --name ${imageTag}`;
        if (options.buildCommand) {
          nixpacksCmd += ` --build-cmd "${options.buildCommand}"`;
        }
        if (options.startCommand) {
          nixpacksCmd += ` --start-cmd "${options.startCommand}"`;
        }

        log(`Compiling container image via Nixpacks: ${nixpacksCmd}`);
        const nixRes = await this.executor.execute(nixpacksCmd, { cwd: sourceDir });
        if (nixRes.exitCode !== 0) {
          throw new Error(`Nixpacks build failed: ${nixRes.stderr || nixRes.stdout}`);
        }
        log(`Nixpacks compilation succeeded for image ${imageTag}`);
      }

      // Step 4: Dynamic Port Allocation
      log(`Allocating host port for service ${options.serviceId || serviceName}`);
      assignedPort = await this.portManager.allocatePort(options.serviceId, jobId);
      log(`Assigned dynamic host port: ${assignedPort} (target container port: ${targetPort})`);

      // Step 5: Container Run
      const envFlags: string[] = [];
      if (options.environmentVariables) {
        for (const [k, v] of Object.entries(options.environmentVariables)) {
          const safeKey = k.replace(/[^a-zA-Z0-9_]/g, "");
          if (!safeKey) continue;
          envFlags.push(`-e ${safeKey}="${String(v).replace(/"/g, '\\"')}"`);
        }
      }
      envFlags.push(`-e PORT=${targetPort}`);

      const startCmd = options.startCommand ? ` ${options.startCommand}` : "";
      const runCmd = `docker run -d --name ${containerName} --restart unless-stopped -p ${assignedPort}:${targetPort} ${envFlags.join(" ")} ${imageTag}${startCmd}`.trim();

      log(`Launching application container: ${runCmd}`);
      const runRes = await this.executor.execute(runCmd);
      if (runRes.exitCode !== 0) {
        throw new Error(`Docker run failed: ${runRes.stderr || runRes.stdout}`);
      }

      containerId = runRes.stdout.trim().split("\n").pop() || containerName;
      log(`Container launched successfully with ID: ${containerId}`);

      // Step 6: Health Probe Verification
      const probePath = options.healthCheckPath || "/health";
      const probeUrl = `http://127.0.0.1:${assignedPort}${probePath}`;
      const timeoutMs = options.healthCheckTimeoutMs ?? 6000;
      const intervalMs = options.healthCheckIntervalMs ?? 500;
      const deadline = Date.now() + timeoutMs;

      log(`Probing health endpoint at ${probeUrl} (timeout: ${timeoutMs}ms)`);
      let isHealthy = false;

      while (Date.now() < deadline) {
        isHealthy = await this.executor.probeHealth(probeUrl, 1000);
        if (isHealthy) {
          log(`Health check passed on ${probeUrl} — container is healthy and responding`);
          break;
        }
        // Fallback probe to root path
        if (probePath !== "/") {
          const rootUrl = `http://127.0.0.1:${assignedPort}/`;
          if (await this.executor.probeHealth(rootUrl, 1000)) {
            isHealthy = true;
            log(`Health check passed on root fallback URL ${rootUrl}`);
            break;
          }
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }

      if (!isHealthy) {
        log(`Warning: Initial health probe did not receive 200 OK within ${timeoutMs}ms (container running)`);
      }

      const durationMs = Date.now() - startTime;
      log(`Pipeline execution finished successfully in ${(durationMs / 1000).toFixed(2)}s`);

      return {
        success: true,
        jobId,
        strategy,
        containerId,
        assignedPort,
        imageTag,
        logs,
        durationMs,
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const errMsg = err.message || String(err);
      log(`Pipeline failed: ${errMsg}`);

      // Cleanup allocated port on failure
      if (assignedPort !== undefined) {
        this.portManager.releasePort(assignedPort);
      }

      // Cleanup failed container if running
      if (containerId) {
        await this.executor.execute(`docker stop ${containerId} && docker rm -f ${containerId}`).catch(() => null);
      }

      return {
        success: false,
        jobId,
        strategy,
        containerId,
        assignedPort,
        imageTag,
        logs,
        durationMs,
        error: errMsg,
      };
    }
  }
}

export const defaultPipeline = new BuildPipeline();

export async function executeBuildPipeline(options: PipelineOptions): Promise<PipelineResult> {
  return defaultPipeline.execute(options);
}
