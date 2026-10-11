/**
 * End-to-End Verification Test:
 * Redeploy (Fast vs Clean Rebuild), Build Logging & Error Surfacing across tRPC Routers
 */

import { executeDeployment } from "../src/lib/orchestrator/engine";
import { logEventBus } from "../src/lib/telemetry/event-bus";
import { appRouter } from "../src/server/root";
import * as fs from "node:fs/promises";
import * as path from "node:path";

async function runVerification() {
  console.log("=== Testing Redeploy, Rebuild, Build Logs & Error Surfacing ===");

  const testUserId = "user_redeploy_test";
  const testWorkspaceId = "ws_redeploy_test";
  const testProjectId = "proj_redeploy_test";
  const testEnvId = "env_redeploy_test";
  const testServiceId = "srv_redeploy_test";

  const store = {
    users: new Map<string, any>(),
    workspaces: new Map<string, any>(),
    workspaceMembers: new Map<string, any>(),
    projects: new Map<string, any>(),
    environments: new Map<string, any>(),
    services: new Map<string, any>(),
    builds: new Map<string, any>(),
    deployments: new Map<string, any>(),
    domains: new Map<string, any>(),
  };

  // Mock DB
  const mockDb: any = {
    user: {
      findUnique: async ({ where }: any) => store.users.get(where.id) || null,
      findFirst: async ({ where }: any) => Array.from(store.users.values())[0] || null,
    },
    workspaceMember: {
      findUnique: async () => ({ role: "OWNER", userId: testUserId, workspaceId: testWorkspaceId }),
      findFirst: async () => ({ role: "OWNER", userId: testUserId, workspaceId: testWorkspaceId }),
    },
    project: {
      findFirst: async () => {
        const p = store.projects.get(testProjectId);
        if (!p) return null;
        return {
          ...p,
          workspace: { members: [{ userId: testUserId, role: "OWNER" }] },
          buckets: [],
          environments: Array.from(store.environments.values()).map((e) => ({
            ...e,
            databases: [],
            services: Array.from(store.services.values()).map((s) => ({
              ...s,
              domains: [],
              variables: [],
              volumes: [],
              deployments: Array.from(store.deployments.values())
                .filter((d) => d.serviceId === s.id)
                .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
            })),
          })),
        };
      },
      findMany: async () => Array.from(store.projects.values()),
    },
    environment: {
      findUnique: async ({ where }: any) => store.environments.get(where.id) || null,
    },
    service: {
      findFirst: async ({ where }: any) => {
        const s = store.services.get(where.id || testServiceId);
        if (!s) return null;
        return {
          ...s,
          environment: {
            ...store.environments.get(s.environmentId),
            project: store.projects.get(testProjectId),
          },
          domains: [],
          variables: [],
          volumes: [],
          deployments: Array.from(store.deployments.values())
            .filter((d) => d.serviceId === s.id)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
          builds: Array.from(store.builds.values())
            .filter((b) => b.serviceId === s.id)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
        };
      },
      findUnique: async ({ where }: any) => store.services.get(where.id) || null,
      findMany: async () => {
        return Array.from(store.services.values()).map((s) => ({
          ...s,
          domains: [],
          variables: [],
          volumes: [],
          environment: {
            ...store.environments.get(s.environmentId),
            project: store.projects.get(testProjectId),
          },
          deployments: Array.from(store.deployments.values())
            .filter((d) => d.serviceId === s.id)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, 1),
          _count: { builds: store.builds.size },
        }));
      },
    },
    build: {
      create: async ({ data }: any) => {
        const id = data.id || `bld_${Math.random().toString(36).slice(2, 9)}`;
        const build = { ...data, id, createdAt: new Date() };
        store.builds.set(id, build);
        return build;
      },
      update: async ({ where, data }: any) => {
        const b = store.builds.get(where.id) || {};
        Object.assign(b, data);
        store.builds.set(where.id, b);
        return b;
      },
      findUnique: async ({ where }: any) => store.builds.get(where.id) || null,
    },
    deployment: {
      create: async ({ data }: any) => {
        const id = data.id || `dep_${Math.random().toString(36).slice(2, 9)}`;
        const dep = { ...data, id, createdAt: new Date() };
        store.deployments.set(id, dep);
        return dep;
      },
      update: async ({ where, data }: any) => {
        const d = store.deployments.get(where.id) || {};
        Object.assign(d, data);
        store.deployments.set(where.id, d);
        return d;
      },
      findFirst: async ({ where }: any) => {
        const d = store.deployments.get(where.id);
        if (!d) return null;
        return {
          ...d,
          build: store.builds.get(d.buildId),
          service: store.services.get(d.serviceId),
        };
      },
      findMany: async ({ where, take }: any) => {
        let list = Array.from(store.deployments.values()).filter((d) => d.serviceId === where.serviceId);
        list = list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        if (take) list = list.slice(0, take);
        return list.map((d) => ({
          ...d,
          build: store.builds.get(d.buildId),
        }));
      },
    },
    domain: {
      upsert: async ({ where, create, update }: any) => {
        const exist = store.domains.get(where.hostname);
        if (exist) {
          Object.assign(exist, update);
          return exist;
        }
        store.domains.set(create.hostname, create);
        return create;
      },
    },
  };

  (globalThis as any).prisma = mockDb;

  // Initialize store items
  const testProject = { id: testProjectId, name: "Redeploy Proj", slug: "redeploy-proj" };
  const testEnv = { id: testEnvId, projectId: testProjectId, name: "production", isDefault: true };
  const testService = {
    id: testServiceId,
    environmentId: testEnvId,
    name: "redeploy-app",
    sourceType: "empty",
    port: 10005,
    isPaused: false,
    deletedAt: null,
  };

  store.projects.set(testProjectId, testProject);
  store.environments.set(testEnvId, testEnv);
  store.services.set(testServiceId, testService);

  const caller = appRouter.createCaller({
    session: {
      user: { id: testUserId, email: "redeploy@syncbay.dev", name: "Redeploy Tester", role: "USER" },
      expires: new Date(Date.now() + 86400000).toISOString(),
    },
    db: mockDb,
    req: {} as any,
  });

  // 1. Initial Deployment
  console.log("\n[1] Triggering initial deployment...");
  const triggerRes = await caller.deployment.trigger({
    serviceId: testServiceId,
    commitSha: "abc1111",
    commitMessage: "Initial release",
  });
  console.log(`Created Initial Build ${triggerRes.build.id}, Deployment ${triggerRes.deployment.id}`);

  // Mark initial build succeeded
  store.builds.get(triggerRes.build.id).status = "SUCCEEDED";

  // 2. Fast Redeploy (without rebuild) -> should reuse initial buildId
  console.log("\n[2] Testing Fast Redeploy (rebuild: false)...");
  const fastRedeploy = await caller.deployment.redeploy({
    deploymentId: triggerRes.deployment.id,
    rebuild: false,
  });
  console.log(`Fast Redeploy created Deployment ${fastRedeploy.id} with buildId: ${fastRedeploy.buildId}`);
  if (fastRedeploy.buildId !== triggerRes.build.id) {
    throw new Error(`Expected fast redeploy to reuse buildId ${triggerRes.build.id}, got ${fastRedeploy.buildId}`);
  }
  console.log("✔ Fast redeploy successfully reused cached build record!");

  // 3. Clean Rebuild (with rebuild: true) -> should create a brand new build record
  console.log("\n[3] Testing Clean Rebuild (rebuild: true)...");
  const cleanRebuild = await caller.deployment.redeploy({
    deploymentId: triggerRes.deployment.id,
    rebuild: true,
  });
  console.log(`Clean Rebuild created Deployment ${cleanRebuild.id} with new buildId: ${cleanRebuild.buildId}`);
  if (cleanRebuild.buildId === triggerRes.build.id) {
    throw new Error(`Expected clean rebuild to create new buildId, but reused old ${triggerRes.build.id}`);
  }
  console.log("✔ Clean rebuild successfully created fresh build record!");

  // 4. Failed Build Redeployment Enforcement
  console.log("\n[4] Testing Redeploy when previous build was marked FAILED...");
  const failedBuildId = "bld_failed_001";
  const failedDeployId = "dep_failed_001";
  const failedBuild = {
    id: failedBuildId,
    serviceId: testServiceId,
    commitSha: "bad0000",
    commitMessage: "Broken build",
    status: "FAILED",
    createdAt: new Date(),
  };
  const failedDeploy = {
    id: failedDeployId,
    serviceId: testServiceId,
    buildId: failedBuildId,
    status: "FAILED",
    createdAt: new Date(),
  };
  store.builds.set(failedBuildId, failedBuild);
  store.deployments.set(failedDeployId, failedDeploy);

  const testErrorStr = "SyntaxError: Unexpected token ';' at src/index.ts:12:4";
  logEventBus.recordError(failedDeployId, testErrorStr);

  // Even if caller passes rebuild: false, because the previous build was FAILED, it MUST create a fresh build
  const autoRebuiltDeploy = await caller.deployment.redeploy({
    deploymentId: failedDeployId,
    rebuild: false,
  });
  console.log(`Redeploy of failed deploy created Deployment ${autoRebuiltDeploy.id} with buildId: ${autoRebuiltDeploy.buildId}`);
  if (autoRebuiltDeploy.buildId === failedBuildId) {
    throw new Error("Expected redeploy to automatically rebuild when previous build failed!");
  }
  console.log("✔ Failed build automatically generated a fresh build record on redeploy!");

  // 5. Error Message Surfacing across Routers
  console.log("\n[5] Testing Error Message Surfacing across tRPC queries...");
  const depById = await caller.deployment.byId({ deploymentId: failedDeployId });
  if (depById.errorMessage !== testErrorStr) {
    throw new Error(`Expected errorMessage on deployment.byId, got: ${depById.errorMessage}`);
  }
  console.log(`✔ deployment.byId returned errorMessage: "${depById.errorMessage}"`);

  const depList = await caller.deployment.list({ serviceId: testServiceId });
  const foundFailed = depList.find((d) => d.id === failedDeployId);
  if (foundFailed?.errorMessage !== testErrorStr) {
    throw new Error(`Expected errorMessage on deployment.list, got: ${foundFailed?.errorMessage}`);
  }
  console.log(`✔ deployment.list returned errorMessage for failed deployment`);

  const srvById = await caller.service.byId({ serviceId: testServiceId });
  const srvFailedDep = srvById.deployments.find((d: any) => d.id === failedDeployId);
  if (srvFailedDep?.errorMessage !== testErrorStr) {
    throw new Error(`Expected errorMessage on service.byId deployments, got: ${srvFailedDep?.errorMessage}`);
  }
  console.log(`✔ service.byId returned errorMessage for failed deployment`);

  const projById = await caller.project.byId({ projectId: testProjectId });
  const projDeployments = projById.environments[0]?.services[0]?.deployments || [];
  const projFailedDep = projDeployments.find((d: any) => d.id === failedDeployId);
  if (projFailedDep?.errorMessage !== testErrorStr) {
    throw new Error(`Expected errorMessage on project.byId deployments, got: ${projFailedDep?.errorMessage}`);
  }
  console.log(`✔ project.byId returned errorMessage for failed deployment`);

  // 6. Test Build Pipeline log streaming and [build:error] capturing
  console.log("\n[6] Testing pipeline build error capturing...");
  const capturedLogs: string[] = [];
  const { MockPipelineExecutor, BuildPipeline } = await import("../runner/src/pipeline");
  const mockExec = new MockPipelineExecutor();
  mockExec.setHandler(/nixpacks build/, () => ({
    stdout: "Compiling client components...\nType check error: Property 'foo' does not exist on type 'Bar'.",
    stderr: "TS2339: Property 'foo' does not exist on type 'Bar'.",
    exitCode: 1,
  }));

  const brokenPipeline = new BuildPipeline({ executor: mockExec });
  const pipelineResult = await brokenPipeline.execute({
    jobId: "job_broken",
    serviceName: "broken-app",
    buildCommand: "npm run build",
    onLog: (line) => capturedLogs.push(line),
  });

  if (pipelineResult.success) {
    throw new Error("Expected broken container build to fail");
  }
  console.log(`Container build failed as expected with error: ${pipelineResult.error}`);
  const hasBuildErrorLog = capturedLogs.some((l) => l.includes("[build:error]"));
  if (!hasBuildErrorLog) {
    throw new Error("Expected pipeline to log [build:error] chunk");
  }
  console.log("✔ Container build pipeline captured compiler error and streamed [build:error] log!");

  // Test native build failure
  const nativeLogs: string[] = [];
  const nativeMockExec = new MockPipelineExecutor();
  nativeMockExec.setHandler(/docker info/, () => ({ stdout: "", stderr: "Docker daemon not running", exitCode: 1 }));
  nativeMockExec.setHandler(/nixpacks --version/, () => ({ stdout: "", stderr: "command not found", exitCode: 1 }));
  nativeMockExec.setHandler(/npm run build/, () => ({
    stdout: "Compiling typescript...\nError: Cannot find module '@types/missing'",
    stderr: "Build failed with exit code 1",
    exitCode: 1,
  }));
  nativeMockExec.mockedFiles.add(path.join(process.cwd(), ".runner_workspace", "job_broken_native", "package.json"));

  const brokenNativePipeline = new BuildPipeline({ executor: nativeMockExec });
  const nativeResult = await brokenNativePipeline.execute({
    jobId: "job_broken_native",
    serviceName: "broken-native-app",
    buildCommand: "npm run build",
    onLog: (line) => nativeLogs.push(line),
  });

  if (nativeResult.success) {
    throw new Error("Expected broken native build to fail");
  }
  console.log(`Native build failed as expected with error: ${nativeResult.error}`);
  const hasNativeBuildErrorLog = nativeLogs.some((l) => l.includes("[build:error]"));
  if (!hasNativeBuildErrorLog) {
    throw new Error("Expected native pipeline to log [build:error] chunk");
  }
  console.log("✔ Native build pipeline captured compiler error and streamed [build:error] log!");

  // Cleanup test workspaces
  await fs.rm(path.join(process.cwd(), ".runner_workspace", "job_broken"), { recursive: true, force: true }).catch(() => null);
  await fs.rm(path.join(process.cwd(), ".runner_workspace", "job_broken_native"), { recursive: true, force: true }).catch(() => null);

  console.log("\n🎉 ALL REDEPLOY, REBUILD, LOG STREAMING & ERROR SURFACING TESTS PASSED PERFECTLY!");
  process.exit(0);
}

runVerification().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
