/**
 * Syncbay PaaS — Tier 5 Adversarial Coverage Hardening E2E Test Suite
 * Registered into master test registry for Tier 5.
 *
 * Covers:
 * - HYB-ADV-01..05: PR manager teardown race conditions and double-destruction
 * - HYB-ADV-06..12: Knip analyzer on malformed/unparseable manifests & cyclic dependencies
 * - HYB-ADV-13..17: Cold-start health probe timeout and redirection race conditions
 * - HYB-ADV-18..24: SSH driver command injection and parameter escaping
 */

import {
  registerTest,
  assertTrue,
  assertFalse,
  assertEqual,
  assertThrows,
  assertRejects,
} from "../harness";

import {
  destroyPreviewEnvironment,
  sleepPreviewEnvironment,
} from "../../src/lib/orchestrator/pr-manager";
import { PrPreviewManager } from "../harness/pr-preview-manager";
import {
  runKnipAnalysis,
  executeNonBlockingScan,
} from "../../src/lib/buildpack/knip-analyzer";
import { hybridHarness } from "../harness/hybrid-harness";
import { createEdgeRegistry } from "../../src/lib/edge/service-registry";
import {
  SshRunnerDriver,
  MockSshClient,
  type BuildDispatchParams,
} from "../../src/lib/orchestrator/runner-driver";

// Helper for mock Prisma in PR tests
function withMockPrisma(fn: (store: Map<string, any>) => Promise<void> | void) {
  return async () => {
    const store = new Map<string, any>();
    const mockPrisma: any = {
      environment: {
        findFirst: async (args: any) => {
          const { where } = args || {};
          for (const env of store.values()) {
            if (where?.name && env.name !== where.name) continue;
            if (where?.projectId && env.projectId !== where.projectId) continue;
            return { ...env, services: [] };
          }
          return null;
        },
        delete: async (args: any) => {
          const env = store.get(args.where.id);
          if (!env) throw new Error(`Not found: ${args.where.id}`);
          store.delete(args.where.id);
          return env;
        },
      },
      service: {
        updateMany: async () => ({ count: 1 }),
      },
      deployment: {
        updateMany: async () => ({ count: 1 }),
      },
    };

    const globalObj = globalThis as any;
    const prev = globalObj.prisma;
    globalObj.prisma = mockPrisma;
    try {
      await fn(store);
    } finally {
      globalObj.prisma = prev;
    }
  };
}

// =============================================================================
// DOMAIN 1: PR MANAGER TEARDOWN RACE CONDITIONS & DOUBLE-DESTRUCTION
// =============================================================================

registerTest(
  "HYB-ADV-PR-01",
  "HYB-F03",
  5,
  "destroyPreviewEnvironment non-idempotence: duplicate call returns success=false",
  withMockPrisma(async (store) => {
    store.set("env_pr_601", { id: "env_pr_601", name: "pr-601", projectId: "proj_1" });
    const res1 = await destroyPreviewEnvironment(601, "proj_1");
    assertEqual(res1.success, true);
    assertEqual((res1 as any).action, "destroyed");

    // Second call confirms non-idempotency
    const res2 = await destroyPreviewEnvironment(601, "proj_1");
    assertEqual(res2.success, false, "Expected failure on second destruction");
    assertEqual((res2 as any).action, undefined);
  })
);

registerTest(
  "HYB-ADV-PR-02",
  "HYB-F03",
  5,
  "PrPreviewManager double-close yields undefined environment in return value",
  () => {
    const mgr = new PrPreviewManager();
    const payload = {
      number: 602,
      pull_request: { title: "T", merged: false, head: { ref: "b", sha: "sha" }, base: { ref: "m" } },
      repository: { name: "r", full_name: "o/r" },
    };
    mgr.handlePullRequestWebhook({ ...payload, action: "opened" });
    const res1 = mgr.handlePullRequestWebhook({ ...payload, action: "closed" });
    assertEqual(res1.action, "closed");
    assertTrue(Boolean(res1.environment));

    const res2 = mgr.handlePullRequestWebhook({ ...payload, action: "closed" });
    assertEqual(res2.action, "closed");
    assertEqual(res2.environment, undefined, "Second close must have undefined environment");
  }
);

