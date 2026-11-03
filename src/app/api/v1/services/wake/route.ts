/**
 * Syncbay PaaS — Scale-to-zero wake endpoint.
 *
 * POST { serviceId? , deploymentId? } re-runs the latest deployment of a
 * SLEEPING service and answers 202. Callers must be a workspace member
 * (NextAuth session) or present RUNNER_SECRET as a Bearer token.
 */

import { NextRequest, NextResponse, after } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { executeDeployment } from "@/lib/orchestrator/engine";
import { hasValidRunnerSecret } from "@/lib/edge/runner-auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { serviceId?: unknown; deploymentId?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // empty / invalid body handled below
  }

  let serviceId = typeof body.serviceId === "string" ? body.serviceId : undefined;
  const deploymentId = typeof body.deploymentId === "string" ? body.deploymentId : undefined;
  if (!serviceId && deploymentId) {
    const dep = await db.deployment.findUnique({ where: { id: deploymentId }, select: { serviceId: true } });
    serviceId = dep?.serviceId;
  }
  if (!serviceId) {
    return NextResponse.json({ error: "serviceId or deploymentId is required" }, { status: 400 });
  }

  const viaRunnerSecret = hasValidRunnerSecret(req.headers);
  let userId: string | undefined;
  if (!viaRunnerSecret) {
    const session = await getServerSession(authOptions);
    userId = (session?.user as { id?: string } | undefined)?.id;
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const service = await db.service.findFirst({
    where: {
      id: serviceId,
      deletedAt: null,
      ...(userId
        ? {
            environment: {
              project: {
                workspace: {
                  members: { some: { userId, role: { in: ["OWNER", "ADMIN", "MEMBER"] } } },
                },
              },
            },
          }
        : {}),
    },
    include: {
      deployments: { orderBy: { createdAt: "desc" }, take: 1, include: { build: true } },
    },
  });
  if (!service) {
    return NextResponse.json({ error: "Service not found" }, { status: 404 });
  }

  const latest = service.deployments[0];
  if (!latest) {
    return NextResponse.json({ error: "Service has no deployment to wake" }, { status: 409 });
  }
  if (!service.isPaused && latest.status !== "SLEEPING") {
    return NextResponse.json(
      { error: "Service is not sleeping", status: latest.status, deploymentId: latest.id },
      { status: 409 }
    );
  }

  await db.service.update({ where: { id: service.id }, data: { isPaused: false } });
  await db.deployment.update({ where: { id: latest.id }, data: { status: "QUEUED" } });

  after(() =>
    executeDeployment(latest.id, latest.buildId, service.id, {
      serviceId: service.id,
      commitSha: latest.build?.commitSha || undefined,
      commitMessage: `Wake from scale-to-zero (deployment ${latest.id.slice(0, 8)})`,
      userId,
    }).catch((err) => {
      console.error("[wake] executeDeployment failed:", err);
    })
  );

  return NextResponse.json(
    { accepted: true, serviceId: service.id, deploymentId: latest.id, status: "QUEUED" },
    { status: 202 }
  );
}
