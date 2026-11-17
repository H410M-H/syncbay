/**
 * Syncbay PaaS — Persistent Storage Volumes tRPC Router (R6 Core)
 * Manages persistent disk volumes mounted to stateful container services.
 */

import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import { TRPCError } from "@trpc/server";
import type { TRPCContext } from "@/server/trpc";
import {
  VolumeRunnerError,
  listVolumeFiles,
  readVolumeFile,
  statVolume,
  toVolumePreview,
} from "@/lib/volumes/volume-access";

/** A volume the caller may see (any member), with the caller's role. NOT_FOUND otherwise. */
async function loadVolumeForMember(db: TRPCContext["db"], userId: string, volumeId: string) {
  const volume = await db.volume.findFirst({
    where: {
      id: volumeId,
      service: {
        deletedAt: null,
        environment: { project: { deletedAt: null, workspace: { members: { some: { userId } } } } },
      },
    },
    select: {
      id: true,
      name: true,
      mountPath: true,
      service: { select: { environment: { select: { project: { select: { workspace: { select: { members: { where: { userId }, select: { role: true } } } } } } } } } },
    },
  });
  if (!volume) throw new TRPCError({ code: "NOT_FOUND", message: "Volume not found" });
  const role = volume.service.environment.project.workspace.members[0]?.role;
  return { id: volume.id, name: volume.name, mountPath: volume.mountPath, role };
}

/** Runner answers → tRPC errors; the hint travels in the message. */
function toVolumeTrpcError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof VolumeRunnerError) {
    const code =
      err.code === "NO_RUNNER" || err.code === "RUNNER_OUTDATED"
        ? "PRECONDITION_FAILED"
        : err.status === 400 || err.status === 409
        ? "BAD_REQUEST"
        : err.status === 403
        ? "FORBIDDEN"
        : err.status === 404
        ? "NOT_FOUND"
        : "INTERNAL_SERVER_ERROR";
    return new TRPCError({ code, message: err.hint ? `${err.message}. ${err.hint}` : err.message });
  }
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: (err as Error)?.message || "Volume access failed" });
}

const volumePath = z
  .string()
  .max(4096)
  .refine((p) => !p.includes("\0"), { message: "Path contains a NUL byte" })
  .default("");

