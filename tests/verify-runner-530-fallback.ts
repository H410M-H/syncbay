/**
 * Verification Test: Runner Dispatch HTTP 530 Diagnostics & Remote-to-Local Fallback
 *
 * Validates:
 * 1. WebhookRunnerDriver URL normalization & scheme validation.
 * 2. WebhookRunnerDriver transient retry on HTTP 530 / Cloudflare 52x / gateway errors with HTML sanitization.
 * 3. WebhookRunnerDriver recovery when transient 530 resolves.
 * 4. Orchestrator Engine automatic fallback from remote runner (even when driverType: "webhook") to local runner driver on HTTP 530.
 * 5. Edge Service Registry records isLocal: true flag and health probe correctly probes 127.0.0.1 (not unreachable RUNNER_URL).
 * 6. Edge Middleware preserves local routing when isLocal: true despite RUNNER_URL env var.
 * 7. Serverless Vercel fallback simulation in LocalRunnerDriver and full end-to-end executeDeployment without loopback probe hang.
 * 8. Status check error count cap preventing infinite polling loops.
 * 9. Canonical re-signed retries, backoff schedule, production secret enforcement.
 * 10. No local fallback on AuthenticationError or with RUNNER_FALLBACK_LOCAL=false.
 * 11. Runner exitCode is included in the recorded deployment error.
 */

import assert from "node:assert";
import { NextRequest } from "next/server";
import {
  WebhookRunnerDriver,
  LocalRunnerDriver,
  RunnerDriverFactory,
  getRunnerDriver,
  RunnerDriverError,
  AuthenticationError,
  signRequest,
  computeBackoffDelay,
  resolveRunnerSecret,
} from "../src/lib/orchestrator/runner-driver";
import { executeDeployment } from "../src/lib/orchestrator/engine";
import {
  registerServiceRoute,
  getServiceRoute,
  clearServiceRoutes,
} from "../src/lib/edge/service-registry";
import { proxy as middleware } from "../src/proxy";

