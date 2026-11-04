/**
 * Syncbay PaaS — Master Test Adapter
 * Bridges production code from `src/` with test oracles and harnesses.
 */

// Production imports from M1
import {
  detectRuntime as prodDetectRuntime,
  type DetectedRuntime,
  type DetectionOptions,
} from "../../src/lib/buildpack/detector";

import {
  generateNixpacksPlan as prodGenerateNixpacksPlan,
  generateOciManifest as prodGenerateOciManifest,
  type NixpacksPlan,
  type BuildOptions,
} from "../../src/lib/buildpack/nixpacks";

import {
  resolveEnvironmentVariables as prodResolveEnvironmentVariables,
  type EnvVar,
  type ResolutionContext,
  type ResolvedEnvVar,
} from "../../src/lib/buildpack/resolver";

import {
  describeBucket as prodDescribeBucket,
  generatePresignedUrl as prodGeneratePresignedUrl,
  readStorageConfig,
  type BucketDetails,
  type PresignedUrlParams,
  type StorageConfig,
} from "../../src/lib/storage-provider";

/**
 * Storage config for offline e2e runs: real SigV4 maths with throwaway test-only
 * keys (no network). Real R2_* / CLOUDFLARE_ACCOUNT_ID values win when present.
 */
function e2eStorageConfig(): StorageConfig {
  const env = readStorageConfig();
  return {
    ...env,
    accountId: env.accountId ?? "e2etestaccount",
    accessKeyId: env.accessKeyId ?? "E2E_TEST_ONLY_ACCESS_KEY",
    secretAccessKey: env.secretAccessKey ?? "e2e-test-only-secret-key",
  };
}

import {
  generateDefaultSubdomain as prodGenerateDefaultSubdomain,
  generateVerificationRecords as prodGenerateVerificationRecords,
  isValidHostname as prodIsValidHostname,
  slugifyHostPart as prodSlugifyHostPart,
  type VerificationRecords,
} from "../../src/lib/domain-service";

import {
  parseDatabaseUrl as prodParseDatabaseUrl,
  type DatabaseCredentials,
} from "../../src/lib/database-provider";

// Test Oracles & Harnesses
import {
  DeploymentStateMachine,
  type DeploymentRecord,
  type DeploymentStatus,
} from "./state-machine";

import {
  LogEventBus,
  MetricsStreamGenerator,
  type LogEntry,
  type MetricSnapshot,
} from "./event-bus";

import {
  PrPreviewManager,
  type GitHubPushPayload,
  type GitHubPullRequestPayload,
  type EphemeralEnvironment,
} from "./pr-preview-manager";

import {
  RbacOracle,
  type WorkspaceRole,
  type ApiTokenScope,
  type VolumeConfig,
} from "./rbac";

// Export unified interface
export const adapter = {
  // Buildpack Detector (F6)
  detectRuntime: (files: string[], options?: DetectionOptions | Record<string, string>): DetectedRuntime => {
    return prodDetectRuntime(files, options);
  },

  // Nixpacks & OCI Builder (F7)
  generateNixpacksPlan: (runtime: DetectedRuntime, options?: BuildOptions): NixpacksPlan => {
    return prodGenerateNixpacksPlan(runtime, options);
  },
  generateOciManifest: (runtime: DetectedRuntime, phases: NixpacksPlan["phases"], options?: BuildOptions): string => {
    return prodGenerateOciManifest(runtime, phases, options);
  },

  // Environment Variable & Reference Engine (F8)
  resolveEnvironmentVariables: (variables: EnvVar[], context: ResolutionContext): ResolvedEnvVar[] => {
    return prodResolveEnvironmentVariables(variables, context);
  },

  // Managed Database Provider (F16)
  parseDatabaseUrl: (connectionUrl: string, providerHint?: "POSTGRES" | "REDIS" | "MYSQL"): DatabaseCredentials => {
    return prodParseDatabaseUrl(connectionUrl, providerHint);
  },

  // Object Storage Provider (F17)
  // Describes the bucket (deterministic R2 name + S3 endpoint) without creating it remotely;
  // real create/list/delete is covered by tests/verify-r2.ts against a live S3 server.
  provisionBucket: async (params: { name: string; projectId: string }): Promise<BucketDetails> => {
    return prodDescribeBucket(params, e2eStorageConfig());
  },
  generatePresignedUrl: async (
    bucketNameOrParams: string | PresignedUrlParams,
    keyArg?: string,
    operationArg?: "get" | "put",
    expiresInSecondsArg?: number
  ): Promise<string> => {
    return await prodGeneratePresignedUrl(bucketNameOrParams, keyArg, operationArg, expiresInSecondsArg, {
      config: e2eStorageConfig(),
    });
  },

  // Domain & SSL Service (F14, F15)
  generateDefaultSubdomain: (serviceName: string, envName: string, suffix?: string): string => {
    return prodGenerateDefaultSubdomain(serviceName, envName, suffix);
  },
  generateVerificationRecords: (domain: string): VerificationRecords => {
    return prodGenerateVerificationRecords(domain);
  },
  isValidHostname: (hostname: string): boolean => {
    return prodIsValidHostname(hostname);
  },
  slugifyHostPart: (str: string): string => {
    return prodSlugifyHostPart(str);
  },

  // Deployment Orchestrator & State Machine (F9, F10, F11)
  createStateMachine: () => new DeploymentStateMachine(),

  // Real-Time SSE Logs & Telemetry Metrics (F12, F13)
  createEventBus: (maxBufferSize?: number) => new LogEventBus(maxBufferSize),
  createMetricsGenerator: () => new MetricsStreamGenerator(),

  // GitHub Push & Ephemeral PR Previews (F19, F20)
  createPrPreviewManager: () => new PrPreviewManager(),

  // RBAC & Navigation Oracle (F1, F2, F3, F4, F5, F18)
  rbac: new RbacOracle(),
};

export type {
  DetectedRuntime,
  NixpacksPlan,
  BuildOptions,
  EnvVar,
  ResolutionContext,
  ResolvedEnvVar,
  BucketDetails,
  VerificationRecords,
  DatabaseCredentials,
  DeploymentRecord,
  DeploymentStatus,
  LogEntry,
  MetricSnapshot,
  GitHubPushPayload,
  GitHubPullRequestPayload,
  EphemeralEnvironment,
  WorkspaceRole,
  ApiTokenScope,
  VolumeConfig,
};
