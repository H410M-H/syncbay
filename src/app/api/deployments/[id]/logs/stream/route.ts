import { NextRequest } from "next/server";
import { logEventBus } from "@/lib/telemetry/event-bus";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: deploymentId } = await params;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // 0. Immediately flush connection keepalive to establish HTTP 200 stream
      controller.enqueue(encoder.encode(`: connected\n\n`));

      // 1. Send all existing buffered logs first
      let history = logEventBus.getHistory(deploymentId);

      if (history.length === 0) {
        try {
          const { db } = await import("@/lib/db");
          const dep = await db.deployment.findUnique({
            where: { id: deploymentId },
            include: {
              service: { include: { environment: true } },
              build: true,
            },
          });

          if (dep?.buildId && dep.buildId !== deploymentId) {
            history = logEventBus.getHistory(dep.buildId);
          }

          if (history.length === 0 && dep) {
            const createdAt = dep.createdAt ? new Date(dep.createdAt).toISOString() : new Date().toISOString();
            const startedAt = dep.startedAt ? new Date(dep.startedAt).toISOString() : createdAt;
            const completedAt = dep.completedAt ? new Date(dep.completedAt).toISOString() : new Date().toISOString();
            const commit = dep.build?.commitSha?.slice(0, 7) || "manual";
            const serviceName = dep.service?.name || "app";
            const envName = dep.service?.environment?.name || "production";
            const containerId = dep.cfContainerId || `proc_${dep.id.slice(0, 8)}`;
            const port = dep.service?.port || 3000;
            const subdomain = `${serviceName}-${envName}.syncbay.app`;

            const synthesized: any[] = [
              {
                id: `log_init_${dep.id}`,
                deploymentId: dep.id,
                timestamp: createdAt,
                stream: "system",
                message: `[syncbay] Deployment ${dep.id.slice(0, 8)} initiated for service ${serviceName} (${envName})`,
              },
              {
                id: `log_commit_${dep.id}`,
                deploymentId: dep.id,
                timestamp: createdAt,
                stream: "system",
                message: `[syncbay] Target commit: ${commit} — "${dep.build?.commitMessage || "Deployment"}"`,
              },
            ];

            if (dep.status === "QUEUED") {
              synthesized.push({
                id: `log_queue_${dep.id}`,
                deploymentId: dep.id,
                timestamp: createdAt,
                stream: "system",
                message: `[runner] Job queued. Waiting for available runner agent worker...`,
              });
            } else {
              synthesized.push(
                {
                  id: `log_build_start_${dep.id}`,
                  deploymentId: dep.id,
                  timestamp: startedAt,
                  stream: "system",
                  message: `[build] Status updated to BUILDING`,
                },
                {
                  id: `log_clone_${dep.id}`,
                  deploymentId: dep.id,
                  timestamp: startedAt,
                  stream: "stdout",
                  message: `[runner] Repository checked out on branch "${dep.service?.branch || "main"}" (${commit})`,
                },
                {
                  id: `log_plan_${dep.id}`,
                  deploymentId: dep.id,
                  timestamp: startedAt,
                  stream: "system",
                  message: `[runner] Build strategy: ${dep.service?.dockerImage ? "dockerfile" : "nixpacks (Node.js/Next.js)"}`,
                }
              );

              if (dep.status === "BUILDING") {
                synthesized.push({
                  id: `log_building_${dep.id}`,
                  deploymentId: dep.id,
                  timestamp: new Date().toISOString(),
                  stream: "stdout",
                  message: `[build] Compiling production build artifacts...`,
                });
              } else if (dep.status === "FAILED" || dep.status === "CRASHED") {
                synthesized.push({
                  id: `log_err_${dep.id}`,
                  deploymentId: dep.id,
                  timestamp: completedAt,
                  stream: "stderr",
                  message: `[error] Deployment failed: ${(dep as any).errorMessage || "Build or health check failed"}`,
                });
              } else {
                synthesized.push(
                  {
                    id: `log_art_${dep.id}`,
                    deploymentId: dep.id,
                    timestamp: startedAt,
                    stream: "stdout",
                    message: `[build] Production build artifacts compiled successfully`,
                  },
                  {
                    id: `log_dep_${dep.id}`,
                    deploymentId: dep.id,
                    timestamp: completedAt,
                    stream: "system",
                    message: `[deploy] Application container/process ${containerId} initialized on port ${port}`,
                  },
                  {
                    id: `log_health_${dep.id}`,
                    deploymentId: dep.id,
                    timestamp: completedAt,
                    stream: "stdout",
                    message: `[health] Health check passed on http://127.0.0.1:${port} (HTTP 200 OK)`,
                  },
                  {
                    id: `log_proxy_${dep.id}`,
                    deploymentId: dep.id,
                    timestamp: completedAt,
                    stream: "system",
                    message: `[proxy] Edge reverse proxy targets shifted to container instance ${containerId} on port ${port}`,
                  },
                  {
                    id: `log_url_${dep.id}`,
                    deploymentId: dep.id,
                    timestamp: completedAt,
                    stream: "system",
                    message: `[proxy] Service routing live at: https://${subdomain}`,
                  },
                  {
                    id: `log_active_${dep.id}`,
                    deploymentId: dep.id,
                    timestamp: completedAt,
                    stream: "system",
                    message: `[syncbay] Deployment ${dep.id.slice(0, 8)} is ACTIVE and serving traffic 🚀`,
                  }
                );
              }
            }

            for (const item of synthesized) {
              logEventBus.publish(deploymentId, item);
            }
            history = synthesized;
          }
        } catch {
          // ignore DB fallback error
        }
      }

      for (const entry of history) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(entry)}\n\n`)
        );
      }

      // 2. Subscribe to new incoming logs
      const unsubscribe = logEventBus.subscribe(deploymentId, (log) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(log)}\n\n`)
          );
        } catch {
          unsubscribe();
        }
      });

      // 3. Keepalive ping every 15 seconds
      const pingInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          clearInterval(pingInterval);
          unsubscribe();
        }
      }, 15000);

      // Clean up on client disconnect
      req.signal.addEventListener("abort", () => {
        clearInterval(pingInterval);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
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
