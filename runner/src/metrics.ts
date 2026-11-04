/**
 * Syncbay Runner — resource metrics for running services.
 *
 * GET /api/metrics/:containerId (HMAC with a single-use nonce, verified by the daemon's
 * `verifySignedRequest()`; GET payload = pathname, same convention as runner/src/services.ts
 * and src/lib/runner-client.ts on the control plane).
 *
 * - Docker containers: `docker stats --no-stream --format '{{json .}}' <id>`.
 * - Native processes (`proc_<pid>`): CPU from `/proc/<pid>/stat` (utime+stime, two
 *   readings `cpuWindowMs` apart) and RSS from `/proc/<pid>/status` (VmRSS), summed
 *   over the whole process group, because the pipeline spawns apps detached through
 *   a shell (`sh -c <cmd>`), so the pid is the group leader and the app is its child.
 */

import type * as http from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { execFile } from "node:child_process";

export interface ContainerMetrics {
  containerId: string;
  source: "docker" | "proc";
  cpuPercent: number;
  memoryMb: number;
  memoryLimitMb: number | null;
  netRxBytes: number | null;
  netTxBytes: number | null;
  pids: number | null;
  sampledAt: string;
}

type SignatureVerifier = (payload: string, signature: string | undefined, timestamp: string | undefined) => boolean;

