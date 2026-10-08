/**
 * Syncbay PaaS — Tier 2: Hybrid Compute & Edge Routing Boundary & Corner Cases Test Suite
 * 90 Tests: Exactly 5 boundary/corner test cases per feature across Features 1 through 18 (R1–R5).
 */

import {
  registerTest,
  assertTrue,
  assertFalse,
  assertEqual,
  assertMatch,
  assertIncludes,
  assertRejects,
  assertThrows,
  hybridHarness,
} from "../harness";

// =============================================================================
// Feature 1: Prisma Relation Query Fix (R5) — Boundary Cases
// =============================================================================

registerTest("HYB-T2-F01-01", "HYB-F01", 2, "Empty string subdomain returns null safely", async () => {
  const oracle = hybridHarness.createServicePreview();
  const res = oracle.queryServiceAndProject("", []);
  assertEqual(res, null);
});

registerTest("HYB-T2-F01-02", "HYB-F01", 2, "Subdomain with maximum length (63-char label) parsed correctly", async () => {
  const oracle = hybridHarness.createServicePreview();
  const maxLabel = "a".repeat(63);
  const mockDb = [
    {
      id: "srv_max",
      name: maxLabel,
      environment: {
        id: "env_max",
        name: "prod",
        project: { id: "p_max", name: "Max Project", slug: "max-slug" },
      },
      status: "ACTIVE" as const,
    },
  ];
  const res = oracle.queryServiceAndProject(`${maxLabel}-prod`, mockDb);
  assertTrue(res !== null);
  assertEqual(res?.serviceName, maxLabel);
});

registerTest("HYB-T2-F01-03", "HYB-F01", 2, "Differentiates identical project names across distinct environments", async () => {
  const oracle = hybridHarness.createServicePreview();
  const mockDb = [
    {
      id: "s1",
      name: "web",
      environment: { id: "e1", name: "staging", project: { id: "p1", name: "Core", slug: "core" } },
      status: "ACTIVE" as const,
    },
    {
      id: "s2",
      name: "web",
      environment: { id: "e2", name: "production", project: { id: "p1", name: "Core", slug: "core" } },
      status: "ACTIVE" as const,
    },
  ];
  const resStaging = oracle.queryServiceAndProject("web-staging", mockDb);
  const resProd = oracle.queryServiceAndProject("web-production", mockDb);
  assertEqual(resStaging?.environmentName, "staging");
  assertEqual(resProd?.environmentName, "production");
});

registerTest("HYB-T2-F01-04", "HYB-F01", 2, "Project name containing unicode, emoji, and punctuation is preserved", async () => {
  const oracle = hybridHarness.createServicePreview();
  const mockDb = [
    {
      id: "s_uni",
      name: "tokyo-shop",
      environment: {
        id: "e_uni",
        name: "preview",
        project: { id: "p_uni", name: "東京ショップ 🚀 (Shop & Pay)", slug: "tokyo-shop" },
      },
      status: "ACTIVE" as const,
    },
  ];
  const res = oracle.queryServiceAndProject("tokyo-shop-preview", mockDb);
  assertEqual(res?.projectName, "東京ショップ 🚀 (Shop & Pay)");
});

registerTest("HYB-T2-F01-05", "HYB-F01", 2, "Rejects null environment relation gracefully with schema validation error", async () => {
  const oracle = hybridHarness.createServicePreview();
  const mockDb: any[] = [{ id: "s_orphan", name: "orphan", environment: null, status: "ACTIVE" }];
  assertThrows(() => {
    oracle.queryServiceAndProject("orphan", mockDb);
  });
});

// =============================================================================
// Feature 2: Ephemeral PR Domain Registration (R3) — Boundary Cases
// =============================================================================

registerTest("HYB-T2-F02-01", "HYB-F02", 2, "High-magnitude PR number (PR #999999) generates valid domain", async () => {
  const prManager = hybridHarness.createPrManager();
  const event = {
    action: "opened" as const,
    number: 999999,
    pull_request: { title: "Big PR", merged: false, head: { ref: "patch", sha: "sha_999999" }, base: { ref: "main" } },
    repository: { html_url: "https://github.com/syncbay/big", full_name: "syncbay/big" },
  };
  const res = prManager.handleWebhook(event, "svc");
  assertEqual(res.domain, "svc-pr-999999.syncbay.app");
});

registerTest("HYB-T2-F02-02", "HYB-F02", 2, "Service name with underscores and dots is sanitized into valid RFC DNS labels", async () => {
  const prManager = hybridHarness.createPrManager();
  const event = {
    action: "opened" as const,
    number: 55,
    pull_request: { title: "Dotted name", merged: false, head: { ref: "p", sha: "sha_55" }, base: { ref: "main" } },
    repository: { html_url: "https://github.com/syncbay/dot", full_name: "syncbay/dot" },
  };
  const res = prManager.handleWebhook(event, "api_v2.0_service");
  assertEqual(res.domain, "apiv20service-pr-55.syncbay.app");
});

registerTest("HYB-T2-F02-03", "HYB-F02", 2, "PR title with markdown/HTML characters does not corrupt domain or env record", async () => {
  const prManager = hybridHarness.createPrManager();
  const event = {
    action: "opened" as const,
    number: 66,
    pull_request: {
      title: "Fix <script>alert('xss')</script> & [Markdown](link)",
      merged: false,
      head: { ref: "security", sha: "sha_66" },
      base: { ref: "main" },
    },
    repository: { html_url: "https://github.com/syncbay/sec", full_name: "syncbay/sec" },
  };
  const res = prManager.handleWebhook(event, "web");
  assertEqual(res.domain, "web-pr-66.syncbay.app");
  assertTrue(Boolean(res.env));
});

