/**
 * Staff console API (`/admin`). Every procedure goes through `staffProcedure(permission)`:
 * non-staff get NOT_FOUND, missing permissions are audited as DENIED, and every mutation writes
 * a staff audit row. Queries select explicit fields only: no password hashes, TOTP secrets,
 * environment variable values, database connection URLs or OAuth tokens ever leave here.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import { staffProcedure } from "@/server/staff-procedure";
import { PUBLIC_USER_SELECT } from "@/lib/users/public-user";
import { getStaffIdentity } from "@/lib/admin/staff";
import { ABUSE_CATEGORIES, PRIVILEGED_ROLES, ROLE_RANK, STAFF_ROLES, permissionsOf, type StaffRoleName } from "@/lib/admin/permissions";
import { restoreService, setUserSuspended, suspendWorkspace, takedownService, unsuspendWorkspace } from "@/lib/admin/enforcement";
import { billingPeriodStart, workspaceUsageTotals } from "@/lib/usage/metering";
import { priceUsage } from "@/lib/billing/pricing";
import { checkRunnerHealth, getRunnerConfigStatus } from "@/lib/orchestrator/runner-config";

const reasonField = z.string().max(1000).optional();
const confirmField = z.string().max(200).optional();
const LIFECYCLE_STAGES = ["TRIAL", "ACTIVE", "AT_RISK", "CHURNED", "ENTERPRISE"] as const;
const REPORT_STATUSES = ["OPEN", "IN_REVIEW", "ACTIONED", "DISMISSED"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Average of the last three fully billed months (usage invoices count against the month they cover). */
async function billedMrrCents(db: any): Promise<{ mrrCents: number; months: Array<{ month: string; cents: number }> }> {
  const since = new Date(billingPeriodStart().getTime() - 95 * DAY_MS);
  const rows = await db.invoice.groupBy({
    by: ["periodStart"],
    where: { status: { not: "VOID" }, periodStart: { gte: since, lt: billingPeriodStart() } },
    _sum: { amountCents: true },
    orderBy: { periodStart: "desc" },
  });
  const months = rows.slice(0, 3).map((r: any) => ({ month: r.periodStart.toISOString().slice(0, 7), cents: r._sum.amountCents ?? 0 }));
  const mrrCents = months.length ? Math.round(months.reduce((a: number, m: { cents: number }) => a + m.cents, 0) / months.length) : 0;
  return { mrrCents, months };
}

/** Month-to-date usage of every workspace, priced with the same rate card as invoices. */
async function monthToDateCents(db: any): Promise<number> {
  const grouped = await db.usageRecord.groupBy({
    by: ["resourceType"],
    where: { periodStart: { gte: billingPeriodStart() } },
    _sum: { quantity: true },
  });
  const totals: Record<string, number> = {};
  for (const g of grouped) totals[g.resourceType] = g._sum.quantity ?? 0;
  return priceUsage(totals).totalCents;
}

/** Search box: email, workspace slug/name, hostname, Stripe customer id or a raw id. */
function workspaceSearchWhere(q: string | undefined) {
  const term = (q || "").trim();
  if (!term) return {};
  const host = term.replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
  return {
    OR: [
      { id: term },
      { slug: { contains: term.toLowerCase() } },
      { name: { contains: term, mode: "insensitive" as const } },
      { stripeCustomerId: term },
      { members: { some: { user: { email: { contains: term.toLowerCase(), mode: "insensitive" as const } } } } },
      { projects: { some: { environments: { some: { services: { some: { domains: { some: { hostname: host } } } } } } } } },
    ],
  };
}

