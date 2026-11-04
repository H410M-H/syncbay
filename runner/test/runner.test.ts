/**
 * Standalone Runner Agent Unit Test Suite
 */

import assert from "node:assert";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { PortManager } from "../src/port-manager";
import { BuildPipeline, MockPipelineExecutor } from "../src/pipeline";
import { RunnerDaemon } from "../src/index";

test("PortManager: dynamic allocation, reservation, and collision detection", async () => {
  const pm = new PortManager({ rangeStart: 30000, rangeEnd: 30050 });

  const portA = await pm.allocatePort("svc_web", "job_1");
  const portB = await pm.allocatePort("svc_api", "job_2");

  assert.ok(portA >= 30000 && portA <= 30050);
  assert.ok(portB >= 30000 && portB <= 30050);
  assert.notStrictEqual(portA, portB);

  assert.strictEqual(pm.isPortAllocated(portA), true);
  assert.strictEqual(pm.isPortAllocated(portB), true);

  const released = pm.releasePort(portA);
  assert.strictEqual(released, true);
  assert.strictEqual(pm.isPortAllocated(portA), false);
});

test("BuildPipeline: automated build and run lifecycle", async () => {
  const mockExecutor = new MockPipelineExecutor();
  const pm = new PortManager({ rangeStart: 31000, rangeEnd: 31050 });
  const pipeline = new BuildPipeline({ executor: mockExecutor, portManager: pm });

  const result = await pipeline.execute({
    jobId: "test_job_1",
    serviceName: "microservice",
    targetPort: 4000,
    environmentVariables: { APP_ENV: "test" },
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.strategy, "nixpacks");
  assert.ok(result.assignedPort! >= 31000);
  assert.ok(mockExecutor.commands.some((c) => c.includes("docker run")));
});

test("RunnerDaemon: HTTP dispatch, HMAC authentication, health check", async () => {
  const secret = "daemon-test-key";
  const pm = new PortManager({ rangeStart: 32000, rangeEnd: 32050 });
  const mockExecutor = new MockPipelineExecutor();
  const pipeline = new BuildPipeline({ executor: mockExecutor, portManager: pm });

  const daemon = new RunnerDaemon({
    port: 0,
    webhookSecret: secret,
    portManager: pm,
    pipeline,
  });

  const port = await daemon.start();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Health check
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.strictEqual(healthRes.status, 200);
    const healthData = await healthRes.json();
    assert.strictEqual(healthData.status, "ok");

    // 2. Reject unauthenticated request
    const unauthRes = await fetch(`${baseUrl}/api/builds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "test" }),
    });
    assert.strictEqual(unauthRes.status, 401);
  } finally {
    await daemon.stop();
  }
});

test("BuildPipeline: native process execution and clean shutdown", async () => {
  const pm = new PortManager({ rangeStart: 33000, rangeEnd: 33050 });
  const pipeline = new BuildPipeline({ portManager: pm });

  const result = await pipeline.execute({
    jobId: "native_test_job",
    serviceName: "native-demo",
    targetPort: 33000,
  });

  if (!result.success) {
    console.error(result.error);
    console.error(result.logs);
  }
  assert.strictEqual(result.success, true);
  assert.ok(result.assignedPort! >= 33000);
  assert.ok(result.containerId?.startsWith("proc_"));

  // Probe the live running application
  const res = await fetch(`http://127.0.0.1:${result.assignedPort}/health`);
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.status, "ok");

  // Cleanly stop process
  const stopRes = await pipeline.stopContainer(result.containerId!);
  assert.strictEqual(stopRes.stopped, true);
  assert.strictEqual(pm.isPortAllocated(result.assignedPort!), false);
});

test("BuildPipeline: failure enforcement when process fails to start", async () => {
  const pm = new PortManager({ rangeStart: 34000, rangeEnd: 34050 });
  const pipeline = new BuildPipeline({ portManager: pm });

  const result = await pipeline.execute({
    jobId: "failing_job",
    serviceName: "broken-app",
    startCommand: "node -e 'process.exit(1)'",
    targetPort: 34000,
    healthCheckTimeoutMs: 1500,
  });

  // MUST report failure, NOT success!
  assert.strictEqual(result.success, false);
  assert.ok(result.error);
});

// ─── Canonical HMAC signing (mirrors signRequest() in src/lib/orchestrator/runner-driver.ts) ───

function signCanonical(
  secret: string,
  method: string,
  path: string,
  body: string,
  ts = Date.now().toString(),
  nonce = crypto.randomBytes(16).toString("hex")
) {
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.${nonce}.${method}.${path}.${body}`).digest("hex");
  return { ts, sig, nonce, headers: { "X-Syncbay-Signature": `sha256=${sig}`, "X-Syncbay-Timestamp": ts, "X-Syncbay-Nonce": nonce } };
}

async function waitForJob(baseUrl: string, secret: string, jobId: string): Promise<any> {
  const path = `/api/builds/${encodeURIComponent(jobId)}`;
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`${baseUrl}${path}`, { headers: signCanonical(secret, "GET", path, jobId).headers });
    const data = await res.json();
    if (data.status && data.status !== "BUILDING" && data.status !== "QUEUED") return data;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`job ${jobId} did not finish`);
}

test("RunnerDaemon: canonical signatures, replay rejection, and exitCode surfacing", async () => {
  const secret = "replay-test-key";
  const pm = new PortManager({ rangeStart: 35000, rangeEnd: 35050 });
  const mockExecutor = new MockPipelineExecutor();
  mockExecutor.setHandler(/nixpacks build/, () => ({ stdout: "", stderr: "nixpacks: build step exploded", exitCode: 2 }));
  const pipeline = new BuildPipeline({ executor: mockExecutor, portManager: pm });
  const daemon = new RunnerDaemon({ port: 0, host: "127.0.0.1", webhookSecret: secret, portManager: pm, pipeline });
  const port = await daemon.start();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const jobId = "job_exit_code";
    const body = JSON.stringify({ jobId, serviceName: "exit-demo" });

    // Legacy `${ts}.${body}` signatures are no longer accepted
    const ts = Date.now().toString();
    const legacySig = crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    const legacyRes = await fetch(`${baseUrl}/api/builds`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Syncbay-Signature": `sha256=${legacySig}`, "X-Syncbay-Timestamp": ts, "X-Syncbay-Nonce": crypto.randomBytes(16).toString("hex") },
      body,
    });
    assert.strictEqual(legacyRes.status, 401);

    // Valid canonical POST is accepted once ...
    const signed = signCanonical(secret, "POST", "/api/builds", body);
    const okRes = await fetch(`${baseUrl}/api/builds`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...signed.headers },
      body,
    });
    assert.strictEqual(okRes.status, 202);

    // ... and a byte-for-byte replay is rejected
    const replayRes = await fetch(`${baseUrl}/api/builds`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...signed.headers },
      body,
    });
    assert.strictEqual(replayRes.status, 401);

    // exitCode from the failing build step is surfaced on GET /api/builds/:id
    const job = await waitForJob(baseUrl, secret, jobId);
    assert.strictEqual(job.status, "FAILED");
    assert.strictEqual(job.exitCode, 2);
    assert.match(job.error, /Nixpacks build failed/);

    const statusPath = `/api/builds/${jobId}`;

    // Signatures over "" or the pathname (old fallbacks) are rejected
    for (const legacyBody of ["", statusPath]) {
      const t = Date.now().toString();
      const s = crypto.createHmac("sha256", secret).update(`${t}.${legacyBody}`).digest("hex");
      const r = await fetch(`${baseUrl}${statusPath}`, { headers: { "X-Syncbay-Signature": `sha256=${s}`, "X-Syncbay-Timestamp": t } });
      assert.strictEqual(r.status, 401, `legacy signature over "${legacyBody}" must be rejected`);
    }

    // A signature is bound to its path: one minted for another job does not authorize this one
    const other = signCanonical(secret, "GET", "/api/builds/other_job", "other_job");
    const crossRes = await fetch(`${baseUrl}${statusPath}`, { headers: other.headers });
    assert.strictEqual(crossRes.status, 401);

    // Query-string sig/ts is not accepted on the JSON status route ...
    const q = signCanonical(secret, "GET", statusPath, jobId);
    const queryStatus = await fetch(`${baseUrl}${statusPath}?sig=${q.sig}&ts=${q.ts}&nonce=${q.nonce}`);
    assert.strictEqual(queryStatus.status, 401);

    // ... only on the SSE log route, bound to that route's path
    const logsPath = `/api/builds/${jobId}/logs`;
    const ql = signCanonical(secret, "GET", logsPath, jobId);
    const nonSseQuery = await fetch(`${baseUrl}${logsPath}?sig=${ql.sig}&ts=${ql.ts}&nonce=${ql.nonce}`);
    assert.strictEqual(nonSseQuery.status, 401);
    const sseNoNonce = await fetch(`${baseUrl}${logsPath}?sig=${ql.sig}&ts=${ql.ts}`, { headers: { Accept: "text/event-stream" } });
    assert.strictEqual(sseNoNonce.status, 401, "query-string SSE requires the nonce");
    const sseRes = await fetch(`${baseUrl}${logsPath}?sig=${ql.sig}&ts=${ql.ts}&nonce=${ql.nonce}`, { headers: { Accept: "text/event-stream" } });
    assert.strictEqual(sseRes.status, 200);
    await sseRes.text();
    const sseReplay = await fetch(`${baseUrl}${logsPath}?sig=${ql.sig}&ts=${ql.ts}&nonce=${ql.nonce}`, { headers: { Accept: "text/event-stream" } });
    assert.strictEqual(sseReplay.status, 401, "query-string SSE nonce is single-use");
    const sseWrongPath = await fetch(`${baseUrl}${logsPath}?sig=${q.sig}&ts=${q.ts}&nonce=${q.nonce}`, { headers: { Accept: "text/event-stream" } });
    assert.strictEqual(sseWrongPath.status, 401);

    // GETs are single-use too: replaying a signed status request is rejected ...
    const getSigned = signCanonical(secret, "GET", statusPath, jobId);
    assert.strictEqual((await fetch(`${baseUrl}${statusPath}`, { headers: getSigned.headers })).status, 200);
    assert.strictEqual((await fetch(`${baseUrl}${statusPath}`, { headers: getSigned.headers })).status, 401, "GET replay rejected");
    // ... a missing nonce is rejected ...
    const { "X-Syncbay-Nonce": _dropped, ...noNonce } = signCanonical(secret, "GET", statusPath, jobId).headers;
    assert.strictEqual((await fetch(`${baseUrl}${statusPath}`, { headers: noNonce })).status, 401, "nonce required");
    // ... a nonce cannot be swapped without re-signing ...
    const swapped = { ...signCanonical(secret, "GET", statusPath, jobId).headers, "X-Syncbay-Nonce": crypto.randomBytes(16).toString("hex") };
    assert.strictEqual((await fetch(`${baseUrl}${statusPath}`, { headers: swapped })).status, 401, "nonce is signed");
    // ... and two requests signed in the same millisecond no longer collide
    const sameTs = Date.now().toString();
    const a = signCanonical(secret, "GET", statusPath, jobId, sameTs);
    const b = signCanonical(secret, "GET", statusPath, jobId, sameTs);
    assert.strictEqual((await fetch(`${baseUrl}${statusPath}`, { headers: a.headers })).status, 200);
    assert.strictEqual((await fetch(`${baseUrl}${statusPath}`, { headers: b.headers })).status, 200, "same-ms requests both accepted");
  } finally {
    await daemon.stop();
  }
});

test("RunnerServices: /api/databases mock mode provision, health, delete with HMAC", async () => {
  const { createHmac, randomBytes } = await import("node:crypto");
  const { RunnerServices } = await import("../src/services");
  const secret = "services-test-key";
  const pm = new PortManager({ rangeStart: 35000, rangeEnd: 35050 });
  const daemon = new RunnerDaemon({
    port: 0,
    webhookSecret: secret,
    portManager: pm,
    pipeline: new BuildPipeline({ executor: new MockPipelineExecutor(), portManager: pm }),
    services: new RunnerServices({ portManager: pm, mode: "mock", dbHost: "10.0.0.5" }),
  });
  const port = await daemon.start();
  const baseUrl = `http://127.0.0.1:${port}`;
  // Canonical `${ts}.${nonce}.${METHOD}.${path}.${payload}`; GET/DELETE sign the pathname as payload.
  const signFor = (method: string, path: string, payload: string) => {
    const ts = Date.now().toString();
    const nonce = randomBytes(16).toString("hex");
    const sig = createHmac("sha256", secret).update(`${ts}.${nonce}.${method}.${path}.${payload}`).digest("hex");
    return { "X-Syncbay-Signature": `sha256=${sig}`, "X-Syncbay-Timestamp": ts, "X-Syncbay-Nonce": nonce };
  };

  try {
    // Unsigned request rejected
    const unauth = await fetch(`${baseUrl}/api/databases`, { method: "POST", body: "{}" });
    assert.strictEqual(unauth.status, 401);

    // Provision (mock)
    const body = JSON.stringify({ id: "dbtest1", name: "main", provider: "POSTGRES" });
    const created = await fetch(`${baseUrl}/api/databases`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...signFor("POST", "/api/databases", body) },
      body,
    });
    assert.strictEqual(created.status, 201);
    const db = await created.json();
    assert.strictEqual(db.mode, "mock");
    assert.ok(db.containerId.startsWith("mock-"));
    assert.ok(db.port >= 35000 && db.port <= 35050);
    assert.ok(pm.isPortAllocated(db.port));
    assert.match(db.connectionUrl, /^postgresql:\/\/postgres:[^@]+@10\.0\.0\.5:\d+\/main$/);

    // Redis provisioning yields redis:// URL
    const redisBody = JSON.stringify({ id: "cache1", provider: "REDIS" });
    const redis = await (await fetch(`${baseUrl}/api/databases`, { method: "POST", headers: signFor("POST", "/api/databases", redisBody), body: redisBody })).json();
    assert.match(redis.connectionUrl, /^redis:\/\/default:/);

    // Unsupported provider
    const badBody = JSON.stringify({ provider: "MONGO" });
    const bad = await fetch(`${baseUrl}/api/databases`, { method: "POST", headers: signFor("POST", "/api/databases", badBody), body: badBody });
    assert.strictEqual(bad.status, 400);

    // Health (GET signs the pathname)
    const healthPath = "/api/databases/dbtest1/health";
    const health = await fetch(`${baseUrl}${healthPath}`, { headers: signFor("GET", healthPath, healthPath) });
    assert.strictEqual(health.status, 200);
    const healthData = await health.json();
    assert.strictEqual(healthData.healthy, true);

    // Health with wrong signature payload rejected
    const forged = await fetch(`${baseUrl}${healthPath}`, { headers: signFor("GET", healthPath, "/api/other") });
    assert.strictEqual(forged.status, 401);

    // Delete releases the port
    const delPath = "/api/databases/dbtest1";
    const del = await fetch(`${baseUrl}${delPath}`, { method: "DELETE", headers: signFor("DELETE", delPath, delPath) });
    assert.strictEqual(del.status, 200);
    assert.strictEqual((await del.json()).deleted, true);
    assert.strictEqual(pm.isPortAllocated(db.port), false);
  } finally {
    await daemon.stop();
  }
});

