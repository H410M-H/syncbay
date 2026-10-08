/**
 * Syncbay PaaS — Master E2E Test Runner
 * Executes all tiers of opaque-box requirement tests:
 * - Foundational PaaS Features (F1 to F20)
 * - Enterprise Upgrade Features (F01 to F16)
 * - Tiers 1 through 6:
 *   - Tier 1: Feature Coverage (>=5 per feature)
 *   - Tier 2: Boundary & Corner Cases (>=5 per feature)
 *   - Tier 3: Pairwise Cross-Feature Interactions
 *   - Tier 4: Real-World Application Scenarios
 *   - Tier 5: Next Modules up to M7 (Edge, CLI, Shell, Studio, Geo/SEO)
 *   - Tier 6: DevOps Hyper-Plane (WAF, Crons, Canary, RBAC, Plans & US Compliance)
 *
 * Usage:
 *   npx tsx tests/e2e/run-all.ts
 *   npx tsx tests/e2e/run-all.ts --tier=1
 *   npx tsx tests/e2e/run-all.ts --tier=4
 *   npx tsx tests/e2e/run-all.ts --feature=F01
 */

import { registry, type TestCase, type TestResult } from "../harness";

// Import all tier test suites
import "./tier1.test";
import "./tier2.test";
import "./tier3.test";
import "./tier4.test";
import "./tier5-next-modules.test";
import "./tier6-devops-pricing-rbac.test";
import "./tier-enterprise.test";
import "./tier7-all-modules-seo-geo-crons-rd.test";
import "./tier8-card-payments-billing.test";
import "./tier9-brand-logo-and-seo.test";

// Import Hybrid Compute & Edge Routing test suites (R1–R5, Features 1–18)
import "./tier1-hybrid.test";
import "./tier2-hybrid.test";
import "./tier3-hybrid.test";
import "./tier4-hybrid.test";
import "./tier5-hybrid-adversarial.test";
import "./tier5-adversarial.test";

// Parse CLI arguments
const args = process.argv.slice(2);
const tierArg = args.find((a) => a.startsWith("--tier="))?.split("=")[1];
const featureArg = args.find((a) => a.startsWith("--feature="))?.split("=")[1];

const filterTier = tierArg ? parseInt(tierArg, 10) : undefined;
const filterFeature = featureArg || undefined;

const TIER_TITLES: Record<number, string> = {
  1: "Tier 1 — Feature Coverage (F1 to F20 & Enterprise F01 to F16)",
  2: "Tier 2 — Boundary & Corner Cases (F1 to F20 & Enterprise Edge Cases)",
  3: "Tier 3 — Pairwise Cross-Feature Combinations & Integrations",
  4: "Tier 4 — Real-World Application Scenarios (Enterprise Onboarding, Rollback & DevOps)",
  5: "Tier 5 — Next Modules up to M7 (M5 Edge, M6 CLI/OpenAPI, M7 Shell/Studio, GEO & SEO)",
  6: "Tier 6 — DevOps Hyper-Plane, WAF, Crons, Canary, RBAC, Plans & US Compliance",
  7: "Tier 7 — Sub-Services & Modules, SEO/GEO Ranking, Smart Crons & Weekly R&D Strategy",
  8: "Tier 8 — Credit/Debit Card Payments, PCI Tokenization, Invoice Settlement & Cloud Credits",
  9: "Tier 9 — Brand Logo, Vercel Avatar Integration, PWA & Global SEO Rankings",
};

