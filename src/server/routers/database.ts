import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import { TRPCError } from "@trpc/server";
import {
  provisionManagedDatabase,
  destroyManagedDatabase,
  checkDatabaseHealth,
  attachDatabaseVariables,
  detachDatabaseVariables,
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
   * Probe database health (pg_isready / redis-cli ping on the runner) and persist status
   */
  health: protectedProcedure
    .input(z.object({ databaseId: z.string() }))
    .query(async ({ ctx, input }) => {
      const instance = await ctx.db.databaseInstance.findFirst({
        where: {
          id: input.databaseId,
          environment: {
            project: {
              deletedAt: null,
              workspace: { members: { some: { userId: ctx.session.user.id } } },
            },
          },
        },
      });
      if (!instance) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Database instance not found" });
      }
      if (instance.status === "PROVISIONING" || instance.status === "DELETING" || instance.status === "FAILED") {
        return { databaseId: instance.id, status: instance.status, healthy: false, lastHealthAt: instance.lastHealthAt };
      }

      const result = await checkDatabaseHealth(instance);
      const updated = await ctx.db.databaseInstance.update({
        where: { id: instance.id },
        data: { status: result.status, lastHealthAt: new Date() },
      });
      return {
        databaseId: instance.id,
        status: updated.status,
        healthy: result.healthy,
        latencyMs: result.latencyMs,
        mode: result.mode,
        message: result.message,
        lastHealthAt: updated.lastHealthAt,
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
      // 1. Access check is part of the lookup: environments outside the caller's workspaces are invisible
      const env = await ctx.db.environment.findFirst({
        where: {
          id: input.environmentId,
          project: {
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
        },
        include: { project: true },
      });

      if (!env) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Environment not found or insufficient permissions to provision database" });
      }

      // 2. Record the instance as PROVISIONING, then provision on the runner / provider
      const pending = await ctx.db.databaseInstance.create({
        data: {
          environmentId: env.id,
          name: input.name,
          provider: input.provider,
          region: input.region,
          connectionUrl: "",
          status: "PROVISIONING",
        },
      });

      let provisionResult;
      try {
        provisionResult = await provisionManagedDatabase({
          id: pending.id,
          projectId: env.projectId,
          environmentId: env.id,
          name: input.name,
          provider: input.provider,
          region: input.region,
        });
      } catch (err: any) {
        await ctx.db.databaseInstance.update({ where: { id: pending.id }, data: { status: "FAILED" } }).catch(() => null);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Database provisioning failed: ${err.message}` });
      }

      const dbInstance = await ctx.db.databaseInstance.update({
        where: { id: pending.id },
        data: {
          partnerDbId: provisionResult.partnerDbId,
          connectionUrl: provisionResult.connectionUrl,
          host: provisionResult.host,
          port: provisionResult.port,
          containerId: provisionResult.containerId,
          status: "ACTIVE",
          lastHealthAt: new Date(),
        },
      });

      // 3. Inject <NAME>_URL + DATABASE_URL / REDIS_URL into existing services (never overriding user keys)
      await attachDatabaseVariables(ctx.db, {
        workspaceId: env.project.workspaceId,
        environmentId: env.id,
        name: input.name,
        provider: input.provider,
        connectionUrl: provisionResult.connectionUrl,
      });

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

      // Verify access — OWNER, ADMIN or MEMBER only
      const member = await ctx.db.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: dbInstance.environment.project.workspaceId,
            userId: ctx.session.user.id,
          },
        },
      });

      if (!member) throw new TRPCError({ code: "NOT_FOUND" });
      if (member.role === "VIEWER") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Viewers cannot delete databases" });
      }
      if (dbInstance.name !== input.confirmName) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Name confirmation mismatch" });
      }

      await ctx.db.databaseInstance.update({ where: { id: dbInstance.id }, data: { status: "DELETING" } });

      // Tear down the runner container / partner instance
      try {
        await destroyManagedDatabase(dbInstance);
      } catch (err: any) {
        await ctx.db.databaseInstance.update({ where: { id: dbInstance.id }, data: { status: "UNHEALTHY" } }).catch(() => null);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Database teardown failed: ${err.message}` });
      }

      // Remove injected variables that still point at this database
      if (dbInstance.connectionUrl) {
        await detachDatabaseVariables(ctx.db, {
          workspaceId: dbInstance.environment.project.workspaceId,
          environmentId: dbInstance.environmentId,
          name: dbInstance.name,
          provider: dbInstance.provider,
          connectionUrl: dbInstance.connectionUrl,
        });
      }

      await ctx.db.databaseInstance.delete({ where: { id: input.databaseId } });

      return { success: true };
    }),
});
