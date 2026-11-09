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

import { exec, execSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { PortManager, defaultPortManager } from "./port-manager.ts";
import { withBuildToolHint } from "./build-hints.ts";
import { dockerVolumeFlags, prepareNativeVolumes, type VolumeMount } from "./volumes.ts";

const execAsync = promisify(exec);

// ─── PIPELINE INTERFACES ─────────────────────────────────────────────────────

export interface PipelineCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface PipelineExecutor {
  execute(command: string, options?: { cwd?: string; env?: NodeJS.ProcessEnv; onLog?: (line: string) => void }): Promise<PipelineCommandResult>;
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
  cleanBuild?: boolean;
  /** Persistent volumes (Volume rows) mounted into the container or bound for native processes. */
  volumes?: VolumeMount[];
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
  /** 0 on success; otherwise the exit code of the failing step or crashed app process (1 if unknown). */
  exitCode: number;
  simulated?: boolean;
}

/** How an instance was started; lets the runner restart or revive it. */
type LaunchSpec = {
  kind: "process" | "docker";
  jobId: string;
  serviceId?: string;
  port: number;
  /** Shell command; for Docker it contains `{{PORT}}` in place of the host port. */
  runCmd: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  containerName?: string;
  healthPath: string;
};

/** Launch specs kept for restart/rollback (oldest evicted first). */
const MAX_LAUNCH_SPECS = 200;

/** Number of trailing stderr lines kept to explain a startup crash. */
const STARTUP_STDERR_LINES = 25;

/** Build artifacts and caches removed by a clean rebuild (cleanBuild: true). */
const CLEAN_BUILD_PURGE_PATHS = ["node_modules", "dist", ".next", "build", "out", ".turbo", ".cache"];

/** Error carrying the exit code of the pipeline step that failed. */
class PipelineStepError extends Error {
  public readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "PipelineStepError";
    this.exitCode = exitCode;
  }
}