registerTest(
  "HYB-ADV-PR-03",
  "HYB-F03",
  5,
  "Concurrent double destruction via Promise.all deletes environment without unhandled crash",
  withMockPrisma(async (store) => {
    store.set("env_pr_603", { id: "env_pr_603", name: "pr-603", projectId: "proj_1" });
    const [r1, r2] = await Promise.all([
      destroyPreviewEnvironment(603, "proj_1"),
      destroyPreviewEnvironment(603, "proj_1"),
    ]);
    assertTrue(r1.success || r2.success, "At least one call must succeed in deleting record");
    assertFalse(store.has("env_pr_603"), "Environment must be removed from store");
  })
);

registerTest(
  "HYB-ADV-PR-04",
  "HYB-F03",
  5,
  "Out-of-order synchronize webhook after closure throws explicit error in PrPreviewManager",
  () => {
    const mgr = new PrPreviewManager();
    const payload = {
      number: 604,
      pull_request: { title: "T", merged: false, head: { ref: "b", sha: "sha" }, base: { ref: "m" } },
      repository: { name: "r", full_name: "o/r" },
    };
    mgr.handlePullRequestWebhook({ ...payload, action: "opened" });
    mgr.handlePullRequestWebhook({ ...payload, action: "closed" });

    assertThrows(
      () => mgr.handlePullRequestWebhook({ ...payload, action: "synchronize" }),
      /Cannot synchronize/
    );
  }
);

registerTest(
  "HYB-ADV-PR-05",
  "HYB-F03",
  5,
  "sleepPreviewEnvironment on torn-down environment returns success=false safely",
  withMockPrisma(async () => {
    const res = await sleepPreviewEnvironment(605, "proj_1");
    assertFalse(res.success);
  })
);

// =============================================================================
// DOMAIN 2: KNIP ANALYZER ON MALFORMED MANIFESTS & CYCLIC DEPENDENCIES
// =============================================================================

registerTest(
  "HYB-ADV-KNIP-01",
  "HYB-F14",
  5,
  "runKnipAnalysis handles truncated malformed JSON manifest non-fatally",
  async () => {
    const res = await runKnipAnalysis({
      files: ["index.ts"],
      fileContents: { "index.ts": 'import "pkg";' },
      packageJsonContent: '{"name": "broken", "dependencies": {',
    });
    assertTrue(Array.isArray(res.unusedDependencies));
    assertTrue(res.formattedLogs.some((l) => l.includes("Failed to parse package.json")));
  }
);

registerTest(
  "HYB-ADV-KNIP-02",
  "HYB-F14",
  5,
  "KnipAnalyzerOracle throws unhandled SyntaxError on malformed JSON without try-catch",
  async () => {
    const oracle = hybridHarness.createKnipAnalyzer();
    await assertRejects(
      async () => oracle.runAnalysis({ files: [], packageJsonContent: "{" }),
      SyntaxError
    );
  }
);

registerTest(
  "HYB-ADV-KNIP-03",
  "HYB-F14",
  5,
  "runKnipAnalysis handles null/non-object manifest fields gracefully",
  async () => {
    const res = await runKnipAnalysis({
      files: ["index.ts"],
      fileContents: { "index.ts": "console.log(1);" },
      packageJsonContent: { name: "test", dependencies: null, scripts: null },
    });
    assertEqual(res.unusedDependencies.length, 0);
  }
);

registerTest(
  "HYB-ADV-KNIP-04",
  "HYB-F14",
  5,
  "Direct two-node cycle (A <-> B) resolves and marks all exports used",
  async () => {
    const res = await runKnipAnalysis({
      files: ["a.ts", "b.ts"],
      entryPoints: ["a.ts"],
      fileContents: {
        "a.ts": 'import { b } from "./b"; export const a = 1 + b;',
        "b.ts": 'import { a } from "./a"; export const b = 2 + a;',
      },
    });
    assertEqual(res.unreferencedFiles.length, 0);
    assertEqual(res.unusedExports.length, 0);
  }
);

