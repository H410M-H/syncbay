import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import { TRPCError } from "@trpc/server";
import {
  provisionManagedDatabase,
  destroyManagedDatabase,
  parseDatabaseUrl,
} from "@/lib/database-provider";
import { DatabaseProvider } from "@prisma/client";

export const databaseRouter = createTRPCRouter({
  /**
   * List databases filtered by environment, project, or workspace
   */
  list: protectedProcedure
    .input(
      z.object({
        environmentId: z.string().optional(),
        projectId: z.string().optional(),
        workspaceId: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const whereClause: any = {
        environment: {
          project: {
            deletedAt: null,
            workspace: {
              members: { some: { userId: ctx.session.user.id } },
            },
          },
        },
      };

      if (input.environmentId) {
        whereClause.environmentId = input.environmentId;
      }
      if (input.projectId) {
        whereClause.environment.projectId = input.projectId;
      }
      if (input.workspaceId) {
        whereClause.environment.project.workspaceId = input.workspaceId;
      }

      const instances = await ctx.db.databaseInstance.findMany({
        where: whereClause,
        include: {
          environment: {
            include: {
              project: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      return instances.map((inst) => ({
        ...inst,
        credentials: parseDatabaseUrl(inst.connectionUrl, inst.provider),
      }));
    }),

  /**
   * Get database details by ID
   */
  byId: protectedProcedure
    .input(z.object({ databaseId: z.string() }))
    .query(async ({ ctx, input }) => {
      const instance = await ctx.db.databaseInstance.findFirst({
        where: {
          id: input.databaseId,
          environment: {
            project: {
              deletedAt: null,
              workspace: {
                members: { some: { userId: ctx.session.user.id } },
              },
            },
          },
        },
        include: {
          environment: {
            include: {
              project: true,
            },
          },
        },
      });

      if (!instance) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Database instance not found" });
      }

      return {
        ...instance,
        credentials: parseDatabaseUrl(instance.connectionUrl, instance.provider),
      };
    }),

  /**
   * Provision a new database
   */
  create: protectedProcedure
    .input(
      z.object({
        environmentId: z.string(),
        name: z.string().min(1).max(64),
        provider: z.nativeEnum(DatabaseProvider),
        region: z.string().default("us-east-1"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // 1. Verify access to the environment
      const env = await ctx.db.environment.findFirst({
        where: { id: input.environmentId },
        include: { project: true },
      });

      if (!env) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Environment not found" });
      }

      const project = await ctx.db.project.findFirst({
        where: {
          id: env.projectId,
          deletedAt: null,
          workspace: {
            members: {
              some: {
                userId: ctx.session.user.id,
                role: { in: ["OWNER", "ADMIN", "MEMBER"] },
              },
            },
          },
        },
      });

      if (!project) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Insufficient permissions to provision database" });
      }

      // 2. Call partner API or local provider to provision
      const provisionResult = await provisionManagedDatabase({
        projectId: project.id,
        environmentId: env.id,
        name: input.name,
        provider: input.provider,
        region: input.region,
      });

      // 3. Save database instance to database
      const dbInstance = await ctx.db.databaseInstance.create({
        data: {
          environmentId: env.id,
          name: input.name,
          provider: input.provider,
          region: input.region,
          partnerDbId: provisionResult.partnerDbId,
          connectionUrl: provisionResult.connectionUrl,
        },
      });

      // 4. Create an EnvironmentVariable linked properly
      const envVarKey = input.name.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_URL";

      // Attach workspace-level variable if none exists
      const existingWsVar = await ctx.db.environmentVariable.findFirst({
        where: {
          workspaceId: project.workspaceId,
          serviceId: null,
          key: envVarKey,
        },
      });
      if (!existingWsVar) {
        await ctx.db.environmentVariable.create({
          data: {
            workspaceId: project.workspaceId,
            key: envVarKey,
            value: provisionResult.connectionUrl,
            isSecret: true,
            isReference: false,
          },
        });
      }

      // Attach to all existing services in this environment
      const services = await ctx.db.service.findMany({
        where: { environmentId: env.id, deletedAt: null },
      });

      for (const svc of services) {
        const existingSvcVar = await ctx.db.environmentVariable.findFirst({
          where: { serviceId: svc.id, key: envVarKey },
        });

        if (existingSvcVar) {
          await ctx.db.environmentVariable.update({
            where: { id: existingSvcVar.id },
            data: { value: provisionResult.connectionUrl },
          });
        } else {
          await ctx.db.environmentVariable.create({
            data: {
              serviceId: svc.id,
              key: envVarKey,
              value: provisionResult.connectionUrl,
              isSecret: true,
              isReference: false,
            },
          });
        }
      }

      return {
        ...dbInstance,
        credentials: parseDatabaseUrl(dbInstance.connectionUrl, dbInstance.provider),
      };
    }),

  /**
   * Delete a database
   */
  delete: protectedProcedure
    .input(z.object({ databaseId: z.string(), confirmName: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const dbInstance = await ctx.db.databaseInstance.findUnique({
        where: { id: input.databaseId },
        include: { environment: { include: { project: true } } },
      });

      if (!dbInstance) throw new TRPCError({ code: "NOT_FOUND" });
      if (dbInstance.name !== input.confirmName) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Name confirmation mismatch" });
      }

      // Verify access — OWNER or MEMBER only
      const member = await ctx.db.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: dbInstance.environment.project.workspaceId,
            userId: ctx.session.user.id,
          },
        },
      });

      if (!member || member.role === "VIEWER") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Viewers cannot delete databases" });
      }

      // Call partner API / provider destruction
      if (dbInstance.partnerDbId) {
        await destroyManagedDatabase(dbInstance.partnerDbId);
      }

      // Delete from our DB
      await ctx.db.databaseInstance.delete({ where: { id: input.databaseId } });

      return { success: true };
    }),
});
