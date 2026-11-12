/**
 * Durable deployment queue (Team A) — the `DeploymentJob` table.
 *
 * Every deployment gets one `deploy` job row, created before the request returns
 * (`enqueueDeploymentJob`). Two independent leases live on it:
 *  - the **orchestrator lease** (`orchestratorLeaseUntil`): the control-plane function that
 *    runs `executeDeployment` holds it and renews it while polling. When a serverless
 *    invocation dies or hands off, the lease lapses and `recoverStaleDeployments()` resumes it.
 *  - the **runner lease** (`leaseOwner` / `leaseExpiresAt` / `heartbeatAt`): in pull mode
 *    (`RUNNER_QUEUE_MODE=pull`) a runner claims the job over HMAC and heartbeats through
 *    `/api/v1/runner/jobs/:id/events`. An expired runner lease requeues the job.
 *
 * `stop` / `restart` control jobs let pull-mode runners (unreachable from the control plane)
 * execute lifecycle operations. Every helper tolerates a client without the model (mocked
 * Prisma in tests) and never throws for bookkeeping failures.
 */

import { db } from "@/lib/db";
import { logEventBus } from "@/lib/telemetry/event-bus";
import { classifyLogLine, type BuildDispatchParams, type BuildStatusResult, type RunnerBuildStatus } from "./runner-driver";
import { redactSecrets } from "@/lib/telemetry/redact";

type Client = any;

const envMs = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
/** How long a control-plane function owns a deployment without renewing (default 90 s). */
export const orchestratorLeaseMs = () => envMs("DEPLOY_ORCHESTRATOR_LEASE_MS", 90_000);
/** How long a runner owns a claimed job without a heartbeat (default 60 s). */
export const runnerLeaseMs = () => envMs("RUNNER_JOB_LEASE_MS", 60_000);
/** How long `executeDeployment` polls a runner before handing off to recovery (default 240 s, under maxDuration 300). */
export const deployPollBudgetMs = () => envMs("DEPLOY_POLL_BUDGET_MS", 240_000);

const TERMINAL_JOB = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

function jobsModel(client: Client = db): any | null {
  try {
    const model = client?.deploymentJob;
    return model && typeof model.updateMany === "function" ? model : null;
  } catch {
    return null;
  }
}

async function quietly<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    if (process.env.SYNCBAY_DEBUG_JOBS === "true") console.warn("[job-queue]", err?.message);
    return fallback;
  }
}

/** Strips callbacks and keeps a JSON-safe copy of the dispatch params (pull-mode payload). */
export function serializeDispatchParams(params: BuildDispatchParams): Record<string, unknown> {
  const { onLog: _onLog, ...rest } = params;
  return JSON.parse(JSON.stringify({ jobId: params.buildId || params.deploymentId, ...rest }));
}

// ─── Orchestrator side (push and pull) ───────────────────────────────────────

/** Creates (or resets, for a re-run of the same deployment) the deploy job row. */
export async function enqueueDeploymentJob(
  input: { deploymentId: string; buildId: string; serviceId: string; options?: Record<string, unknown> },
  client: Client = db
): Promise<{ id: string } | null> {
  const model = jobsModel(client);
  if (!model?.upsert) return null;
  const options = input.options ? JSON.parse(JSON.stringify(input.options)) : undefined;
  return quietly(
    () =>
      model.upsert({
        where: { deploymentId: input.deploymentId },
        create: { kind: "deploy", mode: "push", status: "PENDING", ...input, options },
        update: {
          status: "PENDING",
          mode: "push",
          buildId: input.buildId,
          options,
          runnerJobId: null,
          payload: null,
          result: null,
          exitCode: null,
          errorMessage: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          orchestratorLeaseUntil: null,
          attempts: 0,
          completedAt: null,
        },
        select: { id: true },
      }),
    null
  );
}

/**
 * Atomically takes the orchestrator lease when it is free or expired. Returns true when this
 * caller now owns the deployment (or no job row exists, i.e. legacy / mocked DB).
 */
