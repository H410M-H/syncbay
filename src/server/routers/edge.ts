/**
 * Syncbay PaaS — Multi-Region Edge Networking tRPC Router (M5)
 * Inspects edge routing topology, measures POP latencies, and simulates edge failover.
 */

import { z } from "zod";
import { createTRPCRouter, publicProcedure, protectedProcedure, type TRPCContext } from "@/server/trpc";
import { TRPCError } from "@trpc/server";
import {
  getEdgeRegions,
  routeClientRequest,
  setRegionStatusOverride,
  getCustomDomainTlsStatus,
  calculateDistanceKm,
  getCoordinatesForCountry,
  purgeEdgeCache,
} from "@/lib/edge/edge-router";

/** Global edge controls affect every tenant: require OWNER/ADMIN of at least one workspace. */
async function assertEdgeOperator(db: TRPCContext["db"], userId: string): Promise<void> {
  const membership = await db.workspaceMember.findFirst({
    where: { userId, role: { in: ["OWNER", "ADMIN"] } },
    select: { id: true },
  });
  if (!membership) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Workspace OWNER or ADMIN role required for edge controls" });
  }
}

export const edgeRouter = createTRPCRouter({
  /** Get all 6 global edge regions and live statuses */
  getRegions: publicProcedure.query(async () => {
    return getEdgeRegions();
  }),

  /** Get active edge routing decision for client or target location */
  getRoutingDecision: publicProcedure
    .input(
      z
        .object({
          country: z.string().optional(),
          city: z.string().optional(),
          clientIp: z.string().optional(),
          latitude: z.number().optional(),
          longitude: z.number().optional(),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      // Extract from request headers if running on Vercel or Cloudflare edge
      const countryHeader = ctx.headers.get("x-vercel-ip-country") || ctx.headers.get("cf-ipcountry") || undefined;
      const cityHeader = ctx.headers.get("x-vercel-ip-city") || undefined;
      const latHeader = ctx.headers.get("x-vercel-ip-latitude");
      const lonHeader = ctx.headers.get("x-vercel-ip-longitude");

      const country = input?.country || countryHeader || "US";
      const city = input?.city || cityHeader || "Global Edge";
      const latitude = input?.latitude ?? (latHeader ? parseFloat(latHeader) : undefined);
      const longitude = input?.longitude ?? (lonHeader ? parseFloat(lonHeader) : undefined);

      return routeClientRequest({
        country,
        city,
        clientIp: input?.clientIp || "127.0.0.1",
        latitude,
        longitude,
      });
    }),

  /** Ping all global POPs and return measured and simulated roundtrips */
  pingPops: publicProcedure
    .input(
      z
        .object({
          country: z.string().optional(),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const countryHeader = ctx.headers.get("x-vercel-ip-country") || ctx.headers.get("cf-ipcountry") || undefined;
      const country = input?.country || countryHeader || "US";
      const coords = getCoordinatesForCountry(country);
      const regions = getEdgeRegions();

      return regions.map((region) => {
        const dist = calculateDistanceKm(coords.lat, coords.lon, region.latitude, region.longitude);
        const latency = Math.max(8, Math.round(region.averageLatencyMs + (dist / 1000) * 4.8));
        return {
          regionId: region.id,
          name: region.name,
          location: region.location,
          status: region.status,
          distanceKm: dist,
          latencyMs: latency,
          http3: region.http3Enabled,
          // Static model, not a live measurement (see edge-router.ts)
          illustrative: true,
        };
      });
    }),

  /** Toggle region status for resilience testing / chaos engineering */
  toggleRegionStatus: protectedProcedure
    .input(
      z.object({
        regionId: z.string(),
        status: z.enum(["HEALTHY", "DEGRADED", "OUTAGE", "RESET"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertEdgeOperator(ctx.db, ctx.session.user.id);
      setRegionStatusOverride(input.regionId, input.status);
      return {
        success: true,
        regionId: input.regionId,
        newStatus: input.status,
      };
    }),

  /** Get Custom Domain TLS 1.3 & HTTP/3 termination details */
  getDomainTls: publicProcedure
    .input(z.object({ domain: z.string() }))
    .query(async ({ input }) => {
      return getCustomDomainTlsStatus(input.domain);
    }),

  /** Invalidate the Cloudflare edge cache (real purge_cache call; "not configured" otherwise) — M5 F16 */
  purgeCache: protectedProcedure
    .input(
      z
        .object({
          domain: z.string().optional(),
          path: z.string().optional(),
          tag: z.string().optional(),
          all: z.boolean().default(true),
        })
        .optional()
    )
    .mutation(async ({ ctx, input }) => {
      await assertEdgeOperator(ctx.db, ctx.session.user.id);
      return purgeEdgeCache(input || { all: true });
    }),
});
