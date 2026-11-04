import { NextRequest, NextResponse } from "next/server";
import { resolveTerminalAccess, terminalContextFor } from "@/lib/shell/terminal-access";
import { getRunnerBaseUrl, runnerJson } from "@/lib/runner-client";
import {
  createTerminalSession,
  openTerminalSession,
  writeTerminalInput,
  closeTerminalSession,
} from "@/lib/shell/terminal-sessions";
import { TerminalTokenConfigError } from "@/lib/shell/terminal-token";

export const dynamic = "force-dynamic";

const MAX_INPUT = 8192;

function configError(err: unknown) {
  if (err instanceof TerminalTokenConfigError) {
    return NextResponse.json({ error: err.message }, { status: 503 });
  }
  throw err;
}

/**
 * POST {}                     → create a terminal session ({ sessionId, mode, cwd })
 * POST { sessionId, input }   → send input (a command line ending in "\n")
 *
 * `sessionId` is a signed token, so any control-plane instance can serve it.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: serviceId } = await params;
  const access = await resolveTerminalAccess(serviceId);
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.status });
  const context = terminalContextFor(access);

  const body = await req.json().catch(() => ({}));

  try {
    if (typeof body?.sessionId === "string") {
      const handle = await openTerminalSession(body.sessionId, context);
      if (!handle) return NextResponse.json({ error: "Terminal session not found or expired" }, { status: 404 });
      if (typeof body.input !== "string" || body.input.length > MAX_INPUT) {
        return NextResponse.json({ error: `Field 'input' must be a string up to ${MAX_INPUT} chars` }, { status: 400 });
      }
      try {
        const { cwd } = await writeTerminalInput(handle, body.input);
        return NextResponse.json({ ok: true, cwd });
      } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 502 });
      }
    }

    const latest = access.service.deployments[0];
    let runnerSessionId: string | undefined;
    let notice: string | undefined;
    if (getRunnerBaseUrl()) {
      try {
        const env: Record<string, string> = {};
        for (const v of context.variables) env[v.key] = v.value;
        const created = await runnerJson<{ sessionId: string }>("/api/terminals", {
          method: "POST",
          body: { containerId: latest?.cfContainerId || undefined, jobId: latest?.buildId, serviceId, env },
          timeoutMs: 15000,
        });
        runnerSessionId = created.sessionId;
      } catch (err: any) {
        notice = `[syncbay] Runner terminal unavailable (${err.message}); using simulated shell.`;
      }
    }

    const session = await createTerminalSession({ ...context, runnerSessionId, notice });
    return NextResponse.json(session, { status: 201 });
  } catch (err) {
    return configError(err);
  }
}

/** DELETE ?sessionId=… → close the session (and the runner shell). */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: serviceId } = await params;
  const access = await resolveTerminalAccess(serviceId);
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.status });

  try {
    const sessionId = req.nextUrl.searchParams.get("sessionId") || "";
    const handle = await openTerminalSession(sessionId, terminalContextFor(access));
    if (!handle) return NextResponse.json({ error: "Terminal session not found" }, { status: 404 });
    await closeTerminalSession(handle);
    return NextResponse.json({ closed: true });
  } catch (err) {
    return configError(err);
  }
}
