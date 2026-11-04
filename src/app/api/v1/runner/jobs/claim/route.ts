/**
 * Pull-mode runner queue: `POST /api/v1/runner/jobs/claim` (HMAC-signed, see runner/src/job-consumer.ts).
 * Body `{ runnerId }`. Answers 200 `{ job }` with a leased job (deploy payload or a stop/restart
 * target), or 204 when nothing is queued for this runner.
 */

import { NextRequest, NextResponse } from "next/server";
import { claimNextJob } from "@/lib/orchestrator/job-queue";
import { verifyRunnerRequest } from "@/lib/orchestrator/runner-request-auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.text();
  if (!verifyRunnerRequest(req.headers, "POST", req.nextUrl.pathname, body)) {
    return NextResponse.json({ error: "Unauthorized: invalid or missing HMAC signature" }, { status: 401 });
  }
  let runnerId = "";
  try {
    runnerId = String(JSON.parse(body || "{}").runnerId || "");
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(runnerId)) {
    return NextResponse.json({ error: "runnerId is required" }, { status: 400 });
  }

  const job = await claimNextJob(runnerId);
  if (!job) return new NextResponse(null, { status: 204 });
  return NextResponse.json({ job });
}