export async function acquireOrchestratorLease(deploymentId: string, client: Client = db): Promise<boolean> {
  const model = jobsModel(client);
  if (!model) return true;
  const now = new Date();
  return quietly(async () => {
    const existing = await model.findUnique({ where: { deploymentId }, select: { id: true } });
    if (!existing) return true;
    const res = await model.updateMany({
      where: {
        deploymentId,
        status: { not: "CANCELLED" },
        OR: [{ orchestratorLeaseUntil: null }, { orchestratorLeaseUntil: { lt: now } }],
      },
      data: { orchestratorLeaseUntil: new Date(now.getTime() + orchestratorLeaseMs()) },
    });
    return res.count > 0;
  }, true);
}

export async function renewOrchestratorLease(deploymentId: string, client: Client = db): Promise<void> {
  const model = jobsModel(client);
  if (!model) return;
  await quietly(
    () =>
      model.updateMany({
        where: { deploymentId },
        data: { orchestratorLeaseUntil: new Date(Date.now() + orchestratorLeaseMs()) },
      }),
    null
  );
}

/** Gives up the orchestrator lease so the next recovery sweep resumes the deployment. */
export async function releaseOrchestratorLease(deploymentId: string, client: Client = db): Promise<void> {
  const model = jobsModel(client);
  if (!model) return;
  await quietly(() => model.updateMany({ where: { deploymentId }, data: { orchestratorLeaseUntil: null } }), null);
}

/** Records which driver/runner job is building this deployment (status RUNNING for push). */
export async function markJobDispatched(
  deploymentId: string,
  driverType: string,
  runnerJobId: string,
  client: Client = db
): Promise<void> {
  const model = jobsModel(client);
  if (!model) return;
  const pull = driverType === "queue";
  await quietly(
    () =>
      model.updateMany({
        where: { deploymentId, status: { notIn: ["CANCELLED"] } },
        data: {
          driverType,
          runnerJobId,
          ...(pull ? {} : { status: "RUNNING", mode: "push" }),
          startedAt: new Date(),
          orchestratorLeaseUntil: new Date(Date.now() + orchestratorLeaseMs()),
        },
      }),
    null
  );
}

/** Terminal bookkeeping for a deployment's job. Clears the payload (it can carry env secrets). */
export async function completeDeploymentJob(
  deploymentId: string,
  status: "SUCCEEDED" | "FAILED" | "CANCELLED",
  info: { exitCode?: number; errorMessage?: string; result?: Record<string, unknown> } = {},
  client: Client = db
): Promise<void> {
  const model = jobsModel(client);
  if (!model) return;
  await quietly(
    () =>
      model.updateMany({
        where: { deploymentId },
        data: {
          status,
          exitCode: info.exitCode ?? null,
          errorMessage: info.errorMessage ? redactSecrets(info.errorMessage).slice(0, 4000) : null,
          ...(info.result ? { result: JSON.parse(JSON.stringify(info.result)) } : {}),
          payload: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          orchestratorLeaseUntil: null,
          completedAt: new Date(),
        },
      }),
    null
  );
}

export async function cancelDeploymentJob(deploymentId: string, client: Client = db): Promise<void> {
  const model = jobsModel(client);
  if (!model) return;
  await quietly(
    () =>
      model.updateMany({
        where: { deploymentId, status: { notIn: ["SUCCEEDED", "FAILED", "CANCELLED"] } },
        data: { status: "CANCELLED", payload: null, completedAt: new Date(), orchestratorLeaseUntil: null },
      }),
    null
  );
}

// ─── Pull mode: QueueRunnerDriver + runner endpoints ─────────────────────────

