/**
 * Syncbay PaaS — Pluggable Global Edge Tunnel Driver Subsystem
 *
 * Implements supervised, self-healing tunnel drivers bridging runner container
 * execution behind NAT/firewalls to the Syncbay Global Edge Network.
 * Supports Cloudflare Tunnels (production), SSH reverse tunnels (bastion),
 * and Local loopback proxy (offline/CI execution).
 */

import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";

export type TunnelStatus =
  | "STOPPED"
  | "STARTING"
  | "RUNNING"
  | "DEGRADED"
  | "RECONNECTING"
  | "ERROR";

export type TunnelDriverType = "cloudflare" | "local" | "ssh";

export interface TunnelDriverConfig {
  driver?: TunnelDriverType;
  token?: string;                  // Cloudflare tunnel token (base64/jwt)
  ingressUrl?: string;            // Local edge ingress target (e.g. "http://127.0.0.1:3000")
  hostname?: string;              // Edge hostname (e.g. "*.syncbay.app")
  cloudflaredBinPath?: string;    // Custom binary path (defaults to "cloudflared")
  sshBastionHost?: string;        // For SSH reverse tunnels
  sshPort?: number;
  sshUser?: string;
  sshRemotePort?: number;
  maxRetries?: number;
  heartbeatIntervalMs?: number;
  logHandler?: (level: "info" | "warn" | "error", message: string) => void;
  onStatusChange?: (status: TunnelStatus, detail?: string) => void;
  // Custom process spawner for mock/testing
  customSpawner?: (command: string, args: string[], options?: any) => any;
}

export interface TunnelDriverStats {
  status: TunnelStatus;
  driverName: TunnelDriverType;
  uptimeSeconds: number;
  reconnectCount: number;
  lastHeartbeatAt?: string;
  lastError?: string;
  publicEndpoint?: string;
  pid?: number;
}

export interface TunnelDriver {
  readonly driverType: TunnelDriverType;
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): TunnelStatus;
  getStats(): TunnelDriverStats;
  checkHealth(): Promise<boolean>;
  on(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
}

const BACKOFF_SCHEDULE = [1000, 2000, 5000, 10000, 30000];

abstract class BaseTunnelDriver extends EventEmitter implements TunnelDriver {
  public abstract readonly driverType: TunnelDriverType;
  protected status: TunnelStatus = "STOPPED";
  protected startedAt: number | null = null;
  protected reconnectCount = 0;
  protected lastError: string | undefined = undefined;
  protected lastHeartbeatAt: string | undefined = undefined;
  protected publicEndpoint: string | undefined = undefined;
  protected config: TunnelDriverConfig;

  constructor(config: TunnelDriverConfig) {
    super();
    this.config = config;
  }

  public getStatus(): TunnelStatus {
    return this.status;
  }

  public getStats(): TunnelDriverStats {
    const uptimeSeconds = this.startedAt && this.status === "RUNNING"
      ? Math.floor((Date.now() - this.startedAt) / 1000)
      : 0;

    return {
      status: this.status,
      driverName: this.driverType,
      uptimeSeconds,
      reconnectCount: this.reconnectCount,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastError: this.lastError,
      publicEndpoint: this.publicEndpoint,
    };
  }

  protected setStatus(status: TunnelStatus, detail?: string): void {
    if (this.status === status) return;
    const oldStatus = this.status;
    this.status = status;
    this.emit("statusChange", { from: oldStatus, to: status, detail });
    if (this.config.onStatusChange) {
      this.config.onStatusChange(status, detail);
    }
  }

  protected log(level: "info" | "warn" | "error", message: string): void {
    if (this.config.logHandler) {
      this.config.logHandler(level, message);
    } else {
      const prefix = `[tunnel:${this.driverType}]`;
      if (level === "error") console.error(`${prefix} ${message}`);
      else if (level === "warn") console.warn(`${prefix} ${message}`);
      else console.log(`${prefix} ${message}`);
    }
  }

  public abstract start(): Promise<void>;
  public abstract stop(): Promise<void>;
  public abstract checkHealth(): Promise<boolean>;
}

/**
 * Cloudflare Tunnel Driver
 *
 * Spawns and supervises `cloudflared tunnel run --token <token>`.
 * Includes an exponential backoff crash supervisor (1s, 2s, 5s, max 30s)
 * and periodic heartbeat health probes.
 */
export class CloudflareTunnelDriver extends BaseTunnelDriver {
  public readonly driverType: TunnelDriverType = "cloudflare";
  private childProcess: ChildProcess | null = null;
  private isStopping = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private consecutiveProbeFailures = 0;

  constructor(config: TunnelDriverConfig = {}) {
    super(config);
    this.publicEndpoint = config.hostname ? `https://${config.hostname}` : "https://*.syncbay.app";
  }

