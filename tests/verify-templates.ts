/**
 * Verification: one-click templates — catalog, syncbay.json manifest, create-from-template.
 *
 * Part A (pure): templates/index.json through the zod loader, manifest parsing and env resolution,
 * source parsing, manifest fetching (GitHub answered by an in-process fetch stub: the template
 * repositories are not reachable from CI sandboxes).
 *
 * Part B (real): Postgres (DATABASE_URL, migrated), the real tRPC routers, one runner daemon
 * (`runner/src/index.ts`, port 47200, RUNNER_DB_MODE=docker, database ports 47210-47299) that
 * provisions REAL Docker databases: pgvector/pgvector:pg16 (+ CREATE EXTENSION vector),
 * redis:7-alpine and valkey/valkey:8-alpine. Only GitHub (api.github.com /
 * raw.githubusercontent.com) is stubbed.
 *
 *  1. template.preview: manifest view, secret defaults withheld, absent / invalid manifests.
 *  2. template.provision refuses a missing required variable before writing anything; viewers
 *     and other workspaces get NOT_FOUND.
 *  3. provision: service (port + health path from the manifest), variables (generated 64-hex
 *     secret, typed secret, default), databases ACTIVE (pgvector really installed), injected
 *     DATABASE_URL / REDIS_URL and the manifest's own CACHE_URL key.
 *  4. A retry reuses the service, databases and generated secret.
 *  5. database.create (shared creation path) still provisions and injects.
 *
 * Usage: DATABASE_URL=postgresql://… npm run test:templates   (needs Docker + the images above)
 */

import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const ROOT = path.resolve(__dirname, "..");
const RUNNER_PORT = 47200;
const DB_PORT_RANGE = "47210-47299";
const SECRET = crypto.randomBytes(24).toString("hex");
const RUN = crypto.randomBytes(3).toString("hex");
const env = process.env as Record<string, string | undefined>;

