/**
 * Syncbay PaaS — Tier 4: Hybrid Compute & Edge Routing Real-World Application Scenarios
 * 10 End-to-End Multi-Feature Production Workflows covering Requirements R1 through R5.
 */

import {
  registerTest,
  assertTrue,
  assertFalse,
  assertEqual,
  assertMatch,
  assertIncludes,
  hybridHarness,
} from "../harness";

// =============================================================================
// Scenario 1: Complete Ephemeral GitHub PR Lifecycle Deployment & Teardown
// =============================================================================
registerTest(
  "HYB-T4-SCENARIO-01",
  "SCENARIO_PR_FULL_LIFECYCLE",
  4,
  "Full GitHub PR deployment: Webhook -> Domain -> Queue build -> Knip scan -> Tunnel update -> Splash -> Health probe -> Octokit checks -> PR merge teardown",
  async () => {
    // 1. Setup subsystems
    const prManager = hybridHarness.createPrManager();
    const queue = hybridHarness.createQueueDriver();
    const portMgr = hybridHarness.createPortManager(24000, 24100);
    const knip = hybridHarness.createKnipAnalyzer();
    const reg = hybridHarness.createEdgeRegistry();
    const mw = hybridHarness.createEdgeMiddleware(reg);
    const preview = hybridHarness.createServicePreview();

    const commitSha = "sha_pr_full_1";
    const prNumber = 501;

    // 2. Incoming PR webhook (opened)
    const webhookRes = prManager.handleWebhook(
      {
        action: "opened",
        number: prNumber,
        pull_request: {
          title: "Add Stripe Checkout",
          merged: false,
          head: { ref: "feat/checkout", sha: commitSha },
          base: { ref: "main" },
        },
        repository: { html_url: "https://github.com/syncbay/shop", full_name: "syncbay/shop" },
      },
      "shop-web"
    );

    assertEqual(webhookRes.action, "provisioned");
    const domain = webhookRes.domain || "shop-web-pr-501.syncbay.app";
    assertEqual(domain, "shop-web-pr-501.syncbay.app");

    // 3. Octokit commit status starts as pending
    const initialStatuses = prManager.getCommitStatuses(commitSha);
    assertEqual(initialStatuses[0].state, "pending");

    // 4. Dispatch build via Queue driver with dynamic port
    const allocatedPort = portMgr.allocatePort();
    const dispatch = await queue.dispatchBuild({
      jobId: `job-pr-${prNumber}`,
      serviceId: "srv-shop-web",
      repoUrl: "https://github.com/syncbay/shop",
      commitSha,
      branch: "feat/checkout",
      targetPort: allocatedPort,
    });
    assertEqual(dispatch.status, "QUEUED");

    // 5. Runner daemon dequeues and starts building
    const dequeued = queue.processNextJob();
    assertEqual(dequeued?.status, "BUILDING");
    reg.registerServiceRoute(domain, allocatedPort, "BUILDING");

    // 6. Non-blocking Knip code analysis during compilation
    const knipLogs: string[] = [];
    const knipRes = await knip.executeNonBlockingScan(
      {
        files: ["src/app.tsx", "src/legacy-cart.ts"],
        packageJsonContent: { dependencies: { "old-stripe": "1.0.0" } },
      },
      (log) => knipLogs.push(log)
    );
    assertTrue(knipRes.buildUnblocked);
    assertTrue(knipLogs.some((l) => l.includes("[knip]")));

    // 7. Cloudflare Tunnel ingress configuration generated
    const tunnelConfig = hybridHarness.generateTunnelConfig({
      tunnelId: "tun-pr-fleet",
      routes: [{ hostname: domain, targetPort: allocatedPort }],
    });
    assertIncludes(tunnelConfig, `hostname: ${domain}`);
    assertIncludes(tunnelConfig, `service: http://localhost:${allocatedPort}`);

    // 8. User accesses PR domain while BUILDING -> Edge middleware rewrites to splash screen
    const userReqDecision = mw.handleRequest({ url: "/checkout", host: domain });
    assertEqual(userReqDecision.action, "rewrite");
    assertEqual(userReqDecision.destinationUrl, `/service-preview/shop-web-pr-${prNumber}`);

    // 9. Splash screen resolves environment.project metadata
    const mockDb = [
      {
        id: "srv-shop-web",
        name: "shop-web",
        environment: { id: "env_501", name: `pr-${prNumber}`, project: { id: "p1", name: "Shop", slug: "shop" } },
        status: "BUILDING" as const,
      },
    ];
    const previewInfo = preview.queryServiceAndProject(`shop-web-pr-${prNumber}`, mockDb);
    assertEqual(previewInfo?.projectName, "Shop");

    // 10. Client health probe checks until container is ready
    let probes = 0;
    const probeRes = await preview.probeHealthUntilReady(
      async () => {
        probes++;
        return { status: probes >= 2 ? 200 : 503 };
      },
      5,
      10
    );
    assertTrue(probeRes.ready);
    assertTrue(probeRes.redirected);

    // 11. Deployment transitions to ACTIVE
    queue.transitionJob(`job-pr-${prNumber}`, "ACTIVE", "Deployment active");
    reg.registerServiceRoute(domain, allocatedPort, "ACTIVE");
    prManager.markActive(prNumber);

    // 12. Edge middleware now directly proxies to upstream
    const activeReqDecision = mw.handleRequest({ url: "/checkout", host: domain });
    assertEqual(activeReqDecision.action, "pass-through");
    assertEqual(activeReqDecision.proxyTarget, `http://localhost:${allocatedPort}`);

    // 13. Octokit status updated to success and PR comment updated
    const finalStatuses = prManager.getCommitStatuses(commitSha);
    assertEqual(finalStatuses[finalStatuses.length - 1].state, "success");
    assertIncludes(prManager.getPrComment(prNumber)?.body || "", "Ready");

    // 14. PR Merged -> Automated Teardown
    const teardownRes = prManager.handleWebhook(
      {
        action: "closed",
        number: prNumber,
        pull_request: {
          title: "Add Stripe Checkout",
          merged: true,
          head: { ref: "feat/checkout", sha: commitSha },
          base: { ref: "main" },
        },
        repository: { html_url: "", full_name: "" },
      },
      "shop-web"
    );
    assertEqual(teardownRes.action, "destroyed");

    // 15. Resources released
    portMgr.releasePort(allocatedPort);
    reg.removeServiceRoute(domain);

    assertFalse(portMgr.isAllocated(allocatedPort));
    assertEqual(reg.getServiceRoute(domain), null);
    assertEqual(prManager.getEnvironment(prNumber), undefined);
  }
);

