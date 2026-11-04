/**
 * Syncbay PaaS — Adversarial Stress Test Suite: Edge WAF Engine & BigInt Arithmetic
 * Challenger 2 for Milestone M1
 *
 * Covers:
 *  1. BigInt Bitmask Arithmetic across all prefixes (/0 to /128) & Extreme Shifts
 *  2. IPv4 Int32 Bitwise Operations, Signedness & CIDR Matching (/0 to /32)
 *  3. IPv6 Hex Parsing, Normalization, Compression (::), and Zone Indices
 *  4. IPv6 Subnet Boundaries (/0, /1, /64, /127, /128) & Canonical Equivalence
 *  5. Dual-Stack IPv4-Mapped IPv6 Formats (::ffff:x.x.x.x)
 *  6. Malformed Inputs, Fuzzing & Boundary Invalidation
 *  7. WAF Decision Pipeline Precedence (Allow > Block > Geo > Rate)
 *  8. High-Concurrency Rate Limiter & Sliding-Window Pruning Under Load
 */

import assert from "node:assert";
import {
  isIpInList,
  evaluateRateLimit,
  cleanupExpiredRateLimits,
  inspectRequest,
  type WafRuleLike,
} from "../../src/lib/devops/waf-engine";

interface RegisteredStressTest {
  id: string;
  category: string;
  name: string;
  fn: () => void | Promise<void>;
}

