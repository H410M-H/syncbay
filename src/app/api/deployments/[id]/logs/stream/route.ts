import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { createDeploymentLogStream, findAccessibleDeployment } from "@/lib/telemetry/log-stream";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * SSE: replays the deployment's persisted logs, then follows live lines
 * (see src/lib/telemetry/log-stream.ts). Requires a workspace member session.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: deploymentId } = await params;

  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const deployment = await findAccessibleDeployment(deploymentId, userId);
  if (!deployment) {
    return NextResponse.json({ error: "Deployment not found" }, { status: 404 });
  }

  return new Response(createDeploymentLogStream({ deploymentId, signal: req.signal }), {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
