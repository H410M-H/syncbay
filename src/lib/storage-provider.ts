/**
 * Syncbay — Object storage provider (Cloudflare R2, S3 API compatible).
 *
 * - Bucket create/delete go through the Cloudflare R2 API
 *   (`/accounts/{CLOUDFLARE_ACCOUNT_ID}/r2/buckets`, Bearer CLOUDFLARE_API_TOKEN).
 *   When R2_ENDPOINT points at another S3-compatible server (local dev/tests), or
 *   no API token is set, the S3 CreateBucket/DeleteBucket calls are used instead.
 * - Object listing, emptying and presigned URLs use the S3 API at
 *   `https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com` (or R2_ENDPOINT),
 *   signed with R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY.
 * - Nothing is fabricated: without credentials every remote operation throws
 *   StorageNotConfiguredError (fail closed), and no access keys are invented.
 */

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { R2ApiClient, R2ApiError } from "@/lib/storage/r2-api";

export class StorageNotConfiguredError extends Error {
  readonly code = "STORAGE_NOT_CONFIGURED";
  constructor(message: string) {
    super(message);
    this.name = "StorageNotConfiguredError";
  }
}

export interface BucketDetails {
  name: string;
  projectId: string;
  r2BucketRef: string;
  /** S3 API endpoint, or null when no account / endpoint is configured. */
  endpoint: string | null;
  region: string;
  /** R2 buckets are private; objects are shared through presigned URLs. */
  publicUrl: string | null;
  createdAt: Date;
}

export interface PresignedUrlParams {
  bucketName: string;
  key: string;
  operation: "get" | "put";
  expiresInSeconds?: number;
}

export interface StorageConfig {
  accountId?: string;
  apiToken?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Explicit S3 endpoint override (R2_ENDPOINT), e.g. http://127.0.0.1:9000. */
  endpointOverride?: string;
}

/** Optional dependency injection (tests, scripts). */
export interface StorageDeps {
  config?: StorageConfig;
  s3?: S3Client;
  r2Api?: R2ApiClient;
}

export const MAX_PRESIGN_SECONDS = 604_800; // SigV4 maximum (7 days)

export function readStorageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const v = (k: string) => env[k]?.trim() || undefined;
  return {
    accountId: v("CLOUDFLARE_ACCOUNT_ID"),
    apiToken: v("CLOUDFLARE_API_TOKEN"),
    accessKeyId: v("R2_ACCESS_KEY_ID"),
    secretAccessKey: v("R2_SECRET_ACCESS_KEY"),
    endpointOverride: v("R2_ENDPOINT"),
  };
}

export function s3EndpointFor(config: StorageConfig): string | null {
  if (config.endpointOverride) return config.endpointOverride.replace(/\/$/, "");
  if (config.accountId) return `https://${config.accountId}.r2.cloudflarestorage.com`;
  return null;
}

function cfg(deps?: StorageDeps): StorageConfig {
  return deps?.config ?? readStorageConfig();
}

let cachedS3: { key: string; client: S3Client } | null = null;

function s3For(deps?: StorageDeps): S3Client {
  if (deps?.s3) return deps.s3;
  const config = cfg(deps);
  const endpoint = s3EndpointFor(config);
  if (!endpoint || !config.accessKeyId || !config.secretAccessKey) {
    throw new StorageNotConfiguredError(
      "R2 object storage is not configured: set CLOUDFLARE_ACCOUNT_ID (or R2_ENDPOINT), R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY."
    );
  }
  const key = `${endpoint}|${config.accessKeyId}|${config.secretAccessKey}`;
  if (!cachedS3 || cachedS3.key !== key) {
    cachedS3 = {
      key,
      client: new S3Client({
        region: "auto",
        endpoint,
        forcePathStyle: true,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        // R2 and most S3-compatible servers do not accept the SDK's default CRC32 trailers.
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      }),
    };
  }
  return cachedS3.client;
}

/** Bucket management via the Cloudflare API, unless an S3 endpoint override is in use. */
function r2ApiFor(deps?: StorageDeps): R2ApiClient | null {
  if (deps?.r2Api) return deps.r2Api;
  const config = cfg(deps);
  if (config.endpointOverride || !config.accountId || !config.apiToken) return null;
  return new R2ApiClient({ accountId: config.accountId, apiToken: config.apiToken });
}

/** True when buckets can be created/deleted and objects listed/presigned. */
export function isStorageConfigured(deps?: StorageDeps): boolean {
  const config = cfg(deps);
  // Listing, emptying and presigning always need the S3 keys, even when buckets
  // are created through the Cloudflare API.
  return !!(deps?.s3 || (s3EndpointFor(config) && config.accessKeyId && config.secretAccessKey));
}

/** Deterministic, R2-valid bucket name (3–63 chars, [a-z0-9-], alphanumeric ends). */
export function bucketRefFor(name: string, projectId: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "bucket";
  const suffix = projectId.slice(-6).toLowerCase().replace(/[^a-z0-9]/g, "0").padStart(6, "0");
  const prefix = `sb-bkt-${suffix}-`;
  return (prefix + slug).slice(0, 63).replace(/-+$/, "");
}

/** Pure description of a bucket (no network). */
export function describeBucket(params: { name: string; projectId: string; r2BucketRef?: string }, config: StorageConfig = readStorageConfig()): BucketDetails {
  return {
    name: params.name,
    projectId: params.projectId,
    r2BucketRef: params.r2BucketRef ?? bucketRefFor(params.name, params.projectId),
    endpoint: s3EndpointFor(config),
    region: "auto",
    publicUrl: null,
    createdAt: new Date(),
  };
}

