/**
 * Syncbay PaaS — Deployment State Machine & Dual-Driver Reference Oracle (F9, F10, F11)
 * Strictly verifies the deployment lifecycle state transitions, dual-driver execution,
 * health checks, and blue/green auto-rollback contracts from PROJECT.md.
 */

export type DeploymentStatus =
  | "QUEUED"
  | "BUILDING"
  | "DEPLOYING"
  | "ACTIVE"
  | "CRASHED"
  | "SLEEPING"
  | "FAILED"
  | "CANCELLED";

export interface DeploymentRecord {
  id: string;
  serviceId: string;
  status: DeploymentStatus;
  driverType: "LOCAL" | "CLOUD";
  healthCheckUrl?: string;
  previousActiveDeploymentId?: string;
  rollbackOccurred: boolean;
  history: { status: DeploymentStatus; timestamp: number }[];
  errorMessage?: string;
}

export const VALID_TRANSITIONS: Record<DeploymentStatus, DeploymentStatus[]> = {
  QUEUED: ["BUILDING", "CANCELLED", "FAILED"],
  BUILDING: ["DEPLOYING", "FAILED", "CANCELLED"],
  DEPLOYING: ["ACTIVE", "FAILED", "CRASHED", "CANCELLED"],
  ACTIVE: ["SLEEPING", "CRASHED", "FAILED", "CANCELLED"],
  SLEEPING: ["QUEUED", "BUILDING"],
  CRASHED: ["QUEUED", "BUILDING"],
  FAILED: [], // Terminal for this deployment
  CANCELLED: [], // Terminal for this deployment
};

export class DeploymentStateMachine {
  private deployments = new Map<string, DeploymentRecord>();
  private activeServiceReleases = new Map<string, string>(); // serviceId -> deploymentId

  createDeployment(params: {
    id: string;
    serviceId: string;
    driverType?: "LOCAL" | "CLOUD";
    healthCheckUrl?: string;
  }): DeploymentRecord {
    const prevActive = this.activeServiceReleases.get(params.serviceId);
    const record: DeploymentRecord = {
      id: params.id,
      serviceId: params.serviceId,
      status: "QUEUED",
      driverType: params.driverType || "LOCAL",
      healthCheckUrl: params.healthCheckUrl,
      previousActiveDeploymentId: prevActive,
      rollbackOccurred: false,
      history: [{ status: "QUEUED", timestamp: Date.now() }],
    };
    this.deployments.set(params.id, record);
    return record;
  }

  getDeployment(id: string): DeploymentRecord | undefined {
    return this.deployments.get(id);
  }

  getActiveDeployment(serviceId: string): string | undefined {
    return this.activeServiceReleases.get(serviceId);
  }

  transition(id: string, targetStatus: DeploymentStatus, errorMessage?: string): DeploymentRecord {
    const deployment = this.deployments.get(id);
    if (!deployment) {
      throw new Error(`Deployment ${id} not found`);
    }

    const allowed = VALID_TRANSITIONS[deployment.status];
    if (!allowed.includes(targetStatus)) {
      throw new Error(
        `Invalid deployment state transition: cannot transition from ${deployment.status} to ${targetStatus}`
      );
    }

    deployment.status = targetStatus;
    deployment.history.push({ status: targetStatus, timestamp: Date.now() });
    if (errorMessage) {
      deployment.errorMessage = errorMessage;
    }

    if (targetStatus === "ACTIVE") {
      this.activeServiceReleases.set(deployment.serviceId, deployment.id);
    }

    return deployment;
  }

  async checkHealth(
    deploymentId: string,
    mockProbe?: () => Promise<{ healthy: boolean; statusCode: number }>
  ): Promise<{ healthy: boolean; statusCode: number }> {
    const deployment = this.deployments.get(deploymentId);
    if (!deployment) throw new Error(`Deployment ${deploymentId} not found`);

    if (mockProbe) {
      return await mockProbe();
    }

    // Default simulated health check
    if (!deployment.healthCheckUrl || deployment.healthCheckUrl.includes("fail")) {
      return { healthy: false, statusCode: 500 };
    }
    return { healthy: true, statusCode: 200 };
  }

  async promoteDeployment(deploymentId: string): Promise<void> {
    const deployment = this.deployments.get(deploymentId);
    if (!deployment) throw new Error(`Deployment ${deploymentId} not found`);
    if (deployment.status !== "DEPLOYING") {
      throw new Error(`Cannot promote deployment in status ${deployment.status}`);
    }
    this.transition(deploymentId, "ACTIVE");
  }

  async rollbackDeployment(failedDeploymentId: string): Promise<{ rolledBackTo: string | null }> {
    const failedDep = this.deployments.get(failedDeploymentId);
    if (!failedDep) throw new Error(`Deployment ${failedDeploymentId} not found`);

    if (failedDep.status !== "FAILED") {
      this.transition(failedDeploymentId, "FAILED", "Health check failed, rolling back");
    }
    failedDep.rollbackOccurred = true;

    const previousId = failedDep.previousActiveDeploymentId;
    if (previousId && this.deployments.has(previousId)) {
      const prevDep = this.deployments.get(previousId)!;
      prevDep.status = "ACTIVE";
      this.activeServiceReleases.set(failedDep.serviceId, previousId);
      return { rolledBackTo: previousId };
    }

    return { rolledBackTo: null };
  }

  async executeDeploymentLifecycle(
    deploymentId: string,
    options?: {
      healthCheckResponse?: { healthy: boolean; statusCode: number };
      onLog?: (line: string) => void;
    }
  ): Promise<{ success: boolean; finalStatus: DeploymentStatus; rolledBack: boolean }> {
    const dep = this.getDeployment(deploymentId);
    if (!dep) throw new Error(`Deployment ${deploymentId} not found`);

    // 1. QUEUED -> BUILDING
    this.transition(deploymentId, "BUILDING");
    options?.onLog?.(`[Build] Starting ${dep.driverType} build runner for ${deploymentId}`);

    // 2. BUILDING -> DEPLOYING
    this.transition(deploymentId, "DEPLOYING");
    options?.onLog?.(`[Deploy] Activating container instances on syncbay cluster`);

    // 3. Health Check Gate
    const health = await this.checkHealth(
      deploymentId,
      options?.healthCheckResponse ? async () => options.healthCheckResponse! : undefined
    );

    if (!health.healthy) {
      options?.onLog?.(`[HealthCheck] Health check failed with status ${health.statusCode}`);
      await this.rollbackDeployment(deploymentId);
      return { success: false, finalStatus: "FAILED", rolledBack: true };
    }

    // 4. DEPLOYING -> ACTIVE
    await this.promoteDeployment(deploymentId);
    options?.onLog?.(`[Route] Traffic successfully routed to ${deploymentId}`);
    return { success: true, finalStatus: "ACTIVE", rolledBack: false };
  }
}
