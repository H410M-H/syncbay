/**
 * Syncbay Runner Agent — native (bare-metal) managed databases
 *
 * Used by RunnerServices when Docker is unavailable but the database binaries
 * exist on the host (or RUNNER_DB_MODE=native):
 *   POSTGRES  initdb (scram-sha-256, password via a 0600 pwfile) + pg_ctl start,
 *             data dir `<state>/databases/<id>/pgdata`, then CREATE DATABASE main.
 *   REDIS     redis-server with a 0600 config file (port, bind, dir, requirepass,
 *             appendonly), data dir `<state>/databases/<id>`.
 * Health uses pg_isready / redis-cli ping (password via REDISCLI_AUTH, never argv).
 * Delete stops the server and removes the data directory.
 *
 * When the runner runs as root, servers run as RUNNER_NATIVE_DB_USER (default
 * `postgres`, falling back to `nobody`) because initdb/postgres refuse root.
 * Each instance's metadata is kept in `<dir>/meta.json` (0600) so health and
 * delete work after a runner restart. Servers are not restarted automatically.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, spawn } from "node:child_process";

export type NativeProvider = "POSTGRES" | "REDIS";

export interface NativeDbMeta {
  id: string;
  provider: NativeProvider;
  port: number;
  host: string;
  password: string;
  connectionUrl: string;
  pid?: number;
  createdAt: string;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RunAs {
  uid: number;
  gid: number;
}

/** Root of the runner's persistent state (databases, volumes). */
export function runnerStateDir(): string {
  if (process.env.RUNNER_STATE_DIR) return path.resolve(process.env.RUNNER_STATE_DIR);
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  return isRoot ? "/var/lib/syncbay-runner" : path.join(os.homedir(), ".syncbay-runner");
}

function exec(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; runAs?: RunAs | null; cwd?: string } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        env: opts.env || process.env,
        timeout: opts.timeoutMs ?? 60000,
        maxBuffer: 4 * 1024 * 1024,
        cwd: opts.cwd,
        ...(opts.runAs ? { uid: opts.runAs.uid, gid: opts.runAs.gid } : {}),
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
        resolve({ code, stdout: String(stdout || ""), stderr: String(stderr || (err && !stderr ? err.message : "")) });
      }
    );
  });
}

