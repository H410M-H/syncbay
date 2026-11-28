/**
 * Create-from-template: turns a template repository (and its optional `syncbay.json`) into a
 * service in an existing project environment, its managed databases and its variables. The first
 * deploy is triggered afterwards by the caller through `deployment.trigger` (runner preflight,
 * build record, scheduling), exactly like any other new service.
 *
 * Order matters: the service is created first, then each database through the shared
 * `createManagedDatabase()` path, whose variable injection writes DATABASE_URL / REDIS_URL (and
 * `<NAME>_URL`) into the service. A manifest that names another key for a service URL gets that
 * key persisted as well. Everything is checked before anything is written, and a retry reuses
 * the service, databases and variables an earlier attempt created (generated secrets are kept).
 */

import type { PrismaClient } from "@prisma/client";
import { claimDefaultHostname } from "@/lib/domains/claim";
import { createManagedDatabase, getDatabaseEnvKeys } from "@/lib/database-provider";
import { resolveGithubToken } from "@/lib/github";
import {
  fetchTemplateManifest,
  resolveTemplateEnv,
  type ManifestFetchResult,
  type TemplateManifest,
  type TemplateSource,
} from "@/lib/templates/manifest";

type Client = Pick<PrismaClient, "service" | "environmentVariable" | "databaseInstance" | "domain">;

export class TemplateInputError extends Error {
  constructor(
    message: string,
    readonly missing: string[] = []
  ) {
    super(message);
    this.name = "TemplateInputError";
  }
}

/**
 * Fetches the manifest with a GitHub token of the user / project's workspace when there is one,
 * and falls back to the public endpoints when that token cannot read it (public repositories
 * never need a GitHub connection).
 */
export async function loadTemplateManifest(
  source: TemplateSource,
  who: { userId?: string | null; projectId?: string | null }
): Promise<ManifestFetchResult> {
  const token = await resolveGithubToken({ userId: who.userId, projectId: who.projectId }).catch(() => null);
  if (token) {
    const withToken = await fetchTemplateManifest(source, { token });
    if (withToken.status !== "unreachable") return withToken;
  }
  return fetchTemplateManifest(source);
}

const SERVICE_PROVIDER = { postgres: "POSTGRES", redis: "REDIS", valkey: "REDIS" } as const;

export interface ProvisionTemplateParams {
  workspaceId: string;
  projectId: string;
  environment: { id: string; name: string };
  source: TemplateSource;
  branch: string;
  /** null when the repository has no syncbay.json: a plain service is created. */
  manifest: TemplateManifest | null;
  /** Values the user typed, keyed by env key. Keys the manifest does not declare are ignored. */
  env?: Record<string, string | undefined>;
  serviceName?: string;
}

export interface ProvisionTemplateResult {
  serviceId: string;
  reusedService: boolean;
  databases: { id: string; name: string; provider: string; status: string; extensions: string[]; reused: boolean }[];
  variables: { key: string; isSecret: boolean; generated: boolean; reused: boolean }[];
}

export async function provisionTemplate(client: Client, params: ProvisionTemplateParams): Promise<ProvisionTemplateResult> {
  const manifest = params.manifest;
  const { variables, missing } = resolveTemplateEnv(manifest || { env: [] }, params.env || {});
  if (missing.length) {
    throw new TemplateInputError(`Required variable${missing.length === 1 ? "" : "s"} missing: ${missing.join(", ")}`, missing);
  }
  const serviceName = params.serviceName || "web";

  // 1. Service (reused when a retry finds the one an earlier attempt created)
  let service = await client.service.findFirst({
    where: { environmentId: params.environment.id, name: serviceName, repoUrl: params.source.repoUrl, deletedAt: null },
  });
  const reusedService = Boolean(service);
  if (!service) {
    service = await client.service.create({
      data: {
        environmentId: params.environment.id,
        name: serviceName,
        sourceType: "github",
        repoUrl: params.source.repoUrl,
        branch: params.branch,
        port: manifest?.port ?? null,
        healthCheckUrl: manifest?.healthcheckPath ?? null,
      },
    });
    await claimDefaultHostname(client, { id: service.id, name: service.name, environment: { name: params.environment.name } });
  }
  const serviceId = service.id;

  // 2. Manifest variables (a retry keeps what is already set, so generated secrets stay stable)
  const variableReport: ProvisionTemplateResult["variables"] = [];
  for (const v of variables) {
    const existing = await client.environmentVariable.findFirst({ where: { serviceId, key: v.key } });
    if (existing) {
      variableReport.push({ key: v.key, isSecret: existing.isSecret, generated: false, reused: true });
      continue;
    }
    await client.environmentVariable.create({
      data: { serviceId, key: v.key, value: v.value, isSecret: v.isSecret, isReference: v.value.includes("${{") },
    });
    variableReport.push({ key: v.key, isSecret: v.isSecret, generated: v.generated, reused: false });
  }

  // 3. Databases, before the first deploy; injection writes their URLs into the service
  const databases: ProvisionTemplateResult["databases"] = [];
  const usedNames = new Set<string>();
  for (const svc of manifest?.services || []) {
    let name: string = svc.type;
    for (let n = 2; usedNames.has(name); n++) name = `${svc.type}-${n}`;
    usedNames.add(name);
    const provider = SERVICE_PROVIDER[svc.type];

    let instance = await client.databaseInstance.findFirst({
      where: { environmentId: params.environment.id, name, provider, status: "ACTIVE" },
    });
    const reused = Boolean(instance);
    if (!instance) {
      instance = await createManagedDatabase(
        client,
        { workspaceId: params.workspaceId, projectId: params.projectId, environmentId: params.environment.id },
        { name, provider, extensions: svc.extensions, engine: svc.type === "valkey" ? "valkey" : undefined }
      );
    }
    databases.push({ id: instance.id, name, provider, status: instance.status, extensions: instance.extensions, reused });

    // The manifest may want the URL under another key than the injected ones.
    if (!getDatabaseEnvKeys(name, provider).includes(svc.env)) {
      const existing = await client.environmentVariable.findFirst({ where: { serviceId, key: svc.env } });
      if (!existing) {
        await client.environmentVariable.create({
          data: { serviceId, key: svc.env, value: instance.connectionUrl, isSecret: true, isReference: true },
        });
      }
    }
  }

  return { serviceId, reusedService, databases, variables: variableReport };
}
