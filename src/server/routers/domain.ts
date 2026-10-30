/**
 * Syncbay PaaS — Custom Domains & SSL tRPC Router (R5 Core)
 * Handles custom domain registration, DNS verification checks (CNAME & TXT),
 * Cloudflare Custom Hostnames integration, and SSL certificate lifecycle.
 */

import { z } from "zod";
import { domainToASCII } from "node:url";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import { TRPCError } from "@trpc/server";
import { domainService, generateVerificationRecords, isValidHostname } from "@/lib/domain-service";
import { cloudflareApiClient } from "@/lib/tunnel/cloudflare-api";
import { getCustomDomainTlsStatus } from "@/lib/edge/edge-router";
import { registerServiceRoute, removeServiceRoute } from "@/lib/edge/service-registry";

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
      const rawHost = input.hostname.toLowerCase().trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
      let cleanHostname: string;
      try {
        cleanHostname = domainToASCII(rawHost) || rawHost;
      } catch {
        cleanHostname = rawHost;
      }

      if (!isValidHostname(cleanHostname)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid domain format. Enter a valid fully-qualified domain name (e.g. app.example.com)",
        });
      }

      if (
        cleanHostname === "syncbay.app" ||
        cleanHostname.endsWith(".syncbay.app") ||
        cleanHostname === "localhost" ||
        cleanHostname.endsWith(".localhost")
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot register syncbay.app or localhost subdomains as custom domains",
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

      // Provision Custom Hostname with Cloudflare API
      const cfRecord = await cloudflareApiClient.createCustomHostname({ hostname: cleanHostname });
      const verification = generateVerificationRecords(cleanHostname);

      const domain = await ctx.db.domain.create({
        data: {
          serviceId: input.serviceId,
          hostname: cleanHostname,
          isGenerated: false,
          status: "PENDING",
          verificationTxt: verification.txtRecord,
          cfRecordId: cfRecord.id,
          cfZoneId: process.env.CLOUDFLARE_ZONE_ID || "cf_zone_managed",
        },
      });

      return {
        ...domain,
        verificationRecords: verification,
        cfRecord,
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
        include: {
          service: {
            include: {
              deployments: { orderBy: { createdAt: "desc" }, take: 1 },
            },
          },
        },
      });

      if (!domain) throw new TRPCError({ code: "NOT_FOUND", message: "Domain not found" });

      // Verify with Cloudflare Custom Hostnames API
      const cfResult = await cloudflareApiClient.verifyCustomHostname(domain.cfRecordId || domain.hostname);
      const newStatus = cfResult.status === "ACTIVE" ? "ACTIVE" : cfResult.status === "FAILED" ? "FAILED" : "VERIFYING";

      const updated = await ctx.db.domain.update({
        where: { id: input.domainId },
        data: {
          status: newStatus,
          verifiedAt: newStatus === "ACTIVE" ? new Date() : undefined,
        },
      });

      // If active, immediately register in Edge Service Registry for zero-latency ingress
      if (newStatus === "ACTIVE" && domain.service) {
        const port = domain.service.port || 3000;
        const isPaused = (domain.service as any).isPaused;
        const deployments = (domain.service as any).deployments;
        const latestStatus = Array.isArray(deployments) && deployments.length > 0 ? deployments[0].status : "ACTIVE";
        const routeStatus = isPaused ? "SLEEPING" : latestStatus || "ACTIVE";
        registerServiceRoute(domain.hostname, port, routeStatus, `http://127.0.0.1:${port}`);
      }

      return {
        ...updated,
        status: newStatus,
        sslStatus: cfResult.sslStatus,
        sslIssuer: cfResult.sslIssuer,
        verificationRecords: updated.isGenerated ? null : generateVerificationRecords(updated.hostname),
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
   * Query real-time Cloudflare Custom Hostname & SSL certificate status
   */
  status: protectedProcedure
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
        include: { service: true },
      });

      if (!domain) throw new TRPCError({ code: "NOT_FOUND", message: "Domain not found" });

      const cfRecord = await cloudflareApiClient.getCustomHostname(domain.cfRecordId || domain.hostname);
      const tls = getCustomDomainTlsStatus(domain.hostname);

      return {
        domain,
        cfRecord,
        tls,
        status: domain.status,
        sslStatus: cfRecord?.ssl?.status || (domain.status === "ACTIVE" ? "active" : "pending_validation"),
        verificationRecords: domain.isGenerated ? null : generateVerificationRecords(domain.hostname),
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

      if (domain.cfRecordId) {
        await cloudflareApiClient.deleteCustomHostname(domain.cfRecordId).catch(() => null);
      }
      removeServiceRoute(domain.hostname);

      await ctx.db.domain.delete({
        where: { id: input.domainId },
      });

      return { success: true };
    }),

  /**
   * Provision a scoped Cloudflare Tunnel token for a service/runner
   */
  provisionTunnel: protectedProcedure
    .input(z.object({ serviceId: z.string() }))
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

      const tunnel = await cloudflareApiClient.provisionTunnelToken(service.name);
      return tunnel;
    }),
});
