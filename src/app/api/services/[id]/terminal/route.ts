import { NextRequest, NextResponse } from "next/server";
import { resolveTerminalAccess } from "@/lib/shell/terminal-access";
import { getRunnerBaseUrl, runnerJson } from "@/lib/runner-client";
import {
  createTerminalSession,
  getTerminalSession,
  writeTerminalInput,
  closeTerminalSession,
} from "@/lib/shell/terminal-sessions";

export const dynamic = "force-dynamic";

const MAX_INPUT = 8192;

/**
 * POST {}                     → create a terminal session ({ sessionId, mode })
 * POST { sessionId, input }   → send input (a command line ending in "\n")
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: serviceId } = await params;
  const access = await resolveTerminalAccess(serviceId);
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.status });
  const { userId, service } = access;

  const body = await req.json().catch(() => ({}));

  if (typeof body?.sessionId === "string") {
    const session = getTerminalSession(body.sessionId, userId, serviceId);
    if (!session) return NextResponse.json({ error: "Terminal session not found or expired" }, { status: 404 });
    if (typeof body.input !== "string" || body.input.length > MAX_INPUT) {
      return NextResponse.json({ error: `Field 'input' must be a string up to ${MAX_INPUT} chars` }, { status: 400 });
    }
    try {
      await writeTerminalInput(session, body.input);
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    return NextResponse.json({ ok: true, cwd: session.state.cwd });
  }

  const latest = service.deployments[0];
  const containerId = latest?.cfContainerId || "";
  const variables = service.variables.map((v) => ({ key: v.key, value: v.value, isSecret: v.isSecret }));

  let runnerSessionId: string | undefined;
  let notice: string | undefined;
  if (getRunnerBaseUrl()) {
    try {
      const env: Record<string, string> = {};
      for (const v of variables) env[v.key] = v.value;
      const created = await runnerJson<{ sessionId: string }>("/api/terminals", {
        method: "POST",
        body: { containerId: containerId || undefined, jobId: latest?.buildId, serviceId, env },
        timeoutMs: 15000,
      });
      runnerSessionId = created.sessionId;
    } catch (err: any) {
      notice = `[syncbay] Runner terminal unavailable (${err.message}); using simulated shell.`;
    }
  }

  const session = createTerminalSession({
    serviceId,
    userId,
    serviceName: service.name,
    containerId: containerId || `proc_${service.name}`,
    variables,
    runnerSessionId,
    notice,
  });

  return NextResponse.json({ sessionId: session.id, mode: session.mode, cwd: session.state.cwd }, { status: 201 });
}

/** DELETE ?sessionId=… → close the session (and the runner shell). */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: serviceId } = await params;
  const access = await resolveTerminalAccess(serviceId);
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.status });

  const sessionId = req.nextUrl.searchParams.get("sessionId") || "";
  const session = getTerminalSession(sessionId, access.userId, serviceId);
  if (!session) return NextResponse.json({ error: "Terminal session not found" }, { status: 404 });
  await closeTerminalSession(session.id);
  return NextResponse.json({ closed: true });
}
