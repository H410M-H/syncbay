import { z } from "zod";
import { createTRPCRouter, protectedProcedure, publicProcedure } from "@/server/trpc";
import { TRPCError } from "@trpc/server";
import { WorkspaceRole } from "@prisma/client";

export const workspaceRouter = createTRPCRouter({
  /** List all workspaces the current user belongs to */
  list: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.workspace.findMany({
      where: {
        members: { some: { userId: ctx.session.user.id } },
      },
      include: {
        members: { include: { user: true } },
        _count: { select: { projects: true } },
      },
      orderBy: { createdAt: "asc" },
    });
  }),

  /** Get a single workspace by slug — scoped to the calling user */
  bySlug: protectedProcedure
    .input(z.object({ slug: z.string() }))
    .query(async ({ ctx, input }) => {
      const workspace = await ctx.db.workspace.findFirst({
        where: {
          slug: input.slug,
          members: { some: { userId: ctx.session.user.id } },
        },
        include: {
          members: { include: { user: true } },
          _count: { select: { projects: true } },
        },
      });
      if (!workspace) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      return workspace;
    }),

  /** Create a team workspace */
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(64),
        slug: z.string().min(2).max(48).regex(/^[a-z0-9-]+$/),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.workspace.findUnique({
        where: { slug: input.slug },
      });
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "A workspace with this slug already exists.",
        });
      }

      const workspace = await ctx.db.workspace.create({
        data: {
          name: input.name,
          slug: input.slug,
          members: {
            create: { userId: ctx.session.user.id, role: "OWNER" },
          },
        },
      });

      await ctx.db.auditLogEntry.create({
        data: {
          workspaceId: workspace.id,
          actorUserId: ctx.session.user.id,
          action: "workspace.created",
        },
      });

      return workspace;
    }),

  /** Invite a member by email */
  invite: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        email: z.string().email().optional(),
        role: z.enum(["ADMIN", "MEMBER", "VIEWER"]).default("MEMBER"),
        expiresInDays: z.number().min(1).max(30).default(7),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Owners and Admins can invite
      const membership = await ctx.db.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: input.workspaceId,
            userId: ctx.session.user.id,
          },
        },
      });
      if (!membership || (membership.role !== "OWNER" && membership.role !== "ADMIN")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only workspace owners and admins can invite members" });
      }

      const invite = await ctx.db.workspaceInvite.create({
        data: {
          workspaceId: input.workspaceId,
          email: input.email,
          role: input.role,
          expiresAt: new Date(
            Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000
          ),
        },
      });

      await ctx.db.auditLogEntry.create({
        data: {
          workspaceId: input.workspaceId,
          actorUserId: ctx.session.user.id,
          action: "member.invited",
          metadata: { email: input.email, role: input.role },
        },
      });

      return invite;
    }),

  /** Get audit log for a workspace — owners & admins */
  auditLog: protectedProcedure
    .input(z.object({ workspaceId: z.string(), limit: z.number().default(50) }))
    .query(async ({ ctx, input }) => {
      const membership = await ctx.db.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: input.workspaceId,
            userId: ctx.session.user.id,
          },
        },
      });
      if (!membership || (membership.role !== "OWNER" && membership.role !== "ADMIN")) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      return ctx.db.auditLogEntry.findMany({
        where: { workspaceId: input.workspaceId },
        include: { actor: true },
        orderBy: { createdAt: "desc" },
        take: input.limit,
      });
    }),

  /** Update workspace spending cap — owners and admins (FR-WRK-05) */
  updateSpendingCap: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        spendingCapCents: z.number().int().min(0).nullable(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const membership = await ctx.db.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: input.workspaceId,
            userId: ctx.session.user.id,
          },
        },
      });
      if (!membership || (membership.role !== "OWNER" && membership.role !== "ADMIN")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only workspace owners and admins can modify spending caps" });
      }

      const updated = await ctx.db.workspace.update({
        where: { id: input.workspaceId },
        data: { spendingCapCents: input.spendingCapCents },
      });

      await ctx.db.auditLogEntry.create({
        data: {
          workspaceId: input.workspaceId,
          actorUserId: ctx.session.user.id,
          action: "workspace.spending_cap_updated",
          metadata: { spendingCapCents: input.spendingCapCents },
        },
      });

      return updated;
    }),

  /** Update a member's role — owners only */
  updateMemberRole: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        userId: z.string(),
        role: z.nativeEnum(WorkspaceRole),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const callerMembership = await ctx.db.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: input.workspaceId,
            userId: ctx.session.user.id,
          },
        },
      });
      if (!callerMembership || (callerMembership.role !== "OWNER" && callerMembership.role !== "ADMIN")) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const targetMember = await ctx.db.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: input.workspaceId,
            userId: input.userId,
          },
        },
      });
      if (!targetMember) throw new TRPCError({ code: "NOT_FOUND" });

      if (callerMembership.role === "ADMIN" && (targetMember.role === "OWNER" || input.role === "OWNER")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only workspace owners can promote to or demote owner" });
      }

      // Prevent accidental lockout: cannot demote the only owner
      if (input.userId === ctx.session.user.id && input.role !== "OWNER") {
        const otherOwners = await ctx.db.workspaceMember.count({
          where: {
            workspaceId: input.workspaceId,
            role: "OWNER",
            userId: { not: ctx.session.user.id },
          },
        });
        if (otherOwners === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Cannot demote the only owner of the workspace. Promote another owner first.",
          });
        }
      }

      const updated = await ctx.db.workspaceMember.update({
        where: {
          workspaceId_userId: {
            workspaceId: input.workspaceId,
            userId: input.userId,
          },
        },
        data: { role: input.role },
      });

      await ctx.db.auditLogEntry.create({
        data: {
          workspaceId: input.workspaceId,
          actorUserId: ctx.session.user.id,
          action: "member.role_updated",
          metadata: { targetUserId: input.userId, newRole: input.role },
        },
      });

      return updated;
    }),

  /** Remove a member from workspace — owners and admins */
  removeMember: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        userId: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const callerMembership = await ctx.db.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: input.workspaceId,
            userId: ctx.session.user.id,
          },
        },
      });
      if (!callerMembership || (callerMembership.role !== "OWNER" && callerMembership.role !== "ADMIN")) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      if (input.userId === ctx.session.user.id) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot remove yourself from workspace" });
      }

      const targetMember = await ctx.db.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: input.workspaceId,
            userId: input.userId,
          },
        },
      });
      if (!targetMember) throw new TRPCError({ code: "NOT_FOUND" });

      if (callerMembership.role === "ADMIN" && targetMember.role === "OWNER") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Admins cannot remove workspace owners" });
      }

      const deleted = await ctx.db.workspaceMember.delete({
        where: {
          workspaceId_userId: {
            workspaceId: input.workspaceId,
            userId: input.userId,
          },
        },
      });

      await ctx.db.auditLogEntry.create({
        data: {
          workspaceId: input.workspaceId,
          actorUserId: ctx.session.user.id,
          action: "member.removed",
          metadata: { removedUserId: input.userId },
        },
      });

      return deleted;
    }),

  /** List pending invites for a workspace */
  listInvites: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ ctx, input }) => {
      const member = await ctx.db.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: input.workspaceId,
            userId: ctx.session.user.id,
          },
        },
      });
      if (!member) throw new TRPCError({ code: "FORBIDDEN" });

      return ctx.db.workspaceInvite.findMany({
        where: {
          workspaceId: input.workspaceId,
          acceptedAt: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: "desc" },
      });
    }),

  /** Revoke an invite */
  revokeInvite: protectedProcedure
    .input(z.object({ inviteId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const invite = await ctx.db.workspaceInvite.findUnique({
        where: { id: input.inviteId },
      });
      if (!invite) throw new TRPCError({ code: "NOT_FOUND" });

      const member = await ctx.db.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: invite.workspaceId,
            userId: ctx.session.user.id,
          },
        },
      });
      if (!member || (member.role !== "OWNER" && member.role !== "ADMIN")) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const deleted = await ctx.db.workspaceInvite.delete({
        where: { id: input.inviteId },
      });

      await ctx.db.auditLogEntry.create({
        data: {
          workspaceId: invite.workspaceId,
          actorUserId: ctx.session.user.id,
          action: "invite.revoked",
          metadata: { inviteId: input.inviteId },
        },
      });

      return deleted;
    }),

  /** Get invite details by token (public procedure allowing invite preview before sign in) */
  getInvite: publicProcedure
    .input(z.object({ token: z.string() }))
    .query(async ({ ctx, input }) => {
      const invite = await ctx.db.workspaceInvite.findUnique({
        where: { token: input.token },
        include: { workspace: true },
      });
      if (!invite) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invitation not found" });
      }
      return {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        workspaceName: invite.workspace.name,
        workspaceSlug: invite.workspace.slug,
        isExpired: invite.expiresAt < new Date(),
        isAccepted: !!invite.acceptedAt,
      };
    }),

  /** Accept an invite by token */
  acceptInvite: protectedProcedure
    .input(z.object({ token: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const invite = await ctx.db.workspaceInvite.findUnique({
        where: { token: input.token },
        include: { workspace: true },
      });
      if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invitation is invalid, expired, or already accepted" });
      }

      // Security check: if invite was addressed to specific email, verify caller email match
      if (
        invite.email &&
        ctx.session.user.email &&
        invite.email.toLowerCase() !== ctx.session.user.email.toLowerCase()
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `This invitation was designated for ${invite.email}. You are currently signed in as ${ctx.session.user.email}.`,
        });
      }

      // Add user to workspace if not already member
      const existing = await ctx.db.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: invite.workspaceId,
            userId: ctx.session.user.id,
          },
        },
      });

      if (!existing) {
        await ctx.db.workspaceMember.create({
          data: {
            workspaceId: invite.workspaceId,
            userId: ctx.session.user.id,
            role: invite.role,
          },
        });
      }

      await ctx.db.workspaceInvite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() },
      });

      await ctx.db.auditLogEntry.create({
        data: {
          workspaceId: invite.workspaceId,
          actorUserId: ctx.session.user.id,
          action: "member.accepted_invite",
          metadata: { role: invite.role },
        },
      });

      return { workspaceSlug: invite.workspace.slug };
    }),
});
