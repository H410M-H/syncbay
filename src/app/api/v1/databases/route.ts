import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { validateBearerToken, checkScope } from "@/lib/api/auth-token";
import { databaseProvider, attachDatabaseVariables } from "@/lib/database-provider";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const auth = await validateBearerToken(req.headers.get("authorization"));

    const databases = await db.databaseInstance.findMany({
      where: {
        environment: { project: { workspaceId: auth.workspaceId, deletedAt: null } },
      },
      include: {
        environment: { select: { name: true, project: { select: { name: true } } } },
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({
      databases: databases.map((d) => ({
        id: d.id,
        name: d.name,
        provider: d.provider,
        status: d.status,
        region: d.region,
        project: d.environment.project.name,
        environment: d.environment.name,
        storageGb: d.storageGb,
        createdAt: d.createdAt,
      })),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: err.message.includes("token") ? 401 : 400 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await validateBearerToken(req.headers.get("authorization"));
    if (!checkScope(auth.scope, "FULL_ACCESS")) {
      return NextResponse.json({ error: "Token scope insufficient: Requires FULL_ACCESS" }, { status: 403 });
    }

    const body = await req.json();
    if (!body.name || !body.projectId) {
      return NextResponse.json({ error: "Fields 'name' and 'projectId' are required" }, { status: 400 });
    }

    const project = await db.project.findFirst({
      where: { id: body.projectId, workspaceId: auth.workspaceId, deletedAt: null },
      include: { environments: true },
    });

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const targetEnv =
      project.environments.find((e) => e.name === (body.environment || "production")) ||
      project.environments[0];
    if (!targetEnv) {
      return NextResponse.json(
        { error: "Project has no environments; create an environment before provisioning a database" },
        { status: 409 }
      );
    }

    const provider = String(body.provider || "POSTGRES").toUpperCase();
    if (provider !== "POSTGRES" && provider !== "REDIS" && provider !== "MYSQL") {
      return NextResponse.json({ error: "Field 'provider' must be one of POSTGRES, REDIS, MYSQL" }, { status: 400 });
    }
    const name = String(body.name).trim();
    const region = body.region || "us-east-1";

    const pending = await db.databaseInstance.create({
      data: {
        environmentId: targetEnv.id,
        name,
        provider,
        connectionUrl: "",
        status: "PROVISIONING",
        region,
        storageGb: body.storageGb ? parseInt(body.storageGb, 10) : 1,
      },
    });

    let creds;
    try {
      creds = await databaseProvider.provision({
        id: pending.id,
        projectId: project.id,
        environmentId: targetEnv.id,
        name,
        provider,
        region,
      });
    } catch (provisionErr: any) {
      await db.databaseInstance.update({ where: { id: pending.id }, data: { status: "FAILED" } }).catch(() => null);
      return NextResponse.json({ error: `Database provisioning failed: ${provisionErr.message}` }, { status: 502 });
    }

    const instance = await db.databaseInstance.update({
      where: { id: pending.id },
      data: {
        partnerDbId: creds.partnerDbId,
        connectionUrl: creds.connectionUrl,
        host: creds.host,
        port: creds.port,
        containerId: creds.containerId,
        status: "ACTIVE",
        lastHealthAt: new Date(),
      },
    });

    await attachDatabaseVariables(db, {
      workspaceId: auth.workspaceId,
      environmentId: targetEnv.id,
      name,
      provider,
      connectionUrl: creds.connectionUrl,
    });

    return NextResponse.json(
      {
        id: instance.id,
        name: instance.name,
        provider: instance.provider,
        status: instance.status,
        region: instance.region,
        connectionUrl: creds.connectionUrl,
        cliCommand: creds.cliCommand,
        createdAt: instance.createdAt,
      },
      { status: 201 }
    );
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: err.message.includes("token") ? 401 : 400 });
  }
}