export const volumeRouter = createTRPCRouter({
  /** Connection test: asks the hosting runner whether it holds the volume and can read it. */
  checkConnection: protectedProcedure
    .input(z.object({ volumeId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const volume = await loadVolumeForMember(ctx.db, ctx.session.user.id, input.volumeId);
      const started = Date.now();
      try {
        const stat = await statVolume(volume.id);
        return { ok: true as const, latencyMs: Date.now() - started, backend: stat.backend, access: stat.access, entries: stat.entries, truncated: stat.truncated };
      } catch (err) {
        if (!(err instanceof VolumeRunnerError)) throw toVolumeTrpcError(err);
        return { ok: false as const, latencyMs: Date.now() - started, error: err.message, hint: err.hint, code: err.code };
      }
    }),

  /** Directory listing inside the volume (≤ 500 entries), from the runner. Any member. */
  listFiles: protectedProcedure
    .input(z.object({ volumeId: z.string(), path: volumePath }))
    .query(async ({ ctx, input }) => {
      const volume = await loadVolumeForMember(ctx.db, ctx.session.user.id, input.volumeId);
      try {
        const listing = await listVolumeFiles(volume.id, input.path);
        return { volumeId: volume.id, name: volume.name, mountPath: volume.mountPath, ...listing };
      } catch (err) {
        throw toVolumeTrpcError(err);
      }
    }),

  /** File preview (≤ 64 KiB of text; binary files report size and type only). Not for viewers. */
  readFile: protectedProcedure
    .input(z.object({ volumeId: z.string(), path: z.string().min(1).max(4096) }))
    .query(async ({ ctx, input }) => {
      const volume = await loadVolumeForMember(ctx.db, ctx.session.user.id, input.volumeId);
      if (!volume.role || volume.role === "VIEWER") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Viewers cannot read file contents" });
      }
      if (input.path.includes("\0")) throw new TRPCError({ code: "BAD_REQUEST", message: "Path contains a NUL byte" });
      try {
        return { volumeId: volume.id, ...toVolumePreview(await readVolumeFile(volume.id, input.path)) };
      } catch (err) {
        throw toVolumeTrpcError(err);
      }
    }),

  /**
   * List all persistent volumes mounted to a service
   */
  list: protectedProcedure
    .input(z.object({ serviceId: z.string() }))
    .query(async ({ ctx, input }) => {
      const service = await ctx.db.service.findFirst({
        where: {
          id: input.serviceId,
          deletedAt: null,
          environment: {
            project: {
              workspace: { members: { some: { userId: ctx.session.user.id } } },
            },
          },
        },
      });

      if (!service) throw new TRPCError({ code: "NOT_FOUND", message: "Service not found" });

      return ctx.db.volume.findMany({
        where: { serviceId: input.serviceId },
        orderBy: { createdAt: "asc" },
      });
    }),

  /**
   * Create and mount a new persistent volume to a service
   */
  create: protectedProcedure
    .input(
      z.object({
        serviceId: z.string(),
        name: z.string().min(1).max(64),
        mountPath: z
          .string()
          .startsWith("/")
          .refine((p) => p.length > 1 && !p.endsWith("/"), {
            message: "Mount path must be a valid absolute UNIX path (e.g. /data, /var/lib/storage)",
          }),
        sizeGb: z.number().int().min(1).max(1000).default(1),
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

      if (!service) throw new TRPCError({ code: "NOT_FOUND", message: "Service not found" });

      // Check for mount path collisions on same service
      const existing = await ctx.db.volume.findFirst({
        where: {
          serviceId: input.serviceId,
          OR: [{ mountPath: input.mountPath }, { name: input.name }],
        },
      });

      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            existing.name === input.name
              ? `A volume named "${input.name}" already exists on this service`
              : `Mount path "${input.mountPath}" is already occupied by volume "${existing.name}"`,
        });
      }

      return ctx.db.volume.create({
        data: {
          serviceId: input.serviceId,
          name: input.name,
          mountPath: input.mountPath,
          sizeGb: input.sizeGb,
        },
      });
    }),

  /**
   * Attach an existing volume to a different service
   */
  attach: protectedProcedure
    .input(
      z.object({
        volumeId: z.string(),
        targetServiceId: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Find volume and verify caller's workspace membership
      const volume = await ctx.db.volume.findFirst({
        where: {
          id: input.volumeId,
          service: {
            deletedAt: null,
            environment: {
              project: {
                workspace: { members: { some: { userId: ctx.session.user.id } } },
              },
            },
          },
        },
        include: {
          service: {
            include: { environment: { include: { project: true } } },
          },
        },
      });

      if (!volume) throw new TRPCError({ code: "NOT_FOUND", message: "Volume not found" });

      // Find target service in same workspace
      const targetService = await ctx.db.service.findFirst({
        where: {
          id: input.targetServiceId,
          deletedAt: null,
          environment: {
            project: {
              workspace: {
                id: volume.service.environment.project.workspaceId,
                members: { some: { userId: ctx.session.user.id } },
              },
            },
          },
        },
      });

      if (!targetService) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Target service not found in the same workspace",
        });
      }

      // Check mount path collision on target service
      const collision = await ctx.db.volume.findFirst({
        where: {
          serviceId: input.targetServiceId,
          mountPath: volume.mountPath,
          id: { not: input.volumeId },
        },
      });

      if (collision) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Target service already has a volume mounted at "${volume.mountPath}"`,
        });
      }

      return ctx.db.volume.update({
        where: { id: input.volumeId },
        data: { serviceId: input.targetServiceId },
      });
    }),

  /**
   * Delete a persistent volume
   */
  delete: protectedProcedure
    .input(z.object({ volumeId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const volume = await ctx.db.volume.findFirst({
        where: {
          id: input.volumeId,
          service: {
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
        },
      });

      if (!volume) throw new TRPCError({ code: "NOT_FOUND", message: "Volume not found" });

      await ctx.db.volume.delete({
        where: { id: input.volumeId },
      });

      return { success: true };
    }),
});
