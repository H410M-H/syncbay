import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import { TRPCError } from "@trpc/server";
import {
  listCronJobs,
  createCronJob,
  toggleCronJob,
  deleteCronJob,
  listCronRuns,
  getCronJob,
} from "@/lib/devops/cron-engine";
import { executeCronJob } from "@/lib/devops/cron-runner";
import {
  WAF_RULE_TYPES,
  getWafConfig,
  updateWafConfig,
  getSecurityEvents,
  listWafRules,
  createWafRule,
} from "@/lib/devops/waf-engine";
import {
  getCanaryConfig,
  startCanary,
  updateCanaryWeight,
  promoteCanary,
  rollbackCanary,
  evaluateCanaryHealth,
} from "@/lib/devops/canary-engine";
import { clearEdgePolicyCache } from "@/lib/edge/edge-policy";
import { autoTuneFramework } from "@/lib/devops/auto-tuner";
import { diagnoseBuildLogs } from "@/lib/devops/ai-diagnostics";
import { parseVercelConfig, applyVercelMigration } from "@/lib/devops/vercel-migrator";
import { purgeEdgeCache } from "@/lib/edge/edge-router";
import { executeInstantRollback } from "@/lib/devops/instant-rollback";
import { executeSyncVariables } from "@/lib/devops/env-sync";

/**
 * RBAC Helper: Asserts caller has access to the workspace containing the service
 */
async function assertDevopsAccess(
  db: any,
  userId: string,
  serviceId: string,
  allowedRoles: ("OWNER" | "ADMIN" | "MEMBER" | "VIEWER")[] = ["OWNER", "ADMIN", "MEMBER"]
) {
  const service = await db.service.findFirst({
    where: {
      id: serviceId,
      deletedAt: null,
      environment: {
        project: {
          deletedAt: null,
          workspace: {
            members: {
              some: {
                userId,
                role: { in: allowedRoles },
              },
            },
          },
        },
      },
    },
    include: {
      environment: {
        include: {
          project: {
            include: {
              workspace: true,
            },
          },
        },
      },
    },
  });

  if (!service) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Insufficient permissions or service not found in your workspaces",
    });
  }

  return service;
}

/**
 * RBAC Helper for cron-based actions: resolves serviceId from cron ID and verifies permissions
 */
async function assertCronAccess(
  db: any,
  userId: string,
  cronId: string,
  allowedRoles: ("OWNER" | "ADMIN" | "MEMBER" | "VIEWER")[] = ["OWNER", "ADMIN", "MEMBER"]
) {
  const cron = await getCronJob(db, cronId);
  if (!cron) {
    throw new TRPCError({ code: "NOT_FOUND", message: `Cron job not found: ${cronId}` });
  }
  await assertDevopsAccess(db, userId, cron.serviceId, allowedRoles);
  return cron;
}

async function canaryMutation<T>(fn: () => Promise<T>): Promise<T> {
  try {
    const result = await fn();
    clearEdgePolicyCache();
    return result;
  } catch (err: any) {
    throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
  }
}

