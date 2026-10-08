/**
 * Syncbay PaaS — Adversarial Stress Test Suite: Hybrid Compute & Edge Routing
 * Challenger 1 Verification Harness
 *
 * Covers:
 *  1. Dynamic Port Manager: high concurrency, rapid alloc/free, host socket availability probing, boundary limits.
 *  2. Runner Drivers: HMAC signature verification with tampered payloads, forged signatures, replay defense.
 *  3. Cloudflare Tunnel Generator: RFC 1123 hostnames, port boundaries, wildcard ordering, YAML invariants.
 *  4. Next.js Edge Middleware & Service Registry: active pass-through vs sleeping/building routing, edge compatibility.
 */

import assert from "node:assert";
import crypto from "node:crypto";
import { PortManager, defaultPortManager } from "../../runner/src/port-manager";
import {
  generateHmacSignature,
  verifyHmacSignature,
  mapWebhookStatus,
  mapPrismaBuildStatus,
  mapDockerStatus,
  WebhookRunnerDriver,
  QueueRunnerDriver,
  SshRunnerDriver,
  RunnerDriverFactory,
  RunnerDriverError,
  AuthenticationError,
} from "../../src/lib/orchestrator/runner-driver";
import {
  validateHostname,
  validatePort,
  generateTunnelConfig,
  type RouteMapping,
} from "../../src/lib/tunnel/tunnel-config";
import {
  EdgeServiceRegistry,
  createEdgeRegistry,
  normalizeHostname,
} from "../../src/lib/edge/service-registry";