/** Queues the deployment for a pull-mode runner. Returns the job id the engine polls. */
export async function enqueuePullJob(params: BuildDispatchParams, client: Client = db): Promise<string | null> {
  const model = jobsModel(client);
  if (!model?.upsert) return null;
  const payload = serializeDispatchParams(params);
  const job = await model.upsert({
    where: { deploymentId: params.deploymentId },
    create: {
      kind: "deploy",
      mode: "pull",
      status: "QUEUED",
      deploymentId: params.deploymentId,
      buildId: params.buildId,
      serviceId: params.serviceId,
      driverType: "queue",
      payload,
    },
    update: {
      mode: "pull",
      status: "QUEUED",
      driverType: "queue",
      payload,
      leaseOwner: null,
      leaseExpiresAt: null,
      result: null,
      exitCode: null,
      errorMessage: null,
      completedAt: null,
    },
    select: { id: true },
  });
  await model.update({ where: { id: job.id }, data: { runnerJobId: job.id } }).catch(() => null);
  return job.id;
}

/** Queues a `stop` / `restart` for the runner that hosts the container. */
export async function enqueueControlJob(
  kind: "stop" | "restart",
  containerId: string,
  opts: { serviceId?: string; targetRunnerId?: string | null } = {},
  client: Client = db
): Promise<string | null> {
  const model = jobsModel(client);
  if (!model?.create) return null;
  return quietly(async () => {
    const job = await model.create({
      data: {
        kind,
        mode: "pull",
        status: "QUEUED",
        serviceId: opts.serviceId,
        driverType: "queue",
        targetContainerId: containerId,
        targetRunnerId: opts.targetRunnerId ?? null,
      },
      select: { id: true },
    });
    return job.id as string;
  }, null);
}

/** Runner id that ran the deploy job owning `containerId` (control jobs are routed to it). */
export async function findRunnerForContainer(containerId: string, client: Client = db): Promise<string | null> {
  const model = jobsModel(client);
  if (!model) return null;
  return quietly(async () => {
    const rows = await model.findMany({
      where: { kind: "deploy", runnerId: { not: null }, result: { path: ["containerId"], equals: containerId } },
      orderBy: { updatedAt: "desc" },
      take: 1,
      select: { runnerId: true },
    });
    return rows[0]?.runnerId ?? null;
  }, null);
}

const JOB_TO_BUILD_STATUS: Record<string, RunnerBuildStatus> = {
  PENDING: "QUEUED",
  QUEUED: "QUEUED",
  RUNNING: "BUILDING",
  SUCCEEDED: "ACTIVE",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
};

/** QueueRunnerDriver.checkStatus(): the job row as the runner last reported it. */
export async function getQueueJobStatus(jobId: string, client: Client = db): Promise<BuildStatusResult | null> {
  const model = jobsModel(client);
  if (!model?.findUnique) return null;
  const job = await model.findUnique({ where: { id: jobId } });
  if (!job) return null;
  const result = (job.result || {}) as Record<string, any>;
  return {
    jobId,
    status: JOB_TO_BUILD_STATUS[job.status] || "QUEUED",
    exitCode: typeof job.exitCode === "number" ? job.exitCode : undefined,
    containerId: result.containerId,
    port: result.port,
    startedAt: job.startedAt || undefined,
    completedAt: job.completedAt || undefined,
    errorMessage: job.errorMessage || undefined,
    metadata: {
      simulated: Boolean(result.simulated),
      ...(typeof result.containerPort === "number" ? { containerPort: result.containerPort } : {}),
      // The runner probes the app before it reports success; without RUNNER_URL the
      // control plane has no network path of its own to the runner host.
      healthVerifiedByRunner: job.status === "SUCCEEDED",
      runnerId: job.runnerId,
    },
  };
}

export interface ClaimedJob {
  id: string;
  kind: string;
  deploymentId: string | null;
  payload: Record<string, unknown> | null;
  targetContainerId: string | null;
  leaseExpiresAt: Date;
  attempts: number;
}