let passed = 0;
const ok = (msg: string) => {
  passed += 1;
  console.log(`  ✔ ${msg}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 45000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(250);
  }
}

async function rejects(fn: () => Promise<unknown>, check: (e: any) => boolean, label: string): Promise<any> {
  try {
    await fn();
  } catch (e: any) {
    assert.ok(check(e), `${label}: unexpected error ${e?.code} ${e?.message}`);
    return e;
  }
  throw new Error(`${label}: expected a rejection`);
}

// ─── GitHub stub ───────────────────────────────────────────────────────────────
/** repo full name → { branch, manifest body (string) | null (404) } */
const fakeRepos = new Map<string, { branch: string; manifest: string | null }>();
const githubCalls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== "api.github.com" && url.hostname !== "raw.githubusercontent.com") return realFetch(input, init);
  githubCalls.push(url.href);
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.hostname === "api.github.com") {
    // /repos/:owner/:repo[/contents/syncbay.json]
    const repo = fakeRepos.get(`${parts[1]}/${parts[2]}`);
    if (!repo) return new Response("{}", { status: 404 });
    if (parts.length === 3) return Response.json({ default_branch: repo.branch });
    if (repo.manifest === null) return new Response("{}", { status: 404 });
    return new Response(repo.manifest, { status: 200 });
  }
  // raw: /:owner/:repo/:branch/syncbay.json
  const repo = fakeRepos.get(`${parts[0]}/${parts[1]}`);
  if (!repo || parts[2] !== repo.branch || repo.manifest === null) return new Response("404: Not Found", { status: 404 });
  return new Response(repo.manifest, { status: 200 });
}) as typeof fetch;

const STANDARDS_EXAMPLE = {
  $schema: "https://syncbay.app/schemas/syncbay.v1.json",
  name: "Next.js & PostgreSQL",
  slug: "nextjs-postgres",
  description: "One line.",
  port: 3000,
  healthcheckPath: "/health",
  services: [
    { type: "postgres", env: "DATABASE_URL" },
    { type: "redis", env: "REDIS_URL" },
  ],
  env: [
    { key: "AUTH_SECRET", description: "Session signing key", generate: "secret" },
    { key: "OPENAI_API_KEY", description: "LLM API key", required: true, secret: true },
    { key: "BRAND_NAME", description: "Name shown in the header", default: "Syncbay" },
  ],
};

async function partA() {
  const catalog = await import("../src/lib/templates/catalog");
  const m = await import("../src/lib/templates/manifest");

  console.log("\n[A1] Catalog");
  const all = catalog.listTemplates();
  assert.strictEqual(all.length, 9);
  assert.deepStrictEqual(
    all.map((t) => t.slug),
    ["nextjs-postgres", "fastapi-redis", "fastapi-ai-agent-hub", "go-fiber", "go-gin-grpc", "rust-axum", "node-websockets", "django-celery", "postgres-valkey"]
  );
  for (const t of all) {
    assert.strictEqual(t.repo, `MSNS-DEV/syncbay-template-${t.slug}`);
    assert.strictEqual(t.repoUrl, `https://github.com/MSNS-DEV/syncbay-template-${t.slug}`);
    assert.strictEqual(t.deployUrl, `https://syncbay.app/new?template=MSNS-DEV/syncbay-template-${t.slug}`);
    assert.ok(catalog.TEMPLATE_REPO_PATTERN.test(t.repo));
    assert.deepStrictEqual(t.metrics, { imageSizeMB: null, idleMemMB: null, coldStartMs: null });
    assert.ok(!/\b\d+(\.\d+)?\s*(ms|k|req|requests)\b|0ms|stars/i.test(t.description), `no performance claim in ${t.slug}`);
    assert.deepStrictEqual(catalog.formatTemplateMetrics(t.metrics), []);
  }
  ok("9 templates, MSNS-DEV repos, deploy URLs, unmeasured metrics are null and render nothing");

  assert.strictEqual(catalog.templateBySlug("rust-axum")?.port, 8080);
  assert.strictEqual(catalog.templateBySlug("nope"), undefined);
  assert.strictEqual(catalog.templateByRepo("msns-dev/SYNCBAY-TEMPLATE-GO-FIBER")?.slug, "go-fiber");
  assert.deepStrictEqual(catalog.templateBySlug("postgres-valkey")?.services, [{ type: "postgres", extensions: ["vector"] }, { type: "valkey" }]);
  assert.deepStrictEqual(catalog.templateBySlug("fastapi-ai-agent-hub")?.services, [{ type: "postgres", extensions: ["vector"] }]);
  assert.deepStrictEqual(
    catalog.listTemplates("data").map((t) => t.slug),
    ["django-celery", "postgres-valkey"]
  );
  assert.strictEqual(catalog.templateDeployHref(all[0]), "/new?template=MSNS-DEV/syncbay-template-nextjs-postgres");
  assert.deepStrictEqual(catalog.formatTemplateMetrics({ imageSizeMB: 41.2, idleMemMB: null, coldStartMs: 1250 }), [
    { label: "Image size", value: "41.2 MB" },
    { label: "Cold start", value: "1.3 s" },
  ]);
  ok("bySlug / byRepo (case-insensitive) / category filter / metric formatting");

  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "templates/index.json"), "utf8"));
  assert.throws(() => catalog.parseTemplateCatalog({ ...raw, templates: [...raw.templates, raw.templates[0]] }), /Duplicate template slug/);
  assert.throws(() => catalog.parseTemplateCatalog({ ...raw, templates: [{ ...raw.templates[0], repoUrl: "https://github.com/syncbay/x" }] }), /repoUrl/);
  assert.throws(() => catalog.parseTemplateCatalog({ ...raw, templates: [{ ...raw.templates[0], category: "EDGE" }] }));
  assert.throws(() => catalog.parseTemplateCatalog({ ...raw, templates: [{ ...raw.templates[0], metrics: { imageSizeMB: -1, idleMemMB: null, coldStartMs: null } }] }));
  ok("catalog loader rejects duplicate slugs, mismatched repoUrl, unknown categories, bad metrics");

  console.log("\n[A2] syncbay.json parsing");
  const parsed = m.parseTemplateManifest(JSON.stringify({ ...STANDARDS_EXAMPLE, futureKey: { anything: true } }));
  assert.strictEqual(parsed.port, 3000);
  assert.strictEqual(parsed.healthcheckPath, "/health");
  assert.deepStrictEqual(parsed.services, [
    { type: "postgres", env: "DATABASE_URL" },
    { type: "redis", env: "REDIS_URL" },
  ]);
  assert.strictEqual(parsed.env.length, 3);
  assert.ok(!("futureKey" in parsed));
  ok("STANDARDS.md example parses; unknown keys are ignored");

  const defaults = m.parseTemplateManifest({ services: [{ type: "postgres", extensions: ["vector"] }, { type: "valkey" }] });
  assert.deepStrictEqual(defaults.services, [
    { type: "postgres", extensions: ["vector"], env: "DATABASE_URL" },
    { type: "valkey", env: "REDIS_URL" },
  ]);
  assert.deepStrictEqual(defaults.env, []);
  ok("service env keys default to DATABASE_URL / REDIS_URL; pgvector extension accepted");

  const bad: [unknown, RegExp][] = [
    ["{not json", /not valid JSON/],
    [[], /must be a JSON object/],
    [{ services: [{ type: "mongo" }] }, /services\.0\.type/],
    [{ services: [{ type: "redis", extensions: ["vector"] }] }, /only supported on postgres/],
    [{ services: [{ type: "postgres", extensions: ["postgis"] }] }, /extensions/],
    [{ services: [{ type: "postgres" }, { type: "postgres" }] }, /two services write DATABASE_URL/],
    [{ env: [{ key: "A" }, { key: "A" }] }, /listed twice/],
    [{ env: [{ key: "bad-key" }] }, /valid environment variable name/],
    [{ env: [{ key: "DATABASE_URL" }], services: [{ type: "postgres" }] }, /both a service URL and an env entry/],
    [{ env: [{ key: "X", generate: "uuid" }] }, /generate/],
    [{ port: 0 }, /port/],
    [{ healthcheckPath: "health" }, /absolute path/],
    [{ healthcheckPath: "/x?y=$(id)" }, /absolute path/],
    ["x".repeat(m.MANIFEST_MAX_BYTES + 1), /larger than/],
  ];
  for (const [input, re] of bad) {
    assert.throws(() => m.parseTemplateManifest(input), (e: any) => e instanceof m.ManifestError && re.test(e.message), String(re));
  }
  ok(`${bad.length} invalid manifests rejected with a clear ManifestError (size cap, schema, duplicates)`);

  const resolved = m.resolveTemplateEnv(parsed, { OPENAI_API_KEY: "sk-test", UNDECLARED: "x" });
  assert.deepStrictEqual(resolved.missing, []);
  const byKey = Object.fromEntries(resolved.variables.map((v) => [v.key, v]));
  assert.match(byKey.AUTH_SECRET.value, /^[0-9a-f]{64}$/);
  assert.deepStrictEqual([byKey.AUTH_SECRET.isSecret, byKey.AUTH_SECRET.generated], [true, true]);
  assert.deepStrictEqual(byKey.OPENAI_API_KEY, { key: "OPENAI_API_KEY", value: "sk-test", isSecret: true, generated: false });
  assert.deepStrictEqual(byKey.BRAND_NAME, { key: "BRAND_NAME", value: "Syncbay", isSecret: false, generated: false });
  assert.ok(!("UNDECLARED" in byKey));
  const again = m.resolveTemplateEnv(parsed, { OPENAI_API_KEY: "sk-test" });
  assert.notStrictEqual(again.variables[0].value, byKey.AUTH_SECRET.value);
  assert.deepStrictEqual(m.resolveTemplateEnv(parsed, {}).missing, ["OPENAI_API_KEY"]);
  assert.deepStrictEqual(m.resolveTemplateEnv(parsed, { OPENAI_API_KEY: "" }).missing, ["OPENAI_API_KEY"]);
  const typed = m.resolveTemplateEnv(parsed, { OPENAI_API_KEY: "k", AUTH_SECRET: "mine", BRAND_NAME: "Acme" }).variables;
  assert.deepStrictEqual(typed.map((v) => v.value), ["mine", "k", "Acme"]);
  ok("env resolution: fresh 32-byte hex secrets, defaults, required → missing, typed values win, undeclared ignored");

  console.log("\n[A3] Sources and fetching");
  assert.deepStrictEqual(m.parseTemplateSource("MSNS-DEV/syncbay-template-go-fiber"), {
    owner: "MSNS-DEV",
    repo: "syncbay-template-go-fiber",
    fullName: "MSNS-DEV/syncbay-template-go-fiber",
    repoUrl: "https://github.com/MSNS-DEV/syncbay-template-go-fiber",
  });
  assert.strictEqual(m.parseTemplateSource("https://github.com/a/b.git")?.fullName, "a/b");
  assert.strictEqual(m.parseTemplateSource("https://github.com/a/b/tree/main/x")?.fullName, "a/b");
  for (const badSource of ["a", "a/b/c", "../etc", "a/..", "a b/c", "https://gitlab.com/a/b", "a/b;rm", "a_b/c"]) {
    assert.strictEqual(m.parseTemplateSource(badSource), null, badSource);
  }
  ok("owner/repo and github.com URLs accepted; traversal, other hosts and odd characters refused");

  fakeRepos.set("acme/found", { branch: "trunk", manifest: JSON.stringify(STANDARDS_EXAMPLE) });
  fakeRepos.set("acme/absent", { branch: "main", manifest: null });
  fakeRepos.set("acme/broken", { branch: "main", manifest: '{"port": "eighty"}' });
  fakeRepos.set("acme/huge", { branch: "main", manifest: JSON.stringify({ description: "x".repeat(40_000) }) });
  const src = (n: string) => m.parseTemplateSource(`acme/${n}`)!;
  const found = await m.fetchTemplateManifest(src("found"));
  assert.ok(found.status === "found" && found.defaultBranch === "trunk" && found.manifest.port === 3000);
  assert.ok(githubCalls.includes("https://raw.githubusercontent.com/acme/found/trunk/syncbay.json"));
  assert.deepStrictEqual(await m.fetchTemplateManifest(src("absent")), { status: "absent", defaultBranch: "main" });
  const broken = await m.fetchTemplateManifest(src("broken"));
  assert.ok(broken.status === "invalid" && /port/.test(broken.error));
  const huge = await m.fetchTemplateManifest(src("huge"));
  assert.ok(huge.status === "invalid" && /larger than/.test(huge.error));
  githubCalls.length = 0;
  const withToken = await m.fetchTemplateManifest(src("found"), { token: "ghp_test" });
  assert.strictEqual(withToken.status, "found");
  assert.ok(githubCalls.includes("https://api.github.com/repos/acme/found/contents/syncbay.json?ref=trunk"));
  ok("fetch: default branch from the API, raw file without a token, contents API with one; absent / invalid / oversize reported");
}