test("BuildPipeline: startup crash keeps the last 25 stderr lines and the exit code", async () => {
  const pm = new PortManager({ rangeStart: 36000, rangeEnd: 36050 });
  const pipeline = new BuildPipeline({ portManager: pm });

  const result = await pipeline.execute({
    jobId: "ring_buffer_job",
    serviceName: "crashy-app",
    startCommand: `node -e "for (let i = 0; i < 40; i++) console.error('L' + String(i).padStart(2, '0')); process.exit(3)"`,
    targetPort: 36000,
    healthCheckTimeoutMs: 5000,
  });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.exitCode, 3);
  const error = result.error || "";
  const kept = Array.from({ length: 40 }, (_, i) => `L${String(i).padStart(2, "0")}`).filter((l) => error.includes(l));
  assert.strictEqual(kept.length, 25, `expected 25 trailing lines, got ${kept.length}: ${error}`);
  assert.ok(error.includes("L39") && error.includes("L15") && !error.includes("L14"));
  assert.match(error, /exit code 3/);
});

test("BuildPipeline: fast redeploy reuses the clone; clean rebuild re-clones with --no-cache", async () => {
  const pm = new PortManager({ rangeStart: 37000, rangeEnd: 37050 });
  const workDir = path.join(os.tmpdir(), `syncbay-fast-redeploy-${process.pid}`);

  const fastExec = new MockPipelineExecutor();
  fastExec.mockedFiles.add(path.join(workDir, ".git"));
  const fast = await new BuildPipeline({ executor: fastExec, portManager: pm }).execute({
    jobId: "fast_job",
    repoUrl: "https://github.com/syncbay/example.git",
    branch: "main",
    workDir,
    cleanBuild: false,
  });
  assert.strictEqual(fast.success, true, fast.error);
  assert.strictEqual(fast.exitCode, 0);
  assert.ok(fastExec.commands.some((c) => c.includes("git fetch --prune origin")));
  assert.ok(!fastExec.commands.some((c) => c.includes("git clone")));

  const cleanExec = new MockPipelineExecutor();
  cleanExec.mockedFiles.add(path.join(workDir, ".git"));
  const clean = await new BuildPipeline({ executor: cleanExec, portManager: pm }).execute({
    jobId: "clean_job",
    repoUrl: "https://github.com/syncbay/example.git",
    workDir,
    cleanBuild: true,
  });
  assert.strictEqual(clean.success, true, clean.error);
  assert.ok(cleanExec.commands.some((c) => c.includes("git clone")));
  assert.ok(cleanExec.commands.some((c) => c.includes("nixpacks build") && c.includes("--no-cache")));
  await fs.rm(workDir, { recursive: true, force: true });
});

