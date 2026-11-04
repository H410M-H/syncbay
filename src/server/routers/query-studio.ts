/**
 * Syncbay PaaS — Database Query Studio tRPC Router (M7)
 * Runs real queries against a managed database's connection URL and returns its real schema.
 * Read-only by default; write mode requires the OWNER or ADMIN workspace role.
 */

import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import { TRPCError } from "@trpc/server";
import { executeQuery, getDatabaseSchema, type QueryProvider } from "@/lib/query-studio/engine";

const WRITE_ROLES = new Set(["OWNER", "ADMIN"]);

async function loadDatabaseForUser(db: any, userId: string, databaseId: string) {
  const dbInstance = await db.databaseInstance.findFirst({
    where: {
      id: databaseId,
      environment: { project: { deletedAt: null, workspace: { members: { some: { userId } } } } },
    },
    include: {
      environment: {
        include: {
          project: { include: { workspace: { include: { members: { where: { userId }, select: { role: true } } } } } },
        },
      },
    },
  });
  if (!dbInstance) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Database not found or unauthorized" });
  }
  const role: string | undefined = dbInstance.environment?.project?.workspace?.members?.[0]?.role;
  return { dbInstance, role };
}

export const queryStudioRouter = createTRPCRouter({
  /** Execute SQL or a Redis command against a managed database */
  execute: protectedProcedure
    .input(
      z.object({
        databaseId: z.string(),
        query: z.string().min(1).max(100_000),
        safeMode: z.boolean().default(true),
        mode: z.enum(["read", "write"]).default("read"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { dbInstance, role } = await loadDatabaseForUser(ctx.db, ctx.session.user.id, input.databaseId);
      if (!role || role === "VIEWER") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Viewers cannot run queries" });
      }
      if (input.mode === "write" && !WRITE_ROLES.has(role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Write mode requires the OWNER or ADMIN role" });
      }

      try {
        const result = await executeQuery(
          { provider: dbInstance.provider as QueryProvider, connectionUrl: dbInstance.connectionUrl },
          input.query,
          { mode: input.mode, safeMode: input.safeMode }
        );
        return {
          ...result,
          databaseName: dbInstance.name,
          provider: dbInstance.provider,
        };
      } catch (err: any) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: err.message || "Query execution failed",
        });
      }
    }),

  /** Get database tables (or Redis keys) from live introspection */
  getSchema: protectedProcedure
    .input(z.object({ databaseId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { dbInstance, role } = await loadDatabaseForUser(ctx.db, ctx.session.user.id, input.databaseId);
      try {
        const tables = await getDatabaseSchema({
          provider: dbInstance.provider as QueryProvider,
          connectionUrl: dbInstance.connectionUrl,
        });
        return {
          databaseName: dbInstance.name,
          provider: dbInstance.provider,
          canWrite: Boolean(role && WRITE_ROLES.has(role)),
          tables,
        };
      } catch (err: any) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Schema introspection failed: ${err.message}` });
      }
    }),
});