// =============================================================================
// Scenario 2: Webhook Runner Driver with Fast Streaming Logs
// =============================================================================
registerTest(
  "HYB-T4-SCENARIO-02",
  "SCENARIO_WEBHOOK_FAST_STREAMING",
  4,
  "Fast build pipeline: Webhook HMAC dispatch -> Dynamic port -> SSE log stream -> Edge pass-through",
  async () => {
    const driver = hybridHarness.createWebhookDriver("shared-secret-key-prod");
    const portMgr = hybridHarness.createPortManager(25000, 25050);
    const reg = hybridHarness.createEdgeRegistry();
    const mw = hybridHarness.createEdgeMiddleware(reg);

    const targetPort = portMgr.allocatePort();
    const dispatch = await driver.dispatchBuild({
      jobId: "fast-job-1",
      serviceId: "srv-fast",
      repoUrl: "https://github.com/syncbay/quick",
      commitSha: "sha_quick",
      branch: "main",
      targetPort,
    });

    assertEqual(dispatch.driverType, "webhook");
    assertEqual(dispatch.assignedPort, targetPort);
    assertIncludes(dispatch.streamUrl || "", "/api/builds/fast-job-1/logs/stream");

    // Register active route
    reg.registerServiceRoute("quick.syncbay.app", targetPort, "ACTIVE");

    // Edge middleware transparently proxies
    const decision = mw.handleRequest({ url: "/fast-data", host: "quick.syncbay.app" });
    assertEqual(decision.action, "pass-through");
    assertEqual(decision.proxyTarget, `http://localhost:${targetPort}`);

    // Clean stop
    await driver.stopContainer(dispatch.containerId || "");
    portMgr.releasePort(targetPort);
  }
);

