/**
 * Syncbay PaaS — API Access Tokens tRPC Router (F1, F2, F3)
 * Manages developer API tokens with granular scopes (READ_ONLY, DEPLOY_ONLY, FULL_ACCESS).
 */

import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import { TRPCError } from "@trpc/server";
import { ApiTokenScope } from "@prisma/client";
import crypto from "crypto";

export const tokenRouter = createTRPCRouter({
  /** List active and revoked API tokens for a workspace */
  list: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ ctx, input }) => {
      // Verify membership
      const member = await ctx.db.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: input.workspaceId,
            userId: ctx.session.user.id,
          },
        },
      });

      if (!member) throw new TRPCError({ code: "FORBIDDEN" });

      const tokens = await ctx.db.apiToken.findMany({
        where: { workspaceId: input.workspaceId },
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: "desc" },
      });

      return tokens.map((t) => ({
        id: t.id,
        name: t.name,
        scope: t.scope,
        lastUsedAt: t.lastUsedAt,
        createdAt: t.createdAt,
        revokedAt: t.revokedAt,
        tokenPrefix: "sb_live_••••" + t.id.slice(-4),
        user: t.user,
      }));
    }),

  /** Create a new API token — returns the raw plaintext secret once */
  create: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        name: z.string().min(1).max(64),
        scope: z.nativeEnum(ApiTokenScope).default(ApiTokenScope.READ_ONLY),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Members and owners can create tokens (RbacOracle: CREATE_API_TOKEN -> OWNER, MEMBER)
      const member = await ctx.db.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: input.workspaceId,
            userId: ctx.session.user.id,
          },
        },
      });

      if (!member || member.role === "VIEWER") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Viewers cannot create API tokens",
        });
      }

      // Generate secure random token
      const rawToken = `sb_live_${crypto.randomBytes(24).toString("hex")}`;
      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

      const tokenRecord = await ctx.db.apiToken.create({
        data: {
          workspaceId: input.workspaceId,
          userId: ctx.session.user.id,
          name: input.name,
          scope: input.scope,
          tokenHash,
        },
      });

      await ctx.db.auditLogEntry.create({
        data: {
          workspaceId: input.workspaceId,
          actorUserId: ctx.session.user.id,
          action: "token.created",
          metadata: { name: input.name, scope: input.scope, tokenId: tokenRecord.id },
        },
      });

      return {
        id: tokenRecord.id,
        name: tokenRecord.name,
        scope: tokenRecord.scope,
        rawToken, // Provided once to the client
        createdAt: tokenRecord.createdAt,
      };
    }),

  /** Revoke an API token */
  revoke: protectedProcedure
    .input(z.object({ tokenId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const token = await ctx.db.apiToken.findUnique({
        where: { id: input.tokenId },
        include: { workspace: true },
      });

      if (!token) throw new TRPCError({ code: "NOT_FOUND" });

      const member = await ctx.db.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: token.workspaceId,
            userId: ctx.session.user.id,
          },
        },
      });

      if (!member || (member.role !== "OWNER" && token.userId !== ctx.session.user.id)) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const updated = await ctx.db.apiToken.update({
        where: { id: input.tokenId },
        data: { revokedAt: new Date() },
      });

      await ctx.db.auditLogEntry.create({
        data: {
          workspaceId: token.workspaceId,
          actorUserId: ctx.session.user.id,
          action: "token.revoked",
          metadata: { tokenId: token.id, name: token.name },
        },
      });

      return updated;
    }),
});
