import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import { TRPCError } from "@trpc/server";
import { logEventBus } from "@/lib/telemetry/event-bus";
import { stopServiceInstances } from "@/lib/orchestrator/lifecycle";
import { needsRebuild, redeployFromDeployment, setServicePaused } from "@/lib/orchestrator/service-actions";
import { isRunnerConfigError } from "@/lib/orchestrator/runner-config";
import { requestTunnelReload } from "@/lib/tunnel/tunnel-sync";
import { cloudflareApiClient } from "@/lib/tunnel/cloudflare-api";
import { findProjectByName, withProjectNameLock } from "@/lib/projects/project-names";
import { ErrorDetails } from "@/server/error-details";
import { requireRunnerReady, surfaceRunnerConfigErrors } from "@/server/runner-preflight";

/** Helper — verify caller is a member of the workspace containing this project */
async function assertProjectAccess(
  db: TRPCContext["db"],
  userId: string,
  projectId: string
) {
  const project = await db.project.findFirst({
    where: {
      id: projectId,
      deletedAt: null,
      workspace: { members: { some: { userId } } },
    },
    include: {
      workspace: { include: { members: true } },
      buckets: true,
      environments: {
        include: {
          services: {
            where: { deletedAt: null },
            include: {
              deployments: {
                orderBy: { createdAt: "desc" },
                take: 10,
                include: {
                  build: true,
                },
              },
              domains: true,
              variables: true,
              volumes: true,
            },
          },
          databases: true,
        },
      },
    },
  });
  if (!project) throw new TRPCError({ code: "NOT_FOUND" });
  return {
    ...project,
    environments: project.environments.map((env) => ({
      ...env,
      services: env.services.map((svc) => ({
        ...svc,
        deployments: svc.deployments.map((dep) => ({
          ...dep,
          errorMessage: dep.errorMessage || logEventBus.getError(dep.id) || null,
        })),
      })),
    })),
  };
}

import type { TRPCContext } from "@/server/trpc";

type Role = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
const OPS_ROLES: Role[] = ["OWNER", "ADMIN", "MEMBER"];
const IN_FLIGHT = ["QUEUED", "BUILDING", "DEPLOYING"];

/** Loads a non-deleted project the caller may act on with one of `roles` (NOT_FOUND / FORBIDDEN otherwise). */
async function loadProjectForAction(
  db: TRPCContext["db"],
  userId: string,
  projectId: string,
  roles: Role[],
  forbiddenMessage = "Viewers cannot change projects"
) {
  const project = await db.project.findFirst({
    where: { id: projectId, deletedAt: null, workspace: { members: { some: { userId } } } },
    include: { workspace: { include: { members: { where: { userId }, select: { role: true } } } } },
  });
  if (!project) throw new TRPCError({ code: "NOT_FOUND" });
  const role = project.workspace.members[0]?.role as Role | undefined;
  if (!role || !roles.includes(role)) throw new TRPCError({ code: "FORBIDDEN", message: forbiddenMessage });
  return project;
}

function duplicateNameError(existing: { id: string; name: string }): TRPCError {
  return new TRPCError({
    code: "CONFLICT",
    message: `A project named "${existing.name}" already exists`,
    cause: new ErrorDetails("Duplicate project name", { existingProjectId: existing.id }),
  });
}

/** The project's non-deleted services (every environment, PR previews included). */
function projectServices(db: TRPCContext["db"], projectId: string, where: Record<string, unknown> = {}) {
  return db.service.findMany({
    where: { deletedAt: null, environment: { projectId }, ...where },
    include: { environment: true },
    orderBy: { createdAt: "asc" },
  });
}

interface ProjectStatusCounts {
  services: number;
  live: number;
  sleeping: number;
  failed: number;
  building: number;
  paused: number;
}

/** Counts by each service's latest deployment (a paused service counts as sleeping). */
function summarizeProject(project: {
  environments: Array<{ services: Array<{ isPaused: boolean; deployments: Array<{ status: string; createdAt: Date }> }> }>;
}): { counts: ProjectStatusCounts; lastDeployedAt: Date | null } {
  const counts: ProjectStatusCounts = { services: 0, live: 0, sleeping: 0, failed: 0, building: 0, paused: 0 };
  let lastDeployedAt: Date | null = null;
  for (const env of project.environments) {
    for (const svc of env.services) {
      counts.services += 1;
      const latest = svc.deployments[0];
      if (latest && (!lastDeployedAt || latest.createdAt > lastDeployedAt)) lastDeployedAt = latest.createdAt;
      if (svc.isPaused) {
        counts.paused += 1;
        counts.sleeping += 1;
      } else if (latest?.status === "ACTIVE") counts.live += 1;
      else if (latest?.status === "SLEEPING") counts.sleeping += 1;
      else if (latest?.status === "FAILED" || latest?.status === "CRASHED") counts.failed += 1;
      else if (latest && IN_FLIGHT.includes(latest.status)) counts.building += 1;
    }
  }
  return { counts, lastDeployedAt };
}

