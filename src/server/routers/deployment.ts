import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import { TRPCError } from "@trpc/server";
import { scheduleDeployment } from "@/lib/orchestrator/schedule";
import { cancelDeploymentJob } from "@/lib/orchestrator/job-queue";
import { driverFor } from "@/lib/orchestrator/lifecycle";
import { resolveHeadCommitSha } from "@/lib/orchestrator/pr-manager";
import { purgeEdgeCache } from "@/lib/edge/edge-router";
import { executeInstantRollback } from "@/lib/devops/instant-rollback";
import { logEventBus } from "@/lib/telemetry/event-bus";
import { requestTunnelReload } from "@/lib/tunnel/tunnel-sync";
import { checkRunnerHealth, getRunnerConfigStatus } from "@/lib/orchestrator/runner-config";
import { needsRebuild, redeployFromDeployment } from "@/lib/orchestrator/service-actions";
import { requireRunnerReady, surfaceRunnerConfigErrors } from "@/server/runner-preflight";

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
        include: { environment: true },
      });
      if (!service) throw new TRPCError({ code: "NOT_FOUND" });
      // A misconfigured runner is PRECONDITION_FAILED here, not a FAILED deployment row later
      requireRunnerReady();

      // Real HEAD of the tracked branch, or null — never an invented SHA
      const commitSha =
        input.commitSha ||
        (await resolveHeadCommitSha(service.repoUrl, service.branch, {
          projectId: service.environment.projectId,
          userId: ctx.session.user.id,
        }));

      // Create Build record
      const build = await ctx.db.build.create({
        data: {
          serviceId: input.serviceId,
          commitSha,
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

      // Durable job row now; the build runs in after() (maxDuration 300) and is recovered if the function dies
      await scheduleDeployment(deployment.id, build.id, service.id, {
        serviceId: service.id,
        commitSha: build.commitSha || undefined,
        commitMessage: build.commitMessage || undefined,
        userId: ctx.session.user.id,
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
        include: { build: true, service: { include: { environment: true } } },
      });
      if (!prev) throw new TRPCError({ code: "NOT_FOUND" });
      requireRunnerReady();

      const { deployment } = await redeployFromDeployment(ctx.db, prev, {
        rebuild: Boolean(input.rebuild) || needsRebuild(prev),
        userId: ctx.session.user.id,
      });
      return deployment;
    }),

  /** Sub-second Instant Rollback shifting edge traffic without full rebuild — M5 F14 */
  instantRollback: protectedProcedure
    .input(z.object({ deploymentId: z.string(), serviceId: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      return surfaceRunnerConfigErrors(() => executeInstantRollback(ctx.db, ctx.session.user.id, input));
    }),

  /**
   * Which runner deploys use and whether it is configured (no secret values), for the wizard and
   * project pages. `health: true` also probes the runner's `/health` (3 s timeout).
   */
  runnerStatus: protectedProcedure
    .input(z.object({ health: z.boolean().optional() }).optional())
    .query(async ({ input }) => {
      const config = getRunnerConfigStatus();
      return { ...config, health: input?.health ? await checkRunnerHealth() : null };
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

      // A pull-mode runner sees the cancelled job on its next report and tears the build down
      await cancelDeploymentJob(deployment.id);
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

      // 1. Stop container if running. A live instance on a misconfigured runner is not orphaned:
      //    the delete fails with the configuration problem instead.
      if (deployment.cfContainerId) {
        if (["ACTIVE", "CRASHED", "DEPLOYING"].includes(deployment.status)) {
          const driver = await surfaceRunnerConfigErrors(async () => driverFor(deployment.runnerDriver));
          await driver.stopContainer(deployment.cfContainerId).catch(() => null);
        } else {
          try {
            await driverFor(deployment.runnerDriver).stopContainer(deployment.cfContainerId).catch(() => null);
          } catch {}
        }
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