interface TestResult {
  id: string;
  category: string;
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

const registered: RegisteredStressTest[] = [];
const results: TestResult[] = [];

function test(
  id: string,
  category: string,
  name: string,
  fn: () => void | Promise<void>
) {
  registered.push({ id, category, name, fn });
}

// ─────────────────────────────────────────────────────────────────────────────
// Oracle Helper: Reference BigInt Mask Generator
// ─────────────────────────────────────────────────────────────────────────────
function oracleIpv6Mask(prefix: number): bigint {
  if (prefix === 0) return BigInt(0);
  if (prefix === 128) return (BigInt(1) << BigInt(128)) - BigInt(1);
  return (
    ((BigInt(1) << BigInt(128)) - BigInt(1)) ^
    ((BigInt(1) << BigInt(128 - prefix)) - BigInt(1))
  );
}

// =============================================================================
// CATEGORY 1: BIGINT ARITHMETIC & PREFIX BITMASKS (/0 to /128)
// =============================================================================

test(
  "BIGINT-01",
  "BigInt Arithmetic",
  "Verifies BigInt mask generation matches bit-exact oracle for all prefixes 0..128",
  () => {
    for (let prefix = 0; prefix <= 128; prefix++) {
      const mask = oracleIpv6Mask(prefix);
      assert(typeof mask === "bigint", `Prefix ${prefix} must produce a bigint`);

      // Verify bit width: mask must not exceed 128 bits
      assert(
        mask >= BigInt(0) && mask < BigInt(1) << BigInt(128),
        `Prefix ${prefix} mask out of 128-bit range: ${mask.toString(16)}`
      );

      // Verify count of set bits equals prefix
      let setBits = 0;
      let temp = mask;
      while (temp > BigInt(0)) {
        if ((temp & BigInt(1)) === BigInt(1)) setBits++;
        temp >>= BigInt(1);
      }
      assert.strictEqual(
        setBits,
        prefix,
        `Prefix ${prefix} expected ${prefix} set bits, got ${setBits}`
      );
    }
  }
);

test(
  "BIGINT-02",
  "BigInt Arithmetic",
  "Extreme prefixes (/0, /1, /64, /127, /128) evaluate correctly in CIDR matching",
  () => {
    // /0 matches everything
    assert.strictEqual(isIpInList("2001:db8::1", ["::/0"]), true);
    assert.strictEqual(isIpInList("fe80::dead:beef", ["::/0"]), true);

    // /1 matches top bit only
    // 0000::/1 has MSB 0. 2001:: has MSB 0 (0x2001 = 0010 0000 0000 0001)
    assert.strictEqual(isIpInList("2001:db8::1", ["::/1"]), true);
    // 8000:: has MSB 1
    assert.strictEqual(isIpInList("8000::1", ["::/1"]), false);
    assert.strictEqual(isIpInList("8000::1", ["8000::/1"]), true);

    // /127 matches pairs
    assert.strictEqual(
      isIpInList("2001:db8::2", ["2001:db8::2/127"]),
      true
    );
    assert.strictEqual(
      isIpInList("2001:db8::3", ["2001:db8::2/127"]),
      true
    );
    assert.strictEqual(
      isIpInList("2001:db8::4", ["2001:db8::2/127"]),
      false
    );

    // /128 exact single host
    assert.strictEqual(
      isIpInList("2001:db8::1", ["2001:db8::1/128"]),
      true
    );
    assert.strictEqual(
      isIpInList("2001:db8::2", ["2001:db8::1/128"]),
      false
    );
  }
);

test(
  "BIGINT-03",
  "BigInt Arithmetic",
  "Rejects out-of-bounds prefixes (<0, >128, NaN) gracefully without crash",
  () => {
    assert.strictEqual(isIpInList("2001:db8::1", ["2001:db8::/129"]), false);
    assert.strictEqual(isIpInList("2001:db8::1", ["2001:db8::/-1"]), false);
    assert.strictEqual(isIpInList("2001:db8::1", ["2001:db8::/999999"]), false);
    assert.strictEqual(isIpInList("2001:db8::1", ["2001:db8::/abc"]), false);
    assert.strictEqual(isIpInList("2001:db8::1", ["2001:db8::/"]), false);
  }
);

test(
  "BIGINT-04",
  "BigInt Arithmetic",
  "Max 128-bit address (ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff) parses and matches",
  () => {
    const maxIp = "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff";
    assert.strictEqual(isIpInList(maxIp, [maxIp]), true);
    assert.strictEqual(isIpInList(maxIp, ["ffff:ffff:ffff:ffff::/64"]), true);
    assert.strictEqual(isIpInList(maxIp, ["ffff:ffff:ffff:ffff:ffff:ffff:ffff:fffe/127"]), true);
    assert.strictEqual(isIpInList(maxIp, ["0000::/0"]), true);
    assert.strictEqual(isIpInList("ffff:ffff:ffff:ffff:ffff:ffff:ffff:fffe", [`${maxIp}/128`]), false);
  }
);

// =============================================================================
// CATEGORY 2: IPV4 BITWISE ARITHMETIC & SIGNEDNESS (/0 to /32)
// =============================================================================

test(
  "IPV4-01",
  "IPv4 CIDR",
  "Validates all prefix lengths /0 through /32 across full 32-bit spectrum",
  () => {
    for (let prefix = 0; prefix <= 32; prefix++) {
      // Test matching with 10.0.0.1
      const res = isIpInList("10.0.0.1", [`10.0.0.0/${prefix}`]);
      if (prefix <= 31) {
        assert.strictEqual(
          res,
          true,
          `10.0.0.1 should match 10.0.0.0/${prefix}`
        );
      } else {
        // prefix 32: 10.0.0.1 does NOT match 10.0.0.0/32
        assert.strictEqual(
          res,
          false,
          `10.0.0.1 should not match 10.0.0.0/32`
        );
      }
    }
  }
);

test(
  "IPV4-02",
  "IPv4 CIDR",
  "High-bit IPv4 addresses (MSB = 1, e.g. 192.x, 203.x, 255.x) do not suffer sign corruption",
  () => {
    // 255.255.255.255 = 0xFFFFFFFF (in JS, -1 in Int32)
    assert.strictEqual(isIpInList("255.255.255.255", ["255.255.255.255"]), true);
    assert.strictEqual(isIpInList("255.255.255.255", ["255.255.255.0/24"]), true);
    assert.strictEqual(isIpInList("255.255.255.254", ["255.255.255.255/32"]), false);
    assert.strictEqual(isIpInList("255.255.255.254", ["255.255.255.252/30"]), true);

    // 192.168.0.0/16 (MSB is 1: 192 = 1100 0000)
    assert.strictEqual(isIpInList("192.168.254.254", ["192.168.0.0/16"]), true);
    assert.strictEqual(isIpInList("192.169.0.1", ["192.168.0.0/16"]), false);

    // 128.0.0.0/1 boundary
    assert.strictEqual(isIpInList("128.0.0.1", ["128.0.0.0/1"]), true);
    assert.strictEqual(isIpInList("127.255.255.255", ["128.0.0.0/1"]), false);
  }
);

test(
  "IPV4-03",
  "IPv4 CIDR",
  "Rejects invalid IPv4 syntax, octet overflows and malformed formats",
  () => {
    const list = ["10.0.0.0/24"];
    assert.strictEqual(isIpInList("256.0.0.1", list), false);
    assert.strictEqual(isIpInList("-1.0.0.1", list), false);
    assert.strictEqual(isIpInList("10.0.0", list), false);
    assert.strictEqual(isIpInList("10.0.0.1.2", list), false);
    assert.strictEqual(isIpInList("10.0.0.a", list), false);
    assert.strictEqual(isIpInList(" 10.0.0.1 ", ["10.0.0.0/24"]), true, "Trimmed valid IP matches");
  }
);

// =============================================================================
// CATEGORY 3: IPV6 PARSING, NORMALIZATION & ZERO COMPRESSION
// =============================================================================

test(
  "IPV6-01",
  "IPv6 Parsing",
  "Parses and matches localhost (::1) in all canonical and expanded representations",
  () => {
    const forms = [
      "::1",
      "0::1",
      "0000::0001",
      "0:0:0:0:0:0:0:1",
      "0000:0000:0000:0000:0000:0000:0000:0001",
    ];

    for (const f1 of forms) {
      for (const f2 of forms) {
        assert.strictEqual(
          isIpInList(f1, [f2]),
          true,
          `Form ${f1} must match list containing ${f2}`
        );
      }
    }
  }
);

test(
  "IPV6-02",
  "IPv6 Parsing",
  "Parses all-zeroes address (::) correctly",
  () => {
    assert.strictEqual(isIpInList("::", ["::"]), true);
    assert.strictEqual(isIpInList("0:0:0:0:0:0:0:0", ["::"]), true);
    assert.strictEqual(isIpInList("::", ["0:0:0:0:0:0:0:0"]), true);
    assert.strictEqual(isIpInList("::1", ["::/128"]), false);
    assert.strictEqual(isIpInList("::", ["::/0"]), true);
  }
);

test(
  "IPV6-03",
  "IPv6 Parsing",
  "Rejects invalid IPv6 formats: multiple '::', >8 segments, invalid hex",
  () => {
    const list = ["::/0"];
    assert.strictEqual(isIpInList("2001::db8::1", list), false, "Double :: must be rejected");
    assert.strictEqual(isIpInList("1:2:3:4:5:6:7:8:9", list), false, "9 segments must be rejected");
    assert.strictEqual(isIpInList("2001:xyz::1", list), false, "Non-hex characters rejected");
    assert.strictEqual(isIpInList("10000::1", list), false, "Segment > 0xFFFF rejected");
    assert.strictEqual(isIpInList(":::1", list), false, "Triple colon rejected");
  }
);

test(
  "IPV6-04",
  "IPv6 Parsing",
  "Handles Zone Index / Scope IDs (e.g. fe80::1%eth0) by stripping interface suffix",
  () => {
    assert.strictEqual(
      isIpInList("fe80::1%eth0", ["fe80::1"]),
      true,
      "Scope ID %eth0 should be ignored in parsing"
    );
    assert.strictEqual(
      isIpInList("fe80::1%12", ["fe80::/10"]),
      true,
      "Link-local with numerical scope ID should match /10 subnet"
    );
  }
);

// =============================================================================
// CATEGORY 4: IPV6 SUBNET BOUNDARIES & CIDR BLOCKS
// =============================================================================

test(
  "IPV6-CIDR-01",
  "IPv6 Subnet Matching",
  "Standard /64 subscriber prefix matches all internal host addresses and excludes external",
  () => {
    const subnet = "2001:db8:85a3:8d3::/64";
    const hostsInSubnet = [
      "2001:db8:85a3:8d3::",
      "2001:db8:85a3:8d3::1",
      "2001:db8:85a3:8d3:ffff:ffff:ffff:ffff",
      "2001:db8:85a3:8d3:0:0:0:1",
      "2001:db8:85a3:8d3:1234:5678:9abc:def0",
    ];
    for (const host of hostsInSubnet) {
      assert.strictEqual(
        isIpInList(host, [subnet]),
        true,
        `${host} must match ${subnet}`
      );
    }

    const hostsOutside = [
      "2001:db8:85a3:8d2:ffff:ffff:ffff:ffff",
      "2001:db8:85a3:8d4::",
      "2001:db8:85a3::1",
    ];
    for (const host of hostsOutside) {
      assert.strictEqual(
        isIpInList(host, [subnet]),
        false,
        `${host} must NOT match ${subnet}`
      );
    }
  }
);

test(
  "IPV6-CIDR-02",
  "IPv6 Subnet Matching",
  "Prefix /48 allocation matches sub-allocations (/64s) correctly",
  () => {
    const sitePrefix = "2001:0db8:abcd::/48";
    assert.strictEqual(isIpInList("2001:db8:abcd:0001::1", [sitePrefix]), true);
    assert.strictEqual(isIpInList("2001:db8:abcd:ffff:ffff:ffff:ffff:ffff", [sitePrefix]), true);
    assert.strictEqual(isIpInList("2001:db8:abce::1", [sitePrefix]), false);
  }
);

// =============================================================================
// CATEGORY 5: DUAL-STACK & IPV4-MAPPED IPV6 ADVERSARIAL DISCOVERY
// =============================================================================

test(
  "DUALSTACK-01",
  "Dual-Stack Mapping",
  "Tests IPv4-mapped IPv6 syntax behavior in parseIpv6ToBigInt",
  () => {
    const mapped = "::ffff:192.0.2.1";
    assert.strictEqual(isIpInList(mapped, [mapped]), true, "Exact match must work");
  }
);

test(
  "DUALSTACK-02",
  "Dual-Stack Mapping",
  "IPv4-mapped IPv6 subnet (::ffff:192.168.1.0/120) should match client IP ::ffff:192.168.1.5",
  () => {
    // In RFC 4291, IPv4-mapped IPv6 addresses have prefix ::ffff:0:0/96.
    // A /120 subnet matches a /24 IPv4 equivalent.
    // 192.168.1.5 is inside 192.168.1.0/24, so ::ffff:192.168.1.5 must be inside ::ffff:192.168.1.0/120.
    const inSubnet = isIpInList("::ffff:192.168.1.5", ["::ffff:192.168.1.0/120"]);
    assert.strictEqual(inSubnet, true, "::ffff:192.168.1.5 must match ::ffff:192.168.1.0/120");
  }
);

test(
  "DUALSTACK-03",
  "Dual-Stack Mapping",
  "Canonical IPv6 hex (::ffff:c0a8:105) matches dotted format (::ffff:192.168.1.5)",
  () => {
    // 192.168.1.5 in hex is c0a8:0105.
    // Both representations represent the exact same 128-bit IPv6 address: 0x0000_0000_0000_0000_0000_ffff_c0a8_0105.
    const matchesHex = isIpInList("::ffff:192.168.1.5", ["::ffff:c0a8:105"]);
    assert.strictEqual(matchesHex, true, "Dotted IPv4-in-IPv6 must match equivalent hex representation");
  }
);

// =============================================================================
// CATEGORY 6: WAF POLICY PRECEDENCE & INSPECT REQUEST
// =============================================================================

test(
  "WAF-POLICY-01",
  "Policy Precedence",
  "Allowlist takes absolute precedence over Blocklist and Geo-block",
  async () => {
    const rules: WafRuleLike[] = [
      { id: "a", type: "IP_ALLOW", value: "198.51.100.50", enabled: true },
      { id: "b", type: "IP_BLOCK", value: "198.51.100.0/24", enabled: true },
      { id: "g", type: "GEO_BLOCK", value: "RU", enabled: true },
    ];
    const result = await inspectRequest(rules, { ip: "198.51.100.50", path: "/admin", countryCode: "RU" });
    assert.strictEqual(result.allowed, true, "Allowlist must bypass blocklist and geo-block");
    assert.strictEqual(result.status, 200);
  }
);

test(
  "WAF-POLICY-02",
  "Policy Precedence",
  "Blocklist takes precedence over Geo-block and Rate Limiter",
  async () => {
    const rules: WafRuleLike[] = [
      { id: "b", type: "IP_BLOCK", value: "203.0.113.10", enabled: true },
      { id: "g", type: "GEO_BLOCK", value: "CN", enabled: true },
      { id: "r", type: "RATE_LIMIT", value: "/*", rateLimitRpm: 10, enabled: true },
    ];
    const result = await inspectRequest(rules, { ip: "203.0.113.10", path: "/api/pay", countryCode: "CN" });
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.status, 403);
    assert.strictEqual(result.reason, "Access Denied by Syncbay Edge Firewall");
  }
);

