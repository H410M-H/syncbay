/**
 * Verification: Managed databases — provisioning, env injection, health, cleanup.
 *
 * 1. database.create (mock provider) records ACTIVE status and injects <NAME>_URL + DATABASE_URL
 *    into existing services without overriding user-set keys.
 * 2. A service created AFTER the database receives DATABASE_URL / REDIS_URL at deploy time
 *    (engine.ts merge), user keys still win.
 * 3. database.health persists status/lastHealthAt.
 * 4. database.delete removes injected variables (only rows still pointing at the DB).
 * 5. Non-members cannot provision.
 * 6. Runner provisioning over signed HTTP against a real RunnerDaemon in mock mode.
 *
 * Runs with tsx and an in-memory globalThis.prisma.
 */

import assert from "node:assert";

type Row = Record<string, any>;
const store = {
  workspaceMembers: [] as Row[],
  projects: [] as Row[],
  environments: [] as Row[],
  services: [] as Row[],
  variables: [] as Row[],
  databases: [] as Row[],
};
let seq = 0;
const nextId = (p: string) => `${p}${++seq}`;

function matchValue(actual: any, expected: any): boolean {
  if (expected && typeof expected === "object" && !(expected instanceof Date)) {
    if ("in" in expected) return expected.in.includes(actual);
    if ("not" in expected) return actual !== expected.not;
  }
  return actual === expected;
}
function matchFlat(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => matchValue(row[k] ?? null, v));
}

function projectAccessible(projectId: string, where: any): boolean {
  const project = store.projects.find((p) => p.id === projectId);
  if (!project) return false;
  if (where?.deletedAt === null && project.deletedAt) return false;
  const some = where?.workspace?.members?.some;
  if (some) {
    return store.workspaceMembers.some(
      (m) => m.workspaceId === project.workspaceId && m.userId === some.userId && (!some.role || some.role.in.includes(m.role))
    );
  }
  return true;
}
function withEnvironment(dbRow: Row) {
  const env = store.environments.find((e) => e.id === dbRow.environmentId)!;
  return { ...dbRow, environment: { ...env, project: store.projects.find((p) => p.id === env.projectId) } };
}