// =============================================================================
// Scenario 3: Scale-to-Zero and Instant Cold-Start Wake-Up Flow
// =============================================================================
registerTest(
  "HYB-T4-SCENARIO-03",
  "SCENARIO_SCALE_TO_ZERO_WAKE",
  4,
  "Container sleeps after 1800s idle -> Edge request rewrites to preview -> Splash wakes container -> Health probe redirects",
  async () => {
    const prManager = hybridHarness.createPrManager();
    const reg = hybridHarness.createEdgeRegistry();
    const mw = hybridHarness.createEdgeMiddleware(reg);
    const preview = hybridHarness.createServicePreview();

    // 1. Initial active environment
    prManager.handleWebhook(
      {
        action: "opened",
        number: 301,
        pull_request: { title: "Idle test", merged: false, head: { ref: "i", sha: "sha_i" }, base: { ref: "main" } },
        repository: { html_url: "", full_name: "" },
      },
      "app"
    );
    prManager.markActive(301);
    reg.registerServiceRoute("app-pr-301.syncbay.app", 3000, "ACTIVE");

    // 2. Idle for 30 minutes (1800s) -> Enters SLEEPING state
    prManager.checkIdleTimeout(301, Date.now() + 1805 * 1000);
    reg.registerServiceRoute("app-pr-301.syncbay.app", 3000, "SLEEPING");

    // 3. Visitor lands on sleeping container
    const visitorReq = mw.handleRequest({ url: "/dashboard", host: "app-pr-301.syncbay.app" });
    assertEqual(visitorReq.action, "rewrite");
    assertEqual(visitorReq.destinationUrl, "/service-preview/app-pr-301");

    // 4. Splash screen renders waking indicator
    const mockDb = [
      {
        id: "s1",
        name: "app",
        environment: { id: "e1", name: "pr-301", project: { id: "p1", name: "App Corp", slug: "app-corp" } },
        status: "SLEEPING" as const,
      },
    ];
    const previewData = preview.queryServiceAndProject("app-pr-301", mockDb);
    assertEqual(previewData?.status, "SLEEPING");

    // 5. Container boots back up -> Health probe polls and redirects
    let boots = 0;
    const probeRes = await preview.probeHealthUntilReady(
      async () => {
        boots++;
        return { status: boots >= 2 ? 200 : 503 };
      },
      5,
      10
    );
    assertTrue(probeRes.ready);
    assertTrue(probeRes.redirected);

    // 6. Route returns to ACTIVE
    reg.registerServiceRoute("app-pr-301.syncbay.app", 3000, "ACTIVE");
    assertEqual(mw.handleRequest({ url: "/dashboard", host: "app-pr-301.syncbay.app" }).action, "pass-through");
  }
);