const CONTAINER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function run(cmd: string, args: string[], timeoutMs = 10_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
      resolve({ code, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

// ─── Docker ──────────────────────────────────────────────────────────────────

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

/** Parses docker's human sizes ("12.5MiB", "1.2kB", "0B") into bytes. */
export function parseDockerSize(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = raw.trim().match(/^([\d.]+)\s*([a-zA-Z]*)$/);
  if (!m) return null;
  const unit = (m[2] || "b").toLowerCase();
  const factor = SIZE_UNITS[unit];
  if (factor === undefined) return null;
  return Number(m[1]) * factor;
}

function parsePair(raw: string | undefined): [number | null, number | null] {
  if (!raw) return [null, null];
  const [a, b] = raw.split("/").map((p) => p.trim());
  return [parseDockerSize(a), parseDockerSize(b)];
}

async function dockerMetrics(containerId: string): Promise<ContainerMetrics | null> {
  const res = await run("docker", ["stats", "--no-stream", "--format", "{{json .}}", containerId]);
  if (res.code !== 0) {
    if (/no such container/i.test(res.stderr)) return null;
    throw new Error(`docker stats failed: ${res.stderr.trim().slice(0, 200) || `exit ${res.code}`}`);
  }
  const line = res.stdout.trim().split("\n").filter(Boolean).pop();
  if (!line) return null;
  const stats = JSON.parse(line) as Record<string, string>;
  const [memUsed, memLimit] = parsePair(stats.MemUsage);
  const [rx, tx] = parsePair(stats.NetIO);
  return {
    containerId,
    source: "docker",
    cpuPercent: round(Number.parseFloat(String(stats.CPUPerc || "0").replace("%", "")) || 0),
    memoryMb: round((memUsed || 0) / 1024 ** 2),
    memoryLimitMb: memLimit ? round(memLimit / 1024 ** 2) : null,
    netRxBytes: rx,
    netTxBytes: tx,
    pids: stats.PIDs ? Number.parseInt(stats.PIDs, 10) : null,
    sampledAt: new Date().toISOString(),
  };
}

// ─── /proc ───────────────────────────────────────────────────────────────────

interface ProcStat {
  pgrp: number;
  cpuTicks: number;
}

/** Parses /proc/<pid>/stat. `comm` (field 2) may contain spaces, so split after the last ')'. */
export function parseProcStat(raw: string): ProcStat | null {
  const close = raw.lastIndexOf(")");
  if (close < 0) return null;
  // Fields after comm start at field 3 (state); utime/stime are fields 14/15, pgrp is 5.
  const rest = raw.slice(close + 2).trim().split(/\s+/);
  const field = (n: number) => Number(rest[n - 3]);
  const utime = field(14);
  const stime = field(15);
  const pgrp = field(5);
  if (![utime, stime, pgrp].every(Number.isFinite)) return null;
  return { pgrp, cpuTicks: utime + stime };
}

function parseVmRssKb(status: string): number {
  const m = status.match(/^VmRSS:\s+(\d+)\s*kB/m);
  return m ? Number(m[1]) : 0;
}

let clockTicks: Promise<number> | null = null;
function getClockTicks(): Promise<number> {
  if (!clockTicks) {
    clockTicks = run("getconf", ["CLK_TCK"], 2000).then((r) => {
      const n = Number.parseInt(r.stdout.trim(), 10);
      return r.code === 0 && n > 0 ? n : 100;
    });
  }
  return clockTicks;
}

/** pids of the process group led by `leader` (falls back to just the leader). */
async function processGroup(leader: number): Promise<number[]> {
  const pids = new Set<number>([leader]);
  let entries: string[] = [];
  try {
    entries = await fs.readdir("/proc");
  } catch {
    return [leader];
  }
  await Promise.all(
    entries
      .filter((e) => /^\d+$/.test(e))
      .map(async (e) => {
        try {
          const stat = parseProcStat(await fs.readFile(`/proc/${e}/stat`, "utf8"));
          if (stat && stat.pgrp === leader) pids.add(Number(e));
        } catch {
          // process exited while scanning
        }
      })
  );
  return [...pids];
}

async function groupReading(pids: number[]): Promise<{ ticks: number; rssKb: number; alive: number }> {
  let ticks = 0;
  let rssKb = 0;
  let alive = 0;
  await Promise.all(
    pids.map(async (pid) => {
      try {
        const [statRaw, statusRaw] = await Promise.all([
          fs.readFile(`/proc/${pid}/stat`, "utf8"),
          fs.readFile(`/proc/${pid}/status`, "utf8"),
        ]);
        const stat = parseProcStat(statRaw);
        if (!stat) return;
        ticks += stat.cpuTicks;
        rssKb += parseVmRssKb(statusRaw);
        alive += 1;
      } catch {
        // exited
      }
    })
  );
  return { ticks, rssKb, alive };
}

async function procMetrics(containerId: string, cpuWindowMs: number): Promise<ContainerMetrics | null> {
  const pid = Number.parseInt(containerId.slice("proc_".length), 10);
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    await fs.access(`/proc/${pid}/stat`);
  } catch {
    return null;
  }
  const hz = await getClockTicks();
  const pids = await processGroup(pid);
  const t0 = process.hrtime.bigint();
  const first = await groupReading(pids);
  if (first.alive === 0) return null;
  await new Promise((r) => setTimeout(r, cpuWindowMs));
  const second = await groupReading(pids);
  const elapsedSec = Number(process.hrtime.bigint() - t0) / 1e9;
  const cpuSec = Math.max(0, second.ticks - first.ticks) / hz;
  return {
    containerId,
    source: "proc",
    // Percent of one core, like `docker stats` (can exceed 100 on multi-core use).
    cpuPercent: round(elapsedSec > 0 ? (cpuSec / elapsedSec) * 100 : 0),
    memoryMb: round((second.alive ? second.rssKb : first.rssKb) / 1024),
    memoryLimitMb: round(os.totalmem() / 1024 ** 2),
    // Native processes share the host network namespace: no per-process counters.
    netRxBytes: null,
    netTxBytes: null,
    pids: second.alive || first.alive,
    sampledAt: new Date().toISOString(),
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Collects one sample for a docker container id/name or a `proc_<pid>` native process. */
export async function collectContainerMetrics(
  containerId: string,
  options: { cpuWindowMs?: number } = {}
): Promise<ContainerMetrics | null> {
  if (!CONTAINER_ID_RE.test(containerId)) return null;
  if (containerId.startsWith("proc_")) {
    return procMetrics(containerId, options.cpuWindowMs ?? 500);
  }
  return dockerMetrics(containerId);
}

/**
 * Handles `GET /api/metrics/:containerId`. Returns true when the request was for
 * this route (whether it succeeded or not).
 */
export async function handleMetricsRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  verify: SignatureVerifier
): Promise<boolean> {
  const match = pathname.match(/^\/api\/metrics\/([^/]+)$/);
  if (!match) return false;
  if ((req.method || "GET").toUpperCase() !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return true;
  }
  const signature = req.headers["x-syncbay-signature"] as string | undefined;
  const timestamp = req.headers["x-syncbay-timestamp"] as string | undefined;
  if (!verify(pathname, signature, timestamp)) {
    sendJson(res, 401, { error: "Unauthorized: Invalid or missing HMAC signature" });
    return true;
  }
  const containerId = decodeURIComponent(match[1]);
  if (!CONTAINER_ID_RE.test(containerId)) {
    sendJson(res, 400, { error: "Invalid container id" });
    return true;
  }
  try {
    const metrics = await collectContainerMetrics(containerId);
    if (!metrics) {
      sendJson(res, 404, { error: `Container ${containerId} is not running` });
      return true;
    }
    sendJson(res, 200, metrics);
  } catch (err: any) {
    sendJson(res, 502, { error: err?.message || "Failed to collect metrics" });
  }
  return true;
}
