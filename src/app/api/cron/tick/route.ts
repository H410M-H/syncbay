import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/crons/cron-auth";
import { runDeploymentRecovery } from "@/lib/crons/recovery-hook";
import { sampleActiveServices } from "@/lib/telemetry/metrics-sampler";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Every minute (vercel.json): stale-deployment recovery + metric sampling. */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const [recovery, metrics] = await Promise.all([
    runDeploymentRecovery(),
    sampleActiveServices().catch((err: Error) => ({ error: err.message })),
  ]);
  return NextResponse.json({ ok: true, at: new Date().toISOString(), recovery, metrics });
}
