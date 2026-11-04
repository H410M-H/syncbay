/**
 * Verifies Syncbay's R2 object storage integration.
 *
 * REAL (when TEST_S3_ENDPOINT / TEST_S3_ACCESS_KEY_ID / TEST_S3_SECRET_ACCESS_KEY are set):
 *   bucket create, presigned PUT upload, object listing, presigned GET download,
 *   signature tampering / expiry rejection, and bucket delete (with purge) against
 *   a live S3-compatible server (e.g. SeaweedFS or MinIO in Docker) via R2_ENDPOINT.
 *   With TEST_DATABASE_URL also the bucket tRPC router end-to-end on real Postgres.
 * MOCKED (always): the Cloudflare R2 bucket API (/accounts/{acct}/r2/buckets) is a
 *   local HTTP server, since api.cloudflare.com is unreachable here.
 * Always: an independent SigV4 recomputation of the presigned URL and the
 *   fail-closed behaviour without keys.
 *
 * Usage: npm run test:r2
 */

import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { S3Client, HeadBucketCommand } from "@aws-sdk/client-s3";
import {
  StorageNotConfiguredError,
  bucketRefFor,
  deleteBucket,
  describeBucket,
  generatePresignedUrl,
  isStorageConfigured,
  listObjects,
  provisionBucket,
  type StorageConfig,
} from "../src/lib/storage-provider";
import { R2ApiClient } from "../src/lib/storage/r2-api";

let passed = 0;
let failed = 0;
let skipped = 0;
function ok(cond: unknown, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ✔ ${msg}`);
  } else {
    failed++;
    console.error(`  ✘ ${msg}`);
  }
}
async function rejects(fn: () => Promise<unknown>, msg: string, check?: (e: any) => boolean) {
  try {
    await fn();
    ok(false, `${msg} (did not throw)`);
  } catch (e) {
    ok(!check || check(e), msg);
  }
}

// ─── Independent SigV4 query-signature check ──────────────────────────────────
function hmac(key: crypto.BinaryLike, data: string) {
  return crypto.createHmac("sha256", key).update(data).digest();
}
function sigv4Encode(s: string) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
function recomputePresignSignature(urlStr: string, method: string, secret: string): { expected: string; actual: string } {
  const url = new URL(urlStr);
  const params = [...url.searchParams.entries()].filter(([k]) => k !== "X-Amz-Signature");
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalQuery = params.map(([k, v]) => `${sigv4Encode(k)}=${sigv4Encode(v)}`).join("&");
  const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders")!;
  if (signedHeaders !== "host") throw new Error(`unexpected signed headers ${signedHeaders}`);
  const canonicalRequest = [method, url.pathname, canonicalQuery, `host:${url.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const amzDate = url.searchParams.get("X-Amz-Date")!;
  const scope = url.searchParams.get("X-Amz-Credential")!.split("/").slice(1).join("/");
  const [date, region, service] = scope.split("/");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, crypto.createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
  const kSigning = hmac(hmac(hmac(hmac("AWS4" + secret, date), region), service), "aws4_request");
  return { expected: crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex"), actual: url.searchParams.get("X-Amz-Signature")! };
}

// ─── Mock Cloudflare R2 bucket API ────────────────────────────────────────────
function startMockCloudflare(token: string, account: string) {
  const buckets = new Set<string>();
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      calls.push(`${req.method} ${req.url}`);
      if (req.headers.authorization !== `Bearer ${token}`) {
        return send(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
      }
      const m = req.url!.match(/^\/client\/v4\/accounts\/([^/]+)\/r2\/buckets(?:\/([^/?]+))?$/);
      if (!m || m[1] !== account) return send(404, { success: false, errors: [{ code: 7003, message: "No route" }] });
      const name = m[2] ? decodeURIComponent(m[2]) : null;
      if (req.method === "POST" && !name) {
        const { name: n } = JSON.parse(body || "{}");
        if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(n)) return send(400, { success: false, errors: [{ code: 10005, message: "invalid name" }] });
        if (buckets.has(n)) return send(409, { success: false, errors: [{ code: 10004, message: "bucket already exists" }] });
        buckets.add(n);
        return send(200, { success: true, errors: [], result: { name: n, creation_date: new Date().toISOString() } });
      }
      if (req.method === "DELETE" && name) {
        if (!buckets.delete(name)) return send(404, { success: false, errors: [{ code: 10006, message: "bucket not found" }] });
        return send(200, { success: true, errors: [], result: {} });
      }
      return send(405, { success: false, errors: [{ code: 7001, message: "method not allowed" }] });
    });
  });
  return new Promise<{ base: string; calls: string[]; buckets: Set<string>; close: () => void }>((resolve) => {
    server.listen(Number(process.env.TEST_CF_MOCK_PORT || 44120), "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ base: `http://127.0.0.1:${port}/client/v4`, calls, buckets, close: () => server.close() });
    });
  });
}

