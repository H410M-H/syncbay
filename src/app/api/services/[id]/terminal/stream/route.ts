import { NextRequest, NextResponse } from "next/server";
import { resolveTerminalAccess, terminalContextFor } from "@/lib/shell/terminal-access";
import { openTerminalSession, streamTerminal, type TerminalEvent } from "@/lib/shell/terminal-sessions";
import { TerminalTokenConfigError } from "@/lib/shell/terminal-token";

export const dynamic = "force-dynamic";

/** GET ?sessionId=… → Server-Sent Events: {type:"output"|"meta"|"exit", …} */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: serviceId } = await params;
  const access = await resolveTerminalAccess(serviceId);
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.status });

  const sessionId = req.nextUrl.searchParams.get("sessionId") || "";
  let handle;
  try {
    handle = await openTerminalSession(sessionId, terminalContextFor(access));
  } catch (err) {
    if (err instanceof TerminalTokenConfigError) return NextResponse.json({ error: err.message }, { status: 503 });
    throw err;
  }
  if (!handle) return NextResponse.json({ error: "Terminal session not found or expired" }, { status: 404 });

  const encoder = new TextEncoder();
  const upstream = new AbortController();
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const send = (event: TerminalEvent) => {
        write(`data: ${JSON.stringify(event)}\n\n`);
        if (event.type === "exit") cleanup();
      };

      write(`: connected\n\n`);
      const heartbeat = setInterval(() => write(`: ping\n\n`), 15000);

      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        upstream.abort();
        try {
          controller.close();
        } catch {}
      };
      req.signal.addEventListener("abort", () => cleanup(), { once: true });

      streamTerminal(handle, send, upstream.signal)
        .catch((err) => {
          if (!upstream.signal.aborted) send({ type: "output", data: `\r\n[syncbay] terminal stream error: ${err.message}\r\n` });
        })
        .finally(() => cleanup());
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
