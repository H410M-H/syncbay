import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { validateBearerToken, checkScope } from "@/lib/api/auth-token";
import { claimDefaultHostname } from "@/lib/domains/claim";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const auth = await validateBearerToken(req.headers.get("authorization"));
    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get("projectId");

    if (!projectId) {
      return NextResponse.json({ error: "Missing query parameter 'projectId'" }, { status: 400 });
    }

    const project = await db.project.findFirst({
      where: { id: projectId, workspaceId: auth.workspaceId },
      include: {
        environments: {
          include: {
            services: {
              where: { deletedAt: null },
              include: {
                deployments: {
                  take: 1,
                  orderBy: { createdAt: "desc" },
                },
                domains: true,
              },
            },
          },
        },
      },
    });

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const services = project.environments.flatMap((env) =>
      env.services.map((s) => ({
        id: s.id,
        name: s.name,
        environment: env.name,
        sourceType: s.sourceType,
        branch: s.branch,
        instanceType: s.instanceType,
        latestDeployment: s.deployments[0]
          ? {
              id: s.deployments[0].id,
              status: s.deployments[0].status,
              createdAt: s.deployments[0].createdAt,
            }
          : null,
        domains: s.domains.map((d) => d.hostname),
      }))
    );

    return NextResponse.json({ projectId: project.id, services });
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
    if (!body.projectId || !body.name) {
      return NextResponse.json({ error: "Fields 'projectId' and 'name' are required" }, { status: 400 });
    }

    const project = await db.project.findFirst({
      where: { id: body.projectId, workspaceId: auth.workspaceId },
      include: { environments: true },
    });

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const targetEnv =
      project.environments.find((e) => e.name === (body.environment || "production")) ||
      project.environments[0];

    const service = await db.service.create({
      data: {
        environmentId: targetEnv.id,
        name: body.name.trim().toLowerCase(),
        sourceType: body.sourceType || "github",
        repoUrl: body.repoUrl || null,
        branch: body.branch || "main",
        rootDir: body.rootDir || null,
        buildCommand: body.buildCommand || null,
        startCommand: body.startCommand || null,
        port: body.port ? parseInt(body.port, 10) : 3000,
        instanceType: body.instanceType || "lite",
      },
    });

    // The service's own platform host (suffixed when another service already owns the plain name).
    const defaultHostname = await claimDefaultHostname(db, { id: service.id, name: service.name, environment: { name: targetEnv.name } });

    return NextResponse.json(
      {
        id: service.id,
        name: service.name,
        environment: targetEnv.name,
        defaultUrl: `https://${defaultHostname}`,
        createdAt: service.createdAt,
      },
      { status: 201 }
    );
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: err.message.includes("token") ? 401 : 400 });
  }
}
