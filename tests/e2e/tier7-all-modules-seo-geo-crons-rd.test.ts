/**
 * Syncbay PaaS — Tier 7 E2E Test Suite
 * Validates:
 * 1. Sub-Services & Modules Across All Phases (Databases, Buckets, Services, Crons, Team, Dynamic Invite)
 * 2. Enterprise Marketing, Trending Templates & Weekly R&D Roadmap
 * 3. SEO Sitemap, Robots Rules & Geo-Targeting Global Ranking
 * 4. Smart Crons (Customer Acquisition, Trial Conversion, Backup Verification, Multi-Region POP Health)
 * 5. Weekly Trending Tech Stacks, Release Drops (v1.0 to v1.5), and Feature Voting Pipeline
 */

import {
  registerTest,
  assertTrue,
  assertFalse,
  assertEqual,
  assertIncludes,
} from "../harness";

import sitemap from "../../src/app/sitemap";
import robots from "../../src/app/robots";
import {
  routeClientRequest,
  getEdgeRegions,
  calculateDistanceKm,
  setRegionStatusOverride,
} from "../../src/lib/edge/edge-router";
import {
  runDormantUserReengagementCron,
  runTrialConversionCron,
  runWeeklyTrendingFeaturesDigestCron,
  runDatabaseBackupVerificationCron,
  runEdgePopHealthProbeCron,
  runWafThreatIntelligenceCron,
  executeSmartCrons,
} from "../../src/lib/crons/smart-crons";
import {
  getWeeklyVersionDrops,
  getTrendingStacks,
  getStrategicInsights,
  getFeatureVotes,
  voteForFeature,
} from "../../src/lib/rd/trending-engine";
import { appRouter } from "../../src/server/root";
import fs from "fs";
import path from "path";

// ─── 1. Sub-Services & Module Route Resolution ──────────────────────────────
registerTest("T7-MOD-01", "ALL_MODULES", 7, "All dashboard sub-services pages exist in App Router", () => {
  const baseAppDir = path.resolve(process.cwd(), "src/app");
  const requiredPages = [
    "dashboard/page.tsx",
    "dashboard/projects/page.tsx",
    "dashboard/services/page.tsx",
    "dashboard/databases/page.tsx",
    "dashboard/buckets/page.tsx",
    "dashboard/crons/page.tsx",
    "dashboard/team/page.tsx",
    "dashboard/members/page.tsx",
    "dashboard/settings/page.tsx",
    "dashboard/usage/page.tsx",
    "dashboard/audit/page.tsx",
    "invite/[token]/page.tsx",
  ];

  for (const pagePath of requiredPages) {
    const fullPath = path.join(baseAppDir, pagePath);
    assertTrue(fs.existsSync(fullPath), `Page file must exist: ${pagePath}`);
  }
});

registerTest("T7-MOD-02", "ALL_MODULES", 7, "All public marketing & discovery pages exist in App Router", () => {
  const baseAppDir = path.resolve(process.cwd(), "src/app");
  const publicPages = [
    "page.tsx",
    "pricing/page.tsx",
    "enterprise/page.tsx",
    "templates/page.tsx",
    "roadmap/page.tsx",
  ];

  for (const pagePath of publicPages) {
    const fullPath = path.join(baseAppDir, pagePath);
    assertTrue(fs.existsSync(fullPath), `Public marketing page must exist: ${pagePath}`);
  }
});

registerTest("T7-MOD-03", "ALL_MODULES", 7, "tRPC root router registers all sub-service routers including devops and rd", () => {
  const procedures = Object.keys((appRouter as any)._def.procedures || {});
  assertTrue(procedures.some((p) => p.startsWith("rd.")), "R&D router must be mounted");
  assertTrue(procedures.some((p) => p.startsWith("devops.")), "Devops router must be mounted");
  assertTrue(procedures.some((p) => p.startsWith("database.")), "Database router must be mounted");
  assertTrue(procedures.some((p) => p.startsWith("bucket.")), "Bucket router must be mounted");
  assertTrue(procedures.some((p) => p.startsWith("service.")), "Service router must be mounted");
  assertTrue(procedures.some((p) => p.startsWith("workspace.")), "Workspace router must be mounted");
});

