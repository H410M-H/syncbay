/**
 * Verification: Web terminal sessions.
 *
 * 1. Fallback session (no runner): cwd persists across commands, export/echo/history work,
 *    secrets (isSecret values + URL credentials) are masked, sessions are owner-scoped.
 * 2. Runner session: real `sh` on a RunnerDaemon (mock DB mode) proxied over signed HTTP/SSE,
 *    with output masking applied on the control-plane side.
 */

import assert from "node:assert";
import {
  createTerminalSession,
  getTerminalSession,
  subscribeTerminal,
  writeTerminalInput,
  pipeRunnerTerminal,
  closeTerminalSession,
  maskTerminalOutput,
  type TerminalEvent,
} from "../src/lib/shell/terminal-sessions";
import { runnerJson } from "../src/lib/runner-client";

const variables = [
  { key: "API_KEY", value: "sk_live_abcdef123", isSecret: true },
  { key: "DATABASE_URL", value: "postgresql://postgres:hunter2pw@db.internal:5432/main", isSecret: false },
  { key: "PUBLIC_FLAG", value: "visible-value", isSecret: false },
];

async function runTests() {
  delete process.env.RUNNER_URL;

  console.log("[0] maskTerminalOutput");
  assert.strictEqual(
    maskTerminalOutput("url=redis://default:pa55word@host:6379 key=topsecret", ["topsecret"]),
    "url=redis://default:****@host:6379 key=••••••••"
  );
  console.log("  ✔ URL credentials and secret values masked");

  console.log("[1] Fallback session");
  const session = createTerminalSession({
    serviceId: "svc_1",
    userId: "user_1",
    serviceName: "api",
    containerId: "proc_api",
    variables,
  });
  assert.strictEqual(session.mode, "fallback");
  assert.ok(session.buffer.includes("SYNCBAY WEB SHELL"), "banner + prompt replayable from buffer");

  let transcript = "";
  let lastCwd = "";
  const unsubscribe = subscribeTerminal(session, (e: TerminalEvent) => {
    if (e.type === "output") transcript += e.data;
    if (e.type === "meta") lastCwd = e.cwd;
  });

  await writeTerminalInput(session, "cd src\n");
  await writeTerminalInput(session, "pwd\n");
  assert.ok(transcript.includes("/app/src\n"), "cd persists across commands");
  assert.strictEqual(lastCwd, "/app/src");
  assert.strictEqual(session.state.cwd, "/app/src");

  transcript = "";
  await writeTerminalInput(session, "env\n");
  assert.ok(transcript.includes("PUBLIC_FLAG=visible-value"), "non-secret values visible");
  assert.ok(!transcript.includes("sk_live_abcdef123"), "isSecret value masked");
  assert.ok(!transcript.includes("hunter2pw"), "URL password masked");
  assert.ok(transcript.includes("postgresql://postgres:****@db.internal:5432/main"));

  transcript = "";
  await writeTerminalInput(session, "echo $API_KEY\n");
  assert.ok(!transcript.includes("sk_live_abcdef123") && transcript.includes("••••••••"), "echo of secret masked");

  transcript = "";
  await writeTerminalInput(session, "export GREETING=hello-shell\necho ${GREETING}\n");
  assert.ok(transcript.includes("hello-shell\n"), "exported env persists in session");

  transcript = "";
  await writeTerminalInput(session, "history\n");
  assert.ok(transcript.includes("cd src") && transcript.includes("export GREETING=hello-shell"), "history recorded");

  assert.strictEqual(getTerminalSession(session.id, "user_2", "svc_1"), null, "other users cannot attach");
  assert.strictEqual(getTerminalSession(session.id, "user_1", "svc_other"), null, "session bound to its service");
  assert.ok(getTerminalSession(session.id, "user_1", "svc_1"));
  unsubscribe();
  await closeTerminalSession(session.id);
  assert.strictEqual(getTerminalSession(session.id, "user_1", "svc_1"), null);
  console.log("  ✔ cwd/env/history persist, secrets masked, owner-scoped, closable");

  console.log("[2] Runner session proxied over signed HTTP + SSE");
  const { RunnerDaemon } = await import("../runner/src/index");
  const { RunnerServices } = await import("../runner/src/services");
  const { PortManager } = await import("../runner/src/port-manager");
  const pm = new PortManager({ rangeStart: 38000, rangeEnd: 38050 });
  const daemon = new RunnerDaemon({
    port: 0,
    host: "127.0.0.1",
    webhookSecret: "terminal-secret",
    portManager: pm,
    services: new RunnerServices({ portManager: pm, mode: "mock" }),
  });
  const port = await daemon.start();
  process.env.RUNNER_URL = `http://127.0.0.1:${port}`;
  process.env.RUNNER_SECRET = "terminal-secret";
  const abort = new AbortController();
  try {
    const env: Record<string, string> = {};
    for (const v of variables) env[v.key] = v.value;
    const created = await runnerJson<{ sessionId: string }>("/api/terminals", { method: "POST", body: { env } });
    const runnerSession = createTerminalSession({
      serviceId: "svc_1",
      userId: "user_1",
      serviceName: "api",
      containerId: "proc_api",
      variables,
      runnerSessionId: created.sessionId,
    });
    assert.strictEqual(runnerSession.mode, "runner");

    let out = "";
    const piping = pipeRunnerTerminal(runnerSession, (e) => {
      if (e.type === "output") out += e.data;
    }, abort.signal).catch(() => null);

    await writeTerminalInput(runnerSession, 'echo "marker-$((6*7)) $API_KEY $DATABASE_URL"\n');
    const deadline = Date.now() + 8000;
    while (!out.includes("marker-42") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(out.includes("marker-42"), `runner shell output relayed, got ${JSON.stringify(out)}`);
    assert.ok(!out.includes("sk_live_abcdef123") && !out.includes("hunter2pw"), "runner output masked");
    await closeTerminalSession(runnerSession.id);
    abort.abort();
    await piping;
    console.log("  ✔ real shell output streamed through the proxy with secrets masked");
  } finally {
    abort.abort();
    delete process.env.RUNNER_URL;
    delete process.env.RUNNER_SECRET;
    await daemon.stop();
  }

  console.log("\nAll web terminal verifications passed.");
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n✖ Web terminal verification failed:", err);
    process.exit(1);
  });
