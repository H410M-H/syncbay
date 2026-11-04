import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { validateBearerToken, checkScope } from "@/lib/api/auth-token";
import { scheduleDeployment } from "@/lib/orchestrator/schedule";
import { resolveHeadCommitSha } from "@/lib/orchestrator/pr-manager";
import { logEventBus } from "@/lib/telemetry/event-bus";

export const dynamic = "force-dynamic";
// Deployments run in after(); give them the full serverless budget.
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  try {
    const auth = await validateBearerToken(req.headers.get("authorization"));
    const { searchParams } = new URL(req.url);
    const serviceId = searchParams.get("serviceId");

    if (!serviceId) {
      return NextResponse.json({ error: "Missing query parameter 'serviceId'" }, { status: 400 });
    }

    const service = await db.service.findFirst({
      where: {
        id: serviceId,
        environment: { project: { workspaceId: auth.workspaceId } },
      },
      include: {
        deployments: {
          take: 20,
          orderBy: { createdAt: "desc" },
          include: { build: true },
        },
      },
    });

    if (!service) {
      return NextResponse.json({ error: "Service not found" }, { status: 404 });
    }

    return NextResponse.json({
      serviceId: service.id,
      deployments: service.deployments.map((d) => ({
        id: d.id,
        status: d.status,
        commitSha: d.build?.commitSha || null,
        commitMessage: d.build?.commitMessage || null,
        createdAt: d.createdAt,
        completedAt: d.completedAt,
        buildDurationMs: d.buildDurationMs,
        errorMessage: d.errorMessage || logEventBus.getError(d.id) || null,
      })),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: err.message.includes("token") ? 401 : 400 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await validateBearerToken(req.headers.get("authorization"));
    if (!checkScope(auth.scope, "DEPLOY_ONLY") && !checkScope(auth.scope, "FULL_ACCESS")) {
      return NextResponse.json({ error: "Token scope insufficient: Requires DEPLOY_ONLY or FULL_ACCESS" }, { status: 403 });
    }

    const body = await req.json();

    // Redeployment Branch: redeploy an existing deployment by deploymentId
    if (body.deploymentId && (body.redeploy || !body.serviceId)) {
      const prev = await db.deployment.findFirst({
        where: {
          id: body.deploymentId,
          service: {
            environment: { project: { workspaceId: auth.workspaceId } },
          },
        },
        include: { build: true, service: { include: { environment: true } } },
      });

      if (!prev) {
        return NextResponse.json({ error: "Previous deployment not found in workspace" }, { status: 404 });
      }

      let targetBuildId = prev.buildId;
      const shouldRebuild = body.rebuild ?? (!prev.build || prev.build.status === "FAILED");

      if (shouldRebuild) {
        const newBuild = await db.build.create({
          data: {
            serviceId: prev.serviceId,
            commitSha:
              prev.build?.commitSha ||
              (await resolveHeadCommitSha(prev.service.repoUrl, prev.service.branch, {
                projectId: prev.service.environment.projectId,
                userId: auth.userId || undefined,
              })),
            commitMessage: prev.build?.commitMessage
              ? `Rebuild: ${prev.build.commitMessage}`
              : `Redeploy with fresh build of ${prev.id.slice(0, 8)}`,
            triggeredBy: auth.userId || `token:${auth.tokenName}`,
            status: "QUEUED",
          },
        });
        targetBuildId = newBuild.id;
      }

      const deployment = await db.deployment.create({
        data: {
          serviceId: prev.serviceId,
          buildId: targetBuildId,
          triggeredBy: auth.userId || `token:${auth.tokenName}`,
          status: "QUEUED",
        },
      });

      await scheduleDeployment(deployment.id, targetBuildId, prev.serviceId, {
        serviceId: prev.serviceId,
        commitSha: prev.build?.commitSha || undefined,
        commitMessage: shouldRebuild
          ? `Clean rebuild of deployment ${prev.id.slice(0, 8)}`
          : `Fast redeploy of deployment ${prev.id.slice(0, 8)}`,
        cleanBuild: shouldRebuild,
        userId: auth.userId || undefined,
      });

      return NextResponse.json(
        {
          deploymentId: deployment.id,
          buildId: targetBuildId,
          status: "QUEUED",
          rebuild: shouldRebuild,
          serviceName: prev.service.name,
          logsUrl: `/api/deployments/${deployment.id}/logs/stream`,
          message: shouldRebuild
            ? "Clean rebuild queued successfully on Syncbay edge pipeline"
            : "Fast redeploy queued successfully on Syncbay edge pipeline",
        },
        { status: 202 }
      );
    }

    if (!body.serviceId) {
      return NextResponse.json({ error: "Field 'serviceId' or 'deploymentId' is required" }, { status: 400 });
    }

    const service = await db.service.findFirst({
      where: {
        id: body.serviceId,
        environment: { project: { workspaceId: auth.workspaceId } },
      },
      include: { environment: true },
    });

    if (!service) {
      return NextResponse.json({ error: "Service not found in workspace" }, { status: 404 });
    }

    // Real HEAD of the tracked branch, or null — never an invented SHA
    const commitSha =
      body.commitSha ||
      (await resolveHeadCommitSha(service.repoUrl, service.branch, {
        projectId: service.environment.projectId,
        userId: auth.userId || undefined,
      }));
    const commitMessage = body.commitMessage || "CLI trigger deployment";

    const build = await db.build.create({
      data: {
        serviceId: service.id,
        commitSha,
        commitMessage,
        triggeredBy: auth.userId || `token:${auth.tokenName}`,
        status: "QUEUED",
      },
    });

    const deployment = await db.deployment.create({
      data: {
        serviceId: service.id,
        buildId: build.id,
        triggeredBy: auth.userId || `token:${auth.tokenName}`,
        status: "QUEUED",
      },
    });

    await scheduleDeployment(deployment.id, build.id, service.id, {
      serviceId: service.id,
      commitSha: commitSha || undefined,
      commitMessage,
      cleanBuild: body.rebuild ?? false,
      userId: auth.userId || undefined,
    });

    return NextResponse.json(
      {
        deploymentId: deployment.id,
        buildId: build.id,
        status: "QUEUED",
        serviceName: service.name,
        logsUrl: `/api/deployments/${deployment.id}/logs/stream`,
        message: "Deployment queued successfully on Syncbay edge pipeline",
      },
      { status: 202 }
    );
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: err.message.includes("token") ? 401 : 400 });
  }
}
