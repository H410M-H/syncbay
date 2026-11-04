/**
 * Syncbay PaaS — Deployment log SSE stream (`/api/deployments/:id/logs/stream`).
 *
 * 1. Replays the persisted history (`DeploymentLog`) plus any in-process lines
 *    that have not been flushed yet.
 * 2. Follows new lines: live from the in-process `logEventBus`, and by tailing
 *    the DB (seq > last) so lines written by another instance arrive too.
 * 3. When neither the DB nor the bus has anything for the deployment and a
 *    runner is configured, it proxies the runner's signed
 *    `GET /api/builds/:id/logs` SSE instead.
 * It also emits `event: status` whenever the deployment status changes.
 * Nothing is ever synthesised.
 */

import { db } from "@/lib/db";
import { logEventBus, type LogEntry } from "@/lib/telemetry/event-bus";
import { loadPersistedLogs } from "@/lib/telemetry/log-store";
import { getRunnerBaseUrl } from "@/lib/runner-client";
import { resolveRunnerSecret, signRequest } from "@/lib/orchestrator/runner-driver";

/** Returns the deployment when `userId` is a member of its workspace. */
export async function findAccessibleDeployment(deploymentId: string, userId: string) {
  return db.deployment.findFirst({
    where: {
      id: deploymentId,
      service: {
        environment: {
          project: { workspace: { members: { some: { userId } } } },
        },
      },
    },
    select: { id: true, serviceId: true, status: true, cfContainerId: true },
  });
}

/** Same stream classification the engine applies to relayed runner lines. */
export function classifyLogLine(line: string): LogEntry["stream"] {
  const trimmed = line.trim();
  if (
    /\[(build|app|runner):error\]|\[app:stderr\]|\[error\]/.test(trimmed) ||
    trimmed.startsWith("Error:") ||
    /error:\s+/i.test(trimmed)
  ) {
    return "stderr";
  }
  if (/^\[(pipeline|runner|build|deploy|proxy|syncbay|health|env)\]/.test(trimmed)) return "system";
  return "stdout";
}

interface StreamOptions {
  deploymentId: string;
  signal: AbortSignal;
  /** DB tail + status poll interval. */
  pollMs?: number;
  /** Proxy the runner SSE when there is no local or persisted history (default true). */
  allowRunnerProxy?: boolean;
  fetchFn?: typeof fetch;
}

function runnerCredentials(): { base: string; secret: string } | null {
  const base = getRunnerBaseUrl();
  if (!base) return null;
  try {
    return { base, secret: resolveRunnerSecret() };
  } catch {
    return null;
  }
}

/** Parses an SSE byte stream into `{ event, data }` messages. */
async function* readSse(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, "");
        let event = "message";
        const data: string[] = [];
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (data.length) yield { event, data: data.join("\n") };
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

export function createDeploymentLogStream(options: StreamOptions): ReadableStream<Uint8Array> {
  const { deploymentId, signal } = options;
  const pollMs = options.pollMs ?? 2000;
  const fetchFn = options.fetchFn ?? fetch;
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      // Ids already sent, and messages the runner proxy sent (so DB rows relayed
      // from the same runner job are not shown twice).
      const sentIds = new Set<string>();
      const runnerMessages = new Map<string, number>();
      let lastSeq = -1;
      let mode: "bus" | "runner" = "bus";

      const emit = (entry: LogEntry) => {
        if (sentIds.has(entry.id)) return;
        const fromRunner = runnerMessages.get(entry.message);
        if (fromRunner) {
          runnerMessages.set(entry.message, fromRunner - 1);
          sentIds.add(entry.id);
          return;
        }
        sentIds.add(entry.id);
        if (typeof entry.seq === "number" && entry.seq > lastSeq) lastSeq = entry.seq;
        send(`data: ${JSON.stringify(entry)}\n\n`);
      };

      send(`: connected\n\n`);

      // Subscribe first so nothing published during the replay is missed.
      const live: LogEntry[] = [];
      let replaying = true;
      const unsubscribe = logEventBus.subscribe(deploymentId, (entry) => {
        if (mode !== "bus") return;
        if (replaying) live.push(entry);
        else emit(entry);
      });

      let persisted: LogEntry[] = [];
      try {
        persisted = await loadPersistedLogs(deploymentId);
      } catch {
        persisted = [];
      }
      const inProcess = logEventBus.getHistory(deploymentId);
      for (const entry of persisted) emit(entry);
      for (const entry of inProcess) emit(entry);
      replaying = false;
      for (const entry of live) emit(entry);
      live.length = 0;

      // Nothing local or persisted: follow the runner's own job log stream.
      const runner = options.allowRunnerProxy === false ? null : runnerCredentials();
      if (persisted.length === 0 && inProcess.length === 0 && runner) {
        mode = "runner";
        void (async () => {
          const apiPath = `/api/builds/${encodeURIComponent(deploymentId)}/logs`;
          try {
            const { headers } = signRequest(runner.secret, "GET", apiPath, deploymentId);
            const res = await fetchFn(`${runner.base}${apiPath}`, {
              headers: { ...headers, Accept: "text/event-stream" },
              signal,
              cache: "no-store",
            });
            if (!res.ok || !res.body) throw new Error(`runner HTTP ${res.status}`);
            let n = 0;
            for await (const msg of readSse(res.body, signal)) {
              if (msg.event === "done") break;
              if (msg.event !== "message") continue;
              let payload: { message?: string; timestamp?: string } = {};
              try {
                payload = JSON.parse(msg.data);
              } catch {
                payload = { message: msg.data };
              }
              const message = String(payload.message ?? "");
              runnerMessages.set(message, (runnerMessages.get(message) || 0) + 1);
              send(
                `data: ${JSON.stringify({
                  id: `runner_${deploymentId}_${n++}`,
                  deploymentId,
                  timestamp: payload.timestamp || new Date().toISOString(),
                  stream: classifyLogLine(message),
                  message,
                } satisfies LogEntry)}\n\n`
              );
            }
          } catch {
            // Runner unknown/unreachable: fall back to following the bus and the DB.
          } finally {
            mode = "bus";
          }
        })();
      }

      // DB tail (cross-instance lines) + `status` events.
      let lastStatus: string | null = null;
      let busy = false;
      const poll = async () => {
        if (busy || closed) return;
        busy = true;
        try {
          if (mode === "bus") {
            const rows = await loadPersistedLogs(deploymentId, { afterSeq: lastSeq, limit: 1000 });
            for (const row of rows) emit(row);
            for (const row of rows) if (typeof row.seq === "number" && row.seq > lastSeq) lastSeq = row.seq;
          }
          const row = await db.deployment.findUnique({ where: { id: deploymentId }, select: { status: true } });
          if (row?.status && row.status !== lastStatus) {
            lastStatus = row.status;
            send(
              `event: status\ndata: ${JSON.stringify({ deploymentId, status: row.status, timestamp: new Date().toISOString() })}\n\n`
            );
          }
        } catch {
          // DB unavailable; retry next tick
        } finally {
          busy = false;
        }
      };
      void poll();
      const pollInterval = setInterval(poll, pollMs);
      const pingInterval = setInterval(() => send(`: ping\n\n`), 15000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(pollInterval);
        clearInterval(pingInterval);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      if (signal.aborted) cleanup();
      else signal.addEventListener("abort", cleanup, { once: true });
    },
  });
}