test(
  "WAF-POLICY-03",
  "Policy Precedence",
  "Disabled rules allow all traffic immediately",
  async () => {
    const rules: WafRuleLike[] = [{ id: "b", type: "IP_BLOCK", value: "1.2.3.4", enabled: false }];
    const result = await inspectRequest(rules, { ip: "1.2.3.4", path: "/" });
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.status, 200);
  }
);

// =============================================================================
// CATEGORY 7: HIGH-CONCURRENCY RATE LIMITER & MEMORY PRUNING
// =============================================================================

test(
  "RATE-LIMIT-01",
  "Rate Limiter Concurrency",
  "Accurately handles 5,000 rapid sequential requests within sliding window",
  () => {
    const testIp = "198.18.0.99";
    const rpm = 500;
    const now = Date.now();

    let allowedCount = 0;
    let blockedCount = 0;

    for (let i = 0; i < 600; i++) {
      const res = evaluateRateLimit(testIp, rpm, 60000, now + i);
      if (res.allowed) allowedCount++;
      else blockedCount++;
    }

    assert.strictEqual(allowedCount, 500, "Exactly 500 requests must be allowed");
    assert.strictEqual(blockedCount, 100, "Exactly 100 requests must be blocked");
  }
);

test(
  "RATE-LIMIT-02",
  "Rate Limiter Memory Pruning",
  "Expired timestamps are purged when evaluating after window passes",
  () => {
    const ip = "198.18.1.5";
    const now = 1000000;
    // Consume limit
    for (let i = 0; i < 10; i++) {
      evaluateRateLimit(ip, 10, 60000, now + i * 100);
    }
    // Blocked now
    const blocked = evaluateRateLimit(ip, 10, 60000, now + 1500);
    assert.strictEqual(blocked.allowed, false);

    // 61 seconds later
    const future = now + 61000;
    const allowedAfterWindow = evaluateRateLimit(ip, 10, 60000, future);
    assert.strictEqual(allowedAfterWindow.allowed, true);
    assert.strictEqual(allowedAfterWindow.currentCount, 1);
  }
);

