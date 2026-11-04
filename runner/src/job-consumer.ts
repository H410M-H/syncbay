/**
 * Pull-mode queue consumer (`RUNNER_QUEUE_MODE=pull`).
 *
 * For runners the control plane cannot reach (no tunnel / behind NAT): the runner claims work
 * from the control plane's `DeploymentJob` queue and reports back.
 *  - `POST {SYNCBAY_API_URL}/api/v1/runner/jobs/claim`        body `{ runnerId }` → 200 `{ job }` | 204
 *  - `POST {SYNCBAY_API_URL}/api/v1/runner/jobs/:id/events`   body `{ runnerId, logs?, status?, result? }`
 * Both are signed exactly like control plane → runner requests: HMAC-SHA256 over
 * `${ts}.${nonce}.POST.${pathname}.${body}` in `X-Syncbay-Signature` / `-Timestamp` / `-Nonce`
 * (a fresh 16-byte nonce per request; the control plane accepts each nonce once).
 * Events double as the lease heartbeat; the response says when the job was cancelled.
 */

import * as crypto from "node:crypto";
import * as os from "node:os";

interface ConsumerJobState {
  jobId: string;
  status: string;
  logs: string[];
  containerId?: string;
  assignedPort?: number;
  error?: string;
  exitCode?: number;
  simulated?: boolean;
}

export interface PullDaemon {
  startJob(params: any): { job: ConsumerJobState; done: Promise<void> };
  stopInstance(containerId: string): Promise<{ stopped: boolean; releasedPort?: number }>;
  restartInstance(containerId: string): Promise<{ restarted: boolean; containerId: string; port?: number; error?: string }>;
}

export interface JobPullConsumerOptions {
  apiUrl: string;
  secret: string;
  daemon: PullDaemon;
  runnerId?: string;
  pollIntervalMs?: number;
  /** Max interval between lease heartbeats while a job runs (default 15 s). */
  heartbeatMs?: number;
  /** How often new log lines are flushed (default 1 s). */
  flushMs?: number;
  fetchFn?: typeof fetch;
}

