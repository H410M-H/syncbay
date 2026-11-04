/**
 * Syncbay PaaS — Durable deployment log store (`DeploymentLog`).
 *
 * `logEventBus` batches published lines into `persistLogEntries()`. Readers use
 * `loadPersistedLogs()` to replay a deployment's history from any instance.
 */

import { db } from "@/lib/db";
import type { LogEntry } from "@/lib/telemetry/event-bus";

const MAX_LINE_LENGTH = 16_384;
const MAX_TRACKED_SEQ = 2000;

type DeploymentLogDelegate = typeof db.deploymentLog;

/** The Prisma delegate, or null when the client in use has no such model (mocked DB in tests). */
function logModel(): DeploymentLogDelegate | null {
  try {
    const model = (db as unknown as { deploymentLog?: DeploymentLogDelegate }).deploymentLog;
    return model && typeof model.createMany === "function" ? model : null;
  } catch {
    return null;
  }
}

/** Next sequence number per deployment, seeded from the DB once per process. */
const nextSeq = new Map<string, number>();

async function reserveSeq(model: DeploymentLogDelegate, deploymentId: string, count: number): Promise<number> {
  let base = nextSeq.get(deploymentId);
  if (base === undefined) {
    const agg = await model.aggregate({ where: { deploymentId }, _max: { seq: true } });
    base = (agg._max.seq ?? -1) + 1;
    if (nextSeq.size >= MAX_TRACKED_SEQ) {
      const oldest = nextSeq.keys().next().value;
      if (oldest !== undefined) nextSeq.delete(oldest);
    }
  }
  nextSeq.set(deploymentId, base + count);
  return base;
}

function normalizeStream(stream: string): LogEntry["stream"] {
  return stream === "stderr" || stream === "system" ? stream : "stdout";
}

/** Writes a batch and assigns `seq` to each entry (in publish order per deployment). */
export async function persistLogEntries(entries: LogEntry[]): Promise<void> {
  const model = logModel();
  if (!model || entries.length === 0) return;

  const byDeployment = new Map<string, LogEntry[]>();
  for (const entry of entries) {
    const list = byDeployment.get(entry.deploymentId) || [];
    list.push(entry);
    byDeployment.set(entry.deploymentId, list);
  }

  const rows: Array<{ id: string; deploymentId: string; seq: number; stream: string; line: string; ts: Date }> = [];
  for (const [deploymentId, list] of byDeployment) {
    const unsequenced = list.filter((e) => e.seq === undefined);
    let seq = unsequenced.length ? await reserveSeq(model, deploymentId, unsequenced.length) : 0;
    for (const entry of list) {
      if (entry.seq === undefined) entry.seq = seq++;
      const ts = new Date(entry.timestamp);
      rows.push({
        id: entry.id,
        deploymentId,
        seq: entry.seq,
        stream: normalizeStream(entry.stream),
        line: String(entry.message ?? "").slice(0, MAX_LINE_LENGTH),
        ts: Number.isNaN(ts.getTime()) ? new Date() : ts,
      });
    }
  }

  // Ids are unique per line, so a retried batch never duplicates rows.
  await model.createMany({ data: rows, skipDuplicates: true });
}

function rowToEntry(row: { id: string; deploymentId: string; seq: number; stream: string; line: string; ts: Date }): LogEntry {
  return {
    id: row.id,
    deploymentId: row.deploymentId,
    seq: row.seq,
    stream: normalizeStream(row.stream),
    message: row.line,
    timestamp: row.ts.toISOString(),
  };
}

/** Persisted lines of a deployment in order, optionally only those after `afterSeq`. */
export async function loadPersistedLogs(
  deploymentId: string,
  options: { afterSeq?: number; limit?: number } = {}
): Promise<LogEntry[]> {
  const model = logModel();
  if (!model) return [];
  const rows = await model.findMany({
    where: {
      deploymentId,
      ...(options.afterSeq !== undefined ? { seq: { gt: options.afterSeq } } : {}),
    },
    orderBy: [{ seq: "asc" }, { ts: "asc" }],
    take: options.limit ?? 5000,
  });
  return rows.map(rowToEntry);
}

/**
 * Full history for a deployment: persisted lines plus in-process lines not yet
 * flushed. Never synthesises lines.
 */
export async function loadDeploymentLogHistory(deploymentId: string, limit = 5000): Promise<LogEntry[]> {
  const { logEventBus } = await import("@/lib/telemetry/event-bus");
  let persisted: LogEntry[] = [];
  try {
    persisted = await loadPersistedLogs(deploymentId, { limit });
  } catch {
    persisted = [];
  }
  const seen = new Set(persisted.map((e) => e.id));
  const unflushed = logEventBus.getHistory(deploymentId).filter((e) => !seen.has(e.id));
  return [...persisted, ...unflushed].slice(-limit);
}

export async function deleteDeploymentLogs(deploymentId: string): Promise<void> {
  const model = logModel();
  nextSeq.delete(deploymentId);
  if (!model) return;
  await model.deleteMany({ where: { deploymentId } }).catch(() => null);
}

/** Retention: drops lines older than `days`. Returns the number deleted. */
export async function purgeOldLogs(days: number): Promise<number> {
  const model = logModel();
  if (!model || !(days > 0)) return 0;
  const res = await model.deleteMany({ where: { ts: { lt: new Date(Date.now() - days * 86_400_000) } } });
  return res.count;
}
