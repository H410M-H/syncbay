import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { validateBearerToken, checkScope } from "@/lib/api/auth-token";
import { findProjectByName, withProjectNameLock } from "@/lib/projects/project-names";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const auth = await validateBearerToken(req.headers.get("authorization"));

    const projects = await db.project.findMany({
      where: {
        workspaceId: auth.workspaceId,
        deletedAt: null,
      },
      include: {
        environments: {
          include: {
            services: {
              select: { id: true, name: true, sourceType: true, instanceType: true },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({
      workspace: { id: auth.workspaceId, name: auth.workspaceName },
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        tags: p.tags,
        servicesCount: p.environments.flatMap((e) => e.services).length,
        createdAt: p.createdAt,
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
    if (!body.name || typeof body.name !== "string") {
      return NextResponse.json({ error: "Field 'name' is required" }, { status: 400 });
    }

    const name = body.name.trim();
    if (!name) {
      return NextResponse.json({ error: "Field 'name' is required" }, { status: 400 });
    }

    // Same rule as the dashboard: no two non-deleted projects with one name in a workspace
    const result = await withProjectNameLock(db, auth.workspaceId, async (tx) => {
      const existing = await findProjectByName(tx, auth.workspaceId, name);
      return existing ? { existing, project: null } : { existing: null, project: await createProject(tx, auth.workspaceId, name, body) };
    });
    if (result.existing) {
      return NextResponse.json(
        { error: `A project named "${result.existing.name}" already exists`, existingProjectId: result.existing.id },
        { status: 409 }
      );
    }
    const project = result.project;

    return NextResponse.json(
      {
        id: project.id,
        name: project.name,
        description: project.description,
        environments: project.environments.map((e: { id: string; name: string }) => ({ id: e.id, name: e.name })),
        createdAt: project.createdAt,
      },
      { status: 201 }
    );
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: err.message.includes("token") ? 401 : 400 });
  }
}

function createProject(tx: any, workspaceId: string, name: string, body: { description?: string; tags?: unknown }) {
  return tx.project.create({
    data: {
      workspaceId,
      name,
      description: body.description?.trim() || null,
      tags: Array.isArray(body.tags) ? body.tags : [],
      environments: {
        create: [
          { name: "production", isDefault: true },
          { name: "preview", isDefault: false },
        ],
      },
    },
    include: { environments: true },
  });
}