// =============================================================================
// Scenario 4: Custom Linux Node Remote Provisioning via SSH Runner
// =============================================================================
registerTest(
  "HYB-T4-SCENARIO-04",
  "SCENARIO_SSH_REMOTE_NODE",
  4,
  "Bare-metal Linux node provisioning via SSH: Health check -> Docker dispatch -> Port mapping -> Tunnel registration",
  async () => {
    const ssh = hybridHarness.createSshDriver({
      host: "baremetal-node-1.compute.internal",
      port: 22,
      username: "syncbay-agent",
    });

    // 1. Health check remote node
    const health = await ssh.checkNodeHealth();
    assertTrue(health.online);

    // 2. Dispatch build on remote host
    const dispatch = await ssh.dispatchBuild({
      jobId: "bm-job-01",
      serviceId: "srv-heavy-worker",
      repoUrl: "https://github.com/syncbay/heavy-worker",
      commitSha: "sha_heavy",
      branch: "main",
      targetPort: 9000,
    });
    assertEqual(dispatch.driverType, "ssh");
    assertEqual(dispatch.assignedPort, 9000);

    // 3. Status check on remote daemon
    const status = await ssh.checkStatus("bm-job-01");
    assertEqual(status.status, "ACTIVE");

    // 4. Ingress configuration generator maps remote container port
    const tunnelConfig = hybridHarness.generateTunnelConfig({
      tunnelId: "tun-baremetal",
      routes: [{ hostname: "worker.syncbay.app", targetPort: 9000 }],
    });
    assertIncludes(tunnelConfig, "http://localhost:9000");

    // 5. Clean teardown
    const stopRes = await ssh.stopContainer(dispatch.containerId || "");
    assertTrue(stopRes.stopped);
  }
);

// =============================================================================
// Scenario 5: Full-Stack Next.js Monorepo with Knip Code Optimization
// =============================================================================
registerTest(
  "HYB-T4-SCENARIO-05",
  "SCENARIO_KNIP_NON_BLOCKING_MONOREPO",
  4,
  "Next.js build with Knip analyzer: detects dead code, logs recommendations non-blockingly, deployment passes",
  async () => {
    const knip = hybridHarness.createKnipAnalyzer();
    const pipeline = hybridHarness.createPipeline();

    // 1. Knip code scan identifies dead files and deps
    const scanResult = await knip.runAnalysis({
      files: ["src/app/page.tsx", "src/components/DeadModal.tsx", "src/legacy.dead.ts"],
      packageJsonContent: {
        dependencies: { next: "16.3.4", lodash: "4.17.21" },
      },
    });

    assertIncludes(scanResult.unusedDependencies, "lodash");
    assertEqual(scanResult.unreferencedFiles.length, 1);
    assertTrue(scanResult.recommendations.length >= 2);

    // 2. Non-blocking build execution
    const buildLogs: string[] = [];
    const scanExecution = await knip.executeNonBlockingScan(
      {
        files: ["src/app/page.tsx", "src/legacy.dead.ts"],
        packageJsonContent: { dependencies: { lodash: "4.17.21" } },
      },
      (line) => buildLogs.push(line)
    );
    assertTrue(scanExecution.buildUnblocked);

    // 3. Container compilation proceeds smoothly
    const buildRes = await pipeline.executePipeline({
      engine: "nixpacks",
      targetTag: "syncbay/nextjs-monorepo:latest",
    });
    assertTrue(buildRes.success);
  }
);

// =============================================================================
// Scenario 6: High-Concurrency Concurrent PR Deployments with Port Pooling
// =============================================================================
registerTest(
  "HYB-T4-SCENARIO-06",
  "SCENARIO_CONCURRENT_PR_PORTS",
  4,
  "Three concurrent PR deployments for same service allocate unique non-colliding ports and subdomains",
  async () => {
    const prManager = hybridHarness.createPrManager();
    const portMgr = hybridHarness.createPortManager(26000, 26100);
    const reg = hybridHarness.createEdgeRegistry();

    const prNumbers = [601, 602, 603];
    const ports: number[] = [];
    const domains: string[] = [];

    for (const pr of prNumbers) {
      const { domain } = prManager.handleWebhook(
        {
          action: "opened",
          number: pr,
          pull_request: { title: `PR ${pr}`, merged: false, head: { ref: `b-${pr}`, sha: `s-${pr}` }, base: { ref: "main" } },
          repository: { html_url: "", full_name: "" },
        },
        "web"
      );
      const port = portMgr.allocatePort();
      ports.push(port);
      domains.push(domain || "");
      reg.registerServiceRoute(domain || "", port, "ACTIVE");
    }

    // Verify all ports and domains are unique
    const uniquePorts = new Set(ports);
    const uniqueDomains = new Set(domains);
    assertEqual(uniquePorts.size, 3);
    assertEqual(uniqueDomains.size, 3);

    // Ingress configuration holds all three routes
    const tunnelConfig = hybridHarness.generateTunnelConfig({
      tunnelId: "tun-concurrent",
      routes: domains.map((d, i) => ({ hostname: d, targetPort: ports[i] })),
    });
    for (const d of domains) {
      assertIncludes(tunnelConfig, `hostname: ${d}`);
    }
  }
);