  private startPromise: Promise<void> | null = null;

  public async start(): Promise<void> {
    if (this.status === "RUNNING") {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.performStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async performStart(): Promise<void> {
    this.isStopping = false;
    this.setStatus("STARTING", "Launching managed cloudflared tunnel process");

    return new Promise<void>((resolve, reject) => {
      let resolved = false;

      const attemptSpawn = () => {
        try {
          const bin = this.config.cloudflaredBinPath || "cloudflared";
          const args: string[] = ["tunnel", "--no-autoupdate"];

          if (this.config.token) {
            args.push("run", "--token", this.config.token);
          } else if (this.config.ingressUrl) {
            args.push("--url", this.config.ingressUrl);
          } else {
            args.push("--url", "http://127.0.0.1:3000");
          }

          this.log("info", `Starting cloudflared: ${bin} ${args.map(a => a.startsWith("ey") ? "[REDACTED_TOKEN]" : a).join(" ")}`);

          const spawner = this.config.customSpawner || spawn;
          const proc = spawner(bin, args, {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env },
          });

          this.childProcess = proc;

          proc.stdout?.on("data", (data: Buffer | string) => {
            const str = data.toString();
            this.handleProcessOutput(str);
            if (this.status === "RUNNING" && !resolved) {
              resolved = true;
              this.startHeartbeat();
              resolve();
            }
          });

          proc.stderr?.on("data", (data: Buffer | string) => {
            const str = data.toString();
            this.handleProcessOutput(str);
            if (this.status === "RUNNING" && !resolved) {
              resolved = true;
              this.startHeartbeat();
              resolve();
            }
          });

          proc.on("error", (err: Error) => {
            this.lastError = err.message;
            this.log("error", `Process error: ${err.message}`);
            if (!resolved) {
              resolved = true;
              this.setStatus("ERROR", err.message);
              reject(err);
            } else {
              this.handleUnexpectedTermination(err.message);
            }
          });

          proc.on("close", (code: number | null, signal: string | null) => {
            const detail = `Exited with code ${code ?? signal ?? "unknown"}`;
            this.log("warn", `cloudflared process terminated: ${detail}`);
            this.childProcess = null;

            if (this.isStopping) {
              this.setStatus("STOPPED", detail);
            } else {
              if (!resolved) {
                resolved = true;
                this.setStatus("ERROR", detail);
                reject(new Error(`cloudflared exited immediately: ${detail}`));
              } else {
                this.handleUnexpectedTermination(detail);
              }
            }
          });

          // Assume running once process stays alive for 400ms without immediate exit
          setTimeout(() => {
            if (!this.isStopping && this.childProcess && !resolved && this.status !== "ERROR") {
              resolved = true;
              this.startedAt = Date.now();
              this.consecutiveProbeFailures = 0;
              this.setStatus("RUNNING", "Tunnel connection active and multiplexing edge traffic");
              this.startHeartbeat();
              resolve();
            }
          }, 400);

        } catch (err: any) {
          this.lastError = err.message;
          this.setStatus("ERROR", err.message);
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        }
      };

      attemptSpawn();
    });
  }

  private handleProcessOutput(output: string): void {
    // Cloudflare Tunnel output analysis
    const lines = output.split("\n");
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      if (
        line.includes("Registered tunnel connection") ||
        line.includes("Connection") && line.includes("registered") ||
        line.includes("Route propagating") ||
        line.includes("INF") && line.includes("Connected to")
      ) {
        if (this.status !== "RUNNING" && !this.isStopping) {
          this.startedAt = Date.now();
          this.consecutiveProbeFailures = 0;
          this.setStatus("RUNNING", "Tunnel connection confirmed established");
        }
      }

      if (
        line.includes("Connection terminated") ||
        line.includes("Retrying connection") ||
        line.includes("Quitting")
      ) {
        if (this.status === "RUNNING") {
          this.setStatus("RECONNECTING", line);
        }
      }
    }
  }

