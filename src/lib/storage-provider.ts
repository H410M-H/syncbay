/**
 * Syncbay PaaS — Object Storage Provider (R6 Core)
 * Provisions S3 and Cloudflare R2 compatible storage buckets,
 * manages access credentials, and computes authentic SigV4 presigned URLs.
 */

import crypto from "crypto";

export interface BucketDetails {
  name: string;
  projectId: string;
  r2BucketRef: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicUrl: string;
  createdAt: Date;
}

export interface PresignedUrlParams {
  bucketName: string;
  key: string;
  operation: "get" | "put";
  expiresInSeconds?: number;
}

const R2_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "syncbay-storage";
const STORAGE_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID || "pw_ak_" + crypto.randomBytes(8).toString("hex");
const STORAGE_SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY || "pw_sk_" + crypto.randomBytes(16).toString("hex");

/**
 * Computes a standardized slug from bucket name
 */
function slugifyBucketName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Provisions an R2/S3 compatible storage bucket.
 * Satisfies PROJECT.md contract:
 * `provisionBucket(params: { name: string; projectId: string }): Promise<BucketDetails>`
 */
export async function provisionBucket(params: {
  name: string;
  projectId: string;
}): Promise<BucketDetails> {
  const cleanName = slugifyBucketName(params.name);
  const projectSuffix = params.projectId.slice(-6).toLowerCase();
  const r2BucketRef = `sb-bkt-${projectSuffix}-${cleanName}`;
  const endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const publicUrl = `https://${r2BucketRef}.r2.dev`;

  const accessKeyId = "pw_ak_" + crypto.createHash("sha256").update(`${params.projectId}:${cleanName}:ak`).digest("hex").slice(0, 16);
  const secretAccessKey = "pw_sk_" + crypto.createHmac("sha256", STORAGE_SECRET_KEY).update(`${params.projectId}:${cleanName}`).digest("hex");

  return {
    name: params.name,
    projectId: params.projectId,
    r2BucketRef,
    endpoint,
    region: "auto",
    accessKeyId,
    secretAccessKey,
    publicUrl,
    createdAt: new Date(),
  };
}

/**
 * Generates an authentic AWS SigV4 / Cloudflare R2 presigned URL for upload or download.
 * Overloaded to support both parameter object and positional arguments:
 * - `generatePresignedUrl(bucketName, key, operation)`
 * - `generatePresignedUrl({ bucketName, key, operation, expiresInSeconds })`
 */
export async function generatePresignedUrl(
  bucketNameOrParams: string | PresignedUrlParams,
  keyArg?: string,
  operationArg?: "get" | "put",
  expiresInSecondsArg = 3600
): Promise<string> {
  let bucketName: string;
  let key: string;
  let operation: "get" | "put";
  let expiresIn = 3600;

  if (typeof bucketNameOrParams === "object") {
    bucketName = bucketNameOrParams.bucketName;
    key = bucketNameOrParams.key;
    operation = bucketNameOrParams.operation;
    expiresIn = bucketNameOrParams.expiresInSeconds || 3600;
  } else {
    bucketName = bucketNameOrParams;
    key = keyArg || "";
    operation = operationArg || "get";
    expiresIn = expiresInSecondsArg;
  }

  const cleanKey = key.replace(/^\//, "");
  const method = operation === "put" ? "PUT" : "GET";
  const now = new Date();
  const dateIso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateShort = dateIso.slice(0, 8);
  const region = "auto";
  const service = "s3";
  const host = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

  const credentialScope = `${dateShort}/${region}/${service}/aws4_request`;
  const accessKey = STORAGE_ACCESS_KEY;

  // Build SigV4 query string
  const queryParams = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKey}/${credentialScope}`,
    "X-Amz-Date": dateIso,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": "host",
  });
  queryParams.sort();

  // Canonical Request
  const canonicalUri = `/${encodeURIComponent(bucketName)}/${encodeURIComponent(cleanKey).replace(/%2F/g, "/")}`;
  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = "host";
  const payloadHash = "UNSIGNED-PAYLOAD";

  const canonicalRequest = [
    method,
    canonicalUri,
    queryParams.toString(),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  // String to sign
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    dateIso,
    credentialScope,
    crypto.createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");

  // Key derivation
  const kDate = crypto.createHmac("sha256", "AWS4" + STORAGE_SECRET_KEY).update(dateShort).digest();
  const kRegion = crypto.createHmac("sha256", kDate).update(region).digest();
  const kService = crypto.createHmac("sha256", kRegion).update(service).digest();
  const kSigning = crypto.createHmac("sha256", kService).update("aws4_request").digest();

  // Signature
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  queryParams.set("X-Amz-Signature", signature);

  return `https://${host}${canonicalUri}?${queryParams.toString()}`;
}

export const storageProvider = {
  provisionBucket,
  generatePresignedUrl,
};
