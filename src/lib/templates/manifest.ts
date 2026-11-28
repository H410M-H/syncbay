/**
 * `syncbay.json` v1: the deploy manifest a template repository ships at its root.
 *
 * Syncbay reads only what it acts on: the app's port, its health-check path, the backing services
 * to provision (postgres / redis / valkey, pgvector) and the environment variables to ask for.
 * Unknown keys are ignored, the document is size-capped, and every field is validated here on the
 * server before anything is created. The manifest never runs code and never names an image.
 */

import crypto from "node:crypto";
import { z } from "zod";
import { TEMPLATE_REPO_PATTERN } from "@/lib/templates/catalog";

/** Largest manifest accepted (bytes). A real one is well under 4 KiB. */
export const MANIFEST_MAX_BYTES = 32 * 1024;

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Extensions the platform can install on a managed Postgres. */
export const SUPPORTED_PG_EXTENSIONS = ["vector"] as const;

const envKey = z.string().regex(ENV_KEY, "must be a valid environment variable name");

const serviceSchema = z
  .object({
    type: z.enum(["postgres", "redis", "valkey"]),
    env: envKey.optional(),
    extensions: z.array(z.enum(SUPPORTED_PG_EXTENSIONS)).max(4).optional(),
  })
  .refine((s) => !s.extensions?.length || s.type === "postgres", { message: "extensions are only supported on postgres services" });

const envSchema = z.object({
  key: envKey,
  description: z.string().max(300).optional(),
  default: z.string().max(4096).optional(),
  required: z.boolean().optional(),
  secret: z.boolean().optional(),
  generate: z.literal("secret").optional(),
});

const manifestSchema = z.object({
  name: z.string().max(120).optional(),
  slug: z.string().max(80).optional(),
  description: z.string().max(500).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  healthcheckPath: z
    .string()
    .max(200)
    .regex(/^\/[A-Za-z0-9._~\/-]*$/, "must be an absolute path such as /health")
    .optional(),
  services: z.array(serviceSchema).max(6).default([]),
  env: z.array(envSchema).max(60).default([]),
});

export type ManifestService = z.infer<typeof serviceSchema> & { env: string };
export type ManifestEnvVar = z.infer<typeof envSchema>;

export interface TemplateManifest {
  name?: string;
  description?: string;
  port?: number;
  healthcheckPath?: string;
  services: ManifestService[];
  env: ManifestEnvVar[];
}

export class ManifestError extends Error {}