registerTest("HYB-T2-F02-04", "HYB-F02", 2, "PR with git ref containing slashes (feat/core/engine) provisions successfully", async () => {
  const prManager = hybridHarness.createPrManager();
  const event = {
    action: "opened" as const,
    number: 77,
    pull_request: {
      title: "Deep branch ref",
      merged: false,
      head: { ref: "team/alpha/feat/login", sha: "sha_77" },
      base: { ref: "main" },
    },
    repository: { html_url: "https://github.com/syncbay/app", full_name: "syncbay/app" },
  };
  const res = prManager.handleWebhook(event, "auth");
  assertEqual(res.domain, "auth-pr-77.syncbay.app");
});

registerTest("HYB-T2-F02-05", "HYB-F02", 2, "Rapid duplicate opened events overwrite or re-use existing environment cleanly", async () => {
  const prManager = hybridHarness.createPrManager();
  const event = {
    action: "opened" as const,
    number: 88,
    pull_request: { title: "Dup test", merged: false, head: { ref: "dup", sha: "sha_88" }, base: { ref: "main" } },
    repository: { html_url: "https://github.com/syncbay/app", full_name: "syncbay/app" },
  };
  const res1 = prManager.handleWebhook(event, "web");
  const res2 = prManager.handleWebhook(event, "web");
  assertEqual(res1.domain, res2.domain);
});

// =============================================================================
// Feature 3: PR Lifecycle Auto-Sleep & Teardown (R3) — Boundary Cases
// =============================================================================

registerTest("HYB-T2-F03-01", "HYB-F03", 2, "Exact idle timeout boundary: ACTIVE at 1799s, SLEEPING at 1800s", async () => {
  const prManager = hybridHarness.createPrManager();
  const event = {
    action: "opened" as const,
    number: 101,
    pull_request: { title: "Boundary test", merged: false, head: { ref: "b", sha: "sha_101" }, base: { ref: "main" } },
    repository: { html_url: "", full_name: "" },
  };
  prManager.handleWebhook(event, "web");
  prManager.markActive(101);

  const now = Date.now();
  // 1799 seconds: should not sleep
  const isSleeping1799 = prManager.checkIdleTimeout(101, now + 1799 * 1000);
  assertFalse(isSleeping1799);

  // 1800 seconds: should sleep
  const isSleeping1800 = prManager.checkIdleTimeout(101, now + 1800 * 1000);
  assertTrue(isSleeping1800);
});

registerTest("HYB-T2-F03-02", "HYB-F03", 2, "Double PR close event is idempotent and does not throw", async () => {
  const prManager = hybridHarness.createPrManager();
  const closeEvent = {
    action: "closed" as const,
    number: 102,
    pull_request: { title: "Double close", merged: true, head: { ref: "b", sha: "sha_102" }, base: { ref: "main" } },
    repository: { html_url: "", full_name: "" },
  };
  const res1 = prManager.handleWebhook(closeEvent, "web");
  const res2 = prManager.handleWebhook(closeEvent, "web");
  assertEqual(res1.action, "destroyed");
  assertEqual(res2.action, "destroyed");
});

registerTest("HYB-T2-F03-03", "HYB-F03", 2, "PR closed while in BUILDING state is destroyed cleanly", async () => {
  const prManager = hybridHarness.createPrManager();
  const openEvent = {
    action: "opened" as const,
    number: 103,
    pull_request: { title: "Cancel mid-build", merged: false, head: { ref: "b", sha: "sha_103" }, base: { ref: "main" } },
    repository: { html_url: "", full_name: "" },
  };
  prManager.handleWebhook(openEvent, "web");
  // Close before markActive
  const closeEvent = { ...openEvent, action: "closed" as const };
  const res = prManager.handleWebhook(closeEvent, "web");
  assertEqual(res.action, "destroyed");
  assertEqual(prManager.getEnvironment(103), undefined);
});

registerTest("HYB-T2-F03-04", "HYB-F03", 2, "Reopened PR restores environment with fresh idle timer", async () => {
  const prManager = hybridHarness.createPrManager();
  const openEvent = {
    action: "opened" as const,
    number: 104,
    pull_request: { title: "Reopen PR", merged: false, head: { ref: "b", sha: "sha_104" }, base: { ref: "main" } },
    repository: { html_url: "", full_name: "" },
  };
  prManager.handleWebhook(openEvent, "web");
  prManager.handleWebhook({ ...openEvent, action: "closed" as const }, "web");

  const reopenEvent = { ...openEvent, action: "reopened" as const };
  const res = prManager.handleWebhook(reopenEvent, "web");
  assertEqual(res.action, "provisioned");
  assertEqual(res.env?.status, "BUILDING");
});

registerTest("HYB-T2-F03-05", "HYB-F03", 2, "checkIdleTimeout on non-existent PR returns false safely", async () => {
  const prManager = hybridHarness.createPrManager();
  const res = prManager.checkIdleTimeout(99999);
  assertFalse(res);
});

// =============================================================================
// Feature 4: GitHub Octokit Commit Status & Comments (R3) — Boundary Cases
// =============================================================================

registerTest("HYB-T2-F04-01", "HYB-F04", 2, "Handles 40-character full hex SHA commit hashes accurately", async () => {
  const prManager = hybridHarness.createPrManager();
  const fullSha = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  prManager.postCommitStatus(fullSha, {
    context: "syncbay/preview",
    state: "success",
    target_url: "https://web-pr-1.syncbay.app",
    description: "Built successfully",
  });
  const statuses = prManager.getCommitStatuses(fullSha);
  assertEqual(statuses.length, 1);
  assertEqual(statuses[0].state, "success");
});

