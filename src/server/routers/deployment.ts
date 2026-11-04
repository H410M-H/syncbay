import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import { TRPCError } from "@trpc/server";
import { executeDeployment } from "@/lib/orchestrator/engine";
import { purgeEdgeCache } from "@/lib/edge/edge-router";
import { executeInstantRollback } from "@/lib/devops/instant-rollback";
import { logEventBus } from "@/lib/telemetry/event-bus";
import { requestTunnelReload } from "@/lib/tunnel/tunnel-sync";

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
      return {
        ...deployment,
        errorMessage: deployment.errorMessage || logEventBus.getError(deployment.id) || null,
      };
    }),

  /** Persisted + live log lines for a deployment (never synthesised) */
  logs: protectedProcedure
    .input(z.object({ deploymentId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { findAccessibleDeployment } = await import("@/lib/telemetry/log-stream");
      const deployment = await findAccessibleDeployment(input.deploymentId, ctx.session.user.id);
      if (!deployment) throw new TRPCError({ code: "NOT_FOUND" });
      const { loadDeploymentLogHistory } = await import("@/lib/telemetry/log-store");
      return loadDeploymentLogHistory(deployment.id);
    }),

  /** Get deployment history for a service */
  list: protectedProcedure
    .input(
      z.object({ serviceId: z.string(), limit: z.number().default(20) })
    )
    .query(async ({ ctx, input }) => {
      const deployments = await ctx.db.deployment.findMany({
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
      return deployments.map((d) => ({
        ...d,
        errorMessage: d.errorMessage || logEventBus.getError(d.id) || null,
      }));
    }),

  /** Get current/latest deployment for a service */
  latest: protectedProcedure
    .input(z.object({ serviceId: z.string() }))
    .query(async ({ ctx, input }) => {
      const deployment = await ctx.db.deployment.findFirst({
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
      if (!deployment) return null;
      return {
        ...deployment,
        errorMessage: deployment.errorMessage || logEventBus.getError(deployment.id) || null,
      };
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

  /** Rollback / Redeploy to a previous deployment — FR-DEP-04 (with optional clean rebuild) */
  redeploy: protectedProcedure
    .input(
      z.object({
        deploymentId: z.string(),
        rebuild: z.boolean().optional(),
      })
    )
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

      let targetBuildId = prev.buildId;
      const shouldRebuild = input.rebuild || !prev.build || prev.build.status === "FAILED";

      if (shouldRebuild) {
        const newBuild = await ctx.db.build.create({
          data: {
            serviceId: prev.serviceId,
            commitSha: prev.build?.commitSha || Math.random().toString(16).slice(2, 9),
            commitMessage: prev.build?.commitMessage
              ? `Rebuild: ${prev.build.commitMessage}`
              : `Redeploy with fresh build of ${prev.id.slice(0, 8)}`,
            triggeredBy: ctx.session.user.id,
            status: "QUEUED",
          },
        });
        targetBuildId = newBuild.id;
      }

      // Create new deployment
      const deployment = await ctx.db.deployment.create({
        data: {
          serviceId: prev.serviceId,
          buildId: targetBuildId,
          triggeredBy: ctx.session.user.id,
          status: "QUEUED",
        },
      });

      executeDeployment(deployment.id, targetBuildId, prev.serviceId, {
        serviceId: prev.serviceId,
        commitSha: prev.build?.commitSha || undefined,
        commitMessage: shouldRebuild
          ? `Clean rebuild of deployment ${prev.id.slice(0, 8)}`
          : `Fast redeploy of deployment ${prev.id.slice(0, 8)}`,
        cleanBuild: shouldRebuild,
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

  /** Delete a deployment and clean up its resources — FR-DEP-DELETE */
  delete: protectedProcedure
    .input(z.object({ deploymentId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const deployment = await ctx.db.deployment.findFirst({
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
        include: {
          service: true,
          build: true,
        },
      });

      if (!deployment) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Deployment not found or insufficient permissions",
        });
      }

      // 1. Stop container if running
      if (deployment.cfContainerId) {
        try {
          const { getRunnerDriver } = await import("@/lib/orchestrator/runner-driver");
          const driver = getRunnerDriver();
          await driver.stopContainer(deployment.cfContainerId).catch(() => null);
        } catch {}
      }

      // 2. Remove logs from the event bus and the DeploymentLog table
      logEventBus.clear(deployment.id);
      await (await import("@/lib/telemetry/log-store")).deleteDeploymentLogs(deployment.id);

      // 3. Count remaining deployments for this build
      const siblingCount = await ctx.db.deployment.count({
        where: {
          buildId: deployment.buildId,
          id: { not: deployment.id },
        },
      });

      // 4. Delete deployment record
      await ctx.db.deployment.delete({
        where: { id: input.deploymentId },
      });
      await requestTunnelReload(`deployment:${input.deploymentId}:deleted`);

      // 5. Clean up orphan build if no other deployments reference it
      if (siblingCount === 0) {
        await ctx.db.build.delete({
          where: { id: deployment.buildId },
        }).catch(() => null);
      }

      return {
        success: true,
        deletedId: input.deploymentId,
        serviceId: deployment.serviceId,
      };
    }),
});

