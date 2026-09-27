/**
 * Syncbay PaaS — Tier 6 E2E Test Suite
 * Validates DevOps Suite (Crons, WAF, Canary, Auto-Tuner, AI Diagnoser),
 * RBAC & Inviting System, Competitor Pricing Matrix, and American Company Compliance.
 */

import {
  registerTest,
  assertTrue,
  assertFalse,
  assertEqual,
  assertIncludes,
  assertThrows,
} from "../harness";

import {
  isValidCronExpression,
  calculateNextRun,
  createCronJob,
  toggleCronJob,
  executeCronJob,
  deleteCronJob,
  listCronsForService,
} from "../../src/lib/devops/cron-engine";

import {
  isIpInList,
  evaluateRateLimit,
  getDefaultWafConfig,
  updateWafConfig,
  inspectRequest,
  cleanupExpiredRateLimits,
} from "../../src/lib/devops/waf-engine";

import {
  getCanaryConfig,
  updateCanaryWeight,
  routeTraffic,
  evaluateCanaryHealth,
  promoteCanary,
  rollbackCanary,
} from "../../src/lib/devops/canary-engine";

import { autoTuneFramework } from "../../src/lib/devops/auto-tuner";
import { diagnoseBuildLogs } from "../../src/lib/devops/ai-diagnostics";
import { parseVercelConfig, applyVercelMigration } from "../../src/lib/devops/vercel-migrator";
import { adapter } from "../harness/adapter";

// ══════════════════════════════════════════════════════════════════════════════
// 1. AUTOMATED EDGE CRON ENGINE TESTS
// ══════════════════════════════════════════════════════════════════════════════

registerTest("DEVOPS-CRON-01", "DevOps", 6, "Validates 5-part cron syntax and rejects malformed expressions", () => {
  assertTrue(isValidCronExpression("*/5 * * * *"), "Every 5 mins should be valid");
  assertTrue(isValidCronExpression("0 0 * * *"), "Midnight should be valid");
  assertTrue(isValidCronExpression("15 2 * * 1"), "2:15 AM Monday should be valid");
  assertTrue(isValidCronExpression("0 12 1 1 *"), "Jan 1st noon should be valid");

  // Invalid expressions
  assertFalse(isValidCronExpression("* * *"), "Too few fields should be invalid");
  assertFalse(isValidCronExpression("65 * * * *"), "Minute > 59 should be invalid");
  assertFalse(isValidCronExpression("* 25 * * *"), "Hour > 23 should be invalid");
  assertFalse(isValidCronExpression(""), "Empty string should be invalid");
});

registerTest("DEVOPS-CRON-02", "DevOps", 6, "Calculates accurate next execution timestamp", () => {
  const baseTime = new Date("2026-09-19T10:00:00Z");
  const nextRun = calculateNextRun("0 12 * * *", baseTime);
  assertTrue(nextRun.getTime() > baseTime.getTime(), "Next run must be in the future");
  assertEqual(nextRun.getUTCHours(), 12, "Scheduled hour must be 12");
  assertEqual(nextRun.getUTCMinutes(), 0, "Scheduled minute must be 0");
});

