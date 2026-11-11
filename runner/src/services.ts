/**
 * Syncbay Runner Agent — Managed Databases & Web Terminal Sessions
 *
 * HMAC-protected routes mounted by RunnerDaemon.handleRequest:
 *   POST   /api/databases                 provision postgres:16-alpine | redis:7-alpine | mysql:8 (Docker),
 *                                         or a native Postgres/Redis server (see native-db.ts)
 *   DELETE /api/databases/:id             remove container + named volume (or stop + rm data dir), release port
 *   GET    /api/databases/:id/health      pg_isready / redis-cli ping / mysqladmin ping
 *   POST   /api/terminals                 spawn `docker exec -i <container> sh` or `sh` in the job workspace
 *   POST   /api/terminals/:id/input       write to the session's stdin
 *   GET    /api/terminals/:id/stream      SSE output stream
 *   DELETE /api/terminals/:id             kill the session
 *
 * Signing: canonical `${ts}.${nonce}.${METHOD}.${path}.${payload}` (see signRequest in
 * runner-driver.ts and runner/src/request-auth.ts); POST payload is the raw body, GET/DELETE
 * payload is the request pathname. The daemon's verifier consumes the `X-Syncbay-Nonce`, so
 * every signed request is single-use.
 * Database mode (RUNNER_DB_MODE, default auto): Docker when `docker info` works,
 * otherwise native processes when initdb/pg_ctl or redis-server exist on the host,
 * otherwise (or RUNNER_DRIVER=mock) a simulated record whose health is always healthy.
 * MySQL needs Docker.
 */

import type * as http from "node:http";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { PortManager, defaultPortManager } from "./port-manager.ts";
import { NativeDatabaseManager } from "./native-db.ts";
import { parsePortRange, rewriteDatabaseUrls, type DatabaseTarget } from "./db-network.ts";

export type SignatureVerifier = (
  payload: string,
  signature: string | undefined,
  timestamp: string | undefined
) => boolean;

export interface RunnerServicesOptions {
  portManager?: PortManager;
  /** "auto" probes `docker info`, then native binaries; "native" forces native processes; "mock" forces simulation. */
  mode?: "auto" | "docker" | "native" | "mock";
  /** Native database manager (state dir override in tests). */
  native?: NativeDatabaseManager;
  /** Hostname written into connection URLs (the runner's address for external clients). */
  dbHost?: string;
  /** Allocator for database host ports; defaults to `RUNNER_DB_PORT_RANGE`, else the shared app range. */
  dbPortManager?: PortManager;
  terminalIdleMs?: number;
  workspaceRoot?: string;
}

type ManagedDbProvider = "POSTGRES" | "REDIS" | "MYSQL";
type DbBackend = "docker" | "native" | "mock";

interface ManagedDbRecord {
  id: string;
  provider: ManagedDbProvider;
  containerName: string;
  containerId: string;
  host: string;
  port: number;
  connectionUrl: string;
  backend: DbBackend;
  createdAt: string;
}

interface TerminalSession {
  id: string;
  proc: ChildProcess;
  pty: boolean;
  buffer: string;
  clients: Set<http.ServerResponse>;
  idleTimer: NodeJS.Timeout | null;
  exited: boolean;
  exitCode: number | null;
}

