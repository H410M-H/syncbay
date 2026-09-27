import { TRPCError } from "@trpc/server";
import { purgeEdgeCache } from "@/lib/edge/edge-router";

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

  // Find currently active deployment for the service and mark it SUPERSEDED
  const currentActive = await db.deployment.findFirst({
    where: {
      serviceId: target.serviceId,
      status: "ACTIVE",
      id: { not: target.id },
    },
  });

  if (currentActive) {
    await db.deployment.update({
      where: { id: currentActive.id },
      data: { status: "SUPERSEDED" },
    });
  }

  // Mark target deployment ACTIVE
  const activeDeployment = await db.deployment.update({
    where: { id: target.id },
    data: { status: "ACTIVE" },
  });

  // Purge edge cache across all 6 POPs
  const purgeResult = purgeEdgeCache({ all: true });

  // Record audit log entry
  try {
    await db.auditLogEntry.create({
      data: {
        workspaceId: workspace.id,
        actorUserId: userId,
        action: "deployment.rollback",
        metadata: {
          targetDeploymentId: activeDeployment.id,
          previousDeploymentId: currentActive?.id ?? null,
          serviceId: target.serviceId,
        },
      },
    });
  } catch {
    // Ignore audit logging errors if schema or DB constraints fail
  }

  const durationMs = Math.max(1, Date.now() - startTime);

  return {
    success: true,
    targetDeploymentId: activeDeployment.id,
    activeDeploymentId: activeDeployment.id,
    previousDeploymentId: currentActive?.id ?? null,
    purgedPops: purgeResult.purgedPops,
    durationMs,
    latencyMs: durationMs,
    message: `Traffic instantly shifted to deployment ${activeDeployment.id.slice(0, 8)} in ${durationMs}ms`,
  };
}