export const adminRouter = createTRPCRouter({
  /** The caller's staff role and permissions; null for everyone else (used to show the console link). */
  me: protectedProcedure.query(async ({ ctx }) => {
    const identity = await getStaffIdentity((ctx.session.user as { id?: string }).id, ctx.db);
    if (!identity) return null;
    return { role: identity.role, pinned: identity.pinned, permissions: permissionsOf(identity.role) };
  }),

  // ─── Overview ──────────────────────────────────────────────────────────────
  overview: staffProcedure("ops.read").query(async ({ ctx }) => {
    const now = Date.now();
    const since24h = new Date(now - DAY_MS);
    const since7d = new Date(now - 7 * DAY_MS);
    const [workspaces, suspended, users, newUsers7d, liveServices, deploys24h, failed24h, openReports, staff] = await Promise.all([
      ctx.db.workspace.count(),
      ctx.db.workspace.count({ where: { suspendedAt: { not: null } } }),
      ctx.db.user.count(),
      ctx.db.user.count({ where: { createdAt: { gte: since7d } } }),
      ctx.db.service.count({ where: { deletedAt: null, isPaused: false, deployments: { some: { status: "ACTIVE" } } } }),
      ctx.db.deployment.count({ where: { createdAt: { gte: since24h } } }),
      ctx.db.deployment.count({ where: { createdAt: { gte: since24h }, status: { in: ["FAILED", "CRASHED"] } } }),
      ctx.db.abuseReport.count({ where: { status: { in: ["OPEN", "IN_REVIEW"] } } }),
      ctx.db.staffMember.count({ where: { revokedAt: null } }),
    ]);
    const recentFailures = await ctx.db.deployment.findMany({
      where: { createdAt: { gte: since24h }, status: { in: ["FAILED", "CRASHED"] } },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        id: true,
        createdAt: true,
        errorMessage: true,
        service: { select: { id: true, name: true, environment: { select: { project: { select: { workspaceId: true, workspace: { select: { slug: true } } } } } } } },
      },
    });
    const revenue = ctx.staff.role && permissionsOf(ctx.staff.role).includes("ops.revenue.read")
      ? { ...(await billedMrrCents(ctx.db)), monthToDateCents: await monthToDateCents(ctx.db) }
      : null;
    const runnerConfig = getRunnerConfigStatus();
    const runnerHealth = runnerConfig.problem ? null : await checkRunnerHealth().catch(() => null);
    return {
      workspaces,
      suspended,
      users,
      newUsers7d,
      liveServices,
      deploys24h,
      failed24h,
      failureRate24h: deploys24h ? failed24h / deploys24h : 0,
      openReports,
      staff,
      revenue,
      runner: { mode: runnerConfig.mode, host: runnerConfig.urlHost, problem: runnerConfig.problem ?? null, health: runnerHealth },
      recentFailures: recentFailures.map((d: any) => ({
        id: d.id,
        createdAt: d.createdAt,
        error: (d.errorMessage || "").slice(0, 300),
        serviceId: d.service?.id,
        serviceName: d.service?.name,
        workspaceId: d.service?.environment?.project?.workspaceId,
        workspaceSlug: d.service?.environment?.project?.workspace?.slug,
      })),
    };
  }),

  /** Recent activity across the platform: customer audit events, deployments, sign-ups and staff actions. */
  activity: staffProcedure("ops.read")
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(async ({ ctx, input }) => {
      const take = input?.limit ?? 50;
      const [audit, deployments, signups, staffEvents] = await Promise.all([
        ctx.db.auditLogEntry.findMany({
          orderBy: { createdAt: "desc" },
          take,
          select: { id: true, action: true, createdAt: true, workspaceId: true, workspace: { select: { slug: true } }, actor: { select: { email: true } } },
        }),
        ctx.db.deployment.findMany({
          orderBy: { createdAt: "desc" },
          take,
          select: { id: true, status: true, createdAt: true, service: { select: { name: true, environment: { select: { project: { select: { workspaceId: true, workspace: { select: { slug: true } } } } } } } } },
        }),
        ctx.db.user.findMany({ orderBy: { createdAt: "desc" }, take: Math.min(take, 30), select: { id: true, email: true, createdAt: true } }),
        ctx.staff.role === "SUPER_ADMIN" || ctx.staff.role === "ADMIN"
          ? ctx.db.staffAuditEvent.findMany({ where: { outcome: { not: "DENIED" } }, orderBy: { createdAt: "desc" }, take, select: { id: true, action: true, createdAt: true, actorUserId: true, targetType: true, targetId: true, workspaceId: true } })
          : Promise.resolve([]),
      ]);
      const items = [
        ...audit.map((a: any) => ({ kind: "workspace", id: a.id, at: a.createdAt, text: `${a.action}${a.actor?.email ? ` by ${a.actor.email}` : ""}`, workspaceId: a.workspaceId, workspaceSlug: a.workspace?.slug })),
        ...deployments.map((d: any) => ({ kind: "deploy", id: d.id, at: d.createdAt, text: `${d.service?.name ?? "service"} deployment ${d.status}`, workspaceId: d.service?.environment?.project?.workspaceId, workspaceSlug: d.service?.environment?.project?.workspace?.slug })),
        ...signups.map((u: any) => ({ kind: "signup", id: u.id, at: u.createdAt, text: `New user ${u.email}`, workspaceId: null, workspaceSlug: null })),
        ...staffEvents.map((e: any) => ({ kind: "staff", id: e.id, at: e.createdAt, text: `Staff: ${e.action}${e.targetType ? ` (${e.targetType})` : ""}`, workspaceId: e.workspaceId, workspaceSlug: null })),
      ];
      return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, take);
    }),

  // ─── Workspaces (customer 360) ─────────────────────────────────────────────
  workspaces: staffProcedure("workspace.read")
    .input(z.object({ q: z.string().max(200).optional(), filter: z.enum(["all", "suspended", "paying"]).default("all"), cursor: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const where: any = { ...workspaceSearchWhere(input?.q) };
      if (input?.filter === "suspended") where.suspendedAt = { not: null };
      if (input?.filter === "paying") where.invoices = { some: { status: { in: ["PAID", "OPEN", "PAST_DUE"] }, amountCents: { gt: 0 } } };
      const rows = await ctx.db.workspace.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 51,
        ...(input?.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          name: true,
          slug: true,
          isPersonal: true,
          createdAt: true,
          suspendedAt: true,
          lifecycleStage: true,
          staffTags: true,
          spendingCapCents: true,
          creditBalanceCents: true,
          _count: { select: { members: true, projects: true } },
          members: { where: { role: "OWNER" }, take: 1, select: { user: { select: { email: true } } } },
        },
      });
      const canSeeBilling = permissionsOf(ctx.staff.role).includes("billing.read");
      return {
        items: rows.slice(0, 50).map((w: any) => ({
          ...w,
          spendingCapCents: canSeeBilling ? w.spendingCapCents : null,
          creditBalanceCents: canSeeBilling ? w.creditBalanceCents : null,
          ownerEmail: w.members[0]?.user?.email ?? null,
          members: undefined,
        })),
        nextCursor: rows.length > 50 ? rows[49].id : null,
      };
    }),

  workspace: staffProcedure("workspace.read")
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const w = await ctx.db.workspace.findUnique({
        where: { id: input.id },
        select: {
          id: true,
          name: true,
          slug: true,
          isPersonal: true,
          createdAt: true,
          suspendedAt: true,
          suspendedReason: true,
          lifecycleStage: true,
          staffTags: true,
          spendingCapCents: true,
          creditBalanceCents: true,
          spendCapReachedAt: true,
          stripeCustomerId: true,
          members: { select: { role: true, joinedAt: true, user: { select: { ...PUBLIC_USER_SELECT, createdAt: true, suspendedAt: true } } } },
          projects: {
            where: { deletedAt: null },
            select: {
              id: true,
              name: true,
              environments: {
                select: {
                  name: true,
                  services: {
                    where: { deletedAt: null },
                    select: {
                      id: true,
                      name: true,
                      repoUrl: true,
                      isPaused: true,
                      scaleToZero: true,
                      moderationLockedAt: true,
                      moderationReason: true,
                      domains: { select: { hostname: true, status: true } },
                      deployments: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true, createdAt: true, errorMessage: true } },
                      // Variable names only: values are customer secrets.
                      variables: { select: { key: true } },
                    },
                  },
                  databases: { select: { id: true, name: true, provider: true, status: true } },
                },
              },
            },
          },
          invoices: { orderBy: { periodStart: "desc" }, take: 6, select: { id: true, periodStart: true, amountCents: true, status: true, pdfUrl: true } },
          paymentMethods: { select: { brand: true, last4: true, expMonth: true, expYear: true, isDefault: true } },
        },
      });
      if (!w) throw new TRPCError({ code: "NOT_FOUND" });
      const [usage, notes, audit, reports] = await Promise.all([
        workspaceUsageTotals(w.id).catch(() => null),
        ctx.db.customerNote.findMany({
          where: { workspaceId: w.id, deletedAt: null },
          orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
          take: 50,
          select: { id: true, body: true, pinned: true, createdAt: true, authorId: true },
        }),
        ctx.db.auditLogEntry.findMany({
          where: { workspaceId: w.id },
          orderBy: { createdAt: "desc" },
          take: 30,
          select: { id: true, action: true, createdAt: true, actor: { select: { email: true } } },
        }),
        ctx.db.abuseReport.findMany({ where: { workspaceId: w.id }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, category: true, status: true, createdAt: true, targetHost: true } }),
      ]);
      const authors = await ctx.db.user.findMany({ where: { id: { in: [...new Set(notes.map((n: any) => n.authorId))] } }, select: { id: true, email: true, name: true } });
      const byId = new Map(authors.map((a: any) => [a.id, a]));
      const canSeeBilling = permissionsOf(ctx.staff.role).includes("billing.read");
      const { invoices, paymentMethods, stripeCustomerId, spendingCapCents, creditBalanceCents, spendCapReachedAt, ...profile } = w;
      return {
        ...profile,
        // Roles without billing.read (moderators) see no billing data at all.
        billing: canSeeBilling ? { invoices, paymentMethods, stripeCustomerId, spendingCapCents, creditBalanceCents, spendCapReachedAt } : null,
        usage: canSeeBilling && usage ? { periodStart: usage.periodStart, totals: usage.totals, estimatedCostCents: usage.estimatedCostCents } : null,
        notes: notes.map((n: any) => ({ ...n, author: byId.get(n.authorId) ?? null })),
        audit,
        reports,
      };
    }),

  suspendWorkspace: staffProcedure("workspace.suspend")
    .input(z.object({ workspaceId: z.string(), reason: reasonField, confirm: confirmField }))
    .mutation(async ({ ctx, input }) => {
      const w = await ctx.db.workspace.findUnique({ where: { id: input.workspaceId }, select: { slug: true, suspendedAt: true } });
      if (!w) throw new TRPCError({ code: "NOT_FOUND" });
      ctx.staff.assertConfirmed(w.slug);
      if (w.suspendedAt) throw new TRPCError({ code: "CONFLICT", message: "Workspace is already suspended" });
      await ctx.staff.audit({ action: "workspace.suspend", outcome: "ALLOWED", targetType: "workspace", targetId: input.workspaceId, workspaceId: input.workspaceId });
      const result = await suspendWorkspace(input.workspaceId, ctx.staff.userId, ctx.staff.reason!, ctx.db);
      if (result.failed.length) {
        await ctx.staff.audit({ action: "workspace.suspend", outcome: "FAILED", targetType: "workspace", targetId: input.workspaceId, workspaceId: input.workspaceId, metadata: { failed: result.failed } });
      }
      return result;
    }),

  unsuspendWorkspace: staffProcedure("workspace.unsuspend")
    .input(z.object({ workspaceId: z.string(), reason: reasonField }))
    .mutation(async ({ ctx, input }) => {
      await ctx.staff.audit({ action: "workspace.unsuspend", outcome: "ALLOWED", targetType: "workspace", targetId: input.workspaceId, workspaceId: input.workspaceId });
      await unsuspendWorkspace(input.workspaceId, ctx.staff.reason!, ctx.db);
      return { ok: true };
    }),

  setWorkspaceCrm: staffProcedure("workspace.tags.write")
    .input(z.object({ workspaceId: z.string(), lifecycleStage: z.enum(LIFECYCLE_STAGES).nullable().optional(), tags: z.array(z.string().trim().min(1).max(32)).max(20).optional() }))
    .mutation(async ({ ctx, input }) => {
      const data: Record<string, unknown> = {};
      if (input.lifecycleStage !== undefined) data.lifecycleStage = input.lifecycleStage;
      if (input.tags) data.staffTags = [...new Set(input.tags.map((t) => t.toLowerCase()))];
      await ctx.db.workspace.update({ where: { id: input.workspaceId }, data });
      await ctx.staff.audit({ action: "workspace.crm.update", outcome: "ALLOWED", targetType: "workspace", targetId: input.workspaceId, workspaceId: input.workspaceId, metadata: data });
      return { ok: true };
    }),

  addNote: staffProcedure("workspace.note.write")
    .input(z.object({ workspaceId: z.string(), body: z.string().trim().min(1).max(5000), pinned: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      const note = await ctx.db.customerNote.create({ data: { workspaceId: input.workspaceId, authorId: ctx.staff.userId, body: input.body, pinned: input.pinned } });
      await ctx.staff.audit({ action: "workspace.note.add", outcome: "ALLOWED", targetType: "workspace", targetId: input.workspaceId, workspaceId: input.workspaceId, metadata: { noteId: note.id } });
      return { id: note.id };
    }),

  updateNote: staffProcedure("workspace.note.write")
    .input(z.object({ noteId: z.string(), pinned: z.boolean().optional(), delete: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const note = await ctx.db.customerNote.findUnique({ where: { id: input.noteId }, select: { workspaceId: true, authorId: true } });
      if (!note) throw new TRPCError({ code: "NOT_FOUND" });
      if (input.delete && note.authorId !== ctx.staff.userId && ctx.staff.role !== "SUPER_ADMIN" && ctx.staff.role !== "ADMIN") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only the author or an admin can delete a note" });
      }
      await ctx.db.customerNote.update({
        where: { id: input.noteId },
        data: { ...(input.pinned !== undefined ? { pinned: input.pinned } : {}), ...(input.delete ? { deletedAt: new Date() } : {}) },
      });
      await ctx.staff.audit({ action: input.delete ? "workspace.note.delete" : "workspace.note.pin", outcome: "ALLOWED", targetType: "note", targetId: input.noteId, workspaceId: note.workspaceId });
      return { ok: true };
    }),

  // ─── Services (moderation) ─────────────────────────────────────────────────
  takedownService: staffProcedure("service.takedown")
    .input(z.object({ serviceId: z.string(), reason: reasonField, confirm: confirmField }))
    .mutation(async ({ ctx, input }) => {
      const s = await ctx.db.service.findUnique({ where: { id: input.serviceId }, select: { name: true, environment: { select: { project: { select: { workspaceId: true } } } } } });
      if (!s) throw new TRPCError({ code: "NOT_FOUND" });
      ctx.staff.assertConfirmed(s.name);
      const workspaceId = s.environment?.project?.workspaceId ?? null;
      await ctx.staff.audit({ action: "service.takedown", outcome: "ALLOWED", targetType: "service", targetId: input.serviceId, workspaceId });
      return takedownService(input.serviceId, ctx.staff.reason!, ctx.db);
    }),

  restoreService: staffProcedure("service.restore")
    .input(z.object({ serviceId: z.string(), reason: reasonField }))
    .mutation(async ({ ctx, input }) => {
      const workspaceId = await restoreService(input.serviceId, ctx.staff.reason!, ctx.db);
      await ctx.staff.audit({ action: "service.restore", outcome: "ALLOWED", targetType: "service", targetId: input.serviceId, workspaceId });
      return { ok: true };
    }),

  // ─── Users ─────────────────────────────────────────────────────────────────
  users: staffProcedure("user.read")
    .input(z.object({ q: z.string().max(200).optional(), cursor: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const q = (input?.q || "").trim();
      const rows = await ctx.db.user.findMany({
        where: q ? { OR: [{ id: q }, { email: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }] } : {},
        orderBy: { createdAt: "desc" },
        take: 51,
        ...(input?.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: {
          ...PUBLIC_USER_SELECT,
          createdAt: true,
          suspendedAt: true,
          accounts: { select: { provider: true } },
          memberships: { select: { role: true, workspace: { select: { id: true, slug: true } } } },
          staffMember: { select: { role: true, revokedAt: true } },
        },
      });
      return {
        items: rows.slice(0, 50).map((u: any) => ({
          ...u,
          providers: [...new Set(u.accounts.map((a: any) => a.provider))],
          accounts: undefined,
          staffRole: u.staffMember && !u.staffMember.revokedAt ? u.staffMember.role : null,
          staffMember: undefined,
        })),
        nextCursor: rows.length > 50 ? rows[49].id : null,
      };
    }),

  setUserSuspended: staffProcedure("user.suspend")
    .input(z.object({ userId: z.string(), suspended: z.boolean(), reason: reasonField, confirm: confirmField }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.staff.userId) throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot suspend yourself" });
      const target = await ctx.db.user.findUnique({ where: { id: input.userId }, select: { email: true, staffMember: { select: { role: true, revokedAt: true } } } });
      if (!target) throw new TRPCError({ code: "NOT_FOUND" });
      if (input.suspended) {
        ctx.staff.assertConfirmed(target.email);
        const targetRole = target.staffMember && !target.staffMember.revokedAt ? (target.staffMember.role as StaffRoleName) : null;
        if (targetRole && ROLE_RANK[targetRole] >= ROLE_RANK[ctx.staff.role]) {
          throw new TRPCError({ code: "FORBIDDEN", message: "You cannot suspend staff at or above your own role" });
        }
      } else if (ctx.staff.gate === "confirm" && (ctx.staff.reason?.length ?? 0) < 8) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "A reason is required" });
      }
      await ctx.staff.audit({ action: input.suspended ? "user.suspend" : "user.unsuspend", outcome: "ALLOWED", targetType: "user", targetId: input.userId });
      await setUserSuspended(input.userId, input.suspended, ctx.staff.reason!, ctx.db);
      return { ok: true };
    }),

  // ─── Moderation ────────────────────────────────────────────────────────────
  reports: staffProcedure("moderation.report.read")
    .input(z.object({ status: z.enum(REPORT_STATUSES).optional(), mine: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.abuseReport.findMany({
        where: {
          ...(input?.status ? { status: input.status } : { status: { in: ["OPEN", "IN_REVIEW"] } }),
          ...(input?.mine ? { assigneeId: ctx.staff.userId } : {}),
        },
        orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
        take: 200,
        // reporterIp stays server-side.
        select: { id: true, category: true, priority: true, url: true, targetHost: true, serviceId: true, workspaceId: true, description: true, reporterEmail: true, status: true, assigneeId: true, resolution: true, resolvedAt: true, createdAt: true },
      });
      const serviceIds = rows.map((r: any) => r.serviceId).filter(Boolean);
      const services = serviceIds.length
        ? await ctx.db.service.findMany({ where: { id: { in: serviceIds } }, select: { id: true, name: true, moderationLockedAt: true } })
        : [];
      const byId = new Map(services.map((s: any) => [s.id, s]));
      return rows.map((r: any) => ({ ...r, service: r.serviceId ? byId.get(r.serviceId) ?? null : null }));
    }),

  assignReport: staffProcedure("moderation.report.assign")
    .input(z.object({ reportId: z.string(), assigneeId: z.string().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const assigneeId = input.assigneeId === "me" ? ctx.staff.userId : input.assigneeId;
      const report = await ctx.db.abuseReport.update({
        where: { id: input.reportId },
        data: { assigneeId, status: assigneeId ? "IN_REVIEW" : "OPEN" },
        select: { workspaceId: true },
      });
      await ctx.staff.audit({ action: "report.assign", outcome: "ALLOWED", targetType: "abuse_report", targetId: input.reportId, workspaceId: report.workspaceId, metadata: { assigneeId } });
      return { ok: true };
    }),

  resolveReport: staffProcedure("moderation.report.resolve")
    .input(z.object({ reportId: z.string(), action: z.enum(["DISMISS", "TAKEDOWN_SERVICE", "SUSPEND_WORKSPACE", "NOTE_ONLY"]), reason: reasonField, confirm: confirmField }))
    .mutation(async ({ ctx, input }) => {
      const report = await ctx.db.abuseReport.findUnique({ where: { id: input.reportId }, select: { serviceId: true, workspaceId: true, status: true } });
      if (!report) throw new TRPCError({ code: "NOT_FOUND" });
      const reason = ctx.staff.reason!;
      if (input.action === "TAKEDOWN_SERVICE") {
        if (!report.serviceId) throw new TRPCError({ code: "BAD_REQUEST", message: "This report is not linked to a service" });
        if (!permissionsOf(ctx.staff.role).includes("service.takedown")) throw new TRPCError({ code: "FORBIDDEN" });
        const target = await ctx.db.service.findUnique({ where: { id: report.serviceId }, select: { name: true } });
        ctx.staff.assertConfirmed(target?.name ?? "", true);
        await takedownService(report.serviceId, reason, ctx.db);
      } else if (input.action === "SUSPEND_WORKSPACE") {
        if (!report.workspaceId) throw new TRPCError({ code: "BAD_REQUEST", message: "This report is not linked to a workspace" });
        if (!permissionsOf(ctx.staff.role).includes("workspace.suspend")) throw new TRPCError({ code: "FORBIDDEN" });
        const target = await ctx.db.workspace.findUnique({ where: { id: report.workspaceId }, select: { slug: true } });
        ctx.staff.assertConfirmed(target?.slug ?? "", true);
        await suspendWorkspace(report.workspaceId, ctx.staff.userId, reason, ctx.db);
      }
      const status = input.action === "DISMISS" ? "DISMISSED" : "ACTIONED";
      await ctx.db.abuseReport.update({ where: { id: input.reportId }, data: { status, resolution: `${input.action}: ${reason}`, resolvedAt: new Date(), assigneeId: ctx.staff.userId } });
      await ctx.staff.audit({ action: `report.resolve.${input.action.toLowerCase()}`, outcome: "ALLOWED", targetType: "abuse_report", targetId: input.reportId, workspaceId: report.workspaceId, metadata: { serviceId: report.serviceId } });
      return { status };
    }),

  // ─── Staff ─────────────────────────────────────────────────────────────────
  staff: staffProcedure("staff.read").query(async ({ ctx }) => {
    const rows = await ctx.db.staffMember.findMany({
      orderBy: [{ revokedAt: "asc" }, { createdAt: "asc" }],
      select: { id: true, role: true, note: true, createdAt: true, revokedAt: true, grantedById: true, user: { select: PUBLIC_USER_SELECT } },
    });
    const pinned = new Set(String(process.env.SUPER_ADMIN_EMAILS || "").toLowerCase().split(/[,\s]+/).filter(Boolean));
    return rows.map((r: any) => ({ ...r, pinned: pinned.has(String(r.user?.email).toLowerCase()) }));
  }),

  grantStaff: staffProcedure("staff.grant")
    .input(z.object({ email: z.string().email(), role: z.enum(STAFF_ROLES), reason: reasonField, confirm: confirmField }))
    .mutation(async ({ ctx, input }) => {
      if (PRIVILEGED_ROLES.includes(input.role) && ctx.staff.role !== "SUPER_ADMIN") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only a super admin can grant ADMIN or SUPER_ADMIN" });
      }
      if (ROLE_RANK[input.role] > ROLE_RANK[ctx.staff.role]) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot grant a role above your own" });
      // Granting ADMIN or SUPER_ADMIN always needs the typed email, whatever the base gate.
      if (PRIVILEGED_ROLES.includes(input.role)) ctx.staff.assertConfirmed(input.email, true);
      const user = await ctx.db.user.findUnique({ where: { email: input.email.toLowerCase() }, select: { id: true, suspendedAt: true } });
      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "No Syncbay account with that email. Ask them to sign in once first." });
      if (user.suspendedAt) throw new TRPCError({ code: "BAD_REQUEST", message: "That account is suspended" });
      if (user.id === ctx.staff.userId) throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot change your own role" });
      await ctx.db.staffMember.upsert({
        where: { userId: user.id },
        create: { userId: user.id, role: input.role, grantedById: ctx.staff.userId, note: ctx.staff.reason },
        update: { role: input.role, grantedById: ctx.staff.userId, note: ctx.staff.reason, revokedAt: null },
      });
      await ctx.staff.audit({ action: "staff.grant", outcome: "ALLOWED", targetType: "user", targetId: user.id, metadata: { role: input.role } });
      return { ok: true };
    }),

  revokeStaff: staffProcedure("staff.revoke")
    .input(z.object({ userId: z.string(), reason: reasonField, confirm: confirmField }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.staff.userId) throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot revoke your own access" });
      const member = await ctx.db.staffMember.findUnique({ where: { userId: input.userId }, select: { role: true, revokedAt: true, user: { select: { email: true } } } });
      if (!member || member.revokedAt) throw new TRPCError({ code: "NOT_FOUND" });
      ctx.staff.assertConfirmed(member.user.email);
      const pinned = String(process.env.SUPER_ADMIN_EMAILS || "").toLowerCase().split(/[,\s]+/).includes(member.user.email.toLowerCase());
      if (pinned) throw new TRPCError({ code: "BAD_REQUEST", message: "This super admin is set by SUPER_ADMIN_EMAILS; remove them there" });
      if (PRIVILEGED_ROLES.includes(member.role as StaffRoleName) && ctx.staff.role !== "SUPER_ADMIN") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only a super admin can revoke an admin" });
      }
      // Never remove the last super admin (checked and changed in one transaction under a lock).
      await ctx.db.$transaction(async (tx: any) => {
        await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('syncbay:staff-super-admins'))");
        if (member.role === "SUPER_ADMIN") {
          const remaining = await tx.staffMember.count({ where: { role: "SUPER_ADMIN", revokedAt: null, userId: { not: input.userId } } });
          if (remaining === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot remove the last super admin" });
        }
        await tx.staffMember.update({ where: { userId: input.userId }, data: { revokedAt: new Date() } });
      });
      await ctx.staff.audit({ action: "staff.revoke", outcome: "ALLOWED", targetType: "user", targetId: input.userId, metadata: { role: member.role } });
      return { ok: true };
    }),

  // ─── Audit ─────────────────────────────────────────────────────────────────
  audit: staffProcedure("audit.read_own")
    .input(z.object({ actorUserId: z.string().optional(), targetId: z.string().optional(), outcome: z.enum(["ALLOWED", "DENIED", "FAILED"]).optional(), cursor: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const seeAll = permissionsOf(ctx.staff.role).includes("audit.read");
      const where: any = {
        ...(seeAll ? (input?.actorUserId ? { actorUserId: input.actorUserId } : {}) : { actorUserId: ctx.staff.userId }),
        ...(input?.targetId ? { targetId: input.targetId } : {}),
        ...(input?.outcome ? { outcome: input.outcome } : {}),
      };
      const rows = await ctx.db.staffAuditEvent.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 101,
        ...(input?.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
      const actors = await ctx.db.user.findMany({ where: { id: { in: [...new Set(rows.map((r: any) => r.actorUserId).filter(Boolean))] } }, select: { id: true, email: true } });
      const byId = new Map(actors.map((a: any) => [a.id, a.email]));
      return {
        items: rows.slice(0, 100).map((r: any) => ({ ...r, actorEmail: r.actorUserId ? byId.get(r.actorUserId) ?? null : null })),
        nextCursor: rows.length > 100 ? rows[99].id : null,
        scope: seeAll ? "all" : "own",
      };
    }),

  categories: staffProcedure("moderation.report.read").query(() => Object.entries(ABUSE_CATEGORIES).map(([id, priority]) => ({ id, priority }))),
});
