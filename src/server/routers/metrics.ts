/**
 * Syncbay PaaS — Telemetry & Metrics tRPC Router (R4 Core)
 * Real container metrics (runner `GET /api/metrics/:containerId`, stored as
 * `MetricSample` by the 1-minute cron), historical aggregates of those samples,
 * and month-to-date usage from `UsageRecord`.
 */

import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import { TRPCError } from "@trpc/server";
import {
  fetchContainerMetrics,
  historicalPoints,
  latestSamples,
  sampleToPoint,
  type TelemetryPoint,
} from "@/lib/telemetry/metrics-sampler";
import { workspaceUsageTotals } from "@/lib/usage/metering";

const memberOf = (userId: string) => ({
  environment: { project: { workspace: { members: { some: { userId } } } } },
});

export const metricsRouter = createTRPCRouter({
  /**
   * Live reading for a service or deployment: asks the runner when the
   * container is running, else the newest stored sample. `point` is null when
   * nothing has been measured.
   */
  live: protectedProcedure
    .input(
      z.object({
        serviceId: z.string().optional(),
        deploymentId: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      if (!input.serviceId && !input.deploymentId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Must provide either serviceId or deploymentId",
        });
      }

      const userId = ctx.session.user.id;
      const deployment = input.deploymentId
        ? await ctx.db.deployment.findFirst({
            where: { id: input.deploymentId, service: { deletedAt: null, ...memberOf(userId) } },
            include: { service: { select: { isPaused: true } } },
          })
        : await ctx.db.deployment.findFirst({
            where: { serviceId: input.serviceId, service: { deletedAt: null, ...memberOf(userId) } },
            orderBy: { createdAt: "desc" },
            include: { service: { select: { isPaused: true } } },
          });
      if (!deployment) {
        if (input.serviceId) {
          const service = await ctx.db.service.findFirst({
            where: { id: input.serviceId, deletedAt: null, ...memberOf(userId) },
            select: { id: true },
          });
          if (!service) throw new TRPCError({ code: "NOT_FOUND" });
          return { status: "NOT_DEPLOYED", source: "none" as const, point: null as TelemetryPoint | null };
        }
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      const status = deployment.service.isPaused ? "SLEEPING" : deployment.status;
      if (status === "ACTIVE" && deployment.cfContainerId) {
        const live = await fetchContainerMetrics(deployment.cfContainerId).catch(() => null);
        if (live) {
          const [prev] = await latestSamples({ deploymentId: deployment.id });
          return {
            status,
            source: live.source,
            point: sampleToPoint({ ...live, sampledAt: live.sampledAt || new Date().toISOString() }, prev) as TelemetryPoint | null,
          };
        }
      }
      const [latest, before] = await latestSamples({ deploymentId: deployment.id });
      return {
        status,
        source: latest ? ("sample" as const) : ("none" as const),
        point: latest ? sampleToPoint(latest, before) : null,
      };
    }),

  /**
   * Historical time-series: bucketed averages of stored samples. Buckets with no
   * samples are omitted.
   */
  historical: protectedProcedure
    .input(
      z.object({
        serviceId: z.string(),
        period: z.enum(["1h", "24h", "7d", "30d"]).default("24h"),
      })
    )
    .query(async ({ ctx, input }) => {
      const service = await ctx.db.service.findFirst({
        where: { id: input.serviceId, deletedAt: null, ...memberOf(ctx.session.user.id) },
        select: { id: true },
      });
      if (!service) throw new TRPCError({ code: "NOT_FOUND", message: "Service not found" });

      return {
        serviceId: input.serviceId,
        period: input.period,
        points: await historicalPoints(service.id, input.period),
      };
    }),

  /**
   * Month-to-date usage for billing and spending caps.
   */
  workspaceUsage: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ ctx, input }) => {
      const workspace = await ctx.db.workspace.findFirst({
        where: {
          id: input.workspaceId,
          members: { some: { userId: ctx.session.user.id } },
        },
        select: { id: true, spendingCapCents: true, spendCapReachedAt: true },
      });

      if (!workspace) throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });

      const { periodStart, totals, estimatedCostCents } = await workspaceUsageTotals(workspace.id);
      const records = await ctx.db.usageRecord.findMany({
        where: { workspaceId: workspace.id, periodStart: { gte: periodStart } },
        orderBy: { periodStart: "desc" },
        take: 50,
      });
      const usageRecordsCount = await ctx.db.usageRecord.count({
        where: { workspaceId: workspace.id, periodStart: { gte: periodStart } },
      });

      return {
        workspaceId: workspace.id,
        periodStart,
        spendingCapCents: workspace.spendingCapCents,
        spendCapReached: Boolean(workspace.spendCapReachedAt && workspace.spendCapReachedAt >= periodStart),
        estimatedCostCents,
        totals,
        usageRecordsCount,
        records,
      };
    }),
});