/** Splits a stdio chunk into trimmed, non-empty lines. */
function splitLines(chunk: Buffer | string): string[] {
  return chunk
    .toString()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

// ─── DEFAULT SYSTEM EXECUTOR ─────────────────────────────────────────────────

export class DefaultPipelineExecutor implements PipelineExecutor {
  public async execute(
    command: string,
    options: { cwd?: string; env?: NodeJS.ProcessEnv; onLog?: (line: string) => void } = {}
  ): Promise<PipelineCommandResult> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";

      const child = spawn(command, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        shell: true,
      });

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        if (options.onLog) {
          const lines = text.split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) options.onLog(trimmed);
          }
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        if (options.onLog) {
          const lines = text.split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) options.onLog(trimmed);
          }
        }
      });

      child.on("close", (code) => {
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: code ?? 0,
        });
      });

      child.on("error", (err: any) => {
        const msg = err?.message || String(err);
        stderr += "\n" + msg;
        if (options.onLog) options.onLog(msg);
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: 1,
        });
      });
    });
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

      // Any valid HTTP response below 500 confirms the application server is up and listening
      return res.status >= 200 && res.status < 500;
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
      stdout: "Cloning into 'repo'...\nremote: Enumerating objects: 154, done.\nremote: Counting objects: 100% (154/154), done.\nremote: Compressing objects: 100% (110/110), done.\nReceiving objects: 100% (154/154), 1.2 MiB | 3.4 MiB/s, done.\nResolving deltas: 100% (45/45), done.",
      stderr: "",
      exitCode: 0,
    }));
    this.commandHandlers.set(/git checkout/, (cmd) => {
      const shaMatch = cmd.match(/git checkout (?:-- )?"([^"]+)"/);
      const sha = shaMatch ? shaMatch[1] : "target";
      return {
        stdout: `Note: switching to '${sha}'.\n\nHEAD is now at ${sha.slice(0, 7)} Deployment target commit`,
        stderr: "",
        exitCode: 0,
      };
    });
    this.commandHandlers.set(/docker build/, () => ({
      stdout: "Step 1/5 : FROM node:20-alpine\n ---> a1b2c3d4e5f6\nStep 2/5 : WORKDIR /app\n ---> Running in 1a2b3c4d5e6f\n ---> 2b3c4d5e6f7a\nStep 3/5 : COPY package*.json ./\n ---> 3c4d5e6f7a8b\nStep 4/5 : RUN npm install\n ---> Running in 4d5e6f7a8b9c\nadded 150 packages in 2.5s\n ---> 5e6f7a8b9c0d\nStep 5/5 : COPY . .\n ---> 6f7a8b9c0d1e\nSuccessfully built abc123456\nSuccessfully tagged image:latest",
      stderr: "",
      exitCode: 0,
    }));
    this.commandHandlers.set(/nixpacks build/, () => ({
      stdout: "[nixpacks] Scanning repository files for runtime signatures...\n[nixpacks] Detected runtime: nodejs (nodejs) on Node.js v20\n[knip] Scanning repository tree...\n[knip] ✔ Zero unused dependencies detected\n[nixpacks] Generated 4-phase build plan:\n  Phase 1 (setup):   install system pkgs [nodejs_20, npm]\n  Phase 2 (install): npm install\n  Phase 3 (build):   npm run build\n  Phase 4 (start):   npm start\n[nixpacks] Executing setup phase...\n[nixpacks] Executing install phase...\n[nixpacks] Executing build phase...\n[nixpacks] Build completed successfully\n[nixpacks] Generated container image.",
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
    this.commandHandlers.set(/docker info/, () => ({
      stdout: "Server Version: 24.0.7",
      stderr: "",
      exitCode: 0,
    }));
    this.commandHandlers.set(/nixpacks --version/, () => ({
      stdout: "nixpacks v1.0.0",
      stderr: "",
      exitCode: 0,
    }));
  }

  public setHandler(pattern: RegExp, handler: (cmd: string) => PipelineCommandResult): void {
    for (const key of Array.from(this.commandHandlers.keys())) {
      if (key.source === pattern.source) {
        this.commandHandlers.delete(key);
      }
    }
    const updated = new Map<RegExp, (cmd: string) => PipelineCommandResult>();
    updated.set(pattern, handler);
    for (const [k, v] of this.commandHandlers.entries()) {
      updated.set(k, v);
    }
    this.commandHandlers = updated;
  }

  public async execute(
    command: string,
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; onLog?: (line: string) => void }
  ): Promise<PipelineCommandResult> {
    this.commands.push(command);
    for (const [pattern, handler] of this.commandHandlers.entries()) {
      if (pattern.test(command)) {
        const res = handler(command);
        if (options?.onLog) {
          if (res.stdout) {
            for (const line of res.stdout.split("\n")) {
              if (line.trim()) options.onLog(line.trim());
            }
          }
          if (res.stderr) {
            for (const line of res.stderr.split("\n")) {
              if (line.trim()) options.onLog(line.trim());
            }
          }
        }
        return res;
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

function createDefaultExecutor(): PipelineExecutor {
  if ((process.env.RUNNER_DRIVER || "").toLowerCase() === "mock") {
    console.log("[pipeline] RUNNER_DRIVER=mock — using MockPipelineExecutor");
    return new MockPipelineExecutor();
  }
  const isServerless = Boolean(process.env.VERCEL || process.env.VERCEL_ENV || process.env.AWS_LAMBDA_FUNCTION_NAME);
  if (isServerless && !process.env.RUNNER_URL) {
    console.log("[pipeline] Serverless environment without RUNNER_URL — using MockPipelineExecutor");
    return new MockPipelineExecutor();
  }
  try {
    execSync("git --version", { stdio: "ignore" });
    console.log("[pipeline] Using DefaultPipelineExecutor");
    return new DefaultPipelineExecutor();
  } catch (err) {
    console.warn("[pipeline] Native git not found, activating serverless MockPipelineExecutor fallback:", err);
    return new MockPipelineExecutor();
  }
}

// ─── BUILD PIPELINE IMPLEMENTATION ───────────────────────────────────────────

export class BuildPipeline {
  private readonly executor: PipelineExecutor;
  private readonly portManager: PortManager;
  private activeProcesses: Map<string, ChildProcess> = new Map();
  private activeProcessPorts: Map<string, number> = new Map();
  /** How each instance was launched, kept after a stop so restart/rollback can revive it. */
  private launchSpecs: Map<string, LaunchSpec> = new Map();

  constructor(options: { executor?: PipelineExecutor; portManager?: PortManager } = {}) {
    this.executor = options.executor || createDefaultExecutor();
    this.portManager = options.portManager || defaultPortManager;
  }

  /**
   * Stops a running container or native child process.
   */
  public async stopContainer(containerId: string): Promise<{ stopped: boolean; releasedPort?: number }> {
    let stopped = false;
    const releasedPort = this.activeProcessPorts.get(containerId) || this.portManager.getPortForJob(containerId);

    if (this.activeProcesses.has(containerId)) {
      const child = this.activeProcesses.get(containerId);
      if (child && child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
          stopped = true;
        } catch {
          try {
            child.kill("SIGTERM");
            stopped = true;
          } catch {}
        }
      }
      this.activeProcesses.delete(containerId);
    } else {
      try {
        const res = await this.executor.execute(`docker stop ${containerId} && docker rm -f ${containerId}`);
        stopped = res.exitCode === 0;
      } catch {}
    }

    if (releasedPort !== undefined) {
      this.portManager.releasePort(releasedPort);
    } else {
      this.portManager.releaseJobPort(containerId);
    }

    this.activeProcessPorts.delete(containerId);
    return { stopped, releasedPort };
  }

  private rememberLaunch(instanceId: string, spec: LaunchSpec): void {
    this.launchSpecs.delete(instanceId);
    this.launchSpecs.set(instanceId, spec);
    while (this.launchSpecs.size > MAX_LAUNCH_SPECS) {
      const oldest = this.launchSpecs.keys().next().value;
      if (oldest === undefined) break;
      this.launchSpecs.delete(oldest);
    }
  }

  /** Kills a native process group and waits (up to `timeoutMs`) for it to exit. */
  private async terminateProcess(child: ChildProcess, timeoutMs = 5000): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const signal = (sig: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {}
      }
    };
    signal("SIGTERM");
    const timer = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs));
    if ((await Promise.race([exited.then(() => "exited" as const), timer])) === "timeout") {
      signal("SIGKILL");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 1000))]);
    }
  }

  /**
   * Stops an instance and starts it again from its launch spec on the same port when that port
   * is still free (otherwise a new one). Works for running and for stopped instances (used by
   * rollback). A native process gets a new `proc_<pid>` id; a Docker container is re-created.
   */
  public async restartContainer(
    containerId: string,
    onLog?: (line: string) => void
  ): Promise<{ restarted: boolean; containerId: string; port?: number; error?: string; exitCode?: number }> {
    const log = (msg: string) => onLog?.(`[pipeline] ${msg}`);
    const spec = this.launchSpecs.get(containerId);
    if (!spec) {
      if (containerId.startsWith("proc_") || !/^[a-zA-Z0-9_.-]+$/.test(containerId)) {
        return { restarted: false, containerId, error: `No launch record for instance ${containerId}` };
      }
      const res = await this.executor.execute(`docker restart ${containerId}`);
      return res.exitCode === 0
        ? { restarted: true, containerId, port: this.activeProcessPorts.get(containerId) }
        : { restarted: false, containerId, error: res.stderr || res.stdout, exitCode: res.exitCode };
    }

    log(`Restarting instance ${containerId} (${spec.kind})`);
    if (spec.kind === "process") {
      const child = this.activeProcesses.get(containerId);
      if (child) await this.terminateProcess(child);
      this.activeProcesses.delete(containerId);
    } else {
      await this.executor.execute(`docker rm -f ${spec.containerName}`).catch(() => null);
    }
    this.activeProcessPorts.delete(containerId);

    // Keep the port when it is still ours or free; otherwise allocate another one.
    let port = spec.port;
    const owner = this.portManager.getAllocations().find((a) => a.port === port);
    if (owner && owner.jobId !== spec.jobId) {
      port = await this.portManager.allocatePort(spec.serviceId, spec.jobId);
    } else if (!owner) {
      this.portManager.reservePortSync(port, spec.serviceId, spec.jobId);
    }

    let newId: string;
    let exitCode: number | null = null;
    const stderrTail: string[] = [];
    if (spec.kind === "process") {
      const spawnEnv = { ...spec.env, PORT: String(port), HTTP_PORT: String(port), SERVER_PORT: String(port) } as NodeJS.ProcessEnv;
      const child: ChildProcess = spawn(spec.runCmd, {
        cwd: spec.cwd || process.cwd(),
        env: spawnEnv,
        shell: true,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      newId = `proc_${child.pid}`;
      this.activeProcesses.set(newId, child);
      this.activeProcesses.set(spec.jobId, child);
      child.stdout?.on("data", (c: Buffer) => splitLines(c).forEach((l) => log(`[app:stdout] ${l}`)));
      child.stderr?.on("data", (c: Buffer) =>
        splitLines(c).forEach((l) => {
          stderrTail.push(l);
          if (stderrTail.length > STARTUP_STDERR_LINES) stderrTail.shift();
          log(`[app:stderr] ${l}`);
        })
      );
      child.on("exit", (code: number | null, signal: string | null) => {
        exitCode = code !== null ? code : signal ? 128 : 1;
        if (this.activeProcesses.get(newId) === child) this.activeProcesses.delete(newId);
        if (this.activeProcesses.get(spec.jobId) === child) this.activeProcesses.delete(spec.jobId);
        this.activeProcessPorts.delete(newId);
      });
    } else {
      const res = await this.executor.execute(spec.runCmd.replace("{{PORT}}", String(port)));
      if (res.exitCode !== 0) {
        this.portManager.releasePort(port);
        return { restarted: false, containerId, error: `docker run failed: ${res.stderr || res.stdout}`, exitCode: res.exitCode };
      }
      newId = res.stdout.trim().split("\n").pop() || spec.containerName!;
    }
    this.activeProcessPorts.set(newId, port);
    this.activeProcessPorts.set(spec.jobId, port);

    const deadline = Date.now() + 10000;
    let healthy = false;
    while (Date.now() < deadline) {
      if (exitCode !== null) break;
      healthy =
        (await this.executor.probeHealth(`http://127.0.0.1:${port}${spec.healthPath}`, 1000)) ||
        (await this.executor.probeHealth(`http://127.0.0.1:${port}/`, 1000));
      if (healthy) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    this.launchSpecs.delete(containerId);
    this.rememberLaunch(newId, { ...spec, port });
    if (!healthy) {
      const detail = stderrTail.join("\n") || (exitCode !== null ? `exited with code ${exitCode}` : "no HTTP response");
      log(`[build:error] Restarted instance ${newId} is not healthy: ${detail}`);
      await this.stopContainer(newId).catch(() => null);
      return { restarted: false, containerId: newId, port, error: `Restarted instance is not healthy: ${detail}`, exitCode: exitCode ?? 1 };
    }
    log(`Instance restarted as ${newId} on port ${port}`);
    return { restarted: true, containerId: newId, port };
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
    let childExitCode: number | null = null;
    let childErrorMsg: string | null = null;
    let childStdioClosed = false;
    const startupStderrLines: string[] = [];

    try {
      // Step 1: Workspace setup
      log(`Setting up build workspace at: ${baseWorkDir}`);
      let sourceDir = baseWorkDir;

      // Step 2: Git checkout if repoUrl provided
      if (options.repoUrl) {
        if (typeof options.repoUrl !== "string" || !options.repoUrl.trim()) {
          throw new Error("Invalid git repoUrl: repository URL must be a non-empty string");
        }
        let trimmedUrl = options.repoUrl.trim();
        // Support GitHub shorthand: "owner/repo" -> "https://github.com/owner/repo.git"
        if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(trimmedUrl)) {
          trimmedUrl = `https://github.com/${trimmedUrl}.git`;
        }

        if (/[\s;`$|&><'"\\]/.test(trimmedUrl) || trimmedUrl.startsWith("-")) {
          throw new Error(`Invalid git repoUrl "${options.repoUrl}": contains disallowed shell characters or flags`);
        }

        let branchFlag = "";
        if (options.branch) {
          const trimmedBranch = options.branch.trim();
          if (!/^[a-zA-Z0-9._/-]+$/.test(trimmedBranch) || trimmedBranch.startsWith("-")) {
            throw new Error(`Invalid git branch "${options.branch}": must match ^[a-zA-Z0-9._/-]+$ and not start with '-'`);
          }
          branchFlag = `-b ${trimmedBranch}`;
        }

        if (options.commitSha) {
          const trimmedSha = options.commitSha.trim();
          if (!/^[a-zA-Z0-9._/-]+$/.test(trimmedSha) || trimmedSha.startsWith("-")) {
            throw new Error(`Invalid commit SHA "${options.commitSha}": contains disallowed shell characters or flags`);
          }
        }

        const gitEnv: NodeJS.ProcessEnv = {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          ...options.environmentVariables,
        };

        // Fast redeploy (cleanBuild false): reuse the existing clone so dependency and build
        // caches survive — fetch the latest refs and force-checkout instead of re-cloning.
        let reusedClone = false;
        if (!options.cleanBuild && (await this.executor.fileExists(path.join(baseWorkDir, ".git")))) {
          log(`Fast redeploy — reusing existing clone at ${baseWorkDir}`);
          const branchRef = branchFlag ? ` "${options.branch!.trim()}"` : "";
          const fetchCmd = `git remote set-url origin "${trimmedUrl}" && git fetch --prune origin${branchRef} && git checkout -f FETCH_HEAD`;
          log(`Updating repository: ${fetchCmd}`);
          const fetchRes = await this.executor.execute(fetchCmd, { cwd: baseWorkDir, env: gitEnv, onLog: log });
          if (fetchRes.exitCode === 0) {
            reusedClone = true;
          } else {
            log(`[git:warn] git fetch failed (exit code ${fetchRes.exitCode}); falling back to a fresh clone`);
          }
        }

        if (!reusedClone) {
          // Clean existing workspace directory before clone to prevent non-empty destination collision
          await fs.rm(baseWorkDir, { recursive: true, force: true }).catch(() => null);
          await fs.mkdir(path.dirname(baseWorkDir), { recursive: true }).catch(() => null);

          const cloneCmd = `git clone ${branchFlag ? branchFlag + " " : ""}-- "${trimmedUrl}" "${baseWorkDir}"`;
          log(`Cloning repository: ${cloneCmd}`);
          const cloneRes = await this.executor.execute(cloneCmd, { env: gitEnv, onLog: log });
          if (cloneRes.exitCode !== 0) {
            const errMsg = cloneRes.stderr || cloneRes.stdout || `Git clone exited with code ${cloneRes.exitCode}`;
            log(`[build:error] ${errMsg}`);
            throw new PipelineStepError(`Git clone failed: ${errMsg}`, cloneRes.exitCode);
          }
        }

        if (options.commitSha) {
          const safeSha = options.commitSha.trim();
          log(`Checking out target commit: ${safeSha}`);
          const checkoutRes = await this.executor.execute(`git checkout "${safeSha}"`, {
            cwd: baseWorkDir,
            onLog: log,
          });
          if (checkoutRes.exitCode !== 0) {
            const errMsg = checkoutRes.stderr || checkoutRes.stdout || `Git checkout exited with code ${checkoutRes.exitCode}`;
            log(`[git:warn] Target commit ${safeSha} not found or checkout failed: ${errMsg}`);
            log(`[git] Proceeding build with latest repository HEAD on ${options.branch || "default"} branch`);
          } else {
            log(`Checked out target commit: ${safeSha}`);
          }
        }
      } else {
        await fs.mkdir(baseWorkDir, { recursive: true }).catch(() => null);
      }

      if (options.rootDir) {
        sourceDir = path.join(baseWorkDir, options.rootDir);
      }

      // If workspace has no starter application files and no repo was provided, provision starter app
      const hasPkg = await this.executor.fileExists(path.join(sourceDir, "package.json"));
      const hasDf = await this.executor.fileExists(path.join(sourceDir, "Dockerfile"));
      const hasIdx = (await this.executor.fileExists(path.join(sourceDir, "index.js"))) || (await this.executor.fileExists(path.join(sourceDir, "server.js")));
      const hasHtml = (await this.executor.fileExists(path.join(sourceDir, "index.html"))) ||
                      (await this.executor.fileExists(path.join(sourceDir, "dist", "index.html"))) ||
                      (await this.executor.fileExists(path.join(sourceDir, "build", "index.html"))) ||
                      (await this.executor.fileExists(path.join(sourceDir, "out", "index.html")));
      if (!hasPkg && !hasDf && !hasIdx && !hasHtml && !options.repoUrl) {
        const starter = `const http = require("http");
const port = parseInt(process.env.PORT || "${targetPort}", 10);
const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", service: "${serviceName}", port }));
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end("<!DOCTYPE html><html><head><title>${serviceName} - Syncbay</title></head><body style='font-family:sans-serif;padding:2rem'><h1>🚀 Syncbay Application (${serviceName})</h1><p>Service is live and serving traffic on port <strong>" + port + "</strong>.</p></body></html>");
});
server.listen(port, "0.0.0.0", () => {
  console.log("Syncbay application [${serviceName}] active on port " + port);
});
`;
        await fs.writeFile(path.join(sourceDir, "server.cjs"), starter, "utf8").catch(() => null);
      }

      // Clean rebuild: purge build artifacts and caches for every strategy (Docker/Nixpacks also get --no-cache)
      if (options.cleanBuild) {
        log(`Clean rebuild requested — purging cached build artifacts and dependencies`);
        for (const rel of CLEAN_BUILD_PURGE_PATHS) {
          const target = path.join(sourceDir, rel);
          const exists = await fs.stat(target).then(() => true, () => false);
          if (!exists) continue;
          await fs.rm(target, { recursive: true, force: true }).catch(() => null);
          log(`Purged ${target}`);
        }
      }

      // Step 3: Determine build strategy (Dockerfile vs Nixpacks vs Native process)
      const dockerfilePath = options.dockerfile
        ? path.join(sourceDir, options.dockerfile)
        : path.join(sourceDir, "Dockerfile");

      const hasDockerfile = await this.executor.fileExists(dockerfilePath);
      const isMockExecutor = !(this.executor instanceof DefaultPipelineExecutor);
      const hasDocker = isMockExecutor || (await this.executor.execute("docker info")).exitCode === 0;
      const hasNixpacks = isMockExecutor || (await this.executor.execute("nixpacks --version")).exitCode === 0;

      if (hasDockerfile && hasDocker) {
        strategy = "dockerfile";
        log(`Dockerfile detected at ${dockerfilePath} — using Docker build strategy`);

        let buildCmd = `docker build -t ${imageTag} -f "${dockerfilePath}" "${sourceDir}"`;
        if (options.cleanBuild) {
          buildCmd += " --no-cache";
        }
        if (options.buildCommand) {
          buildCmd += ` --build-arg BUILD_CMD="${options.buildCommand}"`;
        }

        log(`Compiling container image: ${buildCmd}`);
        const buildRes = await this.executor.execute(buildCmd, { cwd: sourceDir, onLog: log });
        if (buildRes.exitCode !== 0) {
          const errMsg = buildRes.stderr || buildRes.stdout || `Docker build exited with code ${buildRes.exitCode}`;
          log(`[build:error] ${errMsg}`);
          throw new PipelineStepError(withBuildToolHint(`Docker build failed: ${errMsg}`), buildRes.exitCode);
        }
        log(`Docker build succeeded for image ${imageTag}`);

        assignedPort = await this.portManager.allocatePort(options.serviceId, jobId);
        log(`Assigned dynamic host port: ${assignedPort} (target container port: ${targetPort})`);

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
        const runCmd = `docker run -d --name ${containerName} --restart unless-stopped -p ${assignedPort}:${targetPort} ${dockerVolumeFlags(options.volumes)} ${envFlags.join(" ")} ${imageTag}${startCmd}`.trim();

        log(`Launching application container: ${runCmd}`);
        const runRes = await this.executor.execute(runCmd);
        if (runRes.exitCode !== 0) {
          throw new PipelineStepError(`Docker run failed: ${runRes.stderr || runRes.stdout}`, runRes.exitCode);
        }

        containerId = runRes.stdout.trim().split("\n").pop() || containerName;
        this.rememberLaunch(containerId, {
          kind: "docker",
          jobId,
          serviceId: options.serviceId,
          containerName,
          port: assignedPort!,
          runCmd: runCmd.replace(`-p ${assignedPort}:`, "-p {{PORT}}:"),
          healthPath: options.healthCheckPath || "/health",
        });
        this.activeProcessPorts.set(containerId, assignedPort!);
        this.activeProcessPorts.set(jobId, assignedPort!);
        log(`Container launched successfully with ID: ${containerId}`);
      } else if (hasNixpacks && hasDocker) {
        strategy = "nixpacks";
        log(`Using Nixpacks automated runtime detection & Docker containerization`);

        let nixpacksCmd = `nixpacks build "${sourceDir}" --name ${imageTag}`;
        if (options.cleanBuild) {
          nixpacksCmd += " --no-cache";
        }
        if (options.buildCommand) {
          nixpacksCmd += ` --build-cmd "${options.buildCommand}"`;
        }
        if (options.startCommand) {
          nixpacksCmd += ` --start-cmd "${options.startCommand}"`;
        }

        log(`Compiling container image via Nixpacks: ${nixpacksCmd}`);
        const nixRes = await this.executor.execute(nixpacksCmd, { cwd: sourceDir, onLog: log });
        if (nixRes.exitCode !== 0) {
          const errMsg = nixRes.stderr || nixRes.stdout || `Nixpacks build exited with code ${nixRes.exitCode}`;
          log(`[build:error] ${errMsg}`);
          throw new PipelineStepError(withBuildToolHint(`Nixpacks build failed: ${errMsg}`), nixRes.exitCode);
        }
        log(`Nixpacks compilation succeeded for image ${imageTag}`);

        assignedPort = await this.portManager.allocatePort(options.serviceId, jobId);
        log(`Assigned dynamic host port: ${assignedPort} (target container port: ${targetPort})`);

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
        const runCmd = `docker run -d --name ${containerName} --restart unless-stopped -p ${assignedPort}:${targetPort} ${dockerVolumeFlags(options.volumes)} ${envFlags.join(" ")} ${imageTag}${startCmd}`.trim();

        log(`Launching application container: ${runCmd}`);
        const runRes = await this.executor.execute(runCmd);
        if (runRes.exitCode !== 0) {
          throw new PipelineStepError(`Docker run failed: ${runRes.stderr || runRes.stdout}`, runRes.exitCode);
        }

        containerId = runRes.stdout.trim().split("\n").pop() || containerName;
        this.rememberLaunch(containerId, {
          kind: "docker",
          jobId,
          serviceId: options.serviceId,
          containerName,
          port: assignedPort!,
          runCmd: runCmd.replace(`-p ${assignedPort}:`, "-p {{PORT}}:"),
          healthPath: options.healthCheckPath || "/health",
        });
        this.activeProcessPorts.set(containerId, assignedPort!);
        this.activeProcessPorts.set(jobId, assignedPort!);
        log(`Container launched successfully with ID: ${containerId}`);
      } else {
        // Containerless native process execution mode (Termux / Linux host without Docker daemon)
        strategy = "nixpacks";
        log(`Native process execution strategy activated for ${serviceName}`);

        const pkgPath = path.join(sourceDir, "package.json");
        const packageJsonExists = await this.executor.fileExists(pkgPath);

        // Prepend node_modules/.bin to PATH so that locally-installed binaries
        // (next, vite, tsc, etc.) are discoverable when running build/start commands
        const nmBin = path.join(sourceDir, "node_modules", ".bin");
        const currentPath = process.env.PATH || "/usr/bin:/bin";
        const execEnv: NodeJS.ProcessEnv = {
          ...process.env,
          ...options.environmentVariables,
          NODE_ENV: (options.environmentVariables?.NODE_ENV as any) || "production",
          PATH: `${nmBin}:${currentPath}`,
        };

        if (packageJsonExists) {
          // Install dependencies first if not already present
          const hasNodeModules = await this.executor.fileExists(path.join(sourceDir, "node_modules"));
          if (!hasNodeModules) {
            let installCmd = "npm install --no-audit --prefer-offline --include=dev";
            if (await this.executor.fileExists(path.join(sourceDir, "pnpm-lock.yaml"))) {
              installCmd = "pnpm install --prefer-offline || npm install --no-audit --prefer-offline --include=dev";
            } else if (await this.executor.fileExists(path.join(sourceDir, "yarn.lock"))) {
              installCmd = "yarn install --prefer-offline || npm install --no-audit --prefer-offline --include=dev";
            }
            log(`Installing dependencies via: ${installCmd}`);
            const iRes = await this.executor.execute(installCmd, { cwd: sourceDir, env: execEnv, onLog: log });
            if (iRes.exitCode !== 0) {
              const errMsg = iRes.stderr || iRes.stdout || `Exit code ${iRes.exitCode}`;
              log(`[build:error] Dependency installation failed: ${errMsg}`);
              if (!options.buildCommand) {
                try {
                  const pkgContent = JSON.parse(await fs.readFile(pkgPath, "utf8"));
                  if (pkgContent.scripts?.build) {
                    throw new PipelineStepError(`Dependency installation failed: ${errMsg}`, iRes.exitCode);
                  }
                } catch (e: any) {
                  if (e.message?.includes("Dependency installation failed")) throw e;
                }
              }
            }
          }

          if (options.buildCommand) {
            log(`Compiling application with custom build command: ${options.buildCommand}`);
            const bRes = await this.executor.execute(options.buildCommand, { cwd: sourceDir, env: execEnv, onLog: log });
            if (bRes.exitCode !== 0) {
              const errMsg = bRes.stderr || bRes.stdout || `Build command exited with code ${bRes.exitCode}`;
              log(`[build:error] ${errMsg}`);
              throw new PipelineStepError(`Build command failed: ${errMsg}`, bRes.exitCode);
            }
          } else {
            try {
              const pkgContent = JSON.parse(await fs.readFile(pkgPath, "utf8"));
              if (pkgContent.scripts?.build) {
                log(`Running npm run build...`);
                const bRes = await this.executor.execute("npm run build", { cwd: sourceDir, env: execEnv, onLog: log });
                if (bRes.exitCode !== 0) {
                  const errMsg = bRes.stderr || bRes.stdout || `npm run build exited with code ${bRes.exitCode}`;
                  log(`[build:error] ${errMsg}`);
                  throw new PipelineStepError(`npm run build failed: ${errMsg}`, bRes.exitCode);
                }
              }
            } catch (err: any) {
              if (err.message?.includes("npm run build failed")) throw err;
            }
          }
        } else if (options.buildCommand) {
          log(`Compiling application with custom build command: ${options.buildCommand}`);
          const bRes = await this.executor.execute(options.buildCommand, { cwd: sourceDir, env: execEnv, onLog: log });
          if (bRes.exitCode !== 0) {
            const errMsg = bRes.stderr || bRes.stdout || `Build command exited with code ${bRes.exitCode}`;
            log(`[build:error] ${errMsg}`);
            throw new PipelineStepError(`Build command failed: ${errMsg}`, bRes.exitCode);
          }
        }

        assignedPort = await this.portManager.allocatePort(options.serviceId, jobId);
        log(`Assigned dynamic host port: ${assignedPort} (target container port: ${targetPort})`);

        let runCmd = options.startCommand;
        if (!runCmd && packageJsonExists) {
          try {
            const pkgContent = JSON.parse(await fs.readFile(pkgPath, "utf8"));
            if (pkgContent.scripts?.start) {
              runCmd = "npm start";
            } else if (pkgContent.main && (await this.executor.fileExists(path.join(sourceDir, pkgContent.main)))) {
              runCmd = `node "${pkgContent.main}"`;
            }
          } catch {}
        }

        if (!runCmd) {
          const candidateFiles = [
            path.join(".next", "standalone", "server.js"),
            "server.js",
            "server.cjs",
            "server.mjs",
            "index.js",
            "index.cjs",
            "index.mjs",
            "app.js",
            "main.js",
            path.join("src", "server.js"),
            path.join("src", "index.js"),
            path.join("src", "app.js"),
            path.join("dist", "server.js"),
            path.join("dist", "index.js"),
            path.join("build", "server.js"),
            path.join("build", "index.js"),
          ];

          for (const cand of candidateFiles) {
            if (await this.executor.fileExists(path.join(sourceDir, cand))) {
              runCmd = `node "${cand}"`;
              break;
            }
          }
        }

        if (!runCmd) {
          const pyCandidates = ["app.py", "main.py", "server.py", "wsgi.py"];
          for (const py of pyCandidates) {
            if (await this.executor.fileExists(path.join(sourceDir, py))) {
              runCmd = `python3 "${py}"`;
              break;
            }
          }
        }

        if (!runCmd) {
          // Static web site / compiled frontend detection (compiled bundles in dist/build/out MUST take priority over raw uncompiled source)
          const staticDirs = [
            path.join(sourceDir, "dist"),
            path.join(sourceDir, "build"),
            path.join(sourceDir, "out"),
            path.join(sourceDir, "public"),
            sourceDir,
          ];
          for (const sDir of staticDirs) {
            if (await this.executor.fileExists(path.join(sDir, "index.html"))) {
              const staticServerFile = path.join(baseWorkDir, "_syncbay_static_server.cjs");
              const staticServerCode = `const http = require("http");
const fs = require("fs");
const path = require("path");
const root = process.argv[2] || process.cwd();
const port = parseInt(process.env.PORT || "3000", 10);
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".cjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json"
};
const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", port }));
  }
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  let safePath = path.normalize(path.join(root, urlPath));
  if (fs.existsSync(safePath) && fs.statSync(safePath).isDirectory()) {
    safePath = path.join(safePath, "index.html");
  }
  if (!fs.existsSync(safePath)) {
    const fallback = path.join(root, "index.html");
    if (fs.existsSync(fallback)) safePath = fallback;
    else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not Found");
    }
  }
  const ext = path.extname(safePath).toLowerCase();
  res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
  fs.createReadStream(safePath).pipe(res);
});
server.listen(port, "0.0.0.0", () => {
  console.log("Static server running on port " + port);
});
`;
              await fs.writeFile(staticServerFile, staticServerCode, "utf8").catch(() => null);
              runCmd = `node "${staticServerFile}" "${sDir}"`;
              break;
            }
          }
        }

        if (!runCmd) {
          if (await this.executor.fileExists(path.join(sourceDir, "server.js"))) {
            runCmd = "node server.js";
          } else {
            // Provision fallback starter app
            const starter = `const http = require("http");
