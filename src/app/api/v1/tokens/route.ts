import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import crypto from "crypto";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized. Please sign in." }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const name = body.name || "Default API Token";
    const scope = body.scope || "FULL_ACCESS";

    // Find the user's personal workspace or first available workspace
    const member = await db.workspaceMember.findFirst({
      where: { userId: session.user.id },
      include: { workspace: true },
    });

    if (!member) {
      return NextResponse.json({ error: "No workspace found for user. Please create one." }, { status: 400 });
    }

    // Generate a secure token
    const rawToken = "sb_live_" + crypto.randomBytes(24).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    const apiToken = await db.apiToken.create({
      data: {
        userId: session.user.id,
        workspaceId: member.workspaceId,
        name: name,
        tokenHash: tokenHash,
        scope: scope,
      },
    });

    return NextResponse.json(
      {
        id: apiToken.id,
        name: apiToken.name,
        scope: apiToken.scope,
        token: rawToken, // Return the raw token ONLY once
        createdAt: apiToken.createdAt,
      },
      { status: 201 }
    );
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized. Please sign in." }, { status: 401 });
    }

    const tokens = await db.apiToken.findMany({
      where: {
        userId: session.user.id,
        revokedAt: null,
      },
      select: {
        id: true,
        name: true,
        scope: true,
        lastUsedAt: true,
        createdAt: true,
        workspaceId: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ tokens });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