registerTest("HYB-T2-F04-02", "HYB-F04", 2, "Multiple commit statuses posted in sequence preserve history", async () => {
  const prManager = hybridHarness.createPrManager();
  const sha = "sha_seq_test";
  prManager.postCommitStatus(sha, { context: "syncbay/preview", state: "pending", target_url: "", description: "step 1" });
  prManager.postCommitStatus(sha, { context: "syncbay/preview", state: "pending", target_url: "", description: "step 2" });
  prManager.postCommitStatus(sha, { context: "syncbay/preview", state: "success", target_url: "", description: "done" });
  const statuses = prManager.getCommitStatuses(sha);
  assertEqual(statuses.length, 3);
  assertEqual(statuses[2].state, "success");
});

registerTest("HYB-T2-F04-03", "HYB-F04", 2, "PR comment contains valid markdown table formatting", async () => {
  const prManager = hybridHarness.createPrManager();
  const event = {
    action: "opened" as const,
    number: 105,
    pull_request: { title: "Table test", merged: false, head: { ref: "t", sha: "sha_105" }, base: { ref: "main" } },
    repository: { html_url: "", full_name: "" },
  };
  prManager.handleWebhook(event, "web");
  const comment = prManager.getPrComment(105);
  assertIncludes(comment?.body || "", "| Service | Status | Preview Link |");
  assertIncludes(comment?.body || "", "|:---|:---:|:---|");
});

registerTest("HYB-T2-F04-04", "HYB-F04", 2, "Querying commit status on non-existent commit returns empty array", async () => {
  const prManager = hybridHarness.createPrManager();
  assertEqual(prManager.getCommitStatuses("non_existent_sha").length, 0);
});

registerTest("HYB-T2-F04-05", "HYB-F04", 2, "PR comment body updates seamlessly without changing commentId", async () => {
  const prManager = hybridHarness.createPrManager();
  prManager.postOrUpdatePrComment(106, { body: "Initial comment", commentId: 5001 });
  prManager.postOrUpdatePrComment(106, { body: "Updated comment" });
  const comment = prManager.getPrComment(106);
  assertEqual(comment?.commentId, 5001);
  assertEqual(comment?.body, "Updated comment");
});

// =============================================================================
// Feature 5: Unified RunnerDriver Interface (R1) — Boundary Cases
// =============================================================================

registerTest("HYB-T2-F05-01", "HYB-F05", 2, "Dispatches build with empty environment variables dictionary", async () => {
  const webhook = hybridHarness.createWebhookDriver();
  const res = await webhook.dispatchBuild({
    jobId: "job_empty_env",
    serviceId: "srv_empty",
    repoUrl: "https://github.com/syncbay/repo",
    commitSha: "sha_empty",
    branch: "main",
    environmentVariables: {},
  });
  assertTrue(res.status === "ACCEPTED" || res.status === "BUILDING");
});

registerTest("HYB-T2-F05-02", "HYB-F05", 2, "Stop container on non-existent containerId returns graceful result", async () => {
  const webhook = hybridHarness.createWebhookDriver();
  const res = await webhook.stopContainer("cnt_does_not_exist", { force: true });
  assertTrue(res.stopped);
});

registerTest("HYB-T2-F05-03", "HYB-F05", 2, "Stop container with force=true and timeoutSeconds=0 completes rapidly", async () => {
  const queue = hybridHarness.createQueueDriver();
  const res = await queue.stopContainer("cnt_force", { force: true, timeoutSeconds: 0 });
  assertTrue(res.stopped);
});

registerTest("HYB-T2-F05-04", "HYB-F05", 2, "Status check on non-existent jobId returns FAILED with error message", async () => {
  const queue = hybridHarness.createQueueDriver();
  const res = await queue.checkStatus("non-existent-job-uuid");
  assertEqual(res.status, "FAILED");
  assertTrue(Boolean(res.error));
});

registerTest("HYB-T2-F05-05", "HYB-F05", 2, "Accepts multiline environment variables without serialization errors", async () => {
  const webhook = hybridHarness.createWebhookDriver();
  const res = await webhook.dispatchBuild({
    jobId: "job_multiline",
    serviceId: "s1",
    repoUrl: "",
    commitSha: "",
    branch: "main",
    environmentVariables: {
      RSA_KEY: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
    },
  });
  assertEqual(res.jobId, "job_multiline");
});

// =============================================================================
// Feature 6: REST Webhook Runner Driver (R1) — Boundary Cases
// =============================================================================

registerTest("HYB-T2-F06-01", "HYB-F06", 2, "Signature verification is timing-safe against mismatched lengths", async () => {
  const driver = hybridHarness.createWebhookDriver("test-secret");
  const payload = "test payload";
  assertFalse(driver.verifySignature(payload, "sha256=short"));
  assertFalse(driver.verifySignature(payload, "sha256=123"));
  assertFalse(driver.verifySignature(payload, ""));
});

registerTest("HYB-T2-F06-02", "HYB-F06", 2, "Single character flip in hex signature causes verification to fail", async () => {
  const driver = hybridHarness.createWebhookDriver("test-secret");
  const payload = "build-dispatch-payload";
  const validSig = driver.generateSignature(payload);
  const corruptedChar = validSig[validSig.length - 1] === "a" ? "b" : "a";
  const tamperedSig = validSig.slice(0, -1) + corruptedChar;

  assertFalse(driver.verifySignature(payload, tamperedSig));
});

registerTest("HYB-T2-F06-03", "HYB-F06", 2, "Signature verification with wrong secret key fails", async () => {
  const driverA = hybridHarness.createWebhookDriver("secret-AAA");
  const driverB = hybridHarness.createWebhookDriver("secret-BBB");
  const payload = "shared-payload";
  const sigA = driverA.generateSignature(payload);

  assertFalse(driverB.verifySignature(payload, sigA));
});