// ─── 2. SEO, Sitemap, Robots & Global Ranking ───────────────────────────────
registerTest("T7-SEO-01", "SEO", 7, "Dynamic sitemap includes all 8 public and marketing URLs with correct priorities", () => {
  const entries = sitemap();
  assertTrue(entries.length >= 8, `Sitemap must have at least 8 entries, got ${entries.length}`);

  const urls = entries.map((e) => e.url);
  assertTrue(urls.some((u) => u.endsWith("/pricing")), "Sitemap must include /pricing");
  assertTrue(urls.some((u) => u.endsWith("/enterprise")), "Sitemap must include /enterprise");
  assertTrue(urls.some((u) => u.endsWith("/templates")), "Sitemap must include /templates");
  assertTrue(urls.some((u) => u.endsWith("/roadmap")), "Sitemap must include /roadmap");
  assertTrue(urls.some((u) => u.endsWith("/auth/signin")), "Sitemap must include /auth/signin");

  const home = entries.find((e) => !e.url.includes("/", 9));
  assertEqual(home?.priority, 1.0, "Landing page priority must be 1.0");
});

registerTest("T7-SEO-02", "SEO", 7, "Robots rules permit all public routes while shielding private console & API routes", () => {
  const r = robots();
  const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules;
  assertTrue(!!rule, "Robots rule must exist");

  const allowList = rule.allow || [];
  assertTrue(allowList.includes("/"), "Robots must allow /");
  assertTrue(allowList.includes("/pricing"), "Robots must allow /pricing");
  assertTrue(allowList.includes("/enterprise"), "Robots must allow /enterprise");
  assertTrue(allowList.includes("/templates"), "Robots must allow /templates");
  assertTrue(allowList.includes("/roadmap"), "Robots must allow /roadmap");

  const disallowList = rule.disallow || [];
  assertTrue(disallowList.includes("/dashboard/"), "Robots must disallow /dashboard/");
  assertTrue(disallowList.includes("/api/deployments/"), "Robots must disallow /api/deployments/");
  assertTrue(disallowList.includes("/api/trpc/"), "Robots must disallow /api/trpc/");
  assertTrue(disallowList.includes("/invite/"), "Robots must disallow /invite/");
});

// ─── 3. Geo Targeting & Global Edge Routing ─────────────────────────────────
registerTest("T7-GEO-01", "GEO", 7, "Geo router routes European requests to Frankfurt POP", () => {
  const result = routeClientRequest({
    country: "DE",
    city: "Berlin",
    latitude: 52.52,
    longitude: 13.405,
    clientIp: "88.130.45.12",
  });

  assertEqual(result.primaryRegion.id, "fra1", "German request should route to Frankfurt (fra1)");
  assertTrue(result.estimatedLatencyMs < 30, "Latency to local POP should be low (<30ms)");
});

registerTest("T7-GEO-02", "GEO", 7, "Geo router routes Asian requests to Singapore POP", () => {
  const result = routeClientRequest({
    country: "SG",
    city: "Singapore",
    latitude: 1.3521,
    longitude: 103.8198,
    clientIp: "133.242.18.5",
  });

  assertEqual(result.primaryRegion.id, "sin1", "Singapore/Asian request should route to Singapore (sin1)");
  assertTrue(result.estimatedLatencyMs < 30, "Singapore latency should be <30ms");
});

registerTest("T7-GEO-03", "GEO", 7, "All 6 edge POP regions calculate realistic distance and latency", () => {
  const regions = getEdgeRegions();
  assertEqual(regions.length, 6, "Must have exactly 6 global edge POP regions");

  // Verify SF distance to Frankfurt
  const sfRegion = regions.find((r) => r.id === "sfo1");
  const fraRegion = regions.find((r) => r.id === "fra1");
  assertTrue(!!sfRegion && !!fraRegion, "sfo1 and fra1 regions must exist");

  const dist = calculateDistanceKm(
    sfRegion!.latitude,
    sfRegion!.longitude,
    fraRegion!.latitude,
    fraRegion!.longitude
  );
  assertTrue(dist > 8000 && dist < 10000, `Distance SF-FRA should be ~9000km, got ${dist}`);
});

// ─── 4. Smart Crons (Customer Acquisition & Maintenance) ────────────────────
registerTest("T7-CRON-01", "SMART_CRONS", 7, "Dormant user re-engagement cron identifies candidates and suggests activation tips", async () => {
  const result = await runDormantUserReengagementCron();
  assertEqual(result.status, "SUCCESS");
  assertEqual(result.category, "ACQUISITION");
  assertTrue(result.itemsProcessed >= 3);
  assertTrue(Array.isArray(result.details.alerts));
  assertTrue(result.details.alerts[0].daysInactive >= 7);
});