function which(binary: string): string | null {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Directory holding initdb/pg_ctl: RUNNER_PG_BIN_DIR, PATH, or the newest /usr/lib/postgresql/<v>/bin. */
function findPgBinDir(): string | null {
  const configured = process.env.RUNNER_PG_BIN_DIR;
  if (configured && fs.existsSync(path.join(configured, "initdb"))) return configured;
  const onPath = which("initdb");
  if (onPath && which("pg_ctl")) return path.dirname(onPath);
  const root = "/usr/lib/postgresql";
  try {
    const versions = fs
      .readdirSync(root)
      .filter((v) => fs.existsSync(path.join(root, v, "bin", "initdb")))
      .sort((a, b) => parseFloat(b) - parseFloat(a));
    if (versions.length) return path.join(root, versions[0], "bin");
  } catch {
    // not installed there
  }
  return null;
}

function pgBin(binDir: string, name: string): string {
  const inDir = path.join(binDir, name);
  return fs.existsSync(inDir) ? inDir : which(name) || name;
}

/** Minimal child environment (never the runner's own secrets). */
function childEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", ...extra } as unknown as NodeJS.ProcessEnv;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class NativeDatabaseManager {
  private readonly baseDir: string;
  private runAsProbe: Promise<RunAs | null> | null = null;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || path.join(runnerStateDir(), "databases");
  }

  /** Providers whose binaries exist on this host. */
  public availableProviders(): NativeProvider[] {
    const providers: NativeProvider[] = [];
    if (findPgBinDir()) providers.push("POSTGRES");
    if (which("redis-server")) providers.push("REDIS");
    return providers;
  }

  public dirFor(id: string): string {
    return path.join(this.baseDir, id);
  }

  public readMeta(id: string): NativeDbMeta | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dirFor(id), "meta.json"), "utf8")) as NativeDbMeta;
    } catch {
      return null;
    }
  }

  private writeMeta(meta: NativeDbMeta): void {
    fs.writeFileSync(path.join(this.dirFor(meta.id), "meta.json"), JSON.stringify(meta, null, 2), { mode: 0o600 });
  }

  /** Unprivileged uid/gid to run servers as when the runner is root. */
  private resolveRunAs(): Promise<RunAs | null> {
    if (typeof process.getuid !== "function" || process.getuid() !== 0) return Promise.resolve(null);
    if (!this.runAsProbe) {
      this.runAsProbe = (async () => {
        const candidates = [process.env.RUNNER_NATIVE_DB_USER, "postgres", "nobody"].filter(Boolean) as string[];
        for (const user of candidates) {
          const uid = await exec("id", ["-u", user], { timeoutMs: 3000 });
          const gid = await exec("id", ["-g", user], { timeoutMs: 3000 });
          if (uid.code === 0 && gid.code === 0) {
            return { uid: parseInt(uid.stdout.trim(), 10), gid: parseInt(gid.stdout.trim(), 10) };
          }
        }
        throw new Error("Running as root and no unprivileged user (RUNNER_NATIVE_DB_USER, postgres, nobody) exists");
      })();
    }
    return this.runAsProbe;
  }

  private prepareDir(dir: string, runAs: RunAs | null): void {
    // Parents must be traversable by the unprivileged server user.
    fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o755 });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (runAs) fs.chownSync(dir, runAs.uid, runAs.gid);
  }

  public async provision(params: {
    id: string;
    provider: NativeProvider;
    port: number;
    host: string;
    listen: string;
    password: string;
  }): Promise<NativeDbMeta> {
    return params.provider === "POSTGRES" ? this.provisionPostgres(params) : this.provisionRedis(params);
  }

  private async provisionPostgres(p: { id: string; port: number; host: string; listen: string; password: string }): Promise<NativeDbMeta> {
    const binDir = findPgBinDir();
    if (!binDir) throw new Error("initdb/pg_ctl not found (set RUNNER_PG_BIN_DIR)");
    const runAs = await this.resolveRunAs();
    const dir = this.dirFor(p.id);
    const dataDir = path.join(dir, "pgdata");
    this.prepareDir(dir, runAs);

    const pwFile = path.join(dir, ".pwfile");
    fs.writeFileSync(pwFile, p.password + "\n", { mode: 0o600 });
    if (runAs) fs.chownSync(pwFile, runAs.uid, runAs.gid);
    const env = childEnv({ HOME: dir });
    try {
      const init = await exec(
        pgBin(binDir, "initdb"),
        ["-D", dataDir, "-U", "postgres", `--pwfile=${pwFile}`, "--auth-local=trust", "--auth-host=scram-sha-256", "-E", "UTF8"],
        { env, runAs, timeoutMs: 120000, cwd: dir }
      );
      if (init.code !== 0) throw new Error(`initdb failed: ${(init.stderr || init.stdout).trim().slice(0, 500)}`);
    } finally {
      fs.rmSync(pwFile, { force: true });
    }

    const conf = [
      "",
      "# Syncbay runner (native managed database)",
      `listen_addresses = '${p.listen}'`,
      `port = ${p.port}`,
      `unix_socket_directories = '${dir}'`,
      "max_connections = 50",
      "",
    ].join("\n");
    fs.appendFileSync(path.join(dataDir, "postgresql.conf"), conf);
    if (p.listen !== "127.0.0.1" && p.listen !== "localhost") {
      fs.appendFileSync(path.join(dataDir, "pg_hba.conf"), "host all all 0.0.0.0/0 scram-sha-256\nhost all all ::/0 scram-sha-256\n");
    }

    const start = await exec(pgBin(binDir, "pg_ctl"), ["-D", dataDir, "-l", path.join(dir, "postgres.log"), "-w", "-t", "60", "start"], {
      env,
      runAs,
      timeoutMs: 90000,
      cwd: dir,
    });
    if (start.code !== 0) {
      const tail = fs.existsSync(path.join(dir, "postgres.log")) ? fs.readFileSync(path.join(dir, "postgres.log"), "utf8").slice(-500) : "";
      throw new Error(`pg_ctl start failed: ${(start.stderr || start.stdout).trim().slice(0, 300)} ${tail}`.trim());
    }

    const create = await exec(pgBin(binDir, "psql"), ["-h", dir, "-p", String(p.port), "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", "CREATE DATABASE main"], {
      env,
      runAs,
      timeoutMs: 30000,
      cwd: dir,
    });
    if (create.code !== 0 && !/already exists/.test(create.stderr)) {
      throw new Error(`CREATE DATABASE failed: ${create.stderr.trim().slice(0, 300)}`);
    }

    const meta: NativeDbMeta = {
      id: p.id,
      provider: "POSTGRES",
      port: p.port,
      host: p.host,
      password: p.password,
      connectionUrl: `postgresql://postgres:${encodeURIComponent(p.password)}@${p.host}:${p.port}/main`,
      createdAt: new Date().toISOString(),
    };
    this.writeMeta(meta);
    return meta;
  }

  private async provisionRedis(p: { id: string; port: number; host: string; listen: string; password: string }): Promise<NativeDbMeta> {
    const server = which("redis-server");
    if (!server) throw new Error("redis-server not found on PATH");
    const runAs = await this.resolveRunAs();
    const dir = this.dirFor(p.id);
    this.prepareDir(dir, runAs);

    const confPath = path.join(dir, "redis.conf");
    const conf = [
      `port ${p.port}`,
      `bind ${p.listen === "*" ? "0.0.0.0" : p.listen}`,
      `dir ${dir}`,
      `requirepass ${p.password}`,
      "appendonly yes",
      "protected-mode yes",
      "daemonize no",
      `logfile ${path.join(dir, "redis.log")}`,
      "",
    ].join("\n");
    fs.writeFileSync(confPath, conf, { mode: 0o600 });
    if (runAs) fs.chownSync(confPath, runAs.uid, runAs.gid);

    const child = spawn(server, [confPath], {
      cwd: dir,
      env: childEnv(),
      detached: true,
      stdio: "ignore",
      ...(runAs ? { uid: runAs.uid, gid: runAs.gid } : {}),
    });
    child.unref();
    const pid = child.pid;

    const meta: NativeDbMeta = {
      id: p.id,
      provider: "REDIS",
      port: p.port,
      host: p.host,
      password: p.password,
      connectionUrl: `redis://default:${encodeURIComponent(p.password)}@${p.host}:${p.port}`,
      pid,
      createdAt: new Date().toISOString(),
    };
    this.writeMeta(meta);

    for (let i = 0; i < 50; i++) {
      if ((await this.health(meta)).healthy) return meta;
      if (child.exitCode !== null) break;
      await sleep(100);
    }
    const log = fs.existsSync(path.join(dir, "redis.log")) ? fs.readFileSync(path.join(dir, "redis.log"), "utf8").slice(-400) : "";
    await this.destroy(p.id);
    throw new Error(`redis-server did not become ready: ${log}`.trim());
  }

  public async health(meta: NativeDbMeta): Promise<{ healthy: boolean; output: string }> {
    if (meta.provider === "POSTGRES") {
      const binDir = findPgBinDir();
      const probe = await exec(pgBin(binDir || "", "pg_isready"), ["-h", "127.0.0.1", "-p", String(meta.port), "-U", "postgres", "-d", "main"], { timeoutMs: 10000 });
      return { healthy: probe.code === 0, output: (probe.stdout || probe.stderr).trim() };
    }
    const cli = which("redis-cli");
    if (!cli) return { healthy: false, output: "redis-cli not found" };
    const probe = await exec(cli, ["-h", "127.0.0.1", "-p", String(meta.port), "ping"], {
      env: childEnv({ REDISCLI_AUTH: meta.password }),
      timeoutMs: 10000,
    });
    return { healthy: probe.code === 0 && probe.stdout.includes("PONG"), output: (probe.stdout || probe.stderr).trim() };
  }

  /** Stops the server and removes its data directory. */
  public async destroy(id: string): Promise<{ existed: boolean }> {
    const dir = this.dirFor(id);
    const meta = this.readMeta(id);
    if (!fs.existsSync(dir)) return { existed: false };

    if (meta?.provider === "POSTGRES" || fs.existsSync(path.join(dir, "pgdata"))) {
      const dataDir = path.join(dir, "pgdata");
      if (fs.existsSync(path.join(dataDir, "postmaster.pid"))) {
        const binDir = findPgBinDir();
        const runAs = await this.resolveRunAs().catch(() => null);
        await exec(pgBin(binDir || "", "pg_ctl"), ["-D", dataDir, "-m", "fast", "-w", "-t", "30", "stop"], {
          env: childEnv({ HOME: dir }),
          runAs,
          timeoutMs: 45000,
          cwd: dir,
        });
      }
    } else if (meta?.pid) {
      try {
        process.kill(meta.pid, "SIGTERM");
        for (let i = 0; i < 30; i++) {
          process.kill(meta.pid, 0);
          await sleep(100);
        }
        process.kill(meta.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return { existed: true };
  }
}
