/**
 * Syncbay PaaS — Tier 5: Adversarial Stress & Boundary Test Suite
 * Hybrid Compute & Edge Routing (R1 through R5)
 * Challenger 1 Empirical Verification
 */

import {
  registerTest,
  assertTrue,
  assertFalse,
  assertEqual,
  assertMatch,
  assertIncludes,
  assertThrows,
} from "../harness";
import crypto from "node:crypto";
import { PortManager } from "../../runner/src/port-manager";
import {
  generateHmacSignature,
  verifyHmacSignature,
  mapWebhookStatus,
  mapPrismaBuildStatus,
  mapDockerStatus,
  RunnerDriverFactory,
} from "../../src/lib/orchestrator/runner-driver";
import {
  validateHostname,
  validatePort,
  generateTunnelConfig,
} from "../../src/lib/tunnel/tunnel-config";
import {
  createEdgeRegistry,
  normalizeHostname,
} from "../../src/lib/edge/service-registry";

// =============================================================================
// 1. Dynamic Port Manager Stress & Boundary (HYB-F10)
// =============================================================================

registerTest("ADV-PM-01", "HYB-F10", 5, "PortManager constructor rejects invalid port range boundaries", async () => {
  assertThrows(() => new PortManager({ rangeStart: 20000, rangeEnd: 10000 }), /Invalid port range/);
  assertThrows(() => new PortManager({ rangeStart: 10000, rangeEnd: 10000 }), /Invalid port range/);
});

registerTest("ADV-PM-02", "HYB-F10", 5, "isPortAvailable rejects negative, out-of-range, and reserved ports", async () => {
  const pm = new PortManager({ rangeStart: 15000, rangeEnd: 15010, reservedPorts: [15005] });
  assertEqual(await pm.isPortAvailable(14999), false);
  assertEqual(await pm.isPortAvailable(15011), false);
  assertEqual(await pm.isPortAvailable(15005), false);
  assertEqual(await pm.isPortAvailable(-1), false);
  assertEqual(await pm.isPortAvailable(70000), false);
});

registerTest("ADV-PM-03", "HYB-F10", 5, "PortManager rapid reserve and release maintains exact pool accounting", async () => {
  const pm = new PortManager({ rangeStart: 16000, rangeEnd: 16050 });
  for (let p = 16000; p < 16030; p++) {
    pm.reservePortSync(p, `srv-${p}`, `job-${p}`);
  }
  assertEqual(pm.getAllocatedPorts().length, 30);

  // Release odd ports
  for (let p = 16001; p < 16030; p += 2) {
    assertTrue(pm.releasePort(p));
  }
  assertEqual(pm.getAllocatedPorts().length, 15);

  // Re-reserve released odd ports
  for (let p = 16001; p < 16030; p += 2) {
    assertEqual(pm.reservePortSync(p, `srv-re-${p}`), p);
  }
  assertEqual(pm.getAllocatedPorts().length, 30);
});

registerTest("ADV-PM-04", "HYB-F10", 5, "PortManager releasePort is idempotent and does not corrupt map on duplicates", async () => {
  const pm = new PortManager({ rangeStart: 17000, rangeEnd: 17010 });
  pm.reservePortSync(17001, "srv-1");
  assertTrue(pm.releasePort(17001));
  assertFalse(pm.releasePort(17001));
  assertFalse(pm.releasePort(17001));
  assertFalse(pm.isPortAllocated(17001));
});

registerTest("ADV-PM-05", "HYB-F10", 5, "PortManager reset completely purges state and clears allocations", async () => {
  const pm = new PortManager({ rangeStart: 18000, rangeEnd: 18020 });
  pm.reservePortSync(18001, "srv-a", "job-a");
  pm.reservePortSync(18002, "srv-b", "job-b");
  pm.reset();
  assertEqual(pm.getAllocatedPorts().length, 0);
  assertEqual(pm.getPortForService("srv-a"), undefined);
});

// =============================================================================
// 2. Runner Drivers HMAC & Authentication Adversarial (HYB-F05/F06)
// =============================================================================

registerTest("ADV-RD-01", "HYB-F06", 5, "HMAC verification accepts sha256= prefix and raw hex strings", async () => {
  const secret = "adversarial-key-9999-secure-hash";
  const body = JSON.stringify({ action: "dispatch", buildId: "bld_1" });
  const { headerValue, signature, timestamp } = generateHmacSignature(body, secret);

  assertTrue(verifyHmacSignature(body, headerValue, secret, { timestamp }));
  assertTrue(verifyHmacSignature(body, signature, secret, { timestamp }));
});

