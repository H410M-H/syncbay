/**
 * Syncbay — Data view inventory (project → environments → databases, services → volumes; buckets).
 * Explicit `select`s only: no variables, no raw connection URLs, no passwords leave the server.
 * Database URLs are returned masked (`maskConnectionUrl`).
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import { maskConnectionUrl } from "@/lib/query-studio/preview";
import { getRunnerBaseUrl } from "@/lib/runner-client";
import { readStorageConfig, storageProvider } from "@/lib/storage-provider";

export const dataRouter = createTRPCRouter({
  inventory: protectedProcedure.input(z.object({ projectId: z.string() })).query(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;
    const project = await ctx.db.project.findFirst({
      where: { id: input.projectId, deletedAt: null, workspace: { members: { some: { userId } } } },
      select: {
        id: true,
        name: true,
        workspace: { select: { name: true, slug: true, members: { where: { userId }, select: { role: true } } } },
        buckets: { select: { id: true, name: true, r2BucketRef: true, createdAt: true }, orderBy: { createdAt: "asc" } },
        environments: {
          orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
          select: {
            id: true,
            name: true,
            isDefault: true,
            databases: {
              orderBy: { createdAt: "asc" },
              select: {
                id: true,
                name: true,
                provider: true,
                status: true,
                region: true,
                storageGb: true,
                host: true,
                port: true,
                containerId: true,
                lastHealthAt: true,
                connectionUrl: true,
              },
            },
            services: {
              where: { deletedAt: null },
              orderBy: { createdAt: "asc" },
              select: {
                id: true,
                name: true,
                volumes: { orderBy: { createdAt: "asc" }, select: { id: true, name: true, mountPath: true, sizeGb: true, createdAt: true } },
              },
            },
          },
        },
      },
    });
    if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });

    const runnerConfigured = Boolean(getRunnerBaseUrl());
    return {
      id: project.id,
      name: project.name,
      workspace: { name: project.workspace.name, slug: project.workspace.slug },
      myRole: project.workspace.members[0]?.role ?? null,
      runnerConfigured,
      storageConfigured: storageProvider.isStorageConfigured(),
      storageEndpoint: storageProvider.describeBucket({ name: "x", projectId: "x" }, readStorageConfig()).endpoint,
      buckets: project.buckets,
      environments: project.environments.map((env) => ({
        id: env.id,
        name: env.name,
        isDefault: env.isDefault,
        databases: env.databases.map(({ connectionUrl, containerId, ...db }) => ({
          ...db,
          maskedUrl: maskConnectionUrl(connectionUrl),
          simulated: /\.syncbay-db\.internal\b/.test(connectionUrl),
          runnerManaged: Boolean(containerId && runnerConfigured),
        })),
        services: env.services,
      })),
    };
  }),
});
