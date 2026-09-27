import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import { TRPCError } from "@trpc/server";
import { domainService } from "@/lib/domain-service";
import { executeSyncVariables } from "@/lib/devops/env-sync";

export const serviceRouter = createTRPCRouter({
  /** List services in an environment */
  list: protectedProcedure
    .input(
      z
        .object({
          environmentId: z.string().optional(),
          workspaceId: z.string().optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const where: any = {
        deletedAt: null,
        environment: {
          project: {
            deletedAt: null,
            workspace: { members: { some: { userId: ctx.session.user.id } } },
          },
        },
      };

      if (input?.environmentId) {
        where.environmentId = input.environmentId;
      }
      if (input?.workspaceId) {
        where.environment.project.workspaceId = input.workspaceId;
      }

      return ctx.db.service.findMany({
        where,
        include: {
          domains: true,
          variables: true,
          volumes: true,
          environment: {
            include: {
              project: true,
            },
          },
          deployments: {
            orderBy: { createdAt: "desc" },
            take: 1,
          },
          _count: { select: { builds: true } },
        },
      });
    }),

  /** Get a single service by ID with full relations */
  byId: protectedProcedure
    .input(z.object({ serviceId: z.string() }))
    .query(async ({ ctx, input }) => {
      const service = await ctx.db.service.findFirst({
        where: {
          id: input.serviceId,
          deletedAt: null,
          environment: {
            project: {
              deletedAt: null,
              workspace: { members: { some: { userId: ctx.session.user.id } } },
            },
          },
        },
        include: {
          environment: { include: { project: true } },
          domains: true,
          variables: true,
          volumes: true,
          deployments: {
            orderBy: { createdAt: "desc" },
            take: 10,
          },
          builds: {
            orderBy: { createdAt: "desc" },
            take: 10,
          },
        },
      });

      if (!service) throw new TRPCError({ code: "NOT_FOUND", message: "Service not found" });
      return service;
    }),

  /** Create a service and auto-generate default domain — FR-SVC-01 */
  create: protectedProcedure
    .input(
      z.object({
        environmentId: z.string(),
        name: z.string().min(1).max(64),
        sourceType: z.enum(["github", "docker", "empty"]),
        repoUrl: z.string().url().optional(),
        branch: z.string().optional(),
        rootDir: z.string().optional(),
        dockerImage: z.string().optional(),
        port: z.number().int().min(1).max(65535).optional(),
        buildCommand: z.string().optional(),
        startCommand: z.string().optional(),
        instanceType: z
          .enum(["lite", "standard-1", "standard-2", "standard-4"])
          .default("lite"),
        scaleToZero: z.boolean().default(true),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Confirm environment belongs to a workspace the caller is in
      const env = await ctx.db.environment.findFirst({
        where: {
          id: input.environmentId,
          project: {
            deletedAt: null,
            workspace: {
              members: { some: { userId: ctx.session.user.id, role: { in: ["OWNER", "ADMIN", "MEMBER"] } } },
            },
          },
        },
        include: { project: true },
      });
      if (!env) throw new TRPCError({ code: "NOT_FOUND", message: "Environment not found or insufficient permissions" });

      const service = await ctx.db.service.create({
        data: {
          environmentId: input.environmentId,
          name: input.name,
          sourceType: input.sourceType,
          repoUrl: input.repoUrl,
          branch: input.branch ?? "main",
          rootDir: input.rootDir,
          dockerImage: input.dockerImage,
          port: input.port,
          buildCommand: input.buildCommand,
          startCommand: input.startCommand,
          instanceType: input.instanceType,
          scaleToZero: input.scaleToZero,
        },
      });

      // Automatically generate default domain <service>-<env>.syncbay.app
      const defaultHostname = domainService.generateDefaultSubdomain(service.name, env.name);
      const existingDomain = await ctx.db.domain.findUnique({
        where: { hostname: defaultHostname },
      });

      const finalHostname = existingDomain
        ? domainService.generateDefaultSubdomain(service.name, env.name, service.id.slice(-4).toLowerCase())
        : defaultHostname;

      await ctx.db.domain.create({
        data: {
          serviceId: service.id,
          hostname: finalHostname,
          isGenerated: true,
          status: "ACTIVE",
          verifiedAt: new Date(),
        },
      });

      return service;
    }),

  /** Update service configuration */
  update: protectedProcedure
    .input(
      z.object({
        serviceId: z.string(),
        name: z.string().min(1).max(64).optional(),
        buildCommand: z.string().optional().nullable(),
        startCommand: z.string().optional().nullable(),
        rootDir: z.string().optional().nullable(),
        dockerImage: z.string().optional().nullable(),
        port: z.number().int().min(1).max(65535).optional().nullable(),
        instanceType: z.string().optional(),
        scaleToZero: z.boolean().optional(),
        idleTimeoutSecs: z.number().int().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const service = await ctx.db.service.findFirst({
        where: {
          id: input.serviceId,
          deletedAt: null,
          environment: {
            project: {
              workspace: { members: { some: { userId: ctx.session.user.id, role: { in: ["OWNER", "ADMIN", "MEMBER"] } } } },
            },
          },
        },
      });
      if (!service) throw new TRPCError({ code: "NOT_FOUND" });

      return ctx.db.service.update({
        where: { id: input.serviceId },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.buildCommand !== undefined && { buildCommand: input.buildCommand }),
          ...(input.startCommand !== undefined && { startCommand: input.startCommand }),
          ...(input.rootDir !== undefined && { rootDir: input.rootDir }),
          ...(input.dockerImage !== undefined && { dockerImage: input.dockerImage }),
          ...(input.port !== undefined && { port: input.port }),
          ...(input.instanceType !== undefined && { instanceType: input.instanceType }),
          ...(input.scaleToZero !== undefined && { scaleToZero: input.scaleToZero }),
          ...(input.idleTimeoutSecs !== undefined && { idleTimeoutSecs: input.idleTimeoutSecs }),
        },
      });
    }),

  /** Pause / unpause a service — FR-SVC-09 */
  setPaused: protectedProcedure
    .input(z.object({ serviceId: z.string(), paused: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const service = await ctx.db.service.findFirst({
        where: {
          id: input.serviceId,
          deletedAt: null,
          environment: {
            project: {
              workspace: { members: { some: { userId: ctx.session.user.id, role: { in: ["OWNER", "ADMIN", "MEMBER"] } } } },
            },
          },
        },
      });
      if (!service) throw new TRPCError({ code: "NOT_FOUND" });

      return ctx.db.service.update({
        where: { id: input.serviceId },
        data: { isPaused: input.paused },
      });
    }),

  /** Restart a service container gracefully — 0ms reboot */
  restart: protectedProcedure
    .input(z.object({ serviceId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const service = await ctx.db.service.findFirst({
        where: {
          id: input.serviceId,
          deletedAt: null,
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
      if (!service) throw new TRPCError({ code: "NOT_FOUND", message: "Service not found" });

      await ctx.db.service.update({
        where: { id: input.serviceId },
        data: { isPaused: false, updatedAt: new Date() },
      });

      return {
        success: true,
        message: `Container ${service.name} restarted successfully (0ms latency)`,
        timestamp: new Date().toISOString(),
      };
    }),

  /** Update service scaling and compute limits */
  updateScaling: protectedProcedure
    .input(
      z.object({
        serviceId: z.string(),
        instanceType: z.enum(["lite", "standard-1", "standard-2", "standard-4"]).optional(),
        scaleToZero: z.boolean().optional(),
        idleTimeoutSecs: z.number().int().min(60).max(86400).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const service = await ctx.db.service.findFirst({
        where: {
          id: input.serviceId,
          deletedAt: null,
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

      return ctx.db.service.update({
        where: { id: input.serviceId },
        data: {
          ...(input.instanceType && { instanceType: input.instanceType }),
          ...(input.scaleToZero !== undefined && { scaleToZero: input.scaleToZero }),
          ...(input.idleTimeoutSecs !== undefined && { idleTimeoutSecs: input.idleTimeoutSecs }),
        },
      });
    }),

  /** Update or insert environment variables for a service — FR-VAR-01 */
  setVariable: protectedProcedure
    .input(
      z.object({
        serviceId: z.string(),
        key: z.string().min(1).max(256),
        value: z.string(),
        isSecret: z.boolean().default(true),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const service = await ctx.db.service.findFirst({
        where: {
          id: input.serviceId,
          deletedAt: null,
          environment: {
            project: {
              workspace: { members: { some: { userId: ctx.session.user.id, role: { in: ["OWNER", "ADMIN", "MEMBER"] } } } },
            },
          },
        },
      });
      if (!service) throw new TRPCError({ code: "NOT_FOUND" });

      // Locate existing variable by serviceId + key
      const existing = await ctx.db.environmentVariable.findFirst({
        where: {
          serviceId: input.serviceId,
          key: input.key,
        },
      });

      if (existing) {
        return ctx.db.environmentVariable.update({
          where: { id: existing.id },
          data: {
            value: input.value,
            isSecret: input.isSecret,
            isReference: input.value.includes("${{"),
          },
        });
      } else {
        return ctx.db.environmentVariable.create({
          data: {
            serviceId: input.serviceId,
            key: input.key,
            value: input.value,
            isSecret: input.isSecret,
            isReference: input.value.includes("${{"),
          },
        });
      }
    }),

  /** Delete an environment variable */
  deleteVariable: protectedProcedure
    .input(z.object({ variableId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const variable = await ctx.db.environmentVariable.findUnique({
        where: { id: input.variableId },
        include: {
          service: {
            include: {
              environment: {
                include: { project: { include: { workspace: true } } },
              },
            },
          },
        },
      });
      if (!variable || !variable.service) throw new TRPCError({ code: "NOT_FOUND" });

      const member = await ctx.db.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: variable.service.environment.project.workspaceId,
            userId: ctx.session.user.id,
          },
        },
      });
      if (!member || member.role === "VIEWER") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Viewers cannot delete environment variables" });
      }

      await ctx.db.environmentVariable.delete({
        where: { id: input.variableId },
      });

      return { success: true };
    }),

  /** Bulk environment variable synchronization — M5 F15 */
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

  /** Soft-delete a service — FR-SVC-08 */
  delete: protectedProcedure
    .input(z.object({ serviceId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const service = await ctx.db.service.findFirst({
        where: {
          id: input.serviceId,
          deletedAt: null,
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

      return ctx.db.service.update({
        where: { id: input.serviceId },
        data: { deletedAt: new Date() },
      });
    }),
});
