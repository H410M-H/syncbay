/**
 * Deploy pipeline against a REAL Docker daemon (skipped when `docker info` fails or the base
 * image cannot be used). Each case builds a small Dockerfile app and deploys it:
 *
 *   port     the app hard-codes port 3000 while the service asks for another → detected, re-mapped
 *   slow     the app opens its port after 14 s → passes (the old 10 s limit failed it)
 *   crash    the app exits at startup → fails fast with the container's own output
 *   loopback the app binds 127.0.0.1 → fails with a hint to bind 0.0.0.0
 *   build    the image build fails → the error shows the END of the build output
 *   secrets  environment values reach the container but never the log
 *   volume   a file written by one deployment is read by the next
 *   database a co-located Postgres is reachable through the private address, also after a
 *            runner restart (registry rebuilt from Docker)
 *
 * Run: cd runner && npm run test:docker   (ports 46000-46099; base image via E2E_BASE_IMAGE)
 */

import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { PortManager } from "../src/port-manager.ts";
import { BuildPipeline, DefaultPipelineExecutor, type PipelineOptions } from "../src/pipeline.ts";
import { RunnerServices } from "../src/services.ts";

const BASE_IMAGE = process.env.E2E_BASE_IMAGE || "node:20-bookworm-slim";
const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8" });
const dockerOk = docker("info", "--format", "{{.ServerVersion}}").status === 0 && docker("image", "inspect", BASE_IMAGE).status === 0;
const skip = dockerOk ? false : `Docker or the ${BASE_IMAGE} image is not available`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docker-e2e-"));
const run = Date.now().toString(36);
const portManager = new PortManager({ rangeStart: 46000, rangeEnd: 46099 });
const pipeline = new BuildPipeline({ executor: new DefaultPipelineExecutor(), portManager });
const started: string[] = [];

/** Writes a one-file Node app plus a Dockerfile and returns its directory. */
function app(name: string, serverJs: string, dockerfileExtra = ""): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "server.js"), serverJs);
  fs.writeFileSync(path.join(dir, "Dockerfile"), `FROM ${BASE_IMAGE}\nWORKDIR /app\nCOPY server.js .\n${dockerfileExtra}CMD ["node", "server.js"]\n`);
  return dir;
}

async function deploy(name: string, dir: string, extra: Partial<PipelineOptions> = {}) {
  const logs: string[] = [];
  const result = await pipeline.execute({
    jobId: `${name}${run}`,
    deploymentId: `dep${name}${run}`,
    serviceId: `svc-${name}-${run}`,
    serviceName: `e2e-${name}`,
    workDir: dir,
    targetPort: 3000,
    onLog: (line) => logs.push(line),
    ...extra,
  });
  if (result.containerId) started.push(result.containerId);
  return { result, logs: logs.join("\n") };
}

const http200 = (port: string) => `require("http").createServer((q, s) => s.end("ok")).listen(${port}, "0.0.0.0");`;

