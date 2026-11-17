/**
 * Syncbay PaaS — health monitor (run by the every-minute cron).
 *
 * Every live instance (newest ACTIVE deployment of a running service) is probed over HTTP the way
 * visitors reach it: through the runner's proxy (`RUNNER_URL` + `x-target-port`) or, for the local
 * driver, directly. Any HTTP answer below 500 counts as alive. After `FAILURES_BEFORE_HEAL`
 * consecutive failed probes the instance is healed with the lifecycle's own restart path
 * (`restartServiceInstance`: restart in place, else redeploy the same build).
 *
 * Safeguards:
 * - Nothing is healed while the runner itself does not answer `/health` (a runner outage is not
 *   an app crash, and restarting would only add load).
 * - One heal per service per `HEAL_COOLDOWN_MS`; at most `MAX_HEALS_PER_RUN` heals per run.
 * - Paused, taken-down, suspended or still-deploying services are never touched.
 * Every heal is written to the deployment's log and the customer's audit log.
 */

import type { DeploymentStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { logEventBus } from "@/lib/telemetry/event-bus";
import { restartServiceInstance } from "@/lib/orchestrator/lifecycle";
import { checkRunnerHealth, getRunnerConfigStatus } from "@/lib/orchestrator/runner-config";

const FAILURES_BEFORE_HEAL = 2;
const HEAL_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_HEALS_PER_RUN = 3;
const PROBE_TIMEOUT_MS = 8000;
const PROBE_CONCURRENCY = 8;
/** Stop starting probes after this long; the cron function has 300 s in total. */
const PROBE_DEADLINE_MS = 150_000;
const IN_FLIGHT: DeploymentStatus[] = ["QUEUED", "BUILDING", "DEPLOYING"];

type ProbeFn = (port: number, runnerDriver: string | null) => Promise<{ ok: boolean; status?: number; error?: string }>;

export interface HealthReport {
  skipped?: string;
  probed: number;
  healthy: number;
  failing: Array<{ serviceId: string; deploymentId: string; failures: number; error?: string }>;
  healed: Array<{ serviceId: string; deploymentId: string; mode: string; message?: string }>;
}

/**
 * Probes one instance through the path visitors use, the way the engine accepted it at deploy
 * time: `/health`, then `/`. Alive as soon as either answers below 500, so an app whose home page
 * fails while `/health` answers is not restarted over and over.
 */
const defaultProbe: ProbeFn = async (port, runnerDriver) => {
  let last: { ok: boolean; status?: number; error?: string } = { ok: false, error: "unreachable" };
  for (const p of ["/health", "/"]) {
    last = await probeOnce(port, runnerDriver, p);
    if (last.ok) return last;
  }
  return last;
};

async function probeOnce(port: number, runnerDriver: string | null, probePath: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  const runnerUrl = process.env.RUNNER_URL?.replace(/\/$/, "");
  const viaRunner = Boolean(runnerUrl) && runnerDriver !== "local";
  const url = viaRunner ? `${runnerUrl}${probePath}` : `http://127.0.0.1:${port}${probePath}`;
  try {
    const res = await fetch(url, {
      headers: viaRunner ? { "x-target-port": String(port), "user-agent": "syncbay-health-monitor" } : { "user-agent": "syncbay-health-monitor" },
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => undefined);
    return { ok: res.status < 500, status: res.status, error: res.status >= 500 ? `HTTP ${res.status}` : undefined };
  } catch (err) {
    const e = err as { name?: string; message?: string; cause?: { code?: string } };
    return { ok: false, error: e?.name === "TimeoutError" ? `no answer within ${PROBE_TIMEOUT_MS / 1000}s` : e?.cause?.code || e?.message || "unreachable" };
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

export async function monitorServiceHealth(options: { now?: number; probe?: ProbeFn; checkRunner?: () => Promise<{ online: boolean }> } = {}): Promise<HealthReport> {
  const now = options.now ?? Date.now();
  const report: HealthReport = { probed: 0, healthy: 0, failing: [], healed: [] };

  const config = getRunnerConfigStatus();
  if (config.problem) return { ...report, skipped: "runner not configured" };
  // Simulated runners have no real instances; SSH runners serve apps on another host that the
  // control plane cannot reach on 127.0.0.1. Probing either would "heal" healthy services forever.
  if (config.mode === "simulated") return { ...report, skipped: "simulated runner: no real instances" };
  if (config.mode === "ssh" && !process.env.RUNNER_URL) return { ...report, skipped: "ssh runner without RUNNER_URL: no probe path" };
  if (config.mode === "queue" && !process.env.RUNNER_URL) return { ...report, skipped: "pull-mode runner without RUNNER_URL: no probe path" };
  if (process.env.RUNNER_URL) {
    const runner = await (options.checkRunner ?? checkRunnerHealth)().catch(() => ({ online: false }));
    if (!runner.online) return { ...report, skipped: "runner offline: not healing apps during a runner outage" };
  }

  const services = await db.service.findMany({
    where: {
      deletedAt: null,
      isPaused: false,
      moderationLockedAt: null,
      environment: { project: { deletedAt: null, workspace: { suspendedAt: null } } },
      deployments: { some: { status: "ACTIVE", assignedPort: { not: null } } },
    },
    select: {
      id: true,
      name: true,
      lastAutoHealAt: true,
      environment: { select: { project: { select: { workspaceId: true } } } },
      deployments: {
        where: { status: { in: ["ACTIVE" as DeploymentStatus, ...IN_FLIGHT] } },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { id: true, status: true, assignedPort: true, runnerDriver: true, healthFailures: true, completedAt: true },
      },
    },
    // Least recently healed first, so services beyond the cap are not always the same ones.
    orderBy: { lastAutoHealAt: { sort: "asc", nulls: "first" } },
    take: 500,
  });

  const targets = services
    .map((s) => {
      // A deploy in progress is the engine's business; its own probe decides.
      if (s.deployments.some((d) => IN_FLIGHT.includes(d.status))) return null;
      const live = s.deployments.find((d) => d.status === "ACTIVE" && d.assignedPort);
      // Pull-mode instances may live on any of several runners; RUNNER_URL reaches only one of them.
      if (live?.runnerDriver === "queue") return null;
      // Give a fresh instance a minute to settle.
      if (!live || (live.completedAt && now - live.completedAt.getTime() < 60_000)) return null;
      return { service: s, live };
    })
    .filter((t): t is NonNullable<typeof t> => t !== null);

  const probe = options.probe ?? defaultProbe;
  const startedAt = Date.now();
  // Each result is stored as soon as it is known, and no new probe starts after the deadline, so a
  // run cut short by the function time limit still records what it learned.
  const results = await mapLimit(targets, PROBE_CONCURRENCY, async (t) => {
    if (Date.now() - startedAt > PROBE_DEADLINE_MS) return null;
    const res = await probe(t.live.assignedPort!, t.live.runnerDriver);
    const at = new Date(now);
    const failures = res.ok ? 0 : (t.live.healthFailures ?? 0) + 1;
    await db.deployment
      .update({ where: { id: t.live.id }, data: res.ok ? { healthFailures: 0, lastProbeAt: at, lastHealthyAt: at } : { healthFailures: failures, lastProbeAt: at } })
      .catch(() => null);
    return { t, res, failures };
  });

  let heals = 0;
  for (const item of results) {
    if (!item) continue;
    const { t, res, failures } = item;
    report.probed += 1;
    const at = new Date(now);
    if (res.ok) {
      report.healthy += 1;
      continue;
    }
    report.failing.push({ serviceId: t.service.id, deploymentId: t.live.id, failures, error: res.error });
    if (failures < FAILURES_BEFORE_HEAL) continue;
    if (t.service.lastAutoHealAt && now - t.service.lastAutoHealAt.getTime() < HEAL_COOLDOWN_MS) continue;
    if (heals >= MAX_HEALS_PER_RUN) continue;

    // Claim the heal so two overlapping cron runs cannot both act on this service.
    // The claim re-checks what the probe snapshot assumed: probing can take minutes, and in that time
    // the user may have paused the service or started a deploy. Healing then would resume a paused
    // service or put an old build back over the new release.
    const claimed = await db.service.updateMany({
      where: {
        id: t.service.id,
        deletedAt: null,
        isPaused: false,
        moderationLockedAt: null,
        deployments: { some: { id: t.live.id, status: "ACTIVE" }, none: { status: { in: IN_FLIGHT } } },
        OR: [{ lastAutoHealAt: null }, { lastAutoHealAt: { lt: new Date(now - HEAL_COOLDOWN_MS) } }],
      },
      data: { lastAutoHealAt: at },
    });
    if (claimed.count === 0) continue;
    heals += 1;

    const line = `[health] ${t.service.name} did not answer ${failures} probes in a row (${res.error ?? "error"}); restarting it automatically`;
    logEventBus.publish(t.live.id, { stream: "system", message: line });
    let outcome: { mode: string; message?: string };
    try {
      const restart = await restartServiceInstance(t.service.id, undefined, db);
      outcome = { mode: restart.mode, message: restart.message };
      await db.deployment.update({ where: { id: t.live.id }, data: { healthFailures: 0 } }).catch(() => null);
    } catch (err) {
      outcome = { mode: "failed", message: (err as Error)?.message };
    }
    logEventBus.publish(t.live.id, { stream: "system", message: `[health] automatic recovery: ${outcome.mode}${outcome.message ? ` (${outcome.message})` : ""}` });
    const workspaceId = t.service.environment?.project?.workspaceId;
    if (workspaceId) {
      await db.auditLogEntry
        .create({ data: { workspaceId, action: "service.auto_healed", metadata: { serviceId: t.service.id, deploymentId: t.live.id, failures, error: res.error ?? null, result: outcome.mode } } })
        .catch(() => null);
    }
    report.healed.push({ serviceId: t.service.id, deploymentId: t.live.id, ...outcome });
  }
  await logEventBus.flush().catch(() => undefined);
  return report;
}
