/**
 * Standalone Runner Agent Unit Test Suite
 */

import assert from "node:assert";
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