interface ClaimedJob {
  id: string;
  kind: "deploy" | "stop" | "restart";
  deploymentId?: string | null;
  payload?: Record<string, any> | null;
  targetContainerId?: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class JobPullConsumer {
  public readonly runnerId: string;
  private readonly apiUrl: string;
  private readonly secret: string;
  private readonly daemon: PullDaemon;
  private readonly pollIntervalMs: number;
  private readonly heartbeatMs: number;
  private readonly flushMs: number;
  private readonly fetchFn: typeof fetch;
  private running = false;
  private loop: Promise<void> | null = null;

  constructor(opts: JobPullConsumerOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
    this.secret = opts.secret;
    this.daemon = opts.daemon;
    this.runnerId = opts.runnerId || process.env.RUNNER_ID || os.hostname();
    this.pollIntervalMs = opts.pollIntervalMs ?? 5000;
    this.heartbeatMs = opts.heartbeatMs ?? 15000;
    this.flushMs = opts.flushMs ?? 1000;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    console.log(`[runner-pull] Consumer ${this.runnerId} polling ${this.apiUrl} every ${this.pollIntervalMs}ms`);
    this.loop = (async () => {
      while (this.running) {
        let worked = false;
        try {
          worked = await this.tick();
        } catch (err: any) {
          console.warn(`[runner-pull] ${err?.message || err}`);
        }
        if (!worked && this.running) await sleep(this.pollIntervalMs);
      }
    })();
  }

  public async stop(): Promise<void> {
    this.running = false;
    await this.loop?.catch(() => null);
    this.loop = null;
  }

  /** Claims and fully processes at most one job. Returns true when a job was processed. */
  public async tick(): Promise<boolean> {
    const job = await this.claim();
    if (!job) return false;
    if (job.kind === "stop" || job.kind === "restart") {
      await this.runControlJob(job);
    } else {
      await this.runDeployJob(job);
    }
    return true;
  }

  private async post(pathname: string, payload: Record<string, unknown>): Promise<Response> {
    const url = `${this.apiUrl}${pathname}`;
    const signedPath = new URL(url).pathname;
    const body = JSON.stringify(payload);
    const ts = Date.now().toString();
    const nonce = crypto.randomBytes(16).toString("hex");
    const sig = crypto.createHmac("sha256", this.secret).update(`${ts}.${nonce}.POST.${signedPath}.${body}`).digest("hex");
    return this.fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Syncbay-Signature": `sha256=${sig}`,
        "X-Syncbay-Timestamp": ts,
        "X-Syncbay-Nonce": nonce,
      },
      body,
      signal: AbortSignal.timeout(15000),
    });
  }

  private async claim(): Promise<ClaimedJob | null> {
    const res = await this.post("/api/v1/runner/jobs/claim", { runnerId: this.runnerId });
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`claim failed (HTTP ${res.status})`);
    const data = (await res.json().catch(() => ({}))) as { job?: ClaimedJob };
    return data.job ?? null;
  }

  /** Sends a progress report. Returns the parsed response, or null when the lease is gone. */
  private async report(jobId: string, event: Record<string, unknown>): Promise<{ cancelled?: boolean } | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.post(`/api/v1/runner/jobs/${encodeURIComponent(jobId)}/events`, {
          runnerId: this.runnerId,
          ...event,
        });
        if (res.status === 409 || res.status === 404) return null;
        if (res.ok) return (await res.json().catch(() => ({}))) as { cancelled?: boolean };
      } catch {
        // retry below
      }
      await sleep(500 * 2 ** attempt);
    }
    return {};
  }

  private async runControlJob(job: ClaimedJob): Promise<void> {
    const target = job.targetContainerId || "";
    if (job.kind === "stop") {
      const res = await this.daemon.stopInstance(target);
      await this.report(job.id, {
        status: "SUCCEEDED",
        result: { containerId: target, stopped: res.stopped, releasedPort: res.releasedPort },
      });
      return;
    }
    const res = await this.daemon.restartInstance(target);
    await this.report(job.id, {
      status: res.restarted ? "SUCCEEDED" : "FAILED",
      result: { containerId: res.containerId, port: res.port, restarted: res.restarted, previousContainerId: target, error: res.error },
    });
  }

  private async runDeployJob(job: ClaimedJob): Promise<void> {
    const params = { ...(job.payload || {}), deploymentId: job.deploymentId ?? job.payload?.deploymentId };
    const { job: state, done } = this.daemon.startJob(params);
    let sent = 0;
    let lastReport = Date.now();
    let finished = false;
    let cancelled = false;
    void done.finally(() => {
      finished = true;
    });

    while (!finished && !cancelled) {
      await Promise.race([done, sleep(this.flushMs)]);
      const lines = state.logs.slice(sent);
      if (finished) break;
      if (lines.length === 0 && Date.now() - lastReport < this.heartbeatMs) continue;
      const res = await this.report(job.id, { logs: lines });
      sent += lines.length;
      lastReport = Date.now();
      if (res === null || res.cancelled) cancelled = true;
    }

    if (cancelled) {
      await done.catch(() => null);
      if (state.containerId) await this.daemon.stopInstance(state.containerId).catch(() => null);
      console.log(`[runner-pull] Job ${job.id} was cancelled or its lease was lost; instance stopped`);
      return;
    }

    const ok = state.status === "ACTIVE";
    const res = await this.report(job.id, {
      logs: state.logs.slice(sent),
      status: ok ? "SUCCEEDED" : "FAILED",
      result: {
        runnerJobId: state.jobId,
        containerId: state.containerId,
        port: state.assignedPort,
        exitCode: state.exitCode ?? (ok ? 0 : 1),
        error: state.error,
        simulated: Boolean(state.simulated),
      },
    });
    // Cancelled while finishing: do not leave an orphaned instance running.
    if ((res === null || res.cancelled) && state.containerId) {
      await this.daemon.stopInstance(state.containerId).catch(() => null);
    }
  }
}
