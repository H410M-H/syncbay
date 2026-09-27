/**
 * Syncbay PaaS — Persistent Storage Volumes tRPC Router (R6 Core)
 * Manages persistent disk volumes mounted to stateful container services.
 */

import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import { TRPCError } from "@trpc/server";

export const volumeRouter = createTRPCRouter({
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
