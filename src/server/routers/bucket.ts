/**
 * Syncbay — Object Storage (Cloudflare R2 bucket) tRPC Router.
 * Buckets are real R2 buckets; objects are listed from R2 and shared through
 * presigned URLs signed with the platform's R2 keys. No per-bucket credentials
 * are fabricated.
 */

import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import { TRPCError } from "@trpc/server";
import { StorageNotConfiguredError, readStorageConfig, storageProvider } from "@/lib/storage-provider";

function toTrpcError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof StorageNotConfiguredError) {
    return new TRPCError({ code: "PRECONDITION_FAILED", message: err.message });
  }
  const e = err as { name?: string; message?: string };
  console.error("[bucket] storage error:", e?.name, e?.message);
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Object storage error: ${e?.message ?? "unknown"}` });
}

const memberScope = (userId: string, roles?: Array<"OWNER" | "ADMIN" | "MEMBER">) => ({
  deletedAt: null,
  workspace: { members: { some: roles ? { userId, role: { in: roles } } : { userId } } },
});

export const bucketRouter = createTRPCRouter({
  /** Whether R2 is configured on this deployment. */
  status: protectedProcedure.query(() => {
    const config = readStorageConfig();
    return {
      configured: storageProvider.isStorageConfigured(),
      endpoint: storageProvider.describeBucket({ name: "x", projectId: "x" }, config).endpoint,
      bucketApi: config.endpointOverride ? "s3" : config.apiToken && config.accountId ? "cloudflare" : "s3",
    };
  }),

  /** List all storage buckets in a project or workspace */
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
      const where: any = { project: memberScope(ctx.session.user.id) };
      if (input?.projectId) where.projectId = input.projectId;
      if (input?.workspaceId) where.project.workspaceId = input.workspaceId;

      const buckets = await ctx.db.bucket.findMany({
        where,
        include: { project: true },
        orderBy: { createdAt: "desc" },
      });

      const config = readStorageConfig();
      return buckets.map((b) => {
        const details = storageProvider.describeBucket({ name: b.name, projectId: b.projectId, r2BucketRef: b.r2BucketRef }, config);
        return { ...b, endpoint: details.endpoint, region: details.region, publicUrl: details.publicUrl };
      });
    }),

  /** Get bucket details by ID */
  byId: protectedProcedure.input(z.object({ bucketId: z.string() })).query(async ({ ctx, input }) => {
    const bucket = await ctx.db.bucket.findFirst({
      where: { id: input.bucketId, project: memberScope(ctx.session.user.id) },
      include: { project: true },
    });
    if (!bucket) throw new TRPCError({ code: "NOT_FOUND", message: "Bucket not found" });

    const details = storageProvider.describeBucket({ name: bucket.name, projectId: bucket.projectId, r2BucketRef: bucket.r2BucketRef });
    return { ...bucket, endpoint: details.endpoint, region: details.region, publicUrl: details.publicUrl };
  }),

  /** List objects stored in the bucket (from R2) */
  listObjects: protectedProcedure
    .input(
      z.object({
        bucketId: z.string(),
        prefix: z.string().max(1024).optional(),
        cursor: z.string().max(2048).optional(),
        limit: z.number().int().min(1).max(1000).default(100),
      })
    )
    .query(async ({ ctx, input }) => {
      const bucket = await ctx.db.bucket.findFirst({
        where: { id: input.bucketId, project: memberScope(ctx.session.user.id) },
      });
      if (!bucket) throw new TRPCError({ code: "NOT_FOUND", message: "Bucket not found" });
      try {
        return await storageProvider.listObjects(bucket.r2BucketRef, {
          prefix: input.prefix,
          continuationToken: input.cursor,
          maxKeys: input.limit,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Create a new object storage bucket (creates the real R2 bucket first) */
  create: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        name: z.string().min(1).max(64),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const project = await ctx.db.project.findFirst({
        where: { id: input.projectId, ...memberScope(ctx.session.user.id, ["OWNER", "ADMIN", "MEMBER"]) },
      });
      if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });

      const existing = await ctx.db.bucket.findFirst({
        where: { projectId: input.projectId, name: input.name },
      });
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Bucket "${input.name}" already exists in this project`,
        });
      }

      let details;
      try {
        details = await storageProvider.provisionBucket({ name: input.name, projectId: input.projectId });
      } catch (err) {
        throw toTrpcError(err);
      }

      try {
        const bucket = await ctx.db.bucket.create({
          data: { projectId: input.projectId, name: input.name, r2BucketRef: details.r2BucketRef },
        });
        return { ...bucket, endpoint: details.endpoint, region: details.region, publicUrl: details.publicUrl };
      } catch (err) {
        // Don't leave an orphaned remote bucket behind.
        await storageProvider.deleteBucket(details.r2BucketRef).catch(() => undefined);
        throw err;
      }
    }),

  /** Generate a presigned GET/PUT URL for an object (signed with the R2 keys) */
  generatePresignedUrl: protectedProcedure
    .input(
      z.object({
        bucketId: z.string(),
        key: z.string().min(1).max(1024),
        operation: z.enum(["get", "put"]).default("get"),
        expiresInSeconds: z.number().int().min(60).max(604800).default(3600),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const bucket = await ctx.db.bucket.findFirst({
        where: { id: input.bucketId, project: memberScope(ctx.session.user.id) },
      });
      if (!bucket) throw new TRPCError({ code: "NOT_FOUND", message: "Bucket not found" });

      let presignedUrl: string;
      try {
        presignedUrl = await storageProvider.generatePresignedUrl({
          bucketName: bucket.r2BucketRef,
          key: input.key,
          operation: input.operation,
          expiresInSeconds: input.expiresInSeconds,
        });
      } catch (err) {
        throw toTrpcError(err);
      }

      return {
        bucketId: bucket.id,
        bucketName: bucket.name,
        key: input.key,
        operation: input.operation,
        url: presignedUrl,
        expiresInSeconds: input.expiresInSeconds,
      };
    }),

  /** Delete a bucket: empties and deletes the real R2 bucket, then the record */
  delete: protectedProcedure.input(z.object({ bucketId: z.string() })).mutation(async ({ ctx, input }) => {
    const bucket = await ctx.db.bucket.findFirst({
      where: { id: input.bucketId, project: memberScope(ctx.session.user.id, ["OWNER", "ADMIN", "MEMBER"]) },
    });
    if (!bucket) throw new TRPCError({ code: "NOT_FOUND", message: "Bucket not found" });

    let objectsRemoved = 0;
    let remoteDeleted = false;
    if (storageProvider.isStorageConfigured()) {
      try {
        const res = await storageProvider.deleteBucket(bucket.r2BucketRef);
        objectsRemoved = res.objectsRemoved;
        remoteDeleted = true;
      } catch (err) {
        throw toTrpcError(err);
      }
    } else if (process.env.NODE_ENV === "production") {
      // Fail closed: never drop the record of a bucket we could not delete.
      throw toTrpcError(new StorageNotConfiguredError("R2 object storage is not configured; the bucket cannot be deleted."));
    }

    await ctx.db.bucket.delete({ where: { id: input.bucketId } });
    return { success: true, remoteDeleted, objectsRemoved };
  }),
});