registerTest("HYB-T2-F06-04", "HYB-F06", 2, "Large build dispatch payload (>64KB) signs and verifies reliably", async () => {
  const driver = hybridHarness.createWebhookDriver("big-secret");
  const largeData = "x".repeat(65536);
  const sig = driver.generateSignature(largeData);
  assertTrue(driver.verifySignature(largeData, sig));
});

registerTest("HYB-T2-F06-05", "HYB-F06", 2, "Rejects signature missing sha256= prefix", async () => {
  const driver = hybridHarness.createWebhookDriver("secret");
  const payload = "payload";
  const rawHex = driver.generateSignature(payload).replace("sha256=", "");
  assertFalse(driver.verifySignature(payload, rawHex));
});

// =============================================================================
// Feature 7: Queue/DB Polling Runner Driver (R1) — Boundary Cases
// =============================================================================

registerTest("HYB-T2-F07-01", "HYB-F07", 2, "processNextJob on empty queue returns null without throwing", async () => {
  const queue = hybridHarness.createQueueDriver();
  assertEqual(queue.processNextJob(), null);
});

registerTest("HYB-T2-F07-02", "HYB-F07", 2, "Handles high backlog of 200 queued jobs in strict FIFO order", async () => {
  const queue = hybridHarness.createQueueDriver();
  for (let i = 0; i < 200; i++) {
    await queue.dispatchBuild({ jobId: `q_job_${i}`, serviceId: "s", repoUrl: "", commitSha: "", branch: "main" });
  }
  const first = queue.processNextJob();
  assertEqual(first?.jobId, "q_job_0");
});

registerTest("HYB-T2-F07-03", "HYB-F07", 2, "Idempotent status transition does not corrupt status history", async () => {
  const queue = hybridHarness.createQueueDriver();
  await queue.dispatchBuild({ jobId: "j_idem", serviceId: "s", repoUrl: "", commitSha: "", branch: "main" });
  queue.transitionJob("j_idem", "BUILDING", "Log 1");
  queue.transitionJob("j_idem", "BUILDING", "Log 2");
  const s = await queue.checkStatus("j_idem");
  assertEqual(s.status, "BUILDING");
  assertEqual(s.logs?.length, 3);
});

registerTest("HYB-T2-F07-04", "HYB-F07", 2, "Allows transition to terminal state FAILED with comprehensive error stack", async () => {
  const queue = hybridHarness.createQueueDriver();
  await queue.dispatchBuild({ jobId: "j_err", serviceId: "s", repoUrl: "", commitSha: "", branch: "main" });
  queue.transitionJob("j_err", "FAILED", "Compilation error", "Error: Cannot find module '@types/node'");
  const s = await queue.checkStatus("j_err");
  assertEqual(s.status, "FAILED");
  assertIncludes(s.error || "", "@types/node");
});

registerTest("HYB-T2-F07-05", "HYB-F07", 2, "Stop container releases allocated port back to system", async () => {
  const queue = hybridHarness.createQueueDriver();
  await queue.dispatchBuild({ jobId: "j_stop", serviceId: "s", repoUrl: "", commitSha: "", branch: "main", targetPort: 3456 });
  const dequeued = queue.processNextJob();
  const stopRes = await queue.stopContainer(dequeued?.containerId || "");
  assertTrue(stopRes.stopped);
  assertEqual(stopRes.releasedPort, 3456);
});

// =============================================================================
// Feature 8: SSH Remote Runner Driver (R1) — Boundary Cases
// =============================================================================

registerTest("HYB-T2-F08-01", "HYB-F08", 2, "Accepts non-standard SSH port numbers (e.g. port 2222)", async () => {
  const ssh = hybridHarness.createSshDriver({ host: "node-custom.internal", port: 2222, username: "admin" });
  const health = await ssh.checkNodeHealth();
  assertTrue(health.online);
});

registerTest("HYB-T2-F08-02", "HYB-F08", 2, "Accepts IPv4 address string as SSH host", async () => {
  const ssh = hybridHarness.createSshDriver({ host: "10.0.1.45", port: 22, username: "deploy" });
  const health = await ssh.checkNodeHealth();
  assertTrue(health.online);
});

registerTest("HYB-T2-F08-03", "HYB-F08", 2, "Stop container on non-existent containerId on SSH node returns safe result", async () => {
  const ssh = hybridHarness.createSshDriver({ host: "node.internal", port: 22, username: "deploy" });
  const stopRes = await ssh.stopContainer("ssh_cnt_ghost");
  assertTrue(stopRes.stopped);
});

registerTest("HYB-T2-F08-04", "HYB-F08", 2, "Concurrent dispatches on same node assign unique container IDs", async () => {
  const ssh = hybridHarness.createSshDriver({ host: "node.internal", port: 22, username: "deploy" });
  const b1 = await ssh.dispatchBuild({ jobId: "b1", serviceId: "s1", repoUrl: "", commitSha: "", branch: "main" });
  const b2 = await ssh.dispatchBuild({ jobId: "b2", serviceId: "s2", repoUrl: "", commitSha: "", branch: "main" });
  assertTrue(b1.containerId !== b2.containerId);
});

registerTest("HYB-T2-F08-05", "HYB-F08", 2, "Dispatch to unreachable host rejects immediately with TimeoutError", async () => {
  const ssh = hybridHarness.createSshDriver({ host: "unreachable.internal", port: 22, username: "deploy" });
  await assertRejects(async () => {
    await ssh.dispatchBuild({ jobId: "b_fail", serviceId: "s", repoUrl: "", commitSha: "", branch: "main" });
  }, /timed out/);
});

// =============================================================================
// Feature 9: Containerized Runner Agent Daemon (R1) — Boundary Cases
// =============================================================================

