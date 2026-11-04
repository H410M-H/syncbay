/**
 * Verification: Web terminal sessions.
 *
 * 1. Fallback session (no runner, mocked prisma.terminalSession): cwd persists across
 *    commands, export/echo/history work, secrets (isSecret values + URL credentials) are
 *    masked, signed session tokens are owner/service-scoped and tamper-proof.
 * 2. Runner session: real `sh` on a RunnerDaemon (mock DB mode) proxied over signed HTTP/SSE,
 *    with output masking applied on the control-plane side.
 */

import assert from "node:assert";
import { createMockTerminalSessionDelegate } from "./harness/mock-terminal-store";

const terminalStore = createMockTerminalSessionDelegate();
(globalThis as any).prisma = { terminalSession: terminalStore };

const variables = [
  { key: "API_KEY", value: "sk_live_abcdef123", isSecret: true },
  { key: "DATABASE_URL", value: "postgresql://postgres:hunter2pw@db.internal:5432/main", isSecret: false },
  { key: "PUBLIC_FLAG", value: "visible-value", isSecret: false },
];

const context = { serviceId: "svc_1", userId: "user_1", serviceName: "api", containerId: "proc_api", variables };

async function runTests() {
  delete process.env.RUNNER_URL;
  const {
    createTerminalSession,
    openTerminalSession,
    streamTerminal,
    writeTerminalInput,
    closeTerminalSession,
    maskTerminalOutput,
  } = await import("../src/lib/shell/terminal-sessions");
  const { runnerJson } = await import("../src/lib/runner-client");
  type TerminalEvent = import("../src/lib/shell/terminal-sessions").TerminalEvent;

  console.log("[0] maskTerminalOutput");
  assert.strictEqual(
    maskTerminalOutput("url=redis://default:pa55word@host:6379 key=topsecret", ["topsecret"]),
    "url=redis://default:****@host:6379 key=••••••••"
  );
  console.log("  ✔ URL credentials and secret values masked");

  console.log("[1] Fallback session");
  const created = await createTerminalSession(context);
  assert.strictEqual(created.mode, "fallback");
  assert.match(created.sessionId, /^sbt1\./, "sessionId is a signed token");
  const session = await openTerminalSession(created.sessionId, context);
  assert.ok(session);

  let transcript = "";
  let lastCwd = "";
  const abort = new AbortController();
  const streaming = streamTerminal(session!, (e: TerminalEvent) => {
    if (e.type === "output") transcript += e.data;
    if (e.type === "meta") lastCwd = e.cwd;
  }, abort.signal, 20);
  const settle = async (pred: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  };
  await settle(() => transcript.includes("SYNCBAY WEB SHELL"));
  assert.ok(transcript.includes("SYNCBAY WEB SHELL"), "banner + prompt replayed from the stored buffer");

  const run = async (input: string, until: string) => {
    transcript = "";
    await writeTerminalInput(session!, input);
    await settle(() => transcript.includes(until));
  };

  await run("cd src\n", "cd src");
  await run("pwd\n", "/app/src\n");
  assert.ok(transcript.includes("/app/src\n"), "cd persists across commands");
  await settle(() => lastCwd === "/app/src");
  assert.strictEqual(lastCwd, "/app/src", "meta event carries the new cwd");

  await run("env\n", "PUBLIC_FLAG");
  assert.ok(transcript.includes("PUBLIC_FLAG=visible-value"), "non-secret values visible");
  assert.ok(!transcript.includes("sk_live_abcdef123"), "isSecret value masked");
  assert.ok(!transcript.includes("hunter2pw"), "URL password masked");
  assert.ok(transcript.includes("postgresql://postgres:****@db.internal:5432/main"));

  await run("echo $API_KEY\n", "••••••••");
  assert.ok(!transcript.includes("sk_live_abcdef123") && transcript.includes("••••••••"), "echo of secret masked");

  await run("export GREETING=hello-shell\necho ${GREETING}\n", "hello-shell\n");
  assert.ok(transcript.includes("hello-shell\n"), "exported env persists in session");

  await run("history\n", "export GREETING");
  assert.ok(transcript.includes("cd src") && transcript.includes("export GREETING=hello-shell"), "history recorded");

  const row = [...terminalStore.rows.values()][0];
  assert.ok(!JSON.stringify(row).includes("sk_live_abcdef123"), "stored row never contains secret values");
  assert.deepStrictEqual(row.envOverrides, { GREETING: "hello-shell" }, "only user overrides are stored");

  assert.strictEqual(await openTerminalSession(created.sessionId, { ...context, userId: "user_2" }), null, "other users cannot attach");
  assert.strictEqual(await openTerminalSession(created.sessionId, { ...context, serviceId: "svc_other" }), null, "session bound to its service");
  const forged = created.sessionId.slice(0, -2) + (created.sessionId.endsWith("A") ? "BB" : "AA");
  assert.strictEqual(await openTerminalSession(forged, context), null, "tampered token rejected");
  abort.abort();
  await streaming;
  await closeTerminalSession(session!);
  assert.strictEqual(await openTerminalSession(created.sessionId, context), null, "closed session gone");
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
  const runnerAbort = new AbortController();
  try {
    const env: Record<string, string> = {};
    for (const v of variables) env[v.key] = v.value;
    const runnerCreated = await runnerJson<{ sessionId: string }>("/api/terminals", { method: "POST", body: { env } });
    const token = await createTerminalSession({ ...context, runnerSessionId: runnerCreated.sessionId });
    assert.strictEqual(token.mode, "runner");
    const runnerSession = (await openTerminalSession(token.sessionId, context))!;
    assert.ok(runnerSession);

    let out = "";
    const piping = streamTerminal(runnerSession, (e) => {
      if (e.type === "output") out += e.data;
    }, runnerAbort.signal).catch(() => null);

    await writeTerminalInput(runnerSession, 'echo "marker-$((6*7)) $API_KEY $DATABASE_URL"\n');
    const deadline = Date.now() + 8000;
    while (!out.includes("marker-42") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(out.includes("marker-42"), `runner shell output relayed, got ${JSON.stringify(out)}`);
    assert.ok(!out.includes("sk_live_abcdef123") && !out.includes("hunter2pw"), "runner output masked");
    await closeTerminalSession(runnerSession);
    runnerAbort.abort();
    await piping;
    console.log("  ✔ real shell output streamed through the proxy with secrets masked");
  } finally {
    runnerAbort.abort();
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
