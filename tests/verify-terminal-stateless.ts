/**
 * Verification: the web terminal survives being served by different control-plane instances.
 *
 * Real infrastructure, no mocks:
 * - Postgres (DATABASE_URL, e.g. postgresql://syncbay:syncbay@localhost:5432/sb_c) for the
 *   TerminalSession rows of the simulated shell;
 * - a real runner daemon (`node runner/src/index.ts`) in its own process;
 * - a real Docker container the runner shell `docker exec`s into;
 * - every "instance" is a separate Node process (tests/harness/terminal-instance.ts) with its
 *   own module graph and Prisma client: create on instance A, input on B/C, stream on D.
 *
 * Usage: DATABASE_URL=… npm run test:terminal-stateless   (ports 43100-43199)
 */

import assert from "node:assert";
import crypto from "node:crypto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const TSX = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");
const INSTANCE = path.join(ROOT, "tests/harness/terminal-instance.ts");
const RUNNER_PORT = 43110;
const RUNNER_SECRET = crypto.randomBytes(24).toString("hex");
const TERMINAL_TOKEN_SECRET = crypto.randomBytes(24).toString("hex");
const CONTAINER = `sbc-term-${crypto.randomBytes(4).toString("hex")}`;

const baseEnv = {
  ...process.env,
  RUNNER_URL: `http://127.0.0.1:${RUNNER_PORT}`,
  RUNNER_SECRET,
  TERMINAL_TOKEN_SECRET,
  NODE_ENV: "test",
};

const variables = [
  { key: "API_KEY", value: "sk_live_stateless_987", isSecret: true },
  { key: "PUBLIC_FLAG", value: "visible-value", isSecret: false },
];

interface InstanceRun {
  pid: number;
  result: any;
}