function startRunner(workDir: string): ChildProcess {
  const child = spawn(process.execPath, [path.join(ROOT, "node_modules/tsx/dist/cli.mjs"), path.join(ROOT, "runner/src/index.ts")], {
    cwd: workDir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "development",
      RUNNER_PORT: String(RUNNER_PORT),
      RUNNER_HOST: "127.0.0.1",
      RUNNER_SECRET: SECRET,
      RUNNER_STATE_DIR: path.join(workDir, ".state"),
      RUNNER_DB_MODE: "docker",
      RUNNER_DB_HOST: "127.0.0.1",
      RUNNER_DB_PORT_RANGE: DB_PORT_RANGE,
      SYNCBAY_API_URL: "http://127.0.0.1:47299",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (c) => process.env.DEBUG_RUNNER && process.stdout.write(`[runner] ${c}`));
  child.stderr?.on("data", (c) => process.env.DEBUG_RUNNER && process.stderr.write(`[runner] ${c}`));
  return child;
}

const containerImage = (dbId: string) =>
  spawnSync("docker", ["inspect", "-f", "{{.Config.Image}}", `syncbay-db-${dbId.toLowerCase()}`], { encoding: "utf8" }).stdout.trim();

async function partB() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required (real Postgres)");
  if (spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"]).status !== 0) throw new Error("Docker is required");
  for (const k of ["GITHUB_TOKEN", "GITHUB_PAT", "GITHUB_ACCESS_TOKEN", "RUNNER_QUEUE_MODE", "RUNNER_WEBHOOK_SECRET", "SYNCBAY_WEBHOOK_SECRET", "UPSTASH_REDIS_REST_URL", "VERCEL", "RUNNER_FORCE_LOCAL"]) {
    delete env[k];
  }
  Object.assign(env, {
    NODE_ENV: "development",
    RUNNER_URL: `http://127.0.0.1:${RUNNER_PORT}`,
    RUNNER_DRIVER: "webhook",
    RUNNER_SECRET: SECRET,
    RUNNER_FALLBACK_LOCAL: "false",
  });

  const prisma = new PrismaClient();
  (globalThis as any).prisma = prisma;
  const { appRouter } = await import("../src/server/root");
  const { ErrorDetails } = await import("../src/server/error-details");
  const { destroyManagedDatabase } = await import("../src/lib/database-provider");
  const { Client } = await import("pg");

  const users = await Promise.all(["owner", "viewer", "stranger"].map((r) => prisma.user.create({ data: { email: `tpl-${r}-${RUN}@test.syncbay.app`, name: r } })));
  const [owner, viewer, stranger] = users;
  const workspace = await prisma.workspace.create({
    data: { name: `tpl-${RUN}`, slug: `tpl-${RUN}`, members: { create: [{ userId: owner.id, role: "OWNER" }, { userId: viewer.id, role: "VIEWER" }] } },
  });
  const other = await prisma.workspace.create({ data: { name: `tpl-o-${RUN}`, slug: `tpl-o-${RUN}`, members: { create: [{ userId: stranger.id, role: "OWNER" }] } } });
  const ctx = (userId: string) => ({ db: prisma, session: { user: { id: userId }, expires: "2099-01-01" }, headers: new Headers() });
  const asOwner = appRouter.createCaller(ctx(owner.id) as any);
  const asViewer = appRouter.createCaller(ctx(viewer.id) as any);
  const asStranger = appRouter.createCaller(ctx(stranger.id) as any);

  const TEMPLATE = `MSNS-DEV/syncbay-template-tpl${RUN}`;
  fakeRepos.set(TEMPLATE, {
    branch: "main",
    manifest: JSON.stringify({
      name: "Template test",
      port: 8000,
      healthcheckPath: "/healthz",
      services: [{ type: "postgres", extensions: ["vector"] }, { type: "redis" }, { type: "valkey", env: "CACHE_URL" }],
      env: [
        { key: "AUTH_SECRET", description: "Session signing key", generate: "secret" },
        { key: "OPENAI_API_KEY", description: "LLM API key", required: true, secret: true },
        { key: "WEBHOOK_TOKEN", description: "Shared token", secret: true, default: "do-not-leak-this-default" },
        { key: "BRAND_NAME", default: "Syncbay" },
      ],
    }),
  });
  fakeRepos.set(`MSNS-DEV/plain${RUN}`, { branch: "main", manifest: null });
  // REDIS_URL declared for the second Redis-compatible service: injection alone would bind it to the first.
  fakeRepos.set(`MSNS-DEV/swapped${RUN}`, {
    branch: "main",
    manifest: JSON.stringify({ services: [{ type: "redis", env: "CACHE_URL" }, { type: "valkey", env: "REDIS_URL" }] }),
  });
  fakeRepos.set(`MSNS-DEV/broken${RUN}`, { branch: "main", manifest: '{"services":[{"type":"mongo"}]}' });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-templates-"));
  const runner = startRunner(tmp);
  const dbIds: string[] = [];
  const cleanup = async () => {
    const dbs = await prisma.databaseInstance.findMany({ where: { environment: { project: { workspaceId: workspace.id } } } }).catch(() => []);
    for (const d of dbs) await destroyManagedDatabase(d).catch(() => null);
    for (const id of dbIds) {
      spawnSync("docker", ["rm", "-f", `syncbay-db-${id.toLowerCase()}`]);
      spawnSync("docker", ["volume", "rm", "-f", `syncbay-db-${id.toLowerCase()}-data`]);
    }
    runner.kill("SIGTERM");
    await prisma.environmentVariable.deleteMany({ where: { workspaceId: { in: [workspace.id, other.id] } } }).catch(() => null);
    await prisma.workspace.deleteMany({ where: { id: { in: [workspace.id, other.id] } } }).catch(() => null);
    await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } }).catch(() => null);
    await prisma.$disconnect();
    fs.rmSync(tmp, { recursive: true, force: true });
  };

  try {
    await waitFor("runner /health", async () => (await realFetch(`http://127.0.0.1:${RUNNER_PORT}/health`)).ok, 30000);
    const health = await (await realFetch(`http://127.0.0.1:${RUNNER_PORT}/health`)).json();
    assert.strictEqual(health.version, "1.6.0");

    console.log("\n[B1] template.preview");
    const preview = await asOwner.template.preview({ source: TEMPLATE });
    assert.strictEqual(preview.manifestStatus, "found");
    assert.strictEqual(preview.branch, "main");
    assert.strictEqual(preview.catalog, null);
    assert.deepStrictEqual(preview.manifest?.services, [
      { type: "postgres", env: "DATABASE_URL", extensions: ["vector"] },
      { type: "redis", env: "REDIS_URL", extensions: [] },
      { type: "valkey", env: "CACHE_URL", extensions: [] },
    ]);
    assert.deepStrictEqual([preview.manifest?.port, preview.manifest?.healthcheckPath], [8000, "/healthz"]);
    const envView = Object.fromEntries(preview.manifest!.env.map((e) => [e.key, e]));
    assert.deepStrictEqual([envView.AUTH_SECRET.generated, envView.AUTH_SECRET.secret], [true, true]);
    assert.deepStrictEqual([envView.OPENAI_API_KEY.required, envView.OPENAI_API_KEY.secret], [true, true]);
    assert.strictEqual(envView.WEBHOOK_TOKEN.default, null, "secret defaults are not sent to the browser");
    assert.strictEqual(envView.BRAND_NAME.default, "Syncbay");
    assert.ok(!JSON.stringify(preview).includes("do-not-leak-this-default"));
    const known = await asOwner.template.preview({ source: "https://github.com/MSNS-DEV/syncbay-template-go-fiber" });
    assert.strictEqual(known.catalog?.slug, "go-fiber");
    assert.strictEqual((await asOwner.template.preview({ source: `MSNS-DEV/plain${RUN}` })).manifestStatus, "absent");
    const brokenPreview = await asOwner.template.preview({ source: `MSNS-DEV/broken${RUN}` });
    assert.ok(brokenPreview.manifestStatus === "invalid" && brokenPreview.manifest === null && /services\.0\.type/.test(brokenPreview.manifestError!));
    await rejects(() => asOwner.template.preview({ source: "../../etc/passwd" }), (e) => e.code === "BAD_REQUEST", "bad source");
    ok("manifest view with services, port, health path; secret defaults withheld; catalog match; absent / invalid reported");

    console.log("\n[B2] Refusals before anything is written");
    const project = await asOwner.project.create({ workspaceId: workspace.id, name: `tpl-${RUN}` });
    const environmentId = project.environments[0].id;
    const missing = await rejects(
      () => asOwner.template.provision({ environmentId, source: TEMPLATE, env: { BRAND_NAME: "Acme" } }),
      (e) => e.code === "BAD_REQUEST",
      "missing required"
    );
    assert.match(missing.message, /OPENAI_API_KEY/);
    assert.ok(missing.cause instanceof ErrorDetails && missing.cause.details.missing === "OPENAI_API_KEY");
    const counts = async () => ({
      services: await prisma.service.count({ where: { environmentId } }),
      dbs: await prisma.databaseInstance.count({ where: { environmentId } }),
    });
    assert.deepStrictEqual(await counts(), { services: 0, dbs: 0 });
    ok("missing required variable → BAD_REQUEST with details.missing; no service or database row created");

    await rejects(() => asViewer.template.provision({ environmentId, source: TEMPLATE, env: { OPENAI_API_KEY: "k" } }), (e) => e.code === "NOT_FOUND", "viewer");
    await rejects(() => asStranger.template.provision({ environmentId, source: TEMPLATE, env: { OPENAI_API_KEY: "k" } }), (e) => e.code === "NOT_FOUND", "stranger");
    await rejects(
      () => asOwner.template.provision({ environmentId, source: `MSNS-DEV/broken${RUN}`, env: {} }),
      (e) => e.code === "BAD_REQUEST" && /Invalid syncbay.json/.test(e.message),
      "invalid manifest"
    );
    assert.deepStrictEqual(await counts(), { services: 0, dbs: 0 });
    ok("viewers and other workspaces get NOT_FOUND; an invalid manifest is refused; still nothing written");

    console.log("\n[B3] Provision: service, variables, real databases");
    const started = Date.now();
    const result = await asOwner.template.provision({
      environmentId,
      source: TEMPLATE,
      env: { OPENAI_API_KEY: "sk-live-123", NOT_IN_MANIFEST: "ignored" },
    });
    console.log(`    (provisioned 3 Docker databases in ${((Date.now() - started) / 1000).toFixed(1)} s)`);
    assert.strictEqual(result.reusedService, false);
    const service = await prisma.service.findUniqueOrThrow({ where: { id: result.serviceId }, include: { domains: true } });
    assert.deepStrictEqual(
      [service.name, service.sourceType, service.repoUrl, service.branch, service.port, service.healthCheckUrl],
      ["web", "github", `https://github.com/${TEMPLATE}`, "main", 8000, "/healthz"]
    );
    assert.strictEqual(service.domains.filter((d) => d.isGenerated).length, 1, "platform hostname claimed");
    ok("service: github source, branch, port 8000 and health path /healthz from the manifest, platform host claimed");

    const dbs = await prisma.databaseInstance.findMany({ where: { environmentId }, orderBy: { createdAt: "asc" } });
    dbIds.push(...dbs.map((d) => d.id));
    assert.deepStrictEqual(
      dbs.map((d) => [d.name, d.provider, d.status, d.extensions]),
      [
        ["postgres", "POSTGRES", "ACTIVE", ["vector"]],
        ["redis", "REDIS", "ACTIVE", []],
        ["valkey", "REDIS", "ACTIVE", []],
      ]
    );
    assert.deepStrictEqual(dbs.map((d) => containerImage(d.id)), ["pgvector/pgvector:pg16", "redis:7-alpine", "valkey/valkey:8-alpine"]);
    const [pgDb, redisDb, valkeyDb] = dbs;
    const pg = new Client({ connectionString: pgDb.connectionUrl });
    await pg.connect();
    const ext = await pg.query("SELECT extname FROM pg_extension WHERE extname = 'vector'");
    const dist = await pg.query("SELECT ('[1,1]'::vector <-> '[4,5]'::vector)::int AS d");
    await pg.end();
    assert.deepStrictEqual([ext.rows[0]?.extname, dist.rows[0]?.d], ["vector", 5]);
    ok("databases ACTIVE on real containers (pgvector/pgvector:pg16, redis:7-alpine, valkey/valkey:8-alpine); pgvector installed and usable");

    const vars = await prisma.environmentVariable.findMany({ where: { serviceId: service.id } });
    const v = Object.fromEntries(vars.map((x) => [x.key, x]));
    assert.match(v.AUTH_SECRET.value, /^[0-9a-f]{64}$/);
    assert.strictEqual(v.AUTH_SECRET.isSecret, true);
    assert.deepStrictEqual([v.OPENAI_API_KEY.value, v.OPENAI_API_KEY.isSecret], ["sk-live-123", true]);
    assert.deepStrictEqual([v.WEBHOOK_TOKEN.value, v.WEBHOOK_TOKEN.isSecret], ["do-not-leak-this-default", true]);
    assert.deepStrictEqual([v.BRAND_NAME.value, v.BRAND_NAME.isSecret], ["Syncbay", false]);
    assert.ok(!v.NOT_IN_MANIFEST);
    assert.strictEqual(v.DATABASE_URL.value, pgDb.connectionUrl);
    assert.strictEqual(v.REDIS_URL.value, redisDb.connectionUrl, "the first Redis-compatible service owns REDIS_URL");
    assert.strictEqual(v.CACHE_URL.value, valkeyDb.connectionUrl, "the manifest's own key for the valkey URL");
    assert.ok([v.DATABASE_URL, v.REDIS_URL, v.CACHE_URL].every((x) => x.isSecret));
    const resultVars = Object.fromEntries(result.variables.map((x) => [x.key, x]));
    assert.deepStrictEqual(resultVars.AUTH_SECRET, { key: "AUTH_SECRET", isSecret: true, generated: true, reused: false });
    assert.ok(!JSON.stringify(result).includes("sk-live-123") && !JSON.stringify(result).includes(v.AUTH_SECRET.value), "no values in the response");
    ok("variables: generated 64-hex AUTH_SECRET, typed + default secrets masked, BRAND_NAME default, DATABASE_URL / REDIS_URL injected, CACHE_URL persisted");

    console.log("\n[B4] Retry");
    const retry = await asOwner.template.provision({ environmentId, source: TEMPLATE, env: { OPENAI_API_KEY: "sk-live-123" } });
    assert.strictEqual(retry.serviceId, service.id);
    assert.strictEqual(retry.reusedService, true);
    assert.ok(retry.databases.every((d) => d.reused));
    assert.strictEqual(await prisma.databaseInstance.count({ where: { environmentId } }), 3);
    assert.strictEqual(await prisma.service.count({ where: { environmentId } }), 1);
    const secretAfter = await prisma.environmentVariable.findFirstOrThrow({ where: { serviceId: service.id, key: "AUTH_SECRET" } });
    assert.strictEqual(secretAfter.value, v.AUTH_SECRET.value);
    ok("a retry reuses the service and databases and keeps the generated secret");

    console.log("\n[B5] database.create through the shared path");
    const plain = await asOwner.project.create({ workspaceId: workspace.id, name: `plain-${RUN}` });
    const plainEnv = plain.environments[0].id;
    const plainSvc = await asOwner.template.provision({ environmentId: plainEnv, source: `MSNS-DEV/plain${RUN}`, env: {} });
    assert.deepStrictEqual([plainSvc.databases, plainSvc.variables], [[], []]);
    const plainService = await prisma.service.findUniqueOrThrow({ where: { id: plainSvc.serviceId } });
    assert.deepStrictEqual([plainService.port, plainService.healthCheckUrl], [null, null]);
    const created = await asOwner.database.create({ environmentId: plainEnv, name: "cache", provider: "REDIS" });
    dbIds.push(created.id);
    assert.strictEqual(created.status, "ACTIVE");
    assert.strictEqual(containerImage(created.id), "redis:7-alpine");
    const injected = await prisma.environmentVariable.findMany({ where: { serviceId: plainSvc.serviceId } });
    assert.deepStrictEqual(injected.map((x) => x.key).sort(), ["CACHE_URL", "REDIS_URL"]);
    ok("a repository without syncbay.json becomes a plain service; database.create still provisions and injects");

    console.log("\n[B6] Manifest keys bind to the declared database");
    const swapped = await asOwner.project.create({ workspaceId: workspace.id, name: `swapped-${RUN}` });
    const swappedEnv = swapped.environments[0].id;
    const sw = await asOwner.template.provision({ environmentId: swappedEnv, source: `MSNS-DEV/swapped${RUN}`, env: {} });
    const swDbs = await prisma.databaseInstance.findMany({ where: { environmentId: swappedEnv }, orderBy: { createdAt: "asc" } });
    dbIds.push(...swDbs.map((d) => d.id));
    const [swRedis, swValkey] = swDbs;
    const swVars = Object.fromEntries((await prisma.environmentVariable.findMany({ where: { serviceId: sw.serviceId } })).map((x) => [x.key, x.value]));
    assert.strictEqual(swVars.REDIS_URL, swValkey.connectionUrl, "REDIS_URL is the valkey database the manifest names");
    assert.strictEqual(swVars.CACHE_URL, swRedis.connectionUrl, "CACHE_URL is the redis database");
    const swRetry = await asOwner.template.provision({ environmentId: swappedEnv, source: `MSNS-DEV/swapped${RUN}`, env: {} });
    const swAfter = await prisma.environmentVariable.findFirstOrThrow({ where: { serviceId: swRetry.serviceId, key: "REDIS_URL" } });
    assert.strictEqual(swAfter.value, swValkey.connectionUrl, "stable across a retry");
    // A user who repoints REDIS_URL at the other database keeps that choice across a retry.
    await prisma.environmentVariable.update({ where: { id: swAfter.id }, data: { value: swRedis.connectionUrl } });
    await asOwner.template.provision({ environmentId: swappedEnv, source: `MSNS-DEV/swapped${RUN}`, env: {} });
    const userChoice = await prisma.environmentVariable.findFirstOrThrow({ where: { id: swAfter.id } });
    assert.strictEqual(userChoice.value, swRedis.connectionUrl, "a retry keeps the user's edit");
    ok("a manifest mapping REDIS_URL to its second Redis-compatible service gets that database; a retry keeps it and keeps a user's later edit");
  } finally {
    await cleanup();
  }
}

async function main() {
  await partA();
  if (process.argv.includes("--unit")) {
    console.log(`\n${passed} checks passed (unit only)`);
    return;
  }
  await partB();
  console.log(`\n${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
