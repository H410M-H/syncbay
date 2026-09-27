/**
 * Syncbay PaaS — Database Query Studio tRPC Router (M7)
 * Provides SQL & Redis query execution and schema tree introspection.
 */

import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import { TRPCError } from "@trpc/server";
import { executeQuery, getDatabaseSchema } from "@/lib/query-studio/engine";

export const queryStudioRouter = createTRPCRouter({
  /** Execute SQL or Redis query against managed database */
  execute: protectedProcedure
    .input(
      z.object({
        databaseId: z.string(),
        query: z.string().min(1),
        safeMode: z.boolean().default(true),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const dbInstance = await ctx.db.databaseInstance.findFirst({
        where: {
          id: input.databaseId,
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

      if (!dbInstance) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Database not found or unauthorized" });
      }

      try {
        const result = await executeQuery(input.query, dbInstance.provider as any, input.safeMode);
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

  /** Get database tables and schema tree */
  getSchema: protectedProcedure
    .input(z.object({ databaseId: z.string() }))
    .query(async ({ ctx, input }) => {
      const dbInstance = await ctx.db.databaseInstance.findFirst({
        where: {
          id: input.databaseId,
          environment: { project: { workspace: { members: { some: { userId: ctx.session.user.id } } } } },
        },
      });

      if (!dbInstance) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Database not found or unauthorized" });
      }

      const tables = getDatabaseSchema(dbInstance.provider as any);
      return {
        databaseName: dbInstance.name,
        provider: dbInstance.provider,
        tables,
      };
    }),
});