test.after(async () => {
  for (const id of started) await pipeline.stopContainer(id).catch(() => null);
  for (const name of docker("ps", "-aq", "--filter", "name=syncbay-e2e-").stdout.split("\n").filter(Boolean)) docker("rm", "-f", name);
  docker("volume", "rm", "-f", `syncbay-vol-e2e${run}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test("port: an app that ignores PORT is found on its real port and re-mapped", { skip }, async () => {
  const dir = app("port", http200("3000"));
  // 10000 is what older engines stored as the service port (the previous host port).
  const { result, logs } = await deploy("port", dir, { targetPort: 10000 });
  assert.strictEqual(result.success, true, result.error);
  assert.strictEqual(result.containerPort, 3000, "the detected app port is reported");
  assert.match(logs, /listens on port 3000, not 10000/);
  const res = await fetch(`http://127.0.0.1:${result.assignedPort}/`);
  assert.strictEqual(await res.text(), "ok");
});

test("slow: an app that needs 14 s to open its port still deploys", { skip }, async () => {
  const dir = app("slow", `setTimeout(() => { ${http200("process.env.PORT")} }, 14000);`);
  const { result } = await deploy("slow", dir);
  assert.strictEqual(result.success, true, result.error);
  assert.ok(result.durationMs > 14000);
});

test("crash: a container that exits at startup fails fast with its own output", { skip }, async () => {
  const dir = app("crash", `console.error("FATAL: DATABASE_URL is not set"); process.exit(3);`);
  const startedAt = Date.now();
  // The pipeline starts containers with --restart unless-stopped, so Docker restarts a crashing
  // app; the pipeline still has to report the crash instead of waiting for the timeout.
  const { result } = await deploy("crash", dir, { healthCheckTimeoutMs: 40000 });
  assert.strictEqual(result.success, false);
  assert.match(result.error || "", /FATAL: DATABASE_URL is not set/);
  assert.ok(Date.now() - startedAt < 35000, "did not wait for the full health timeout");
});

test("loopback: an app bound to 127.0.0.1 fails with a hint to bind 0.0.0.0", { skip }, async () => {
  const dir = app("loop", `require("http").createServer((q, s) => s.end("ok")).listen(3000, "127.0.0.1");`);
  const { result } = await deploy("loop", dir, { healthCheckTimeoutMs: 12000 });
  assert.strictEqual(result.success, false);
  assert.match(result.error || "", /127\.0\.0\.1:3000/);
  assert.match(result.error || "", /0\.0\.0\.0/);
});

test("build: a failed image build reports the end of the output, not the start", { skip }, async () => {
  const noise = Array.from({ length: 400 }, (_, i) => `echo build-noise-line-${i}`).join(" && ");
  const dir = app("build", http200("3000"), `RUN ${noise} && echo THE-REAL-ERROR-IS-HERE && exit 7\n`);
  const { result } = await deploy("build", dir);
  assert.strictEqual(result.success, false);
  assert.match(result.error || "", /Docker build failed \(exit code \d+\)/);
  assert.match(result.error || "", /THE-REAL-ERROR-IS-HERE/);
  assert.ok((result.error || "").length < 6000, "the error is a tail, not the whole build log");
});

test("secrets: environment values reach the container but not the log", { skip }, async () => {
  const secret = `s3cr3t-${run}-$(touch ${root}/pwned)-"quoted"`;
  const dir = app("env", `require("http").createServer((q, s) => s.end(process.env.API_SECRET + "|" + process.env.MULTI)).listen(process.env.PORT, "0.0.0.0");`);
  const { result, logs } = await deploy("env", dir, { environmentVariables: { API_SECRET: secret, MULTI: "line1\nline2", "bad key": "x" } });
  assert.strictEqual(result.success, true, result.error);
  const body = await (await fetch(`http://127.0.0.1:${result.assignedPort}/`)).text();
  assert.strictEqual(body, `${secret}|line1\nline2`, "values arrive unmodified, including shell syntax and newlines");
  assert.ok(!logs.includes(`s3cr3t-${run}`), "the value is not written to the build log");
  assert.ok(!fs.existsSync(path.join(root, "pwned")), "shell syntax in a value is not executed on the runner");
});

test("volume: data written by one deployment is read by the next", { skip }, async () => {
  const volumes = [{ id: `e2e${run}`, name: "data", mountPath: "/data", sizeGb: 1 }];
  const server = `const fs = require("fs"); const f = "/data/counter"; const n = (fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) : 0) + 1; fs.writeFileSync(f, String(n)); require("http").createServer((q, s) => s.end(String(n))).listen(process.env.PORT, "0.0.0.0");`;
  const dir = app("vol", server);
  const first = await deploy("vol", dir, { volumes });
  assert.strictEqual(first.result.success, true, first.result.error);
  assert.strictEqual(await (await fetch(`http://127.0.0.1:${first.result.assignedPort}/`)).text(), "1");
  await pipeline.stopContainer(first.result.containerId!);
  const second = await deploy("vol2", dir, { volumes });
  assert.strictEqual(second.result.success, true, second.result.error);
  assert.strictEqual(await (await fetch(`http://127.0.0.1:${second.result.assignedPort}/`)).text(), "2", "the volume survived the redeploy");
});

test("database: a Postgres on this runner is reachable from an app through the private address", { skip: skip || (docker("image", "inspect", "postgres:16-alpine").status !== 0 ? "postgres:16-alpine is not available" : false) }, async () => {
  // 203.0.113.10 (TEST-NET-3) stands for the runner's public IP: unreachable from inside, as on a cloud host.
  const publicHost = "203.0.113.10";
  const dbId = `e2e${run}`;
  const services = new RunnerServices({ mode: "docker", dbHost: publicHost, portManager });
  const reply = await new Promise<{ status: number; body: any }>((resolve) => {
    const res: any = { writeHead: (status: number) => (res.status = status), end: (text: string) => resolve({ status: res.status, body: JSON.parse(text) }) };
    void services.handle({ method: "POST", headers: {} } as any, res, "/api/databases", JSON.stringify({ provider: "POSTGRES", id: dbId }), () => true);
  });
  try {
    assert.strictEqual(reply.status, 201, JSON.stringify(reply.body));
    const url: string = reply.body.connectionUrl;
    assert.ok(url.includes(`@${publicHost}:${reply.body.port}/`), "the stored URL carries the public address");

    // A new instance stands for the daemon after a restart: its registry is rebuilt from Docker.
    const restarted = new RunnerServices({ mode: "docker", dbHost: publicHost, portManager: new PortManager({ rangeStart: 46000, rangeEnd: 46099 }) });
    const rewritten = await restarted.rewriteEnv({ DATABASE_URL: url, OTHER: `https://${publicHost}:443/x` }, "docker");
    assert.ok(!rewritten.env.DATABASE_URL.includes(publicHost), "the URL no longer points at the public address");
    assert.strictEqual(rewritten.env.OTHER, `https://${publicHost}:443/x`, "other URLs are untouched");
    assert.match(rewritten.notes.join(" "), /DATABASE_URL/);
    assert.strictEqual((await restarted.rewriteEnv({ DATABASE_URL: url }, "process")).env.DATABASE_URL, url.replace(publicHost, "127.0.0.1"));

    // The app answers 200 only after it connected to the database address from its environment.
    const server = `const net = require("net"); const u = new URL(process.env.DATABASE_URL);
let ok = false; const tryConnect = () => { const s = net.connect(Number(u.port), u.hostname, () => { ok = true; s.end(); }); s.on("error", () => setTimeout(tryConnect, 500)); };
tryConnect();
require("http").createServer((q, r) => { r.statusCode = ok ? 200 : 503; r.end(u.hostname); }).listen(process.env.PORT, "0.0.0.0");`;
    const dir = app("db", server);
    const { result, logs } = await deploy("db", dir, {
      environmentVariables: { DATABASE_URL: url },
      rewriteEnv: (env, runtime) => restarted.rewriteEnv(env, runtime),
      healthCheckTimeoutMs: 60000,
    });
    assert.strictEqual(result.success, true, result.error);
    assert.match(logs, /private address/);
    let status = 0;
    for (let i = 0; i < 40 && status !== 200; i++) {
      status = (await fetch(`http://127.0.0.1:${result.assignedPort}/`)).status;
      if (status !== 200) await new Promise((r) => setTimeout(r, 500));
    }
    assert.strictEqual(status, 200, "the app reached the database over the private address");
  } finally {
    docker("rm", "-f", `syncbay-db-${dbId}`);
    docker("volume", "rm", "-f", `syncbay-db-${dbId}-data`);
  }
});