type ServiceActionResult = {
  serviceId: string;
  serviceName: string;
  status: "scheduled" | "paused" | "resumed" | "skipped" | "failed";
  deploymentId?: string;
  rebuild?: boolean;
  reason?: string;
  stopped?: number;
  stopFailures?: number;
};

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** All failures are runner configuration errors and nothing succeeded: one PRECONDITION_FAILED. */
function throwIfOnlyConfigFailures(results: ServiceActionResult[], configError: Error | null): void {
  if (!configError) return;
  if (results.some((r) => r.status !== "failed" && r.status !== "skipped")) return;
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: configError.message, cause: configError });
}

export const projectRouter = createTRPCRouter({
  /** List projects in a workspace */
  list: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ ctx, input }) => {
      const member = await ctx.db.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: ctx.session.user.id } },
        select: { role: true },
      });
      const projects = await ctx.db.project.findMany({
        where: {
          workspaceId: input.workspaceId,
          deletedAt: null,
          workspace: { members: { some: { userId: ctx.session.user.id } } },
        },
        include: {
          environments: {
            include: {
              services: {
                where: { deletedAt: null },
                include: {
                  deployments: {
                    orderBy: { createdAt: "desc" },
                    take: 1,
                  },
                },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });
      // Per-project status from each non-deleted service's latest deployment, plus the caller's role
      return projects.map((project) => ({ ...project, ...summarizeProject(project), myRole: (member?.role ?? null) as Role | null }));
    }),

  /** Get a single project by id */
  byId: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ ctx, input }) => {
      return assertProjectAccess(ctx.db, ctx.session.user.id, input.projectId);
    }),

  /** Create a project */
  create: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        name: z.string().trim().min(1).max(64),
        description: z.string().max(256).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Confirm user is a member of the workspace
      const member = await ctx.db.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: input.workspaceId,
            userId: ctx.session.user.id,
          },
        },
      });
      if (!member || member.role === "VIEWER") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Viewers cannot create projects" });
      }

      // No duplicate non-deleted names per workspace (a retried wizard must not create a second copy)
      return withProjectNameLock(ctx.db, input.workspaceId, async (tx) => {
        const existing = await findProjectByName(tx, input.workspaceId, input.name);
        if (existing) throw duplicateNameError(existing);
        return tx.project.create({
          data: {
            workspaceId: input.workspaceId,
            name: input.name,
            description: input.description,
            environments: {
              create: {
                name: "production",
                isDefault: true,
              },
            },
          },
          include: { environments: true },
        });
      });
    }),

  /** Rename / re-describe a project (duplicate names in the workspace are a CONFLICT) */
  update: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        name: z.string().trim().min(1).max(64).optional(),
        description: z.string().max(256).nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const project = await loadProjectForAction(ctx.db, ctx.session.user.id, input.projectId, OPS_ROLES);
      return withProjectNameLock(ctx.db, project.workspaceId, async (tx) => {
        if (input.name !== undefined && input.name !== project.name) {
          const existing = await findProjectByName(tx, project.workspaceId, input.name, project.id);
          if (existing) throw duplicateNameError(existing);
        }
        return tx.project.update({
          where: { id: project.id },
          data: {
            ...(input.name !== undefined && { name: input.name }),
            ...(input.description !== undefined && { description: input.description }),
          },
        });
      });
    }),

  /**
   * Redeploy every non-paused service from its latest deployment (fast redeploy, or a clean
   * rebuild with `rebuild: true` / when that build failed), through the durable scheduler.
   */
  redeployAll: protectedProcedure
    .input(z.object({ projectId: z.string(), rebuild: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      await loadProjectForAction(ctx.db, ctx.session.user.id, input.projectId, OPS_ROLES, "Viewers cannot redeploy projects");
      requireRunnerReady();

      const results: ServiceActionResult[] = [];
      for (const svc of await projectServices(ctx.db, input.projectId)) {
        const base = { serviceId: svc.id, serviceName: svc.name };
        if (svc.isPaused) {
          results.push({ ...base, status: "skipped", reason: "Service is paused" });
          continue;
        }
        const prev = await ctx.db.deployment.findFirst({
          where: { serviceId: svc.id },
          orderBy: { createdAt: "desc" },
          include: { build: true },
        });
        if (!prev) {
          results.push({ ...base, status: "skipped", reason: "No previous deployment" });
          continue;
        }
        if (IN_FLIGHT.includes(prev.status)) {
          results.push({ ...base, status: "skipped", reason: "A deployment is already in progress", deploymentId: prev.id });
          continue;
        }
        try {
          const { deployment, rebuild } = await redeployFromDeployment(
            ctx.db,
            { ...prev, service: svc },
            { rebuild: Boolean(input.rebuild) || needsRebuild(prev), userId: ctx.session.user.id }
          );
          results.push({ ...base, status: "scheduled", deploymentId: deployment.id, rebuild });
        } catch (err) {
          results.push({ ...base, status: "failed", reason: errorMessage(err) });
        }
      }
      return { projectId: input.projectId, results, scheduled: results.filter((r) => r.status === "scheduled").length };
    }),

  /** Pause every service: stop its instances on the runner and route it to the sleeping splash */
  pauseAll: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await loadProjectForAction(ctx.db, ctx.session.user.id, input.projectId, OPS_ROLES, "Viewers cannot pause projects");
      const results: ServiceActionResult[] = [];
      let configError: Error | null = null;
      for (const svc of await projectServices(ctx.db, input.projectId)) {
        const base = { serviceId: svc.id, serviceName: svc.name };
        if (svc.isPaused) {
          results.push({ ...base, status: "skipped", reason: "Already paused" });
          continue;
        }
        try {
          const { lifecycle } = await setServicePaused(ctx.db, svc.id, true, ctx.session.user.id);
          results.push({
            ...base,
            status: "paused",
            stopped: (lifecycle?.stopped.length ?? 0) + (lifecycle?.queued.length ?? 0),
            stopFailures: lifecycle?.failed.length ?? 0,
            ...(lifecycle?.failed.length ? { reason: lifecycle.failed.map((f) => f.message).filter(Boolean).join("; ") } : {}),
          });
        } catch (err) {
          if (isRunnerConfigError(err)) configError = err;
          results.push({ ...base, status: "failed", reason: errorMessage(err) });
        }
      }
      throwIfOnlyConfigFailures(results, configError);
      return { projectId: input.projectId, results, paused: results.filter((r) => r.status === "paused").length };
    }),

  /** Resume every paused service (wakes its sleeping deployment through the durable scheduler) */
  resumeAll: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await loadProjectForAction(ctx.db, ctx.session.user.id, input.projectId, OPS_ROLES, "Viewers cannot resume projects");
      const results: ServiceActionResult[] = [];
      let configError: Error | null = null;
      for (const svc of await projectServices(ctx.db, input.projectId)) {
        const base = { serviceId: svc.id, serviceName: svc.name };
        if (!svc.isPaused) {
          results.push({ ...base, status: "skipped", reason: "Not paused" });
          continue;
        }
        try {
          const { wokeDeploymentId } = await setServicePaused(ctx.db, svc.id, false, ctx.session.user.id);
          results.push({
            ...base,
            status: "resumed",
            ...(wokeDeploymentId ? { deploymentId: wokeDeploymentId } : { reason: "Nothing to wake" }),
          });
        } catch (err) {
          if (isRunnerConfigError(err)) configError = err;
          results.push({ ...base, status: "failed", reason: errorMessage(err) });
        }
      }
      throwIfOnlyConfigFailures(results, configError);
      return { projectId: input.projectId, results, resumed: results.filter((r) => r.status === "resumed").length };
    }),

  /**
   * Delete a project — FR-PROJ-07. A real teardown: every service's instances are stopped on the
   * runner and its routes removed (`stopServiceInstances(…, "delete")`), its custom domains are
   * released, the services are marked deleted, then the project. There is no restore.
   */
  delete: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        confirmName: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const project = await loadProjectForAction(
        ctx.db,
        ctx.session.user.id,
        input.projectId,
        ["OWNER", "ADMIN"],
        "Only workspace owners and admins can delete projects"
      );

      if (input.confirmName !== project.name) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Project name confirmation does not match.",
        });
      }

      const reason = `project-delete:${project.id}`;
      const teardown: Array<{ serviceId: string; serviceName: string; stopped: number; cancelled: number; stopFailures: number }> = [];
      for (const svc of await projectServices(ctx.db, project.id)) {
        // A runner configuration error stops the delete (PRECONDITION_FAILED) before this service changes
        const report = await surfaceRunnerConfigErrors(() => stopServiceInstances(svc.id, "delete", ctx.db, { reason }));
        const domains = await ctx.db.domain.findMany({ where: { serviceId: svc.id }, select: { id: true, cfRecordId: true } });
        for (const d of domains) if (d.cfRecordId) await cloudflareApiClient.deleteCustomHostname(d.cfRecordId).catch(() => null);
        if (domains.length) await ctx.db.domain.deleteMany({ where: { id: { in: domains.map((d) => d.id) } } });
        await ctx.db.service.update({ where: { id: svc.id }, data: { deletedAt: new Date() } });
        teardown.push({
          serviceId: svc.id,
          serviceName: svc.name,
          stopped: report.stopped.length + report.queued.length,
          cancelled: report.cancelled.length,
          stopFailures: report.failed.length,
        });
      }

      const deleted = await ctx.db.project.update({
        where: { id: project.id },
        data: { deletedAt: new Date() },
      });
      await requestTunnelReload(reason); // no-op unless a tunnel is configured; never throws
      return { ...deleted, teardown };
    }),

  /** Create an additional environment */
  createEnvironment: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        name: z.string().min(1).max(32),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const project = await assertProjectAccess(ctx.db, ctx.session.user.id, input.projectId);
      const callerMember = project.workspace.members.find((m) => m.userId === ctx.session.user.id);
      if (!callerMember || callerMember.role === "VIEWER") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Viewers cannot create environments" });
      }

      return ctx.db.environment.create({
        data: {
          projectId: input.projectId,
          name: input.name,
        },
      });
    }),
});