test("BuildPipeline: RUNNER_DRIVER=mock selects MockPipelineExecutor", () => {
  const prev = process.env.RUNNER_DRIVER;
  process.env.RUNNER_DRIVER = "mock";
  try {
    const pipeline = new BuildPipeline();
    assert.ok((pipeline as any).executor instanceof MockPipelineExecutor);
  } finally {
    if (prev === undefined) delete process.env.RUNNER_DRIVER;
    else process.env.RUNNER_DRIVER = prev;
  }
});

test("RunnerServices: /api/terminals process session streams command output over SSE", async () => {
  const { createHmac, randomBytes } = await import("node:crypto");
  const { RunnerServices } = await import("../src/services");
  const secret = "terminal-test-key";
  const pm = new PortManager({ rangeStart: 36000, rangeEnd: 36050 });
  const daemon = new RunnerDaemon({
    port: 0,
    webhookSecret: secret,
    portManager: pm,
    pipeline: new BuildPipeline({ executor: new MockPipelineExecutor(), portManager: pm }),
    services: new RunnerServices({ portManager: pm, mode: "mock" }),
  });
  const port = await daemon.start();
  const baseUrl = `http://127.0.0.1:${port}`;
  // Canonical `${ts}.${nonce}.${METHOD}.${path}.${payload}`; GET/DELETE sign the pathname as payload.
  const signFor = (method: string, path: string, payload: string) => {
    const ts = Date.now().toString();
    const nonce = randomBytes(16).toString("hex");
    const sig = createHmac("sha256", secret).update(`${ts}.${nonce}.${method}.${path}.${payload}`).digest("hex");
    return { "X-Syncbay-Signature": `sha256=${sig}`, "X-Syncbay-Timestamp": ts, "X-Syncbay-Nonce": nonce };
  };

  try {
    const createBody = JSON.stringify({ env: { GREETING: "hi" } });
    const created = await fetch(`${baseUrl}/api/terminals`, { method: "POST", headers: signFor("POST", "/api/terminals", createBody), body: createBody });
    assert.strictEqual(created.status, 201);
    const { sessionId, mode } = await created.json();
    assert.strictEqual(mode, "process");

    const streamPath = `/api/terminals/${sessionId}/stream`;
    const controller = new AbortController();
    const stream = await fetch(`${baseUrl}${streamPath}`, { headers: signFor("GET", streamPath, streamPath), signal: controller.signal });
    assert.strictEqual(stream.status, 200);
    assert.match(stream.headers.get("content-type") || "", /text\/event-stream/);

    const inputBody = JSON.stringify({ input: "echo term-$((40+2))\n" });
    const input = await fetch(`${baseUrl}/api/terminals/${sessionId}/input`, { method: "POST", headers: signFor("POST", `/api/terminals/${sessionId}/input`, inputBody), body: inputBody });
    assert.strictEqual(input.status, 200);

    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let transcript = "";
    const deadline = Date.now() + 8000;
    while (!transcript.includes("term-42") && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), 8000)),
      ]);
      if (chunk.done) break;
      for (const line of decoder.decode(chunk.value).split("\n")) {
        if (line.startsWith("data: ")) transcript += JSON.parse(line.slice(6)).data || "";
      }
    }
    controller.abort();
    assert.ok(transcript.includes("term-42"), `expected command output in transcript, got: ${JSON.stringify(transcript)}`);

    const delPath = `/api/terminals/${sessionId}`;
    const del = await fetch(`${baseUrl}${delPath}`, { method: "DELETE", headers: signFor("DELETE", delPath, delPath) });
    assert.strictEqual(del.status, 200);
  } finally {
    await daemon.stop();
  }
});

test("NonceCache: single-use within the window, expires with the timestamp, bounded", async () => {
  const { NonceCache, SIGNATURE_TOLERANCE_MS } = await import("../src/request-auth.ts");
  const cache = new NonceCache(3);
  const now = Date.now();
  assert.strictEqual(cache.consume("a".repeat(32), now, now), true);
  assert.strictEqual(cache.consume("A".repeat(32), now, now), false, "case-insensitive replay rejected");
  // Once the request timestamp is outside the window the entry is swept (the ts check rejects it anyway)
  assert.strictEqual(cache.consume("b".repeat(32), now, now + SIGNATURE_TOLERANCE_MS + 1), true);
  assert.strictEqual(cache.size, 1);
  for (const c of ["c", "d", "e"]) cache.consume(c.repeat(32), now + SIGNATURE_TOLERANCE_MS, now + SIGNATURE_TOLERANCE_MS + 1);
  assert.strictEqual(cache.size, 3, "bounded to maxEntries");
});
