import { db } from "@/lib/db";
import { logEventBus } from "@/lib/telemetry/event-bus";
import { detectRuntime } from "@/lib/buildpack/detector";
import { generateNixpacksPlan } from "@/lib/buildpack/nixpacks";
import { resolveEnvironmentVariables, type DatabaseRef } from "@/lib/buildpack/resolver";
import { generateDefaultSubdomain, resolveServiceHostnames } from "@/lib/domains/service-hosts";
import { claimDefaultHostname } from "@/lib/domains/claim";
import { runKnipAnalysis } from "@/lib/buildpack/knip-analyzer";
import { registerServiceRouteAsync } from "@/lib/edge/service-registry";
import { applyDatabaseEnv } from "@/lib/database-provider";
import { requestTunnelReload } from "@/lib/tunnel/tunnel-sync";
import { loadServiceVolumes } from "@/lib/orchestrator/volume-payload";
import {
  getRunnerDriver,
  RunnerDriverFactory,
  AuthenticationError,
  type BuildDispatchParams,
  type BuildDispatchResult,
  type BuildStatusResult,
} from "@/lib/orchestrator/runner-driver";
import { onDeploymentActive, onDeploymentFailed, resolveProbeTargets } from "@/lib/orchestrator/lifecycle";
import { deployPollBudgetMs, markJobDispatched, releaseOrchestratorLease, renewOrchestratorLease } from "@/lib/orchestrator/job-queue";
import { redactSecrets } from "@/lib/telemetry/redact";

export interface TriggerOptions {
  serviceId: string;
  commitSha?: string;
  commitMessage?: string;
  userId?: string;
  cleanBuild?: boolean;
  driverType?: "LOCAL" | "CLOUD" | "webhook" | "queue" | "ssh" | "local";
  /** Recovery: resume polling a runner job that is already building this deployment. */
  resume?: { runnerJobId: string; driverType: string };
  /** How long to poll the runner before handing off to the recovery sweep (default `DEPLOY_POLL_BUDGET_MS`). */
  pollBudgetMs?: number;
}

interface LiveRoute {
  port: number;
  isLocal: boolean;
}