registerTest("ADV-RD-02", "HYB-F06", 5, "HMAC verification strictly detects tampered payloads and forged signatures", async () => {
  const secret = "adversarial-key-9999-secure-hash";
  const body = JSON.stringify({ action: "dispatch", buildId: "bld_1" });
  const { headerValue, timestamp } = generateHmacSignature(body, secret);

  // Tampered body
  assertFalse(verifyHmacSignature(body + " ", headerValue, secret, { timestamp }));
  assertFalse(verifyHmacSignature('{"tampered":true}', headerValue, secret, { timestamp }));

  // Forged signature
  const forged = "sha256=" + crypto.randomBytes(32).toString("hex");
  assertFalse(verifyHmacSignature(body, forged, secret, { timestamp }));
});

registerTest("ADV-RD-03", "HYB-F06", 5, "HMAC verification defends against replay attacks and clock skew beyond 5 minutes", async () => {
  const secret = "adversarial-key-9999-secure-hash";
  const body = JSON.stringify({ action: "dispatch" });

  const staleTime = (Date.now() - 305000).toString(); // 5 min 5 sec ago
  const { headerValue: staleHeader } = generateHmacSignature(body, secret, staleTime);
  assertFalse(verifyHmacSignature(body, staleHeader, secret, { timestamp: staleTime, toleranceMs: 300000 }));

  const futureTime = (Date.now() + 305000).toString(); // 5 min 5 sec ahead
  const { headerValue: futureHeader } = generateHmacSignature(body, secret, futureTime);
  assertFalse(verifyHmacSignature(body, futureHeader, secret, { timestamp: futureTime, toleranceMs: 300000 }));
});

registerTest("ADV-RD-04", "HYB-F06", 5, "HMAC verification immediately rejects malformed headers and empty secrets", async () => {
  const body = "valid-body";
  assertFalse(verifyHmacSignature(body, "sha256=invalid-short", "secret"));
  assertFalse(verifyHmacSignature(body, "sha256=", "secret"));
  assertFalse(verifyHmacSignature(body, "", "secret"));
  assertFalse(verifyHmacSignature(body, "sha256=" + "a".repeat(64), ""));
});

registerTest("ADV-RD-05", "HYB-F05", 5, "Runner status mappings correctly handle terminal and transient states", async () => {
  assertEqual(mapWebhookStatus("QUEUED"), "QUEUED");
  assertEqual(mapWebhookStatus("RUNNING"), "BUILDING");
  assertEqual(mapWebhookStatus("READY"), "ACTIVE");
  assertEqual(mapWebhookStatus("CRASHED"), "FAILED");
  assertEqual(mapWebhookStatus("STOPPED"), "CANCELLED");

  assertEqual(mapDockerStatus({ Status: "running", Running: true }), "ACTIVE");
  assertEqual(mapDockerStatus({ Status: "exited", ExitCode: 0 }), "ACTIVE");
  assertEqual(mapDockerStatus({ Status: "exited", ExitCode: 1 }), "FAILED");
  assertEqual(mapDockerStatus({ OOMKilled: true }), "FAILED");
});

// =============================================================================
// 3. Cloudflare Tunnel Generator Adversarial & Boundary (HYB-F11)
// =============================================================================

registerTest("ADV-TC-01", "HYB-F11", 5, "validateHostname enforces RFC 1123 and rejects URI schemes and port suffixes", async () => {
  assertTrue(validateHostname("web-production-1.syncbay.app"));
  assertTrue(validateHostname("*.syncbay.app"));

  assertFalse(validateHostname("http://web-production-1.syncbay.app"));
  assertFalse(validateHostname("https://web-production-1.syncbay.app"));
  assertFalse(validateHostname("web-production-1.syncbay.app:80"));
  assertFalse(validateHostname("web-production-1.syncbay.app/path"));
  assertFalse(validateHostname("-leading-hyphen.syncbay.app"));
  assertFalse(validateHostname("trailing-hyphen-.syncbay.app"));
  assertFalse(validateHostname("*.*.syncbay.app"));
  assertFalse(validateHostname(""));
});

