/**
 * Helpers for building and launching application containers.
 *
 * - `shq()` quotes one shell argument, so user-supplied commands and paths cannot inject shell syntax.
 * - `tailText()` keeps the end of a long output: the reason a build failed is in its last lines.
 * - `containerEnv()` passes environment variables through the docker/nixpacks CLI's own process
 *   environment (`-e KEY` without a value), so secret values never reach a command line or a log.
 * - `parseListeningPorts()` reads `/proc/net/tcp` from inside a container to find the port the
 *   application really listens on.
 * - `pickNodeVersion()` chooses a current Node.js for projects that do not pin one.
 */

/** Quotes a value as one POSIX shell argument. */
export function shq(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Last `maxLines` lines of `text`, capped at `maxChars` characters (cut at the front). */
export function tailText(text: string, maxLines = 40, maxChars = 4000): string {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim());
  const tail = lines.slice(-maxLines).join("\n");
  return tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail;
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ContainerEnv {
  /** Values to merge into the CLI process environment. */
  env: Record<string, string>;
  /** `-e KEY` flags (no values) for `docker run`. */
  dockerFlags: string[];
  /** `--env KEY` flags (no values) for `nixpacks build`. */
  nixpacksFlags: string[];
  /** Keys that were dropped because they are not valid environment variable names. */
  skipped: string[];
}

/**
 * Builds the flags and process environment for a container. `overrides` win over user values
 * (the platform owns `PORT`); `defaults` apply only when the user did not set the key.
 */
export function containerEnv(
  userEnv: Record<string, string> | undefined,
  overrides: Record<string, string> = {},
  defaults: Record<string, string> = {}
): ContainerEnv {
  const env: Record<string, string> = {};
  const skipped: string[] = [];
  for (const [key, value] of Object.entries({ ...defaults, ...(userEnv || {}), ...overrides })) {
    if (!ENV_KEY.test(key)) {
      skipped.push(key);
      continue;
    }
    if (value === undefined || value === null) continue;
    env[key] = String(value);
  }
  const keys = Object.keys(env);
  return {
    env,
    dockerFlags: keys.map((k) => `-e ${k}`),
    nixpacksFlags: keys.map((k) => `--env ${k}`),
    skipped,
  };
}

export interface ListeningPort {
  port: number;
  /** True when the socket is bound to 127.0.0.1 / ::1 only (unreachable through a port mapping). */
  loopbackOnly: boolean;
}

function isLoopback(hexAddr: string): boolean {
  // /proc/net/tcp prints an IPv4 address as little-endian hex (127.0.0.1 → 0100007F) and an IPv6
  // address as four little-endian 32-bit words (::1 → 00000000000000000000000001000000).
  const upper = hexAddr.toUpperCase();
  if (upper.length === 8) return upper.endsWith("7F");
  if (upper.length === 32) {
    if (upper === "00000000000000000000000001000000") return true;
    if (upper.startsWith("0000000000000000FFFF0000")) return upper.endsWith("7F"); // ::ffff:127.x.x.x
  }
  return false;
}

/** Parses the content of `/proc/net/tcp` (+ `/proc/net/tcp6`) into the listening TCP ports. */
export function parseListeningPorts(procNetTcp: string): ListeningPort[] {
  const byPort = new Map<number, boolean>();
  for (const line of String(procNetTcp || "").split("\n")) {
    const cols = line.trim().split(/\s+/);
    // "<n>: <local_address> <rem_address> <st> ..." — st 0A is TCP_LISTEN
    if (cols.length < 4 || cols[3].toUpperCase() !== "0A") continue;
    const idx = cols[1].lastIndexOf(":");
    if (idx < 0) continue;
    const port = parseInt(cols[1].slice(idx + 1), 16);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    const loopback = isLoopback(cols[1].slice(0, idx));
    // A port reachable on any non-loopback address counts as reachable.
    byPort.set(port, (byPort.get(port) ?? true) && loopback);
  }
  return [...byPort.entries()].map(([port, loopbackOnly]) => ({ port, loopbackOnly })).sort((a, b) => a.port - b.port);
}

/** Ports web frameworks listen on by default, tried when a container cannot be inspected. */
export const COMMON_APP_PORTS = [3000, 8080, 8000, 5000, 80, 4000, 5173, 4173, 4321, 8888, 9000, 3001];

/** Platform default for Node.js projects that pin no version (Nixpacks itself would pick 18, which is end-of-life). */
export const DEFAULT_NODE_MAJOR = "22";

/** Whether an `engines.node` range accepts `major` (compared by major version only). */
export function nodeRangeAllows(range: string, major: number): boolean {
  const alternatives = String(range || "").split("||").map((part) => part.trim());
  return alternatives.some((part) => {
    if (!part || part === "*" || part.toLowerCase() === "x") return true;
    const comparators = part.replace(/\s*-\s*/g, " - ").split(/\s+/).filter(Boolean);
    if (comparators.includes("-")) {
      // "18 - 22" hyphen range
      const [low, , high] = comparators.map((c) => parseInt(c.replace(/^v/, ""), 10));
      return Number.isFinite(low) && Number.isFinite(high) && major >= low && major <= high;
    }
    return comparators.every((comparator) => {
      const match = /^(>=|<=|>|<|\^|~|=)?v?(\d+)/.exec(comparator);
      if (!match) return comparator === "*" || comparator.toLowerCase() === "x";
      const n = Number(match[2]);
      switch (match[1]) {
        case ">=":
        case ">":
          return major >= n;
        case "<=":
          return major <= n;
        case "<":
          return major < n;
        default:
          return major === n; // ^N, ~N, =N, N, N.x pin a major
      }
    });
  });
}

/**
 * The Node.js major to request from Nixpacks, or null to let Nixpacks decide.
 *
 * Nixpacks picks Node 18 (end-of-life) for a project that pins nothing, and also for an open
 * range such as `>=18`. A current major is requested whenever the project allows it. A project
 * pinned to another major (`18.x`, `^20`, `.nvmrc`) keeps its pin, and a value the user set
 * (`NIXPACKS_NODE_VERSION`) always wins.
 */
export function pickNodeVersion(input: {
  packageJson?: { engines?: { node?: unknown } } | null;
  hasNvmrc?: boolean;
  /** Content of `.node-version`, which Nixpacks itself does not read. */
  nodeVersionFile?: string | null;
  userEnv?: Record<string, string>;
  fallback?: string;
}): string | null {
  if (!input.packageJson) return null;
  if (input.userEnv?.NIXPACKS_NODE_VERSION || input.userEnv?.NODE_VERSION) return null;
  if (input.hasNvmrc) return null;
  const fromFile = /^v?(\d+)/.exec((input.nodeVersionFile || "").trim());
  if (fromFile) return fromFile[1];
  const preferred = /^\d+$/.test(input.fallback || "") ? input.fallback! : DEFAULT_NODE_MAJOR;
  const pinned = input.packageJson.engines?.node;
  if (typeof pinned === "string" && pinned.trim()) {
    return nodeRangeAllows(pinned, Number(preferred)) ? preferred : null;
  }
  return preferred;
}

/** Bounded-concurrency gate: at most `limit` holders at a time, FIFO. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit) || 1);
  }

  public get waiting(): number {
    return this.waiters.length;
  }

  public async run<T>(task: () => Promise<T>, onWait?: (ahead: number) => void): Promise<T> {
    if (this.active >= this.limit) {
      onWait?.(this.waiters.length + 1);
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await task();
    } finally {
      const next = this.waiters.shift();
      if (next) next(); // hand the slot over without releasing it
      else this.active -= 1;
    }
  }
}