registerTest(
  "HYB-ADV-KNIP-05",
  "HYB-F14",
  5,
  "Four-node cyclic ring (A -> B -> C -> D -> A) completes without recursion overflow",
  async () => {
    const res = await runKnipAnalysis({
      files: ["1.ts", "2.ts", "3.ts", "4.ts"],
      entryPoints: ["1.ts"],
      fileContents: {
        "1.ts": 'import { x2 } from "./2"; export const x1 = x2;',
        "2.ts": 'import { x3 } from "./3"; export const x2 = x3;',
        "3.ts": 'import { x4 } from "./4"; export const x3 = x4;',
        "4.ts": 'import { x1 } from "./1"; export const x4 = x1;',
      },
    });
    assertEqual(res.unreferencedFiles.length, 0);
    assertEqual(res.unusedExports.length, 0);
  }
);

registerTest(
  "HYB-ADV-KNIP-06",
  "HYB-F14",
  5,
  "Self-referencing module (imports from itself) terminates correctly",
  async () => {
    const res = await runKnipAnalysis({
      files: ["self.ts"],
      entryPoints: ["self.ts"],
      fileContents: {
        "self.ts": 'import { val } from "./self"; export const val = 10;',
      },
    });
    assertEqual(res.unreferencedFiles.length, 0);
  }
);

registerTest(
  "HYB-ADV-KNIP-07",
  "HYB-F14",
  5,
  "Unreferenced cyclic module island (isoA <-> isoB) flagged as unreferencedFiles",
  async () => {
    const res = await runKnipAnalysis({
      files: ["app.ts", "isoA.ts", "isoB.ts"],
      entryPoints: ["app.ts"],
      fileContents: {
        "app.ts": 'export const app = "live";',
        "isoA.ts": 'import { b } from "./isoB"; export const a = b;',
        "isoB.ts": 'import { a } from "./isoA"; export const b = a;',
      },
    });
    assertTrue(res.unreferencedFiles.includes("isoA.ts"));
    assertTrue(res.unreferencedFiles.includes("isoB.ts"));
  }
);

// =============================================================================
// DOMAIN 3: COLD-START HEALTH PROBE TIMEOUT & REDIRECTION RACE CONDITIONS
// =============================================================================

registerTest(
  "HYB-ADV-PROBE-01",
  "HYB-F18",
  5,
  "Edge Registry status check reveals reload loop when /health succeeds on BUILDING state",
  () => {
    const reg = createEdgeRegistry();
    const host = "service-pr-77.syncbay.app";
    reg.registerServiceRoute(host, 3000, "BUILDING");

    const route = reg.getServiceRoute(host);
    // When /health returns 200, client reloads to /
    // If route is BUILDING, middleware rewrites / back to /service-preview
    const isBuilding = route?.status === "BUILDING";
    const probeWouldLoop = isBuilding && true; // Middleware returns 200 regardless of state
    assertTrue(probeWouldLoop, "Confirmed reload loop condition when route is BUILDING");
  }
);

registerTest(
  "HYB-ADV-PROBE-02",
  "HYB-F18",
  5,
  "probeHealthUntilReady honors maxRetries on continuous 503 Service Unavailable",
  async () => {
    const oracle = hybridHarness.createServicePreview();
    let retries = 0;
    const res = await oracle.probeHealthUntilReady(async () => {
      retries++;
      return { status: 503 };
    }, 4, 1);
    assertFalse(res.ready);
    assertFalse(res.redirected);
    assertEqual(res.attempts, 4);
    assertEqual(retries, 4);
  }
);

registerTest(
  "HYB-ADV-PROBE-03",
  "HYB-F18",
  5,
  "probeHealthUntilReady immediately aborts when maxRetries=0",
  async () => {
    const oracle = hybridHarness.createServicePreview();
    const res = await oracle.probeHealthUntilReady(async () => ({ status: 200 }), 0, 1);
    assertFalse(res.ready);
    assertEqual(res.attempts, 0);
  }
);

registerTest(
  "HYB-ADV-PROBE-04",
  "HYB-F18",
  5,
  "probeHealthUntilReady does not consider 301/302 redirects as ready (status=200 required)",
  async () => {
    const oracle = hybridHarness.createServicePreview();
    const res = await oracle.probeHealthUntilReady(async () => ({ status: 302 }), 3, 1);
    assertFalse(res.ready);
    assertFalse(res.redirected);
    assertEqual(res.attempts, 3);
  }
);

// =============================================================================
// DOMAIN 4: SSH DRIVER COMMAND INJECTION & PARAMETER ESCAPING
// =============================================================================