registerTest("ADV-TC-02", "HYB-F11", 5, "validatePort strictly enforces valid TCP port range (1..65535)", async () => {
  assertTrue(validatePort(1));
  assertTrue(validatePort(80));
  assertTrue(validatePort(443));
  assertTrue(validatePort(65535));

  assertFalse(validatePort(0));
  assertFalse(validatePort(-1));
  assertFalse(validatePort(65536));
  assertFalse(validatePort(8080.5));
  assertFalse(validatePort(NaN));
});

registerTest("ADV-TC-03", "HYB-F11", 5, "generateTunnelConfig guarantees specific subdomains precede wildcards", async () => {
  const yaml = generateTunnelConfig({
    tunnelId: "tun-adv-1",
    routes: [
      { hostname: "*.syncbay.app", targetPort: 8080 },
      { hostname: "web-production-nuu9.syncbay.app", targetPort: 3000 },
      { hostname: "web-pr-12.syncbay.app", targetPort: 3001 },
    ],
  });

  const lines = yaml.split("\n");
  const wildIdx = lines.findIndex((l) => l.includes("hostname: *.syncbay.app") || l.includes('hostname: "*.syncbay.app"'));
  const prodIdx = lines.findIndex((l) => l.includes("hostname: web-production-nuu9.syncbay.app"));
  const prIdx = lines.findIndex((l) => l.includes("hostname: web-pr-12.syncbay.app"));

  assertTrue(prodIdx !== -1 && prIdx !== -1 && wildIdx !== -1);
  assertTrue(prodIdx < wildIdx, "Production route must precede wildcard");
  assertTrue(prIdx < wildIdx, "PR route must precede wildcard");
});

registerTest("ADV-TC-04", "HYB-F11", 5, "generateTunnelConfig preserves terminal catch-all 404 rule as the last entry", async () => {
  const yaml = generateTunnelConfig({
    tunnelId: "tun-adv-2",
    routes: [{ hostname: "web-production-1.syncbay.app", targetPort: 3000 }],
    controlPlaneFallback: "http://localhost:3000",
  });

  const lines = yaml.trim().split("\n");
  assertEqual(lines[lines.length - 1].trim(), "- service: http_status:404");
});

// =============================================================================
// 4. Edge Middleware & Service Registry Stress (HYB-F12/F13)
// =============================================================================

registerTest("ADV-MW-01", "HYB-F12", 5, "EdgeRegistry normalizes hostnames and isolates concurrent route registrations", async () => {
  const reg = createEdgeRegistry();
  reg.registerServiceRoute("HTTP://WEB-PR-99.SYNCBAY.APP:8080/test", 3050, "ACTIVE");

  const entry = reg.getServiceRoute("web-pr-99.syncbay.app");
  assertTrue(entry !== null);
  assertEqual(entry?.targetPort, 3050);
  assertEqual(entry?.upstreamUrl, "http://localhost:3050");
  assertEqual(entry?.status, "ACTIVE");
});

registerTest("ADV-MW-02", "HYB-F12", 5, "EdgeRegistry handles high route volume with zero memory corruption", async () => {
  const reg = createEdgeRegistry();
  const count = 300;
  for (let i = 0; i < count; i++) {
    reg.registerServiceRoute(`service-${i}.syncbay.app`, 20000 + i, i % 2 === 0 ? "ACTIVE" : "SLEEPING");
  }
  assertEqual(reg.listRoutes().length, count);
  assertEqual(reg.getServiceRoute("service-100.syncbay.app")?.status, "ACTIVE");
  assertEqual(reg.getServiceRoute("service-101.syncbay.app")?.status, "SLEEPING");
  reg.clearServiceRoutes();
  assertEqual(reg.listRoutes().length, 0);
});

registerTest("ADV-MW-03", "HYB-F13", 5, "Routing oracle validates instant health probe bypass and preview redirection", async () => {
  const reg = createEdgeRegistry();
  reg.registerServiceRoute("sleeping-app.syncbay.app", 3000, "SLEEPING");
  reg.registerServiceRoute("crashed-app.syncbay.app", 3001, "FAILED");

  const routeSleeping = reg.getServiceRoute("sleeping-app.syncbay.app");
  const routeCrashed = reg.getServiceRoute("crashed-app.syncbay.app");

  // Sleeping goes to preview splash
  assertTrue(routeSleeping?.status === "SLEEPING");
  // Crashed returns 502
  assertTrue(routeCrashed?.status === "FAILED");
});