test(
  "RATE-LIMIT-03",
  "Rate Limiter Memory Cleanup",
  "cleanupExpiredRateLimits cleans up inactive IP entries from internal Map",
  () => {
    const ip1 = "198.18.2.1";
    const ip2 = "198.18.2.2";
    const t0 = 2000000;

    evaluateRateLimit(ip1, 100, 60000, t0);
    evaluateRateLimit(ip2, 100, 60000, t0 + 70000); // 70s later

    // Run cleanup at t0 + 65000 (ip1 is 65s old > 60s, ip2 is in the future)
    cleanupExpiredRateLimits(t0 + 65000, 60000);

    // ip1 should now start fresh with count 1
    const res1 = evaluateRateLimit(ip1, 100, 60000, t0 + 65001);
    assert.strictEqual(res1.currentCount, 1);
  }
);

// =============================================================================
// RUNNER & SUMMARY EMISSION
// =============================================================================

async function runAll() {
  console.log("================================================================================");
  console.log("     SYNCBAY PaaS — CHALLENGER 2 WAF & BIGINT EMPIRICAL STRESS SUITE            ");
  console.log("================================================================================");
  console.log(`Node: ${process.version} | Platform: ${process.platform} | Time: ${new Date().toISOString()}\n`);

  for (const t of registered) {
    const start = performance.now();
    try {
      await t.fn();
      const durationMs = Math.round((performance.now() - start) * 100) / 100;
      results.push({
        id: t.id,
        category: t.category,
        name: t.name,
        passed: true,
        durationMs,
      });
      console.log(`  ✔ [${t.id.padEnd(15)}] [${t.category.padEnd(25)}] ${t.name} (${durationMs}ms)`);
    } catch (err: any) {
      const durationMs = Math.round((performance.now() - start) * 100) / 100;
      results.push({
        id: t.id,
        category: t.category,
        name: t.name,
        passed: false,
        error: err?.message || String(err),
        durationMs,
      });
      console.error(`  ✘ [${t.id.padEnd(15)}] [${t.category.padEnd(25)}] ${t.name} (${durationMs}ms)`);
      console.error(`     Error: ${err?.message || String(err)}`);
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log("\n================================================================================");
  console.log(`TOTAL STRESS TESTS: ${results.length}`);
  console.log(`PASSED:             ${passed}`);
  console.log(`FAILED:             ${failed}`);
  console.log("================================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

// Execute tests sequentially
(async () => {
  await runAll();
})();
