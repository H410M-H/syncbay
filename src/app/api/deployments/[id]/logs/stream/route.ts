import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { validateBearerToken } from "@/lib/api/auth-token";
import { createDeploymentLogStream, findAccessibleDeployment } from "@/lib/telemetry/log-stream";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * SSE: replays the deployment's persisted logs, then follows live lines
 * (see src/lib/telemetry/log-stream.ts). Requires a workspace member session or API bearer token.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: deploymentId } = await params;

  let hasAccess = false;
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (userId) {
    const deployment = await findAccessibleDeployment(deploymentId, userId);
    if (deployment) hasAccess = true;
  }

  if (!hasAccess) {
    try {
      const auth = await validateBearerToken(req.headers.get("authorization"));
      if (auth.workspaceId) {
        const deployment = await db.deployment.findFirst({
          where: {
            id: deploymentId,
            service: {
              environment: {
                project: { workspaceId: auth.workspaceId },
              },
            },
          },
          select: { id: true },
        });
        if (deployment) hasAccess = true;
      }
    } catch {}
  }

  if (!hasAccess) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return new Response(createDeploymentLogStream({ deploymentId, signal: req.signal }), {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