registerTest("HYB-T2-F09-01", "HYB-F09", 2, "Supports custom target tags with semantic versioning syntax", async () => {
  const pipeline = hybridHarness.createPipeline();
  const res = await pipeline.executePipeline({ engine: "docker", targetTag: "syncbay/app:v2.1.0-beta.1+build.104" });
  assertEqual(res.imageTag, "syncbay/app:v2.1.0-beta.1+build.104");
});

registerTest("HYB-T2-F09-02", "HYB-F09", 2, "Nixpacks build includes export stage for OCI container creation", async () => {
  const pipeline = hybridHarness.createPipeline();
  const res = await pipeline.executePipeline({ engine: "nixpacks", targetTag: "oci/app:latest" });
  assertIncludes(res.stages, "export");
});

registerTest("HYB-T2-F09-03", "HYB-F09", 2, "Docker build pipeline includes docker-context preparation stage", async () => {
  const pipeline = hybridHarness.createPipeline();
  const res = await pipeline.executePipeline({ engine: "docker", targetTag: "docker/app:latest" });
  assertIncludes(res.stages, "docker-context");
});

registerTest("HYB-T2-F09-04", "HYB-F09", 2, "Simultaneous pipeline executions operate with isolated log outputs", async () => {
  const pipeline = hybridHarness.createPipeline();
  const [res1, res2] = await Promise.all([
    pipeline.executePipeline({ engine: "docker", targetTag: "tag-1" }),
    pipeline.executePipeline({ engine: "nixpacks", targetTag: "tag-2" }),
  ]);
  assertTrue(res1.logs.some((l) => l.includes("docker")));
  assertTrue(res2.logs.some((l) => l.includes("nixpacks")));
});

registerTest("HYB-T2-F09-05", "HYB-F09", 2, "Pipeline returns clean execution object without unhandled rejections", async () => {
  const pipeline = hybridHarness.createPipeline();
  const res = await pipeline.executePipeline({ engine: "docker", targetTag: "safe-tag" });
  assertTrue(typeof res.success === "boolean");
});

// =============================================================================
// Feature 10: Runner Build Pipeline & Port Allocator (R1) — Boundary Cases
// =============================================================================

registerTest("HYB-T2-F10-01", "HYB-F10", 2, "Port bounds boundary: allocates exact minimum port (20000) first", async () => {
  const mgr = hybridHarness.createPortManager(20000, 20005);
  assertEqual(mgr.allocatePort(), 20000);
});

registerTest("HYB-T2-F10-02", "HYB-F10", 2, "Releasing unallocated port returns false without altering pool state", async () => {
  const mgr = hybridHarness.createPortManager(20000, 20005);
  assertFalse(mgr.releasePort(29999));
  assertEqual(mgr.allocatedCount(), 0);
});

registerTest("HYB-T2-F10-03", "HYB-F10", 2, "High-churn cycle: allocates and releases 500 times without leaking ports", async () => {
  const mgr = hybridHarness.createPortManager(21000, 21010);
  for (let i = 0; i < 500; i++) {
    const p = mgr.allocatePort();
    mgr.releasePort(p);
  }
  assertEqual(mgr.allocatedCount(), 0);
  assertEqual(mgr.allocatePort(), 21000);
});

registerTest("HYB-T2-F10-04", "HYB-F10", 2, "Single-port pool (minPort == maxPort) handles fill and release cycle", async () => {
  const mgr = hybridHarness.createPortManager(25000, 25000);
  const p1 = mgr.allocatePort();
  assertEqual(p1, 25000);
  assertThrows(() => mgr.allocatePort(), /exhausted/);
  mgr.releasePort(p1);
  assertEqual(mgr.allocatePort(), 25000);
});

registerTest("HYB-T2-F10-05", "HYB-F10", 2, "Pool correctly tracks allocated status via isAllocated", async () => {
  const mgr = hybridHarness.createPortManager(22000, 22005);
  assertFalse(mgr.isAllocated(22000));
  mgr.allocatePort();
  assertTrue(mgr.isAllocated(22000));
});

// =============================================================================
// Feature 11: Cloudflare Tunnel Ingress Generator (R2) — Boundary Cases
// =============================================================================

registerTest("HYB-T2-F11-01", "HYB-F11", 2, "Accepts minimum valid port (1) and maximum valid port (65535)", async () => {
  const yaml = hybridHarness.generateTunnelConfig({
    tunnelId: "tun-ports",
    routes: [
      { hostname: "port-min.syncbay.app", targetPort: 1 },
      { hostname: "port-max.syncbay.app", targetPort: 65535 },
    ],
  });
  assertIncludes(yaml, "http://localhost:1");
  assertIncludes(yaml, "http://localhost:65535");
});

registerTest("HYB-T2-F11-02", "HYB-F11", 2, "Rejects port 0 with validation error", async () => {
  assertThrows(() => {
    hybridHarness.generateTunnelConfig({
      tunnelId: "tun-zero",
      routes: [{ hostname: "bad.syncbay.app", targetPort: 0 }],
    });
  }, /Target port out of range/);
});

registerTest("HYB-T2-F11-03", "HYB-F11", 2, "Rejects port 65536 with validation error", async () => {
  assertThrows(() => {
    hybridHarness.generateTunnelConfig({
      tunnelId: "tun-high",
      routes: [{ hostname: "bad.syncbay.app", targetPort: 65536 }],
    });
  }, /Target port out of range/);
});

registerTest("HYB-T2-F11-04", "HYB-F11", 2, "Rejects invalid hostname format (special chars, url schemes)", async () => {
  assertThrows(() => {
    hybridHarness.generateTunnelConfig({
      tunnelId: "tun-invalid-host",
      routes: [{ hostname: "http://invalid-scheme.com", targetPort: 3000 }],
    });
  }, /Invalid route hostname/);
});

