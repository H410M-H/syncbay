/**
 * Syncbay PaaS — Custom Domains & SSL tRPC Router (R5 Core)
 * Handles custom domain registration, DNS verification checks (CNAME & TXT),
 * Cloudflare Custom Hostnames integration, and SSL certificate lifecycle.
 */

import { z } from "zod";
import { domainToASCII } from "node:url";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import { TRPCError } from "@trpc/server";
import { generateVerificationRecords, isValidHostname, verifyDomainDetailed } from "@/lib/domain-service";
import { cloudflareApiClient, CloudflareNotConfiguredError } from "@/lib/tunnel/cloudflare-api";
import { getCustomDomainTlsStatus } from "@/lib/edge/edge-router";
import { registerServiceRouteAsync, removeServiceRouteAsync } from "@/lib/edge/service-registry";
import { resolveDomainUpstream } from "@/lib/edge/domain-upstream";
import { requestTunnelReload } from "@/lib/tunnel/tunnel-sync";

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

      // Provision the Custom Hostname with Cloudflare for SaaS when configured. Without it the
      // domain is verified by DNS alone (no simulated Cloudflare record in production).
      let cfRecord: Awaited<ReturnType<typeof cloudflareApiClient.createCustomHostname>> | null = null;
      if (cloudflareApiClient.isLiveApiConfigured || process.env.NODE_ENV !== "production") {
        try {
          cfRecord = await cloudflareApiClient.createCustomHostname({ hostname: cleanHostname });
        } catch (err: any) {
          throw new TRPCError({ code: "BAD_GATEWAY", message: `Cloudflare custom hostname could not be created: ${err.message}` });
        }
      }
      const verification = generateVerificationRecords(cleanHostname);

      const domain = await ctx.db.domain.create({
        data: {
          serviceId: input.serviceId,
          hostname: cleanHostname,
          isGenerated: false,
          status: "PENDING",
          verificationTxt: verification.txtRecord,
          cfRecordId: cfRecord?.id ?? null,
          cfZoneId: cfRecord ? process.env.CLOUDFLARE_ZONE_ID || null : null,
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
              environment: { select: { name: true } },
            },
          },
        },
      });

      if (!domain) throw new TRPCError({ code: "NOT_FOUND", message: "Domain not found" });

      // Real DNS (TXT challenge + CNAME) and, when configured, Cloudflare custom-hostname status
      const result = await verifyDomainDetailed(domain.id);
      const updated = await ctx.db.domain.findUniqueOrThrow({ where: { id: domain.id } });

      if (result.status === "ACTIVE" && domain.service) {
        // Route the custom host exactly like the service's live platform route (same upstream,
        // port and isLocal), not a guessed 127.0.0.1 upstream.
        const upstream = await resolveDomainUpstream(domain.service);
        await registerServiceRouteAsync(domain.hostname, upstream.targetPort, upstream.status, upstream.upstreamUrl, upstream.isLocal);
        await requestTunnelReload(`domain:${domain.hostname}:active`);
      }

      return {
        ...updated,
        status: result.status,
        sslStatus: result.cloudflare.sslStatus ?? (result.cloudflare.configured ? "pending" : "not_managed"),
        sslIssuer: result.cloudflare.configured ? "Cloudflare Managed CA" : null,
        cloudflareConfigured: result.cloudflare.configured,
        dns: result.dns,
        errors: result.errors,
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

      const cfRecord = cloudflareApiClient.isLiveApiConfigured || process.env.NODE_ENV !== "production"
        ? await cloudflareApiClient.getCustomHostname(domain.cfRecordId || domain.hostname).catch(() => null)
        : null;
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
      await removeServiceRouteAsync(domain.hostname);

      await ctx.db.domain.delete({
        where: { id: input.domainId },
      });
      await requestTunnelReload(`domain:${domain.hostname}:deleted`);

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

      try {
        return await cloudflareApiClient.provisionTunnelToken(service.name);
      } catch (err: any) {
        throw new TRPCError({
          code: err instanceof CloudflareNotConfiguredError ? "PRECONDITION_FAILED" : "BAD_GATEWAY",
          message: err.message,
        });
      }
    }),
});