/** The instance currently serving a service (its newest ACTIVE deployment other than `exceptDeploymentId`). */
async function findLiveRoute(serviceId: string, exceptDeploymentId: string): Promise<LiveRoute | null> {
  try {
    const live = await db.deployment.findFirst({
      where: { serviceId, status: "ACTIVE", id: { not: exceptDeploymentId }, assignedPort: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { assignedPort: true, runnerDriver: true, cfContainerId: true },
    });
    if (!live?.assignedPort) return null;
    const isLocal = live.runnerDriver === "local" || Boolean(live.cfContainerId?.startsWith("proc_") && !process.env.RUNNER_URL);
    return { port: live.assignedPort, isLocal };
  } catch {
    return null;
  }
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
  const commit = options.commitSha || "branch HEAD";
  const message = options.commitMessage || "Deployment via console";

  const log = (message: string, stream: "stdout" | "stderr" | "system" = "system") => {
    logEventBus.publish(deploymentId, {
      stream,
      message,
      timestamp: new Date().toISOString(),
    });
  };

  const targetHostnames = new Set<string>();
  let liveRoute: LiveRoute | null = null;
  /** Routes for a deploy in progress: the live version keeps its route; otherwise the splash shows `status`. */
  const setInFlightRoutes = async (status: "BUILDING" | "DEPLOYING" | "FAILED") => {
    for (const host of targetHostnames) {
      if (liveRoute) {
        await registerServiceRouteAsync(host, liveRoute.port, "ACTIVE", `http://127.0.0.1:${liveRoute.port}`, liveRoute.isLocal);
      } else {
        await registerServiceRouteAsync(host, undefined, status);
      }
    }
  };

  try {
    log(`[syncbay] Deployment initiated for service ${serviceId}`, "system");
    log(`[syncbay] Target commit: ${commit} — "${message}"`, "system");
    await renewOrchestratorLease(deploymentId);

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
    // The service answers on its own Domain rows. The generated platform host is claimed here
    // (suffixed when another service already owns `<service>-<env>.syncbay.app`), never assumed
    // from the name: two services with the same name must not route each other's address.
    const defaultUrl = service
      ? await claimDefaultHostname(db, { id: service.id, name: serviceName, environment: { name: envName } }).catch(() =>
          generateDefaultSubdomain(serviceName, envName)
        )
      : generateDefaultSubdomain(serviceName, envName);
    for (const host of resolveServiceHostnames({
      name: serviceName,
      environment: service?.environment,
      domains: [{ hostname: defaultUrl, isGenerated: true }, ...(service?.domains || [])],
    })) {
      targetHostnames.add(host);
    }

    // A version that is already live keeps serving while this one builds (and stays live if this
    // one fails). Only a service with nothing running shows the build splash.
    liveRoute = await findLiveRoute(serviceId, deploymentId);

    // Register initial state in Edge Service Registry (routes traffic to preview splash while building)
    await setInFlightRoutes("BUILDING");

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
    // Managed databases: DATABASE_URL / REDIS_URL / <NAME>_URL, never overriding user-set keys
    const dbInjected = applyDatabaseEnv(envMap, service?.environment?.databases || []);
    if (dbInjected.length) log(`[env] Linked managed database variables: ${dbInjected.join(", ")}`, "stdout");

    // Phase 2: Update to DEPLOYING
    await db.deployment.update({
      where: { id: deploymentId },
      data: { status: "DEPLOYING" },
    }).catch(() => null);

    await setInFlightRoutes("DEPLOYING");

    // Phase 2.5: Dispatch to Runner Driver Subsystem
    let driver = getRunnerDriver((options.resume?.driverType as TriggerOptions["driverType"]) ?? options.driverType);
    log(`[runner] Executing deployment via ${driver.type.toUpperCase()} runner driver...`, "system");

    const dispatchOnLog = (line: string) => {
      let stream: "stdout" | "stderr" | "system" = "stdout";
      const trimmed = line.trim();
      if (
        trimmed.includes("[build:error]") ||
        trimmed.includes("[app:error]") ||
        trimmed.includes("[app:stderr]") ||
        trimmed.includes("[error]") ||
        trimmed.startsWith("Error:") ||
        /error:\s+/i.test(trimmed)
      ) {
        stream = "stderr";
      } else if (
        trimmed.startsWith("[pipeline]") ||
        trimmed.startsWith("[runner]") ||
        trimmed.startsWith("[build]") ||
        trimmed.startsWith("[deploy]") ||
        trimmed.startsWith("[proxy]") ||
        trimmed.startsWith("[syncbay]") ||
        trimmed.startsWith("[health]") ||
        trimmed.startsWith("[env]")
      ) {
        stream = "system";
      }
      log(line, stream);
    };

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
      cleanBuild: options.cleanBuild,
      environmentVariables: envMap,
      volumes: await loadServiceVolumes(serviceId),
      subdomain: defaultUrl,
      onLog: dispatchOnLog,
    };

    let dispatchRes: BuildDispatchResult;
    try {
      dispatchRes = options.resume
        ? { jobId: options.resume.runnerJobId, driverType: driver.type, status: "BUILDING" }
        : await driver.dispatchBuild(dispatchParams);
    } catch (dispatchErr: any) {
      // If remote runner dispatch failed (HTTP 530 Cloudflare tunnel error, 502/503/504, connection refused, or timeout),
      // fall back to the local runner driver. Authentication failures are never masked by a fallback, and the
      // fallback can be disabled with RUNNER_FALLBACK_LOCAL=false (or RUNNER_FORCE_REMOTE=true).
      const isAuthError =
        dispatchErr instanceof AuthenticationError || dispatchErr?.code === "AUTHENTICATION_ERROR";
      const fallbackEnabled =
        (process.env.RUNNER_FALLBACK_LOCAL ?? "true").toLowerCase() !== "false" &&
        process.env.RUNNER_FORCE_REMOTE !== "true";
      if (isAuthError) {
        log(`[runner:error] Remote runner rejected authentication (${dispatchErr.message}). Check RUNNER_SECRET on both sides; not falling back to local.`, "stderr");
      }
      if (driver.type !== "local" && fallbackEnabled && !isAuthError) {
        log(`[runner:warn] Remote runner dispatch failed (${dispatchErr.message}). Activating local runner driver fallback...`, "system");
        driver = RunnerDriverFactory.createDriver("local");
        dispatchRes = await driver.dispatchBuild(dispatchParams);
      } else {
        throw dispatchErr;
      }
    }

    await markJobDispatched(deploymentId, driver.type, dispatchRes.jobId);
    const runnerMeta: Record<string, any> = { ...(dispatchRes.metadata || {}) };
    let finalStatus = dispatchRes.status;
    let assignedPort = dispatchRes.assignedPort || service?.port || 3000;
    let containerId = dispatchRes.containerId;
    let lastErrorMessage: string | undefined;
    let lastExitCode: number | undefined;
    const withExitCode = (msg: string) =>
      lastExitCode === undefined || /exit(?:ed with)? code \d+/i.test(msg) ? msg : `${msg} (exit code ${lastExitCode})`;

    if (finalStatus !== "ACTIVE" && finalStatus !== "FAILED" && finalStatus !== "CANCELLED") {
      log(`[runner] Build job ${dispatchRes.jobId} enqueued/running. Awaiting completion...`, "system");
      const pollStart = Date.now();
      const timeoutMs = options.pollBudgetMs ?? deployPollBudgetMs();
      let lastRenew = Date.now();
      let lastLogCount = 0;
      let consecutivePollErrors = 0;
      while (Date.now() - pollStart < timeoutMs) {
        await new Promise((r) => setTimeout(r, 1000));
        if (Date.now() - lastRenew > 15000) {
          lastRenew = Date.now();
          await renewOrchestratorLease(deploymentId);
        }
        let check: BuildStatusResult;
        try {
          check = await driver.checkStatus(dispatchRes.jobId);
          consecutivePollErrors = 0;
        } catch (pollErr: any) {
          consecutivePollErrors += 1;
          log(`[runner:warn] Status polling error (${consecutivePollErrors}/10): ${pollErr.message}. Retrying...`, "system");
          if (consecutivePollErrors >= 10) {
            throw new Error(`Runner status check failed after 10 consecutive attempts: ${pollErr.message}`);
          }
          continue;
        }
        finalStatus = check.status;
        if (check.port) assignedPort = check.port;
        if (check.containerId) containerId = check.containerId;
        if (check.errorMessage) lastErrorMessage = check.errorMessage;
        if (typeof check.exitCode === "number") lastExitCode = check.exitCode;
        if (check.metadata) Object.assign(runnerMeta, check.metadata);

        // Relay remote runner daemon logs to event bus
        if (check.logs && Array.isArray(check.logs) && check.logs.length > lastLogCount) {
          for (let i = lastLogCount; i < check.logs.length; i++) {
            dispatchOnLog(check.logs[i]);
          }
          lastLogCount = check.logs.length;
        }

        if (finalStatus === "ACTIVE" || finalStatus === "FAILED" || finalStatus === "CANCELLED") {
          if (check.errorMessage) {
            logEventBus.recordError(deploymentId, withExitCode(check.errorMessage));
          }
          break;
        }
      }
    }

    if (finalStatus !== "ACTIVE" && finalStatus !== "FAILED" && finalStatus !== "CANCELLED") {
      // Poll budget spent (serverless maxDuration): hand off to recoverStaleDeployments().
      log(`[runner] Build job ${dispatchRes.jobId} still ${finalStatus}; handing off to the recovery sweep`, "system");
      await releaseOrchestratorLease(deploymentId);
      return { status: "PENDING", url: `https://${defaultUrl}`, port: undefined, containerId };
    }

    if (finalStatus !== "ACTIVE") {
      const err = lastErrorMessage || logEventBus.getError(deploymentId) || `Runner build failed with status: ${finalStatus}`;
      throw new Error(withExitCode(err));
    }

    const targetPort = assignedPort || service?.port || 3000;
    log(`[deploy] Application container/process ${containerId || "active"} initialized on port ${targetPort}`, "system");

    // Phase 3: Blue/Green Health Check Verification
    const healthPath = (service as any)?.healthCheckUrl || "/health";
    log(`[health] Running blue/green health probe on port ${targetPort}${healthPath}...`, "stdout");
    const { primaryProbeUrl, rootProbeUrl, probeHeaders } = resolveProbeTargets(driver, runnerMeta, targetPort, healthPath);
    let isHealthy = false;

    // Only the runner can say an instance is simulated (mock executor); a real runner is probed even on Vercel.
    const isSimulated = Boolean(runnerMeta.simulated);

    if (isSimulated) {
      isHealthy = true;
      log(`[health] Runner reported a simulated instance ${containerId || "active"} on port ${targetPort}; skipping HTTP probe`, "stdout");
    } else if (runnerMeta.healthVerifiedByRunner && !process.env.RUNNER_URL) {
      isHealthy = true;
      log(`[health] Health verified by the pull-mode runner (no RUNNER_URL route from the control plane)`, "stdout");
    } else {
      for (let i = 0; i < 25; i++) {
        try {
          const res = await fetch(primaryProbeUrl, { 
            signal: AbortSignal.timeout(1000),
            headers: probeHeaders
          });
          if (res.status >= 200 && res.status < 500) {
            isHealthy = true;
            log(`[health] Health check passed on ${primaryProbeUrl} (HTTP ${res.status})`, "stdout");
            break;
          }
        } catch {
          try {
            const resRoot = await fetch(rootProbeUrl, { 
              signal: AbortSignal.timeout(1000),
              headers: probeHeaders
            });
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
    }

    if (!isHealthy) {
      // The runner started this instance; do not leave it running behind a failed deployment.
      if (containerId) await driver.stopContainer(containerId).catch(() => null);
      throw new Error(
        `Deployment health check failed: application on port ${targetPort} did not respond to HTTP probes on ${healthPath} or /`
      );
    }

    // Shift traffic & promote to ACTIVE in Edge Service Registry
    const isLocalDriver = driver.type === "local";
    for (const host of targetHostnames) {
      await registerServiceRouteAsync(host, targetPort, "ACTIVE", `http://127.0.0.1:${targetPort}`, isLocalDriver);
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
        assignedPort: targetPort,
        completedAt: new Date(),
        errorMessage: null,
      },
    }).catch(() => null);

    // `Service.port` is the port the app listens on inside its container. The host port the runner
    // assigned lives on the deployment (`assignedPort`). When the runner had to detect the app's
    // real port, remember it so the next deploy maps it correctly on the first try.
    const detectedAppPort = Number(runnerMeta.containerPort);
    if (Number.isInteger(detectedAppPort) && detectedAppPort > 0 && detectedAppPort !== service?.port && typeof (db.service as any)?.update === "function") {
      await (db.service as any).update({ where: { id: serviceId }, data: { port: detectedAppPort } }).catch(() => null);
      log(`[deploy] The app listens on port ${detectedAppPort}; saved as the service port`, "system");
    }

    await onDeploymentActive({
      deploymentId,
      serviceId,
      containerId,
      port: targetPort,
      driver,
      hosts: [...targetHostnames],
      isLocal: isLocalDriver,
      simulated: isSimulated,
      log: (line) => log(line, "system"),
    });
    await requestTunnelReload(`deploy:${deploymentId}:active`); // no-op unless a tunnel is configured; never throws

    log(`[syncbay] Deployment ${deploymentId} is ACTIVE and serving traffic 🚀`, "system");

    return { status: "ACTIVE", url: `https://${defaultUrl}`, port: targetPort, containerId };
  } catch (error: any) {
    log(`[error] Deployment failed: ${error.message}`, "stderr");
    logEventBus.recordError(deploymentId, error.message);

    await setInFlightRoutes("FAILED");

    await db.build.update({
      where: { id: buildId },
      data: { status: "FAILED", completedAt: new Date() },
    }).catch(() => null);

    await db.deployment.update({
      where: { id: deploymentId },
      data: { status: "FAILED", completedAt: new Date(), errorMessage: redactSecrets(String(error?.message || error)).slice(0, 4000) },
    }).catch(() => null);

    await onDeploymentFailed({ deploymentId, error: String(error?.message || error) });

    throw error;
  } finally {
    // Persist buffered log lines before a serverless invocation can be frozen.
    await logEventBus.flush();
  }
}
