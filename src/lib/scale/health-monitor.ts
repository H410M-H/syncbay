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

import { db } from "@/lib/db";
import { logEventBus } from "@/lib/telemetry/event-bus";
import { restartServiceInstance } from "@/lib/orchestrator/lifecycle";
import { checkRunnerHealth, getRunnerConfigStatus } from "@/lib/orchestrator/runner-config";

const FAILURES_BEFORE_HEAL = 2;
const HEAL_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_HEALS_PER_RUN = 3;
const PROBE_TIMEOUT_MS = 8000;
const PROBE_CONCURRENCY = 8;
const IN_FLIGHT = ["QUEUED", "BUILDING", "DEPLOYING"];

type ProbeFn = (port: number, runnerDriver: string | null) => Promise<{ ok: boolean; status?: number; error?: string }>;

export interface HealthReport {
  skipped?: string;
  probed: number;
  healthy: number;
  failing: Array<{ serviceId: string; deploymentId: string; failures: number; error?: string }>;
  healed: Array<{ serviceId: string; deploymentId: string; mode: string; message?: string }>;
}

/** Probes one instance through the path visitors use. */
const defaultProbe: ProbeFn = async (port, runnerDriver) => {
  const runnerUrl = process.env.RUNNER_URL?.replace(/\/$/, "");
  const viaRunner = Boolean(runnerUrl) && runnerDriver !== "local";
  const url = viaRunner ? `${runnerUrl}/` : `http://127.0.0.1:${port}/`;
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
};

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
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { id: true, status: true, assignedPort: true, runnerDriver: true, healthFailures: true, completedAt: true },
      },
    },
    take: 500,
  });

  const targets = services
    .map((s) => {
      // A deploy in progress is the engine's business; its own probe decides.
      if (s.deployments.some((d) => IN_FLIGHT.includes(d.status))) return null;
      const live = s.deployments.find((d) => d.status === "ACTIVE" && d.assignedPort);
      // Give a fresh instance a minute to settle.
      if (!live || (live.completedAt && now - live.completedAt.getTime() < 60_000)) return null;
      return { service: s, live };
    })
    .filter((t): t is NonNullable<typeof t> => t !== null);

  const probe = options.probe ?? defaultProbe;
  const results = await mapLimit(targets, PROBE_CONCURRENCY, async (t) => ({ t, res: await probe(t.live.assignedPort!, t.live.runnerDriver) }));

  let heals = 0;
  for (const { t, res } of results) {
    report.probed += 1;
    const at = new Date(now);
    if (res.ok) {
      report.healthy += 1;
      await db.deployment.update({ where: { id: t.live.id }, data: { healthFailures: 0, lastProbeAt: at, lastHealthyAt: at } }).catch(() => null);
      continue;
    }
    const failures = (t.live.healthFailures ?? 0) + 1;
    await db.deployment.update({ where: { id: t.live.id }, data: { healthFailures: failures, lastProbeAt: at } }).catch(() => null);
    report.failing.push({ serviceId: t.service.id, deploymentId: t.live.id, failures, error: res.error });
    if (failures < FAILURES_BEFORE_HEAL) continue;
    if (t.service.lastAutoHealAt && now - t.service.lastAutoHealAt.getTime() < HEAL_COOLDOWN_MS) continue;
    if (heals >= MAX_HEALS_PER_RUN) continue;

    // Claim the heal so two overlapping cron runs cannot both act on this service.
    const claimed = await db.service.updateMany({
      where: { id: t.service.id, OR: [{ lastAutoHealAt: null }, { lastAutoHealAt: { lt: new Date(now - HEAL_COOLDOWN_MS) } }] },
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