/** util-linux `script` allocates a pty so interactive shells behave (prompts, echo, job control). */
const PTY_WRAPPER = process.env.RUNNER_PTY_WRAPPER || "script";
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const MAX_BUFFER = 64 * 1024;

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv, timeoutMs = 60000): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env: env || process.env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
      resolve({ code, stdout: String(stdout || ""), stderr: String(stderr || (err && !stderr ? err.message : "")) });
    });
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function parseJson(body: string): Record<string, any> | null {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export class RunnerServices {
  private readonly portManager: PortManager;
  private readonly mode: "auto" | "docker" | "native" | "mock";
  private readonly native: NativeDatabaseManager;
  private readonly dbHost: string;
  /** Database ports come from their own range when one is configured, so only it needs opening in a firewall. */
  private readonly dbPortManager: PortManager;
  private bridgeGateway: Promise<string | null> | null = null;
  private recovery: Promise<void> | null = null;
  private readonly terminalIdleMs: number;
  private readonly workspaceRoot: string;
  private readonly databases = new Map<string, ManagedDbRecord>();
  private readonly terminals = new Map<string, TerminalSession>();
  private dockerProbe: Promise<boolean> | null = null;
  private scriptProbe: Promise<boolean> | null = null;

  constructor(options: RunnerServicesOptions = {}) {
    this.portManager = options.portManager || defaultPortManager;
    const envMode = process.env.RUNNER_DB_MODE as RunnerServicesOptions["mode"] | undefined;
    this.mode = options.mode || (process.env.RUNNER_DRIVER === "mock" ? "mock" : envMode && ["auto", "docker", "native", "mock"].includes(envMode) ? envMode : "auto");
    this.native = options.native || new NativeDatabaseManager();
    this.dbHost = options.dbHost || process.env.RUNNER_DB_HOST || "127.0.0.1";
    const dbRange = parsePortRange(process.env.RUNNER_DB_PORT_RANGE);
    this.dbPortManager = options.dbPortManager || (dbRange ? new PortManager({ rangeStart: dbRange.start, rangeEnd: dbRange.end }) : this.portManager);
    this.terminalIdleMs = options.terminalIdleMs ?? 10 * 60 * 1000;
    this.workspaceRoot = options.workspaceRoot || path.join(process.cwd(), ".runner_workspace");
  }

  /** Returns true when the request was handled by this module. */
  public async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    body: string,
    verify: SignatureVerifier
  ): Promise<boolean> {
    const method = (req.method || "GET").toUpperCase();
    const isDb = pathname === "/api/databases" || pathname.startsWith("/api/databases/");
    const isTerm = pathname === "/api/terminals" || pathname.startsWith("/api/terminals/");
    if (!isDb && !isTerm) return false;

    const signature = req.headers["x-syncbay-signature"] as string | undefined;
    const timestamp = req.headers["x-syncbay-timestamp"] as string | undefined;
    const signedPayload = method === "POST" ? body : pathname;
    if (!verify(signedPayload, signature, timestamp)) {
      sendJson(res, 401, { error: "Unauthorized: Invalid or missing HMAC signature" });
      return true;
    }

    const segments = pathname.split("/").filter(Boolean).slice(2).map(decodeURIComponent);
    const [id, action] = segments;

    try {
      if (isDb) {
        await this.recoverDockerDatabases();
        if (method === "POST" && segments.length === 0) return await this.createDatabase(res, body), true;
        if (method === "DELETE" && segments.length === 1) return await this.deleteDatabase(res, id), true;
        if (method === "GET" && segments.length === 2 && action === "health") return await this.databaseHealth(res, id), true;
      } else {
        if (method === "POST" && segments.length === 0) return await this.createTerminal(res, body), true;
        if (method === "POST" && action === "input") return this.terminalInput(res, id, body), true;
        if (method === "GET" && action === "stream") return this.streamTerminal(req, res, id), true;
        if (method === "DELETE" && segments.length === 1) return this.closeTerminal(res, id), true;
      }
    } catch (err: any) {
      sendJson(res, 500, { error: err?.message || "Internal runner error" });
      return true;
    }

    sendJson(res, 404, { error: "Route not found", path: pathname });
    return true;
  }

  public shutdown(): void {
    for (const session of this.terminals.values()) {
      this.killTerminal(session);
    }
    this.terminals.clear();
  }

  // ─── Capability probes ─────────────────────────────────────────────────────

  private useDocker(): Promise<boolean> {
    if (this.mode === "mock" || this.mode === "native") return Promise.resolve(false);
    if (this.mode === "docker") return Promise.resolve(true);
    if (!this.dockerProbe) {
      this.dockerProbe = run("docker", ["info", "--format", "{{.ServerVersion}}"], undefined, 5000).then((r) => r.code === 0);
    }
    return this.dockerProbe;
  }

  private hasScript(): Promise<boolean> {
    if (!this.scriptProbe) {
      this.scriptProbe = run(PTY_WRAPPER, ["--version"], undefined, 3000).then((r) => r.code === 0);
    }
    return this.scriptProbe;
  }

  // ─── Managed databases ────────────────────────────────────────────────────

  /** Backend for a new database of this provider. */
  private async backendFor(provider: ManagedDbProvider): Promise<DbBackend | null> {
    if (this.mode === "mock") return "mock";
    if (await this.useDocker()) return "docker";
    if (provider === "MYSQL") return null;
    if (this.mode === "native" || this.mode === "auto") {
      if (this.native.availableProviders().includes(provider)) return "native";
      return this.mode === "native" ? null : "mock";
    }
    return null;
  }

  /** Gateway address of Docker's default bridge: where a container reaches ports published on this host. */
  private dockerBridgeGateway(): Promise<string | null> {
    if (!this.bridgeGateway) {
      this.bridgeGateway = run("docker", ["network", "inspect", "bridge", "-f", "{{(index .IPAM.Config 0).Gateway}}"], undefined, 5000).then((r) => {
        const ip = r.stdout.trim();
        return r.code === 0 && /^[0-9a-f.:]+$/i.test(ip) ? ip : null;
      });
    }
    return this.bridgeGateway;
  }

  /**
   * Rebuilds the registry of Docker databases after a daemon restart: the containers (labelled
   * `syncbay.managed-db`) keep running, and their port and password are read back from Docker.
   */
  private recoverDockerDatabases(): Promise<void> {
    if (!this.recovery) {
      this.recovery = (async () => {
        if (!(await this.useDocker())) return;
        const list = await run("docker", ["ps", "-a", "--filter", "label=syncbay.managed-db", "--format", "{{.Names}}"], undefined, 10000);
        if (list.code !== 0) return;
        for (const name of list.stdout.split("\n").map((n) => n.trim()).filter(Boolean)) {
          const inspect = await run("docker", ["inspect", name], undefined, 10000);
          if (inspect.code !== 0) continue;
          try {
            const info = JSON.parse(inspect.stdout)[0];
            const id = String(info.Config?.Labels?.["syncbay.managed-db"] || "").toLowerCase();
            if (!id || this.databases.has(id)) continue;
            const image = String(info.Config?.Image || "");
            const provider: ManagedDbProvider = image.includes("redis") ? "REDIS" : image.includes("mysql") ? "MYSQL" : "POSTGRES";
            const bindings = Object.values(info.HostConfig?.PortBindings || {}) as Array<Array<{ HostPort?: string }> | null>;
            const port = Number(bindings[0]?.[0]?.HostPort);
            const envList: string[] = info.Config?.Env || [];
            const passwordKey = provider === "POSTGRES" ? "POSTGRES_PASSWORD" : provider === "MYSQL" ? "MYSQL_ROOT_PASSWORD" : "REDIS_PASSWORD";
            const password = envList.find((e) => e.startsWith(`${passwordKey}=`))?.slice(passwordKey.length + 1);
            if (!Number.isInteger(port) || port <= 0 || !password) continue;
            const encoded = encodeURIComponent(password);
            const host = this.dbHost;
            this.databases.set(id, {
              id,
              provider,
              containerName: name,
              containerId: String(info.Id || name).slice(0, 12),
              host,
              port,
              connectionUrl:
                provider === "POSTGRES"
                  ? `postgresql://postgres:${encoded}@${host}:${port}/main`
                  : provider === "MYSQL"
                  ? `mysql://root:${encoded}@${host}:${port}/main`
                  : `redis://default:${encoded}@${host}:${port}`,
              backend: "docker",
              createdAt: String(info.Created || new Date().toISOString()),
            });
            try {
              this.dbPortManager.reservePortSync(port, `db:${id}`);
            } catch {
              // Outside the configured range or already reserved: the socket check still protects it.
            }
          } catch {
            // Unreadable inspect output: leave this container to the name-based health/delete paths.
          }
        }
      })();
    }
    return this.recovery;
  }

  /**
   * Points database URLs in a service's environment at the address the database answers on from
   * this host. `runtime` says whether the app will run in a Docker container or as a host process.
   */
  public async rewriteEnv(env: Record<string, string>, runtime: "docker" | "process"): Promise<{ env: Record<string, string>; notes: string[] }> {
    await this.recoverDockerDatabases().catch(() => null);
    const records = [...this.databases.values()].filter((r) => r.backend !== "mock");
    if (records.length === 0) return { env, notes: [] };
    const override = process.env.RUNNER_DB_INTERNAL_HOST?.trim();
    const gateway = runtime === "docker" ? await this.dockerBridgeGateway() : null;
    const internalHost = override || (runtime === "docker" ? gateway : "127.0.0.1");
    if (!internalHost) return { env, notes: [] };
    // An older daemon (or a changed RUNNER_DB_HOST) may have issued URLs with another host.
    const publicHosts = new Set([this.dbHost, ...records.map((r) => r.host)]);
    const targets: DatabaseTarget[] = [];
    for (const record of records) {
      for (const publicHost of publicHosts) targets.push({ publicHost, port: record.port, internalHost });
    }
    const result = rewriteDatabaseUrls(env, targets);
    const notes = result.rewritten.length
      ? [`Database on this runner: ${result.rewritten.join(", ")} now use${result.rewritten.length === 1 ? "s" : ""} the private address ${internalHost}`]
      : [];
    return { env: result.env, notes };
  }

  private async createDatabase(res: http.ServerResponse, body: string): Promise<void> {
    const params = parseJson(body);
    if (!params) return sendJson(res, 400, { error: "Invalid JSON body" });

    const provider = String(params.provider || "POSTGRES").toUpperCase();
    if (provider !== "POSTGRES" && provider !== "REDIS" && provider !== "MYSQL") {
      return sendJson(res, 400, { error: `Unsupported provider: ${provider}. Supported: POSTGRES, REDIS, MYSQL` });
    }
    const id = typeof params.id === "string" && SAFE_ID.test(params.id) ? params.id.toLowerCase() : `db${crypto.randomBytes(6).toString("hex")}`;

    const existing = this.databases.get(id);
    if (existing) return sendJson(res, 200, this.publicRecord(existing));

    const backend = await this.backendFor(provider);
    if (!backend) {
      return sendJson(res, 501, {
        error: provider === "MYSQL" ? "MySQL provisioning requires Docker on the runner" : `No Docker and no native ${provider} binaries on this runner`,
      });
    }

    const password = crypto.randomBytes(18).toString("base64url");
    const containerName = `syncbay-db-${id}`;
    const port = await this.dbPortManager.allocatePort(`db:${id}`);
    const host = this.dbHost;
    let containerId = `mock-${crypto.randomBytes(6).toString("hex")}`;

    if (backend === "docker") {
      const env = { ...process.env, SB_DB_PASSWORD: password, POSTGRES_PASSWORD: password, REDIS_PASSWORD: password, MYSQL_ROOT_PASSWORD: password };
      const common = ["run", "-d", "--name", containerName, "--label", `syncbay.managed-db=${id}`, "--restart", "unless-stopped"];
      const args =
        provider === "POSTGRES"
          ? [...common, "-e", "POSTGRES_PASSWORD", "-e", "POSTGRES_USER=postgres", "-e", "POSTGRES_DB=main",
             "-p", `${port}:5432`, "-v", `${containerName}-data:/var/lib/postgresql/data`, "postgres:16-alpine"]
          : provider === "MYSQL"
          ? [...common, "-e", "MYSQL_ROOT_PASSWORD", "-e", "MYSQL_DATABASE=main",
             "-p", `${port}:3306`, "-v", `${containerName}-data:/var/lib/mysql`, "mysql:8"]
          : [...common, "-e", "REDIS_PASSWORD", "-p", `${port}:6379`, "-v", `${containerName}-data:/data`, "redis:7-alpine",
             "sh", "-c", 'exec redis-server --appendonly yes --requirepass "$REDIS_PASSWORD"'];
      // Passwords travel via the docker client's environment (`-e NAME` without value), never argv.
      const result = await run("docker", args, env, 300000);
      if (result.code !== 0) {
        this.dbPortManager.releasePort(port);
        return sendJson(res, 500, { error: `docker run failed: ${result.stderr.trim().slice(0, 500)}` });
      }
      containerId = result.stdout.trim().split("\n").pop()!.slice(0, 12) || containerName;
    } else if (backend === "native") {
      const listen = process.env.RUNNER_DB_LISTEN || (/^(127\.|localhost$)/.test(host) ? "127.0.0.1" : "*");
      try {
        await this.native.provision({ id, provider: provider as "POSTGRES" | "REDIS", port, host, listen, password });
      } catch (err: any) {
        this.dbPortManager.releaseServicePort(`db:${id}`);
        await this.native.destroy(id).catch(() => null);
        return sendJson(res, 500, { error: `native provisioning failed: ${String(err?.message || err).slice(0, 600)}` });
      }
      containerId = `native-${id}`;
    }

    const encoded = encodeURIComponent(password);
    const connectionUrl =
      provider === "POSTGRES"
        ? `postgresql://postgres:${encoded}@${host}:${port}/main`
        : provider === "MYSQL"
        ? `mysql://root:${encoded}@${host}:${port}/main`
        : `redis://default:${encoded}@${host}:${port}`;

    const record: ManagedDbRecord = {
      id,
      provider,
      containerName,
      containerId,
      host,
      port,
      connectionUrl,
      backend,
      createdAt: new Date().toISOString(),
    };
    this.databases.set(id, record);
    sendJson(res, 201, this.publicRecord(record));
  }

  /** In-memory record, or a native instance recovered from its meta.json after a restart. */
  private findRecord(id: string): ManagedDbRecord | undefined {
    const record = this.databases.get(id);
    if (record) return record;
    const meta = this.native.readMeta(id);
    if (!meta) return undefined;
    const recovered: ManagedDbRecord = {
      id,
      provider: meta.provider,
      containerName: `syncbay-db-${id}`,
      containerId: `native-${id}`,
      host: meta.host,
      port: meta.port,
      connectionUrl: meta.connectionUrl,
      backend: "native",
      createdAt: meta.createdAt,
    };
    this.databases.set(id, recovered);
    return recovered;
  }

  private publicRecord(record: ManagedDbRecord) {
    return {
      id: record.id,
      provider: record.provider,
      connectionUrl: record.connectionUrl,
      host: record.host,
      port: record.port,
      containerId: record.containerId,
      containerName: record.containerName,
      mode: record.backend,
    };
  }

  private async deleteDatabase(res: http.ServerResponse, rawId: string): Promise<void> {
    if (!SAFE_ID.test(rawId)) return sendJson(res, 400, { error: "Invalid database id" });
    const id = rawId.toLowerCase();
    const record = this.findRecord(id);
    const containerName = record?.containerName || `syncbay-db-${id}`;

    if (record?.backend === "native") {
      await this.native.destroy(id);
    } else if (record ? record.backend === "docker" : await this.useDocker()) {
      const removed = await run("docker", ["rm", "-f", containerName], undefined, 60000);
      if (removed.code !== 0 && !/no such container/i.test(removed.stderr)) {
        return sendJson(res, 500, { error: `Container teardown failed: ${removed.stderr.trim().slice(0, 500)}` });
      }
      const volume = await run("docker", ["volume", "rm", "-f", `${containerName}-data`], undefined, 60000);
      if (volume.code !== 0 && !/no such volume/i.test(volume.stderr)) {
        return sendJson(res, 500, { error: `Volume teardown failed: ${volume.stderr.trim().slice(0, 500)}` });
      }
    }
    this.dbPortManager.releaseServicePort(`db:${id}`);
    this.databases.delete(id);
    sendJson(res, 200, { id, deleted: true, existed: Boolean(record) });
  }

  private async databaseHealth(res: http.ServerResponse, rawId: string): Promise<void> {
    if (!SAFE_ID.test(rawId)) return sendJson(res, 400, { error: "Invalid database id" });
    const id = rawId.toLowerCase();
    const record = this.findRecord(id);
    const startedAt = Date.now();

    if (record?.backend === "mock" || (!record && !(await this.useDocker()))) {
      if (!record && this.mode !== "mock") return sendJson(res, 404, { id, healthy: false, status: "missing" });
      return sendJson(res, 200, { id, healthy: true, status: "healthy", mode: "mock", latencyMs: 0 });
    }

    if (record?.backend === "native") {
      const meta = this.native.readMeta(id);
      if (!meta) return sendJson(res, 404, { id, healthy: false, status: "missing" });
      const probe = await this.native.health(meta);
      return sendJson(res, 200, {
        id,
        healthy: probe.healthy,
        status: probe.healthy ? "healthy" : "unhealthy",
        mode: "native",
        latencyMs: Date.now() - startedAt,
        output: probe.output.slice(0, 300),
      });
    }

    const containerName = record?.containerName || `syncbay-db-${id}`;
    let provider = record?.provider;
    if (!provider) {
      const inspect = await run("docker", ["inspect", "-f", "{{.Config.Image}}", containerName], undefined, 10000);
      if (inspect.code !== 0) return sendJson(res, 404, { id, healthy: false, status: "missing" });
      provider = inspect.stdout.includes("redis") ? "REDIS" : inspect.stdout.includes("mysql") ? "MYSQL" : "POSTGRES";
    }

    const probe =
      provider === "POSTGRES"
        ? await run("docker", ["exec", containerName, "pg_isready", "-U", "postgres", "-d", "main"], undefined, 10000)
        : provider === "MYSQL"
        ? await run("docker", ["exec", containerName, "sh", "-c", 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqladmin ping -uroot -h127.0.0.1 --silent'], undefined, 10000)
        : await run("docker", ["exec", containerName, "sh", "-c", 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning ping'], undefined, 10000);
    const healthy =
      probe.code === 0 && (provider === "POSTGRES" || (provider === "MYSQL" ? /alive/.test(probe.stdout) : probe.stdout.includes("PONG")));

    sendJson(res, 200, {
      id,
      healthy,
      status: healthy ? "healthy" : "unhealthy",
      mode: "docker",
      latencyMs: Date.now() - startedAt,
      output: (probe.stdout || probe.stderr).trim().slice(0, 300),
    });
  }

  // ─── Terminal sessions ────────────────────────────────────────────────────

  private async createTerminal(res: http.ServerResponse, body: string): Promise<void> {
    const params = parseJson(body);
    if (!params) return sendJson(res, 400, { error: "Invalid JSON body" });

    const containerId = typeof params.containerId === "string" ? params.containerId : "";
    const jobId = typeof params.jobId === "string" && SAFE_ID.test(params.jobId) ? params.jobId : "";
    const usePty = await this.hasScript();
    const inContainer =
      Boolean(containerId) && SAFE_ID.test(containerId) && !/^(proc_|mock|sim)/.test(containerId) && (await this.useDocker());

    let cwd = process.cwd();
    const jobDir = jobId ? path.join(this.workspaceRoot, jobId) : "";
    if (jobDir && fs.existsSync(jobDir)) cwd = jobDir;
    else if (fs.existsSync(this.workspaceRoot)) cwd = this.workspaceRoot;

    // Only native deployments with an existing workspace may open a host shell.
    // Missing containers must not turn a container terminal into runner-host access.
    const isNativeDeployment = /^proc_/.test(containerId) && Boolean(jobDir && fs.existsSync(jobDir));
    if (!inContainer && this.mode !== "mock" && !isNativeDeployment) {
      return sendJson(res, 409, { error: "No deployed container or native workspace available for this terminal" });
    }

    const inner = inContainer
      ? `docker exec ${usePty ? "-it" : "-i"} ${containerId} sh`
      : usePty
      ? "sh"
      : "";

    // Minimal environment: never leak the runner's own secrets (RUNNER_SECRET, tokens) into the shell.
    const userEnv: Record<string, string> = {};
    if (params.env && typeof params.env === "object") {
      for (const [k, v] of Object.entries(params.env)) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === "string") userEnv[k] = v;
      }
    }
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME || cwd,
      LANG: process.env.LANG || "C.UTF-8",
      TERM: "xterm-256color",
      PS1: "$ ",
      ...(inContainer ? {} : userEnv),
    };

    const proc = usePty
      ? spawn(PTY_WRAPPER, ["-qfc", inner, "/dev/null"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
      : inContainer
      ? spawn("docker", ["exec", "-i", containerId, "sh", "-i"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
      : spawn("sh", ["-i"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });

    const session: TerminalSession = {
      id: `term_${crypto.randomUUID()}`,
      proc,
      pty: usePty,
      buffer: "",
      clients: new Set(),
      idleTimer: null,
      exited: false,
      exitCode: null,
    };
    this.terminals.set(session.id, session);

    const onData = (chunk: Buffer) => this.broadcast(session, chunk.toString("utf8"));
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", (err) => this.broadcast(session, `\r\n[runner] terminal error: ${err.message}\r\n`));
    proc.on("exit", (code) => {
      session.exited = true;
      session.exitCode = code;
      if (session.idleTimer) clearTimeout(session.idleTimer);
      for (const client of session.clients) {
        try {
          client.write(`data: ${JSON.stringify({ type: "exit", code })}\n\n`);
          client.end();
        } catch {}
      }
      session.clients.clear();
      setTimeout(() => this.terminals.delete(session.id), 30000).unref();
    });
    this.touch(session);

    sendJson(res, 201, {
      sessionId: session.id,
      mode: inContainer ? "container" : "process",
      pty: usePty,
      cwd,
      idleTimeoutMs: this.terminalIdleMs,
    });
  }

  private broadcast(session: TerminalSession, data: string): void {
    session.buffer = (session.buffer + data).slice(-MAX_BUFFER);
    const frame = `data: ${JSON.stringify({ type: "output", data })}\n\n`;
    for (const client of session.clients) {
      try {
        client.write(frame);
      } catch {}
    }
  }

  private touch(session: TerminalSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      this.broadcast(session, `\r\n[runner] session closed after ${Math.round(this.terminalIdleMs / 60000)} min idle\r\n`);
      this.killTerminal(session);
    }, this.terminalIdleMs);
    session.idleTimer.unref();
  }

  private killTerminal(session: TerminalSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (!session.exited) {
      try {
        session.proc.kill("SIGTERM");
      } catch {}
    }
  }

  private terminalInput(res: http.ServerResponse, id: string, body: string): void {
    const session = this.terminals.get(id);
    if (!session) return sendJson(res, 404, { error: "Terminal session not found" });
    if (session.exited) return sendJson(res, 410, { error: "Terminal session has exited", exitCode: session.exitCode });
    const params = parseJson(body);
    const input = params && typeof params.input === "string" ? params.input : null;
    if (input === null) return sendJson(res, 400, { error: "Field 'input' (string) is required" });

    // Without a pty the shell does not echo, so echo here to keep the transcript readable.
    if (!session.pty) this.broadcast(session, input);
    session.proc.stdin?.write(input);
    this.touch(session);
    sendJson(res, 200, { ok: true });
  }

  private streamTerminal(req: http.IncomingMessage, res: http.ServerResponse, id: string): void {
    const session = this.terminals.get(id);
    if (!session) return sendJson(res, 404, { error: "Terminal session not found" });

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write(`: connected\n\n`);
    if (session.buffer) res.write(`data: ${JSON.stringify({ type: "output", data: session.buffer })}\n\n`);
    if (session.exited) {
      res.write(`data: ${JSON.stringify({ type: "exit", code: session.exitCode })}\n\n`);
      res.end();
      return;
    }

    session.clients.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
      } catch {}
    }, 15000);
    heartbeat.unref();
    req.on("close", () => {
      clearInterval(heartbeat);
      session.clients.delete(res);
    });
  }

  private closeTerminal(res: http.ServerResponse, id: string): void {
    const session = this.terminals.get(id);
    if (!session) return sendJson(res, 404, { error: "Terminal session not found" });
    this.killTerminal(session);
    this.terminals.delete(id);
    sendJson(res, 200, { sessionId: id, closed: true });
  }
}
