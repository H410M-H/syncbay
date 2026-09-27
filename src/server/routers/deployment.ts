import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import { TRPCError } from "@trpc/server";
import { executeDeployment } from "@/lib/orchestrator/engine";
import { purgeEdgeCache } from "@/lib/edge/edge-router";
import { executeInstantRollback } from "@/lib/devops/instant-rollback";
import { logEventBus } from "@/lib/telemetry/event-bus";

export const deploymentRouter = createTRPCRouter({
  /** Get single deployment by id */
  byId: protectedProcedure
    .input(z.object({ deploymentId: z.string() }))
    .query(async ({ ctx, input }) => {
      const deployment = await ctx.db.deployment.findFirst({
        where: {
          id: input.deploymentId,
          service: {
            environment: {
              project: {
                workspace: {
                  members: { some: { userId: ctx.session.user.id } },
                },
              },
            },
          },
        },
        include: {
          build: true,
          service: {
            include: {
              environment: true,
            },
          },
        },
      });
      if (!deployment) throw new TRPCError({ code: "NOT_FOUND" });
      return deployment;
    }),

  /** Get live or historical log lines for a deployment */
  logs: protectedProcedure
    .input(z.object({ deploymentId: z.string() }))
    .query(async ({ input }) => {
      return logEventBus.getHistory(input.deploymentId);
    }),

  /** Get deployment history for a service */
  list: protectedProcedure
    .input(
      z.object({ serviceId: z.string(), limit: z.number().default(20) })
    )
    .query(async ({ ctx, input }) => {
      return ctx.db.deployment.findMany({
        where: {
          serviceId: input.serviceId,
          service: {
            environment: {
              project: {
                workspace: {
                  members: { some: { userId: ctx.session.user.id } },
                },
              },
            },
          },
        },
        include: { build: true },
        orderBy: { createdAt: "desc" },
        take: input.limit,
      });
    }),

  /** Get current/latest deployment for a service */
  latest: protectedProcedure
    .input(z.object({ serviceId: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.db.deployment.findFirst({
        where: {
          serviceId: input.serviceId,
          service: {
            environment: {
              project: {
                workspace: {
                  members: { some: { userId: ctx.session.user.id } },
                },
              },
            },
          },
        },
        include: { build: true },
        orderBy: { createdAt: "desc" },
      });
    }),

  /**
   * Trigger a manual deployment — FR-DEP-01, FR-SVC-05
   */
  trigger: protectedProcedure
    .input(
      z.object({
        serviceId: z.string(),
        commitSha: z.string().optional(),
        commitMessage: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const service = await ctx.db.service.findFirst({
        where: {
          id: input.serviceId,
          deletedAt: null,
          isPaused: false,
          environment: {
            project: {
              workspace: {
                members: {
                  some: {
                    userId: ctx.session.user.id,
                    role: { in: ["OWNER", "ADMIN", "MEMBER"] },
                  },
                },
              },
            },
          },
        },
      });
      if (!service) throw new TRPCError({ code: "NOT_FOUND" });

      // Create Build record
      const build = await ctx.db.build.create({
        data: {
          serviceId: input.serviceId,
          commitSha: input.commitSha || Math.random().toString(16).slice(2, 9),
          commitMessage: input.commitMessage || "Manual deployment via console",
          triggeredBy: ctx.session.user.id,
          status: "QUEUED",
        },
      });

      // Create Deployment record
      const deployment = await ctx.db.deployment.create({
        data: {
          serviceId: input.serviceId,
          buildId: build.id,
          triggeredBy: ctx.session.user.id,
          status: "QUEUED",
        },
      });

      // Execute asynchronously via dual-driver orchestrator
      executeDeployment(deployment.id, build.id, service.id, {
        serviceId: service.id,
        commitSha: build.commitSha || undefined,
        commitMessage: build.commitMessage || undefined,
        userId: ctx.session.user.id,
      }).catch((err) => {
        console.error("Deployment execution error:", err);
      });

      return { build, deployment };
    }),

  /** Rollback to a previous deployment — FR-DEP-04 */
  redeploy: protectedProcedure
    .input(z.object({ deploymentId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const prev = await ctx.db.deployment.findFirst({
        where: {
          id: input.deploymentId,
          service: {
            environment: {
              project: {
                workspace: {
                  members: {
                    some: {
                      userId: ctx.session.user.id,
                      role: { in: ["OWNER", "ADMIN", "MEMBER"] },
                    },
                  },
                },
              },
            },
          },
        },
        include: { build: true, service: true },
      });
      if (!prev) throw new TRPCError({ code: "NOT_FOUND" });

      // Reuse cached build image — FR-BLD-07
      const deployment = await ctx.db.deployment.create({
        data: {
          serviceId: prev.serviceId,
          buildId: prev.buildId,
          triggeredBy: ctx.session.user.id,
          status: "QUEUED",
        },
      });

      executeDeployment(deployment.id, prev.buildId, prev.serviceId, {
        serviceId: prev.serviceId,
        commitSha: prev.build?.commitSha || undefined,
        commitMessage: `Rollback to deployment ${prev.id.slice(0, 8)}`,
        userId: ctx.session.user.id,
      }).catch((err) => {
        console.error("Redeploy error:", err);
      });

      return deployment;
    }),

  /** Sub-second Instant Rollback shifting edge traffic without full rebuild — M5 F14 */
  instantRollback: protectedProcedure
    .input(z.object({ deploymentId: z.string(), serviceId: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      return executeInstantRollback(ctx.db, ctx.session.user.id, input);
    }),

  /** Cancel a running/queued deployment */
  cancel: protectedProcedure
    .input(z.object({ deploymentId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const deployment = await ctx.db.deployment.findFirst({
        where: {
          id: input.deploymentId,
          status: { in: ["QUEUED", "BUILDING", "DEPLOYING"] },
          service: {
            environment: {
              project: {
                workspace: {
                  members: {
                    some: {
                      userId: ctx.session.user.id,
                      role: { in: ["OWNER", "ADMIN", "MEMBER"] },
                    },
                  },
                },
              },
            },
          },
        },
      });
      if (!deployment) throw new TRPCError({ code: "NOT_FOUND" });

      return ctx.db.deployment.update({
        where: { id: input.deploymentId },
        data: { status: "CANCELLED" },
      });
    }),
});