registerTest("T7-CRON-02", "SMART_CRONS", 7, "Trial conversion cron calculates exact cost savings vs Vercel", async () => {
  const result = await runTrialConversionCron();
  assertEqual(result.status, "SUCCESS");
  assertEqual(result.category, "ACQUISITION");
  assertTrue(result.itemsProcessed >= 2);
  assertTrue(result.details.candidates[0].estimatedMonthlySavingsVsVercel > 100);
});

registerTest("T7-CRON-03", "SMART_CRONS", 7, "Database backup verification cron checks snapshot restorable checksums", async () => {
  const result = await runDatabaseBackupVerificationCron();
  assertEqual(result.status, "SUCCESS");
  assertEqual(result.category, "MAINTENANCE");
  assertTrue(result.details.allSnapshotsValid);
  assertTrue(result.details.reports.every((r: any) => r.restorable));
});

registerTest("T7-CRON-04", "SMART_CRONS", 7, "Edge POP health probe verifies SSL certificates across all 6 POPs", async () => {
  const result = await runEdgePopHealthProbeCron();
  assertEqual(result.status, "SUCCESS");
  assertEqual(result.details.globalPopCount, 6);
  assertTrue(result.details.allPopsHealthy);
});

registerTest("T7-CRON-05", "SMART_CRONS", 7, "WAF threat intelligence cron updates malicious IP blocks", async () => {
  const result = await runWafThreatIntelligenceCron();
  assertEqual(result.status, "SUCCESS");
  assertEqual(result.category, "SECURITY");
  assertTrue(result.details.newMaliciousIpsBlocked > 0);
});

registerTest("T7-CRON-06", "SMART_CRONS", 7, "Master smart cron runner executes filtered categories and full sweep", async () => {
  const acqRun = await executeSmartCrons("ACQUISITION");
  assertEqual(acqRun.results.length, 3);

  const maintRun = await executeSmartCrons("MAINTENANCE");
  assertEqual(maintRun.results.length, 2);

  const fullRun = await executeSmartCrons("ALL");
  assertEqual(fullRun.results.length, 6);
  assertTrue(fullRun.totalDurationMs >= 0);
});

// ─── 5. R&D Strategies & Weekly Trending Features Engine ────────────────────
registerTest("T7-RD-01", "RD_STRATEGIES", 7, "Weekly release pipeline tracks versions v1.0 through v1.5", () => {
  const drops = getWeeklyVersionDrops();
  assertTrue(drops.length >= 6);

  const versions = drops.map((d) => d.version);
  assertIncludes(versions, "v1.0.0");
  assertIncludes(versions, "v1.1.0");
  assertIncludes(versions, "v1.2.0");
  assertIncludes(versions, "v1.3.0");
  assertIncludes(versions, "v1.4.0");
  assertIncludes(versions, "v1.5.0");

  const v13 = drops.find((d) => d.version === "v1.3.0");
  assertTrue(!!v13?.features.some((f) => f.includes("cron")));
});

registerTest("T7-RD-02", "RD_STRATEGIES", 7, "Trending stacks catalog includes Next.js 16, Python AI, Rust, and Go", () => {
  const stacks = getTrendingStacks("ALL");
  assertTrue(stacks.length >= 5);

  const stackNames = stacks.map((s) => s.name);
  assertTrue(stackNames.some((n) => n.includes("Next.js 16")));
  assertTrue(stackNames.some((n) => n.includes("FastAPI")));
  assertTrue(stackNames.some((n) => n.includes("Rust Axum")));
  assertTrue(stackNames.some((n) => n.includes("Go Gin")));
});

registerTest("T7-RD-03", "RD_STRATEGIES", 7, "Strategic R&D insights formulate speed, AI agent, and zero-seat-tax advantages", () => {
  const insights = getStrategicInsights();
  assertTrue(insights.length >= 4);

  const pillars = insights.map((i) => i.pillar);
  assertIncludes(pillars, "SPEED");
  assertIncludes(pillars, "TRENDING_TECH");
  assertIncludes(pillars, "ENTERPRISE_DEMAND");
  assertIncludes(pillars, "AI_AUTOMATION");
});

registerTest("T7-RD-04", "RD_STRATEGIES", 7, "Community feature voting increments tally correctly", () => {
  const initialVotes = getFeatureVotes();
  const targetFeature = initialVotes[0].feature;
  const initialCount = initialVotes[0].votes;

  const voteResult = voteForFeature(targetFeature);
  assertEqual(voteResult.totalVotes, initialCount + 1);

  const updatedVotes = getFeatureVotes();
  const updatedItem = updatedVotes.find((v) => v.feature === targetFeature);
  assertEqual(updatedItem?.votes, initialCount + 1);
});

