/**
 * Syncbay PaaS — Custom Domains & SSL tRPC Router (R5 Core)
 * Handles custom domain registration, DNS verification checks (CNAME & TXT),
 * and SSL certificate lifecycle.
 */

import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import { TRPCError } from "@trpc/server";
import { domainService, generateVerificationRecords, isValidHostname } from "@/lib/domain-service";

export const domainRouter = createTRPCRouter({
  /**
   * List all domains registered for a service
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

      const domains = await ctx.db.domain.findMany({
        where: { serviceId: input.serviceId },
        orderBy: [{ isGenerated: "desc" }, { createdAt: "desc" }],
      });

      return domains.map((d) => ({
        ...d,
        verificationRecords: d.isGenerated ? null : generateVerificationRecords(d.hostname),
      }));
    }),

  /**
   * Add a custom domain to a service
   */
  create: protectedProcedure
    .input(
      z.object({
        serviceId: z.string(),
        hostname: z.string().min(3).max(253),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const cleanHostname = input.hostname.toLowerCase().trim().replace(/^https?:\/\//, "").replace(/\/$/, "");

      if (!isValidHostname(cleanHostname)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid domain format. Enter a valid fully-qualified domain name (e.g. app.example.com)",
        });
      }

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

      // DR-06: Hostname must be globally unique
      const existing = await ctx.db.domain.findUnique({
        where: { hostname: cleanHostname },
      });

      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Hostname "${cleanHostname}" is already associated with another service`,
        });
      }

      const verification = generateVerificationRecords(cleanHostname);

      const domain = await ctx.db.domain.create({
        data: {
          serviceId: input.serviceId,
          hostname: cleanHostname,
          isGenerated: false,
          status: "PENDING",
          verificationTxt: verification.txtRecord,
        },
      });

      return {
        ...domain,
        verificationRecords: verification,
      };
    }),

  /**
   * Trigger DNS verification and SSL certificate issuance
   */
  verify: protectedProcedure
    .input(z.object({ domainId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const domain = await ctx.db.domain.findFirst({
        where: {
          id: input.domainId,
          service: {
            deletedAt: null,
            environment: {
              project: {
                workspace: { members: { some: { userId: ctx.session.user.id } } },
              },
            },
          },
        },
      });

      if (!domain) throw new TRPCError({ code: "NOT_FOUND", message: "Domain not found" });

      const newStatus = await domainService.verifyDomain(input.domainId);

      const updated = await ctx.db.domain.findUnique({
        where: { id: input.domainId },
      });

      return {
        ...updated,
        status: newStatus,
        verificationRecords: updated?.isGenerated ? null : generateVerificationRecords(updated?.hostname || ""),
      };
    }),

  /**
   * Get DNS verification instructions for a domain
   */
  records: protectedProcedure
    .input(z.object({ domainId: z.string() }))
    .query(async ({ ctx, input }) => {
      const domain = await ctx.db.domain.findFirst({
        where: {
          id: input.domainId,
          service: {
            deletedAt: null,
            environment: {
              project: {
                workspace: { members: { some: { userId: ctx.session.user.id } } },
              },
            },
          },
        },
      });

      if (!domain) throw new TRPCError({ code: "NOT_FOUND", message: "Domain not found" });

      return {
        domain,
        records: generateVerificationRecords(domain.hostname),
      };
    }),

  /**
   * Delete a domain from a service
   */
  delete: protectedProcedure
    .input(z.object({ domainId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const domain = await ctx.db.domain.findFirst({
        where: {
          id: input.domainId,
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

      if (!domain) throw new TRPCError({ code: "NOT_FOUND", message: "Domain not found" });

      await ctx.db.domain.delete({
        where: { id: input.domainId },
      });

      return { success: true };
    }),
});