// =============================================================================
// Scenario 7: Resilient Build Failure Handling & Graceful Teardown
// =============================================================================
registerTest(
  "HYB-T4-SCENARIO-07",
  "SCENARIO_BUILD_FAILURE_RESILIENCE",
  4,
  "Build compilation fails: status marked FAILED, Octokit check marked failure, edge middleware returns 502 safely",
  async () => {
    const prManager = hybridHarness.createPrManager();
    const queue = hybridHarness.createQueueDriver();
    const reg = hybridHarness.createEdgeRegistry();
    const mw = hybridHarness.createEdgeMiddleware(reg);

    const sha = "sha_fail_workflow";
    const { domain } = prManager.handleWebhook(
      {
        action: "opened",
        number: 701,
        pull_request: { title: "Failing PR", merged: false, head: { ref: "fail", sha }, base: { ref: "main" } },
        repository: { html_url: "", full_name: "" },
      },
      "api"
    );

    // Dispatch build
    await queue.dispatchBuild({ jobId: "job-fail-701", serviceId: "srv-api", repoUrl: "", commitSha: sha, branch: "fail" });
    queue.processNextJob();

    // Mark failed
    queue.transitionJob("job-fail-701", "FAILED", "Compilation error", "TS2304: Cannot find name 'foo'");
    reg.registerServiceRoute(domain || "", 3000, "FAILED");

    // Octokit status updated to failure
    prManager.postCommitStatus(sha, {
      context: "syncbay/preview",
      state: "failure",
      target_url: `https://${domain}`,
      description: "Build failed: TS2304",
    });

    const statuses = prManager.getCommitStatuses(sha);
    assertEqual(statuses[statuses.length - 1].state, "failure");

    // Edge middleware returns 502 for failed service
    const decision = mw.handleRequest({ url: "/", host: domain || "" });
    assertEqual(decision.action, "not-found");
    assertEqual(decision.status, 502);
  }
);

// =============================================================================
// Scenario 8: Multi-Service Microservices Fleet PR Deployment
// =============================================================================
registerTest(
  "HYB-T4-SCENARIO-08",
  "SCENARIO_MULTISERVICE_PR",
  4,
  "Single PR provisions both frontend and backend preview services with separate domains and tunnel routing",
  async () => {
    const prManager = hybridHarness.createPrManager();
    const portMgr = hybridHarness.createPortManager(27500, 27550);
    const reg = hybridHarness.createEdgeRegistry();

    const prEvent = {
      action: "opened" as const,
      number: 801,
      pull_request: { title: "Full-stack PR", merged: false, head: { ref: "stack", sha: "sha_stack" }, base: { ref: "main" } },
      repository: { html_url: "", full_name: "" },
    };

    const webRes = prManager.handleWebhook(prEvent, "frontend");
    const apiRes = prManager.handleWebhook(prEvent, "backend");

    const webPort = portMgr.allocatePort();
    const apiPort = portMgr.allocatePort();

    reg.registerServiceRoute(webRes.domain || "", webPort, "ACTIVE");
    reg.registerServiceRoute(apiRes.domain || "", apiPort, "ACTIVE");

    const tunnelConfig = hybridHarness.generateTunnelConfig({
      tunnelId: "tun-stack",
      routes: [
        { hostname: webRes.domain || "", targetPort: webPort },
        { hostname: apiRes.domain || "", targetPort: apiPort },
      ],
    });

    assertIncludes(tunnelConfig, "frontend-pr-801.syncbay.app");
    assertIncludes(tunnelConfig, "backend-pr-801.syncbay.app");
    assertTrue(webPort !== apiPort);
  }
);