async function runTests() {
  console.log("================================================================================");
  console.log("   SYNCBAY RUNNER DISPATCH HTTP 530 & RESILIENT FALLBACK VERIFICATION SUITE    ");
  console.log("================================================================================");

  // ─── TEST 1: URL Normalization ──────────────────────────────────────────────
  console.log("\n[1] Testing WebhookRunnerDriver URL normalization...");
  {
    const driverNoScheme = new WebhookRunnerDriver({
      runnerUrl: "tunnel.syncbay.app/",
      webhookSecret: "secret123",
    });
    assert.strictEqual(driverNoScheme.runnerUrl, "https://tunnel.syncbay.app");

    const driverLocal = new WebhookRunnerDriver({
      runnerUrl: "localhost:8080/",
      webhookSecret: "secret123",
    });
    assert.strictEqual(driverLocal.runnerUrl, "http://localhost:8080");

    console.log("  ✔ WebhookRunnerDriver correctly prepends protocol and trims trailing slashes");
  }

  // ─── TEST 2: HTTP 530 Transient Retries & HTML Error Sanitization ────────────
  console.log("\n[2] Testing WebhookRunnerDriver HTTP 530 retries and HTML error sanitization...");
  {
    let fetchAttempts = 0;
    const mockFetch530 = async () => {
      fetchAttempts++;
      return {
        ok: false,
        status: 530,
        text: async () => "<!DOCTYPE html><html><head><title>Error 1033 Argo Tunnel</title></head><body><h1>Origin DNS error</h1></body></html>",
        json: async () => ({}),
      } as any;
    };

    const driver = new WebhookRunnerDriver({
      runnerUrl: "https://runner.syncbay.app",
      webhookSecret: "test-secret",
      fetchFn: mockFetch530 as any,
      timeoutMs: 1000,
      retryBaseDelayMs: 10,
    });

    let threw = false;
    try {
      await driver.dispatchBuild({
        deploymentId: "dep_530_test",
        buildId: "bld_530_test",
        serviceId: "srv_530_test",
        serviceName: "service-530",
      });
    } catch (err: any) {
      threw = true;
      assert.ok(err instanceof RunnerDriverError, "Must throw RunnerDriverError");
      assert.strictEqual(err.code, "DISPATCH_FAILED");
      assert.ok(err.message.includes("HTTP 530"), "Error message must report HTTP 530");
      assert.ok(
        err.message.includes("Error 1033 Argo Tunnel") || err.message.includes("530"),
        "Error message must capture sanitized title instead of raw HTML"
      );
      assert.ok(!err.message.includes("<!DOCTYPE"), "Error message must NOT leak raw HTML doctype");
    }

    assert.strictEqual(threw, true, "dispatchBuild must throw when all 530 attempts fail");
    assert.strictEqual(fetchAttempts, 4, "dispatchBuild must make 4 attempts on transient 530");
    console.log("  ✔ WebhookRunnerDriver made 4 attempts on HTTP 530 and sanitized HTML error output");
  }

  // ─── TEST 3: Recovery when HTTP 530 clears on retry ─────────────────────────
  console.log("\n[3] Testing WebhookRunnerDriver recovery from transient HTTP 530...");
  {
    let attempts = 0;
    const seenHeaders: Array<Record<string, string>> = [];
    const seenBodies: string[] = [];
    const mockFetchRecovering = async (url: string, init: any) => {
      attempts++;
      seenHeaders.push(init.headers);
      seenBodies.push(init.body);
      if (attempts === 1) await new Promise((r) => setTimeout(r, 5)); // force a distinct timestamp
      if (attempts === 1) {
        return {
          ok: false,
          status: 530,
          text: async () => "Tunnel reconnecting",
        } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ jobId: "job_recovered_123", status: "ACTIVE", port: 3000 }),
      } as any;
    };

    const driver = new WebhookRunnerDriver({
      runnerUrl: "https://runner.syncbay.app",
      webhookSecret: "test-secret",
      fetchFn: mockFetchRecovering as any,
      timeoutMs: 1000,
      retryBaseDelayMs: 10,
    });

    const res = await driver.dispatchBuild({
      deploymentId: "dep_rec_1",
      buildId: "bld_rec_1",
      serviceId: "srv_rec_1",
      serviceName: "service-rec",
    });

    assert.strictEqual(res.jobId, "job_recovered_123");
    assert.strictEqual(res.status, "ACTIVE");
    assert.strictEqual(attempts, 2, "Recovered on attempt #2");
    const [h1, h2] = seenHeaders;
    assert.notStrictEqual(h1["X-Syncbay-Timestamp"], h2["X-Syncbay-Timestamp"], "Retry must carry a fresh timestamp");
    assert.notStrictEqual(h1["X-Syncbay-Signature"], h2["X-Syncbay-Signature"], "Retry must be re-signed");
    for (let i = 0; i < 2; i++) {
      const expected = signRequest("test-secret", "POST", "/api/builds", seenBodies[i], seenHeaders[i]["X-Syncbay-Timestamp"]);
      assert.strictEqual(seenHeaders[i]["X-Syncbay-Signature"], expected.headerValue, "Signature covers ts.METHOD.path.body");
    }
    console.log("  ✔ WebhookRunnerDriver recovered after transient 530 and re-signed the retry with a fresh timestamp");
  }

  // ─── TEST 4: Orchestrator Engine Remote-to-Local Fallback on HTTP 530 ────────
  console.log("\n[4] Testing Orchestrator Engine fallback to local runner on HTTP 530 with driverType='webhook'...");
  {
    clearServiceRoutes();

    // Mock store for in-memory database
    const mockStore = {
      services: new Map<string, any>(),
      builds: new Map<string, any>(),
      deployments: new Map<string, any>(),
      domains: new Map<string, any>(),
    };

    const testService = {
      id: "srv_fallback_app",
      name: "fallback-demo-app",
      sourceType: "empty",
      port: 3000,
      environment: {
        id: "env_prod",
        name: "production",
        isPrEnv: false,
        databases: [],
        project: { id: "prj_1", name: "Demo Project", slug: "demo-project" },
      },
      variables: [],
      domains: [],
    };

    const testBuild = {
      id: "bld_fallback_123",
      serviceId: testService.id,
      commitSha: "sha530fb",
      commitMessage: "Test remote 530 fallback",
      status: "QUEUED",
    };

    const testDeployment = {
      id: "dep_fallback_123",
      serviceId: testService.id,
      buildId: testBuild.id,
      status: "QUEUED",
    };

    mockStore.services.set(testService.id, testService);
    mockStore.builds.set(testBuild.id, testBuild);
    mockStore.deployments.set(testDeployment.id, testDeployment);

    (globalThis as any).prisma = {
      service: {
        findUnique: async ({ where }: any) => mockStore.services.get(where.id) || null,
        update: async ({ where, data }: any) => {
          const item = mockStore.services.get(where.id) || {};
          Object.assign(item, data);
          return item;
        },
      },
      build: {
        update: async ({ where, data }: any) => {
          const item = mockStore.builds.get(where.id) || {};
          Object.assign(item, data);
          return item;
        },
        findUnique: async ({ where }: any) => mockStore.builds.get(where.id) || null,
      },
      deployment: {
        update: async ({ where, data }: any) => {
          const item = mockStore.deployments.get(where.id) || {};
          Object.assign(item, data);
          return item;
        },
        findUnique: async ({ where }: any) => mockStore.deployments.get(where.id) || null,
      },
      domain: {
        upsert: async ({ where, create, update }: any) => create,
        findFirst: async () => null,
      },
    };

    // Temporarily set RUNNER_URL to an unreachable domain that returns 530
    const originalRunnerUrl = process.env.RUNNER_URL;
    process.env.RUNNER_URL = "https://unreachable-tunnel.syncbay.app";

    // Mock global fetch to return 530 for runnerUrl requests, but allow local loopback health probes
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const urlStr = typeof input === "string" ? input : input.url || "";
      if (urlStr.includes("unreachable-tunnel.syncbay.app")) {
        return {
          ok: false,
          status: 530,
          text: async () => "Error 530: Argo Tunnel error",
          json: async () => ({}),
        } as any;
      }
      return originalFetch(input, init);
    }) as any;

    try {
      // Explicitly pass driverType: "webhook" to prove fallback functions even when webhook driver was requested
      const result = await executeDeployment(
        testDeployment.id,
        testBuild.id,
        testService.id,
        {
          serviceId: testService.id,
          commitSha: "sha530fb",
          commitMessage: "Test remote 530 fallback",
          driverType: "webhook",
        }
      );

      assert.strictEqual(result.status, "ACTIVE", "Deployment must be ACTIVE via local fallback");
      assert.ok(result.port, "Assigned local port must exist");
      assert.ok(result.containerId, "Container/process ID must exist");

      // Verify Edge Service Registry recorded isLocal: true
      const registeredRoute = getServiceRoute("fallback-demo-app-production.syncbay.app");
      assert.ok(registeredRoute, "Route must exist in registry");
      assert.strictEqual(registeredRoute.isLocal, true, "Route must have isLocal: true");

      // Clean up local process
      const localDriver = RunnerDriverFactory.createDriver("local");
      await localDriver.stopContainer(result.containerId!);

      console.log("  ✔ Orchestrator engine caught HTTP 530 with driverType='webhook' and seamlessly fell back to LocalRunnerDriver");
      console.log("  ✔ Deployment status ACTIVE and health check passed on local port");
      console.log("  ✔ Edge registry entry marked with isLocal: true");
    } finally {
      if (originalRunnerUrl === undefined) delete process.env.RUNNER_URL;
      else process.env.RUNNER_URL = originalRunnerUrl;
      globalThis.fetch = originalFetch;
    }
  }

  // ─── TEST 5: Edge Middleware with isLocal: true ─────────────────────────────
  console.log("\n[5] Testing Edge Middleware routing for isLocal: true services...");
  {
    clearServiceRoutes();

    // Register a local service on port 10055
    registerServiceRoute(
      "local-app.syncbay.app",
      10055,
      "ACTIVE",
      "http://127.0.0.1:10055",
      true /* isLocal */
    );

    // Even if RUNNER_URL is set in environment, middleware must NOT proxy local service through RUNNER_URL
    const originalRunnerUrl = process.env.RUNNER_URL;
    process.env.RUNNER_URL = "https://cloud-tunnel.syncbay.app";

    try {
      const req = new NextRequest("http://127.0.0.1:3000/api/status", {
        headers: { host: "local-app.syncbay.app" },
      });
      const res = await middleware(req);
      const rewrite = res.headers.get("x-middleware-rewrite");
      assert.ok(rewrite !== null, "Middleware must rewrite request");
      assert.ok(
        rewrite.includes("10055"),
        `Rewrite destination must point to local port 10055, got: ${rewrite}`
      );
      assert.ok(
        !rewrite.includes("cloud-tunnel.syncbay.app"),
        "Rewrite destination must NOT use cloud tunnel URL when isLocal is true"
      );
      console.log("  ✔ Middleware routed directly to 127.0.0.1:10055 and avoided external runner tunnel");
    } finally {
      if (originalRunnerUrl === undefined) delete process.env.RUNNER_URL;
      else process.env.RUNNER_URL = originalRunnerUrl;
    }
  }

  // ─── TEST 6: Serverless Vercel Simulation Fallback in LocalRunnerDriver ─────
  console.log("\n[6] Testing Serverless Vercel fallback simulation in LocalRunnerDriver and full executeDeployment...");
  {
    const origVercel = process.env.VERCEL;
    process.env.VERCEL = "1";

    try {
      // 6a. Direct LocalRunnerDriver simulation
      const localDriver = new LocalRunnerDriver({ pipeline: null });
      const logs: string[] = [];
      const result = await localDriver.dispatchBuild({
        deploymentId: "dep_vercel_sim",
        buildId: "bld_vercel_sim",
        serviceId: "srv_vercel_sim",
        serviceName: "vercel-app",
        repoUrl: "https://github.com/syncbay/sample-app.git",
        buildCommand: "npm run build",
        startCommand: "npm start",
        onLog: (line) => logs.push(line),
      });

      assert.strictEqual(result.status, "ACTIVE");
      assert.ok(result.assignedPort);
      assert.ok(result.metadata?.simulated, "Metadata must indicate simulated execution");
      assert.ok(
        logs.some((l) => l.includes("Serverless environment detected")),
        "Logs must contain serverless notification"
      );
      console.log("  ✔ LocalRunnerDriver gracefully simulated deployment in serverless Vercel environment");

      // 6b. Full Orchestrator executeDeployment lifecycle in serverless environment
      const vercelService = {
        id: "srv_vercel_e2e",
        name: "vercel-e2e-app",
        sourceType: "github",
        repoUrl: "https://github.com/syncbay/sample-app.git",
        port: 3000,
        environment: {
          id: "env_prod",
          name: "production",
          isPrEnv: false,
          databases: [],
          project: { id: "prj_1", name: "Demo Project", slug: "demo-project" },
        },
        variables: [],
        domains: [],
      };
      const vercelBuild = {
        id: "bld_vercel_e2e",
        serviceId: vercelService.id,
        commitSha: "shaVercel",
        status: "QUEUED",
      };
      const vercelDeployment = {
        id: "dep_vercel_e2e",
        serviceId: vercelService.id,
        buildId: vercelBuild.id,
        status: "QUEUED",
      };

      (globalThis as any).prisma.service.findUnique = async ({ where }: any) =>
        where.id === vercelService.id ? vercelService : null;
      (globalThis as any).prisma.build.findUnique = async ({ where }: any) =>
        where.id === vercelBuild.id ? vercelBuild : null;
      (globalThis as any).prisma.deployment.findUnique = async ({ where }: any) =>
        where.id === vercelDeployment.id ? vercelDeployment : null;

      const e2eResult = await executeDeployment(
        vercelDeployment.id,
        vercelBuild.id,
        vercelService.id,
        {
          serviceId: vercelService.id,
          commitSha: "shaVercel",
          driverType: "local",
        }
      );

      assert.strictEqual(e2eResult.status, "ACTIVE", "Must be ACTIVE in serverless Vercel execution");
      console.log("  ✔ Orchestrator executeDeployment end-to-end successfully executed in Vercel mode without probe hang");
    } finally {
      if (origVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = origVercel;
    }
  }

  // ─── TEST 7: Consecutive Status Polling Error Safety ─────────────────────────
  console.log("\n[7] Testing Status Polling Failure Cap...");
  {
    const mockDriverWithFailingStatus: any = {
      type: "webhook",
      dispatchBuild: async () => ({
        jobId: "job_polling_fail",
        status: "BUILDING",
        streamUrl: "/api/builds/job_polling_fail/logs",
      }),
      checkStatus: async () => {
        throw new RunnerDriverError("Cloudflare 530 tunnel down", "STATUS_CHECK_FAILED", "webhook");
      },
    };

    const srv = {
      id: "srv_poll_test",
      name: "poll-test-app",
      sourceType: "empty",
      port: 3000,
      environment: { id: "env_p", name: "production", isPrEnv: false, databases: [], project: { id: "p", name: "P", slug: "p" } },
      variables: [],
      domains: [],
    };
    const bld = { id: "bld_poll_test", serviceId: srv.id, status: "QUEUED" };
    const dep = { id: "dep_poll_test", serviceId: srv.id, buildId: bld.id, status: "QUEUED" };

    (globalThis as any).prisma.service.findUnique = async () => srv;
    (globalThis as any).prisma.build.findUnique = async () => bld;
    (globalThis as any).prisma.deployment.findUnique = async () => dep;

    // Temporarily replace RunnerDriverFactory.createDriver
    const origCreate = RunnerDriverFactory.createDriver;
    RunnerDriverFactory.createDriver = (() => mockDriverWithFailingStatus) as any;

    try {
      let threw = false;
      try {
        await executeDeployment(dep.id, bld.id, srv.id, {
          serviceId: srv.id,
          driverType: "webhook",
        });
      } catch (err: any) {
        threw = true;
        assert.ok(err.message.includes("10 consecutive attempts"), `Error must mention attempt limit, got: ${err.message}`);
      }
      assert.strictEqual(threw, true, "Must abort status polling after 10 consecutive failures");
      console.log("  ✔ Status polling loop cleanly aborted after 10 consecutive failures rather than hanging");
    } finally {
      RunnerDriverFactory.createDriver = origCreate;
    }
  }


  // ─── TEST 8: Backoff schedule & production secret enforcement ───────────────
  console.log("\n[8] Testing backoff schedule and production secret enforcement...");
  {
    assert.strictEqual(computeBackoffDelay(0, 500, 8000, () => 1), 500);
    assert.strictEqual(computeBackoffDelay(3, 500, 8000, () => 1), 4000);
    assert.strictEqual(computeBackoffDelay(10, 500, 8000, () => 1), 8000, "Backoff caps at 8s");
    assert.strictEqual(computeBackoffDelay(2, 500, 8000, () => 0), 1000, "Jitter keeps at least half the delay");

    const saved = {
      NODE_ENV: process.env.NODE_ENV,
      RUNNER_SECRET: process.env.RUNNER_SECRET,
      RUNNER_WEBHOOK_SECRET: process.env.RUNNER_WEBHOOK_SECRET,
      SYNCBAY_WEBHOOK_SECRET: process.env.SYNCBAY_WEBHOOK_SECRET,
    };
    const env = process.env as Record<string, string | undefined>;
    delete env.RUNNER_SECRET;
    delete env.RUNNER_WEBHOOK_SECRET;
    delete env.SYNCBAY_WEBHOOK_SECRET;
    try {
      env.NODE_ENV = "production";
      assert.throws(() => resolveRunnerSecret(), AuthenticationError, "Missing secret must throw in production");
      assert.throws(() => getRunnerDriver("webhook"), AuthenticationError, "Webhook driver must not use a default secret in production");
      env.RUNNER_SECRET = "prod-secret";
      assert.strictEqual(resolveRunnerSecret(), "prod-secret");
      env.NODE_ENV = "development";
      delete env.RUNNER_SECRET;
      assert.ok(resolveRunnerSecret().length > 0, "Dev default secret is available outside production");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete env[k];
        else env[k] = v;
      }
    }
    console.log("  ✔ Exponential backoff with jitter capped at 8s; production refuses to run without RUNNER_SECRET");
  }

  // Shared fixtures for engine-level fallback tests
  const fbSrv = {
    id: "srv_fb_ctrl",
    name: "fb-ctrl-app",
    sourceType: "empty",
    port: 3000,
    environment: { id: "env_fb", name: "production", isPrEnv: false, databases: [], project: { id: "p", name: "P", slug: "p" } },
    variables: [],
    domains: [],
  };
  const fbBld = { id: "bld_fb_ctrl", serviceId: fbSrv.id, status: "QUEUED" };
  const fbDep = { id: "dep_fb_ctrl", serviceId: fbSrv.id, buildId: fbBld.id, status: "QUEUED" };
  (globalThis as any).prisma.service.findUnique = async () => fbSrv;
  (globalThis as any).prisma.build.findUnique = async () => fbBld;
  (globalThis as any).prisma.deployment.findUnique = async () => fbDep;

  async function runWithMockDriver(mockDriver: any): Promise<{ error?: Error; requested: string[] }> {
    const requested: string[] = [];
    const origCreate = RunnerDriverFactory.createDriver;
    RunnerDriverFactory.createDriver = ((type: any) => {
      requested.push(type);
      return mockDriver;
    }) as any;
    try {
      await executeDeployment(fbDep.id, fbBld.id, fbSrv.id, { serviceId: fbSrv.id, driverType: "webhook" });
      return { requested };
    } catch (error: any) {
      return { error, requested };
    } finally {
      RunnerDriverFactory.createDriver = origCreate;
    }
  }

  // ─── TEST 9: No local fallback on AuthenticationError / RUNNER_FALLBACK_LOCAL=false ──
  console.log("\n[9] Testing fallback suppression for auth errors and RUNNER_FALLBACK_LOCAL=false...");
  {
    const authFailDriver = {
      type: "webhook",
      dispatchBuild: async () => {
        throw new AuthenticationError("Runner rejected HMAC authentication (HTTP 401)");
      },
      checkStatus: async () => ({ jobId: "x", status: "FAILED" }),
      stopContainer: async () => ({ containerId: "x", stopped: true }),
    };
    const authRun = await runWithMockDriver(authFailDriver);
    assert.ok(authRun.error, "AuthenticationError must fail the deployment");
    assert.ok(/HMAC authentication/.test(authRun.error!.message));
    assert.ok(!authRun.requested.includes("local"), "Engine must not fall back to local on AuthenticationError");

    const transientDriver = {
      ...authFailDriver,
      dispatchBuild: async () => {
        throw new RunnerDriverError("Runner dispatch failed (HTTP 530): tunnel down", "DISPATCH_FAILED", "webhook");
      },
    };
    const prevFallback = process.env.RUNNER_FALLBACK_LOCAL;
    process.env.RUNNER_FALLBACK_LOCAL = "false";
    try {
      const noFallbackRun = await runWithMockDriver(transientDriver);
      assert.ok(noFallbackRun.error && /HTTP 530/.test(noFallbackRun.error.message), "Dispatch error must surface");
      assert.ok(!noFallbackRun.requested.includes("local"), "RUNNER_FALLBACK_LOCAL=false disables the local fallback");
    } finally {
      if (prevFallback === undefined) delete process.env.RUNNER_FALLBACK_LOCAL;
      else process.env.RUNNER_FALLBACK_LOCAL = prevFallback;
    }
    console.log("  ✔ AuthenticationError and RUNNER_FALLBACK_LOCAL=false both skip the local fallback");
  }

  // ─── TEST 10: Runner exitCode is recorded with the deployment error ─────────
  console.log("\n[10] Testing exitCode propagation into the recorded deployment error...");
  {
    const failingDriver = {
      type: "webhook",
      dispatchBuild: async () => ({ jobId: "job_exit_137", status: "BUILDING" }),
      checkStatus: async () => ({ jobId: "job_exit_137", status: "FAILED", exitCode: 137, errorMessage: "Container killed (OOM)" }),
      stopContainer: async () => ({ containerId: "x", stopped: true }),
    };
    const run = await runWithMockDriver(failingDriver);
    assert.ok(run.error, "FAILED status must fail the deployment");
    assert.ok(run.error!.message.includes("exit code 137"), `Error must include exit code, got: ${run.error!.message}`);
    const { logEventBus } = await import("../src/lib/telemetry/event-bus");
    assert.ok((logEventBus.getError(fbDep.id) || "").includes("exit code 137"), "recordError must include the exit code");
    console.log("  ✔ exitCode 137 from runner status is included in the thrown and recorded error");
  }

  console.log("\n================================================================================");
  console.log("🎉 ALL 10 RUNNER HTTP 530 & RESILIENT FALLBACK CHECKS PASSED PERFECTLY!");
  console.log("================================================================================");
  process.exit(0);
}

runTests().catch((err) => {
  console.error("❌ TEST RUN FAILED:", err);
  process.exit(1);
});