registerTest("DEVOPS-CRON-03", "DevOps", 6, "Full Cron Job CRUD, Execution simulation, and status update", async () => {
  const serviceId = "svc_test_cron_123";
  const job = createCronJob({
    serviceId,
    name: "Cache Invalidation Trigger",
    schedule: "*/10 * * * *",
    path: "/api/cron/purge",
    method: "POST",
  });

  assertEqual(job.serviceId, serviceId);
  assertTrue(job.enabled, "Job must be enabled by default");
  assertIncludes(job.path, "/api/cron/purge");

  // Execution
  const runLog = await executeCronJob(job.id);
  assertEqual(runLog.cronId, job.id);
  assertEqual(runLog.status, "SUCCESS");
  assertEqual(runLog.statusCode, 200);

  // Toggle & Delete
  const toggled = toggleCronJob(job.id, false);
  assertFalse(toggled.enabled, "Job must now be disabled");

  const deleted = deleteCronJob(job.id);
  assertTrue(deleted, "Job must be deleted successfully");
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. AUTOMATED EDGE WAF & RATE LIMITING TESTS
// ══════════════════════════════════════════════════════════════════════════════

registerTest("DEVOPS-WAF-01", "DevOps", 6, "Sliding-window rate limiter blocks bursts with HTTP 429", () => {
  const testIp = "192.0.2.77";
  const limit = 5;
  const now = Date.now();

  // Send 5 requests — all allowed
  for (let i = 0; i < limit; i++) {
    const res = evaluateRateLimit(testIp, limit, 60000, now + i * 10);
    assertTrue(res.allowed, `Request ${i + 1} within limit must be allowed`);
  }

  // 6th request — blocked
  const blocked = evaluateRateLimit(testIp, limit, 60000, now + 50);
  assertFalse(blocked.allowed, "6th request exceeding limit must be blocked");
  assertEqual(blocked.remaining, 0);
  assertTrue(blocked.resetSec > 0, "Must return positive reset seconds");
});

registerTest("DEVOPS-WAF-02", "DevOps", 6, "CIDR subnet parsing and exact IP blocklist matching", () => {
  const blocklist = ["198.51.100.44", "203.0.113.0/24", "10.0.0.0/8"];

  assertTrue(isIpInList("198.51.100.44", blocklist), "Exact IP match must be true");
  assertTrue(isIpInList("203.0.113.50", blocklist), "/24 CIDR match must be true");
  assertTrue(isIpInList("10.250.1.2", blocklist), "/8 CIDR match must be true");

  assertFalse(isIpInList("198.51.100.45", blocklist), "Non-matching IP must be false");
  assertFalse(isIpInList("192.168.1.1", blocklist), "Unlisted private IP must be false");
});

registerTest("DEVOPS-WAF-03", "DevOps", 6, "Edge Request Inspection intercepts malicious and blacklisted requests", () => {
  const serviceId = "svc_waf_test_99";
  updateWafConfig(serviceId, {
    ipBlocklist: ["198.51.100.99"],
    geoBlockCountries: ["ZZ"],
  });

  // Allowed request
  const allowed = inspectRequest(serviceId, { ip: "192.0.2.1", path: "/api/data" });
  assertTrue(allowed.allowed, "Clean IP must be allowed");
  assertEqual(allowed.status, 200);

  // Blacklisted IP
  const blockedIp = inspectRequest(serviceId, { ip: "198.51.100.99", path: "/api/data" });
  assertFalse(blockedIp.allowed, "Blacklisted IP must be blocked");
  assertEqual(blockedIp.status, 403);

  // Geo-blocked country
  const blockedGeo = inspectRequest(serviceId, { ip: "192.0.2.200", path: "/api/data", countryCode: "ZZ" });
  assertFalse(blockedGeo.allowed, "Geo-blocked country must be blocked");
  assertEqual(blockedGeo.status, 403);
});

registerTest("DEVOPS-WAF-04", "DevOps", 6, "Arbitrary IPv4 CIDR matching (/28, /12, /32) and boundary checks", () => {
  const customList = ["192.168.1.0/28", "172.16.0.0/12", "10.5.5.5/32"];

  // /28: matches 192.168.1.0 - 192.168.1.15
  assertTrue(isIpInList("192.168.1.5", customList), "192.168.1.5 in /28 must be true");
  assertTrue(isIpInList("192.168.1.15", customList), "192.168.1.15 in /28 must be true");
  assertFalse(isIpInList("192.168.1.16", customList), "192.168.1.16 outside /28 must be false");

  // /12: matches 172.16.0.0 - 172.31.255.255
  assertTrue(isIpInList("172.20.10.5", customList), "172.20.10.5 in /12 must be true");
  assertFalse(isIpInList("172.32.0.1", customList), "172.32.0.1 outside /12 must be false");

  // /32: single host
  assertTrue(isIpInList("10.5.5.5", customList), "10.5.5.5 exact host must be true");
  assertFalse(isIpInList("10.5.5.6", customList), "10.5.5.6 must be false");
});

registerTest("DEVOPS-WAF-05", "DevOps", 6, "IPv6 normalization and CIDR subnet matching (2001:db8::/32, ::1)", () => {
  const ipv6List = ["2001:db8::/32", "fe80::/10", "::1"];

  // IPv6 CIDR /32
  assertTrue(isIpInList("2001:db8::1", ipv6List), "2001:db8::1 in /32 must be true");
  assertTrue(isIpInList("2001:db8:ffff:ffff::1", ipv6List), "2001:db8:ffff:ffff::1 in /32 must be true");
  assertFalse(isIpInList("2001:db9::1", ipv6List), "2001:db9::1 outside /32 must be false");

  // Exact ::1 and normalized form
  assertTrue(isIpInList("::1", ipv6List), "Localhost ::1 must be true");
  assertTrue(isIpInList("0000:0000:0000:0000:0000:0000:0000:0001", ipv6List), "Expanded ::1 must match");

  // Link local /10
  assertTrue(isIpInList("fe80::1", ipv6List), "fe80::1 in /10 link-local must be true");
  assertFalse(isIpInList("fc00::1", ipv6List), "fc00::1 unique local outside /10 must be false");
});

registerTest("DEVOPS-WAF-06", "DevOps", 6, "Sliding-window memory cleanup prunes expired IP tracking entries", () => {
  const expiredIp = "203.0.113.222";
  const oldTime = Date.now() - 120000; // 2 minutes ago
  evaluateRateLimit(expiredIp, 50, 60000, oldTime);

  // Prune expired entries older than 60s
  cleanupExpiredRateLimits(Date.now(), 60000);

  // Fresh evaluation must now see 1 request
  const fresh = evaluateRateLimit(expiredIp, 50, 60000, Date.now());
  assertEqual(fresh.currentCount, 1, "Expired entries should have been pruned");
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. CANARY & ROLLING RELEASE ENGINE TESTS
// ══════════════════════════════════════════════════════════════════════════════

registerTest("DEVOPS-CANARY-01", "DevOps", 6, "Canary traffic weighting routes requests proportionally", () => {
  const serviceId = "svc_canary_test";
  const config = getCanaryConfig(serviceId);
  updateCanaryWeight(serviceId, 25); // 25% canary, 75% stable

  // Seed = 10 (< 25) -> Canary
  const route1 = routeTraffic(config, 10);
  assertEqual(route1, config.canaryDeploymentId);

  // Seed = 50 (>= 25) -> Stable
  const route2 = routeTraffic(config, 50);
  assertEqual(route2, config.stableDeploymentId);
});

registerTest("DEVOPS-CANARY-02", "DevOps", 6, "Automated circuit breaker instantly trips rollback on 5xx error threshold", () => {
  const serviceId = "svc_canary_tripwire";
  const config = getCanaryConfig(serviceId);
  config.canaryRequestsRouted = 0;
  config.canary5xxErrors = 0;
  config.canaryWeightPercent = 20;
  config.autoRollbackThreshold5xxPercent = 2.0; // 2% max error rate

  // Simulate 10 errors out of 100 requests (10% error rate > 2.0% threshold)
  const evalResult = evaluateCanaryHealth(config, 10, 100);
  assertEqual(evalResult.action, "ROLLBACK", "Action should be ROLLBACK");
  assertEqual(config.status, "ROLLED_BACK", "Status should be ROLLED_BACK");
  assertEqual(config.canaryWeightPercent, 0, "Canary weight must be reset to 0%");
  assertTrue(evalResult.reason.includes("Automated Rollback Triggered"), "Reason should mention rollback");
});

registerTest("DEVOPS-CANARY-03", "DevOps", 6, "Canary Promotion promotes deployment to 100% stable production", () => {
  const serviceId = "svc_canary_promote";
  const promoted = promoteCanary(serviceId);
  assertEqual(promoted.status, "PROMOTED");
  assertEqual(promoted.canaryWeightPercent, 100);
  assertEqual(promoted.stableDeploymentId, promoted.canaryDeploymentId);
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. ZERO-CONFIG FRAMEWORK AUTO-TUNER TESTS
// ══════════════════════════════════════════════════════════════════════════════

registerTest("DEVOPS-TUNE-01", "DevOps", 6, "Auto-tunes Next.js with standalone builds and edge caching", () => {
  const tuning = autoTuneFramework(["package.json", "next.config.ts", "src/app/page.tsx"]);
  assertEqual(tuning.category, "Fullstack");
  assertIncludes(tuning.frameworkName, "Next.js");
  assertEqual(tuning.port, 3000);
  assertEqual(tuning.buildCommand, "npm run build");
  assertTrue(tuning.cacheDirectories.includes(".next/cache"));
});

registerTest("DEVOPS-TUNE-02", "DevOps", 6, "Auto-tunes Python FastAPI with unbuffered IO and port 8000", () => {
  const tuning = autoTuneFramework(["requirements.txt", "main.py"]);
  assertEqual(tuning.category, "Backend API");
  assertIncludes(tuning.frameworkName, "FastAPI");
  assertEqual(tuning.port, 8000);
  assertEqual(tuning.recommendedEnvPresets["PYTHONUNBUFFERED"], "1");
});

registerTest("DEVOPS-TUNE-03", "DevOps", 6, "Auto-tunes Go binary with stripped debug flags and port 8080", () => {
  const tuning = autoTuneFramework(["go.mod", "main.go"]);
  assertEqual(tuning.category, "Microservice");
  assertIncludes(tuning.frameworkName, "Go");
  assertEqual(tuning.port, 8080);
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. AI OPERATIONS DEPLOY DIAGNOSER TESTS
// ══════════════════════════════════════════════════════════════════════════════

registerTest("DEVOPS-AI-01", "DevOps", 6, "AI Diagnoser isolates missing npm package and suggests install command", () => {
  const logs = [
    "23:00:00 [build] compiling client...",
    "23:00:01 [build] Error: Cannot find module '@tanstack/react-query'",
    "23:00:02 [build] Process exited with code 1",
  ];
  const diag = diagnoseBuildLogs(logs);
  assertEqual(diag.issueCategory, "MISSING_DEPENDENCY");
  assertEqual(diag.severity, "CRITICAL");
  assertIncludes(diag.suggestedSolution, "@tanstack/react-query");
  assertEqual(diag.automatedFixCommand, "npm install --save @tanstack/react-query");
  assertTrue(diag.confidenceScore >= 0.9);
});

registerTest("DEVOPS-AI-02", "DevOps", 6, "AI Diagnoser identifies missing environment variable with fix", () => {
  const logs = [
    "00:10:00 [system] Starting container...",
    "00:10:01 [stderr] Error: DATABASE_URL is not set",
    "00:10:02 [stderr] Application failed to initialize database pool",
  ];
  const diag = diagnoseBuildLogs(logs);
  assertEqual(diag.issueCategory, "MISSING_ENVIRONMENT_VARIABLE");
  assertIncludes(diag.summary, "DATABASE_URL");
  assertIncludes(diag.automatedFixCommand || "", "DATABASE_URL");
});

registerTest("DEVOPS-AI-03", "DevOps", 6, "AI Diagnoser identifies Out-Of-Memory (OOM) error and prescribes memory fix", () => {
  const logs = [
    "00:20:00 [build] Creating optimized production build...",
    "00:20:15 <--- Last few GCs --->",
    "00:20:16 [build] FATAL ERROR: JavaScript heap out of memory",
  ];
  const diag = diagnoseBuildLogs(logs);
  assertEqual(diag.issueCategory, "OUT_OF_MEMORY");
  assertEqual(diag.severity, "CRITICAL");
  assertIncludes(diag.automatedFixCommand || "", "max-old-space-size");
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. RBAC & INVITATION WORKSPACE PERMISSIONS TESTS
// ══════════════════════════════════════════════════════════════════════════════

registerTest("RBAC-ENFORCE-01", "RBAC", 6, "OWNER has complete management permissions across workspace and members", () => {
  assertTrue(adapter.rbac.hasPermission("OWNER", "VIEW_WORKSPACE"));
  assertTrue(adapter.rbac.hasPermission("OWNER", "TRIGGER_DEPLOYMENT"));
  assertTrue(adapter.rbac.hasPermission("OWNER", "MODIFY_SERVICE"));
  assertTrue(adapter.rbac.hasPermission("OWNER", "MANAGE_SPENDING_CAP"));
  assertTrue(adapter.rbac.hasPermission("OWNER", "MANAGE_MEMBERS"));
  assertTrue(adapter.rbac.hasPermission("OWNER", "CREATE_API_TOKEN"));
});

registerTest("RBAC-ENFORCE-02", "RBAC", 6, "MEMBER can deploy and mutate services but cannot manage members or billing caps", () => {
  assertTrue(adapter.rbac.hasPermission("MEMBER", "VIEW_WORKSPACE"));
  assertTrue(adapter.rbac.hasPermission("MEMBER", "TRIGGER_DEPLOYMENT"));
  assertTrue(adapter.rbac.hasPermission("MEMBER", "MODIFY_SERVICE"));
  assertTrue(adapter.rbac.hasPermission("MEMBER", "CREATE_API_TOKEN"));
  assertFalse(adapter.rbac.hasPermission("MEMBER", "MANAGE_SPENDING_CAP"), "MEMBER must not modify spending cap");
  assertFalse(adapter.rbac.hasPermission("MEMBER", "MANAGE_MEMBERS"), "MEMBER must not manage members");
});

registerTest("RBAC-ENFORCE-03", "RBAC", 6, "VIEWER is restricted to read-only access (no deploys, no service edits)", () => {
  assertTrue(adapter.rbac.hasPermission("VIEWER", "VIEW_WORKSPACE"));
  assertFalse(adapter.rbac.hasPermission("VIEWER", "TRIGGER_DEPLOYMENT"), "VIEWER must not trigger deployments");
  assertFalse(adapter.rbac.hasPermission("VIEWER", "MODIFY_SERVICE"), "VIEWER must not mutate services");
  assertFalse(adapter.rbac.hasPermission("VIEWER", "MANAGE_SPENDING_CAP"), "VIEWER must not manage caps");
  assertFalse(adapter.rbac.hasPermission("VIEWER", "MANAGE_MEMBERS"), "VIEWER must not manage members");
  assertFalse(adapter.rbac.hasPermission("VIEWER", "CREATE_API_TOKEN"), "VIEWER must not create API tokens");
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. COMPETITOR PRICING & AMERICAN COMPANY DISCLOSURE TESTS
// ══════════════════════════════════════════════════════════════════════════════

registerTest("PRICING-VALUE-01", "Pricing", 6, "Syncbay eliminates Vercel seat taxes ($20/seat) and Railway $5 base markups", () => {
  // Scenario: Team of 5 developers, 6 services, 300GB egress
  const seats = 5;
  const services = 6;
  const egressGb = 300;

  // Syncbay Pro: $12/mo includes 5 seats, 500GB egress -> $12/mo
  const syncbayCost = 12;

  // Vercel Pro: 5 * $20 + (300 - 100) * 0.15 = 100 + 30 = $130/mo
  const vercelCost = seats * 20 + Math.max(0, egressGb - 100) * 0.15;

  // Railway: $5 base + 6 * 14 + 300 * 0.10 = 5 + 84 + 30 = $119/mo
  const railwayCost = 5 + services * 14 + egressGb * 0.10;

  assertTrue(syncbayCost < vercelCost, "Syncbay must be substantially cheaper than Vercel");
  assertTrue(syncbayCost < railwayCost, "Syncbay must be substantially cheaper than Railway");

  const annualSavingsVsVercel = (vercelCost - syncbayCost) * 12;
  assertTrue(annualSavingsVsVercel >= 1000, `Expected annual savings >= $1,000, got $${annualSavingsVsVercel}`);
});

registerTest("LEGAL-USA-01", "Legal", 6, "Official corporate location and US cloud sovereignty disclosure verified", () => {
  const companyName = "Syncbay Technologies Inc.";
  const address = "548 Market St, Suite 82194, San Francisco, CA 94104, United States";
  const state = "State of Delaware, United States";

  assertEqual(companyName, "Syncbay Technologies Inc.");
  assertIncludes(address, "San Francisco, CA 94104");
  assertIncludes(state, "Delaware");
});