/** Creates the real bucket (Cloudflare R2 API, or S3 CreateBucket with R2_ENDPOINT). */
export async function provisionBucket(
  params: { name: string; projectId: string },
  deps?: StorageDeps
): Promise<BucketDetails & { provisionedVia: "cloudflare-api" | "s3-api" }> {
  const details = describeBucket(params, cfg(deps));
  const api = r2ApiFor(deps);
  if (api) {
    try {
      await api.createBucket(details.r2BucketRef);
    } catch (err) {
      // 409 / 10004: the bucket already exists in this account (e.g. a retried create).
      if (!(err instanceof R2ApiError && (err.status === 409 || err.codes.includes(10004)))) throw err;
    }
    return { ...details, provisionedVia: "cloudflare-api" };
  }

  const s3 = s3For(deps);
  try {
    await s3.send(new CreateBucketCommand({ Bucket: details.r2BucketRef }));
  } catch (err) {
    if ((err as { name?: string }).name !== "BucketAlreadyOwnedByYou") throw err;
  }
  return { ...details, provisionedVia: "s3-api" };
}

export interface ListedObject {
  key: string;
  size: number;
  lastModified: Date | null;
  etag: string | null;
}

export async function listObjects(
  bucketRef: string,
  opts: { prefix?: string; maxKeys?: number; continuationToken?: string } = {},
  deps?: StorageDeps
): Promise<{ objects: ListedObject[]; nextContinuationToken: string | null; isTruncated: boolean }> {
  const res = await s3For(deps).send(
    new ListObjectsV2Command({
      Bucket: bucketRef,
      Prefix: opts.prefix || undefined,
      MaxKeys: Math.min(Math.max(opts.maxKeys ?? 100, 1), 1000),
      ContinuationToken: opts.continuationToken || undefined,
    })
  );
  return {
    objects: (res.Contents ?? []).map((o) => ({
      key: o.Key ?? "",
      size: o.Size ?? 0,
      lastModified: o.LastModified ?? null,
      etag: o.ETag ?? null,
    })),
    nextContinuationToken: res.NextContinuationToken ?? null,
    isTruncated: !!res.IsTruncated,
  };
}

function isNoSuchBucket(err: unknown) {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchBucket" || e?.$metadata?.httpStatusCode === 404;
}

/**
 * Deletes the real bucket. R2 only deletes empty buckets, so all objects are
 * removed first (batched DeleteObjects). A bucket that no longer exists counts as deleted.
 */
export async function deleteBucket(bucketRef: string, deps?: StorageDeps): Promise<{ deleted: true; objectsRemoved: number }> {
  const s3 = s3For(deps);
  let removed = 0;
  let token: string | undefined;
  try {
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucketRef, MaxKeys: 1000, ContinuationToken: token }));
      const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! })).filter((o) => !!o.Key);
      if (keys.length > 0) {
        await s3.send(new DeleteObjectsCommand({ Bucket: bucketRef, Delete: { Objects: keys, Quiet: true } }));
        removed += keys.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  } catch (err) {
    if (isNoSuchBucket(err)) return { deleted: true, objectsRemoved: removed };
    throw err;
  }

  const api = r2ApiFor(deps);
  if (api) {
    try {
      await api.deleteBucket(bucketRef);
    } catch (err) {
      if (!(err instanceof R2ApiError && err.status === 404)) throw err;
    }
  } else {
    try {
      await s3.send(new DeleteBucketCommand({ Bucket: bucketRef }));
    } catch (err) {
      if (!isNoSuchBucket(err)) throw err;
    }
  }
  return { deleted: true, objectsRemoved: removed };
}

/**
 * Generates a SigV4 presigned GET/PUT URL with the configured R2 keys.
 * Accepts `(params)` or `(bucketName, key, operation, expiresInSeconds)`.
 * Throws StorageNotConfiguredError when the keys are missing (never signs with throwaway keys).
 */
export async function generatePresignedUrl(
  bucketNameOrParams: string | PresignedUrlParams,
  keyArg?: string,
  operationArg?: "get" | "put",
  expiresInSecondsArg = 3600,
  deps?: StorageDeps
): Promise<string> {
  const p: PresignedUrlParams =
    typeof bucketNameOrParams === "object"
      ? bucketNameOrParams
      : { bucketName: bucketNameOrParams, key: keyArg ?? "", operation: operationArg ?? "get", expiresInSeconds: expiresInSecondsArg };

  const key = (p.key ?? "").replace(/^\/+/, "");
  if (!key) throw new Error("Object key is required for a presigned URL");
  if (!p.bucketName) throw new Error("Bucket name is required for a presigned URL");
  const expiresIn = Math.min(Math.max(Math.floor(p.expiresInSeconds ?? 3600), 1), MAX_PRESIGN_SECONDS);

  const command =
    p.operation === "put"
      ? new PutObjectCommand({ Bucket: p.bucketName, Key: key })
      : new GetObjectCommand({ Bucket: p.bucketName, Key: key });
  return getSignedUrl(s3For(deps), command, { expiresIn });
}

export const storageProvider = {
  describeBucket,
  provisionBucket,
  deleteBucket,
  listObjects,
  generatePresignedUrl,
  isStorageConfigured,
};
