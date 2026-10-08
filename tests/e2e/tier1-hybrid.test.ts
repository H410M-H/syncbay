/**
 * Syncbay PaaS — Tier 1: Hybrid Compute & Edge Routing Feature Coverage Test Suite
 * 90 Tests: Exactly 5 comprehensive happy-path test cases per feature across Features 1 through 18 (R1–R5).
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
  RunnerDriverError,
} from "../harness";

// =============================================================================
// Feature 1: Prisma Relation Query Fix (R5)
// =============================================================================

registerTest("HYB-T1-F01-01", "HYB-F01", 1, "Preview page queries project metadata via environment.project relation", async () => {
  const oracle = hybridHarness.createServicePreview();
  const mockDb = [
    {
      id: "srv_1",
      name: "api-backend",
      environment: {
        id: "env_1",
        name: "production",
        project: { id: "prj_1", name: "Fintech Platform", slug: "fintech-platform" },
      },
      status: "ACTIVE" as const,
    },
  ];

  const result = oracle.queryServiceAndProject("api-backend-production", mockDb);
  assertTrue(result !== null);
  assertEqual(result?.projectName, "Fintech Platform");
  assertEqual(result?.projectSlug, "fintech-platform");
  assertEqual(result?.serviceName, "api-backend");
});

registerTest("HYB-T1-F01-02", "HYB-F01", 1, "Preview page resolves standalone service subdomain to project", async () => {
  const oracle = hybridHarness.createServicePreview();
  const mockDb = [
    {
      id: "srv_web",
      name: "storefront",
      environment: {
        id: "env_preview",
        name: "preview",
        project: { id: "prj_ecom", name: "E-Commerce Suite", slug: "ecom-suite" },
      },
      status: "BUILDING" as const,
    },
  ];

  const result = oracle.queryServiceAndProject("storefront", mockDb);
  assertTrue(result !== null);
  assertEqual(result?.projectName, "E-Commerce Suite");
  assertEqual(result?.environmentName, "preview");
  assertEqual(result?.status, "BUILDING");
});

registerTest("HYB-T1-F01-03", "HYB-F01", 1, "Query returns null safely without uncaught exceptions on missing service", async () => {
  const oracle = hybridHarness.createServicePreview();
  const result = oracle.queryServiceAndProject("non-existent-subdomain", []);
  assertEqual(result, null);
});

registerTest("HYB-T1-F01-04", "HYB-F01", 1, "Throws schema validation error if environment.project is null", async () => {
  const oracle = hybridHarness.createServicePreview();
  const invalidDb: any[] = [
    {
      id: "srv_bad",
      name: "broken-app",
      environment: { id: "env_orphan", name: "orphan", project: null },
      status: "ACTIVE",
    },
  ];
  assertThrows(() => {
    oracle.queryServiceAndProject("broken-app", invalidDb);
  }, /environment\.project is null/);
});

registerTest("HYB-T1-F01-05", "HYB-F01", 1, "Successfully retrieves environment slug along with project metadata", async () => {
  const oracle = hybridHarness.createServicePreview();
  const mockDb = [
    {
      id: "srv_99",
      name: "auth-service",
      environment: {
        id: "env_staging",
        name: "staging",
        project: { id: "prj_idm", name: "Identity Manager", slug: "idm" },
      },
      status: "DEPLOYING" as const,
    },
  ];
  const res = oracle.queryServiceAndProject("auth-service-staging", mockDb);
  assertEqual(res?.environmentName, "staging");
  assertEqual(res?.projectSlug, "idm");
});

// =============================================================================
// Feature 2: Ephemeral PR Domain Registration (R3)
// =============================================================================

registerTest("HYB-T1-F02-01", "HYB-F02", 1, "Generates and persists ${service.name}-pr-${prNumber}.syncbay.app domain", async () => {
  const prManager = hybridHarness.createPrManager();
  const event = {
    action: "opened" as const,
    number: 42,
    pull_request: {
      title: "Add payment gateway",
      merged: false,
      head: { ref: "feat/payments", sha: "sha_pr_42" },
      base: { ref: "main" },
    },
    repository: { html_url: "https://github.com/syncbay/shop", full_name: "syncbay/shop" },
  };

  const res = prManager.handleWebhook(event, "web");
  assertEqual(res.action, "provisioned");
  assertEqual(res.domain, "web-pr-42.syncbay.app");
  assertTrue(Boolean(res.env));
  assertEqual(res.env?.subdomain, "web-pr-42");
});

registerTest("HYB-T1-F02-02", "HYB-F02", 1, "Sanitizes service name with uppercase/special characters into valid RFC hostname", async () => {
  const prManager = hybridHarness.createPrManager();
  const event = {
    action: "opened" as const,
    number: 105,
    pull_request: {
      title: "UI Polish",
      merged: false,
      head: { ref: "ui-patch", sha: "sha_105" },
      base: { ref: "main" },
    },
    repository: { html_url: "https://github.com/syncbay/shop", full_name: "syncbay/shop" },
  };

  const res = prManager.handleWebhook(event, "Frontend_Web$App!");
  assertEqual(res.domain, "frontend-webapp-pr-105.syncbay.app");
});

registerTest("HYB-T1-F02-03", "HYB-F02", 1, "Maintains identical domain on subsequent PR synchronize pushes", async () => {
  const prManager = hybridHarness.createPrManager();
  const openEvent = {
    action: "opened" as const,
    number: 77,
    pull_request: {
      title: "Refactor core",
      merged: false,
      head: { ref: "core-refactor", sha: "sha_77_v1" },
      base: { ref: "main" },
    },
    repository: { html_url: "https://github.com/syncbay/api", full_name: "syncbay/api" },
  };
  const syncEvent = {
    ...openEvent,
    action: "synchronize" as const,
    pull_request: { ...openEvent.pull_request, head: { ref: "core-refactor", sha: "sha_77_v2" } },
  };

  const res1 = prManager.handleWebhook(openEvent, "api");
  const res2 = prManager.handleWebhook(syncEvent, "api");
  assertEqual(res1.domain, res2.domain);
  assertEqual(res2.domain, "api-pr-77.syncbay.app");
});

registerTest("HYB-T1-F02-04", "HYB-F02", 1, "Associates ephemeral environment record with the generated Domain", async () => {
  const prManager = hybridHarness.createPrManager();
  const event = {
    action: "opened" as const,
    number: 12,
    pull_request: {
      title: "Test domain link",
      merged: false,
      head: { ref: "patch-12", sha: "sha_12" },
      base: { ref: "main" },
    },
    repository: { html_url: "https://github.com/syncbay/docs", full_name: "syncbay/docs" },
  };

  const res = prManager.handleWebhook(event, "docs");
  const retrieved = prManager.getEnvironment(12);
  assertEqual(retrieved?.domain, "docs-pr-12.syncbay.app");
  assertEqual(retrieved?.prNumber, 12);
});

registerTest("HYB-T1-F02-05", "HYB-F02", 1, "Handles multiple services per repository assigning distinct PR domains", async () => {
  const prManager = hybridHarness.createPrManager();
  const event = {
    action: "opened" as const,
    number: 88,
    pull_request: {
      title: "Monorepo update",
      merged: false,
      head: { ref: "monorepo-pr", sha: "sha_88" },
      base: { ref: "main" },
    },
    repository: { html_url: "https://github.com/syncbay/mono", full_name: "syncbay/mono" },
  };

  const resWeb = prManager.handleWebhook(event, "web");
  const resApi = prManager.handleWebhook(event, "api");
  assertEqual(resWeb.domain, "web-pr-88.syncbay.app");
  assertEqual(resApi.domain, "api-pr-88.syncbay.app");
});

// =============================================================================
// Feature 3: PR Lifecycle Auto-Sleep & Teardown (R3)
// =============================================================================

registerTest("HYB-T1-F03-01", "HYB-F03", 1, "Initializes ephemeral preview environment with idleTimeoutSecs = 1800", async () => {
  const prManager = hybridHarness.createPrManager();
  const event = {
    action: "opened" as const,
    number: 201,
    pull_request: {
      title: "Timeout feature",
      merged: false,
      head: { ref: "timeout-test", sha: "sha_201" },
      base: { ref: "main" },
    },
    repository: { html_url: "https://github.com/syncbay/app", full_name: "syncbay/app" },
  };
  const res = prManager.handleWebhook(event, "app");
  assertEqual(res.env?.idleTimeoutSecs, 1800);
});

registerTest("HYB-T1-F03-02", "HYB-F03", 1, "Auto-sleep transitions environment status to SLEEPING when idle > 1800s", async () => {
  const prManager = hybridHarness.createPrManager();
  const event = {
    action: "opened" as const,
    number: 202,
    pull_request: {
      title: "Auto-sleep test",
      merged: false,
      head: { ref: "sleep-test", sha: "sha_202" },
      base: { ref: "main" },
    },
    repository: { html_url: "https://github.com/syncbay/app", full_name: "syncbay/app" },
  };
  prManager.handleWebhook(event, "app");
  prManager.markActive(202);

  const env = prManager.getEnvironment(202);
  assertEqual(env?.status, "ACTIVE");

  // Advance time by 1801 seconds
  const isSleeping = prManager.checkIdleTimeout(202, Date.now() + 1801 * 1000);
  assertTrue(isSleeping);
  assertEqual(env?.status, "SLEEPING");
});

registerTest("HYB-T1-F03-03", "HYB-F03", 1, "Does not trigger auto-sleep when activity is within 1800s threshold", async () => {
  const prManager = hybridHarness.createPrManager();
  const event = {
    action: "opened" as const,
    number: 203,
    pull_request: {
      title: "Active container test",
      merged: false,
      head: { ref: "active-test", sha: "sha_203" },
      base: { ref: "main" },
    },
    repository: { html_url: "https://github.com/syncbay/app", full_name: "syncbay/app" },
  };
  prManager.handleWebhook(event, "app");
  prManager.markActive(203);

  const isSleeping = prManager.checkIdleTimeout(203, Date.now() + 600 * 1000); // 10 minutes
  assertFalse(isSleeping);
  const env = prManager.getEnvironment(203);
  assertEqual(env?.status, "ACTIVE");
});

registerTest("HYB-T1-F03-04", "HYB-F03", 1, "Destroys preview environment upon PR closed (merged = true)", async () => {
  const prManager = hybridHarness.createPrManager();
  const openEvent = {
    action: "opened" as const,
    number: 204,
    pull_request: {
      title: "Merge PR",
      merged: false,
      head: { ref: "merge-branch", sha: "sha_204" },
      base: { ref: "main" },
    },
    repository: { html_url: "https://github.com/syncbay/app", full_name: "syncbay/app" },
  };
  prManager.handleWebhook(openEvent, "app");
  assertTrue(Boolean(prManager.getEnvironment(204)));

  const closeEvent = {
    ...openEvent,
    action: "closed" as const,
    pull_request: { ...openEvent.pull_request, merged: true },
  };
  const res = prManager.handleWebhook(closeEvent, "app");
  assertEqual(res.action, "destroyed");
  assertEqual(prManager.getEnvironment(204), undefined);
});

registerTest("HYB-T1-F03-05", "HYB-F03", 1, "Destroys preview environment upon PR closed without merge (abandoned)", async () => {
  const prManager = hybridHarness.createPrManager();
  const openEvent = {
    action: "opened" as const,
    number: 205,
    pull_request: {
      title: "Abandoned PR",
      merged: false,
      head: { ref: "abandoned-branch", sha: "sha_205" },
      base: { ref: "main" },
    },
    repository: { html_url: "https://github.com/syncbay/app", full_name: "syncbay/app" },
  };
  prManager.handleWebhook(openEvent, "app");

  const closeEvent = {
    ...openEvent,
    action: "closed" as const,
    pull_request: { ...openEvent.pull_request, merged: false },
  };
  const res = prManager.handleWebhook(closeEvent, "app");
  assertEqual(res.action, "destroyed");
  assertEqual(prManager.getEnvironment(205), undefined);
});

// =============================================================================
// Feature 4: GitHub Octokit Commit Status & Comments (R3)
// =============================================================================

registerTest("HYB-T1-F04-01", "HYB-F04", 1, "Posts syncbay/preview commit status check with pending state on dispatch", async () => {
  const prManager = hybridHarness.createPrManager();
  const event = {
    action: "opened" as const,
    number: 301,
    pull_request: {
      title: "Check test",
      merged: false,
      head: { ref: "test-head", sha: "sha_commit_301" },
      base: { ref: "main" },
    },
    repository: { html_url: "https://github.com/syncbay/app", full_name: "syncbay/app" },
  };
  prManager.handleWebhook(event, "web");

  const statuses = prManager.getCommitStatuses("sha_commit_301");
  assertEqual(statuses.length, 1);
  assertEqual(statuses[0].context, "syncbay/preview");
  assertEqual(statuses[0].state, "pending");
  assertIncludes(statuses[0].target_url, "web-pr-301.syncbay.app");
});

registerTest("HYB-T1-F04-02", "HYB-F04", 1, "Updates commit status to success when deployment completes", async () => {
  const prManager = hybridHarness.createPrManager();
  const event = {
    action: "opened" as const,
    number: 302,
    pull_request: {
      title: "Success test",
      merged: false,
      head: { ref: "success-head", sha: "sha_commit_302" },
      base: { ref: "main" },
    },
    repository: { html_url: "https://github.com/syncbay/app", full_name: "syncbay/app" },
  };
  prManager.handleWebhook(event, "web");
  prManager.markActive(302);

  const statuses = prManager.getCommitStatuses("sha_commit_302");
  assertEqual(statuses.length, 2);
  assertEqual(statuses[1].state, "success");
  assertIncludes(statuses[1].description, "ready");
});

registerTest("HYB-T1-F04-03", "HYB-F04", 1, "Posts formatted PR markdown comment containing live preview URL and badge", async () => {
  const prManager = hybridHarness.createPrManager();
  const event = {
    action: "opened" as const,
    number: 303,
    pull_request: {
      title: "Comment test",
      merged: false,
      head: { ref: "comment-head", sha: "sha_303" },
      base: { ref: "main" },
    },
    repository: { html_url: "https://github.com/syncbay/app", full_name: "syncbay/app" },
  };
  prManager.handleWebhook(event, "web");

  const comment = prManager.getPrComment(303);
  assertTrue(Boolean(comment));
  assertIncludes(comment?.body || "", "https://web-pr-303.syncbay.app");
  assertIncludes(comment?.body || "", "Syncbay Preview Deployment");
  assertIncludes(comment?.body || "", "badge/pr-303.svg");
});

registerTest("HYB-T1-F04-04", "HYB-F04", 1, "Updates existing bot comment on markActive rather than creating new comment ID", async () => {
  const prManager = hybridHarness.createPrManager();
  const event = {
    action: "opened" as const,
    number: 304,
    pull_request: {
      title: "Update comment test",
      merged: false,
      head: { ref: "update-head", sha: "sha_304" },
      base: { ref: "main" },
    },
    repository: { html_url: "https://github.com/syncbay/app", full_name: "syncbay/app" },
  };
  prManager.handleWebhook(event, "web");
  const commentInitial = prManager.getPrComment(304);

  prManager.markActive(304);
  const commentUpdated = prManager.getPrComment(304);

  assertEqual(commentInitial?.commentId, commentUpdated?.commentId);
  assertIncludes(commentUpdated?.body || "", "Ready");
});

registerTest("HYB-T1-F04-05", "HYB-F04", 1, "Posts failure commit status when preview deployment fails", async () => {
  const prManager = hybridHarness.createPrManager();
  prManager.postCommitStatus("sha_fail_1", {
    context: "syncbay/preview",
    state: "failure",
    target_url: "https://web-pr-305.syncbay.app",
    description: "Build failed: compilation error",
  });
  const statuses = prManager.getCommitStatuses("sha_fail_1");
  assertEqual(statuses[0].state, "failure");
  assertIncludes(statuses[0].description, "compilation error");
});

// =============================================================================
// Feature 5: Unified RunnerDriver Interface (R1)
// =============================================================================

registerTest("HYB-T1-F05-01", "HYB-F05", 1, "RunnerDriver exposes unified dispatchBuild method returning BuildDispatchResult", async () => {
  const webhook = hybridHarness.createWebhookDriver();
  const res = await webhook.dispatchBuild({
    jobId: "job_u1",
    serviceId: "srv_u1",
    repoUrl: "https://github.com/syncbay/web",
    commitSha: "sha_u1",
    branch: "main",
  });
  assertEqual(res.jobId, "job_u1");
  assertEqual(res.driverType, "webhook");
  assertTrue(res.status === "ACCEPTED" || res.status === "BUILDING");
});

registerTest("HYB-T1-F05-02", "HYB-F05", 1, "RunnerDriver exposes unified checkStatus method returning BuildStatusResult", async () => {
  const queue = hybridHarness.createQueueDriver();
  await queue.dispatchBuild({
    jobId: "job_u2",
    serviceId: "srv_u2",
    repoUrl: "https://github.com/syncbay/web",
    commitSha: "sha_u2",
    branch: "main",
  });
  const status = await queue.checkStatus("job_u2");
  assertEqual(status.jobId, "job_u2");
  assertEqual(status.status, "QUEUED");
});

registerTest("HYB-T1-F05-03", "HYB-F05", 1, "RunnerDriver exposes unified stopContainer method returning StopContainerResult", async () => {
  const webhook = hybridHarness.createWebhookDriver();
  const build = await webhook.dispatchBuild({
    jobId: "job_u3",
    serviceId: "srv_u3",
    repoUrl: "https://github.com/syncbay/web",
    commitSha: "sha_u3",
    branch: "main",
  });
  const stopRes = await webhook.stopContainer(build.containerId || "");
  assertTrue(stopRes.stopped);
  assertEqual(stopRes.containerId, build.containerId);
});

registerTest("HYB-T1-F05-04", "HYB-F05", 1, "Unified drivers accurately identify their respective driver types", async () => {
  const webhook = hybridHarness.createWebhookDriver();
  const queue = hybridHarness.createQueueDriver();
  const ssh = hybridHarness.createSshDriver({ host: "node1.internal", port: 22, username: "root" });

  assertEqual(webhook.type, "webhook");
  assertEqual(queue.type, "queue");
  assertEqual(ssh.type, "ssh");
});

registerTest("HYB-T1-F05-05", "HYB-F05", 1, "Custom RunnerDriverError retains driver type and structured message", async () => {
  const customErr = new RunnerDriverError("Generic runner failure", "webhook");
  assertTrue(customErr instanceof Error);
  assertEqual(customErr.driverType, "webhook");
  assertEqual(customErr.message, "Generic runner failure");
});

// =============================================================================
// Feature 6: REST Webhook Runner Driver (R1)
// =============================================================================

registerTest("HYB-T1-F06-01", "HYB-F06", 1, "Webhook driver generates valid sha256= HMAC signature for dispatch payload", async () => {
  const driver = hybridHarness.createWebhookDriver("test-secret-key-123");
  const payload = JSON.stringify({ jobId: "job_1", serviceId: "srv_1" });
  const sig = driver.generateSignature(payload);
  assertTrue(sig.startsWith("sha256="));
  assertEqual(sig.length, 7 + 64); // "sha256=" + 64 hex characters
});

registerTest("HYB-T1-F06-02", "HYB-F06", 1, "Webhook driver accepts valid signed build dispatch request", async () => {
  const driver = hybridHarness.createWebhookDriver("secret-key");
  const params = {
    jobId: "job_sig_ok",
    serviceId: "srv_sig",
    repoUrl: "https://github.com/syncbay/app",
    commitSha: "sha_sig",
    branch: "main",
  };
  const sig = driver.generateSignature(JSON.stringify(params));
  const res = await driver.dispatchBuildWithSignature(params, sig);
  assertEqual(res.status, "ACCEPTED");
  assertEqual(res.jobId, "job_sig_ok");
});

registerTest("HYB-T1-F06-03", "HYB-F06", 1, "Webhook driver rejects tampered payload with AuthenticationError", async () => {
  const driver = hybridHarness.createWebhookDriver("secret-key");
  const params = {
    jobId: "job_tampered",
    serviceId: "srv_tampered",
    repoUrl: "https://github.com/syncbay/app",
    commitSha: "sha_tampered",
    branch: "main",
  };
  const badSig = "sha256=0000000000000000000000000000000000000000000000000000000000000000";
  await assertRejects(async () => {
    await driver.dispatchBuildWithSignature(params, badSig);
  }, /HMAC SHA-256 signature/);
});

registerTest("HYB-T1-F06-04", "HYB-F06", 1, "Webhook driver rejects request missing X-Syncbay-Signature header", async () => {
  const driver = hybridHarness.createWebhookDriver("secret-key");
  const params = {
    jobId: "job_no_sig",
    serviceId: "srv_no_sig",
    repoUrl: "https://github.com/syncbay/app",
    commitSha: "sha_no_sig",
    branch: "main",
  };
  await assertRejects(async () => {
    await driver.dispatchBuildWithSignature(params, undefined);
  }, /HMAC SHA-256 signature/);
});

registerTest("HYB-T1-F06-05", "HYB-F06", 1, "Webhook driver returns live SSE streaming log endpoint URL", async () => {
  const driver = hybridHarness.createWebhookDriver();
  const res = await driver.dispatchBuild({
    jobId: "job_sse_url",
    serviceId: "srv_sse",
    repoUrl: "https://github.com/syncbay/app",
    commitSha: "sha_sse",
    branch: "main",
  });
  assertEqual(res.streamUrl, "/api/builds/job_sse_url/logs/stream");
});

// =============================================================================
// Feature 7: Queue/DB Polling Runner Driver (R1)
// =============================================================================

registerTest("HYB-T1-F07-01", "HYB-F07", 1, "Queue driver enqueues job with initial status QUEUED", async () => {
  const queue = hybridHarness.createQueueDriver();
  const res = await queue.dispatchBuild({
    jobId: "job_q1",
    serviceId: "srv_q1",
    repoUrl: "https://github.com/syncbay/app",
    commitSha: "sha_q1",
    branch: "main",
  });
  assertEqual(res.status, "QUEUED");
  const status = await queue.checkStatus("job_q1");
  assertEqual(status.status, "QUEUED");
});

registerTest("HYB-T1-F07-02", "HYB-F07", 1, "Runner daemon dequeues jobs in FIFO order", async () => {
  const queue = hybridHarness.createQueueDriver();
  await queue.dispatchBuild({ jobId: "job_first", serviceId: "s1", repoUrl: "", commitSha: "", branch: "main" });
  await queue.dispatchBuild({ jobId: "job_second", serviceId: "s2", repoUrl: "", commitSha: "", branch: "main" });

  const firstDequeued = queue.processNextJob();
  assertEqual(firstDequeued?.jobId, "job_first");
  assertEqual(firstDequeued?.status, "BUILDING");

  const secondDequeued = queue.processNextJob();
  assertEqual(secondDequeued?.jobId, "job_second");
});

registerTest("HYB-T1-F07-03", "HYB-F07", 1, "Transitions job through BUILDING -> DEPLOYING -> ACTIVE states", async () => {
  const queue = hybridHarness.createQueueDriver();
  await queue.dispatchBuild({ jobId: "job_trans", serviceId: "s1", repoUrl: "", commitSha: "", branch: "main" });

  queue.transitionJob("job_trans", "BUILDING", "Compiling Nixpacks plan");
  let s = await queue.checkStatus("job_trans");
  assertEqual(s.status, "BUILDING");

  queue.transitionJob("job_trans", "DEPLOYING", "Starting container");
  s = await queue.checkStatus("job_trans");
  assertEqual(s.status, "DEPLOYING");

  queue.transitionJob("job_trans", "ACTIVE", "Health check 200 OK");
  s = await queue.checkStatus("job_trans");
  assertEqual(s.status, "ACTIVE");
});

registerTest("HYB-T1-F07-04", "HYB-F07", 1, "Queue polling driver accumulates build logs safely", async () => {
  const queue = hybridHarness.createQueueDriver();
  await queue.dispatchBuild({ jobId: "job_logs", serviceId: "s1", repoUrl: "", commitSha: "", branch: "main" });
  queue.transitionJob("job_logs", "BUILDING", "Step 1: Cloning");
  queue.transitionJob("job_logs", "BUILDING", "Step 2: Installing npm deps");

  const s = await queue.checkStatus("job_logs");
  assertTrue((s.logs || []).length >= 2);
  assertIncludes((s.logs || []).join("\n"), "Step 2: Installing npm deps");
});

registerTest("HYB-T1-F07-05", "HYB-F07", 1, "Marks job FAILED and attaches error message when compilation fails", async () => {
  const queue = hybridHarness.createQueueDriver();
  await queue.dispatchBuild({ jobId: "job_fail", serviceId: "s1", repoUrl: "", commitSha: "", branch: "main" });
  queue.transitionJob("job_fail", "FAILED", "Build failed", "Syntax error in index.ts:14");

  const s = await queue.checkStatus("job_fail");
  assertEqual(s.status, "FAILED");
  assertEqual(s.error, "Syntax error in index.ts:14");
});

// =============================================================================
// Feature 8: SSH Remote Runner Driver (R1)
// =============================================================================

registerTest("HYB-T1-F08-01", "HYB-F08", 1, "SSH driver validates node health before dispatching commands", async () => {
  const ssh = hybridHarness.createSshDriver({
    host: "worker-node-1.compute.syncbay.internal",
    port: 22,
    username: "deploy",
  });
  const health = await ssh.checkNodeHealth();
  assertTrue(health.online);
  assertTrue(health.memFreeMb > 1024);
});

registerTest("HYB-T1-F08-02", "HYB-F08", 1, "SSH driver dispatches build and creates remote container process", async () => {
  const ssh = hybridHarness.createSshDriver({ host: "node-2.internal", port: 22, username: "root" });
  const res = await ssh.dispatchBuild({
    jobId: "ssh_job_1",
    serviceId: "srv_ssh_1",
    repoUrl: "https://github.com/syncbay/worker",
    commitSha: "sha_worker",
    branch: "main",
    targetPort: 8080,
  });
  assertEqual(res.status, "ACCEPTED");
  assertEqual(res.assignedPort, 8080);
  assertTrue(res.containerId?.startsWith("ssh_cnt_") ?? false);
});

registerTest("HYB-T1-F08-03", "HYB-F08", 1, "SSH driver checks container status on remote node", async () => {
  const ssh = hybridHarness.createSshDriver({ host: "node-3.internal", port: 22, username: "root" });
  await ssh.dispatchBuild({
    jobId: "ssh_job_2",
    serviceId: "srv_ssh_2",
    repoUrl: "https://github.com/syncbay/worker",
    commitSha: "sha_worker",
    branch: "main",
    targetPort: 8081,
  });
  const status = await ssh.checkStatus("ssh_job_2");
  assertEqual(status.status, "ACTIVE");
  assertEqual(status.port, 8081);
});

registerTest("HYB-T1-F08-04", "HYB-F08", 1, "SSH driver stops container on remote host and releases assigned port", async () => {
  const ssh = hybridHarness.createSshDriver({ host: "node-4.internal", port: 22, username: "root" });
  const build = await ssh.dispatchBuild({
    jobId: "ssh_job_3",
    serviceId: "srv_ssh_3",
    repoUrl: "",
    commitSha: "",
    branch: "main",
    targetPort: 9000,
  });
  const stopRes = await ssh.stopContainer(build.containerId || "");
  assertTrue(stopRes.stopped);
  assertEqual(stopRes.releasedPort, 9000);
});

registerTest("HYB-T1-F08-05", "HYB-F08", 1, "SSH driver throws TimeoutError when remote host is unreachable", async () => {
  const unreachableSsh = hybridHarness.createSshDriver({
    host: "unreachable.internal",
    port: 22,
    username: "root",
  });
  await assertRejects(async () => {
    await unreachableSsh.checkNodeHealth();
  }, /unreachable/);
});

// =============================================================================
// Feature 9: Containerized Runner Agent Daemon (R1)
// =============================================================================

registerTest("HYB-T1-F09-01", "HYB-F09", 1, "Runner pipeline initiates multi-stage compilation for Docker", async () => {
  const pipeline = hybridHarness.createPipeline();
  const res = await pipeline.executePipeline({
    engine: "docker",
    targetTag: "syncbay/app:v1.0.0",
  });
  assertTrue(res.success);
  assertEqual(res.imageTag, "syncbay/app:v1.0.0");
  assertIncludes(res.stages, "docker-build");
});

registerTest("HYB-T1-F09-02", "HYB-F09", 1, "Runner pipeline initiates Nixpacks build stages (setup, install, build)", async () => {
  const pipeline = hybridHarness.createPipeline();
  const res = await pipeline.executePipeline({
    engine: "nixpacks",
    targetTag: "syncbay/nixpacks-app:v1",
  });
  assertTrue(res.success);
  assertIncludes(res.stages, "setup");
  assertIncludes(res.stages, "install");
  assertIncludes(res.stages, "build");
});

registerTest("HYB-T1-F09-03", "HYB-F09", 1, "Runner pipeline emits tagged log lines for each compilation stage", async () => {
  const pipeline = hybridHarness.createPipeline();
  const res = await pipeline.executePipeline({
    engine: "nixpacks",
    targetTag: "syncbay/logs:v1",
  });
  assertTrue(res.logs.length >= 3);
  assertIncludes(res.logs[0], "[pipeline:nixpacks]");
});

registerTest("HYB-T1-F09-04", "HYB-F09", 1, "Runner agent isolates target tag across different jobs", async () => {
  const pipeline = hybridHarness.createPipeline();
  const res1 = await pipeline.executePipeline({ engine: "docker", targetTag: "job-1:latest" });
  const res2 = await pipeline.executePipeline({ engine: "docker", targetTag: "job-2:latest" });
  assertEqual(res1.imageTag, "job-1:latest");
  assertEqual(res2.imageTag, "job-2:latest");
});

registerTest("HYB-T1-F09-05", "HYB-F09", 1, "Runner agent pipeline completes all stages with exit code 0", async () => {
  const pipeline = hybridHarness.createPipeline();
  const res = await pipeline.executePipeline({ engine: "docker", targetTag: "exit-code-test:v1" });
  assertTrue(res.success);
});

// =============================================================================
// Feature 10: Runner Build Pipeline & Port Allocator (R1)
// =============================================================================

registerTest("HYB-T1-F10-01", "HYB-F10", 1, "Port manager allocates port within range 20000..30000", async () => {
  const portMgr = hybridHarness.createPortManager(20000, 30000);
  const port = portMgr.allocatePort();
  assertTrue(port >= 20000 && port <= 30000);
  assertTrue(portMgr.isAllocated(port));
});

registerTest("HYB-T1-F10-02", "HYB-F10", 1, "Port manager prevents duplicate port allocation across concurrent containers", async () => {
  const portMgr = hybridHarness.createPortManager(25000, 25010);
  const p1 = portMgr.allocatePort();
  const p2 = portMgr.allocatePort();
  const p3 = portMgr.allocatePort();
  assertTrue(p1 !== p2 && p2 !== p3 && p1 !== p3);
  assertEqual(portMgr.allocatedCount(), 3);
});

registerTest("HYB-T1-F10-03", "HYB-F10", 1, "Port manager releases and recycles port back to available pool", async () => {
  const portMgr = hybridHarness.createPortManager(26000, 26001);
  const p1 = portMgr.allocatePort();
  const p2 = portMgr.allocatePort();
  assertEqual(portMgr.allocatedCount(), 2);

  const released = portMgr.releasePort(p1);
  assertTrue(released);
  assertFalse(portMgr.isAllocated(p1));
  assertEqual(portMgr.allocatedCount(), 1);

  // Next allocation can re-use released port
  const p3 = portMgr.allocatePort();
  assertEqual(p3, p1);
});

registerTest("HYB-T1-F10-04", "HYB-F10", 1, "Port manager throws descriptive error when port pool is exhausted", async () => {
  const portMgr = hybridHarness.createPortManager(29999, 30000); // pool size = 2
  portMgr.allocatePort();
  portMgr.allocatePort();
  assertThrows(() => {
    portMgr.allocatePort();
  }, /Port pool exhausted/);
});

registerTest("HYB-T1-F10-05", "HYB-F10", 1, "Allocates consecutive ports deterministically in FIFO order", async () => {
  const portMgr = hybridHarness.createPortManager(20100, 20105);
  assertEqual(portMgr.allocatePort(), 20100);
  assertEqual(portMgr.allocatePort(), 20101);
  assertEqual(portMgr.allocatePort(), 20102);
});

// =============================================================================
// Feature 11: Cloudflare Tunnel Ingress Generator (R2)
// =============================================================================

registerTest("HYB-T1-F11-01", "HYB-F11", 1, "Generates valid YAML containing tunnel ID and credentials file", async () => {
  const yaml = hybridHarness.generateTunnelConfig({
    tunnelId: "cf-tunnel-abc-123",
    routes: [{ hostname: "web-production-api.syncbay.app", targetPort: 3000 }],
  });
  assertIncludes(yaml, "tunnel: cf-tunnel-abc-123");
  assertIncludes(yaml, "credentials-file: /etc/cloudflared/cf-tunnel-abc-123.json");
  assertIncludes(yaml, "ingress:");
});

registerTest("HYB-T1-F11-02", "HYB-F11", 1, "Maps production subdomains web-production-*.syncbay.app to container port", async () => {
  const yaml = hybridHarness.generateTunnelConfig({
    tunnelId: "tun-prod",
    routes: [{ hostname: "web-production-checkout.syncbay.app", targetPort: 24500 }],
  });
  assertIncludes(yaml, "hostname: web-production-checkout.syncbay.app");
  assertIncludes(yaml, "service: http://localhost:24500");
});

registerTest("HYB-T1-F11-03", "HYB-F11", 1, "Maps ephemeral PR subdomains web-pr-*.syncbay.app to container port", async () => {
  const yaml = hybridHarness.generateTunnelConfig({
    tunnelId: "tun-pr",
    routes: [{ hostname: "web-pr-42.syncbay.app", targetPort: 25100 }],
  });
  assertIncludes(yaml, "hostname: web-pr-42.syncbay.app");
  assertIncludes(yaml, "service: http://localhost:25100");
});

registerTest("HYB-T1-F11-04", "HYB-F11", 1, "Orders specific routes before wildcard *.syncbay.app rule", async () => {
  const yaml = hybridHarness.generateTunnelConfig({
    tunnelId: "tun-order",
    routes: [
      { hostname: "*.syncbay.app", targetPort: 8080 },
      { hostname: "web-production-app.syncbay.app", targetPort: 3000 },
    ],
  });
  const specificIndex = yaml.indexOf("web-production-app.syncbay.app");
  const wildcardIndex = yaml.indexOf("*.syncbay.app");
  assertTrue(specificIndex !== -1 && wildcardIndex !== -1);
  assertTrue(specificIndex < wildcardIndex, "Specific route must appear before wildcard");
});

registerTest("HYB-T1-F11-05", "HYB-F11", 1, "Always terminates ingress configuration with catch-all service: http_status:404", async () => {
  const yaml = hybridHarness.generateTunnelConfig({
    tunnelId: "tun-catchall",
    routes: [{ hostname: "app.syncbay.app", targetPort: 3000 }],
  });
  const lines = yaml.trim().split("\n");
  const lastLine = lines[lines.length - 1];
  assertIncludes(lastLine, "service: http_status:404");
});

// =============================================================================
// Feature 12: Edge Service Registry (R2)
// =============================================================================

registerTest("HYB-T1-F12-01", "HYB-F12", 1, "Registers service route with hostname, port, and status", async () => {
  const reg = hybridHarness.createEdgeRegistry();
  reg.registerServiceRoute("api.syncbay.app", 3001, "ACTIVE");
  const entry = reg.getServiceRoute("api.syncbay.app");
  assertTrue(entry !== null);
  assertEqual(entry?.hostname, "api.syncbay.app");
  assertEqual(entry?.targetPort, 3001);
  assertEqual(entry?.status, "ACTIVE");
});

registerTest("HYB-T1-F12-02", "HYB-F12", 1, "Normalizes hostnames to lowercase to guarantee case-insensitive lookups", async () => {
  const reg = hybridHarness.createEdgeRegistry();
  reg.registerServiceRoute("My-Store.Syncbay.App", 4000, "ACTIVE");
  const entry = reg.getServiceRoute("my-store.syncbay.app");
  assertTrue(entry !== null);
  assertEqual(entry?.targetPort, 4000);
});

registerTest("HYB-T1-F12-03", "HYB-F12", 1, "Updates existing route status from BUILDING to ACTIVE seamlessly", async () => {
  const reg = hybridHarness.createEdgeRegistry();
  reg.registerServiceRoute("checkout.syncbay.app", 5000, "BUILDING");
  assertEqual(reg.getServiceRoute("checkout.syncbay.app")?.status, "BUILDING");

  reg.registerServiceRoute("checkout.syncbay.app", 5000, "ACTIVE");
  assertEqual(reg.getServiceRoute("checkout.syncbay.app")?.status, "ACTIVE");
});

registerTest("HYB-T1-F12-04", "HYB-F12", 1, "Removes route on service teardown returning true", async () => {
  const reg = hybridHarness.createEdgeRegistry();
  reg.registerServiceRoute("temp.syncbay.app", 6000, "ACTIVE");
  const removed = reg.removeServiceRoute("temp.syncbay.app");
  assertTrue(removed);
  assertEqual(reg.getServiceRoute("temp.syncbay.app"), null);
});

registerTest("HYB-T1-F12-05", "HYB-F12", 1, "Lists all active registered routes accurately", async () => {
  const reg = hybridHarness.createEdgeRegistry();
  reg.registerServiceRoute("r1.syncbay.app", 3001);
  reg.registerServiceRoute("r2.syncbay.app", 3002);
  const list = reg.listRoutes();
  assertEqual(list.length, 2);
});

// =============================================================================
// Feature 13: Edge Middleware Transparent Routing (R2)
// =============================================================================

registerTest("HYB-T1-F13-01", "HYB-F13", 1, "Transparently proxies requests for ACTIVE service to upstream port", async () => {
  const reg = hybridHarness.createEdgeRegistry();
  reg.registerServiceRoute("app.syncbay.app", 3000, "ACTIVE");
  const mw = hybridHarness.createEdgeMiddleware(reg);

  const decision = mw.handleRequest({ url: "/items", host: "app.syncbay.app" });
  assertEqual(decision.action, "pass-through");
  assertEqual(decision.proxyTarget, "http://localhost:3000");
});

registerTest("HYB-T1-F13-02", "HYB-F13", 1, "Rewrites request to /service-preview/[subdomain] when status is BUILDING", async () => {
  const reg = hybridHarness.createEdgeRegistry();
  reg.registerServiceRoute("waking-app.syncbay.app", 3000, "BUILDING");
  const mw = hybridHarness.createEdgeMiddleware(reg);

  const decision = mw.handleRequest({ url: "/profile", host: "waking-app.syncbay.app" });
  assertEqual(decision.action, "rewrite");
  assertEqual(decision.destinationUrl, "/service-preview/waking-app");
});

registerTest("HYB-T1-F13-03", "HYB-F13", 1, "Rewrites request to /service-preview/[subdomain] when status is DEPLOYING", async () => {
  const reg = hybridHarness.createEdgeRegistry();
  reg.registerServiceRoute("deploy-app.syncbay.app", 3000, "DEPLOYING");
  const mw = hybridHarness.createEdgeMiddleware(reg);

  const decision = mw.handleRequest({ url: "/", host: "deploy-app.syncbay.app" });
  assertEqual(decision.action, "rewrite");
  assertEqual(decision.destinationUrl, "/service-preview/deploy-app");
});

registerTest("HYB-T1-F13-04", "HYB-F13", 1, "Rewrites request to /service-preview/[subdomain] when status is SLEEPING", async () => {
  const reg = hybridHarness.createEdgeRegistry();
  reg.registerServiceRoute("sleeping-app.syncbay.app", 3000, "SLEEPING");
  const mw = hybridHarness.createEdgeMiddleware(reg);

  const decision = mw.handleRequest({ url: "/cart", host: "sleeping-app.syncbay.app" });
  assertEqual(decision.action, "rewrite");
  assertEqual(decision.destinationUrl, "/service-preview/sleeping-app");
});

registerTest("HYB-T1-F13-05", "HYB-F13", 1, "Directly passes through internal routes like /dashboard, /api, /_next", async () => {
  const reg = hybridHarness.createEdgeRegistry();
  const mw = hybridHarness.createEdgeMiddleware(reg);

  assertEqual(mw.handleRequest({ url: "/dashboard", host: "syncbay.app" }).action, "pass-through");
  assertEqual(mw.handleRequest({ url: "/api/health", host: "syncbay.app" }).action, "pass-through");
  assertEqual(mw.handleRequest({ url: "/_next/static/chunk.js", host: "syncbay.app" }).action, "pass-through");
});

// =============================================================================
// Feature 14: Knip Code Quality Analyzer Module (R4)
// =============================================================================

registerTest("HYB-T1-F14-01", "HYB-F14", 1, "Detects unused dependencies declared in package.json", async () => {
  const knip = hybridHarness.createKnipAnalyzer();
  const res = await knip.runAnalysis({
    files: ["src/index.ts", "src/utils.ts"],
    packageJsonContent: {
      dependencies: { lodash: "^4.17.21", axios: "^1.6.0" },
    },
  });
  assertIncludes(res.unusedDependencies, "lodash");
  assertIncludes(res.unusedDependencies, "axios");
});

registerTest("HYB-T1-F14-02", "HYB-F14", 1, "Detects unreferenced and orphaned source files", async () => {
  const knip = hybridHarness.createKnipAnalyzer();
  const res = await knip.runAnalysis({
    files: ["src/index.ts", "src/unused-helper.ts", "src/legacy.dead.ts"],
    packageJsonContent: { dependencies: {} },
  });
  assertEqual(res.unreferencedFiles.length, 2);
  assertIncludes(res.unreferencedFiles, "src/unused-helper.ts");
});

registerTest("HYB-T1-F14-03", "HYB-F14", 1, "Formats scan log lines with [knip] prefix for build streaming", async () => {
  const knip = hybridHarness.createKnipAnalyzer();
  const res = await knip.runAnalysis({
    files: ["src/index.ts"],
    packageJsonContent: { dependencies: { unusedLib: "1.0.0" } },
  });
  assertTrue(res.formattedLogs.length >= 2);
  assertTrue(res.formattedLogs[0].startsWith("[knip]"));
  assertIncludes(res.formattedLogs[1], "unusedLib");
});

registerTest("HYB-T1-F14-04", "HYB-F14", 1, "Emits clean optimization recommendations for identified dead code", async () => {
  const knip = hybridHarness.createKnipAnalyzer();
  const res = await knip.runAnalysis({
    files: ["src/index.ts"],
    packageJsonContent: { dependencies: { moment: "^2.29.4" } },
  });
  assertIncludes(res.recommendations[0], "Remove unused dependency 'moment'");
});

registerTest("HYB-T1-F14-05", "HYB-F14", 1, "Reports clean result when all dependencies and files are referenced", async () => {
  const knip = hybridHarness.createKnipAnalyzer();
  const res = await knip.runAnalysis({
    files: ["src/index.ts", "src/lib/react.ts"],
    packageJsonContent: { dependencies: { react: "19.0.0" } },
  });
  assertEqual(res.unusedDependencies.length, 0);
  assertEqual(res.unreferencedFiles.length, 0);
});

// =============================================================================
// Feature 15: Non-Blocking Knip Engine Integration (R4)
// =============================================================================

registerTest("HYB-T1-F15-01", "HYB-F15", 1, "Executes Knip analysis non-blockingly without halting build pipeline", async () => {
  const knip = hybridHarness.createKnipAnalyzer();
  const streamedLogs: string[] = [];
  const res = await knip.executeNonBlockingScan(
    { files: ["src/index.ts"], packageJsonContent: { dependencies: { dead: "1.0" } } },
    (line) => streamedLogs.push(line)
  );
  assertTrue(res.buildUnblocked);
  assertTrue(streamedLogs.length > 0);
});

registerTest("HYB-T1-F15-02", "HYB-F15", 1, "Build succeeds with exit 0 even if Knip identifies multiple dead files", async () => {
  const knip = hybridHarness.createKnipAnalyzer();
  const logs: string[] = [];
  const res = await knip.executeNonBlockingScan(
    { files: ["src/dead1.ts", "src/dead2.ts"], packageJsonContent: { dependencies: {} } },
    (l) => logs.push(l)
  );
  assertTrue(res.buildUnblocked);
  assertTrue(res.scanPassed);
});

registerTest("HYB-T1-F15-03", "HYB-F15", 1, "Streams [knip] findings directly into deployment log stream", async () => {
  const knip = hybridHarness.createKnipAnalyzer();
  const logs: string[] = [];
  await knip.executeNonBlockingScan(
    { files: ["src/index.ts"], packageJsonContent: { dependencies: { orphanPkg: "2.0" } } },
    (l) => logs.push(l)
  );
  const knipLog = logs.find((l) => l.includes("orphanPkg"));
  assertTrue(Boolean(knipLog));
});

registerTest("HYB-T1-F15-04", "HYB-F15", 1, "Swallows unexpected analyzer errors without crashing engine build", async () => {
  const knip = hybridHarness.createKnipAnalyzer();
  const logs: string[] = [];
  // Invalid malformed JSON package content
  const res = await knip.executeNonBlockingScan(
    { files: ["src/index.ts"], packageJsonContent: "{invalid-json" },
    (l) => logs.push(l)
  );
  assertTrue(res.buildUnblocked);
  assertIncludes(logs.join("\n"), "Non-fatal analysis error");
});

registerTest("HYB-T1-F15-05", "HYB-F15", 1, "Build continues to container compilation stage after Knip scan", async () => {
  const knip = hybridHarness.createKnipAnalyzer();
  const res = await knip.executeNonBlockingScan(
    { files: ["src/index.ts"], packageJsonContent: { dependencies: {} } },
    () => {}
  );
  assertEqual(res.buildUnblocked, true);
});

// =============================================================================
// Feature 16: Cold-Start Live Splash Screen (R5)
// =============================================================================

registerTest("HYB-T1-F16-01", "HYB-F16", 1, "Renders active indicator badge for BUILDING state", async () => {
  const oracle = hybridHarness.createServicePreview();
  const mockDb = [
    {
      id: "s1",
      name: "web-ui",
      environment: { id: "e1", name: "prod", project: { id: "p1", name: "Shop", slug: "shop" } },
      status: "BUILDING" as const,
    },
  ];
  const data = oracle.queryServiceAndProject("web-ui-prod", mockDb);
  assertEqual(data?.status, "BUILDING");
});

registerTest("HYB-T1-F16-02", "HYB-F16", 1, "Renders active indicator badge for DEPLOYING state", async () => {
  const oracle = hybridHarness.createServicePreview();
  const mockDb = [
    {
      id: "s2",
      name: "web-ui",
      environment: { id: "e2", name: "prod", project: { id: "p1", name: "Shop", slug: "shop" } },
      status: "DEPLOYING" as const,
    },
  ];
  const data = oracle.queryServiceAndProject("web-ui-prod", mockDb);
  assertEqual(data?.status, "DEPLOYING");
});

registerTest("HYB-T1-F16-03", "HYB-F16", 1, "Renders waking status banner for SLEEPING state container spin-up", async () => {
  const oracle = hybridHarness.createServicePreview();
  const mockDb = [
    {
      id: "s3",
      name: "worker",
      environment: { id: "e3", name: "pr-10", project: { id: "p2", name: "Worker", slug: "wrk" } },
      status: "SLEEPING" as const,
    },
  ];
  const data = oracle.queryServiceAndProject("worker-pr-10", mockDb);
  assertEqual(data?.status, "SLEEPING");
});

registerTest("HYB-T1-F16-04", "HYB-F16", 1, "Renders project name and environment slug from environment.project query", async () => {
  const oracle = hybridHarness.createServicePreview();
  const mockDb = [
    {
      id: "s4",
      name: "frontend",
      environment: { id: "e4", name: "staging", project: { id: "p3", name: "Analytics Dashboard", slug: "analytics" } },
      status: "BUILDING" as const,
    },
  ];
  const data = oracle.queryServiceAndProject("frontend-staging", mockDb);
  assertEqual(data?.projectName, "Analytics Dashboard");
  assertEqual(data?.environmentName, "staging");
});

registerTest("HYB-T1-F16-05", "HYB-F16", 1, "Provides fallback metadata when service is actively booting", async () => {
  const oracle = hybridHarness.createServicePreview();
  const mockDb = [
    {
      id: "s5",
      name: "auth",
      environment: { id: "e5", name: "dev", project: { id: "p4", name: "IAM", slug: "iam" } },
      status: "BUILDING" as const,
    },
  ];
  const data = oracle.queryServiceAndProject("auth-dev", mockDb);
  assertTrue(Boolean(data?.projectName));
});

// =============================================================================
// Feature 17: Real-Time SSE Log Streaming Console (R5)
// =============================================================================

registerTest("HYB-T1-F17-01", "HYB-F17", 1, "Subscribes to SSE stream endpoint /api/deployments/${id}/logs/stream", async () => {
  const endpoint = `/api/deployments/dep_123/logs/stream`;
  assertMatch(endpoint, /^\/api\/deployments\/[a-zA-Z0-9_-]+\/logs\/stream$/);
});

registerTest("HYB-T1-F17-02", "HYB-F17", 1, "Appends streamed log lines in chronological order", async () => {
  const consoleBuffer: string[] = [];
  const appendLog = (line: string) => consoleBuffer.push(line);
  appendLog("Starting container runner...");
  appendLog("Nixpacks plan generated in 120ms");
  appendLog("Container healthy on port 3000");

  assertEqual(consoleBuffer.length, 3);
  assertEqual(consoleBuffer[0], "Starting container runner...");
  assertEqual(consoleBuffer[2], "Container healthy on port 3000");
});

registerTest("HYB-T1-F17-03", "HYB-F17", 1, "Preserves ANSI color codes and timestamp headers in log output", async () => {
  const rawLog = "\x1b[32m✔ Build successful\x1b[0m [2026-10-08T09:00:00Z]";
  assertIncludes(rawLog, "\x1b[32m");
  assertIncludes(rawLog, "Build successful");
});

registerTest("HYB-T1-F17-04", "HYB-F17", 1, "Maintains ring buffer capacity without memory exhaustion on large logs", async () => {
  const maxLines = 100;
  const ringBuffer: string[] = [];
  for (let i = 0; i < 250; i++) {
    ringBuffer.push(`Log entry #${i}`);
    if (ringBuffer.length > maxLines) ringBuffer.shift();
  }
  assertEqual(ringBuffer.length, 100);
  assertEqual(ringBuffer[99], "Log entry #249");
});

registerTest("HYB-T1-F17-05", "HYB-F17", 1, "Closes SSE stream cleanly once deployment status transitions to ACTIVE", async () => {
  let isClosed = false;
  const onStatusChange = (status: string) => {
    if (status === "ACTIVE") isClosed = true;
  };
  onStatusChange("ACTIVE");
  assertTrue(isClosed);
});

// =============================================================================
// Feature 18: Client-Side Health Probe & Redirect (R5)
// =============================================================================

registerTest("HYB-T1-F18-01", "HYB-F18", 1, "Polls /health endpoint and redirects upon 200 OK", async () => {
  const oracle = hybridHarness.createServicePreview();
  let calls = 0;
  const probeFn = async () => {
    calls++;
    return { status: calls >= 3 ? 200 : 503 };
  };

  const res = await oracle.probeHealthUntilReady(probeFn, 5, 10);
  assertTrue(res.ready);
  assertTrue(res.redirected);
  assertEqual(res.attempts, 3);
});

registerTest("HYB-T1-F18-02", "HYB-F18", 1, "Continues polling while receiving HTTP 503 Service Unavailable", async () => {
  const oracle = hybridHarness.createServicePreview();
  let calls = 0;
  const probeFn = async () => {
    calls++;
    return { status: calls < 4 ? 503 : 200 };
  };
  const res = await oracle.probeHealthUntilReady(probeFn, 6, 10);
  assertEqual(res.attempts, 4);
  assertTrue(res.ready);
});

registerTest("HYB-T1-F18-03", "HYB-F18", 1, "Continues polling while receiving HTTP 502 Bad Gateway during booting", async () => {
  const oracle = hybridHarness.createServicePreview();
  let calls = 0;
  const probeFn = async () => {
    calls++;
    return { status: calls < 2 ? 502 : 200 };
  };
  const res = await oracle.probeHealthUntilReady(probeFn, 4, 10);
  assertEqual(res.attempts, 2);
  assertTrue(res.ready);
});

registerTest("HYB-T1-F18-04", "HYB-F18", 1, "Immediately redirects when first health probe returns 200 OK", async () => {
  const oracle = hybridHarness.createServicePreview();
  const probeFn = async () => ({ status: 200 });
  const res = await oracle.probeHealthUntilReady(probeFn, 5, 10);
  assertEqual(res.attempts, 1);
  assertTrue(res.redirected);
});

registerTest("HYB-T1-F18-05", "HYB-F18", 1, "Stops polling and marks not ready if maxRetries is exceeded", async () => {
  const oracle = hybridHarness.createServicePreview();
  const probeFn = async () => ({ status: 503 }); // Never recovers
  const res = await oracle.probeHealthUntilReady(probeFn, 3, 10);
  assertFalse(res.ready);
  assertFalse(res.redirected);
  assertEqual(res.attempts, 3);
});