/** Atomically claims the oldest queued pull job for `runnerId` (FOR UPDATE SKIP LOCKED). */
export async function claimNextJob(runnerId: string, client: Client = db): Promise<ClaimedJob | null> {
  if (typeof client?.$queryRawUnsafe !== "function") return null;
  const leaseExpiresAt = new Date(Date.now() + runnerLeaseMs());
  const rows: ClaimedJob[] = await client.$queryRawUnsafe(
    `UPDATE "deployment_jobs"
        SET "status" = 'RUNNING', "leaseOwner" = $1, "runnerId" = $1, "leaseExpiresAt" = $2,
            "heartbeatAt" = $3, "attempts" = "attempts" + 1, "startedAt" = COALESCE("startedAt", $3), "updatedAt" = $3
      WHERE "id" = (
        SELECT "id" FROM "deployment_jobs"
         WHERE "status" = 'QUEUED' AND "mode" = 'pull'
           AND ("targetRunnerId" IS NULL OR "targetRunnerId" = $1)
         ORDER BY "createdAt" ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
      RETURNING "id", "kind", "deploymentId", "payload", "targetContainerId", "leaseExpiresAt", "attempts"`,
    runnerId,
    leaseExpiresAt,
    new Date()
  );
  return rows[0] ?? null;
}

export interface RunnerEventBody {
  runnerId?: string;
  logs?: string[];
  status?: "RUNNING" | "SUCCEEDED" | "FAILED";
  result?: {
    containerId?: string;
    port?: number;
    exitCode?: number;
    error?: string;
    simulated?: boolean;
    runnerJobId?: string;
    [key: string]: unknown;
  };
}

/**
 * Applies a runner's progress report: relays log lines, renews the lease, and records the
 * terminal result. Only the lease holder may report. Returns an HTTP status + JSON body.
 */
export async function recordRunnerEvents(
  jobId: string,
  body: RunnerEventBody,
  client: Client = db
): Promise<{ status: number; body: Record<string, unknown> }> {
  const model = jobsModel(client);
  if (!model) return { status: 503, body: { error: "Job queue unavailable" } };
  const runnerId = typeof body.runnerId === "string" ? body.runnerId : "";
  const job = await model.findUnique({ where: { id: jobId } });
  if (!job) return { status: 404, body: { error: "Job not found" } };
  if (job.status === "CANCELLED") return { status: 200, body: { ok: true, cancelled: true } };
  if (TERMINAL_JOB.has(job.status)) return { status: 200, body: { ok: true, duplicate: true } };
  if (!runnerId || job.leaseOwner !== runnerId || job.status !== "RUNNING") {
    return { status: 409, body: { error: "Lease not held by this runner" } };
  }

  const logs = Array.isArray(body.logs) ? body.logs.filter((l) => typeof l === "string").slice(0, 500) : [];
  if (job.deploymentId) {
    for (const line of logs) {
      logEventBus.publish(job.deploymentId, {
        stream: classifyLogLine(line),
        message: line,
        timestamp: new Date().toISOString(),
      });
    }
  }

  const now = new Date();
  const terminal = body.status === "SUCCEEDED" || body.status === "FAILED";
  const result = body.result ? JSON.parse(JSON.stringify(body.result)) : undefined;
  const leaseExpiresAt = new Date(now.getTime() + runnerLeaseMs());
  const res = await model.updateMany({
    where: { id: jobId, leaseOwner: runnerId, status: "RUNNING" },
    data: terminal
      ? {
          status: body.status,
          result,
          exitCode: typeof body.result?.exitCode === "number" ? body.result.exitCode : body.status === "SUCCEEDED" ? 0 : 1,
          errorMessage: body.result?.error ? redactSecrets(String(body.result.error)).slice(0, 4000) : null,
          payload: null,
          leaseExpiresAt: null,
          heartbeatAt: now,
          completedAt: now,
        }
      : { heartbeatAt: now, leaseExpiresAt },
  });
  if (res.count === 0) return { status: 409, body: { error: "Lease lost" } };
  // A restarted instance has a new id/port: keep the deployment pointing at it.
  if (job.kind === "restart" && body.status === "SUCCEEDED" && body.result?.containerId && job.targetContainerId) {
    await quietly(
      () =>
        client.deployment.updateMany({
          where: { cfContainerId: job.targetContainerId },
          data: { cfContainerId: body.result!.containerId, ...(body.result!.port ? { assignedPort: body.result!.port } : {}) },
        }),
      null
    );
  }
  return { status: 200, body: { ok: true, cancelled: false, leaseExpiresAt: terminal ? null : leaseExpiresAt.toISOString() } };
}
