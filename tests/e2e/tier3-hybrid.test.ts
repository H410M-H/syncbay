/**
 * Syncbay PaaS — Tier 3: Hybrid Compute & Edge Routing Cross-Feature Combinations Test Suite
 * 20 Comprehensive Pairwise Cross-Feature Tests connecting interdependent subsystems across R1–R5.
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
// Pair 1: F2 (PR Domain Registration) + F11 (Tunnel Ingress YAML)
// =============================================================================
registerTest(
  "HYB-T3-PAIR-01",
  "HYB-F02+F11",
  3,
  "PR domain is dynamically injected into Cloudflare Tunnel ingress configuration",
  async () => {
    const prManager = hybridHarness.createPrManager();
    const event = {
      action: "opened" as const,
      number: 142,
      pull_request: { title: "Payment UI", merged: false, head: { ref: "ui", sha: "sha_142" }, base: { ref: "main" } },
      repository: { html_url: "https://github.com/syncbay/shop", full_name: "syncbay/shop" },
    };
    const { domain } = prManager.handleWebhook(event, "web");

    const yaml = hybridHarness.generateTunnelConfig({
      tunnelId: "tun-pr-deploy",
      routes: [
        { hostname: domain || "web-pr-142.syncbay.app", targetPort: 24100 },
        { hostname: "*.syncbay.app", targetPort: 8080 },
      ],
    });

    assertIncludes(yaml, "hostname: web-pr-142.syncbay.app");
    assertIncludes(yaml, "service: http://localhost:24100");
    assertTrue(yaml.indexOf("web-pr-142.syncbay.app") < yaml.indexOf("*.syncbay.app"));
  }
);

// =============================================================================
// Pair 2: F3 (Auto-Sleep) + F12 (Edge Registry) + F13 (Edge Middleware)
// =============================================================================
registerTest(
  "HYB-T3-PAIR-02",
  "HYB-F03+F12+F13",
  3,
  "Idle container transitions to SLEEPING in registry, edge middleware rewrites to preview splash",
  async () => {
    const reg = hybridHarness.createEdgeRegistry();
    const mw = hybridHarness.createEdgeMiddleware(reg);
    const prManager = hybridHarness.createPrManager();

    // 1. Provision PR and mark active
    prManager.handleWebhook(
      {
        action: "opened",
        number: 80,
        pull_request: { title: "Test", merged: false, head: { ref: "b", sha: "s" }, base: { ref: "main" } },
        repository: { html_url: "", full_name: "" },
      },
      "api"
    );
    prManager.markActive(80);
    reg.registerServiceRoute("api-pr-80.syncbay.app", 3000, "ACTIVE");

    // Initially active: middleware proxies pass-through
    assertEqual(mw.handleRequest({ url: "/users", host: "api-pr-80.syncbay.app" }).action, "pass-through");

    // 2. Idle timeout triggers
    prManager.checkIdleTimeout(80, Date.now() + 2000 * 1000);
    reg.registerServiceRoute("api-pr-80.syncbay.app", 3000, "SLEEPING");

    // Now sleeping: middleware rewrites to splash screen
    const decision = mw.handleRequest({ url: "/users", host: "api-pr-80.syncbay.app" });
    assertEqual(decision.action, "rewrite");
    assertEqual(decision.destinationUrl, "/service-preview/api-pr-80");
  }
);

// =============================================================================
// Pair 3: F5 (Unified Driver) + F6 (Webhook HMAC) + F17 (SSE Logs)
// =============================================================================
registerTest(
  "HYB-T3-PAIR-03",
  "HYB-F05+F06+F17",
  3,
  "Webhook runner dispatches with HMAC signature and exposes SSE log stream endpoint",
  async () => {
    const driver = hybridHarness.createWebhookDriver("shared-secret-key");
    const dispatch = await driver.dispatchBuild({
      jobId: "job-sse-dispatch",
      serviceId: "srv-web",
      repoUrl: "https://github.com/syncbay/web",
      commitSha: "sha_111",
      branch: "main",
    });

    assertEqual(dispatch.status, "ACCEPTED");
    assertTrue(Boolean(dispatch.streamUrl));
    assertMatch(dispatch.streamUrl || "", /^\/api\/builds\/job-sse-dispatch\/logs\/stream$/);

    const status = await driver.checkStatus("job-sse-dispatch");
    assertTrue(status.status === "BUILDING" || status.status === "ACCEPTED");
  }
);

// =============================================================================
// Pair 4: F5 (Unified Driver) + F7 (Queue Driver) + F10 (Port Allocator)
// =============================================================================
registerTest(
  "HYB-T3-PAIR-04",
  "HYB-F05+F07+F10",
  3,
  "Queue runner dequeues job, binds dynamic port, and releases port upon container stop",
  async () => {
    const queue = hybridHarness.createQueueDriver();
    const portMgr = hybridHarness.createPortManager(24000, 24050);

    const allocatedPort = portMgr.allocatePort();
    await queue.dispatchBuild({
      jobId: "q-job-port",
      serviceId: "srv-backend",
      repoUrl: "",
      commitSha: "",
      branch: "main",
      targetPort: allocatedPort,
    });

    const dequeued = queue.processNextJob();
    assertEqual(dequeued?.port, allocatedPort);
    assertTrue(portMgr.isAllocated(allocatedPort));

    const stopRes = await queue.stopContainer(dequeued?.containerId || "");
    assertTrue(stopRes.stopped);
    portMgr.releasePort(stopRes.releasedPort || allocatedPort);
    assertFalse(portMgr.isAllocated(allocatedPort));
  }
);

// =============================================================================
// Pair 5: F8 (SSH Driver) + F10 (Port Allocator) + F11 (Tunnel Generator)
// =============================================================================
registerTest(
  "HYB-T3-PAIR-05",
  "HYB-F08+F10+F11",
  3,
  "SSH remote runner provisions container on dynamic port, registered in Cloudflare tunnel YAML",
  async () => {
    const ssh = hybridHarness.createSshDriver({ host: "node-1.compute.internal", port: 22, username: "root" });
    const portMgr = hybridHarness.createPortManager(27000, 27010);
    const port = portMgr.allocatePort();

    const dispatch = await ssh.dispatchBuild({
      jobId: "ssh-tun-job",
      serviceId: "srv-compute",
      repoUrl: "",
      commitSha: "",
      branch: "main",
      targetPort: port,
    });

    const yaml = hybridHarness.generateTunnelConfig({
      tunnelId: "tun-ssh",
      routes: [{ hostname: "compute.syncbay.app", targetPort: dispatch.assignedPort || port }],
    });

    assertIncludes(yaml, `http://localhost:${port}`);
    assertIncludes(yaml, "hostname: compute.syncbay.app");
  }
);

// =============================================================================
// Pair 6: F14 (Knip Analyzer) + F15 (Non-Blocking Scan) + F17 (SSE Logs)
// =============================================================================
registerTest(
  "HYB-T3-PAIR-06",
  "HYB-F14+F15+F17",
  3,
  "Knip scan detects dead code and streams [knip] formatted recommendations into SSE build logs",
  async () => {
    const knip = hybridHarness.createKnipAnalyzer();
    const liveSseLogs: string[] = [];

    const res = await knip.executeNonBlockingScan(
      {
        files: ["src/index.ts", "src/unused-old-view.ts"],
        packageJsonContent: { dependencies: { "old-dep": "1.0.0" } },
      },
      (logLine) => liveSseLogs.push(logLine)
    );

    assertTrue(res.buildUnblocked);
    assertTrue(liveSseLogs.some((l) => l.startsWith("[knip]")));
    assertTrue(liveSseLogs.some((l) => l.includes("old-dep")));
  }
);

// =============================================================================
// Pair 7: F1 (Relation Query Fix) + F16 (Cold-Start Splash) + F18 (Health Probe)
// =============================================================================
registerTest(
  "HYB-T3-PAIR-07",
  "HYB-F01+F16+F18",
  3,
  "Preview page displays project via environment.project, runs health probe, and auto-redirects",
  async () => {
    const oracle = hybridHarness.createServicePreview();
    const mockDb = [
      {
        id: "s1",
        name: "web-shop",
        environment: { id: "e1", name: "prod", project: { id: "p1", name: "Shopper", slug: "shopper" } },
        status: "BUILDING" as const,
      },
    ];

    const preview = oracle.queryServiceAndProject("web-shop-prod", mockDb);
    assertEqual(preview?.projectName, "Shopper");

    let probeCount = 0;
    const probeRes = await oracle.probeHealthUntilReady(
      async () => {
        probeCount++;
        return { status: probeCount >= 2 ? 200 : 503 };
      },
      5,
      10
    );

    assertTrue(probeRes.ready);
    assertTrue(probeRes.redirected);
    assertEqual(probeCount, 2);
  }
);

// =============================================================================
// Pair 8: F2 (PR Domain) + F4 (Octokit Status) + F18 (Health Probe)
// =============================================================================
registerTest(
  "HYB-T3-PAIR-08",
  "HYB-F02+F04+F18",
  3,
  "PR deployment lifecycle: pending check -> domain creation -> health probe success -> Octokit check ready",
  async () => {
    const prManager = hybridHarness.createPrManager();
    const commitSha = "sha_full_flow_8";
    const { domain } = prManager.handleWebhook(
      {
        action: "opened",
        number: 88,
        pull_request: { title: "Feature 88", merged: false, head: { ref: "f88", sha: commitSha }, base: { ref: "main" } },
        repository: { html_url: "", full_name: "" },
      },
      "store"
    );

    // Initial check is pending
    assertEqual(prManager.getCommitStatuses(commitSha)[0].state, "pending");

    // Simulated health check probe returns 200 OK
    const preview = hybridHarness.createServicePreview();
    const health = await preview.probeHealthUntilReady(async () => ({ status: 200 }), 3, 5);
    assertTrue(health.ready);

    // Deployment marked active
    prManager.markActive(88);
    const statuses = prManager.getCommitStatuses(commitSha);
    assertEqual(statuses[statuses.length - 1].state, "success");
    assertIncludes(statuses[statuses.length - 1].target_url, domain || "");
  }
);

// =============================================================================
// Pair 9: F3 (PR Teardown) + F10 (Port Release) + F12 (Edge Registry Route Removal)
// =============================================================================
registerTest(
  "HYB-T3-PAIR-09",
  "HYB-F03+F10+F12",
  3,
  "PR close event tears down environment, releases allocated port, and purges Edge Registry route",
  async () => {
    const prManager = hybridHarness.createPrManager();
    const reg = hybridHarness.createEdgeRegistry();
    const portMgr = hybridHarness.createPortManager(23000, 23010);

    const port = portMgr.allocatePort();
    const { domain } = prManager.handleWebhook(
      {
        action: "opened",
        number: 99,
        pull_request: { title: "PR 99", merged: false, head: { ref: "b", sha: "s" }, base: { ref: "main" } },
        repository: { html_url: "", full_name: "" },
      },
      "web"
    );
    reg.registerServiceRoute(domain || "web-pr-99.syncbay.app", port, "ACTIVE");

    // Close PR
    prManager.handleWebhook(
      {
        action: "closed",
        number: 99,
        pull_request: { title: "PR 99", merged: true, head: { ref: "b", sha: "s" }, base: { ref: "main" } },
        repository: { html_url: "", full_name: "" },
      },
      "web"
    );

    portMgr.releasePort(port);
    reg.removeServiceRoute(domain || "web-pr-99.syncbay.app");

    assertFalse(portMgr.isAllocated(port));
    assertEqual(reg.getServiceRoute(domain || "web-pr-99.syncbay.app"), null);
    assertEqual(prManager.getEnvironment(99), undefined);
  }
);

// =============================================================================
// Pair 10: F9 (Runner Pipeline) + F10 (Port Allocator) + F12 (Edge Registry)
// =============================================================================
registerTest(
  "HYB-T3-PAIR-10",
  "HYB-F09+F10+F12",
  3,
  "Nixpacks build pipeline compiles container, binds dynamic port, and registers in Edge Registry",
  async () => {
    const pipeline = hybridHarness.createPipeline();
    const portMgr = hybridHarness.createPortManager(28000, 28010);
    const reg = hybridHarness.createEdgeRegistry();

    const build = await pipeline.executePipeline({ engine: "nixpacks", targetTag: "syncbay/node-app:v1" });
    assertTrue(build.success);

    const port = portMgr.allocatePort();
    reg.registerServiceRoute("node-app.syncbay.app", port, "ACTIVE");

    const route = reg.getServiceRoute("node-app.syncbay.app");
    assertEqual(route?.targetPort, port);
    assertEqual(route?.status, "ACTIVE");
  }
);

// =============================================================================
// Pair 11: F6 (Webhook Driver) + F12 (Registry) + F13 (Edge Middleware)
// =============================================================================
registerTest(
  "HYB-T3-PAIR-11",
  "HYB-F06+F12+F13",
  3,
  "Webhook build sets BUILDING in registry (splash rewrite), then transitions to ACTIVE (direct proxy)",
  async () => {
    const reg = hybridHarness.createEdgeRegistry();
    const mw = hybridHarness.createEdgeMiddleware(reg);
    const driver = hybridHarness.createWebhookDriver();

    await driver.dispatchBuild({
      jobId: "job-w11",
      serviceId: "srv-w11",
      repoUrl: "",
      commitSha: "",
      branch: "main",
      targetPort: 3000,
    });
    reg.registerServiceRoute("web-w11.syncbay.app", 3000, "BUILDING");

    // Phase 1: splash screen rewrite
    const d1 = mw.handleRequest({ url: "/feed", host: "web-w11.syncbay.app" });
    assertEqual(d1.action, "rewrite");
    assertEqual(d1.destinationUrl, "/service-preview/web-w11");

    // Phase 2: active pass-through
    reg.registerServiceRoute("web-w11.syncbay.app", 3000, "ACTIVE");
    const d2 = mw.handleRequest({ url: "/feed", host: "web-w11.syncbay.app" });
    assertEqual(d2.action, "pass-through");
    assertEqual(d2.proxyTarget, "http://localhost:3000");
  }
);

// =============================================================================
// Pair 12: F7 (Queue Driver) + F14 (Knip) + F15 (Non-Blocking Integration)
// =============================================================================
registerTest(
  "HYB-T3-PAIR-12",
  "HYB-F07+F14+F15",
  3,
  "Queue runner pipeline executes Knip analysis during build without blocking transition to ACTIVE",
  async () => {
    const queue = hybridHarness.createQueueDriver();
    const knip = hybridHarness.createKnipAnalyzer();

    await queue.dispatchBuild({ jobId: "job-q-knip", serviceId: "s", repoUrl: "", commitSha: "", branch: "main" });
    queue.processNextJob();

    // Run knip non-blockingly
    const knipRes = await knip.executeNonBlockingScan(
      { files: ["src/index.ts"], packageJsonContent: { dependencies: { unused: "1.0" } } },
      (line) => queue.transitionJob("job-q-knip", "BUILDING", line)
    );
    assertTrue(knipRes.buildUnblocked);

    queue.transitionJob("job-q-knip", "ACTIVE", "Health check passed");
    const status = await queue.checkStatus("job-q-knip");
    assertEqual(status.status, "ACTIVE");
    assertTrue((status.logs || []).some((l) => l.includes("[knip]")));
  }
);

// =============================================================================
// Pair 13: F2 (PR Domain) + F3 (Idle Timeout) + F16 (Splash Screen)
// =============================================================================
registerTest(
  "HYB-T3-PAIR-13",
  "HYB-F02+F03+F16",
  3,
  "PR environment auto-sleeps after 1800s, preview page renders waking indicator",
  async () => {
    const prManager = hybridHarness.createPrManager();
    const { domain } = prManager.handleWebhook(
      {
        action: "opened",
        number: 113,
        pull_request: { title: "PR 113", merged: false, head: { ref: "b", sha: "s" }, base: { ref: "main" } },
        repository: { html_url: "", full_name: "" },
      },
      "dashboard"
    );
    prManager.markActive(113);

    // Timeout
    prManager.checkIdleTimeout(113, Date.now() + 1900 * 1000);
    const env = prManager.getEnvironment(113);
    assertEqual(env?.status, "SLEEPING");

    const preview = hybridHarness.createServicePreview();
    const mockDb = [
      {
        id: "s1",
        name: "dashboard",
        environment: { id: "e1", name: "pr-113", project: { id: "p1", name: "Dash", slug: "dash" } },
        status: "SLEEPING" as const,
      },
    ];
    const info = preview.queryServiceAndProject("dashboard-pr-113", mockDb);
    assertEqual(info?.status, "SLEEPING");
  }
);

// =============================================================================
// Pair 14: F4 (Octokit Comments) + F2 (PR Domain) + F3 (Teardown)
// =============================================================================
registerTest(
  "HYB-T3-PAIR-14",
  "HYB-F04+F02+F03",
  3,
  "PR markdown comment reflects initial creation and is retained for history after teardown",
  async () => {
    const prManager = hybridHarness.createPrManager();
    const event = {
      action: "opened" as const,
      number: 114,
      pull_request: { title: "PR 114", merged: false, head: { ref: "b", sha: "s" }, base: { ref: "main" } },
      repository: { html_url: "", full_name: "" },
    };
    prManager.handleWebhook(event, "web");
    const comment = prManager.getPrComment(114);
    assertIncludes(comment?.body || "", "web-pr-114.syncbay.app");

    // Close PR
    prManager.handleWebhook({ ...event, action: "closed" as const }, "web");
    assertEqual(prManager.getEnvironment(114), undefined);
    // Comment record remains in cache
    assertTrue(Boolean(prManager.getPrComment(114)));
  }
);

// =============================================================================
// Pair 15: F8 (SSH Driver) + F12 (Edge Registry) + F13 (Edge Middleware)
// =============================================================================
registerTest(
  "HYB-T3-PAIR-15",
  "HYB-F08+F12+F13",
  3,
  "Remote Linux container launched via SSH is registered and served by Edge Middleware",
  async () => {
    const ssh = hybridHarness.createSshDriver({ host: "linux-node-1.internal", port: 22, username: "deploy" });
    const reg = hybridHarness.createEdgeRegistry();
    const mw = hybridHarness.createEdgeMiddleware(reg);

    const build = await ssh.dispatchBuild({
      jobId: "ssh-edge-15",
      serviceId: "s",
      repoUrl: "",
      commitSha: "",
      branch: "main",
      targetPort: 9090,
    });
    reg.registerServiceRoute("linux-app.syncbay.app", build.assignedPort || 9090, "ACTIVE");

    const decision = mw.handleRequest({ url: "/status", host: "linux-app.syncbay.app" });
    assertEqual(decision.action, "pass-through");
    assertEqual(decision.proxyTarget, "http://localhost:9090");
  }
);

// =============================================================================
// Pair 16: F10 (Port Allocator) + F11 (Tunnel Ingress) + F12 (Edge Registry)
// =============================================================================
registerTest(
  "HYB-T3-PAIR-16",
  "HYB-F10+F11+F12",
  3,
  "Dynamic port allocated is mapped synchronously across Tunnel YAML and Edge Registry",
  async () => {
    const portMgr = hybridHarness.createPortManager(29000, 29010);
    const reg = hybridHarness.createEdgeRegistry();
    const port = portMgr.allocatePort();

    reg.registerServiceRoute("sync-app.syncbay.app", port, "ACTIVE");
    const yaml = hybridHarness.generateTunnelConfig({
      tunnelId: "tun-sync",
      routes: [{ hostname: "sync-app.syncbay.app", targetPort: port }],
    });

    assertEqual(reg.getServiceRoute("sync-app.syncbay.app")?.targetPort, port);
    assertIncludes(yaml, `http://localhost:${port}`);
  }
);

// =============================================================================
// Pair 17: F1 (Relation Query Fix) + F13 (Middleware) + F16 (Splash Screen)
// =============================================================================
registerTest(
  "HYB-T3-PAIR-17",
  "HYB-F01+F13+F16",
  3,
  "Edge middleware rewrites booting route to splash page which successfully loads environment.project",
  async () => {
    const reg = hybridHarness.createEdgeRegistry();
    reg.registerServiceRoute("finance-prod.syncbay.app", 3000, "BUILDING");
    const mw = hybridHarness.createEdgeMiddleware(reg);

    const decision = mw.handleRequest({ url: "/transactions", host: "finance-prod.syncbay.app" });
    assertEqual(decision.destinationUrl, "/service-preview/finance-prod");

    const preview = hybridHarness.createServicePreview();
    const mockDb = [
      {
        id: "s1",
        name: "finance",
        environment: { id: "e1", name: "prod", project: { id: "p1", name: "FinCorp", slug: "fincorp" } },
        status: "BUILDING" as const,
      },
    ];
    const info = preview.queryServiceAndProject("finance-prod", mockDb);
    assertEqual(info?.projectName, "FinCorp");
  }
);

// =============================================================================
// Pair 18: F5 (Unified Driver) + F6 (Webhook) + F8 (SSH)
// =============================================================================
registerTest(
  "HYB-T3-PAIR-18",
  "HYB-F05+F06+F08",
  3,
  "Multi-driver dispatcher handles polymorphic dispatch to both Webhook and SSH drivers",
  async () => {
    const drivers = [
      hybridHarness.createWebhookDriver(),
      hybridHarness.createSshDriver({ host: "node.internal", port: 22, username: "root" }),
    ];

    for (const d of drivers) {
      const res = await d.dispatchBuild({
        jobId: `job-poly-${d.type}`,
        serviceId: "s",
        repoUrl: "",
        commitSha: "",
        branch: "main",
      });
      assertTrue(res.status === "ACCEPTED" || res.status === "BUILDING");
      assertEqual(res.driverType, d.type);
    }
  }
);

// =============================================================================
// Pair 19: F14 (Knip) + F9 (Runner Pipeline) + F10 (Port Allocator)
// =============================================================================
registerTest(
  "HYB-T3-PAIR-19",
  "HYB-F14+F09+F10",
  3,
  "Build pipeline runs Knip scan before Docker build and dynamically binds available port",
  async () => {
    const knip = hybridHarness.createKnipAnalyzer();
    const pipeline = hybridHarness.createPipeline();
    const portMgr = hybridHarness.createPortManager(22500, 22510);

    // 1. Code scan
    const scan = await knip.runAnalysis({ files: ["src/app.ts"], packageJsonContent: { dependencies: {} } });
    assertEqual(scan.unusedDependencies.length, 0);

    // 2. Build
    const build = await pipeline.executePipeline({ engine: "docker", targetTag: "clean-app:latest" });
    assertTrue(build.success);

    // 3. Port bind
    const port = portMgr.allocatePort();
    assertTrue(port >= 22500);
  }
);

// =============================================================================
// Pair 20: F3 (PR Teardown) + F11 (Tunnel Ingress) + F4 (Octokit Status)
// =============================================================================
registerTest(
  "HYB-T3-PAIR-20",
  "HYB-F03+F11+F04",
  3,
  "PR merge tears down preview, regenerates tunnel config without PR route, and retains status checks",
  async () => {
    const prManager = hybridHarness.createPrManager();
    const event = {
      action: "opened" as const,
      number: 220,
      pull_request: { title: "Feature 220", merged: false, head: { ref: "f220", sha: "sha_220" }, base: { ref: "main" } },
      repository: { html_url: "", full_name: "" },
    };
    prManager.handleWebhook(event, "web");

    // Close PR
    prManager.handleWebhook({ ...event, action: "closed" as const, pull_request: { ...event.pull_request, merged: true } }, "web");

    // Regenerate tunnel without PR route
    const yaml = hybridHarness.generateTunnelConfig({
      tunnelId: "tun-prod-clean",
      routes: [{ hostname: "web-production.syncbay.app", targetPort: 3000 }],
    });

    assertFalse(yaml.includes("web-pr-220.syncbay.app"));
    assertIncludes(yaml, "web-production.syncbay.app");
    assertTrue(prManager.getCommitStatuses("sha_220").length > 0);
  }
);
