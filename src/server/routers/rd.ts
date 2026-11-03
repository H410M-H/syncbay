import { z } from "zod";
import { createTRPCRouter, publicProcedure, protectedProcedure } from "@/server/trpc";
import { TRPCError } from "@trpc/server";
import {
  getWeeklyVersionDrops,
  getTrendingStacks,
  getStrategicInsights,
  getFeatureVotes,
  voteForFeature,
} from "@/lib/rd/trending-engine";

export const rdRouter = createTRPCRouter({
  /**
   * Get weekly version updates and changelogs (v1.0 to v1.5)
   */
  getWeeklyDrops: publicProcedure.query(async () => {
    return getWeeklyVersionDrops();
  }),

  /**
   * Get trending developer stacks & templates (Next.js 16, Python FastAPI, Rust Axum, Go Gin, etc.)
   */
  getTrendingStacks: publicProcedure
    .input(z.object({ category: z.string().optional() }).optional())
    .query(async ({ input }) => {
      return getTrendingStacks(input?.category);
    }),

  /**
   * Get R&D strategic insights and market differentiators
   */
  getStrategicInsights: publicProcedure.query(async () => {
    return getStrategicInsights();
  }),

  /**
   * Community & Enterprise feature vote leaderboard
   */
  getFeatureVotes: publicProcedure.query(async () => {
    return getFeatureVotes();
  }),

  /**
   * Vote for an upcoming feature in the weekly R&D pipeline (signed-in users, one vote per feature)
   */
  voteFeature: protectedProcedure
    .input(z.object({ feature: z.string().min(1).max(128) }))
    .mutation(async ({ ctx, input }) => {
      const known = getFeatureVotes().some((v) => v.feature === input.feature);
      if (!known) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Unknown roadmap feature" });
      }
      return voteForFeature(input.feature, ctx.session.user.id);
    }),
});
