import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { findAccessibleDeployment } from "@/lib/telemetry/log-stream";
import { fetchContainerMetrics, latestSamples, sampleToPoint, type TelemetryPoint } from "@/lib/telemetry/metrics-sampler";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const LIVE_INTERVAL_MS = 5000;

/** Wire shape consumed by the dashboard metrics tab. */
function toSnapshot(deploymentId: string, p: TelemetryPoint, source: string) {
  return {
    deploymentId,
    timestamp: p.timestamp,
    cpuPercent: p.cpuPercent,
    memoryMiB: p.memoryUsedMb,
    memoryLimitMiB: p.memoryLimitMb,
    networkEgressKb: p.networkEgressKb,
    networkIngressKb: p.networkIngressKb,
    diskUsedMiB: p.diskUsedMb,
    source,
  };
}

/**
 * SSE: real metrics for a deployment. Reads the runner live every 5 s when the
 * container is reachable, otherwise replays the newest stored `MetricSample`.
 * Requires a workspace member session.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: deploymentId } = await params;
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const deployment = await findAccessibleDeployment(deploymentId, userId);
  if (!deployment) return NextResponse.json({ error: "Deployment not found" }, { status: 404 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let prev: Parameters<typeof sampleToPoint>[0] | null = null;
      let lastSentAt = "";
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      const tick = async () => {
        if (closed) return;
        try {
          const live =
            deployment.status === "ACTIVE" && deployment.cfContainerId
              ? await fetchContainerMetrics(deployment.cfContainerId).catch(() => null)
              : null;
          if (live) {
            const sample = { ...live, sampledAt: live.sampledAt || new Date().toISOString() };
            send(`data: ${JSON.stringify(toSnapshot(deploymentId, sampleToPoint(sample, prev), live.source))}\n\n`);
            prev = sample;
            return;
          }
          const [latest, before] = await latestSamples({ deploymentId });
          if (latest && latest.sampledAt.toISOString() !== lastSentAt) {
            lastSentAt = latest.sampledAt.toISOString();
            send(`data: ${JSON.stringify(toSnapshot(deploymentId, sampleToPoint(latest, before), latest.source))}\n\n`);
          } else if (!latest) {
            send(`event: unavailable\ndata: ${JSON.stringify({ deploymentId, status: deployment.status })}\n\n`);
          }
        } catch {
          // transient failure; next tick retries
        }
      };

      void tick();
      const interval = setInterval(() => void tick(), LIVE_INTERVAL_MS);
      const cleanup = () => {
        closed = true;
        clearInterval(interval);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      if (req.signal.aborted) cleanup();
      else req.signal.addEventListener("abort", cleanup, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
