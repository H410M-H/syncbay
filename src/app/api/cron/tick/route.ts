import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/crons/cron-auth";
import { runDeploymentRecovery } from "@/lib/crons/recovery-hook";
import { sampleActiveServices } from "@/lib/telemetry/metrics-sampler";
import { runDueCronJobs } from "@/lib/devops/cron-runner";
import { collectTraffic } from "@/lib/telemetry/traffic-sampler";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Every minute (vercel.json): stale-deployment recovery, metric sampling, traffic drain and due customer CronJobs. */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const now = new Date();
  const [recovery, metrics, traffic, crons] = await Promise.all([
    runDeploymentRecovery(),
    sampleActiveServices().catch((err: Error) => ({ error: err.message })),
    collectTraffic().catch((err: Error) => ({ error: err.message })),
    runDueCronJobs(now)
      .then(({ results: _results, ...summary }) => summary)
      .catch((err: Error) => ({ error: err.message })),
  ]);
  return NextResponse.json({ ok: true, at: now.toISOString(), recovery, metrics, traffic, crons });
}
