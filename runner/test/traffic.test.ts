/**
 * Runner traffic counters (runner/src/traffic.ts) and POST /api/traffic/drain.
 * The daemon proxies real HTTP to a real local app server; nothing here is mocked except the
 * build executor of the identity-mapping case (MockPipelineExecutor, no process on that port).
 */

import assert from "node:assert";
import * as crypto from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { PortManager } from "../src/port-manager.ts";
import { BuildPipeline, MockPipelineExecutor } from "../src/pipeline.ts";
import { RunnerDaemon } from "../src/index.ts";
import {
  TrafficStats,
  getDefaultTrafficStats,
  identityForPort,
  latencyBucket,
  statusClass,
} from "../src/traffic.ts";

function signed(secret: string, method: string, path: string, body: string) {
  const ts = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString("hex");
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.${nonce}.${method}.${path}.${body}`).digest("hex");
  return { "X-Syncbay-Signature": `sha256=${sig}`, "X-Syncbay-Timestamp": ts, "X-Syncbay-Nonce": nonce };
}

/** First-party app: 200 / 404 / 500 / 302 and a slow path. */
async function startApp(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/ok") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end("ok:" + "x".repeat(96)); // 99 bytes
      }
      if (req.url === "/echo") {
        res.writeHead(200);
        return res.end(body);
      }
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "/ok" });
        return res.end();
      }
      if (req.url === "/boom") {
        res.writeHead(500);
        return res.end("boom");
      }
      if (req.url === "/slow") {
        return setTimeout(() => {
          res.writeHead(200);
          res.end("slow");
        }, 250);
      }
      res.writeHead(404);
      res.end("nope");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return { port, close: () => new Promise((r) => server.close(() => r())) };
}

test("traffic: status classes, latency buckets and identity lookup", () => {
  assert.strictEqual(statusClass(200), "s2xx");
  assert.strictEqual(statusClass(101), "s2xx");
  assert.strictEqual(statusClass(304), "s3xx");
  assert.strictEqual(statusClass(404), "s4xx");
  assert.strictEqual(statusClass(503), "s5xx");
  assert.strictEqual(statusClass(null), "errors");
  assert.strictEqual(statusClass(999), "errors");
  assert.deepStrictEqual([10, 50, 199, 200, 999, 1000, 5000].map(latencyBucket), ["lt50", "lt200", "lt200", "lt1000", "lt1000", "ge1000", "ge1000"]);

  const jobs = [
    { jobId: "old", status: "CANCELLED", assignedPort: 4000, containerId: "proc_1" },
    { jobId: "new", status: "ACTIVE", assignedPort: 4000, containerId: "proc_2", deploymentId: "dep_2", serviceId: "svc" },
    { jobId: "other", status: "ACTIVE", assignedPort: 4001 },
  ];
  assert.deepStrictEqual(identityForPort(jobs, 4000), { containerId: "proc_2", jobId: "new", deploymentId: "dep_2", serviceId: "svc" });
  assert.strictEqual(identityForPort(jobs, 4999), null);
  assert.strictEqual(getDefaultTrafficStats(), getDefaultTrafficStats(), "process-wide store is a singleton");
});

test("traffic: per-minute buckets, drain resets, bounded memory", () => {
  let now = Date.UTC(2026, 10, 7, 12, 0, 30);
  const stats = new TrafficStats({ now: () => now, maxBuckets: 3 });
  stats.record(5000, { status: 200, latencyMs: 12, bytesIn: 10, bytesOut: 100 }, () => ({ jobId: "j1" }));
  stats.record(5000, { status: 500, latencyMs: 1500, bytesIn: 0 });
  stats.addBytesOut(5000, 50);
  now += 60_000; // next minute
  stats.record(5000, { status: null, latencyMs: 3 });
  const d = stats.drain(() => ({ jobId: "late" }));
  assert.strictEqual(d.entries.length, 2);
  const [m1, m2] = d.entries;
  assert.strictEqual(m1.bucketStart, "2026-11-07T12:00:00.000Z");
  assert.deepStrictEqual(
    [m1.requests, m1.s2xx, m1.s5xx, m1.bytesIn, m1.bytesOut, m1.latencySumMs, m1.latencyMaxMs, m1.lt50, m1.ge1000],
    [2, 1, 1, 10, 150, 1512, 1500, 1, 1]
  );
  assert.strictEqual(m1.jobId, "j1", "identity captured when the bucket was opened");
  assert.strictEqual(m2.bucketStart, "2026-11-07T12:01:00.000Z");
  assert.deepStrictEqual([m2.requests, m2.errors, m2.jobId], [1, 1, "late"]);
  assert.strictEqual(stats.size, 0);
  assert.strictEqual(stats.drain().entries.length, 0, "second drain is empty");

  for (let p = 1; p <= 5; p++) stats.record(6000 + p, { status: 200, latencyMs: 1 });
  const bounded = stats.drain();
  assert.strictEqual(bounded.entries.length, 3);
  assert.strictEqual(bounded.droppedBuckets, 2);
  assert.deepStrictEqual(bounded.entries.map((e) => e.port), [6003, 6004, 6005], "oldest buckets evicted first");
});

test("RunnerDaemon: proxied traffic is counted per port and drained once over signed POST", async () => {
  const secret = "traffic-test-key";
  const pm = new PortManager({ rangeStart: 36000, rangeEnd: 36050 });
  const traffic = new TrafficStats();
  const daemon = new RunnerDaemon({
    port: 0,
    host: "127.0.0.1",
    webhookSecret: secret,
    portManager: pm,
    pipeline: new BuildPipeline({ executor: new MockPipelineExecutor(), portManager: pm }),
    traffic,
  });
  const port = await daemon.start();
  const base = `http://127.0.0.1:${port}`;
  const app = await startApp();
  const via = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, redirect: "manual", headers: { ...(init.headers as Record<string, string> | undefined), "x-target-port": String(app.port) } });

  try {
    const statuses: number[] = [];
    for (const p of ["/ok", "/ok", "/ok", "/redirect", "/missing", "/boom", "/slow"]) {
      const r = await via(p);
      await r.arrayBuffer();
      statuses.push(r.status);
    }
    const echo = await via("/echo", { method: "POST", body: "y".repeat(1000) });
    assert.strictEqual((await echo.text()).length, 1000);
    assert.deepStrictEqual(statuses, [200, 200, 200, 302, 404, 500, 200]);

    // Unsigned, wrong-method and replayed drains are refused and do not reset the counters
    assert.strictEqual((await fetch(`${base}/api/traffic/drain`, { method: "POST", body: "{}" })).status, 401);
    assert.strictEqual((await fetch(`${base}/api/traffic/drain`, { headers: signed(secret, "GET", "/api/traffic/drain", "") })).status, 405);
    const headers = { "Content-Type": "application/json", ...signed(secret, "POST", "/api/traffic/drain", "{}") };
    const res = await fetch(`${base}/api/traffic/drain`, { method: "POST", headers, body: "{}" });
    assert.strictEqual(res.status, 200);
    const replay = await fetch(`${base}/api/traffic/drain`, { method: "POST", headers, body: "{}" });
    assert.strictEqual(replay.status, 401, "nonce is single-use");

    const drained = await res.json();
    type Row = Record<string, number> & { port: number };
    const rows = (drained.entries as Row[]).filter((e) => e.port === app.port);
    const sum = (k: string) => rows.reduce((n, e) => n + e[k], 0);
    assert.strictEqual(sum("requests"), 8);
    assert.deepStrictEqual([sum("s2xx"), sum("s3xx"), sum("s4xx"), sum("s5xx"), sum("errors")], [5, 1, 1, 1, 0]);
    assert.strictEqual(sum("bytesIn"), 1000);
    assert.strictEqual(sum("bytesOut"), 3 * 99 + 4 + 4 + 4 + 1000, "response body bytes");
    assert.ok(sum("latencyMaxMs") >= 240, `slow path latency ${sum("latencyMaxMs")}`);
    assert.strictEqual(sum("lt50") + sum("lt200") + sum("lt1000") + sum("ge1000"), 8);
    assert.ok(sum("lt1000") >= 1, "the 250 ms request lands in <1000");

    const again = await fetch(`${base}/api/traffic/drain`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...signed(secret, "POST", "/api/traffic/drain", "{}") },
      body: "{}",
    });
    assert.deepStrictEqual((await again.json()).entries, [], "second drain is empty");
  } finally {
    await app.close();
    await daemon.stop();
  }
});

