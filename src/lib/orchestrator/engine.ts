import { db } from "@/lib/db";
import { logEventBus } from "@/lib/telemetry/event-bus";
import { detectRuntime } from "@/lib/buildpack/detector";
import { generateNixpacksPlan } from "@/lib/buildpack/nixpacks";
import { resolveEnvironmentVariables, type DatabaseRef } from "@/lib/buildpack/resolver";
import { generateDefaultSubdomain } from "@/lib/domain-service";
import { runKnipAnalysis } from "@/lib/buildpack/knip-analyzer";
import { registerServiceRoute } from "@/lib/edge/service-registry";
import {
  getRunnerDriver,
  type BuildDispatchParams,
} from "@/lib/orchestrator/runner-driver";

export interface TriggerOptions {
  serviceId: string;
  commitSha?: string;
  commitMessage?: string;
  userId?: string;
  driverType?: "LOCAL" | "CLOUD" | "webhook" | "queue" | "ssh" | "local";
}

/**
 * Executes full PaaS deployment lifecycle (F9, F10, F11)
 * Transitions: QUEUED -> BUILDING -> DEPLOYING -> ACTIVE (or FAILED)
 * Emits real-time logs via logEventBus for SSE streaming
 */
export async function executeDeployment(
  deploymentId: string,
  buildId: string,
  serviceId: string,
  options: TriggerOptions = { serviceId }
) {
  const commit = options.commitSha || Math.random().toString(16).slice(2, 9);
  const message = options.commitMessage || "Deployment via console";

  const log = (message: string, stream: "stdout" | "stderr" | "system" = "system") => {
    logEventBus.publish(deploymentId, {
      stream,
      message,
      timestamp: new Date().toISOString(),
    });
  };

  const targetHostnames = new Set<string>();

  try {
    log(`[syncbay] Deployment initiated for service ${serviceId}`, "system");
    log(`[syncbay] Target commit: ${commit} — "${message}"`, "system");

    // Phase 1: Update to BUILDING
    await db.build.update({
      where: { id: buildId },
      data: { status: "RUNNING", startedAt: new Date() },
    }).catch(() => null);

    await db.deployment.update({
      where: { id: deploymentId },
      data: { status: "BUILDING", startedAt: new Date() },
    }).catch(() => null);

    log(`[build] Status updated to BUILDING`, "system");

    // Fetch service details and variables
    const service = await db.service.findUnique({
      where: { id: serviceId },
      include: {
        variables: true,
        domains: true,
        environment: {
          include: {
            databases: true,
            project: true,
          },
        },
      },
    });

    const envName = service?.environment?.name || "production";
    const serviceName = service?.name || "web";
    const defaultUrl = generateDefaultSubdomain(serviceName, envName);

    // Collect all relevant domain hostnames for this service
    targetHostnames.add(defaultUrl);
    if (defaultUrl.endsWith(".syncbay.app")) {
      const sub = defaultUrl.slice(0, -".syncbay.app".length);
      targetHostnames.add(`${sub}.localhost`);
      targetHostnames.add(sub);
    }
    if (service?.domains) {
      for (const d of service.domains) {
        if (d.hostname) {
          targetHostnames.add(d.hostname);
          if (d.hostname.endsWith(".syncbay.app")) {
            const dSub = d.hostname.slice(0, -".syncbay.app".length);
            targetHostnames.add(`${dSub}.localhost`);
            targetHostnames.add(dSub);
          }
        }
      }
    }
    if (service?.environment?.isPrEnv && service?.environment?.prNumber) {
      const prHost = `${serviceName}-pr-${service.environment.prNumber}.syncbay.app`;
      targetHostnames.add(prHost);
      targetHostnames.add(`${serviceName}-pr-${service.environment.prNumber}.localhost`);
    }

    // Register initial state in Edge Service Registry (routes traffic to preview splash while building)
    for (const host of targetHostnames) {
      registerServiceRoute(host, undefined, "BUILDING");
    }

    // Check if repository needs authenticated git clone credentials
    let resolvedRepoUrl = service?.repoUrl || undefined;
    if (resolvedRepoUrl && /github\.com/i.test(resolvedRepoUrl) && !resolvedRepoUrl.includes("@")) {
      try {
        let githubToken: string | undefined = process.env.GITHUB_TOKEN;
        if (!githubToken && options.userId) {
          const acc = await (db.account as any).findFirst({
            where: { userId: options.userId, provider: "github", access_token: { not: null } },
          });
          githubToken = acc?.access_token;
        }
        if (!githubToken) {
          const anyAcc = await (db.account as any).findFirst({
            where: { provider: "github", access_token: { not: null } },
          });
          githubToken = anyAcc?.access_token;
        }
        if (githubToken) {
          resolvedRepoUrl = resolvedRepoUrl.replace(
            /https?:\/\/github\.com\//i,
            `https://x-access-token:${githubToken}@github.com/`
          );
          if (!resolvedRepoUrl.endsWith(".git")) {
            resolvedRepoUrl += ".git";
          }
        }
      } catch {
        // Keep original repoUrl
      }
    }

    // Ensure default domain record is persisted in DB
    if (service) {
      await (db.domain as any).upsert({
        where: { hostname: defaultUrl },
        update: { status: "ACTIVE" },
        create: {
          serviceId: service.id,
          hostname: defaultUrl,
          isGenerated: true,
          status: "ACTIVE",
        },
      }).catch(() => null);
    }

    // Defer runtime detection and build plan generation to the runner
    // once the repository is actually cloned and analyzed.
    log(`[syncbay] Awaiting runner allocation...`, "system");

    // Resolve environment variables & cross-service references
    const rawVars = service?.variables?.map((v) => ({
      key: v.key,
      value: v.value,
      isSecret: v.isSecret,
    })) || [];

    const dbRefs: DatabaseRef[] = (service?.environment?.databases || []).map((d) => ({
      name: d.name,
      provider: d.provider,
      connectionUrl: d.connectionUrl || `postgres://user:pass@localhost:5432/${d.name}`,
    }));

    const resolved = resolveEnvironmentVariables(rawVars, {
      services: [{ name: serviceName, port: service?.port || 3000 }],
      databases: dbRefs,
      systemVariables: { ENVIRONMENT: envName },
    });
    log(`[env] Injected ${resolved.length} environment variables into runtime container`, "stdout");

    const envMap: Record<string, string> = {};
    for (const v of resolved) {
      envMap[v.key] = v.value;
    }

    // Phase 2: Update to DEPLOYING
    await db.deployment.update({
      where: { id: deploymentId },
      data: { status: "DEPLOYING" },
    }).catch(() => null);

    for (const host of targetHostnames) {
      registerServiceRoute(host, undefined, "DEPLOYING");
    }

    // Phase 2.5: Dispatch to Runner Driver Subsystem
    const driver = getRunnerDriver(options.driverType);
    log(`[runner] Executing deployment via ${driver.type.toUpperCase()} runner driver...`, "system");

    const dispatchParams: BuildDispatchParams = {
      deploymentId,
      buildId,
      serviceId,
      serviceName,
      repoUrl: resolvedRepoUrl,
      branch: service?.branch || undefined,
      commitSha: options.commitSha,
      commitMessage: message,
      rootDir: service?.rootDir || undefined,
      buildCommand: service?.buildCommand || undefined,
      startCommand: service?.startCommand || undefined,
      dockerfile: service?.dockerImage || undefined,
      port: service?.port || 3000,
      targetPort: service?.port || 3000,
      environmentVariables: envMap,
      subdomain: defaultUrl,
      onLog: (line: string) => log(line, "stdout"),
    };

    const dispatchRes = await driver.dispatchBuild(dispatchParams);

    let finalStatus = dispatchRes.status;
    let assignedPort = dispatchRes.assignedPort || service?.port || 3000;
    let containerId = dispatchRes.containerId;

    if (finalStatus !== "ACTIVE" && finalStatus !== "FAILED" && finalStatus !== "CANCELLED") {
      log(`[runner] Build job ${dispatchRes.jobId} enqueued/running. Awaiting completion...`, "system");
      const pollStart = Date.now();
      const timeoutMs = 120000;
      while (Date.now() - pollStart < timeoutMs) {
        await new Promise((r) => setTimeout(r, 1000));
        const check = await driver.checkStatus(dispatchRes.jobId);
        finalStatus = check.status;
        if (check.port) assignedPort = check.port;
        if (check.containerId) containerId = check.containerId;
        if (finalStatus === "ACTIVE" || finalStatus === "FAILED" || finalStatus === "CANCELLED") {
          break;
        }
      }
    }

    if (finalStatus !== "ACTIVE") {
      throw new Error(`Runner build failed with status: ${finalStatus}`);
    }

    const targetPort = assignedPort || service?.port || 3000;
    log(`[deploy] Application container/process ${containerId || "active"} initialized on port ${targetPort}`, "system");

    // Phase 3: Blue/Green Health Check Verification
    const healthPath = (service as any)?.healthCheckUrl || "/health";
    log(`[health] Running blue/green health probe on port ${targetPort}${healthPath}...`, "stdout");
    const primaryProbeUrl = `http://127.0.0.1:${targetPort}${healthPath}`;
    const rootProbeUrl = `http://127.0.0.1:${targetPort}/`;
    let isHealthy = false;

    for (let i = 0; i < 10; i++) {
      try {
        const res = await fetch(primaryProbeUrl, { signal: AbortSignal.timeout(1000) });
        if (res.status >= 200 && res.status < 500) {
          isHealthy = true;
          log(`[health] Health check passed on ${primaryProbeUrl} (HTTP ${res.status})`, "stdout");
          break;
        }
      } catch {
        try {
          const resRoot = await fetch(rootProbeUrl, { signal: AbortSignal.timeout(1000) });
          if (resRoot.status >= 200 && resRoot.status < 500) {
            isHealthy = true;
            log(`[health] Health check passed on root fallback ${rootProbeUrl} (HTTP ${resRoot.status})`, "stdout");
            break;
          }
        } catch {
          // Retry
        }
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    if (!isHealthy) {
      throw new Error(
        `Deployment health check failed: application on port ${targetPort} did not respond to HTTP probes on ${healthPath} or /`
      );
    }

    // Shift traffic & promote to ACTIVE in Edge Service Registry
    for (const host of targetHostnames) {
      registerServiceRoute(host, targetPort, "ACTIVE", `http://127.0.0.1:${targetPort}`);
    }
    log(`[proxy] Edge reverse proxy targets shifted to container instance ${containerId || "active"} on port ${targetPort}`, "system");
    log(`[proxy] Service routing live at: https://${defaultUrl}`, "system");

    await db.build.update({
      where: { id: buildId },
      data: { status: "SUCCEEDED", completedAt: new Date() },
    }).catch(() => null);

    await db.deployment.update({
      where: { id: deploymentId },
      data: {
        status: "ACTIVE",
        cfContainerId: containerId,
        completedAt: new Date(),
      },
    }).catch(() => null);

    log(`[syncbay] Deployment ${deploymentId} is ACTIVE and serving traffic 🚀`, "system");

    return { status: "ACTIVE", url: `https://${defaultUrl}`, port: targetPort, containerId };
  } catch (error: any) {
    log(`[error] Deployment failed: ${error.message}`, "stderr");

    for (const host of targetHostnames) {
      registerServiceRoute(host, undefined, "FAILED");
    }

    await db.build.update({
      where: { id: buildId },
      data: { status: "FAILED", completedAt: new Date() },
    }).catch(() => null);

    await db.deployment.update({
      where: { id: deploymentId },
      data: { status: "FAILED", completedAt: new Date() },
    }).catch(() => null);

    throw error;
  }
}