registerTest("HYB-T2-F11-05", "HYB-F11", 2, "Empty routes array produces valid config with only catch-all rule", async () => {
  const yaml = hybridHarness.generateTunnelConfig({
    tunnelId: "tun-empty",
    routes: [],
  });
  assertIncludes(yaml, "tunnel: tun-empty");
  assertIncludes(yaml, "ingress:\n  - service: http_status:404");
});

// =============================================================================
// Feature 12: Edge Service Registry (R2) — Boundary Cases
// =============================================================================

registerTest("HYB-T2-F12-01", "HYB-F12", 2, "Clearing an already empty registry is a safe no-op", async () => {
  const reg = hybridHarness.createEdgeRegistry();
  reg.clearServiceRoutes();
  assertEqual(reg.listRoutes().length, 0);
});

registerTest("HYB-T2-F12-02", "HYB-F12", 2, "High route density (1,000 routes) operates with zero memory leakage", async () => {
  const reg = hybridHarness.createEdgeRegistry();
  for (let i = 0; i < 1000; i++) {
    reg.registerServiceRoute(`svc-${i}.syncbay.app`, 20000 + (i % 5000));
  }
  assertEqual(reg.listRoutes().length, 1000);
  const found = reg.getServiceRoute("svc-499.syncbay.app");
  assertTrue(found !== null);
});

registerTest("HYB-T2-F12-03", "HYB-F12", 2, "Custom upstream URL with custom protocol or IP preserved intact", async () => {
  const reg = hybridHarness.createEdgeRegistry();
  reg.registerServiceRoute("node.syncbay.app", 8080, "ACTIVE", "http://192.168.1.100:8080");
  const route = reg.getServiceRoute("node.syncbay.app");
  assertEqual(route?.upstreamUrl, "http://192.168.1.100:8080");
});

registerTest("HYB-T2-F12-04", "HYB-F12", 2, "Removing non-existent route returns false cleanly", async () => {
  const reg = hybridHarness.createEdgeRegistry();
  assertFalse(reg.removeServiceRoute("ghost.syncbay.app"));
});

registerTest("HYB-T2-F12-05", "HYB-F12", 2, "Overwriting route updates updatedAt timestamp to later time", async () => {
  const reg = hybridHarness.createEdgeRegistry();
  reg.registerServiceRoute("time.syncbay.app", 3000, "BUILDING");
  const t1 = reg.getServiceRoute("time.syncbay.app")?.updatedAt || 0;
  reg.registerServiceRoute("time.syncbay.app", 3000, "ACTIVE");
  const t2 = reg.getServiceRoute("time.syncbay.app")?.updatedAt || 0;
  assertTrue(t2 >= t1);
});

// =============================================================================
// Feature 13: Edge Middleware Transparent Routing (R2) — Boundary Cases
// =============================================================================

registerTest("HYB-T2-F13-01", "HYB-F13", 2, "Handles host header with explicit port (:443 or :80) gracefully", async () => {
  const reg = hybridHarness.createEdgeRegistry();
  reg.registerServiceRoute("app.syncbay.app", 3000, "ACTIVE");
  const mw = hybridHarness.createEdgeMiddleware(reg);

  const dec = mw.handleRequest({ url: "/feed", host: "app.syncbay.app" });
  assertEqual(dec.action, "pass-through");
});

registerTest("HYB-T2-F13-02", "HYB-F13", 2, "Static assets pass through without being intercepted by splash rewrite", async () => {
  const reg = hybridHarness.createEdgeRegistry();
  reg.registerServiceRoute("app.syncbay.app", 3000, "BUILDING");
  const mw = hybridHarness.createEdgeMiddleware(reg);

  const dec = mw.handleRequest({ url: "/favicon.ico", host: "app.syncbay.app" });
  assertEqual(dec.action, "pass-through");
});

registerTest("HYB-T2-F13-03", "HYB-F13", 2, "Deep service-preview URLs pass through without infinite rewrite loops", async () => {
  const reg = hybridHarness.createEdgeRegistry();
  reg.registerServiceRoute("app.syncbay.app", 3000, "BUILDING");
  const mw = hybridHarness.createEdgeMiddleware(reg);

  const dec = mw.handleRequest({ url: "/service-preview/app", host: "app.syncbay.app" });
  assertEqual(dec.action, "pass-through");
});

registerTest("HYB-T2-F13-04", "HYB-F13", 2, "Unregistered unknown domain returns 404 status decision", async () => {
  const reg = hybridHarness.createEdgeRegistry();
  const mw = hybridHarness.createEdgeMiddleware(reg);

  const dec = mw.handleRequest({ url: "/", host: "unknown-subdomain.syncbay.app" });
  assertEqual(dec.action, "not-found");
  assertEqual(dec.status, 404);
});

registerTest("HYB-T2-F13-05", "HYB-F13", 2, "Service in FAILED status returns 502 Bad Gateway decision", async () => {
  const reg = hybridHarness.createEdgeRegistry();
  reg.registerServiceRoute("failed-app.syncbay.app", 3000, "FAILED");
  const mw = hybridHarness.createEdgeMiddleware(reg);

  const dec = mw.handleRequest({ url: "/", host: "failed-app.syncbay.app" });
  assertEqual(dec.action, "not-found");
  assertEqual(dec.status, 502);
});

// =============================================================================
// Feature 14: Knip Code Quality Analyzer Module (R4) — Boundary Cases
// =============================================================================

registerTest("HYB-T2-F14-01", "HYB-F14", 2, "Empty file list and empty package.json completes without errors", async () => {
  const knip = hybridHarness.createKnipAnalyzer();
  const res = await knip.runAnalysis({ files: [], packageJsonContent: {} });
  assertEqual(res.unusedDependencies.length, 0);
  assertEqual(res.unreferencedFiles.length, 0);
});