test("RunnerDaemon: traffic to a job's port is attributed to its deployment; upstream down = network error", async () => {
  const secret = "traffic-identity-key";
  const pm = new PortManager({ rangeStart: 36100, rangeEnd: 36150 });
  const traffic = new TrafficStats();
  const daemon = new RunnerDaemon({
    port: 0,
    host: "127.0.0.1",
    webhookSecret: secret,
    portManager: pm,
    pipeline: new BuildPipeline({ executor: new MockPipelineExecutor(), portManager: pm }),
    traffic,
  });
  const port = await daemon.start();
  const base = `http://127.0.0.1:${port}`;
  try {
    // MockPipelineExecutor: the job gets a port but nothing listens on it.
    const { job, done } = daemon.startJob({ jobId: "build_1", deploymentId: "dep_1", serviceId: "svc_1", serviceName: "traffic-id" });
    await done;
    assert.strictEqual(job.status, "ACTIVE", job.error);
    const r = await fetch(`${base}/anything`, { headers: { "x-target-port": String(job.assignedPort) } });
    assert.strictEqual(r.status, 502);
    await r.arrayBuffer();

    const res = await fetch(`${base}/api/traffic/drain`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...signed(secret, "POST", "/api/traffic/drain", "{}") },
      body: "{}",
    });
    const [entry] = (await res.json()).entries;
    assert.strictEqual(entry.port, job.assignedPort);
    assert.deepStrictEqual(
      [entry.requests, entry.errors, entry.s5xx, entry.jobId, entry.deploymentId, entry.serviceId, entry.containerId],
      [1, 1, 0, "build_1", "dep_1", "svc_1", job.containerId]
    );
  } finally {
    await daemon.stop();
  }
});