export const devopsRouter = createTRPCRouter({
  // ─── CRON SCHEDULER (CronJob / CronRun rows; runDueCronJobs executes them) ──
  listCrons: protectedProcedure
    .input(z.object({ serviceId: z.string() }))
    .query(async ({ ctx, input }) => {
      await assertDevopsAccess(ctx.db, ctx.session.user.id, input.serviceId, ["OWNER", "ADMIN", "MEMBER", "VIEWER"]);
      return listCronJobs(ctx.db, input.serviceId);
    }),

  createCron: protectedProcedure
    .input(
      z.object({
        serviceId: z.string(),
        name: z.string().min(1).max(100),
        schedule: z.string().min(5),
        path: z.string().min(1).max(2048),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
        headers: z.record(z.string(), z.string().max(4096)).optional(),
        timeoutMs: z.number().int().min(1000).max(60000).optional(),
        maxRetries: z.number().int().min(0).max(5).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertDevopsAccess(ctx.db, ctx.session.user.id, input.serviceId, ["OWNER", "ADMIN", "MEMBER"]);
      try {
        return await createCronJob(ctx.db, input);
      } catch (err: any) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
      }
    }),

  toggleCron: protectedProcedure
    .input(z.object({ cronId: z.string(), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await assertCronAccess(ctx.db, ctx.session.user.id, input.cronId, ["OWNER", "ADMIN", "MEMBER"]);
      try {
        return await toggleCronJob(ctx.db, input.cronId, input.enabled);
      } catch (err: any) {
        throw new TRPCError({ code: "NOT_FOUND", message: err.message });
      }
    }),

  triggerCron: protectedProcedure
    .input(z.object({ cronId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await assertCronAccess(ctx.db, ctx.session.user.id, input.cronId, ["OWNER", "ADMIN", "MEMBER"]);
      try {
        return await executeCronJob(input.cronId, { trigger: "manual" });
      } catch (err: any) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
      }
    }),

  deleteCron: protectedProcedure
    .input(z.object({ cronId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await assertCronAccess(ctx.db, ctx.session.user.id, input.cronId, ["OWNER", "ADMIN", "MEMBER"]);
      return { success: await deleteCronJob(ctx.db, input.cronId) };
    }),

  getCronLogs: protectedProcedure
    .input(z.object({ cronId: z.string(), limit: z.number().int().min(1).max(100).optional() }))
    .query(async ({ ctx, input }) => {
      await assertCronAccess(ctx.db, ctx.session.user.id, input.cronId, ["OWNER", "ADMIN", "MEMBER", "VIEWER"]);
      return listCronRuns(ctx.db, input.cronId, input.limit);
    }),

  // ─── WAF & RATE LIMITING (WafRule rows, enforced in src/proxy.ts) ─────────
  getWafConfig: protectedProcedure
    .input(z.object({ serviceId: z.string() }))
    .query(async ({ ctx, input }) => {
      await assertDevopsAccess(ctx.db, ctx.session.user.id, input.serviceId, ["OWNER", "ADMIN", "MEMBER", "VIEWER"]);
      return getWafConfig(ctx.db, input.serviceId);
    }),

  updateWafConfig: protectedProcedure
    .input(
      z.object({
        serviceId: z.string(),
        enabled: z.boolean().optional(),
        rateLimitRpm: z.number().int().min(10).max(50000).nullable().optional(),
        ipBlocklist: z.array(z.string().max(64)).max(1000).optional(),
        ipAllowlist: z.array(z.string().max(64)).max(1000).optional(),
        geoBlockCountries: z.array(z.string().length(2)).max(250).optional(),
        pathBlocklist: z.array(z.string().max(512)).max(500).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertDevopsAccess(ctx.db, ctx.session.user.id, input.serviceId, ["OWNER", "ADMIN", "MEMBER"]);
      const { serviceId, ...partial } = input;
      try {
        const config = await updateWafConfig(ctx.db, serviceId, partial);
        clearEdgePolicyCache();
        return config;
      } catch (err: any) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
      }
    }),

  listWafRules: protectedProcedure
    .input(z.object({ serviceId: z.string() }))
    .query(async ({ ctx, input }) => {
      await assertDevopsAccess(ctx.db, ctx.session.user.id, input.serviceId, ["OWNER", "ADMIN", "MEMBER", "VIEWER"]);
      return listWafRules(ctx.db, input.serviceId);
    }),

  createWafRule: protectedProcedure
    .input(
      z.object({
        serviceId: z.string(),
        type: z.enum(WAF_RULE_TYPES),
        value: z.string().min(1).max(512),
        rateLimitRpm: z.number().int().min(1).max(100000).optional(),
        description: z.string().max(200).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertDevopsAccess(ctx.db, ctx.session.user.id, input.serviceId, ["OWNER", "ADMIN", "MEMBER"]);
      try {
        const rule = await createWafRule(ctx.db, input);
        clearEdgePolicyCache();
        return rule;
      } catch (err: any) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
      }
    }),

  deleteWafRule: protectedProcedure
    .input(z.object({ serviceId: z.string(), ruleId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await assertDevopsAccess(ctx.db, ctx.session.user.id, input.serviceId, ["OWNER", "ADMIN", "MEMBER"]);
      const result = await ctx.db.wafRule.deleteMany({ where: { id: input.ruleId, serviceId: input.serviceId } });
      clearEdgePolicyCache();
      return { success: result.count > 0 };
    }),

  getSecurityEvents: protectedProcedure
    .input(z.object({ serviceId: z.string() }))
    .query(async ({ ctx, input }) => {
      await assertDevopsAccess(ctx.db, ctx.session.user.id, input.serviceId, ["OWNER", "ADMIN", "MEMBER", "VIEWER"]);
      return getSecurityEvents(ctx.db, input.serviceId);
    }),

  // ─── CANARY & ROLLING RELEASES (CanaryConfig, split in src/proxy.ts) ──────
  getCanaryConfig: protectedProcedure
    .input(z.object({ serviceId: z.string() }))
    .query(async ({ ctx, input }) => {
      await assertDevopsAccess(ctx.db, ctx.session.user.id, input.serviceId, ["OWNER", "ADMIN", "MEMBER", "VIEWER"]);
      return getCanaryConfig(ctx.db, input.serviceId);
    }),

  startCanary: protectedProcedure
    .input(
      z.object({
        serviceId: z.string(),
        stableDeploymentId: z.string(),
        canaryDeploymentId: z.string(),
        stableUpstreamUrl: z.string().url().optional(),
        canaryUpstreamUrl: z.string().url().optional(),
        weightPercent: z.number().min(0).max(100).optional(),
        autoRollbackThreshold5xxPercent: z.number().min(0.1).max(100).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertDevopsAccess(ctx.db, ctx.session.user.id, input.serviceId, ["OWNER", "ADMIN", "MEMBER"]);
      try {
        const config = await startCanary(ctx.db, input);
        clearEdgePolicyCache();
        return config;
      } catch (err: any) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
      }
    }),

  updateCanaryWeight: protectedProcedure
    .input(
      z.object({
        serviceId: z.string(),
        weightPercent: z.number().min(0).max(100),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertDevopsAccess(ctx.db, ctx.session.user.id, input.serviceId, ["OWNER", "ADMIN", "MEMBER"]);
      return canaryMutation(() => updateCanaryWeight(ctx.db, input.serviceId, input.weightPercent));
    }),

  promoteCanary: protectedProcedure
    .input(z.object({ serviceId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await assertDevopsAccess(ctx.db, ctx.session.user.id, input.serviceId, ["OWNER", "ADMIN", "MEMBER"]);
      return canaryMutation(() => promoteCanary(ctx.db, input.serviceId));
    }),

  rollbackCanary: protectedProcedure
    .input(z.object({ serviceId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await assertDevopsAccess(ctx.db, ctx.session.user.id, input.serviceId, ["OWNER", "ADMIN", "MEMBER"]);
      return canaryMutation(() => rollbackCanary(ctx.db, input.serviceId));
    }),

  evaluateCanary: protectedProcedure
    .input(z.object({ serviceId: z.string(), windowMinutes: z.number().int().min(1).max(1440).optional() }))
    .mutation(async ({ ctx, input }) => {
      await assertDevopsAccess(ctx.db, ctx.session.user.id, input.serviceId, ["OWNER", "ADMIN", "MEMBER"]);
      return canaryMutation(() => evaluateCanaryHealth(ctx.db, input.serviceId, { windowMinutes: input.windowMinutes }));
    }),

  // ─── ZERO-CONFIG AUTO-TUNER ────────────────────────────────────────────────
  autoTune: protectedProcedure
    .input(
      z.object({
        files: z.array(z.string()),
        packageJsonSnippet: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      return autoTuneFramework(input.files, input.packageJsonSnippet);
    }),

  // ─── AI DEPLOY DIAGNOSTICS ─────────────────────────────────────────────────
  diagnoseLogs: protectedProcedure
    .input(
      z.object({
        serviceId: z.string(),
        logLines: z.array(z.string()),
      })
    )
    .query(async ({ ctx, input }) => {
      await assertDevopsAccess(ctx.db, ctx.session.user.id, input.serviceId, ["OWNER", "ADMIN", "MEMBER", "VIEWER"]);
      return diagnoseBuildLogs(input.logLines);
    }),

  // ─── VERCEL CLI PARSER & MIGRATOR ──────────────────────────────────────────
  parseVercelConfig: protectedProcedure
    .input(z.object({ rawJson: z.string() }))
    .query(async ({ input }) => {
      try {
        return parseVercelConfig(input.rawJson);
      } catch (err: any) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
      }
    }),

  applyVercelMigration: protectedProcedure
    .input(
      z.object({
        serviceId: z.string(),
        rawJson: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertDevopsAccess(ctx.db, ctx.session.user.id, input.serviceId, ["OWNER", "ADMIN", "MEMBER"]);
      try {
        const plan = parseVercelConfig(input.rawJson);
        const result = await applyVercelMigration(ctx.db, input.serviceId, plan);
        clearEdgePolicyCache();
        return {
          success: true,
          plan,
          result,
        };
      } catch (err: any) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
      }
    }),

  // ─── INSTANT ROLLBACK (M5 F14) ─────────────────────────────────────────────
  instantRollback: protectedProcedure
    .input(z.object({ deploymentId: z.string(), serviceId: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      return executeInstantRollback(ctx.db, ctx.session.user.id, input);
    }),

  // ─── ENVIRONMENT VARIABLE SYNCHRONIZATION (M5 F15) ─────────────────────────
  syncVariables: protectedProcedure
    .input(
      z.object({
        serviceId: z.string(),
        variables: z.record(z.string(), z.string()).optional(),
        rawEnv: z.string().optional(),
        mode: z.enum(["merge", "overwrite"]).default("merge"),
        includeWorkspaceShared: z.boolean().default(false),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return executeSyncVariables(ctx.db, ctx.session.user.id, input);
    }),

  // ─── EDGE CACHE PURGE (M5 F16) ─────────────────────────────────────────────
  purgeEdgeCache: protectedProcedure
    .input(
      z.object({
        serviceId: z.string().optional(),
        domain: z.string().optional(),
        path: z.string().optional(),
        tag: z.string().optional(),
        all: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.serviceId) {
        await assertDevopsAccess(ctx.db, ctx.session.user.id, input.serviceId, ["OWNER", "ADMIN"]);
      }
      return purgeEdgeCache(input);
    }),

  purgeCache: protectedProcedure
    .input(
      z.object({
        serviceId: z.string().optional(),
        domain: z.string().optional(),
        path: z.string().optional(),
        tag: z.string().optional(),
        all: z.boolean().default(true),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.serviceId) {
        await assertDevopsAccess(ctx.db, ctx.session.user.id, input.serviceId, ["OWNER", "ADMIN"]);
      }
      return purgeEdgeCache({
        domain: input.domain,
        path: input.path,
        tag: input.tag,
        all: input.all,
      });
    }),
});