(globalThis as any).prisma = new Proxy(
  {
    workspaceMember: {
      findUnique: async ({ where }: any) =>
        store.workspaceMembers.find(
          (m) => m.workspaceId === where.workspaceId_userId.workspaceId && m.userId === where.workspaceId_userId.userId
        ) || null,
    },
    environment: {
      findFirst: async ({ where }: any) => {
        const env = store.environments.find((e) => e.id === where.id);
        if (!env || !projectAccessible(env.projectId, where.project)) return null;
        return { ...env, project: store.projects.find((p) => p.id === env.projectId) };
      },
    },
    service: {
      findMany: async ({ where }: any) => store.services.filter((s) => matchFlat(s, where)).map((s) => ({ id: s.id })),
      findUnique: async ({ where }: any) => {
        const svc = store.services.find((s) => s.id === where.id);
        if (!svc) return null;
        const env = store.environments.find((e) => e.id === svc.environmentId)!;
        return {
          ...svc,
          variables: store.variables.filter((v) => v.serviceId === svc.id),
          domains: [],
          environment: {
            ...env,
            databases: store.databases.filter((d) => d.environmentId === env.id),
            project: store.projects.find((p) => p.id === env.projectId),
          },
        };
      },
    },
    environmentVariable: {
      findFirst: async ({ where }: any) => store.variables.find((v) => matchFlat(v, where)) || null,
      create: async ({ data }: any) => {
        const row = { id: nextId("var_"), serviceId: null, workspaceId: null, isSecret: true, isReference: false, ...data };
        store.variables.push(row);
        return row;
      },
      deleteMany: async ({ where }: any) => {
        const before = store.variables.length;
        store.variables = store.variables.filter((v) => !matchFlat(v, where));
        return { count: before - store.variables.length };
      },
    },
    databaseInstance: {
      create: async ({ data }: any) => {
        const row = { id: nextId("cdb"), status: "PROVISIONING", createdAt: new Date(Date.now() + seq), lastHealthAt: null, ...data };
        store.databases.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = store.databases.find((d) => d.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
      findUnique: async ({ where }: any) => {
        const row = store.databases.find((d) => d.id === where.id);
        return row ? withEnvironment(row) : null;
      },
      findFirst: async ({ where }: any) => {
        const row = store.databases.find((d) => d.id === where.id);
        if (!row) return null;
        const env = store.environments.find((e) => e.id === row.environmentId)!;
        return projectAccessible(env.projectId, where.environment?.project) ? row : null;
      },
      delete: async ({ where }: any) => {
        const idx = store.databases.findIndex((d) => d.id === where.id);
        return store.databases.splice(idx, 1)[0];
      },
    },
  } as Row,
  {
    // Any other model (build, deployment, domain, account…) is a no-op for the engine.
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return new Proxy({}, { get: () => async () => null });
    },
  }
);

async function runTests() {
  delete process.env.RUNNER_URL;
  delete process.env.DATABASE_PARTNER_API_KEY;

  const { databaseRouter } = await import("../src/server/routers/database");
  const { executeDeployment } = await import("../src/lib/orchestrator/engine");
  const { RunnerDriverFactory } = await import("../src/lib/orchestrator/runner-driver");
  const provider = await import("../src/lib/database-provider");

  // Capture the env each deployment dispatches, then end the job quickly.
  let capturedEnv: Record<string, string> = {};
  RunnerDriverFactory.registerDriver("local", () => ({
    type: "local",
    dispatchBuild: async (params: any) => {
      capturedEnv = { ...(params.environmentVariables || {}) };
      return { jobId: "job_capture", driverType: "local", status: "FAILED" };
    },
    checkStatus: async () => ({ jobId: "job_capture", status: "FAILED" }),
    stopContainer: async () => ({ success: true }),
  }) as any);
  const deployEnv = async (serviceId: string) => {
    capturedEnv = {};
    await executeDeployment(`dep_${serviceId}`, `build_${serviceId}`, serviceId, { serviceId, driverType: "local" }).catch(() => null);
    return capturedEnv;
  };

  store.workspaceMembers.push({ id: "m1", workspaceId: "ws_1", userId: "user_1", role: "OWNER" });
  store.projects.push({ id: "proj_1", workspaceId: "ws_1", name: "shop", deletedAt: null });
  store.environments.push({ id: "env_1", projectId: "proj_1", name: "production" });
  store.services.push({ id: "svc_old", environmentId: "env_1", name: "api", port: 3000, deletedAt: null });
  // User-set DATABASE_URL on the pre-existing service must never be overridden.
  store.variables.push({ id: "var_user", serviceId: "svc_old", workspaceId: null, key: "DATABASE_URL", value: "postgresql://me:custom@external:5432/app", isSecret: true, isReference: false });

  const caller = databaseRouter.createCaller({ db: (globalThis as any).prisma, session: { user: { id: "user_1" } }, headers: new Headers() } as any);

  console.log("[1] database.create (mock provisioning) + injection into existing services");
  const pg = await caller.create({ environmentId: "env_1", name: "main-db", provider: "POSTGRES", region: "us-east-1" });
  assert.strictEqual(pg.status, "ACTIVE");
  assert.ok(pg.partnerDbId?.startsWith("sb-db-postgres-"), "mock provisioning uses sb-db- prefix");
  assert.ok(pg.connectionUrl.startsWith("postgresql://"));
  assert.ok(pg.host && pg.port === 5432);
  const oldVars = store.variables.filter((v) => v.serviceId === "svc_old");
  const mainUrlVar = oldVars.find((v) => v.key === "MAIN_DB_URL");
  assert.ok(mainUrlVar && mainUrlVar.value === pg.connectionUrl && mainUrlVar.isReference === true && mainUrlVar.isSecret === true);
  assert.strictEqual(oldVars.find((v) => v.key === "DATABASE_URL")!.value, "postgresql://me:custom@external:5432/app");
  assert.ok(store.variables.some((v) => v.workspaceId === "ws_1" && v.serviceId === null && v.key === "MAIN_DB_URL"));
  console.log("  ✔ ACTIVE instance, MAIN_DB_URL injected, user DATABASE_URL preserved");

  console.log("[2] Service created after the database receives DATABASE_URL / REDIS_URL at deploy time");
  const redis = await caller.create({ environmentId: "env_1", name: "cache", provider: "REDIS", region: "us-east-1" });
  assert.ok(redis.connectionUrl.startsWith("redis://"));
  store.services.push({ id: "svc_new", environmentId: "env_1", name: "worker", port: 3000, deletedAt: null });
  assert.strictEqual(store.variables.filter((v) => v.serviceId === "svc_new").length, 0, "no rows persisted for the new service");
  const envNew = await deployEnv("svc_new");
  assert.strictEqual(envNew.DATABASE_URL, pg.connectionUrl);
  assert.strictEqual(envNew.MAIN_DB_URL, pg.connectionUrl);
  assert.strictEqual(envNew.REDIS_URL, redis.connectionUrl);
  assert.strictEqual(envNew.CACHE_URL, redis.connectionUrl);
  const envOld = await deployEnv("svc_old");
  assert.strictEqual(envOld.DATABASE_URL, "postgresql://me:custom@external:5432/app", "user key wins at deploy time");
  console.log("  ✔ deploy-time merge injects DATABASE_URL/REDIS_URL without overriding user keys");

  console.log("[3] database.health");
  const health = await caller.health({ databaseId: pg.id });
  assert.strictEqual(health.healthy, true);
  assert.strictEqual(health.status, "ACTIVE");
  assert.ok(store.databases.find((d) => d.id === pg.id)!.lastHealthAt instanceof Date);
  console.log("  ✔ health persisted (mock mode)");

  console.log("[4] database.delete cleans up injected variables");
  await assert.rejects(caller.delete({ databaseId: pg.id, confirmName: "wrong" }), /Name confirmation mismatch/);
  await caller.delete({ databaseId: pg.id, confirmName: "main-db" });
  assert.ok(!store.databases.some((d) => d.id === pg.id));
  assert.ok(!store.variables.some((v) => v.value === pg.connectionUrl), "all rows pointing at the DB removed");
  assert.ok(store.variables.some((v) => v.id === "var_user"), "user-set DATABASE_URL kept");
  const envAfter = await deployEnv("svc_new");
  assert.strictEqual(envAfter.DATABASE_URL, undefined);
  assert.strictEqual(envAfter.REDIS_URL, redis.connectionUrl);
  console.log("  ✔ injected vars removed, user vars and other DBs untouched");

  console.log("[5] Access check precedes environment lookup");
  const outsider = databaseRouter.createCaller({ db: (globalThis as any).prisma, session: { user: { id: "user_2" } }, headers: new Headers() } as any);
  await assert.rejects(outsider.create({ environmentId: "env_1", name: "x", provider: "POSTGRES", region: "us-east-1" }), (err: any) => err.code === "FORBIDDEN");
  await assert.rejects(outsider.create({ environmentId: "env_missing", name: "x", provider: "POSTGRES", region: "us-east-1" }), (err: any) => err.code === "FORBIDDEN");
  console.log("  ✔ non-members get FORBIDDEN for existing and missing environments alike");

  console.log("[6] Runner provisioning over signed HTTP (RunnerDaemon in mock mode)");
  const { RunnerDaemon } = await import("../runner/src/index");
  const { RunnerServices } = await import("../runner/src/services");
  const { PortManager } = await import("../runner/src/port-manager");
  const pm = new PortManager({ rangeStart: 37000, rangeEnd: 37050 });
  const daemon = new RunnerDaemon({
    port: 0,
    host: "127.0.0.1",
    webhookSecret: "managed-db-secret",
    portManager: pm,
    services: new RunnerServices({ portManager: pm, mode: "mock" }),
  });
  const port = await daemon.start();
  process.env.RUNNER_URL = `http://127.0.0.1:${port}`;
  process.env.RUNNER_SECRET = "managed-db-secret";
  try {
    const creds = await provider.provisionManagedDatabase({ id: "cdbrunner1", name: "orders", provider: "POSTGRES" });
    assert.strictEqual(creds.mode, "runner");
    assert.ok(creds.containerId?.startsWith("mock-"));
    assert.ok(creds.port >= 37000 && creds.port <= 37050);
    assert.ok(pm.isPortAllocated(creds.port));
    const ref = { id: "cdbrunner1", partnerDbId: creds.partnerDbId, containerId: creds.containerId };
    const h = await provider.checkDatabaseHealth(ref);
    assert.strictEqual(h.healthy, true);
    assert.strictEqual(h.mode, "runner");
    await provider.destroyManagedDatabase(ref);
    assert.strictEqual(pm.isPortAllocated(creds.port), false);

    process.env.RUNNER_SECRET = "wrong-secret";
    await assert.rejects(provider.provisionManagedDatabase({ id: "cdbrunner2", name: "x", provider: "REDIS" }), /HTTP 401/);
    console.log("  ✔ provision/health/destroy round-trip via HMAC-signed runner API; bad secret rejected");
  } finally {
    delete process.env.RUNNER_URL;
    delete process.env.RUNNER_SECRET;
    await daemon.stop();
  }

  console.log("\nAll managed database verifications passed.");
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n✖ Managed database verification failed:", err);
    process.exit(1);
  });