async function main() {
  const suffix = crypto.randomBytes(3).toString("hex");

  console.log("\n[1] Bucket naming and description (pure)");
  const ref = bucketRefFor("MY Super Bucket!!", "proj_abc123");
  ok(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(ref), `bucket ref is R2-valid (${ref})`);
  ok(bucketRefFor("x".repeat(200), "p").length <= 63, "bucket ref is capped at 63 chars");
  const desc = describeBucket({ name: "assets", projectId: "proj_1" }, { accountId: "acct123" });
  ok(desc.endpoint === "https://acct123.r2.cloudflarestorage.com", "endpoint is https://<acct>.r2.cloudflarestorage.com");
  ok(desc.publicUrl === null && !("secretAccessKey" in desc), "no fabricated public URL or credentials");
  ok(describeBucket({ name: "a", projectId: "p" }, { accountId: "acct", endpointOverride: "http://127.0.0.1:9000/" }).endpoint === "http://127.0.0.1:9000", "R2_ENDPOINT overrides the endpoint");

  console.log("\n[2] Fail closed without R2 keys");
  const prevEnv = process.env.NODE_ENV;
  (process.env as any).NODE_ENV = "production";
  const empty: StorageConfig = { accountId: "acct123" };
  ok(!isStorageConfigured({ config: empty }), "isStorageConfigured() is false without keys");
  await rejects(() => generatePresignedUrl({ bucketName: "b", key: "k", operation: "get" }, undefined, undefined, 3600, { config: empty }), "presign throws StorageNotConfiguredError in production without keys", (e) => e instanceof StorageNotConfiguredError);
  await rejects(() => provisionBucket({ name: "b", projectId: "p" }, { config: empty }), "provisionBucket throws without credentials", (e) => e instanceof StorageNotConfiguredError);
  await rejects(() => listObjects("b", {}, { config: empty }), "listObjects throws without credentials", (e) => e instanceof StorageNotConfiguredError);
  (process.env as any).NODE_ENV = prevEnv;

  console.log("\n[3] SigV4 presigned URL maths (independent recomputation)");
  const sigCfg: StorageConfig = { accountId: "acct123", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
  for (const op of ["get", "put"] as const) {
    const url = await generatePresignedUrl({ bucketName: "my-bucket", key: "docs/my photo & info.pdf", operation: op, expiresInSeconds: 900 }, undefined, undefined, 3600, { config: sigCfg });
    const u = new URL(url);
    ok(u.host === "acct123.r2.cloudflarestorage.com" && u.pathname === "/my-bucket/docs/my%20photo%20%26%20info.pdf", `${op}: path-style R2 URL with encoded key`);
    ok(u.searchParams.get("X-Amz-Credential")!.startsWith("AKIDEXAMPLE/") && u.searchParams.get("X-Amz-Credential")!.endsWith("/auto/s3/aws4_request"), `${op}: credential scope uses the configured key, region auto`);
    ok(!u.searchParams.has("x-amz-checksum-crc32") && !u.searchParams.has("x-amz-sdk-checksum-algorithm"), `${op}: no checksum params R2 would reject`);
    const { expected, actual } = recomputePresignSignature(url, op === "put" ? "PUT" : "GET", sigCfg.secretAccessKey!);
    ok(expected === actual, `${op}: signature matches an independent SigV4 computation`);
  }
  await rejects(() => generatePresignedUrl({ bucketName: "b", key: "", operation: "put" }, undefined, undefined, 3600, { config: sigCfg }), "empty object key is rejected");

  console.log("\n[4] Cloudflare R2 bucket API (MOCKED local HTTP server)");
  const cf = await startMockCloudflare("cf-test-token", "acct123");
  try {
    const stubS3 = { send: async () => ({ Contents: [], IsTruncated: false }) } as unknown as S3Client;
    const api = new R2ApiClient({ accountId: "acct123", apiToken: "cf-test-token", baseUrl: cf.base });
    const deps = { config: sigCfg, r2Api: api, s3: stubS3 };
    const created = await provisionBucket({ name: `cf-${suffix}`, projectId: "proj_cf0001" }, deps);
    ok(created.provisionedVia === "cloudflare-api", "bucket created through the Cloudflare API");
    ok(cf.calls.includes("POST /client/v4/accounts/acct123/r2/buckets") && cf.buckets.has(created.r2BucketRef), "POST /accounts/{acct}/r2/buckets with the bucket name");
    const again = await provisionBucket({ name: `cf-${suffix}`, projectId: "proj_cf0001" }, deps);
    ok(again.r2BucketRef === created.r2BucketRef, "409 already-exists is adopted (idempotent create)");
    await deleteBucket(created.r2BucketRef, deps);
    ok(cf.calls.includes(`DELETE /client/v4/accounts/acct123/r2/buckets/${created.r2BucketRef}`) && !cf.buckets.has(created.r2BucketRef), "DELETE /accounts/{acct}/r2/buckets/{name} removes the bucket");
    await deleteBucket(created.r2BucketRef, deps);
    ok(true, "deleting an already-deleted bucket is a no-op (404 tolerated)");
    const badApi = new R2ApiClient({ accountId: "acct123", apiToken: "wrong", baseUrl: cf.base });
    await rejects(() => provisionBucket({ name: "x", projectId: "p" }, { ...deps, r2Api: badApi }), "a bad API token surfaces the Cloudflare error", (e) => /Authentication error/.test(e.message));
  } finally {
    cf.close();
  }

  console.log("\n[5] Live S3-compatible server (REAL)");
  const endpoint = process.env.TEST_S3_ENDPOINT;
  const accessKeyId = process.env.TEST_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.TEST_S3_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    skipped++;
    console.log("  - SKIPPED: set TEST_S3_ENDPOINT, TEST_S3_ACCESS_KEY_ID, TEST_S3_SECRET_ACCESS_KEY");
  } else {
    const realCfg: StorageConfig = { endpointOverride: endpoint, accessKeyId, secretAccessKey };
    const deps = { config: realCfg };
    const bucket = await provisionBucket({ name: `real-${suffix}`, projectId: "proj_real01" }, deps);
    ok(bucket.provisionedVia === "s3-api", `bucket ${bucket.r2BucketRef} created on ${endpoint}`);

    const body = `hello from syncbay ${suffix}`;
    const putUrl = await generatePresignedUrl({ bucketName: bucket.r2BucketRef, key: "uploads/hello world.txt", operation: "put", expiresInSeconds: 300 }, undefined, undefined, 3600, deps);
    const putRes = await fetch(putUrl, { method: "PUT", body });
    ok(putRes.status === 200, `presigned PUT upload accepted by the server (HTTP ${putRes.status})`);

    const listed = await listObjects(bucket.r2BucketRef, {}, deps);
    const obj = listed.objects.find((o) => o.key === "uploads/hello world.txt");
    ok(!!obj && obj.size === Buffer.byteLength(body), "listObjects returns the uploaded object with its real size");
    ok((await listObjects(bucket.r2BucketRef, { prefix: "nope/" }, deps)).objects.length === 0, "prefix filter is applied server-side");

    const getUrl = await generatePresignedUrl(bucket.r2BucketRef, "uploads/hello world.txt", "get", 300, deps);
    const getRes = await fetch(getUrl);
    ok(getRes.status === 200 && (await getRes.text()) === body, "presigned GET downloads the exact bytes");

    const tampered = new URL(getUrl);
    const sig = tampered.searchParams.get("X-Amz-Signature")!;
    tampered.searchParams.set("X-Amz-Signature", (sig[0] === "a" ? "b" : "a") + sig.slice(1));
    ok((await fetch(tampered)).status === 403, "tampered signature is rejected (403)");

    const otherKey = new URL(getUrl);
    otherKey.pathname = otherKey.pathname.replace("hello%20world.txt", "other.txt");
    ok((await fetch(otherKey)).status === 403, "signature is bound to the object key (403 for another key)");

    const forged = await generatePresignedUrl(bucket.r2BucketRef, "uploads/hello world.txt", "get", 300, { config: { ...realCfg, secretAccessKey: "not-the-real-secret" } });
    ok((await fetch(forged)).status === 403, "URL signed with a wrong secret is rejected (403)");

    const shortUrl = await generatePresignedUrl(bucket.r2BucketRef, "uploads/hello world.txt", "get", 1, deps);
    await new Promise((r) => setTimeout(r, 2500));
    ok((await fetch(shortUrl)).status === 403, "expired presigned URL is rejected (403)");

    const del = await deleteBucket(bucket.r2BucketRef, deps);
    ok(del.objectsRemoved === 1, "delete purges the bucket's objects first");
    const s3 = new S3Client({ region: "auto", endpoint, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
    await rejects(() => s3.send(new HeadBucketCommand({ Bucket: bucket.r2BucketRef })), "bucket no longer exists on the server after delete");
    await deleteBucket(bucket.r2BucketRef, deps);
    ok(true, "deleting a missing bucket is idempotent");

    await verifyRouter(endpoint, accessKeyId, secretAccessKey, suffix, s3);
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed > 0 ? 1 : 0);
}

/** bucket tRPC router against real Postgres + the live S3 server. */
async function verifyRouter(endpoint: string, accessKeyId: string, secretAccessKey: string, suffix: string, s3: S3Client) {
  const dbUrl = process.env.TEST_DATABASE_URL;
  console.log("\n[6] bucket router on real Postgres + live S3 (REAL)");
  if (!dbUrl) {
    skipped++;
    console.log("  - SKIPPED: set TEST_DATABASE_URL");
    return;
  }
  process.env.DATABASE_URL = dbUrl;
  process.env.R2_ENDPOINT = endpoint;
  process.env.R2_ACCESS_KEY_ID = accessKeyId;
  process.env.R2_SECRET_ACCESS_KEY = secretAccessKey;
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  (globalThis as any).prisma = prisma;
  const { bucketRouter } = await import("../src/server/routers/bucket");

  const user = await prisma.user.create({ data: { email: `r2-${suffix}@syncbay.test`, name: "R2 Tester" } });
  const ws = await prisma.workspace.create({ data: { name: "R2 WS", slug: `r2-${suffix}`, members: { create: { userId: user.id, role: "OWNER" } } } });
  const project = await prisma.project.create({ data: { workspaceId: ws.id, name: "R2 Project" } });
  const outsider = await prisma.user.create({ data: { email: `r2-out-${suffix}@syncbay.test` } });
  const ctx = (uid: string) => ({ db: prisma, session: { user: { id: uid }, expires: new Date(Date.now() + 3600_000).toISOString() }, headers: new Headers() }) as any;
  const caller = bucketRouter.createCaller(ctx(user.id));
  try {
    const created = await caller.create({ projectId: project.id, name: "media" });
    ok(!!(await s3.send(new HeadBucketCommand({ Bucket: created.r2BucketRef }))), "bucket.create creates the real bucket");
    const put = await caller.generatePresignedUrl({ bucketId: created.id, key: "a.txt", operation: "put" });
    ok((await fetch(put.url, { method: "PUT", body: "abc" })).status === 200, "router presigned PUT works");
    const objs = await caller.listObjects({ bucketId: created.id });
    ok(objs.objects.length === 1 && objs.objects[0].key === "a.txt", "bucket.listObjects lists real objects");
    await rejects(() => bucketRouter.createCaller(ctx(outsider.id)).listObjects({ bucketId: created.id }), "outsider cannot list objects", (e) => e.code === "NOT_FOUND");
    const del = await caller.delete({ bucketId: created.id });
    ok(del.remoteDeleted && del.objectsRemoved === 1, "bucket.delete removes the real bucket and its objects");
    await rejects(() => s3.send(new HeadBucketCommand({ Bucket: created.r2BucketRef })), "bucket is gone on the server");
    ok((await prisma.bucket.count({ where: { id: created.id } })) === 0, "bucket row deleted");

    // Fail closed in production: without keys the row must survive a delete attempt.
    const row = await prisma.bucket.create({ data: { projectId: project.id, name: "orphan", r2BucketRef: `sb-orphan-${suffix}` } });
    const saved = { k: process.env.R2_ACCESS_KEY_ID, n: process.env.NODE_ENV };
    delete process.env.R2_ACCESS_KEY_ID;
    (process.env as any).NODE_ENV = "production";
    await rejects(() => caller.delete({ bucketId: row.id }), "production delete without R2 keys fails closed", (e) => e.code === "PRECONDITION_FAILED");
    ok((await prisma.bucket.count({ where: { id: row.id } })) === 1, "bucket row is kept when the remote delete cannot run");
    await rejects(() => caller.create({ projectId: project.id, name: "nokeys" }), "create without R2 keys is refused", (e) => e.code === "PRECONDITION_FAILED");
    process.env.R2_ACCESS_KEY_ID = saved.k;
    (process.env as any).NODE_ENV = saved.n;
  } finally {
    await prisma.project.deleteMany({ where: { workspaceId: ws.id } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: ws.id } });
    await prisma.workspace.delete({ where: { id: ws.id } });
    await prisma.user.deleteMany({ where: { id: { in: [user.id, outsider.id] } } });
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