/** Env key the platform injects for a service type when the manifest names none. */
export function defaultServiceEnvKey(type: ManifestService["type"]): string {
  return type === "postgres" ? "DATABASE_URL" : "REDIS_URL";
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.length ? i.path.join(".") : "manifest"}: ${i.message}`)
    .join("; ");
}

/** Parses and validates a manifest (a JSON string or an already-parsed value). Throws ManifestError. */
export function parseTemplateManifest(input: string | unknown): TemplateManifest {
  let value: unknown = input;
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > MANIFEST_MAX_BYTES) {
      throw new ManifestError(`syncbay.json is larger than ${MANIFEST_MAX_BYTES / 1024} KiB`);
    }
    try {
      value = JSON.parse(input);
    } catch {
      throw new ManifestError("syncbay.json is not valid JSON");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManifestError("syncbay.json must be a JSON object");
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) throw new ManifestError(`Invalid syncbay.json: ${formatIssues(parsed.error)}`);
  const m = parsed.data;

  const keys = new Set<string>();
  for (const v of m.env) {
    if (keys.has(v.key)) throw new ManifestError(`Invalid syncbay.json: env key ${v.key} is listed twice`);
    keys.add(v.key);
  }
  const services: ManifestService[] = m.services.map((s) => ({ ...s, env: s.env ?? defaultServiceEnvKey(s.type) }));
  const serviceKeys = new Set<string>();
  for (const s of services) {
    if (keys.has(s.env)) throw new ManifestError(`Invalid syncbay.json: ${s.env} is both a service URL and an env entry`);
    if (serviceKeys.has(s.env)) throw new ManifestError(`Invalid syncbay.json: two services write ${s.env}`);
    serviceKeys.add(s.env);
  }

  return {
    name: m.name,
    description: m.description,
    port: m.port,
    healthcheckPath: m.healthcheckPath,
    services,
    env: m.env,
  };
}

export interface ResolvedTemplateVariable {
  key: string;
  value: string;
  isSecret: boolean;
  generated: boolean;
}

/**
 * Turns the manifest's env entries plus the values a user typed into service variables.
 * `generate: "secret"` entries get a fresh 32-byte hex value here (on the server) unless the user
 * typed one; defaults fill blanks; `required` entries left blank are reported in `missing`.
 * Keys the manifest does not declare are ignored.
 */
export function resolveTemplateEnv(
  manifest: Pick<TemplateManifest, "env">,
  provided: Record<string, string | undefined> = {}
): { variables: ResolvedTemplateVariable[]; missing: string[] } {
  const variables: ResolvedTemplateVariable[] = [];
  const missing: string[] = [];
  for (const entry of manifest.env) {
    const typed = provided[entry.key];
    const value = typeof typed === "string" && typed.length > 0 ? typed : undefined;
    const isSecret = Boolean(entry.secret || entry.generate === "secret");
    if (value !== undefined) {
      variables.push({ key: entry.key, value, isSecret, generated: false });
    } else if (entry.generate === "secret") {
      variables.push({ key: entry.key, value: crypto.randomBytes(32).toString("hex"), isSecret: true, generated: true });
    } else if (entry.default !== undefined && entry.default !== "") {
      variables.push({ key: entry.key, value: entry.default, isSecret, generated: false });
    } else if (entry.required) {
      missing.push(entry.key);
    }
  }
  return { variables, missing };
}

// ─── Fetching ────────────────────────────────────────────────────────────────

export interface TemplateSource {
  owner: string;
  repo: string;
  fullName: string;
  repoUrl: string;
}

/** `owner/repo`, or a github.com URL (`https://github.com/owner/repo[.git][/…]`), as a source. */
export function parseTemplateSource(input: string): TemplateSource | null {
  let value = input.trim();
  const url = value.match(/^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+?)(?:\.git)?(?:[/?#].*)?$/i);
  if (url) value = `${url[1]}/${url[2]}`;
  if (!TEMPLATE_REPO_PATTERN.test(value)) return null;
  const [owner, repo] = value.split("/");
  if (repo === "." || repo === "..") return null;
  return { owner, repo, fullName: `${owner}/${repo}`, repoUrl: `https://github.com/${owner}/${repo}` };
}

export type ManifestFetchResult =
  | { status: "found"; manifest: TemplateManifest; defaultBranch: string }
  | { status: "absent"; defaultBranch: string }
  | { status: "invalid"; error: string; defaultBranch: string }
  | { status: "unreachable"; error: string; defaultBranch: string };

async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > MANIFEST_MAX_BYTES) throw new ManifestError(`syncbay.json is larger than ${MANIFEST_MAX_BYTES / 1024} KiB`);
  const text = await res.text();
  if (Buffer.byteLength(text, "utf8") > MANIFEST_MAX_BYTES) throw new ManifestError(`syncbay.json is larger than ${MANIFEST_MAX_BYTES / 1024} KiB`);
  return text;
}

/**
 * Reads the repository's default branch and its `syncbay.json`. With a GitHub token the REST API is
 * used (works for private repositories); without one, public endpoints (api.github.com for the
 * branch, raw.githubusercontent.com for the file). A missing manifest is not an error.
 */
export async function fetchTemplateManifest(source: TemplateSource, opts: { token?: string | null; timeoutMs?: number } = {}): Promise<ManifestFetchResult> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const auth: Record<string, string> = opts.token ? { authorization: `Bearer ${opts.token}` } : {};
  const ghHeaders = { accept: "application/vnd.github+json", "user-agent": "syncbay-templates", ...auth };

  let defaultBranch = "main";
  try {
    const res = await fetch(`https://api.github.com/repos/${source.owner}/${source.repo}`, { headers: ghHeaders, signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) {
      const info = (await res.json()) as { default_branch?: unknown };
      if (typeof info.default_branch === "string" && /^[A-Za-z0-9._\/-]{1,200}$/.test(info.default_branch)) defaultBranch = info.default_branch;
    }
  } catch {
    // Rate-limited or offline: keep "main" and still try the file.
  }

  const ref = encodeURIComponent(defaultBranch);
  const url = opts.token
    ? `https://api.github.com/repos/${source.owner}/${source.repo}/contents/syncbay.json?ref=${ref}`
    : `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${defaultBranch.split("/").map(encodeURIComponent).join("/")}/syncbay.json`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: opts.token ? { ...ghHeaders, accept: "application/vnd.github.raw" } : { "user-agent": "syncbay-templates" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
  } catch (err) {
    return { status: "unreachable", error: `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`, defaultBranch };
  }
  if (res.status === 404) return { status: "absent", defaultBranch };
  if (!res.ok) return { status: "unreachable", error: `GitHub answered HTTP ${res.status} for syncbay.json`, defaultBranch };
  try {
    const manifest = parseTemplateManifest(await readCapped(res));
    return { status: "found", manifest, defaultBranch };
  } catch (err) {
    return { status: "invalid", error: err instanceof ManifestError ? err.message : "syncbay.json could not be read", defaultBranch };
  }
}