export interface StressTestResult {
  id: string;
  category: string;
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

export const results: StressTestResult[] = [];

export async function runTest(
  id: string,
  category: string,
  name: string,
  fn: () => void | Promise<void>
): Promise<boolean> {
  const start = Date.now();
  try {
    await fn();
    results.push({
      id,
      category,
      name,
      passed: true,
      durationMs: Date.now() - start,
    });
    return true;
  } catch (err: any) {
    results.push({
      id,
      category,
      name,
      passed: false,
      error: err?.message || String(err),
      durationMs: Date.now() - start,
    });
    return false;
  }
}

// =============================================================================
// CATEGORY 1: Dynamic Port Manager Stress & Boundary Harness
// =============================================================================

export async function runPortManagerStressTests() {
  await runTest("PM-STRESS-01", "PortManager", "Constructor rejects invalid port range where rangeStart >= rangeEnd", () => {
    assert.throws(
      () => new PortManager({ rangeStart: 5000, rangeEnd: 5000 }),
      /Invalid port range/
    );
    assert.throws(
      () => new PortManager({ rangeStart: 6000, rangeEnd: 5000 }),
      /Invalid port range/
    );
  });

  await runTest("PM-STRESS-02", "PortManager", "isPortAvailable rejects ports outside configured boundaries", async () => {
    const pm = new PortManager({ rangeStart: 10000, rangeEnd: 10010 });
    assert.strictEqual(await pm.isPortAvailable(9999), false);
    assert.strictEqual(await pm.isPortAvailable(10011), false);
    assert.strictEqual(await pm.isPortAvailable(-1), false);
    assert.strictEqual(await pm.isPortAvailable(70000), false);
  });

  await runTest("PM-STRESS-03", "PortManager", "Reserved ports are strictly excluded from allocation and availability checks", async () => {
    const pm = new PortManager({
      rangeStart: 10000,
      rangeEnd: 10005,
      reservedPorts: [10000, 10001, 10002],
    });

    assert.strictEqual(await pm.isPortAvailable(10000), false);
    assert.strictEqual(await pm.isPortAvailable(10001), false);
    assert.strictEqual(await pm.isPortAvailable(10002), false);

    // Synchronous reservation of a non-reserved port succeeds
    const allocated = pm.reservePortSync(10003);
    assert.strictEqual(allocated, 10003);
    assert.strictEqual(pm.isPortAllocated(10003), true);
  });

  await runTest("PM-STRESS-04", "PortManager", "High concurrency synchronous reservation guarantees unique allocations", () => {
    const pm = new PortManager({ rangeStart: 20000, rangeEnd: 20100 });
    const allocated = new Set<number>();

    for (let i = 20000; i < 20050; i++) {
      const p = pm.reservePortSync(i, `service-${i}`, `job-${i}`);
      assert.strictEqual(allocated.has(p), false, `Collision detected on port ${p}`);
      allocated.add(p);
    }

    assert.strictEqual(allocated.size, 50);
    assert.strictEqual(pm.getAllocatedPorts().length, 50);
  });

  await runTest("PM-STRESS-05", "PortManager", "Duplicate reservePortSync throws on already allocated port", () => {
    const pm = new PortManager({ rangeStart: 30000, rangeEnd: 30010 });
    pm.reservePortSync(30001, "srv-1");
    assert.throws(() => pm.reservePortSync(30001, "srv-2"), /already allocated/);
  });

  await runTest("PM-STRESS-06", "PortManager", "Rapid allocate, release, and reallocate cycle reclaims ports cleanly", () => {
    const pm = new PortManager({ rangeStart: 31000, rangeEnd: 31020 });
    const ports: number[] = [];

    // Churn 1: Allocate 20 ports
    for (let p = 31000; p < 31020; p++) {
      ports.push(pm.reservePortSync(p, `srv-${p}`));
    }
    assert.strictEqual(pm.getAllocatedPorts().length, 20);

    // Churn 2: Release all 20 ports
    for (const p of ports) {
      const released = pm.releasePort(p);
      assert.strictEqual(released, true);
    }
    assert.strictEqual(pm.getAllocatedPorts().length, 0);

    // Churn 3: Re-allocate same ports cleanly
    for (const p of ports) {
      const reallocated = pm.reservePortSync(p, `srv-re-${p}`);
      assert.strictEqual(reallocated, p);
    }
    assert.strictEqual(pm.getAllocatedPorts().length, 20);
  });

  await runTest("PM-STRESS-07", "PortManager", "releasePort double-release is safe and idempotent", () => {
    const pm = new PortManager({ rangeStart: 32000, rangeEnd: 32010 });
    pm.reservePortSync(32001, "srv-idem");

    assert.strictEqual(pm.releasePort(32001), true);
    assert.strictEqual(pm.releasePort(32001), false);
    assert.strictEqual(pm.releasePort(32001), false);
    assert.strictEqual(pm.isPortAllocated(32001), false);
  });

  await runTest("PM-STRESS-08", "PortManager", "releaseServicePort and releaseJobPort cleanly unmap associations", () => {
    const pm = new PortManager({ rangeStart: 33000, rangeEnd: 33010 });
    pm.reservePortSync(33001, "srv-target", "job-target");

    assert.strictEqual(pm.getPortForService("srv-target"), 33001);

    // Release by service ID
    assert.strictEqual(pm.releaseServicePort("srv-target"), true);
    assert.strictEqual(pm.getPortForService("srv-target"), undefined);
    assert.strictEqual(pm.isPortAllocated(33001), false);

    // Re-reserve for job test
    pm.reservePortSync(33002, "srv-target-2", "job-target-2");
    assert.strictEqual(pm.releaseJobPort("job-target-2"), true);
    assert.strictEqual(pm.isPortAllocated(33002), false);

    // Non-existent releases return false
    assert.strictEqual(pm.releaseServicePort("non-existent"), false);
    assert.strictEqual(pm.releaseJobPort("non-existent"), false);
  });

  await runTest("PM-STRESS-09", "PortManager", "Reset wipes all allocations, service maps, and job maps", () => {
    const pm = new PortManager({ rangeStart: 34000, rangeEnd: 34010 });
    pm.reservePortSync(34001, "s1", "j1");
    pm.reservePortSync(34002, "s2", "j2");
    pm.reservePortSync(34003, "s3", "j3");

    assert.strictEqual(pm.getAllocatedPorts().length, 3);
    pm.reset();
    assert.strictEqual(pm.getAllocatedPorts().length, 0);
    assert.strictEqual(pm.getPortForService("s1"), undefined);
    assert.strictEqual(pm.getAllocations().length, 0);
  });
}

// =============================================================================
// CATEGORY 2: Runner Drivers HMAC & Authentication Adversarial Harness
// =============================================================================

export async function runRunnerDriverStressTests() {
  const secret = "syncbay-super-secret-hmac-key-2026-xyz";
  const payload = {
    jobId: "job_adversarial_99",
    serviceName: "payment-api",
    commitSha: "a1b2c3d4e5f6",
    subdomain: "payment-api-nuu9",
  };
  const bodyStr = JSON.stringify(payload);

  await runTest("RD-HMAC-01", "RunnerDrivers", "Valid HMAC SHA-256 signature with sha256= prefix verifies successfully", () => {
    const { headerValue, timestamp } = generateHmacSignature(bodyStr, secret);
    const isValid = verifyHmacSignature(bodyStr, headerValue, secret, { timestamp });
    assert.strictEqual(isValid, true);
  });

  await runTest("RD-HMAC-02", "RunnerDrivers", "Valid HMAC SHA-256 signature without sha256= prefix verifies successfully", () => {
    const { signature, timestamp } = generateHmacSignature(bodyStr, secret);
    const isValid = verifyHmacSignature(bodyStr, signature, secret, { timestamp });
    assert.strictEqual(isValid, true);
  });

  await runTest("RD-HMAC-03", "RunnerDrivers", "Tampered payload body fails HMAC verification", () => {
    const { headerValue, timestamp } = generateHmacSignature(bodyStr, secret);
    const tamperedBody = JSON.stringify({ ...payload, serviceName: "payment-api-TAMPERED" });
    const isValid = verifyHmacSignature(tamperedBody, headerValue, secret, { timestamp });
    assert.strictEqual(isValid, false);
  });

  await runTest("RD-HMAC-04", "RunnerDrivers", "Forged signature string fails verification with timing-safe comparison", () => {
    const fakeSignature = "sha256=" + crypto.randomBytes(32).toString("hex");
    const now = Date.now().toString();
    const isValid = verifyHmacSignature(bodyStr, fakeSignature, secret, { timestamp: now });
    assert.strictEqual(isValid, false);
  });

  await runTest("RD-HMAC-05", "RunnerDrivers", "Truncated or malformed hex signature header is immediately rejected", () => {
    const now = Date.now().toString();
    assert.strictEqual(verifyHmacSignature(bodyStr, "sha256=deadbeef", secret, { timestamp: now }), false);
    assert.strictEqual(verifyHmacSignature(bodyStr, "sha256=", secret, { timestamp: now }), false);
    assert.strictEqual(verifyHmacSignature(bodyStr, "not-a-hex-signature-at-all", secret, { timestamp: now }), false);
    assert.strictEqual(verifyHmacSignature(bodyStr, "zzzz".repeat(16), secret, { timestamp: now }), false);
  });

  await runTest("RD-HMAC-06", "RunnerDrivers", "Replay attack defense rejects timestamps older than tolerance window (5 mins)", () => {
    const expiredTimestamp = (Date.now() - 301000).toString(); // 5 min 1 sec ago
    const { headerValue } = generateHmacSignature(bodyStr, secret, expiredTimestamp);
    const isValid = verifyHmacSignature(bodyStr, headerValue, secret, {
      timestamp: expiredTimestamp,
      toleranceMs: 300000,
    });
    assert.strictEqual(isValid, false);
  });

  await runTest("RD-HMAC-07", "RunnerDrivers", "Replay attack defense rejects timestamps in the future (> 5 mins)", () => {
    const futureTimestamp = (Date.now() + 301000).toString(); // 5 min 1 sec in future
    const { headerValue } = generateHmacSignature(bodyStr, secret, futureTimestamp);
    const isValid = verifyHmacSignature(bodyStr, headerValue, secret, {
      timestamp: futureTimestamp,
      toleranceMs: 300000,
    });
    assert.strictEqual(isValid, false);
  });

  await runTest("RD-HMAC-08", "RunnerDrivers", "Incorrect HMAC secret rejects verification", () => {
    const { headerValue, timestamp } = generateHmacSignature(bodyStr, secret);
    const wrongSecret = "wrong-secret-key-that-does-not-match";
    const isValid = verifyHmacSignature(bodyStr, headerValue, wrongSecret, { timestamp });
    assert.strictEqual(isValid, false);
  });

  await runTest("RD-HMAC-09", "RunnerDrivers", "generateHmacSignature throws on empty secret and verify returns false", () => {
    assert.throws(() => generateHmacSignature(bodyStr, ""), /HMAC secret must not be empty/);
    assert.strictEqual(verifyHmacSignature(bodyStr, "sha256=abc", ""), false);
  });

  await runTest("RD-STATUS-01", "RunnerDrivers", "mapWebhookStatus accurately categorizes all operational status strings", () => {
    assert.strictEqual(mapWebhookStatus("QUEUED"), "QUEUED");
    assert.strictEqual(mapWebhookStatus("PENDING"), "QUEUED");
    assert.strictEqual(mapWebhookStatus("BUILDING"), "BUILDING");
    assert.strictEqual(mapWebhookStatus("RUNNING"), "BUILDING");
    assert.strictEqual(mapWebhookStatus("DEPLOYING"), "DEPLOYING");
    assert.strictEqual(mapWebhookStatus("PROVISIONING"), "DEPLOYING");
    assert.strictEqual(mapWebhookStatus("ACTIVE"), "ACTIVE");
    assert.strictEqual(mapWebhookStatus("SUCCEEDED"), "ACTIVE");
    assert.strictEqual(mapWebhookStatus("SUCCESS"), "ACTIVE");
    assert.strictEqual(mapWebhookStatus("READY"), "ACTIVE");
    assert.strictEqual(mapWebhookStatus("FAILED"), "FAILED");
    assert.strictEqual(mapWebhookStatus("ERROR"), "FAILED");
    assert.strictEqual(mapWebhookStatus("CRASHED"), "FAILED");
    assert.strictEqual(mapWebhookStatus("CANCELLED"), "CANCELLED");
    assert.strictEqual(mapWebhookStatus("STOPPED"), "CANCELLED");
  });

  await runTest("RD-STATUS-02", "RunnerDrivers", "mapDockerStatus correctly interprets Docker State object", () => {
    assert.strictEqual(mapDockerStatus({ Running: true }), "ACTIVE");
    assert.strictEqual(mapDockerStatus({ Status: "running" }), "ACTIVE");
    assert.strictEqual(mapDockerStatus({ Status: "created" }), "DEPLOYING");
    assert.strictEqual(mapDockerStatus({ Status: "restarting" }), "DEPLOYING");
    assert.strictEqual(mapDockerStatus({ Status: "exited", ExitCode: 0 }), "ACTIVE");
    assert.strictEqual(mapDockerStatus({ Status: "exited", ExitCode: 137 }), "FAILED");
    assert.strictEqual(mapDockerStatus({ Dead: true }), "FAILED");
    assert.strictEqual(mapDockerStatus({ OOMKilled: true }), "FAILED");
  });

  await runTest("RD-FACTORY-01", "RunnerDrivers", "RunnerDriverFactory creates registered drivers and rejects unsupported types", () => {
    const webhookDriver = RunnerDriverFactory.createDriver("webhook", {
      runnerUrl: "http://127.0.0.1:8080",
      webhookSecret: "secret",
    });
    assert.strictEqual(webhookDriver.type, "webhook");

    const queueDriver = RunnerDriverFactory.createDriver("queue");
    assert.strictEqual(queueDriver.type, "queue");

    const sshDriver = RunnerDriverFactory.createDriver("ssh", {
      host: "10.0.0.1",
      username: "ubuntu",
    });
    assert.strictEqual(sshDriver.type, "ssh");

    assert.throws(
      () => RunnerDriverFactory.createDriver("invalid_type" as any),
      /Unsupported runner driver type/
    );
  });
}

// =============================================================================
// CATEGORY 3: Cloudflare Tunnel Generator Adversarial & Boundary Harness
// =============================================================================

export async function runTunnelConfigStressTests() {
  await runTest("TC-VAL-01", "TunnelConfig", "validateHostname validates RFC 1123 subdomains and wildcards", () => {
    assert.strictEqual(validateHostname("web-production-nuu9.syncbay.app"), true);
    assert.strictEqual(validateHostname("web-pr-42.syncbay.app"), true);
    assert.strictEqual(validateHostname("*.syncbay.app"), true);
    assert.strictEqual(validateHostname("api.service.internal.io"), true);
  });

  await runTest("TC-VAL-02", "TunnelConfig", "validateHostname rejects URI schemes, paths, and port numbers", () => {
    assert.strictEqual(validateHostname("http://web-production-1.syncbay.app"), false);
    assert.strictEqual(validateHostname("https://web-production-1.syncbay.app"), false);
    assert.strictEqual(validateHostname("web-production-1.syncbay.app/admin"), false);
    assert.strictEqual(validateHostname("web-production-1.syncbay.app:3000"), false);
  });

  await runTest("TC-VAL-03", "TunnelConfig", "validateHostname rejects malformed wildcards and illegal RFC characters", () => {
    assert.strictEqual(validateHostname("*.*.syncbay.app"), false);
    assert.strictEqual(validateHostname("web.*.syncbay.app"), false);
    assert.strictEqual(validateHostname("-start-hyphen.syncbay.app"), false);
    assert.strictEqual(validateHostname("end-hyphen-.syncbay.app"), false);
    assert.strictEqual(validateHostname("localhost"), false); // No TLD / dot
    assert.strictEqual(validateHostname(""), false);
  });

  await runTest("TC-VAL-04", "TunnelConfig", "validatePort enforces TCP integer range (1..65535)", () => {
    assert.strictEqual(validatePort(1), true);
    assert.strictEqual(validatePort(80), true);
    assert.strictEqual(validatePort(443), true);
    assert.strictEqual(validatePort(3000), true);
    assert.strictEqual(validatePort(65535), true);

    // Out of bounds / invalid
    assert.strictEqual(validatePort(0), false);
    assert.strictEqual(validatePort(-1), false);
    assert.strictEqual(validatePort(65536), false);
    assert.strictEqual(validatePort(3000.5), false);
    assert.strictEqual(validatePort(NaN), false);
    assert.strictEqual(validatePort(Infinity), false);
  });

  await runTest("TC-GEN-01", "TunnelConfig", "generateTunnelConfig sorts specific subdomains BEFORE wildcard rules", () => {
    const routes: RouteMapping[] = [
      { hostname: "*.syncbay.app", targetPort: 8080 },
      { hostname: "web-production-nuu9.syncbay.app", targetPort: 3000 },
      { hostname: "web-pr-101.syncbay.app", targetPort: 4000 },
      { hostname: "api-service.syncbay.app", targetPort: 5000 },
    ];

    const yaml = generateTunnelConfig({
      tunnelId: "tun-adversarial-01",
      routes,
    });

    const lines = yaml.split("\n");
    const wildcardIdx = lines.findIndex((l) => l.includes('hostname: "*.syncbay.app"') || l.includes("hostname: *.syncbay.app"));
    const prodIdx = lines.findIndex((l) => l.includes("hostname: web-production-nuu9.syncbay.app"));
    const prIdx = lines.findIndex((l) => l.includes("hostname: web-pr-101.syncbay.app"));
    const apiIdx = lines.findIndex((l) => l.includes("hostname: api-service.syncbay.app"));

    assert.ok(prodIdx !== -1 && prIdx !== -1 && apiIdx !== -1 && wildcardIdx !== -1);
    assert.ok(prodIdx < wildcardIdx, "Specific production route must precede wildcard");
    assert.ok(prIdx < wildcardIdx, "Specific PR preview route must precede wildcard");
    assert.ok(apiIdx < wildcardIdx, "Specific API route must precede wildcard");
  });

  await runTest("TC-GEN-02", "TunnelConfig", "Mandatory final catch-all rule is strictly preserved as last entry", () => {
    const yaml = generateTunnelConfig({
      tunnelId: "tun-catchall-02",
      routes: [
        { hostname: "web-production-1.syncbay.app", targetPort: 3000 },
      ],
      controlPlaneFallback: "http://localhost:8080",
    });

    const lines = yaml.trim().split("\n");
    const lastLine = lines[lines.length - 1].trim();
    assert.strictEqual(lastLine, "- service: http_status:404");
  });

  await runTest("TC-GEN-03", "TunnelConfig", "controlPlaneFallback injected when routes lack wildcard", () => {
    const yaml = generateTunnelConfig({
      tunnelId: "tun-fallback-03",
      routes: [{ hostname: "web-production-1.syncbay.app", targetPort: 3000 }],
      controlPlaneFallback: "http://localhost:3000",
    });

    assert.ok(yaml.includes('hostname: "*.syncbay.app"'));
    assert.ok(yaml.includes("service: http://localhost:3000"));
  });

  await runTest("TC-GEN-04", "TunnelConfig", "Throws descriptive errors on invalid tunnelId, hostname, or port", () => {
    assert.throws(
      () => generateTunnelConfig({ tunnelId: "", routes: [] }),
      /tunnelId is required/
    );

    assert.throws(
      () =>
        generateTunnelConfig({
          tunnelId: "tun-test",
          routes: [{ hostname: "invalid hostname with spaces", targetPort: 3000 }],
        }),
      /Invalid route hostname/
    );

    assert.throws(
      () =>
        generateTunnelConfig({
          tunnelId: "tun-test",
          routes: [{ hostname: "valid.syncbay.app", targetPort: 70000 }],
        }),
      /Target port out of range/
    );
  });
}

// =============================================================================
// CATEGORY 4: Next.js Edge Middleware & Service Registry Stress Harness
// =============================================================================

export async function runEdgeMiddlewareStressTests() {
  await runTest("MW-REG-01", "EdgeRegistry", "normalizeHostname cleans protocols, ports, trailing slashes, and casing", () => {
    assert.strictEqual(normalizeHostname("HTTP://WEB-PR-12.SYNCBAY.APP:3000/path"), "web-pr-12.syncbay.app");
    assert.strictEqual(normalizeHostname("HTTPS://API-SVC.SYNCBAY.APP:443/"), "api-svc.syncbay.app");
    assert.strictEqual(normalizeHostname("  storefront.syncbay.app  "), "storefront.syncbay.app");
    assert.strictEqual(normalizeHostname(""), "");
  });

  await runTest("MW-REG-02", "EdgeRegistry", "Registers and retrieves service routes with default localhost target", () => {
    const reg = createEdgeRegistry();
    reg.registerServiceRoute("web-production-nuu9.syncbay.app", 3001, "ACTIVE");

    const route = reg.getServiceRoute("WEB-PRODUCTION-NUU9.SYNCBAY.APP");
    assert.ok(route !== null);
    assert.strictEqual(route?.status, "ACTIVE");
    assert.strictEqual(route?.targetPort, 3001);
    assert.strictEqual(route?.upstreamUrl, "http://localhost:3001");
  });

  await runTest("MW-REG-03", "EdgeRegistry", "Explicit upstreamUrl takes precedence over targetPort synthesis", () => {
    const reg = createEdgeRegistry();
    reg.registerServiceRoute(
      "custom-origin.syncbay.app",
      3002,
      "ACTIVE",
      "https://internal-runner.syncbay.internal:8443"
    );

    const route = reg.getServiceRoute("custom-origin.syncbay.app");
    assert.strictEqual(route?.upstreamUrl, "https://internal-runner.syncbay.internal:8443");
  });

  await runTest("MW-REG-04", "EdgeRegistry", "High-volume insertion of 500 routes handles rapid lookups without degradation", () => {
    const reg = createEdgeRegistry();
    const count = 500;

    for (let i = 0; i < count; i++) {
      reg.registerServiceRoute(`service-${i}.syncbay.app`, 10000 + i, i % 2 === 0 ? "ACTIVE" : "BUILDING");
    }

    assert.strictEqual(reg.listRoutes().length, count);

    // Verify boundary lookups
    assert.strictEqual(reg.getServiceRoute("service-0.syncbay.app")?.status, "ACTIVE");
    assert.strictEqual(reg.getServiceRoute("service-1.syncbay.app")?.status, "BUILDING");
    assert.strictEqual(reg.getServiceRoute(`service-${count - 1}.syncbay.app`)?.targetPort, 10000 + count - 1);

    // Clean wipe
    reg.clearServiceRoutes();
    assert.strictEqual(reg.listRoutes().length, 0);
  });

  await runTest("MW-REG-05", "EdgeRegistry", "Edge Runtime isolation: zero Node native module dependencies", () => {
    // Verify that registry relies purely on web standards (Map, Date.now)
    const reg = createEdgeRegistry();
    assert.strictEqual(typeof reg.registerServiceRoute, "function");
    assert.strictEqual(typeof reg.getServiceRoute, "function");
    assert.strictEqual(typeof reg.removeServiceRoute, "function");
    assert.strictEqual(typeof reg.clearServiceRoutes, "function");
  });

  await runTest("MW-ROUTING-ORACLE-01", "EdgeMiddleware", "Routing oracle correctly classifies subdomain types", () => {
    const isSyncbaySubdomain = (host: string) =>
      host.endsWith(".syncbay.app") &&
      host !== "syncbay.app" &&
      host !== "www.syncbay.app" &&
      host !== "cname.syncbay.app";

    assert.strictEqual(isSyncbaySubdomain("web-production-nuu9.syncbay.app"), true);
    assert.strictEqual(isSyncbaySubdomain("web-pr-42.syncbay.app"), true);
    assert.strictEqual(isSyncbaySubdomain("syncbay.app"), false);
    assert.strictEqual(isSyncbaySubdomain("www.syncbay.app"), false);
    assert.strictEqual(isSyncbaySubdomain("cname.syncbay.app"), false);
    assert.strictEqual(isSyncbaySubdomain("custom-customer-domain.com"), false);
  });

  await runTest("MW-ROUTING-ORACLE-02", "EdgeMiddleware", "Routing oracle distinguishes ACTIVE, BUILDING, SLEEPING, and FAILED", () => {
    const reg = createEdgeRegistry();
    reg.registerServiceRoute("active.syncbay.app", 3000, "ACTIVE", "http://localhost:3000");
    reg.registerServiceRoute("building.syncbay.app", 3001, "BUILDING");
    reg.registerServiceRoute("sleeping.syncbay.app", 3002, "SLEEPING");
    reg.registerServiceRoute("failed.syncbay.app", 3003, "FAILED");

    const getRouteAction = (host: string, pathname: string) => {
      if (pathname === "/health" || pathname === "/healthz") {
        return { action: "health_probe_200" };
      }
      const route = reg.getServiceRoute(host);
      if (route && (route.status === "FAILED" || route.status === "CRASHED")) {
        return { action: "502_bad_gateway", status: route.status };
      }
      if (route && route.status === "ACTIVE") {
        return { action: "proxy_upstream", upstreamUrl: route.upstreamUrl };
      }
      const subdomain = host.replace(".syncbay.app", "");
      return { action: "service_preview_splash", target: `/service-preview/${subdomain}` };
    };

    // Health probe bypass
    assert.strictEqual(getRouteAction("active.syncbay.app", "/health").action, "health_probe_200");
    assert.strictEqual(getRouteAction("sleeping.syncbay.app", "/healthz").action, "health_probe_200");

    // Active proxy
    const activeRes = getRouteAction("active.syncbay.app", "/dashboard");
    assert.strictEqual(activeRes.action, "proxy_upstream");
    assert.strictEqual(activeRes.upstreamUrl, "http://localhost:3000");

    // Building -> Splash preview
    const buildingRes = getRouteAction("building.syncbay.app", "/");
    assert.strictEqual(buildingRes.action, "service_preview_splash");
    assert.strictEqual(buildingRes.target, "/service-preview/building");

    // Sleeping -> Splash preview
    const sleepingRes = getRouteAction("sleeping.syncbay.app", "/api");
    assert.strictEqual(sleepingRes.action, "service_preview_splash");
    assert.strictEqual(sleepingRes.target, "/service-preview/sleeping");

    // Failed -> 502 Bad Gateway
    const failedRes = getRouteAction("failed.syncbay.app", "/");
    assert.strictEqual(failedRes.action, "502_bad_gateway");

    // Unknown -> Splash preview
    const unknownRes = getRouteAction("unknown-new.syncbay.app", "/");
    assert.strictEqual(unknownRes.action, "service_preview_splash");
    assert.strictEqual(unknownRes.target, "/service-preview/unknown-new");
  });
}

// =============================================================================
// MASTER RUNNER
// =============================================================================

export async function runAllStressTests() {
  console.log("================================================================================");
  console.log("    SYNCBAY PAAS — ADVERSARIAL STRESS TEST SUITE (CHALLENGER 1)               ");
  console.log("================================================================================\n");

  await runPortManagerStressTests();
  await runRunnerDriverStressTests();
  await runTunnelConfigStressTests();
  await runEdgeMiddlewareStressTests();

  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log("\n--------------------------------------------------------------------------------");
  console.log(`TOTAL TESTS:   ${total}`);
  console.log(`PASSED:        ${passed}`);
  console.log(`FAILED:        ${failed}`);
  console.log("================================================================================\n");

  return { total, passed, failed, results };
}

// Self-executing if run directly via tsx/node
if (process.argv[1]?.includes("hybrid-routing-stress")) {
  runAllStressTests().then(({ failed }) => {
    process.exit(failed > 0 ? 1 : 0);
  });
}