async function runSuite() {
  const startTime = Date.now();
  console.log("================================================================================");
  console.log("             SYNCBAY PaaS — COMPREHENSIVE E2E TEST RUNNER                      ");
  console.log("================================================================================");
  console.log(`Node: ${process.version} | Platform: ${process.platform} | Time: ${new Date().toISOString()}`);
  if (filterTier) console.log(`Filter: Tier ${filterTier}`);
  if (filterFeature) console.log(`Filter: Feature ${filterFeature}`);
  console.log("--------------------------------------------------------------------------------\n");

  const allTests = registry.getTests({ tier: filterTier, feature: filterFeature });
  if (allTests.length === 0) {
    console.warn("No tests matched the specified filter criteria.");
    process.exit(0);
  }

  const results: TestResult[] = [];
  let currentTier = -1;

  for (const test of allTests) {
    if (test.tier !== currentTier) {
      currentTier = test.tier;
      console.log(`\n▶ ${TIER_TITLES[currentTier] || `Tier ${currentTier}`}`);
      console.log("─".repeat(80));
    }

    const tStart = Date.now();
    try {
      await test.run();
      const durationMs = Date.now() - tStart;
      results.push({
        id: test.id,
        name: test.name,
        tier: test.tier,
        feature: test.feature,
        passed: true,
        durationMs,
      });
      console.log(`  ✔ [${test.id.padEnd(17)}] [${test.feature.padEnd(10)}] ${test.name} (${durationMs}ms)`);
    } catch (err: any) {
      const durationMs = Date.now() - tStart;
      results.push({
        id: test.id,
        name: test.name,
        tier: test.tier,
        feature: test.feature,
        passed: false,
        error: err,
        durationMs,
      });
      console.error(`  ✘ [${test.id.padEnd(17)}] [${test.feature.padEnd(10)}] ${test.name} (${durationMs}ms)`);
      console.error(`    Error: ${err.message}`);
      if (err.stack) {
        console.error(`    ${err.stack.split("\n")[1]?.trim() || ""}`);
      }
    }
  }

  const totalDuration = Date.now() - startTime;
  const passedCount = results.filter((r) => r.passed).length;
  const failedCount = results.filter((r) => !r.passed).length;

  console.log("\n================================================================================");
  console.log("                             TEST EXECUTION SUMMARY                             ");
  console.log("================================================================================");

  // Per-Tier Summary Table
  console.log("\n  Tier Breakdown:");
  console.log("  ┌────────┬────────────────────────────────────────────────────────┬───────┬────────┬────────┐");
  console.log("  │ Tier   │ Description                                            │ Total │ Passed │ Failed │");
  console.log("  ├────────┼────────────────────────────────────────────────────────┼───────┼────────┼────────┤");

  const tierNumbers = [1, 2, 3, 4, 5, 6].filter((t) => !filterTier || t === filterTier);
  for (const t of tierNumbers) {
    const tierResults = results.filter((r) => r.tier === t);
    const total = tierResults.length;
    const passed = tierResults.filter((r) => r.passed).length;
    const failed = tierResults.filter((r) => !r.passed).length;
    const title = (TIER_TITLES[t] || "").split(" — ")[1] || `Tier ${t}`;
    console.log(
      `  │ Tier ${t} │ ${title.padEnd(54)} │ ${String(total).padStart(5)} │ ${String(passed).padStart(6)} │ ${String(failed).padStart(6)} │`
    );
  }
  console.log("  └────────┴────────────────────────────────────────────────────────┴───────┴────────┴────────┘");

  // Enterprise Feature Checklist (F01 through F16)
  const enterpriseFeatures = [
    "F01", "F02", "F03", "F04", "F05", "F06", "F07", "F08",
    "F09", "F10", "F11", "F12", "F13", "F14", "F15", "F16",
  ];
  console.log("\n  Enterprise Upgrade Feature Inventory (F01 to F16):");
  console.log("  ┌─────────┬────────┬────────┬────────┬────────┬─────────┐");
  console.log("  │ Feature │ Tier 1 │ Tier 2 │ Tier 3 │ Tier 4 │ Status  │");
  console.log("  ├─────────┼────────┼────────┼────────┼────────┼─────────┤");

  for (const f of enterpriseFeatures) {
    const t1 = results.filter((r) => r.feature === f && r.tier === 1);
    const t2 = results.filter((r) => r.feature === f && r.tier === 2);
    const t3 = results.filter((r) => r.feature.includes(f) && r.tier === 3);
    const t4 = results.filter((r) => r.feature.includes(f) && r.tier === 4);

    const fPassed = results.filter((r) => r.feature.includes(f) && !r.passed).length === 0;
    const status = fPassed ? "PASS ✔" : "FAIL ✘";

    console.log(
      `  │ ${f.padEnd(7)} │ ${String(t1.length).padStart(6)} │ ${String(t2.length).padStart(6)} │ ${String(t3.length).padStart(6)} │ ${String(t4.length > 0 ? "✓" : "-").padStart(6)} │ ${status.padEnd(7)} │`
    );
  }
  console.log("  └─────────┴────────┴────────┴────────┴────────┴─────────┘");

  // Foundational Feature Checklist (F1 through F20)
  const foundationalFeatures = Array.from({ length: 20 }, (_, i) => `F${i + 1}`);
  console.log("\n  Foundational Platform Feature Coverage (F1 to F20):");
  console.log("  ┌─────────┬────────┬────────┬────────┬────────┬─────────┐");
  console.log("  │ Feature │ Tier 1 │ Tier 2 │ Tier 3 │ Tier 4 │ Status  │");
  console.log("  ├─────────┼────────┼────────┼────────┼────────┼─────────┤");

  for (const f of foundationalFeatures) {
    const t1 = results.filter((r) => r.feature === f && r.tier === 1);
    const t2 = results.filter((r) => r.feature === f && r.tier === 2);
    const t3 = results.filter((r) => r.feature.includes(f) && r.tier === 3);
    const t4 = results.filter((r) => r.tier === 4);

    const fPassed = results.filter((r) => r.feature.includes(f) && !r.passed).length === 0;
    const status = fPassed ? "PASS ✔" : "FAIL ✘";

    console.log(
      `  │ ${f.padEnd(7)} │ ${String(t1.length).padStart(6)} │ ${String(t2.length).padStart(6)} │ ${String(t3.length).padStart(6)} │ ${String(t4.length > 0 ? "✓" : "-").padStart(6)} │ ${status.padEnd(7)} │`
    );
  }
  console.log("  └─────────┴────────┴────────┴────────┴────────┴─────────┘");

  // Hybrid Compute & Edge Routing Feature Inventory (HYB-F01 through HYB-F18 across R1–R5)
  const hybridFeatures = Array.from({ length: 18 }, (_, i) => `HYB-F${String(i + 1).padStart(2, "0")}`);
  console.log("\n  Hybrid Compute & Edge Routing Feature Inventory (R1 to R5 / HYB-F01 to HYB-F18):");
  console.log("  ┌─────────┬────────┬────────┬────────┬────────┬─────────┐");
  console.log("  │ Feature │ Tier 1 │ Tier 2 │ Tier 3 │ Tier 4 │ Status  │");
  console.log("  ├─────────┼────────┼────────┼────────┼────────┼─────────┤");

  for (const f of hybridFeatures) {
    const t1 = results.filter((r) => r.feature === f && r.tier === 1);
    const t2 = results.filter((r) => r.feature === f && r.tier === 2);
    const t3 = results.filter((r) => r.feature.includes(f.replace("HYB-", "")) && r.tier === 3);
    const t4 = results.filter((r) => r.tier === 4);

    const fPassed = results.filter((r) => r.feature.includes(f) && !r.passed).length === 0;
    const status = fPassed ? "PASS ✔" : "FAIL ✘";

    console.log(
      `  │ ${f.padEnd(7)} │ ${String(t1.length).padStart(6)} │ ${String(t2.length).padStart(6)} │ ${String(t3.length).padStart(6)} │ ${String(t4.length > 0 ? "✓" : "-").padStart(6)} │ ${status.padEnd(7)} │`
    );
  }
  console.log("  └─────────┴────────┴────────┴────────┴────────┴─────────┘");

  console.log("\n--------------------------------------------------------------------------------");
  console.log(`TOTAL TESTS:   ${results.length}`);
  console.log(`PASSED:        ${passedCount}`);
  console.log(`FAILED:        ${failedCount}`);
  console.log(`TOTAL TIME:    ${(totalDuration / 1000).toFixed(2)}s`);
  console.log("================================================================================\n");

  if (failedCount > 0) {
    console.error(`💥 TEST SUITE FAILED with ${failedCount} failure(s).\n`);
    process.exit(1);
  } else {
    console.log("✨ ALL E2E TESTS PASSED SUCCESSFULLY! (Exit Code 0)\n");
    process.exit(0);
  }
}

runSuite().catch((err) => {
  console.error("Fatal runner error:", err);
  process.exit(1);
});
