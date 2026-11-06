/**
 * Syncbay PaaS — Managed Database Provider (R6 Core)
 * Provisions, parses, and manages PostgreSQL, Redis/Valkey, and MySQL database instances.
 * With RUNNER_URL set, the runner provisions the database: Docker containers (postgres:16-alpine,
 * redis:7-alpine, mysql:8) or, without Docker, native Postgres/Redis processes. Without a runner
 * a simulated `sb-db-*` instance is returned (it has no server; Query Studio refuses it).
 */

import type { PrismaClient } from "@prisma/client";
import { getRunnerBaseUrl, runnerJson } from "@/lib/runner-client";

const PARTNER_API_KEY = process.env.DATABASE_PARTNER_API_KEY;

export interface DatabaseCredentials {
  partnerDbId: string;
  connectionUrl: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  sslMode: string;
  cliCommand: string;
  flags: string[];
}

/**
 * Parses a database connection URL into structured credentials and connection helpers.
 */
export function parseDatabaseUrl(
  connectionUrl: string,
  providerHint?: "POSTGRES" | "REDIS" | "MYSQL"
): DatabaseCredentials {
  try {
    const parsed = new URL(connectionUrl);
    const protocol = parsed.protocol.replace(/:$/, "").toLowerCase();

    let provider: "POSTGRES" | "REDIS" | "MYSQL" = "POSTGRES";
    if (protocol.includes("postgres")) provider = "POSTGRES";
    else if (protocol.includes("mysql")) provider = "MYSQL";
    else if (protocol.includes("redis")) provider = "REDIS";
    else if (providerHint) provider = providerHint;

    const host = parsed.hostname;
    const port = parsed.port
      ? parseInt(parsed.port, 10)
      : provider === "POSTGRES"
      ? 5432
      : provider === "MYSQL"
      ? 3306
      : 6379;

    const user = parsed.username ? decodeURIComponent(parsed.username) : provider === "POSTGRES" ? "postgres" : provider === "MYSQL" ? "root" : "default";
    const password = parsed.password ? decodeURIComponent(parsed.password) : "";
    const database = parsed.pathname ? parsed.pathname.replace(/^\//, "") : "main";
    const sslMode = parsed.searchParams.get("sslmode") || (provider === "POSTGRES" ? "require" : "disabled");

    let cliCommand = "";
    if (provider === "POSTGRES") {
      cliCommand = `psql "${connectionUrl}"`;
    } else if (provider === "MYSQL") {
      cliCommand = `mysql -h ${host} -P ${port} -u ${user} -p${password ? "*****" : ""} ${database}`;
    } else if (provider === "REDIS") {
      cliCommand = `redis-cli -u "${connectionUrl}"`;
    }

    return {
      partnerDbId: host.split(".")[0] || "managed-db",
      connectionUrl,
      host,
      port,
      user,
      password,
      database,
      sslMode,
      cliCommand,
      flags: [provider.toLowerCase(), `port:${port}`, `ssl:${sslMode}`],
    };
  } catch {
    // Regex fallback
    const match = connectionUrl.match(/^([a-zA-Z0-9+.-]+):\/\/([^:]+):([^@]+)@([^:/]+)(?::(\d+))?(?:\/(.*))?$/);
    const protocol = match?.[1] || "postgresql";
    const user = match?.[2] || "postgres";
    const password = match?.[3] || "";
    const host = match?.[4] || "localhost";
    const port = match?.[5] ? parseInt(match[5], 10) : 5432;
    const database = match?.[6]?.split("?")[0] || "main";

    return {
      partnerDbId: host.split(".")[0] || "managed-db",
      connectionUrl,
      host,
      port,
      user,
      password,
      database,
      sslMode: "require",
      cliCommand: `psql "${connectionUrl}"`,
      flags: ["parsed-fallback"],
    };
  }
}

type ManagedProvider = "POSTGRES" | "REDIS" | "MYSQL";

export interface ProvisionResult extends DatabaseCredentials {
  containerId: string | null;
  mode: "runner" | "mock";
}

interface RunnerDatabaseResponse {
  id: string;
  connectionUrl: string;
  host: string;
  port: number;
  containerId: string;
  mode: "docker" | "native" | "mock";
}

/**
 * Provisions a managed database on the runner (RUNNER_URL) or as a local simulation.
 * `id` (the DatabaseInstance id) becomes the runner-side database id.
 */
export async function provisionManagedDatabase(params: {
  id?: string;
  projectId?: string;
  environmentId?: string;
  name: string;
  provider: ManagedProvider;
  region?: string;
}): Promise<ProvisionResult> {
  const provider = params.provider;
  const region = params.region || "us-east-1";

  if (getRunnerBaseUrl()) {
    const runnerDb = await runnerJson<RunnerDatabaseResponse>("/api/databases", {
      method: "POST",
      body: { id: params.id, name: params.name, provider },
      timeoutMs: 320000,
    });
    const creds = parseDatabaseUrl(runnerDb.connectionUrl, provider);
    return {
      ...creds,
      partnerDbId: runnerDb.id,
      host: runnerDb.host,
      port: runnerDb.port,
      sslMode: "disable",
      containerId: runnerDb.containerId,
      mode: "runner",
    };
  }

  if (PARTNER_API_KEY) {
    // Cloud partner integration (Neon, Upstash, PlanetScale)
    throw new Error("External partner database provisioning requires cloud credentials");
  }

  const mockId = `sb-db-${provider.toLowerCase()}-${Math.random().toString(36).substring(2, 9)}`;
  const mockPass = Math.random().toString(36).substring(2, 14);
  const mockHost = `${mockId}.${region}.syncbay-db.internal`;

  let mockUrl = "";
  if (provider === "POSTGRES") {
    mockUrl = `postgresql://postgres:${mockPass}@${mockHost}:5432/main?sslmode=require`;
  } else if (provider === "MYSQL") {
    mockUrl = `mysql://root:${mockPass}@${mockHost}:3306/main`;
  } else {
    mockUrl = `redis://default:${mockPass}@${mockHost}:6379`;
  }

  return { ...parseDatabaseUrl(mockUrl, provider), containerId: null, mode: "mock" };
}

interface ManagedDatabaseRef {
  id: string;
  partnerDbId?: string | null;
  containerId?: string | null;
}

function isRunnerManaged(ref: ManagedDatabaseRef): boolean {
  return Boolean(ref.containerId && getRunnerBaseUrl());
}

export interface DatabaseHealthResult {
  healthy: boolean;
  status: "ACTIVE" | "UNHEALTHY";
  mode: "runner" | "mock";
  latencyMs?: number;
  message?: string;
}

/**
 * Probes a managed database. Runner-managed instances are checked with
 * pg_isready / redis-cli ping on the runner; simulated instances are always healthy.
 */
export async function checkDatabaseHealth(ref: ManagedDatabaseRef): Promise<DatabaseHealthResult> {
  if (!isRunnerManaged(ref)) {
    return { healthy: true, status: "ACTIVE", mode: "mock", latencyMs: 0 };
  }
  const runnerId = encodeURIComponent(ref.partnerDbId || ref.id);
  try {
    const res = await runnerJson<{ healthy: boolean; latencyMs?: number; output?: string }>(
      `/api/databases/${runnerId}/health`,
      { method: "GET", timeoutMs: 15000 }
    );
    return {
      healthy: Boolean(res.healthy),
      status: res.healthy ? "ACTIVE" : "UNHEALTHY",
      mode: "runner",
      latencyMs: res.latencyMs,
      message: res.output,
    };
  } catch (err: any) {
    return { healthy: false, status: "UNHEALTHY", mode: "runner", message: err.message };
  }
}

/**
 * Tears down a managed database (runner container + volume) or a simulated instance.
 */
export async function destroyManagedDatabase(ref: ManagedDatabaseRef): Promise<{ success: boolean }> {
  if (isRunnerManaged(ref)) {
    const runnerId = encodeURIComponent(ref.partnerDbId || ref.id);
    await runnerJson(`/api/databases/${runnerId}`, { method: "DELETE", timeoutMs: 90000 });
  }
  return { success: true };
}

// ─── Environment variable injection ───────────────────────────────────────────

interface InjectableDatabase {
  name: string;
  provider: ManagedProvider;
  connectionUrl: string;
  status?: string | null;
  createdAt?: Date | string;
}

/** Keys injected for a database: `<NAME>_URL`, plus DATABASE_URL (Postgres) / REDIS_URL (Redis). */
export function getDatabaseEnvKeys(name: string, provider: ManagedProvider): string[] {
  const keys = [name.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_URL"];
  if (provider === "POSTGRES") keys.push("DATABASE_URL");
  if (provider === "REDIS") keys.push("REDIS_URL");
  return Array.from(new Set(keys));
}

/**
 * Deploy-time merge: adds connection URLs of the environment's databases to `envMap`
 * without overriding keys the user already set. Oldest database wins a shared key.
 * Returns the keys that were injected.
 */
export function applyDatabaseEnv(envMap: Record<string, string>, databases: InjectableDatabase[]): string[] {
  const injected: string[] = [];
  const usable = databases
    .filter((d) => d.connectionUrl && d.status !== "FAILED" && d.status !== "DELETING")
    .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
  for (const d of usable) {
    for (const key of getDatabaseEnvKeys(d.name, d.provider)) {
      if (!(key in envMap)) {
        envMap[key] = d.connectionUrl;
        injected.push(key);
      }
    }
  }
  return injected;
}

type VariableClient = Pick<PrismaClient, "environmentVariable" | "service">;

interface DatabaseVariableTarget {
  workspaceId: string;
  environmentId: string;
  name: string;
  provider: ManagedProvider;
  connectionUrl: string;
}

/**
 * Persists injected variables for existing services (and `<NAME>_URL` at workspace level).
 * Existing keys are left untouched; services created later receive the URLs at deploy time.
 */
export async function attachDatabaseVariables(client: VariableClient, target: DatabaseVariableTarget): Promise<number> {
  const keys = getDatabaseEnvKeys(target.name, target.provider);
  let created = 0;

  const wsKey = keys[0];
  const existingWsVar = await client.environmentVariable.findFirst({
    where: { workspaceId: target.workspaceId, serviceId: null, key: wsKey },
  });
  if (!existingWsVar) {
    await client.environmentVariable.create({
      data: { workspaceId: target.workspaceId, key: wsKey, value: target.connectionUrl, isSecret: true, isReference: true },
    });
    created++;
  }

  const services = await client.service.findMany({
    where: { environmentId: target.environmentId, deletedAt: null },
    select: { id: true },
  });
  for (const svc of services) {
    for (const key of keys) {
      const existing = await client.environmentVariable.findFirst({ where: { serviceId: svc.id, key } });
      if (existing) continue;
      await client.environmentVariable.create({
        data: { serviceId: svc.id, key, value: target.connectionUrl, isSecret: true, isReference: true },
      });
      created++;
    }
  }
  return created;
}

/** Removes variables injected for a database (only rows still pointing at its URL). */
export async function detachDatabaseVariables(client: VariableClient, target: DatabaseVariableTarget): Promise<number> {
  const keys = getDatabaseEnvKeys(target.name, target.provider);
  const services = await client.service.findMany({
    where: { environmentId: target.environmentId },
    select: { id: true },
  });
  const serviceIds = services.map((s) => s.id);

  const svcResult = serviceIds.length
    ? await client.environmentVariable.deleteMany({
        where: { serviceId: { in: serviceIds }, key: { in: keys }, value: target.connectionUrl },
      })
    : { count: 0 };
  const wsResult = await client.environmentVariable.deleteMany({
    where: { workspaceId: target.workspaceId, serviceId: null, key: { in: keys }, value: target.connectionUrl },
  });
  return svcResult.count + wsResult.count;
}

/**
 * PROJECT.md interface contract object
 */
export const databaseProvider = {
  provision: provisionManagedDatabase,
  destroy: destroyManagedDatabase,
  health: checkDatabaseHealth,
  parseDatabaseUrl,
};
