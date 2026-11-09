/**
 * Syncbay PaaS — Real-Time Telemetry & Log Event Bus (F12, F13)
 *
 * Per-process pub/sub for deployment log lines. Each deployment keeps a bounded
 * ring buffer (a hot cache for in-process readers), and every published line is
 * queued for batched persistence to the `DeploymentLog` table (flushed every
 * 250 ms or every 200 lines, see `src/lib/telemetry/log-store.ts`). Readers in
 * other instances replay from the DB (`src/lib/telemetry/log-stream.ts`).
 */

import { randomUUID } from "node:crypto";
import { redactSecrets } from "./redact";

export interface LogEntry {
  id: string;
  deploymentId: string;
  timestamp: string;
  stream: "stdout" | "stderr" | "system";
  message: string;
  /** Per-deployment order, assigned when the line is persisted. */
  seq?: number;
}

/** Writes a batch of entries durably. Must assign `entry.seq`. */
export type LogPersister = (entries: LogEntry[]) => Promise<void>;

const FLUSH_INTERVAL_MS = 250;
const FLUSH_BATCH_SIZE = 200;
const MAX_PENDING = 5000;
const MAX_TRACKED_DEPLOYMENTS = 500;
const RETRY_BACKOFF_MS = 5000;

function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/** Default persister: the Prisma-backed log store, loaded lazily. */
const dbPersister: LogPersister = async (entries) => {
  const { persistLogEntries } = await import("./log-store");
  await persistLogEntries(entries);
};

export class LogEventBus {
  private ringBuffers = new Map<string, LogEntry[]>();
  private errors = new Map<string, string>();
  private subscribers = new Map<string, Set<(log: LogEntry) => void>>();
  private maxBufferSize: number;
  private pending: LogEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private retryAfter = 0;
  private persister: LogPersister | null | undefined;

  constructor(maxBufferSize = 1000) {
    this.maxBufferSize = maxBufferSize;
  }

  /** Overrides the persister (`null` disables persistence). Mainly for tests. */
  setPersister(persister: LogPersister | null): void {
    this.persister = persister;
  }

  private activePersister(): LogPersister | null {
    if (this.persister !== undefined) return this.persister;
    return hasDatabase() ? dbPersister : null;
  }

  private evictIdleBuffers(): void {
    if (this.ringBuffers.size <= MAX_TRACKED_DEPLOYMENTS) return;
    for (const key of this.ringBuffers.keys()) {
      if (this.ringBuffers.size <= MAX_TRACKED_DEPLOYMENTS) break;
      if (!this.subscribers.has(key)) {
        this.ringBuffers.delete(key);
        this.errors.delete(key);
      }
    }
  }

  private enqueue(entry: LogEntry): void {
    if (!this.activePersister()) return;
    this.pending.push(entry);
    if (this.pending.length > MAX_PENDING) {
      this.pending.splice(0, this.pending.length - MAX_PENDING);
    }
    if (this.pending.length >= FLUSH_BATCH_SIZE) {
      void this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, Math.max(FLUSH_INTERVAL_MS, this.retryAfter - Date.now()));
      this.flushTimer.unref?.();
    }
  }

  /**
   * Persists every queued line. Resolves once they are written (or the write
   * failed; failed batches are re-queued and retried after a short backoff).
   * Never rejects. Callers that may be frozen right after (serverless) await it.
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    while (this.inflight) await this.inflight;
    const persister = this.activePersister();
    if (!persister || this.pending.length === 0) return;
    const batch = this.pending.splice(0, this.pending.length);
    this.inflight = (async () => {
      for (let i = 0; i < batch.length; i += FLUSH_BATCH_SIZE) {
        const chunk = batch.slice(i, i + FLUSH_BATCH_SIZE);
        try {
          await persister(chunk);
        } catch (err) {
          this.retryAfter = Date.now() + RETRY_BACKOFF_MS;
          this.pending.unshift(...batch.slice(i));
          if (this.pending.length > MAX_PENDING) this.pending.length = MAX_PENDING;
          console.warn(`[logs] Persisting ${batch.length - i} log line(s) failed; retrying: ${(err as Error)?.message || err}`);
          return;
        }
      }
    })();
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
    }
    if (this.pending.length > 0 && !this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, Math.max(FLUSH_INTERVAL_MS, this.retryAfter - Date.now()));
      this.flushTimer.unref?.();
    }
  }

  publish(
    deploymentId: string,
    logLine: { timestamp?: string; stream: "stdout" | "stderr" | "system"; message: string }
  ): LogEntry {
    const entry: LogEntry = {
      id: `log_${randomUUID()}`,
      deploymentId,
      timestamp: logLine.timestamp || new Date().toISOString(),
      stream: logLine.stream,
      message: redactSecrets(logLine.message),
    };

    let buffer = this.ringBuffers.get(deploymentId);
    if (!buffer) {
      buffer = [];
      this.ringBuffers.set(deploymentId, buffer);
      this.evictIdleBuffers();
    }

    buffer.push(entry);
    if (buffer.length > this.maxBufferSize) {
      buffer.shift(); // FIFO eviction
    }

    this.enqueue(entry);

    const listeners = this.subscribers.get(deploymentId);
    if (listeners) {
      listeners.forEach((listener) => {
        try {
          listener(entry);
        } catch (e) {
          console.error("Error in log listener:", e);
        }
      });
    }

    return entry;
  }

  /** In-process error cache; the durable copy is `Deployment.errorMessage` (written by the engine). */
  recordError(deploymentId: string, error: string): void {
    this.errors.set(deploymentId, redactSecrets(error));
  }

  getError(deploymentId: string): string | null {
    return this.errors.get(deploymentId) || null;
  }

  subscribe(deploymentId: string, listener: (log: LogEntry) => void): () => void {
    let listeners = this.subscribers.get(deploymentId);
    if (!listeners) {
      listeners = new Set();
      this.subscribers.set(deploymentId, listeners);
    }
    listeners.add(listener);

    return () => {
      listeners?.delete(listener);
      if (listeners && listeners.size === 0) {
        this.subscribers.delete(deploymentId);
      }
    };
  }

  /** In-process ring buffer only. Use `loadDeploymentLogHistory()` for the durable history. */
  getHistory(deploymentId: string): LogEntry[] {
    return [...(this.ringBuffers.get(deploymentId) || [])];
  }

  clear(deploymentId?: string): void {
    if (deploymentId) {
      this.ringBuffers.delete(deploymentId);
      this.errors.delete(deploymentId);
      this.subscribers.delete(deploymentId);
      this.pending = this.pending.filter((e) => e.deploymentId !== deploymentId);
    } else {
      this.ringBuffers.clear();
      this.errors.clear();
      this.subscribers.clear();
      this.pending = [];
    }
  }
}

// Global singleton (persists across Next.js webpack/worker chunks)
const globalForTelemetry = globalThis as unknown as {
  logEventBus?: LogEventBus;
};

export const logEventBus = globalForTelemetry.logEventBus || new LogEventBus(1000);

globalForTelemetry.logEventBus = logEventBus;
