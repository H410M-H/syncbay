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

import { exec, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
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
  private activeProcesses: Map<string, ChildProcess> = new Map();
  private activeProcessPorts: Map<string, number> = new Map();

  constructor(options: { executor?: PipelineExecutor; portManager?: PortManager } = {}) {
    this.executor = options.executor || new DefaultPipelineExecutor();
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

        // Clean existing workspace directory before clone to prevent non-empty destination collision
        await fs.rm(baseWorkDir, { recursive: true, force: true }).catch(() => null);
        await fs.mkdir(path.dirname(baseWorkDir), { recursive: true }).catch(() => null);

        const cloneCmd = `git clone --depth 1 ${branchFlag ? branchFlag + " " : ""}-- "${trimmedUrl}" "${baseWorkDir}"`;
        log(`Cloning repository: ${cloneCmd}`);
        const cloneRes = await this.executor.execute(cloneCmd, {
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            ...options.environmentVariables,
          },
        });
        if (cloneRes.exitCode !== 0) {
          throw new Error(`Git clone failed: ${cloneRes.stderr || cloneRes.stdout}`);
        }

        if (options.commitSha) {
          const safeSha = options.commitSha.trim();
          log(`Checking out target commit: ${safeSha}`);
          await this.executor.execute(`git checkout -- "${safeSha}"`, { cwd: baseWorkDir });
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
      if (!hasPkg && !hasDf && !hasIdx && !options.repoUrl) {
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
        await fs.writeFile(path.join(sourceDir, "server.js"), starter, "utf8").catch(() => null);
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
        if (options.buildCommand) {
          buildCmd += ` --build-arg BUILD_CMD="${options.buildCommand}"`;
        }

        log(`Compiling container image: ${buildCmd}`);
        const buildRes = await this.executor.execute(buildCmd, { cwd: sourceDir });
        if (buildRes.exitCode !== 0) {
          throw new Error(`Docker build failed: ${buildRes.stderr || buildRes.stdout}`);
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
        const runCmd = `docker run -d --name ${containerName} --restart unless-stopped -p ${assignedPort}:${targetPort} ${envFlags.join(" ")} ${imageTag}${startCmd}`.trim();

        log(`Launching application container: ${runCmd}`);
        const runRes = await this.executor.execute(runCmd);
        if (runRes.exitCode !== 0) {
          throw new Error(`Docker run failed: ${runRes.stderr || runRes.stdout}`);
        }

        containerId = runRes.stdout.trim().split("\n").pop() || containerName;
        this.activeProcessPorts.set(containerId, assignedPort);
        this.activeProcessPorts.set(jobId, assignedPort);
        log(`Container launched successfully with ID: ${containerId}`);
      } else if (hasNixpacks && hasDocker) {
        strategy = "nixpacks";
        log(`Using Nixpacks automated runtime detection & Docker containerization`);

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
        const runCmd = `docker run -d --name ${containerName} --restart unless-stopped -p ${assignedPort}:${targetPort} ${envFlags.join(" ")} ${imageTag}${startCmd}`.trim();

        log(`Launching application container: ${runCmd}`);
        const runRes = await this.executor.execute(runCmd);
        if (runRes.exitCode !== 0) {
          throw new Error(`Docker run failed: ${runRes.stderr || runRes.stdout}`);
        }

        containerId = runRes.stdout.trim().split("\n").pop() || containerName;
        this.activeProcessPorts.set(containerId, assignedPort);
        this.activeProcessPorts.set(jobId, assignedPort);
        log(`Container launched successfully with ID: ${containerId}`);
      } else {
        // Containerless native process execution mode (Termux / Linux host without Docker daemon)
        strategy = "nixpacks";
        log(`Native process execution strategy activated for ${serviceName}`);

        const pkgPath = path.join(sourceDir, "package.json");
        const packageJsonExists = await this.executor.fileExists(pkgPath);

        const execEnv = { ...process.env, ...options.environmentVariables };

        if (packageJsonExists) {
          // Install dependencies first if not already present
          const hasNodeModules = await this.executor.fileExists(path.join(sourceDir, "node_modules"));
          if (!hasNodeModules) {
            let installCmd = "npm install --no-audit --prefer-offline";
            if (await this.executor.fileExists(path.join(sourceDir, "pnpm-lock.yaml"))) {
              installCmd = "pnpm install --prefer-offline || npm install --no-audit --prefer-offline";
            } else if (await this.executor.fileExists(path.join(sourceDir, "yarn.lock"))) {
              installCmd = "yarn install --prefer-offline || npm install --no-audit --prefer-offline";
            }
            log(`Installing dependencies via: ${installCmd}`);
            const iRes = await this.executor.execute(installCmd, { cwd: sourceDir, env: execEnv });
            if (iRes.exitCode !== 0) {
              log(`Notice: Dependency installation returned exit code ${iRes.exitCode}: ${iRes.stderr || iRes.stdout}`);
            }
          }

          if (options.buildCommand) {
            log(`Compiling application with custom build command: ${options.buildCommand}`);
            const bRes = await this.executor.execute(options.buildCommand, { cwd: sourceDir, env: execEnv });
            if (bRes.exitCode !== 0) {
              throw new Error(`Build command failed: ${bRes.stderr || bRes.stdout}`);
            }
          } else {
            try {
              const pkgContent = JSON.parse(await fs.readFile(pkgPath, "utf8"));
              if (pkgContent.scripts?.build) {
                log(`Running npm run build...`);
                const bRes = await this.executor.execute("npm run build", { cwd: sourceDir, env: execEnv });
                if (bRes.exitCode !== 0) {
                  throw new Error(`npm run build failed: ${bRes.stderr || bRes.stdout}`);
                }
              }
            } catch (err: any) {
              if (err.message?.includes("npm run build failed")) throw err;
            }
          }
        } else if (options.buildCommand) {
          log(`Compiling application with custom build command: ${options.buildCommand}`);
          const bRes = await this.executor.execute(options.buildCommand, { cwd: sourceDir, env: execEnv });
          if (bRes.exitCode !== 0) {
            throw new Error(`Build command failed: ${bRes.stderr || bRes.stdout}`);
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
            "server.js",
            "index.js",
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
          // Static web site detection
          const staticDirs = [
            sourceDir,
            path.join(sourceDir, "dist"),
            path.join(sourceDir, "build"),
            path.join(sourceDir, "out"),
            path.join(sourceDir, "public"),
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
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain"
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
            await fs.writeFile(path.join(sourceDir, "server.js"), starter, "utf8").catch(() => null);
            runCmd = "node server.js";
          }
        }

        log(`Launching application process: ${runCmd} with PORT=${assignedPort}`);
        const childEnv: NodeJS.ProcessEnv = {
          ...process.env,
          ...options.environmentVariables,
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
        this.activeProcessPorts.set(activeContainerId, assignedPort);
        this.activeProcessPorts.set(jobId, assignedPort);

        let childExitCode: number | null = null;
        let childErrorMsg: string | null = null;

        child.on("error", (err: any) => {
          childErrorMsg = err?.message || String(err);
          log(`[app:error] Failed to launch process: ${childErrorMsg}`);
        });

        child.stdout?.on("data", (chunk: Buffer) => {
          const line = chunk.toString().trim();
          if (line) log(`[app:stdout] ${line}`);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          const line = chunk.toString().trim();
          if (line) log(`[app:stderr] ${line}`);
        });
        child.on("exit", (code: number | null, signal: string | null) => {
          childExitCode = code !== null ? code : (signal ? 128 : 1);
          log(`[app] Process ${activeContainerId} exited with code ${code ?? signal}`);
          this.activeProcesses.delete(activeContainerId);
          this.activeProcesses.delete(jobId);
          this.activeProcessPorts.delete(activeContainerId);
          this.activeProcessPorts.delete(jobId);
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
          throw new Error(`Application process terminated prematurely during startup`);
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
        if (options.targetPort && options.targetPort !== assignedPort) {
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
        throw new Error(
          `Health check failed: application did not respond to HTTP probes on port ${assignedPort} within ${timeoutMs}ms`
        );
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
      };
    }
  }
}

export const defaultPipeline = new BuildPipeline();

export async function executeBuildPipeline(options: PipelineOptions): Promise<PipelineResult> {
  return defaultPipeline.execute(options);
}