  private handleUnexpectedTermination(reason: string): void {
    if (this.isStopping) return;

    this.reconnectCount++;

    if (this.config.maxRetries !== undefined && this.reconnectCount > this.config.maxRetries) {
      this.setStatus("ERROR", `Exceeded maximum restart attempts (${this.config.maxRetries})`);
      this.log("error", `Exceeded maxRetries (${this.config.maxRetries}). Supervisor stopped.`);
      return;
    }

    this.setStatus("RECONNECTING", `Unexpected termination (${reason}). Scheduled restart #${this.reconnectCount}`);

    const backoffIndex = Math.min(this.reconnectCount - 1, BACKOFF_SCHEDULE.length - 1);
    const delay = BACKOFF_SCHEDULE[backoffIndex];

    this.log("warn", `Scheduling crash recovery restart in ${delay}ms (attempt #${this.reconnectCount})`);

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (!this.isStopping) {
        this.start().catch((err) => {
          this.log("error", `Restart attempt failed: ${err.message}`);
        });
      }
    }, delay);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const interval = this.config.heartbeatIntervalMs || 5000;

    this.heartbeatTimer = setInterval(async () => {
      if (this.isStopping) return;
      const ok = await this.checkHealth();
      this.lastHeartbeatAt = new Date().toISOString();

      if (!ok) {
        this.consecutiveProbeFailures++;
        if (this.consecutiveProbeFailures >= 3 && this.status === "RUNNING") {
          this.setStatus("DEGRADED", "Tunnel process degraded or failed 3 consecutive health checks");
        }
      } else {
        if (this.consecutiveProbeFailures > 0) {
          this.consecutiveProbeFailures = 0;
        }
        if (this.status === "DEGRADED") {
          this.setStatus("RUNNING", "Tunnel recovered and responding to health probes");
        }
      }
    }, interval);
  }

  public async checkHealth(): Promise<boolean> {
    if (this.isStopping || !this.childProcess) return false;
    if (this.status === "ERROR" || this.status === "STOPPED") return false;

    // 1. Process liveness check
    try {
      if (this.childProcess.killed || (this.childProcess.exitCode !== null && this.childProcess.exitCode !== undefined)) {
        return false;
      }
      if (this.childProcess.pid && !this.config.customSpawner) {
        process.kill(this.childProcess.pid, 0);
      }
    } catch {
      return false;
    }

    // 2. Ingress URL health check if provided
    if (this.config.ingressUrl) {
      try {
        const probeUrl = `${this.config.ingressUrl.replace(/\/$/, "")}/health`;
        const res = await fetch(probeUrl, {
          method: "GET",
          signal: AbortSignal.timeout(1200),
        }).catch(() => null);

        // Edge Ingress returns 200 (healthy) or 503 (booting/warming)
        if (!res || (res.status !== 200 && res.status !== 503)) {
          return false;
        }
      } catch {
        return false;
      }
    }

    return true;
  }

  public async stop(): Promise<void> {
    this.isStopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (!this.childProcess) {
      this.setStatus("STOPPED", "Driver stopped cleanly");
      return;
    }

    return new Promise((resolve) => {
      const proc = this.childProcess;
      this.childProcess = null;

      const forceKillTimer = setTimeout(() => {
        try {
          if (proc?.pid) process.kill(proc.pid, "SIGKILL");
        } catch {}
        this.setStatus("STOPPED", "Force-killed cloudflared process");
        resolve();
      }, 3000);

      proc?.on("close", () => {
        clearTimeout(forceKillTimer);
        this.setStatus("STOPPED", "cloudflared process terminated cleanly");
        resolve();
      });

      try {
        proc?.kill("SIGTERM");
      } catch {
        clearTimeout(forceKillTimer);
        this.setStatus("STOPPED", "Process already stopped");
        resolve();
      }
    });
  }

  public override getStats(): TunnelDriverStats {
    const stats = super.getStats();
    if (this.childProcess?.pid) {
      stats.pid = this.childProcess.pid;
    }
    return stats;
  }
}

/**
 * Local Proxy Tunnel Driver
 *
 * Designed for offline, CI, and local development environments.
 * Instantly transitions to RUNNING without requiring cloudflared or internet access.
 */
export class LocalProxyTunnelDriver extends BaseTunnelDriver {
  public readonly driverType: TunnelDriverType = "local";
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(config: TunnelDriverConfig = {}) {
    super(config);
    this.publicEndpoint = config.ingressUrl || "http://127.0.0.1:3000";
  }

  public async start(): Promise<void> {
    this.setStatus("STARTING", "Initializing local loopback proxy driver");
    this.startedAt = Date.now();
    this.setStatus("RUNNING", "Local loopback edge driver active");

    const interval = this.config.heartbeatIntervalMs || 5000;
    this.heartbeatTimer = setInterval(async () => {
      await this.checkHealth();
      this.lastHeartbeatAt = new Date().toISOString();
    }, interval);
  }

  public async checkHealth(): Promise<boolean> {
    this.lastHeartbeatAt = new Date().toISOString();
    return this.status === "RUNNING";
  }

  public async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.setStatus("STOPPED", "Local loopback proxy driver stopped");
  }
}

/**
 * SSH Reverse Tunnel Driver
 *
 * Establishes an outbound reverse port forward (`ssh -R <remote_port>:127.0.0.1:<local_port>`)
 * to a central bastion host for environments where Cloudflare is not available.
 */