const port = parseInt(process.env.PORT || "${assignedPort}", 10);
const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", service: "${serviceName}", port }));
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end("<!DOCTYPE html><html><body style='font-family:sans-serif;padding:2rem'><h1>🚀 Syncbay Application (${serviceName})</h1><p>Service active on port " + port + "</p></body></html>");
});
server.listen(port, "0.0.0.0");
`;
            await fs.writeFile(path.join(sourceDir, "server.cjs"), starter, "utf8").catch(() => null);
            runCmd = "node server.cjs";
          }
        }

        log(`Launching application process: ${runCmd} with PORT=${assignedPort}`);
        const nativeVolumes = prepareNativeVolumes(options.volumes, sourceDir);
        for (const m of nativeVolumes.mounts) log(`Volume ${m.id} bound at ${m.hostPath} (mountPath ${m.mountPath})`);
        const childEnv: NodeJS.ProcessEnv = {
          ...process.env,
          ...options.environmentVariables,
          ...nativeVolumes.env,
          PATH: `${nmBin}:${currentPath}`,
          PORT: String(assignedPort),
          HTTP_PORT: String(assignedPort),
          SERVER_PORT: String(assignedPort),
          HOST: "0.0.0.0",
          NODE_ENV: "production",
        };

        const child = spawn(runCmd, {
          cwd: sourceDir,
          env: childEnv,
          shell: true,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        const activeContainerId = `proc_${child.pid}`;
        containerId = activeContainerId;
        this.activeProcesses.set(activeContainerId, child);
        this.activeProcesses.set(jobId, child);
        this.activeProcessPorts.set(activeContainerId, assignedPort!);
        this.activeProcessPorts.set(jobId, assignedPort!);

        childExitCode = null;
        childErrorMsg = null;
        childStdioClosed = false;
        startupStderrLines.length = 0;

        child.on("error", (err: any) => {
          childErrorMsg = err?.message || String(err);
          log(`[app:error] Failed to launch process: ${childErrorMsg}`);
        });

        child.stdout?.on("data", (chunk: Buffer) => {
          for (const line of splitLines(chunk)) log(`[app:stdout] ${line}`);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          for (const line of splitLines(chunk)) {
            startupStderrLines.push(line);
            if (startupStderrLines.length > STARTUP_STDERR_LINES) startupStderrLines.shift();
            log(`[app:stderr] ${line}`);
          }
        });
        child.on("close", () => {
          childStdioClosed = true;
        });
        child.on("exit", (code: number | null, signal: string | null) => {
          childExitCode = code !== null ? code : (signal ? 128 : 1);
          log(`[app] Process ${activeContainerId} exited with code ${code ?? signal}`);
          this.activeProcesses.delete(activeContainerId);
          this.activeProcesses.delete(jobId);
          this.activeProcessPorts.delete(activeContainerId);
          this.activeProcessPorts.delete(jobId);
        });

        this.rememberLaunch(activeContainerId, {
          kind: "process",
          jobId,
          serviceId: options.serviceId,
          port: assignedPort!,
          runCmd,
          cwd: sourceDir,
          env: childEnv,
          healthPath: options.healthCheckPath || "/health",
        });
        log(`Application process launched with PID ${child.pid} (Instance: ${containerId})`);
      }

      // Step 6: Health Probe Verification
      const probePath = options.healthCheckPath || "/health";
      const probeUrl = `http://127.0.0.1:${assignedPort}${probePath}`;
      const timeoutMs = options.healthCheckTimeoutMs ?? 10000;
      const intervalMs = options.healthCheckIntervalMs ?? 300;
      const deadline = Date.now() + timeoutMs;

      log(`Probing health endpoint at ${probeUrl} (timeout: ${timeoutMs}ms)`);
      let isHealthy = false;

      while (Date.now() < deadline) {
        // If native child process died, fail fast without waiting for probe timeout
        if (containerId?.startsWith("proc_") && !this.activeProcesses.has(containerId)) {
          // 'exit' can fire before the last stderr chunk is read; wait briefly for stdio to drain.
          for (let i = 0; i < 10 && !childStdioClosed; i++) {
            await new Promise((r) => setTimeout(r, 50));
          }
          const exitCode = childExitCode ?? 1;
          const detail = childErrorMsg || (startupStderrLines.length > 0 ? startupStderrLines.join("\n") : `Process exited with code ${exitCode}`);
          log(`[build:error] Application crashed during startup (exit code ${exitCode}): ${detail}`);
          throw new PipelineStepError(`Application process terminated prematurely during startup (exit code ${exitCode}): ${detail}`, exitCode);
        }

        isHealthy = await this.executor.probeHealth(probeUrl, 1000);
        if (isHealthy) {
          log(`Health check passed on ${probeUrl} — application is healthy and responding`);
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

        // If app bound to options.targetPort instead of dynamic port, detect it
        // (never when that port belongs to another instance, e.g. the previous deployment)
        if (options.targetPort && options.targetPort !== assignedPort && !this.portManager.isPortAllocated(options.targetPort)) {
          const altProbeUrl = `http://127.0.0.1:${options.targetPort}${probePath}`;
          if (await this.executor.probeHealth(altProbeUrl, 500)) {
            isHealthy = true;
            log(`Detected application responding directly on target port ${options.targetPort}`);
            assignedPort = options.targetPort;
            break;
          }
        }

        await new Promise((r) => setTimeout(r, intervalMs));
      }

      if (!isHealthy) {
        const detail = childErrorMsg || (startupStderrLines.length > 0 ? startupStderrLines.join("\n") : "");
        const errMsg = detail
          ? `Health check failed on port ${assignedPort}: ${detail}`
          : `Health check failed: application did not respond to HTTP probes on port ${assignedPort} within ${timeoutMs}ms`;
        log(`[build:error] ${errMsg}`);
        throw new Error(errMsg);
      }

      const durationMs = Date.now() - startTime;
      log(`Pipeline execution finished successfully in ${(durationMs / 1000).toFixed(2)}s`);

      // Simulated means "no real process was started" — decided by the executor, not by the host env.
      const isSimulated = !(this.executor instanceof DefaultPipelineExecutor);

      return {
        success: true,
        jobId,
        strategy,
        containerId,
        assignedPort,
        imageTag,
        logs,
        durationMs,
        exitCode: 0,
        simulated: isSimulated,
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const errMsg = err.message || String(err);
      const exitCode = err instanceof PipelineStepError ? err.exitCode : (childExitCode ?? 1);
      log(`Pipeline failed (exit code ${exitCode}): ${errMsg}`);

      // Cleanup allocated port on failure
      if (assignedPort !== undefined) {
        this.portManager.releasePort(assignedPort);
      }

      // Cleanup failed container if running
      if (containerId) {
        await this.stopContainer(containerId).catch(() => null);
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
        exitCode,
      };
    }
  }
}