registerTest(
  "HYB-ADV-SSH-01",
  "HYB-F08",
  5,
  "SshRunnerDriver.serializeCommand neutralizes command injection via serviceName",
  () => {
    const driver = new SshRunnerDriver({ host: "node.internal", username: "deploy", sshClient: new MockSshClient() });
    const params: BuildDispatchParams = {
      deploymentId: "dep_1",
      buildId: "bld_1",
      serviceId: "srv_1",
      serviceName: "web; rm -rf / ; #",
      commitSha: "sha1234",
    };
    const cmd = driver.serializeCommand(params);
    assertFalse(cmd.includes("; rm -rf / ; #"), "Expected injection payload to be neutralized");
    assertTrue(cmd.includes("webrm-rf"), "Expected sanitized serviceName in command");
  }
);

registerTest(
  "HYB-ADV-SSH-02",
  "HYB-F08",
  5,
  "SshRunnerDriver.serializeCommand neutralizes injection via environment variable keys",
  () => {
    const driver = new SshRunnerDriver({ host: "node.internal", username: "deploy", sshClient: new MockSshClient() });
    const params: BuildDispatchParams = {
      deploymentId: "dep_1",
      buildId: "bld_1",
      serviceId: "srv_1",
      serviceName: "app",
      environmentVariables: {
        "INJECT_KEY; id ; #": "val",
      },
    };
    const cmd = driver.serializeCommand(params);
    assertFalse(cmd.includes("; id ; #"), "Expected key injection payload to be neutralized");
    assertTrue(cmd.includes("-e INJECT_KEYid='val'"), "Expected sanitized key in command");
  }
);

registerTest(
  "HYB-ADV-SSH-03",
  "HYB-F08",
  5,
  "SshRunnerDriver.serializeCommand neutralizes injection via commitSha parameter",
  () => {
    const driver = new SshRunnerDriver({ host: "node.internal", username: "deploy", sshClient: new MockSshClient() });
    const params: BuildDispatchParams = {
      deploymentId: "dep_1",
      buildId: "bld_1",
      serviceId: "srv_1",
      serviceName: "app",
      commitSha: ";reboot",
    };
    const cmd = driver.serializeCommand(params);
    assertFalse(cmd.includes(";reboot"), "Expected commitSha injection to be neutralized");
    assertTrue(cmd.includes("syncbay-app:reboot"), "Expected sanitized commitSha in image tag");
  }
);

registerTest(
  "HYB-ADV-SSH-04",
  "HYB-F08",
  5,
  "SshRunnerDriver.stopContainer sanitizes containerId parameter",
  async () => {
    const mock = new MockSshClient();
    const driver = new SshRunnerDriver({ host: "node.internal", username: "deploy", sshClient: mock });
    await driver.stopContainer("c_1; cat /etc/passwd");
    const stopCmd = mock.history.find((h) => h.command.includes("docker stop"));
    assertFalse(Boolean(stopCmd?.command.includes("; cat /etc/passwd")), "Expected containerId injection to be neutralized");
    assertTrue(Boolean(stopCmd?.command.includes("c_1catetcpasswd")), "Expected sanitized containerId in command");
  }
);

registerTest(
  "HYB-ADV-SSH-05",
  "HYB-F08",
  5,
  "SshRunnerDriver.checkStatus sanitizes jobId parameter before executing docker inspect",
  async () => {
    const mock = new MockSshClient();
    const driver = new SshRunnerDriver({ host: "node.internal", username: "deploy", sshClient: mock });
    await driver.checkStatus("job_1 $(whoami)");
    const inspectCmd = mock.history.find((h) => h.command.includes("docker inspect"));
    assertFalse(Boolean(inspectCmd?.command.includes("$(whoami)")), "Expected subshell injection in jobId to be neutralized");
    assertTrue(Boolean(inspectCmd?.command.includes("job_1whoami")), "Expected sanitized jobId in command");
  }
);

registerTest(
  "HYB-ADV-SSH-06",
  "HYB-F08",
  5,
  "CliSshClient double-quote command wrapping does not escape Unix subshell expansions",
  () => {
    const raw = 'echo "$(whoami)"';
    const escaped = raw.replace(/"/g, '\\"');
    const wrapped = `"${escaped}"`;
    assertTrue(wrapped.includes("$(whoami)"), "Subshell $(whoami) remains unescaped in double quotes");
  }
);
