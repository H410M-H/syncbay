/**
 * Pull-mode runner progress: `POST /api/v1/runner/jobs/:id/events` (HMAC-signed).
 * Body `{ runnerId, logs?, status?: RUNNING|SUCCEEDED|FAILED, result? }`. Relays log lines to
 * the deployment's log stream, renews the runner lease, and records the terminal result the
 * orchestrator (or the recovery sweep) then finalizes. Answers `{ cancelled }` so the runner
 * can tear down a cancelled build; 409 when the caller does not hold the lease.
 */

import { NextRequest, NextResponse } from "next/server";
import { recordRunnerEvents, type RunnerEventBody } from "@/lib/orchestrator/job-queue";
import { verifyRunnerRequest } from "@/lib/orchestrator/runner-request-auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.text();
  if (!verifyRunnerRequest(req.headers, "POST", req.nextUrl.pathname, body)) {
    return NextResponse.json({ error: "Unauthorized: invalid or missing HMAC signature" }, { status: 401 });
  }
  let parsed: RunnerEventBody;
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const res = await recordRunnerEvents(id, parsed);
  return NextResponse.json(res.body, { status: res.status });
}
