/**
 * Syncbay PaaS — live dashboard analytics (Team B, v1.2).
 *
 * Every procedure is scoped to the caller's workspace memberships (optionally narrowed to one
 * workspace or service; a workspace/service the caller cannot read is NOT_FOUND). Counts use
 * the latest deployment per non-deleted service in non-deleted projects; traffic comes from
 * `TrafficSample` (runner proxy counters), resources from `MetricSample`, cost from the shared
 * metering / rate card. Nothing here is simulated.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import type { TRPCContext } from "@/server/trpc";
import {
  countProjects,
  countServiceStates,
  deployStats,
  deploymentTimeline,
  latestServiceStates,
  liveResourceSummary,
  serviceState,
} from "@/lib/analytics/overview";
import { trafficReport, type ServiceRef } from "@/lib/analytics/traffic";
import { workspaceUsageTotals } from "@/lib/usage/metering";
import { checkRunnerHealth, getRunnerConfigStatus, type RunnerHealth } from "@/lib/telemetry/runner-status";

type Db = TRPCContext["db"];

interface Scope {
  workspaces: Array<{ id: string; name: string; slug: string; role: string; spendingCapCents: number | null; spendCapReachedAt: Date | null }>;
  ids: string[];
}

async function resolveScope(db: Db, userId: string, workspaceId?: string): Promise<Scope> {
  const memberships = await db.workspaceMember.findMany({
    where: { userId, ...(workspaceId ? { workspaceId } : {}) },
    select: {
      role: true,
      workspace: { select: { id: true, name: true, slug: true, spendingCapCents: true, spendCapReachedAt: true } },
    },
    orderBy: { joinedAt: "asc" },
  });
  if (workspaceId && memberships.length === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });
  const workspaces = memberships.map((m) => ({ ...m.workspace, role: m.role }));
  return { workspaces, ids: workspaces.map((w) => w.id) };
}

// The dashboard polls every 15 s; one runner /health probe per instance per 10 s is plenty.
const RUNNER_HEALTH_TTL_MS = 10_000;
let runnerHealthCache: { at: number; value: Promise<RunnerHealth> } | null = null;
function cachedRunnerHealth(): Promise<RunnerHealth> {
  const now = Date.now();
  if (!runnerHealthCache || now - runnerHealthCache.at > RUNNER_HEALTH_TTL_MS) {
    runnerHealthCache = { at: now, value: checkRunnerHealth().catch((err: Error) => ({ online: false, error: err.message })) };
  }
  return runnerHealthCache.value;
}

const scopeInput = z.object({ workspaceId: z.string().optional() });

async function servicesInScope(db: Db, workspaceIds: string[]): Promise<ServiceRef[]> {
  if (workspaceIds.length === 0) return [];
  const rows = await db.service.findMany({
    where: { deletedAt: null, environment: { project: { deletedAt: null, workspaceId: { in: workspaceIds } } } },
    select: { id: true, name: true, environment: { select: { project: { select: { id: true, name: true } } } } },
  });
  return rows.map((s) => ({ id: s.id, name: s.name, projectId: s.environment.project.id, projectName: s.environment.project.name }));
}

export const analyticsRouter = createTRPCRouter({
  /** Headline numbers for the dashboard cards. */
  overview: protectedProcedure.input(scopeInput.optional()).query(async ({ ctx, input }) => {
    const scope = await resolveScope(ctx.db, ctx.session.user.id, input?.workspaceId);
    const now = new Date();
    const [states, projects, deploys24h, deploys7d, usage, runnerHealth] = await Promise.all([
      latestServiceStates(scope.ids),
      countProjects(scope.ids),
      deployStats(scope.ids, new Date(now.getTime() - 24 * 3_600_000)),
      deployStats(scope.ids, new Date(now.getTime() - 7 * 24 * 3_600_000)),
      Promise.all(
        scope.workspaces.map(async (w) => {
          const { periodStart, estimatedCostCents } = await workspaceUsageTotals(w.id, now);
          const capPercent = w.spendingCapCents && w.spendingCapCents > 0 ? Math.round((estimatedCostCents / w.spendingCapCents) * 1000) / 10 : null;
          return {
            workspaceId: w.id,
            name: w.name,
            periodStart,
            estimatedCostCents,
            spendingCapCents: w.spendingCapCents,
            capPercent,
            capReached: Boolean(w.spendCapReachedAt && w.spendCapReachedAt >= periodStart),
          };
        })
      ),
      cachedRunnerHealth(),
    ]);
    const liveIds = states.filter((s) => serviceState(s.isPaused, s.status) === "live").map((s) => s.id);
    const resources = await liveResourceSummary(liveIds, now);
    const capped = usage.filter((u) => u.capPercent !== null);
    return {
      generatedAt: now.toISOString(),
      scope: { workspaceId: input?.workspaceId ?? null, workspaceIds: scope.ids },
      workspaces: scope.workspaces.length,
      projects,
      services: countServiceStates(states),
      deploys: { "24h": deploys24h, "7d": deploys7d },
      usage: {
        periodStart: usage[0]?.periodStart ?? null,
        estimatedCostCents: usage.reduce((n, u) => n + u.estimatedCostCents, 0),
        /** The workspace closest to its spending cap (null when none has a cap). */
        nearestCap: capped.sort((a, b) => (b.capPercent ?? 0) - (a.capPercent ?? 0))[0] ?? null,
        workspaces: usage,
      },
      resources,
      runner: { config: getRunnerConfigStatus(), health: runnerHealth },
    };
  }),

  /** Per-UTC-day deployment counts by outcome. */
  deploymentTimeline: protectedProcedure
    .input(z.object({ workspaceId: z.string().optional(), days: z.union([z.literal(7), z.literal(30)]).default(7) }))
    .query(async ({ ctx, input }) => {
      const scope = await resolveScope(ctx.db, ctx.session.user.id, input.workspaceId);
      return deploymentTimeline(scope.ids, input.days);
    }),

  /** Latest deployments (with failure reasons) plus audit events of workspaces the caller administers. */
  recentActivity: protectedProcedure
    .input(z.object({ workspaceId: z.string().optional(), limit: z.number().int().min(1).max(50).default(20) }))
    .query(async ({ ctx, input }) => {
      const scope = await resolveScope(ctx.db, ctx.session.user.id, input.workspaceId);
      if (scope.ids.length === 0) return { items: [] };
      // Same rule as workspace.auditLog: owners and admins only.
      const adminIds = scope.workspaces.filter((w) => w.role === "OWNER" || w.role === "ADMIN").map((w) => w.id);
      const [deployments, audits] = await Promise.all([
        ctx.db.deployment.findMany({
          where: { service: { deletedAt: null, environment: { project: { deletedAt: null, workspaceId: { in: scope.ids } } } } },
          orderBy: { createdAt: "desc" },
          take: input.limit,
          select: {
            id: true,
            status: true,
            createdAt: true,
            startedAt: true,
            completedAt: true,
            errorMessage: true,
            build: { select: { commitSha: true, commitMessage: true } },
            service: {
              select: {
                id: true,
                name: true,
                environment: { select: { name: true, project: { select: { id: true, name: true, workspaceId: true } } } },
              },
            },
          },
        }),
        adminIds.length
          ? ctx.db.auditLogEntry.findMany({
              where: { workspaceId: { in: adminIds } },
              orderBy: { createdAt: "desc" },
              take: input.limit,
              select: { id: true, action: true, createdAt: true, workspaceId: true, actor: { select: { name: true, email: true } } },
            })
          : Promise.resolve([]),
      ]);
      const items = [
        ...deployments.map((d) => ({
          kind: "deployment" as const,
          id: d.id,
          at: d.createdAt.toISOString(),
          status: d.status as string,
          serviceId: d.service.id,
          serviceName: d.service.name,
          environment: d.service.environment.name,
          projectId: d.service.environment.project.id,
          projectName: d.service.environment.project.name,
          workspaceId: d.service.environment.project.workspaceId,
          durationMs: d.startedAt && d.completedAt ? d.completedAt.getTime() - d.startedAt.getTime() : null,
          commitSha: d.build?.commitSha ? d.build.commitSha.slice(0, 7) : null,
          commitMessage: d.build?.commitMessage ? d.build.commitMessage.split("\n")[0].slice(0, 120) : null,
          errorMessage: d.errorMessage ? d.errorMessage.slice(0, 300) : null,
        })),
        ...audits.map((a) => ({
          kind: "audit" as const,
          id: a.id,
          at: a.createdAt.toISOString(),
          action: a.action,
          workspaceId: a.workspaceId,
          actor: a.actor?.name || a.actor?.email || null,
        })),
      ]
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, input.limit);
      return { items };
    }),

  /** Requests, status classes, bandwidth and latency over time, for one service or a workspace scope. */
  traffic: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().optional(),
        serviceId: z.string().optional(),
        period: z.enum(["1h", "24h", "7d"]).default("24h"),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      let services: ServiceRef[];
      if (input.serviceId) {
        const svc = await ctx.db.service.findFirst({
          where: {
            id: input.serviceId,
            deletedAt: null,
            environment: {
              project: {
                deletedAt: null,
                ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
                workspace: { members: { some: { userId } } },
              },
            },
          },
          select: { id: true, name: true, environment: { select: { project: { select: { id: true, name: true } } } } },
        });
        if (!svc) throw new TRPCError({ code: "NOT_FOUND", message: "Service not found" });
        services = [{ id: svc.id, name: svc.name, projectId: svc.environment.project.id, projectName: svc.environment.project.name }];
      } else {
        const scope = await resolveScope(ctx.db, userId, input.workspaceId);
        services = await servicesInScope(ctx.db, scope.ids);
      }
      return { scope: { workspaceId: input.workspaceId ?? null, serviceId: input.serviceId ?? null }, ...(await trafficReport(services, input.period)) };
    }),
});
