import { TRPCError } from "@trpc/server";
import { purgeEdgeCache } from "@/lib/edge/edge-router";
import { rollbackToDeployment } from "@/lib/orchestrator/lifecycle";

export interface InstantRollbackInput {
  deploymentId: string;
  serviceId?: string;
}

export async function executeInstantRollback(
  db: any,
  userId: string,
  input: InstantRollbackInput
) {
  const startTime = Date.now();

  const target = await db.deployment.findUnique({
    where: { id: input.deploymentId },
    include: {
      build: true,
      service: {
        include: {
          environment: {
            include: {
              project: {
                include: {
                  workspace: {
                    include: { members: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!target || !target.service) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Target deployment does not exist.",
    });
  }

  const workspace = target.service.environment.project.workspace;
  const callerMember = workspace.members.find((m: any) => m.userId === userId);

  if (!callerMember || (callerMember.role !== "OWNER" && callerMember.role !== "ADMIN")) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only workspace Owners and Admins can execute instant rollbacks.",
    });
  }

  if (input.serviceId && target.serviceId !== input.serviceId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Target deployment does not belong to this service.",
    });
  }

  if (target.status === "ACTIVE") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Target deployment is already active.",
    });
  }

  if (target.status === "FAILED") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Cannot rollback to a failed deployment.",
    });
  }

  if (!target.build || target.build.status !== "SUCCEEDED") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Target deployment has no successful build to roll back to.",
    });
  }

  const currentActive = await db.deployment.findFirst({
    where: {
      serviceId: target.serviceId,
      status: "ACTIVE",
      id: { not: target.id },
    },
  });

  // Restart the target's instance on its runner and move every route to it; when the instance
  // is gone, redeploy its build (the current deployment serves until the new one supersedes it).
  const outcome = await rollbackToDeployment(target, currentActive, userId, db);
  const activeDeployment = { id: outcome.mode === "restart" ? target.id : outcome.deploymentId! };

  // Purge the Cloudflare edge cache (reports "not configured" when Cloudflare is unset)
  const purgeResult = await purgeEdgeCache({ all: true });

  // Record audit log entry
  try {
    await db.auditLogEntry.create({
      data: {
        workspaceId: workspace.id,
        actorUserId: userId,
        action: "deployment.rollback",
        metadata: {
          targetDeploymentId: target.id,
          previousDeploymentId: currentActive?.id ?? null,
          serviceId: target.serviceId,
          mode: outcome.mode,
        },
      },
    });
  } catch {
    // Ignore audit logging errors if schema or DB constraints fail
  }

  const durationMs = Math.max(1, Date.now() - startTime);

  return {
    success: true,
    targetDeploymentId: target.id,
    activeDeploymentId: activeDeployment.id,
    previousDeploymentId: currentActive?.id ?? null,
    mode: outcome.mode,
    port: outcome.port,
    purgedPops: purgeResult.purgedPops,
    durationMs,
    latencyMs: durationMs,
    message:
      outcome.mode === "restart"
        ? `Traffic shifted to restarted deployment ${target.id.slice(0, 8)} in ${durationMs}ms`
        : `Instance of ${target.id.slice(0, 8)} is gone; redeploying its build as ${activeDeployment.id.slice(0, 8)}`,
  };
}