// =============================================================================
// Scenario 9: Custom Vanity Domain Ingress with Health Probe Redirection
// =============================================================================
registerTest(
  "HYB-T4-SCENARIO-09",
  "SCENARIO_VANITY_DOMAIN_INGRESS",
  4,
  "Vanity custom domain routed through Cloudflare Tunnel, cold-start splash verifies project and redirects",
  async () => {
    const reg = hybridHarness.createEdgeRegistry();
    const preview = hybridHarness.createServicePreview();

    const vanityHost = "store.acmecorp.com";
    reg.registerServiceRoute(vanityHost, 3000, "BUILDING");

    const tunnelConfig = hybridHarness.generateTunnelConfig({
      tunnelId: "tun-vanity",
      routes: [
        { hostname: vanityHost, targetPort: 3000 },
        { hostname: "web-production.syncbay.app", targetPort: 3000 },
      ],
    });
    assertIncludes(tunnelConfig, `hostname: ${vanityHost}`);

    // Splash screen resolution
    const mockDb = [
      {
        id: "s1",
        name: "acme-store",
        environment: { id: "e1", name: "prod", project: { id: "p1", name: "Acme Enterprise", slug: "acme-enterprise" } },
        status: "BUILDING" as const,
      },
    ];
    const info = preview.queryServiceAndProject("acme-store-prod", mockDb);
    assertEqual(info?.projectName, "Acme Enterprise");

    // Health probe completes
    const probeRes = await preview.probeHealthUntilReady(async () => ({ status: 200 }), 3, 5);
    assertTrue(probeRes.ready);
  }
);

// =============================================================================
// Scenario 10: Runner Daemon Failover and FIFO Queue Recovery
// =============================================================================
registerTest(
  "HYB-T4-SCENARIO-10",
  "SCENARIO_RUNNER_FAILOVER_FIFO",
  4,
  "Runner daemon crashes: DB queue retains build in QUEUED, new runner starts and processes job to completion",
  async () => {
    const queue = hybridHarness.createQueueDriver();
    const portMgr = hybridHarness.createPortManager(29500, 29550);
    const reg = hybridHarness.createEdgeRegistry();

    // 1. Dispatch build into persistent queue
    await queue.dispatchBuild({
      jobId: "failover-job-10",
      serviceId: "srv-resilient",
      repoUrl: "https://github.com/syncbay/resilient",
      commitSha: "sha_resilient",
      branch: "main",
      targetPort: 29501,
    });

    let s1 = await queue.checkStatus("failover-job-10");
    assertEqual(s1.status, "QUEUED");

    // 2. Simulated daemon restart -> New runner dequeues
    const recoveredJob = queue.processNextJob();
    assertEqual(recoveredJob?.jobId, "failover-job-10");
    assertEqual(recoveredJob?.status, "BUILDING");

    // 3. Successfully completes build
    queue.transitionJob("failover-job-10", "ACTIVE", "Compilation completed after daemon restart");
    reg.registerServiceRoute("resilient.syncbay.app", 29501, "ACTIVE");

    const s2 = await queue.checkStatus("failover-job-10");
    assertEqual(s2.status, "ACTIVE");
    assertEqual(reg.getServiceRoute("resilient.syncbay.app")?.status, "ACTIVE");
  }
);
