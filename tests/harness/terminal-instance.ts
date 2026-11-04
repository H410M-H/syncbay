/**
 * One "control-plane instance" for tests/verify-terminal-stateless.ts.
 *
 * Each invocation is a fresh Node process with its own module graph and Prisma client, so
 * nothing can be shared through memory: only the signed token, Postgres and the runner.
 * Talks to the parent on stdout with a single JSON line prefixed by `RESULT `.
 *
 *   tsx terminal-instance.ts create   '<ctx json>'  [runner]   → { sessionId, mode, cwd }
 *   tsx terminal-instance.ts input    '<ctx json>'  <token> <input>
 *   tsx terminal-instance.ts stream   '<ctx json>'  <token> <untilText> <timeoutMs>
 *   tsx terminal-instance.ts open     '<ctx json>'  <token>   → { ok: boolean }
 *   tsx terminal-instance.ts close    '<ctx json>'  <token>
 */

import {
  createTerminalSession,
  openTerminalSession,
  writeTerminalInput,
  streamTerminal,
  closeTerminalSession,
} from "../../src/lib/shell/terminal-sessions";
import { runnerJson } from "../../src/lib/runner-client";
import { db } from "../../src/lib/db";

function out(value: unknown): void {
  process.stdout.write(`RESULT ${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
  const [cmd, ctxJson, ...args] = process.argv.slice(2);
  const ctx = JSON.parse(ctxJson);

  if (cmd === "create") {
    let runnerSessionId: string | undefined;
    if (args[0] === "runner") {
      const env: Record<string, string> = {};
      for (const v of ctx.variables) env[v.key] = v.value;
      const created = await runnerJson<{ sessionId: string }>("/api/terminals", {
        method: "POST",
        body: { containerId: ctx.containerId, serviceId: ctx.serviceId, env },
        timeoutMs: 15000,
      });
      runnerSessionId = created.sessionId;
    }
    out({ pid: process.pid, ...(await createTerminalSession({ ...ctx, runnerSessionId })) });
    return;
  }

  const handle = await openTerminalSession(args[0], ctx);
  if (cmd === "open") return out({ pid: process.pid, ok: Boolean(handle) });
  if (!handle) throw new Error("token rejected");

  if (cmd === "input") {
    out({ pid: process.pid, ...(await writeTerminalInput(handle, args[1])) });
    return;
  }
  if (cmd === "close") {
    await closeTerminalSession(handle);
    out({ pid: process.pid, closed: true });
    return;
  }
  if (cmd === "stream") {
    const until = args[1];
    const abort = new AbortController();
    let output = "";
    const cwds: string[] = [];
    const timer = setTimeout(() => abort.abort(), Number(args[2] || 15000));
    process.stdout.write("STREAMING\n");
    await streamTerminal(handle, (e) => {
      if (e.type === "output") output += e.data;
      if (e.type === "meta") cwds.push(e.cwd);
      if (until.split("|").every((u) => output.includes(u))) abort.abort();
    }, abort.signal, 100).catch(() => null);
    clearTimeout(timer);
    out({ pid: process.pid, output, cwds });
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

main()
  .then(async () => {
    await db.$disconnect().catch(() => null);
    process.exit(0);
  })
  .catch(async (err) => {
    process.stdout.write(`RESULT ${JSON.stringify({ error: err.message })}\n`);
    await db.$disconnect().catch(() => null);
    process.exit(1);
  });