registerTest("T7-RD-05", "RD_STRATEGIES", 7, "Roadmap voting requires sign-in and counts one vote per user", async () => {
  const anonymous = appRouter.createCaller({
    db: {} as any,
    session: null,
    headers: new Headers(),
  });
  let rejected = false;
  try {
    await anonymous.rd.voteFeature({ feature: "Native Kubernetes Cluster Importer" });
  } catch (err: any) {
    rejected = err?.code === "UNAUTHORIZED";
  }
  assertTrue(rejected, "Unauthenticated vote must be rejected with UNAUTHORIZED");

  const member = appRouter.createCaller({
    db: {} as any,
    session: { user: { id: "t7_rd_voter" }, expires: new Date(Date.now() + 60_000).toISOString() } as any,
    headers: new Headers(),
  });
  const first = await member.rd.voteFeature({ feature: "Native Kubernetes Cluster Importer" });
  assertTrue(first.totalVotes > 0, "Vote count must be positive");
  assertEqual(first.feature, "Native Kubernetes Cluster Importer");
  const second = await member.rd.voteFeature({ feature: "Native Kubernetes Cluster Importer" });
  assertEqual(second.totalVotes, first.totalVotes, "Repeat vote by the same user must not increment");
  assertTrue(second.alreadyVoted === true, "Repeat vote flagged as alreadyVoted");
});

registerTest("T7-GEO-04", "GEO", 7, "Geo router cleanly handles extreme coordinates, South Pole, and NaN inputs", () => {
  // South Pole routes to nearest Southern POP (Sydney syd1)
  const southPole = routeClientRequest({ latitude: -90, longitude: 0 });
  assertEqual(southPole.primaryRegion.id, "syd1", "South Pole should route to Sydney POP");
  assertTrue(!isNaN(southPole.distanceKm), "Distance must not be NaN");
  assertTrue(!isNaN(southPole.estimatedLatencyMs), "Latency must not be NaN");

  // NaN input safely falls back to country coordinates
  const nanInput = routeClientRequest({ latitude: NaN, longitude: NaN, country: "DE" });
  assertEqual(nanInput.primaryRegion.id, "fra1", "NaN coordinates should fall back to country code DE (fra1)");
  assertTrue(!isNaN(nanInput.estimatedLatencyMs), "Estimated latency must be valid number");
});

registerTest("T7-GEO-05", "GEO", 7, "Geo router fails over to DEGRADED region when primary is in OUTAGE", () => {
  try {
    // Set Frankfurt to OUTAGE and London to DEGRADED
    setRegionStatusOverride("fra1", "OUTAGE");
    setRegionStatusOverride("lhr1", "DEGRADED");
    // Also set other regions to OUTAGE to force fallback to DEGRADED lhr1
    setRegionStatusOverride("iad1", "OUTAGE");
    setRegionStatusOverride("sfo1", "OUTAGE");
    setRegionStatusOverride("sin1", "OUTAGE");
    setRegionStatusOverride("syd1", "OUTAGE");

    const decision = routeClientRequest({ country: "DE", city: "Frankfurt" });
    assertEqual(decision.primaryRegion.id, "fra1");
    assertEqual(decision.activeRegion.id, "lhr1", "Must failover to degraded lhr1 when all others are OUTAGE");
    assertTrue(decision.isFailover, "Must flag as failover");
    assertIncludes(decision.failoverReason || "", "LHR1");
  } finally {
    // Reset all region overrides
    setRegionStatusOverride("fra1", "RESET");
    setRegionStatusOverride("lhr1", "RESET");
    setRegionStatusOverride("iad1", "RESET");
    setRegionStatusOverride("sfo1", "RESET");
    setRegionStatusOverride("sin1", "RESET");
    setRegionStatusOverride("syd1", "RESET");
  }
});

registerTest("T7-CRON-07", "SMART_CRONS", 7, "Concurrent execution of smart crons preserves telemetry consistency without collisions", async () => {
  const [runA, runB, runC] = await Promise.all([
    executeSmartCrons("MAINTENANCE"),
    executeSmartCrons("SECURITY"),
    executeSmartCrons("ACQUISITION"),
  ]);

  assertEqual(runA.results.length, 2);
  assertEqual(runB.results.length, 1);
  assertEqual(runC.results.length, 3);
  assertTrue(runA.results.every((r) => r.status === "SUCCESS"));
  assertTrue(runB.results.every((r) => r.status === "SUCCESS"));
  assertTrue(runC.results.every((r) => r.status === "SUCCESS"));
});

