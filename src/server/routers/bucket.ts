/**
 * Syncbay PaaS — Object Storage (Bucket) tRPC Router (R6 Core)
 * Handles S3/Cloudflare R2 bucket provisioning, access keys, and presigned URLs.
 */

import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import { TRPCError } from "@trpc/server";
import { storageProvider } from "@/lib/storage-provider";

export const bucketRouter = createTRPCRouter({
  /**
   * List all storage buckets in a project or workspace
   */
  list: protectedProcedure
    .input(
      z
        .object({
          projectId: z.string().optional(),
          workspaceId: z.string().optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const where: any = {
        project: {
          deletedAt: null,
          workspace: { members: { some: { userId: ctx.session.user.id } } },
        },
      };

      if (input?.projectId) {
        where.projectId = input.projectId;
      }
      if (input?.workspaceId) {
        where.project.workspaceId = input.workspaceId;
      }

      const buckets = await ctx.db.bucket.findMany({
        where,
        include: {
          project: true,
        },
        orderBy: { createdAt: "desc" },
      });

      return buckets.map((b) => ({
        ...b,
        endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID || "syncbay-storage"}.r2.cloudflarestorage.com`,
        publicUrl: `https://${b.r2BucketRef}.r2.dev`,
      }));
    }),

  /**
   * Get bucket details and credentials by ID
   */
  byId: protectedProcedure
    .input(z.object({ bucketId: z.string() }))
    .query(async ({ ctx, input }) => {
      const bucket = await ctx.db.bucket.findFirst({
        where: {
          id: input.bucketId,
          project: {
            deletedAt: null,
            workspace: { members: { some: { userId: ctx.session.user.id } } },
          },
        },
        include: { project: true },
      });

      if (!bucket) throw new TRPCError({ code: "NOT_FOUND", message: "Bucket not found" });

      const details = await storageProvider.provisionBucket({
        name: bucket.name,
        projectId: bucket.projectId,
      });

      return {
        ...bucket,
        endpoint: details.endpoint,
        region: details.region,
        accessKeyId: details.accessKeyId,
        secretAccessKey: details.secretAccessKey,
        publicUrl: details.publicUrl,
      };
    }),

  /**
   * Create a new object storage bucket
   */
  create: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        name: z.string().min(1).max(64),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const project = await ctx.db.project.findFirst({
        where: {
          id: input.projectId,
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

      if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });

      // Check if bucket with same name already exists in project
      const existing = await ctx.db.bucket.findFirst({
        where: {
          projectId: input.projectId,
          name: input.name,
        },
      });

      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Bucket "${input.name}" already exists in this project`,
        });
      }

      // Provision storage bucket
      const details = await storageProvider.provisionBucket({
        name: input.name,
        projectId: input.projectId,
      });

      const bucket = await ctx.db.bucket.create({
        data: {
          projectId: input.projectId,
          name: input.name,
          r2BucketRef: details.r2BucketRef,
        },
      });

      return {
        ...bucket,
        endpoint: details.endpoint,
        region: details.region,
        accessKeyId: details.accessKeyId,
        secretAccessKey: details.secretAccessKey,
        publicUrl: details.publicUrl,
      };
    }),

  /**
   * Generate an authentic S3 / Cloudflare R2 presigned URL for upload or download
   */
  generatePresignedUrl: protectedProcedure
    .input(
      z.object({
        bucketId: z.string(),
        key: z.string().min(1),
        operation: z.enum(["get", "put"]).default("get"),
        expiresInSeconds: z.number().int().min(60).max(86400).default(3600),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const bucket = await ctx.db.bucket.findFirst({
        where: {
          id: input.bucketId,
          project: {
            deletedAt: null,
            workspace: { members: { some: { userId: ctx.session.user.id } } },
          },
        },
      });

      if (!bucket) throw new TRPCError({ code: "NOT_FOUND", message: "Bucket not found" });

      const presignedUrl = await storageProvider.generatePresignedUrl({
        bucketName: bucket.r2BucketRef,
        key: input.key,
        operation: input.operation,
        expiresInSeconds: input.expiresInSeconds,
      });

      return {
        bucketId: bucket.id,
        bucketName: bucket.name,
        key: input.key,
        operation: input.operation,
        url: presignedUrl,
        expiresInSeconds: input.expiresInSeconds,
      };
    }),

  /**
   * Delete an object storage bucket
   */
  delete: protectedProcedure
    .input(z.object({ bucketId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const bucket = await ctx.db.bucket.findFirst({
        where: {
          id: input.bucketId,
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
      });

      if (!bucket) throw new TRPCError({ code: "NOT_FOUND", message: "Bucket not found" });

      await ctx.db.bucket.delete({
        where: { id: input.bucketId },
      });

      return { success: true };
    }),
});