function instance(args: string[], env: NodeJS.ProcessEnv = baseEnv, onStreaming?: () => void): Promise<InstanceRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX, INSTANCE, ...args], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
      if (onStreaming && stdout.includes("STREAMING\n")) {
        const cb = onStreaming;
        onStreaming = undefined;
        cb();
      }
    });
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("exit", () => {
      const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
      if (!line) return reject(new Error(`instance ${args[0]} produced no result: ${stderr.slice(-800)}`));
      const result = JSON.parse(line.slice(7));
      if (result.error) return reject(new Error(`instance ${args[0]} failed: ${result.error}`));
      resolve({ pid: child.pid!, result });
    });
  });
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL (real Postgres) is required");
  const pids = new Set<number>();
  let runner: ChildProcess | null = null;

  try {
    console.log("[setup] real Docker container + runner daemon process");
    execFileSync("docker", ["run", "-d", "--rm", "--name", CONTAINER, "redis:7-alpine"], { stdio: "pipe" });
    runner = spawn(process.execPath, [path.join(ROOT, "runner/src/index.ts")], {
      cwd: path.join(ROOT, "runner"),
      env: { ...process.env, RUNNER_PORT: String(RUNNER_PORT), RUNNER_HOST: "127.0.0.1", RUNNER_SECRET, TUNNEL_DRIVER: "local" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitFor(async () => (await fetch(`http://127.0.0.1:${RUNNER_PORT}/health`)).ok, 15000, "runner /health");
    console.log(`  ✔ container ${CONTAINER} running, runner daemon pid ${runner.pid} on :${RUNNER_PORT}`);

    const ctx = {
      serviceId: `svc_${crypto.randomBytes(4).toString("hex")}`,
      userId: "user_stateless",
      serviceName: "api",
      containerId: CONTAINER,
      variables,
    };
    const ctxJson = JSON.stringify(ctx);

    // ── 1. Runner-backed shell ────────────────────────────────────────────────
    console.log("[1] runner shell: create on A, stream on D, input on B");
    const a = await instance(["create", ctxJson, "runner"]);
    pids.add(a.pid);
    assert.strictEqual(a.result.mode, "runner");
    const runnerToken: string = a.result.sessionId;

    let streamStarted!: () => void;
    const started = new Promise<void>((r) => (streamStarted = r));
    const streamD = instance(["stream", ctxJson, runnerToken, "marker-42|Alpine", "20000"], baseEnv, () => streamStarted());
    await started;
    await new Promise((r) => setTimeout(r, 500));
    const b = await instance(["input", ctxJson, runnerToken, 'echo "marker-$((6*7)) $API_KEY"; grep PRETTY /etc/os-release\n']);
    const d = await streamD;
    pids.add(b.pid).add(d.pid);
    assert.ok(d.result.output.includes("marker-42"), `stream on D relays output of input sent via B: ${JSON.stringify(d.result.output.slice(-300))}`);
    assert.ok(d.result.output.includes("Alpine"), "shell runs inside the Docker container (Alpine os-release)");
    assert.ok(!d.result.output.includes("sk_live_stateless_987"), "secret masked by the streaming instance");
    console.log("  ✔ real container shell output streamed across processes, secret masked");

    // ── 2. Simulated shell (TerminalSession row) ─────────────────────────────
    console.log("[2] simulated shell: create on A, input on B and C, stream on D");
    const fa = await instance(["create", ctxJson]);
    assert.strictEqual(fa.result.mode, "fallback");
    const fbToken: string = fa.result.sessionId;

    let fbStarted!: () => void;
    const fbReady = new Promise<void>((r) => (fbStarted = r));
    const fbStream = instance(["stream", ctxJson, fbToken, "/app/src\n|from-instance-b", "20000"], baseEnv, () => fbStarted());
    await fbReady;
    const fb = await instance(["input", ctxJson, fbToken, "cd src\nexport GREETING=from-instance-b\n"]);
    assert.strictEqual(fb.result.cwd, "/app/src");
    const fc = await instance(["input", ctxJson, fbToken, "pwd\necho $GREETING $API_KEY\n"]);
    const fd = await fbStream;
    pids.add(fa.pid).add(fb.pid).add(fc.pid).add(fd.pid);
    assert.strictEqual(fc.result.cwd, "/app/src", "cwd set on B is visible to C");
    assert.ok(fd.result.output.includes("/app/src\n"), "pwd on C ran in the cwd set on B");
    assert.ok(fd.result.output.includes("from-instance-b"), "export on B visible to C");
    assert.ok(!fd.result.output.includes("sk_live_stateless_987"), "secret masked");
    assert.ok(fd.result.cwds.includes("/app/src"), "stream on D received the cwd change");
    console.log("  ✔ cwd/env/history shared through Postgres; stream follows writes from other processes");

    // Row contents straight from Postgres via a fresh Prisma client in this process
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();
    const sid = JSON.parse(Buffer.from(fbToken.split(".")[1], "base64url").toString()).sid;
    const row = await prisma.terminalSession.findUnique({ where: { id: sid } });
    assert.ok(row && row.cwd === "/app/src" && row.version === 2, "row updated twice (B then C)");
    assert.ok(!JSON.stringify(row).includes("sk_live_stateless_987"), "row never stores secret values");

    // ── 3. Token checks across instances ─────────────────────────────────────
    console.log("[3] token binding");
    const other = await instance(["open", JSON.stringify({ ...ctx, userId: "intruder" }), fbToken]);
    assert.strictEqual(other.result.ok, false, "token bound to its user");
    const otherSvc = await instance(["open", JSON.stringify({ ...ctx, serviceId: "svc_other" }), fbToken]);
    assert.strictEqual(otherSvc.result.ok, false, "token bound to its service");
    const wrongKey = await instance(["open", ctxJson, fbToken], { ...baseEnv, TERMINAL_TOKEN_SECRET: "different-secret" });
    assert.strictEqual(wrongKey.result.ok, false, "instance with another TERMINAL_TOKEN_SECRET rejects the token");
    const prod = await instance(["open", ctxJson, fbToken], { ...baseEnv, NODE_ENV: "production", TERMINAL_TOKEN_SECRET: "" }).catch((e) => e);
    assert.ok(prod instanceof Error && /TERMINAL_TOKEN_SECRET/.test(prod.message), "production without TERMINAL_TOKEN_SECRET fails closed");
    console.log("  ✔ user/service binding, secret mismatch and production fail-closed");

    // ── 4. Close from yet another instance ───────────────────────────────────
    await instance(["close", ctxJson, fbToken]);
    await instance(["close", ctxJson, runnerToken]);
    assert.strictEqual((await instance(["open", ctxJson, fbToken])).result.ok, false, "closed simulated session is gone everywhere");
    assert.strictEqual(await prisma.terminalSession.count({ where: { id: sid } }), 0);
    await prisma.$disconnect();

    // ── 5. Signed runner requests are single-use against the real daemon ────
    console.log("[4] runner nonce replay");
    const { signRequest } = await import("../src/lib/orchestrator/runner-driver");
    const healthPath = "/api/terminals/term_missing/stream";
    const signed = signRequest(RUNNER_SECRET, "GET", healthPath, healthPath);
    const first = await fetch(`http://127.0.0.1:${RUNNER_PORT}${healthPath}`, { headers: signed.headers });
    const replay = await fetch(`http://127.0.0.1:${RUNNER_PORT}${healthPath}`, { headers: signed.headers });
    assert.strictEqual(first.status, 404, "authentic GET reaches the route");
    assert.strictEqual(replay.status, 401, "replayed GET rejected");
    console.log("  ✔ replayed signed GET rejected by the daemon process");

    console.log(`\nAll stateless terminal verifications passed (instance pids: ${[...pids].join(", ")}).`);
  } finally {
    runner?.kill("SIGTERM");
    try {
      execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "pipe" });
    } catch {}
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n✖ Stateless terminal verification failed:", err);
    process.exit(1);
  });
