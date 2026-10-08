/**
 * Verification Test: End-to-End Orchestrator -> Runner Driver -> Runner Pipeline -> Edge Registry Routing
 */

import assert from "node:assert";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { executeDeployment } from "../src/lib/orchestrator/engine";
import { getRunnerDriver, LocalRunnerDriver } from "../src/lib/orchestrator/runner-driver";
import { getServiceRoute, clearServiceRoutes } from "../src/lib/edge/service-registry";
import { generateDefaultSubdomain } from "../src/lib/domain-service";

async function runVerification() {
  console.log("--- Starting End-to-End Orchestrator Integration Test ---");
  clearServiceRoutes();

  // In-memory data store for deterministic testing without external database dependencies
  const mockStore = {
    services: new Map<string, any>(),
    builds: new Map<string, any>(),
    deployments: new Map<string, any>(),
    domains: new Map<string, any>(),
  };

  const testService = {
    id: "srv_test_real_app",
    name: "real-demo-app",
    sourceType: "empty",
    port: 3000,
    environment: {
      id: "env_prod",
      name: "production",
      isPrEnv: false,
      databases: [],
      project: { id: "prj_1", name: "Demo Project", slug: "demo-project" },
    },
    variables: [
      { key: "DEMO_MSG", value: "Syncbay is live!", isSecret: false },
    ],
    domains: [],
  };

  const testBuild = {
    id: "bld_test_123",
    serviceId: testService.id,
    commitSha: "sha998877",
    commitMessage: "Deploy real application container",
    status: "QUEUED",
  };

  const testDeployment = {
    id: "dep_test_123",
    serviceId: testService.id,
    buildId: testBuild.id,
    status: "QUEUED",
  };

  mockStore.services.set(testService.id, testService);
  mockStore.builds.set(testBuild.id, testBuild);
  mockStore.deployments.set(testDeployment.id, testDeployment);

  // Set up in-memory mock on globalThis.prisma so engine.ts queries it
  (globalThis as any).prisma = {
    service: {
      findUnique: async ({ where }: any) => mockStore.services.get(where.id) || null,
    },
    build: {
      update: async ({ where, data }: any) => {
        const item = mockStore.builds.get(where.id) || {};
        Object.assign(item, data);
        mockStore.builds.set(where.id, item);
        return item;
      },
      findUnique: async ({ where }: any) => mockStore.builds.get(where.id) || null,
    },
    deployment: {
      update: async ({ where, data }: any) => {
        const item = mockStore.deployments.get(where.id) || {};
        Object.assign(item, data);
        mockStore.deployments.set(where.id, item);
        return item;
      },
      findUnique: async ({ where }: any) => mockStore.deployments.get(where.id) || null,
    },
    domain: {
      upsert: async ({ where, create, update }: any) => {
        const existing = mockStore.domains.get(where.hostname);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        mockStore.domains.set(create.hostname, create);
        return create;
      },
      findFirst: async ({ where }: any) => {
        for (const d of mockStore.domains.values()) {
          if (where.hostname && d.hostname === where.hostname) return d;
        }
        return null;
      },
    },
  };

  console.log(`Initialized test service: ${testService.id}, build: ${testBuild.id}`);

  // 1. Execute deployment via orchestrator engine
  console.log("Triggering executeDeployment...");
  const result = await executeDeployment(testDeployment.id, testBuild.id, testService.id, {
    serviceId: testService.id,
    commitSha: "sha998877",
    commitMessage: "Deploy real application container",
    driverType: "local",
  });

  console.log("executeDeployment finished with result:", result);
  assert.strictEqual(result.status, "ACTIVE");
  assert.ok(result.port, "Assigned dynamic port must be returned");
  assert.ok(result.containerId, "Container/process ID must be returned");

  // 2. Verify Edge Service Registry has been populated
  const defaultSubdomain = generateDefaultSubdomain(testService.name, testService.environment.name);
  const route = getServiceRoute(defaultSubdomain);
  console.log(`Checking route for ${defaultSubdomain}:`, route);
  assert.ok(route, "Route must exist in Edge Service Registry");
  assert.strictEqual(route.status, "ACTIVE");
  assert.strictEqual(route.targetPort, result.port);
  assert.strictEqual(route.upstreamUrl, `http://127.0.0.1:${result.port}`);

  // Check that .localhost alias resolves too
  const localAlias = getServiceRoute(`${testService.name}-${testService.environment.name}.localhost`);
  console.log("Localhost alias route:", localAlias);

  // 3. Verify the actual application process is responding to real HTTP requests!
  console.log(`Probing actual running application at http://127.0.0.1:${result.port}/health...`);
  const probeResponse = await fetch(`http://127.0.0.1:${result.port}/health`);
  console.log(`HTTP Probe status: ${probeResponse.status}`);
  assert.strictEqual(probeResponse.status, 200);
  const probeJson = await probeResponse.json();
  console.log("HTTP Probe body:", probeJson);
  assert.strictEqual(probeJson.status, "ok");

  // 4. Verify database records are updated
  const updatedDep = mockStore.deployments.get(testDeployment.id);
  assert.strictEqual(updatedDep?.status, "ACTIVE");
  assert.strictEqual(updatedDep?.cfContainerId, result.containerId);

  const updatedBuild = mockStore.builds.get(testBuild.id);
  assert.strictEqual(updatedBuild?.status, "SUCCEEDED");

  // 5. Test stopping the container/process
  console.log(`Stopping container/process ${result.containerId}...`);
  const driver = getRunnerDriver("local");
  const stopRes = await driver.stopContainer(result.containerId);
  console.log("Stop result:", stopRes);
  assert.strictEqual(stopRes.stopped, true);

  // 6. Test Scenario 2: Broken project must FAIL deployment (NOT falsely report ACTIVE)
  console.log("\n--- Testing Failure Enforcement (Broken App) ---");
  const brokenService = {
    id: "srv_broken_app",
    name: "broken-app",
    sourceType: "github",
    startCommand: "node -e 'process.exit(1)'",
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

  const brokenBuild = {
    id: "bld_broken_1",
    serviceId: brokenService.id,
    commitSha: "sha0001",
    commitMessage: "Broken build",
    status: "QUEUED",
  };

  const brokenDeployment = {
    id: "dep_broken_1",
    serviceId: brokenService.id,
    buildId: brokenBuild.id,
    status: "QUEUED",
  };

  mockStore.services.set(brokenService.id, brokenService);
  mockStore.builds.set(brokenBuild.id, brokenBuild);
  mockStore.deployments.set(brokenDeployment.id, brokenDeployment);

  let failedAsExpected = false;
  try {
    await executeDeployment(brokenDeployment.id, brokenBuild.id, brokenService.id, {
      serviceId: brokenService.id,
      commitSha: "sha0001",
      commitMessage: "Broken build",
      driverType: "local",
    });
  } catch (err: any) {
    console.log("Captured expected deployment error:", err.message);
    failedAsExpected = true;
  }

  assert.strictEqual(failedAsExpected, true, "Deployment must throw when process fails!");
  const failedDepRecord = mockStore.deployments.get(brokenDeployment.id);
  assert.strictEqual(failedDepRecord?.status, "FAILED", "Deployment status must be FAILED in DB");
  const failedBuildRecord = mockStore.builds.get(brokenBuild.id);
  assert.strictEqual(failedBuildRecord?.status, "FAILED", "Build status must be FAILED in DB");

  const brokenSubdomain = generateDefaultSubdomain(brokenService.name, brokenService.environment.name);
  const brokenRoute = getServiceRoute(brokenSubdomain);
  assert.strictEqual(brokenRoute?.status, "FAILED", "Edge route must be marked FAILED");

  // 7. Test Scenario 3: Real app serving on root / without explicit /health endpoint
  console.log("\n--- Testing Real App Serving on Root / ---");
  const customService = {
    id: "srv_custom_app",
    name: "custom-web-app",
    sourceType: "github",
    startCommand: "node -e 'const http = require(\"http\"); http.createServer((q,s) => s.end(\"HELLO FROM USER REPO\")).listen(process.env.PORT, \"0.0.0.0\");'",
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

  const customBuild = {
    id: "bld_custom_1",
    serviceId: customService.id,
    commitSha: "sha0002",
    commitMessage: "Custom app serving root",
    status: "QUEUED",
  };

  const customDeployment = {
    id: "dep_custom_1",
    serviceId: customService.id,
    buildId: customBuild.id,
    status: "QUEUED",
  };

  mockStore.services.set(customService.id, customService);
  mockStore.builds.set(customBuild.id, customBuild);
  mockStore.deployments.set(customDeployment.id, customDeployment);

  const customResult = await executeDeployment(customDeployment.id, customBuild.id, customService.id, {
    serviceId: customService.id,
    commitSha: "sha0002",
    commitMessage: "Custom app serving root",
    driverType: "local",
  });

  assert.strictEqual(customResult.status, "ACTIVE");
  assert.ok(customResult.port);
  console.log(`Probing custom app at http://127.0.0.1:${customResult.port}/...`);
  const rootResponse = await fetch(`http://127.0.0.1:${customResult.port}/`);
  const rootText = await rootResponse.text();
  console.log(`Received response: "${rootText}"`);
  assert.strictEqual(rootText, "HELLO FROM USER REPO");

  // Clean up custom app
  await driver.stopContainer(customResult.containerId!);

  console.log("🎉 ALL INTEGRATION CHECKS (SUCCESS, REAL APP ON ROOT, AND FAILURE ENFORCEMENT) PASSED PERFECTLY!");
}

runVerification().catch((err) => {
  console.error("❌ VERIFICATION TEST FAILED:", err);
  process.exit(1);
});