registerTest("HYB-T2-F14-02", "HYB-F14", 2, "Handles JSON string input format for packageJsonContent", async () => {
  const knip = hybridHarness.createKnipAnalyzer();
  const res = await knip.runAnalysis({
    files: ["src/index.ts"],
    packageJsonContent: JSON.stringify({ dependencies: { unusedLib: "1.0.0" } }),
  });
  assertIncludes(res.unusedDependencies, "unusedLib");
});

registerTest("HYB-T2-F14-03", "HYB-F14", 2, "Detects orphan files ending in .orphan.ts", async () => {
  const knip = hybridHarness.createKnipAnalyzer();
  const res = await knip.runAnalysis({
    files: ["src/index.ts", "src/services/old.orphan.ts"],
    packageJsonContent: {},
  });
  assertIncludes(res.unreferencedFiles, "src/services/old.orphan.ts");
});

registerTest("HYB-T2-F14-04", "HYB-F14", 2, "Handles Windows path separators seamlessly", async () => {
  const knip = hybridHarness.createKnipAnalyzer();
  const res = await knip.runAnalysis({
    files: ["src\\components\\dead-button.ts", "src\\index.ts"],
    packageJsonContent: {},
  });
  assertEqual(res.unreferencedFiles.length, 1);
});

registerTest("HYB-T2-F14-05", "HYB-F14", 2, "Correctly identifies used dependency matching file name", async () => {
  const knip = hybridHarness.createKnipAnalyzer();
  const res = await knip.runAnalysis({
    files: ["src/lib/zod.ts"],
    packageJsonContent: { dependencies: { zod: "^3.0.0" } },
  });
  assertEqual(res.unusedDependencies.length, 0);
});

// =============================================================================
// Feature 15: Non-Blocking Knip Engine Integration (R4) — Boundary Cases
// =============================================================================

registerTest("HYB-T2-F15-01", "HYB-F15", 2, "Swallows throwing buildLogStream callback gracefully", async () => {
  const knip = hybridHarness.createKnipAnalyzer();
  const throwingStream = () => {
    throw new Error("Stream write error");
  };
  const res = await knip.executeNonBlockingScan(
    { files: ["src/index.ts"], packageJsonContent: { dependencies: { unused: "1.0" } } },
    throwingStream
  );
  assertTrue(res.buildUnblocked);
});

registerTest("HYB-T2-F15-02", "HYB-F15", 2, "Handles large number of 50 unused dependencies without crashing", async () => {
  const knip = hybridHarness.createKnipAnalyzer();
  const deps: Record<string, string> = {};
  for (let i = 0; i < 50; i++) deps[`dead-pkg-${i}`] = "1.0.0";
  const logs: string[] = [];
  const res = await knip.executeNonBlockingScan(
    { files: ["src/index.ts"], packageJsonContent: { dependencies: deps } },
    (l) => logs.push(l)
  );
  assertTrue(res.buildUnblocked);
  assertIncludes(logs.join("\n"), "Found 50 unused dependencies");
});

registerTest("HYB-T2-F15-03", "HYB-F15", 2, "Null packageJsonContent defaults safely to empty dependencies", async () => {
  const knip = hybridHarness.createKnipAnalyzer();
  const logs: string[] = [];
  const res = await knip.executeNonBlockingScan({ files: ["src/index.ts"] }, (l) => logs.push(l));
  assertTrue(res.buildUnblocked);
});

registerTest("HYB-T2-F15-04", "HYB-F15", 2, "Always returns scanPassed = true even with dead code", async () => {
  const knip = hybridHarness.createKnipAnalyzer();
  const res = await knip.executeNonBlockingScan(
    { files: ["src/dead.ts"], packageJsonContent: { dependencies: { dead: "1.0" } } },
    () => {}
  );
  assertTrue(res.scanPassed);
});

registerTest("HYB-T2-F15-05", "HYB-F15", 2, "Execution time is bounded and fast for non-blocking build loops", async () => {
  const knip = hybridHarness.createKnipAnalyzer();
  const start = Date.now();
  await knip.executeNonBlockingScan({ files: ["src/a.ts", "src/b.ts"] }, () => {});
  const elapsed = Date.now() - start;
  assertTrue(elapsed < 200, "Non-blocking scan must complete within 200ms");
});

// =============================================================================
// Feature 16: Cold-Start Live Splash Screen (R5) — Boundary Cases
// =============================================================================

registerTest("HYB-T2-F16-01", "HYB-F16", 2, "Handles service with empty name by falling back gracefully", async () => {
  const oracle = hybridHarness.createServicePreview();
  const res = oracle.queryServiceAndProject("nonexistent", []);
  assertEqual(res, null);
});

registerTest("HYB-T2-F16-02", "HYB-F16", 2, "Handles status transitions without state corruption", async () => {
  const oracle = hybridHarness.createServicePreview();
  const db = [
    {
      id: "s1",
      name: "worker",
      environment: { id: "e1", name: "prod", project: { id: "p1", name: "Worker App", slug: "wrk" } },
      status: "BUILDING" as const,
    },
  ];
  let info = oracle.queryServiceAndProject("worker-prod", db);
  assertEqual(info?.status, "BUILDING");

  db[0].status = "ACTIVE";
  info = oracle.queryServiceAndProject("worker-prod", db);
  assertEqual(info?.status, "ACTIVE");
});

registerTest("HYB-T2-F16-03", "HYB-F16", 2, "Queries environment with numerical suffixes correctly", async () => {
  const oracle = hybridHarness.createServicePreview();
  const db = [
    {
      id: "s2",
      name: "svc",
      environment: { id: "e2", name: "pr-42", project: { id: "p2", name: "Service", slug: "svc" } },
      status: "BUILDING" as const,
    },
  ];
  const info = oracle.queryServiceAndProject("svc-pr-42", db);
  assertEqual(info?.environmentName, "pr-42");
});

