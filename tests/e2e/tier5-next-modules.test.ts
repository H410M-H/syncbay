/**
 * Syncbay PaaS — Next Modules E2E Test Suite (M5, M6, M7, GEO & SEO)
 * Verifies Multi-Region Edge Networking, Developer CLI & OpenAPI,
 * Interactive Web Shell, Database Query Studio, and SEO & GEO primitives.
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
  getEdgeRegions,
  routeClientRequest,
  setRegionStatusOverride,
  calculateDistanceKm,
  getCoordinatesForCountry,
  getCustomDomainTlsStatus,
} from "../../src/lib/edge/edge-router";

import {
  parseManifest,
  generateStarterManifest,
  generateGitHubWorkflow,
} from "../../src/lib/manifest/parser";

import { parseCliArgs, runCli } from "../../src/cli/index";
import { checkScope } from "../../src/lib/api/auth-token";
import { executeShellCommand, getPrompt } from "../../src/lib/shell/web-shell";
import { executeQuery, getDatabaseSchema, detectDestructiveSql, parseRedisCommand } from "../../src/lib/query-studio/engine";
import robots from "../../src/app/robots";
import sitemap from "../../src/app/sitemap";

// ══════════════════════════════════════════════════════════════════════════════
// M5: MULTI-REGION EDGE NETWORKING & PROXY TESTS
// ══════════════════════════════════════════════════════════════════════════════

registerTest("M5-EDGE-01", "M5", 5, "All 6 Global Edge POPs defined with TLS 1.3 & HTTP/3", () => {
  const regions = getEdgeRegions();
  assertEqual(regions.length, 6, "Must define 6 global edge POPs");
  const popIds = regions.map((r) => r.id).sort();
  assertEqual(popIds.join(","), "fra1,iad1,lhr1,sfo1,sin1,syd1");
  for (const reg of regions) {
    assertTrue(reg.http3Enabled, `${reg.id} must support HTTP/3 QUIC`);
    assertEqual(reg.tlsVersion, "TLSv1.3", `${reg.id} must enforce TLS 1.3`);
    assertTrue(reg.activeContainers > 0, `${reg.id} must report active container capacity`);
  }
});

registerTest("M5-EDGE-02", "M5", 5, "Haversine great-circle distance calculation accuracy", () => {
  // Frankfurt (50.11, 8.68) to London (51.51, -0.13) approx ~637 km
  const distFraLhr = calculateDistanceKm(50.1109, 8.6821, 51.5074, -0.1278);
  assertTrue(distFraLhr >= 600 && distFraLhr <= 700, `Expected ~637 km, got ${distFraLhr}`);

  // Zero distance for identical points
  const zeroDist = calculateDistanceKm(38.9, -77.0, 38.9, -77.0);
  assertEqual(zeroDist, 0, "Distance between identical points must be 0");
});

registerTest("M5-EDGE-03", "M5", 5, "Geo routing directs EU clients to Frankfurt or London POP", () => {
  const deDecision = routeClientRequest({ country: "DE", city: "Berlin" });
  assertEqual(deDecision.activeRegion.id, "fra1", "German client must route to Frankfurt fra1");
  assertFalse(deDecision.isFailover, "Normal routing should not flag failover");

  const ukDecision = routeClientRequest({ country: "GB", city: "Manchester" });
  assertEqual(ukDecision.activeRegion.id, "lhr1", "UK client must route to London lhr1");

  const sgDecision = routeClientRequest({ country: "SG", city: "Singapore" });
  assertEqual(sgDecision.activeRegion.id, "sin1", "Singapore client must route to sin1");
});

registerTest("M5-EDGE-04", "M5", 5, "Automated edge failover cascade when primary POP is down", () => {
  try {
    // Override iad1 to OUTAGE
    setRegionStatusOverride("iad1", "OUTAGE");

    const usDecision = routeClientRequest({ country: "US", city: "Washington DC" });
    assertTrue(usDecision.isFailover, "Decision must be flagged as failover");
    assertEqual(usDecision.primaryRegion.id, "iad1", "Primary should have been iad1");
    assertEqual(usDecision.activeRegion.id, "sfo1", "Traffic must failover to sfo1");
    assertTrue(
      usDecision.failoverReason?.includes("outage") ?? false,
      "Must include explicit failover explanation"
    );
  } finally {
    setRegionStatusOverride("iad1", "RESET");
  }
});

registerTest("M5-EDGE-05", "M5", 5, "Custom domain TLS certificate status and auto-renewal check", () => {
  const tls = getCustomDomainTlsStatus("api.mycompany.com");
  assertEqual(tls.status, "ACTIVE");
  assertEqual(tls.tlsVersion, "TLSv1.3");
  assertTrue(tls.autoRenew);
  assertTrue(tls.http3Support);
  assertIncludes(tls.cipherSuite, "AES_256_GCM");
});

// ══════════════════════════════════════════════════════════════════════════════
// M6: DEVELOPER CLI & PUBLIC OPENAPI PLATFORM TESTS
// ══════════════════════════════════════════════════════════════════════════════

registerTest("M6-CLI-01", "M6", 5, "Starter syncbay.json manifest generation and structure", () => {
  const manifest = generateStarterManifest("cloud-rocket");
  assertEqual(manifest.project, "cloud-rocket");
  assertEqual(manifest.version, "1");
  assertTrue(manifest.services.length >= 1);
  assertEqual(manifest.services[0].name, "web");
  assertEqual(manifest.databases[0].provider, "POSTGRES");
  assertTrue(manifest.services[0].regions.includes("iad1"));
});

registerTest("M6-CLI-02", "M6", 5, "Manifest parser validates schemas and catches invalid ports", () => {
  const validJson = JSON.stringify({
    version: "1",
    project: "valid-app",
    services: [{ name: "api", run: { port: 8080 } }],
  });
  const parsed = parseManifest(validJson);
  assertEqual(parsed.project, "valid-app");
  assertEqual(parsed.services[0].run.port, 8080);

  // Invalid port (> 65535)
  const invalidJson = JSON.stringify({
    version: "1",
    project: "bad-port",
    services: [{ name: "api", run: { port: 999999 } }],
  });
  assertThrows(() => parseManifest(invalidJson), /Manifest validation failed/);
});

registerTest("M6-CLI-03", "M6", 5, "GitHub Actions workflow YAML generator outputs deployment command", () => {
  const yaml = generateGitHubWorkflow("production-edge");
  assertIncludes(yaml, "name: Syncbay Continuous Delivery");
  assertIncludes(yaml, "SYNCBAY_API_TOKEN");
  assertIncludes(yaml, "npx syncbay deploy");
  assertIncludes(yaml, 'SYNCBAY_PROJECT: "production-edge"');
});

registerTest("M6-CLI-04", "M6", 5, "CLI argument parser extracts commands, tokens, and flags", () => {
  const args = ["deploy", "--token=pw_live_sec123", "--project=prod-app", "--env=staging"];
  const parsed = parseCliArgs(args);
  assertEqual(parsed.command, "deploy");
  assertEqual(parsed.options.token, "pw_live_sec123");
  assertEqual(parsed.options.project, "prod-app");
  assertEqual(parsed.options.env, "staging");
});

registerTest("M6-CLI-05", "M6", 5, "API Token granular RBAC scope enforcement", () => {
  assertTrue(checkScope("FULL_ACCESS", "READ_ONLY"));
  assertTrue(checkScope("FULL_ACCESS", "DEPLOY_ONLY"));
  assertTrue(checkScope("FULL_ACCESS", "FULL_ACCESS"));

  assertTrue(checkScope("DEPLOY_ONLY", "READ_ONLY"));
  assertTrue(checkScope("DEPLOY_ONLY", "DEPLOY_ONLY"));
  assertFalse(checkScope("DEPLOY_ONLY", "FULL_ACCESS"));

  assertTrue(checkScope("READ_ONLY", "READ_ONLY"));
  assertFalse(checkScope("READ_ONLY", "DEPLOY_ONLY"));
  assertFalse(checkScope("READ_ONLY", "FULL_ACCESS"));
});

registerTest("M6-CLI-06", "M6", 5, "CLI executes status, logs, and db list commands successfully", async () => {
  const statusCode = await runCli(["status"]);
  assertEqual(statusCode, 0, "syncbay status must exit with code 0");

  const logsCode = await runCli(["logs", "web"]);
  assertEqual(logsCode, 0, "syncbay logs web must exit with code 0");

  const dbCode = await runCli(["db", "list"]);
  assertEqual(dbCode, 0, "syncbay db list must exit with code 0");
});

// ══════════════════════════════════════════════════════════════════════════════
// M7: INTERACTIVE WEB SHELL & DATABASE QUERY STUDIO TESTS
// ══════════════════════════════════════════════════════════════════════════════

registerTest("M7-SHELL-01", "M7", 5, "Web shell executes standard container commands (pwd, ls, uname)", () => {
  const state = { cwd: "/app", env: {}, serviceName: "web", containerId: "cf-c1" };

  const pwdRes = executeShellCommand("pwd", state);
  assertEqual(pwdRes.stdout.trim(), "/app");
  assertEqual(pwdRes.exitCode, 0);

  const lsRes = executeShellCommand("ls -la", state);
  assertIncludes(lsRes.stdout, "package.json");
  assertIncludes(lsRes.stdout, "src");

  const unameRes = executeShellCommand("uname -a", state);
  assertIncludes(unameRes.stdout, "Linux");
  assertIncludes(unameRes.stdout, "cloudflare-containers");
});

registerTest("M7-SHELL-02", "M7", 5, "Web shell masks sensitive secret variables in env output", () => {
  const state = {
    cwd: "/app",
    env: {
      DATABASE_URL: "postgresql://postgres:secret@db:5432",
      API_SECRET_KEY: "super_secret_jwt_token_123",
      PUBLIC_APP_URL: "https://my-app.syncbay.app",
    },
    serviceName: "web",
    containerId: "cf-c1",
  };

  const envRes = executeShellCommand("env", state);
  assertIncludes(envRes.stdout, "PUBLIC_APP_URL=https://my-app.syncbay.app");
  assertIncludes(envRes.stdout, "API_SECRET_KEY=••••••••••••••••");
  assertFalse(envRes.stdout.includes("super_secret_jwt_token_123"));
});

registerTest("M7-SHELL-03", "M7", 5, "Web shell navigation (cd) tracks directory state changes", () => {
  const state = { cwd: "/app", env: {}, serviceName: "web", containerId: "cf-c1" };

  const cdRoot = executeShellCommand("cd /", state);
  assertEqual(cdRoot.cwd, "/");

  const cdApp = executeShellCommand("cd app", { ...state, cwd: "/" });
  assertEqual(cdApp.cwd, "/app");

  const prompt = getPrompt("my-service", "/app");
  assertIncludes(prompt, "my-service");
  assertIncludes(prompt, "~");
});

// Real-server Query Studio coverage lives in tests/verify-query-studio.ts (Postgres + Redis).
const PG_TARGET = { provider: "POSTGRES" as const, connectionUrl: "postgresql://postgres:x@127.0.0.1:1/main" };
const SIMULATED = { provider: "POSTGRES" as const, connectionUrl: "postgresql://postgres:x@sb-db-postgres-abc.us-east-1.syncbay-db.internal:5432/main" };

registerTest("M7-STUDIO-01", "M7", 5, "Query Studio refuses simulated instances instead of inventing rows", async () => {
  let message = "";
  try {
    await executeQuery(SIMULATED, "SELECT * FROM users LIMIT 5");
  } catch (err: any) {
    message = err.message;
  }
  assertIncludes(message, "simulated instance");
  assertFalse(detectDestructiveSql("SELECT * FROM users WHERE id = 1").isDestructive);
});

registerTest("M7-STUDIO-02", "M7", 5, "Query Studio Safe Mode blocks destructive DROP/DELETE without WHERE and bypass attempts", async () => {
  for (const sql of ["DROP TABLE users;", "DELETE FROM users", "SELECT 1; DELETE FROM users;", "TRUNCATE TABLE users;", "DROP SCHEMA public CASCADE;"]) {
    let message = "";
    try {
      await executeQuery(PG_TARGET, sql, { mode: "write", safeMode: true });
    } catch (err: any) {
      message = err.message;
    }
    assertIncludes(message, "Safe Mode Block", `Safe Mode must block: ${sql}`);
  }
});

registerTest("M7-STUDIO-03", "M7", 5, "Query Studio Redis read-only mode refuses write commands before connecting", async () => {
  const target = { provider: "REDIS" as const, connectionUrl: "redis://default:x@127.0.0.1:1" };
  let message = "";
  try {
    await executeQuery(target, "SET user:session 123");
  } catch (err: any) {
    message = err.message;
  }
  assertIncludes(message, "Read-only mode");
  const args = parseRedisCommand(`SET greeting "hello world" EX 10`);
  assertEqual(args.join("|"), "SET|greeting|hello world|EX|10");
});

registerTest("M7-STUDIO-04", "M7", 5, "Schema introspection refuses simulated instances", async () => {
  let threw = false;
  try {
    await getDatabaseSchema(SIMULATED);
  } catch {
    threw = true;
  }
  assertTrue(threw, "Introspection must not fabricate tables");
});

// ══════════════════════════════════════════════════════════════════════════════
// GEO & SEO TESTS
// ══════════════════════════════════════════════════════════════════════════════

registerTest("GEO-01", "GEO", 5, "Country coordinate dictionary accurately resolves ISO codes", () => {
  const usCoords = getCoordinatesForCountry("US");
  assertEqual(usCoords.lat, 37.0902);

  const deCoords = getCoordinatesForCountry("DE");
  assertEqual(deCoords.lat, 51.1657);

  const pkCoords = getCoordinatesForCountry("PK");
  assertEqual(pkCoords.lat, 30.3753);

  const fallback = getCoordinatesForCountry("UNKNOWN_COUNTRY");
  assertTrue(fallback.lat !== undefined && fallback.lon !== undefined);
});

registerTest("GEO-02", "GEO", 5, "Global Edge Routing accurately routes developer hubs to optimal POPs", () => {
  // Pakistan routes to Singapore (sin1), NOT US East (iad1)
  const pkDecision = routeClientRequest({ country: "PK" });
  assertEqual(pkDecision.activeRegion.id, "sin1", "PK client must route to sin1 Singapore POP");

  // Spain routes to Frankfurt (fra1) or London (lhr1)
  const esDecision = routeClientRequest({ country: "ES" });
  assertTrue(
    esDecision.activeRegion.id === "fra1" || esDecision.activeRegion.id === "lhr1",
    "ES client must route to European POP"
  );
});

registerTest("SEO-01", "SEO", 5, "Robots.txt allows public marketing routes and protects private consoles", () => {
  const rules = robots();
  const rule = Array.isArray(rules.rules) ? rules.rules[0] : rules.rules;
  assertTrue(!!rule);
  assertTrue(Boolean(rule?.allow?.includes("/")));
  assertTrue(Boolean(rule?.disallow?.includes("/dashboard/")));
  assertTrue(Boolean(rules.sitemap?.includes("sitemap.xml")));
});

registerTest("SEO-02", "SEO", 5, "Dynamic sitemap includes landing, auth, and API routes with valid priorities", () => {
  const entries = sitemap();
  assertTrue(entries.length >= 4);
  const homeEntry = entries.find((e) => e.priority === 1.0);
  assertTrue(!!homeEntry);
  assertTrue(entries.some((e) => e.url.includes("/api/v1/openapi.json")));
});