export class SshReverseTunnelDriver extends BaseTunnelDriver {
  public readonly driverType: TunnelDriverType = "ssh";
  private childProcess: ChildProcess | null = null;
  private isStopping = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(config: TunnelDriverConfig = {}) {
    super(config);
    const host = config.sshBastionHost || "bastion.syncbay.app";
    const port = config.sshRemotePort || 443;
    this.publicEndpoint = `https://${host}:${port}`;
  }

  public async start(): Promise<void> {
    this.isStopping = false;
    this.setStatus("STARTING", "Establishing SSH reverse tunnel connection");

    return new Promise<void>((resolve, reject) => {
      let resolved = false;

      const attemptSpawn = () => {
        try {
          const bastion = this.config.sshBastionHost || "bastion.syncbay.app";
          const user = this.config.sshUser || "tunnel";
          const port = this.config.sshPort || 22;
          const remotePort = this.config.sshRemotePort || 8443;
          const localPort = 3000;

          const args = [
            "-N",
            "-R", `${remotePort}:127.0.0.1:${localPort}`,
            "-p", String(port),
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=3",
            "-o", "StrictHostKeyChecking=no",
            `${user}@${bastion}`,
          ];

          const spawner = this.config.customSpawner || spawn;
          const proc = spawner("ssh", args, {
            stdio: ["ignore", "pipe", "pipe"],
          });

          this.childProcess = proc;

          proc.on("error", (err: Error) => {
            this.lastError = err.message;
            if (!resolved) {
              resolved = true;
              this.setStatus("ERROR", err.message);
              reject(err);
            }
          });

          proc.on("close", (code: number | null) => {
            this.childProcess = null;
            if (this.isStopping) {
              this.setStatus("STOPPED", "SSH tunnel closed");
            } else {
              this.reconnectCount++;
              if (this.config.maxRetries !== undefined && this.reconnectCount > this.config.maxRetries) {
                this.setStatus("ERROR", `Exceeded maximum restart attempts (${this.config.maxRetries})`);
                this.log("error", `Exceeded maxRetries (${this.config.maxRetries}). Halting SSH reconnect.`);
                return;
              }
              this.setStatus("RECONNECTING", `SSH process exited (code ${code})`);
              const delay = BACKOFF_SCHEDULE[Math.min(this.reconnectCount - 1, BACKOFF_SCHEDULE.length - 1)];
              this.reconnectTimer = setTimeout(() => {
                if (!this.isStopping) this.start().catch(() => {});
              }, delay);
            }
          });

          setTimeout(() => {
            if (!this.isStopping && this.childProcess && !resolved) {
              resolved = true;
              this.startedAt = Date.now();
              this.setStatus("RUNNING", "SSH reverse tunnel active");
              resolve();
            }
          }, 300);
        } catch (err: any) {
          this.lastError = err.message;
          this.setStatus("ERROR", err.message);
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        }
      };

      attemptSpawn();
    });
  }

  public async checkHealth(): Promise<boolean> {
    if (this.isStopping || !this.childProcess) return false;
    if (this.childProcess.killed || (this.childProcess.exitCode !== null && this.childProcess.exitCode !== undefined)) {
      return false;
    }
    try {
      if (this.childProcess.pid && !this.config.customSpawner) process.kill(this.childProcess.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  public async stop(): Promise<void> {
    this.isStopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    if (this.childProcess) {
      try {
        this.childProcess.kill("SIGTERM");
      } catch {}
      this.childProcess = null;
    }
    this.setStatus("STOPPED", "SSH reverse tunnel stopped");
  }
}

/**
 * Factory creating the configured Tunnel Driver
 */
export function createTunnelDriver(config: TunnelDriverConfig = {}): TunnelDriver {
  const driverType: TunnelDriverType =
    config.driver ||
    (process.env.TUNNEL_DRIVER as TunnelDriverType) ||
    (config.token || process.env.TUNNEL_TOKEN || process.env.CLOUDFLARE_TUNNEL_TOKEN ? "cloudflare" : "local");

  const resolvedConfig: TunnelDriverConfig = {
    ...config,
    driver: driverType,
    token: config.token || process.env.TUNNEL_TOKEN || process.env.CLOUDFLARE_TUNNEL_TOKEN,
    ingressUrl: config.ingressUrl || process.env.TUNNEL_INGRESS_URL || "http://127.0.0.1:3000",
    cloudflaredBinPath: config.cloudflaredBinPath || process.env.CLOUDFLARED_BIN || "cloudflared",
  };

  switch (driverType) {
    case "cloudflare":
      return new CloudflareTunnelDriver(resolvedConfig);
    case "ssh":
      return new SshReverseTunnelDriver(resolvedConfig);
    case "local":
    default:
      return new LocalProxyTunnelDriver(resolvedConfig);
  }
}