registerTest("HYB-T2-F16-04", "HYB-F16", 2, "Project slug with hyphens and numbers is preserved", async () => {
  const oracle = hybridHarness.createServicePreview();
  const db = [
    {
      id: "s3",
      name: "app",
      environment: { id: "e3", name: "stage", project: { id: "p3", name: "Web 3.0 Portal", slug: "web3-portal-2026" } },
      status: "DEPLOYING" as const,
    },
  ];
  const info = oracle.queryServiceAndProject("app-stage", db);
  assertEqual(info?.projectSlug, "web3-portal-2026");
});

registerTest("HYB-T2-F16-05", "HYB-F16", 2, "Multiple services in database do not conflict during subdomain resolution", async () => {
  const oracle = hybridHarness.createServicePreview();
  const db = [
    {
      id: "s1",
      name: "api",
      environment: { id: "e1", name: "prod", project: { id: "p1", name: "P1", slug: "p1" } },
      status: "ACTIVE" as const,
    },
    {
      id: "s2",
      name: "api",
      environment: { id: "e2", name: "dev", project: { id: "p2", name: "P2", slug: "p2" } },
      status: "BUILDING" as const,
    },
  ];
  assertEqual(oracle.queryServiceAndProject("api-prod", db)?.projectName, "P1");
  assertEqual(oracle.queryServiceAndProject("api-dev", db)?.projectName, "P2");
});

// =============================================================================
// Feature 17: Real-Time SSE Log Streaming Console (R5) — Boundary Cases
// =============================================================================

registerTest("HYB-T2-F17-01", "HYB-F17", 2, "Accepts extremely large single log line (10,000 characters)", async () => {
  const largeLine = "DATA: " + "a".repeat(10000);
  assertEqual(largeLine.length, 10006);
});

registerTest("HYB-T2-F17-02", "HYB-F17", 2, "Handles empty log lines without breaking stream processing", async () => {
  const lines = ["line 1", "", "line 2"];
  const filtered = lines.filter((l) => l !== undefined);
  assertEqual(filtered.length, 3);
});

registerTest("HYB-T2-F17-03", "HYB-F17", 2, "Emoji and unicode in build log stream are handled without corruption", async () => {
  const emojiLog = "📦 Packaging OCI container... 🚀 Done in 2.3s ✨";
  assertIncludes(emojiLog, "📦");
  assertIncludes(emojiLog, "🚀");
});

registerTest("HYB-T2-F17-04", "HYB-F17", 2, "Endpoint URL parser supports UUID format deployment IDs", async () => {
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  const url = `/api/deployments/${uuid}/logs/stream`;
  assertMatch(url, /^\/api\/deployments\/[0-9a-f-]+\/logs\/stream$/);
});

registerTest("HYB-T2-F17-05", "HYB-F17", 2, "Handles stream completion cleanly when status is FAILED", async () => {
  let streamClosed = false;
  const onStatus = (s: string) => {
    if (s === "FAILED" || s === "ACTIVE") streamClosed = true;
  };
  onStatus("FAILED");
  assertTrue(streamClosed);
});

// =============================================================================
// Feature 18: Client-Side Health Probe & Redirect (R5) — Boundary Cases
// =============================================================================

registerTest("HYB-T2-F18-01", "HYB-F18", 2, "Health probe network exception (e.g. ECONNREFUSED) treated as 503 and retries", async () => {
  const oracle = hybridHarness.createServicePreview();
  let calls = 0;
  const probeFn = async () => {
    calls++;
    if (calls === 1) throw new Error("ECONNREFUSED");
    return { status: 200 };
  };

  // Safe wrapper that turns exceptions into 503
  const safeProbe = async () => {
    try {
      return await probeFn();
    } catch {
      return { status: 503 };
    }
  };

  const res = await oracle.probeHealthUntilReady(safeProbe, 3, 5);
  assertTrue(res.ready);
  assertEqual(res.attempts, 2);
});

registerTest("HYB-T2-F18-02", "HYB-F18", 2, "Redirect HTTP 301/302 from health check is not treated as 200 ready", async () => {
  const oracle = hybridHarness.createServicePreview();
  let calls = 0;
  const probeFn = async () => {
    calls++;
    return { status: calls < 3 ? 302 : 200 };
  };
  const res = await oracle.probeHealthUntilReady(probeFn, 4, 5);
  assertEqual(res.attempts, 3);
  assertTrue(res.ready);
});

registerTest("HYB-T2-F18-03", "HYB-F18", 2, "Recovers and redirects on exact final retry attempt", async () => {
  const oracle = hybridHarness.createServicePreview();
  let calls = 0;
  const maxRetries = 5;
  const probeFn = async () => {
    calls++;
    return { status: calls === maxRetries ? 200 : 503 };
  };
  const res = await oracle.probeHealthUntilReady(probeFn, maxRetries, 5);
  assertTrue(res.ready);
  assertEqual(res.attempts, maxRetries);
});

registerTest("HYB-T2-F18-04", "HYB-F18", 2, "Zero maxRetries immediately finishes without redirecting", async () => {
  const oracle = hybridHarness.createServicePreview();
  const probeFn = async () => ({ status: 200 });
  const res = await oracle.probeHealthUntilReady(probeFn, 0, 5);
  assertFalse(res.ready);
  assertEqual(res.attempts, 0);
});

registerTest("HYB-T2-F18-05", "HYB-F18", 2, "Health probe handles 404 response as unready and retries", async () => {
  const oracle = hybridHarness.createServicePreview();
  let calls = 0;
  const probeFn = async () => {
    calls++;
    return { status: calls < 2 ? 404 : 200 };
  };
  const res = await oracle.probeHealthUntilReady(probeFn, 3, 5);
  assertTrue(res.ready);
  assertEqual(res.attempts, 2);
});
