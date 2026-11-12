import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/crons/cron-auth";
import { runDeploymentRecovery } from "@/lib/crons/recovery-hook";
import { sampleActiveServices } from "@/lib/telemetry/metrics-sampler";
import { runDueCronJobs } from "@/lib/devops/cron-runner";
import { collectTraffic } from "@/lib/telemetry/traffic-sampler";
import { wakeAlwaysOnServices } from "@/lib/scale/always-on";

export const dynamic = "force-dynamic";
// Resuming a long build polls the runner for up to 200 s (recovery-hook), so the tick needs more than a minute.
export const maxDuration = 300;

/** Every minute (vercel.json): stale-deployment recovery, waking always-on services, metric sampling, traffic drain and due customer CronJobs. */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const now = new Date();
  const [recovery, alwaysOn, metrics, traffic, crons] = await Promise.all([
    runDeploymentRecovery(),
    wakeAlwaysOnServices().catch((err: Error) => ({ error: err.message })),
    sampleActiveServices().catch((err: Error) => ({ error: err.message })),
    collectTraffic().catch((err: Error) => ({ error: err.message })),
    runDueCronJobs(now)
      .then(({ results: _results, ...summary }) => summary)
      .catch((err: Error) => ({ error: err.message })),
  ]);
  return NextResponse.json({ ok: true, at: now.toISOString(), recovery, alwaysOn, metrics, traffic, crons });
}
