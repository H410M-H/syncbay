import { z } from "zod";

/**
 * Server-side environment, validated with zod.
 *
 * - During `next build` (NEXT_PHASE === "phase-production-build", set by Next
 *   before it spawns the page-data / prerender workers) secrets are usually
 *   absent, so the production requirements are skipped and the build never
 *   throws.
 * - At runtime in production, a missing required variable throws on first
 *   import so a misconfigured deployment fails fast instead of serving
 *   half-broken auth.
 * - In development and tests problems are logged and the raw values are used.
 */

// Treat empty strings (common in copied .env files) as "unset".
const optional = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().optional(),
);

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).catch("development"),
    NEXT_PHASE: optional,

    // Required in production
    DATABASE_URL: optional,
    NEXTAUTH_SECRET: optional,

    // Optional
    NEXTAUTH_URL: optional,
    NEXT_PUBLIC_APP_URL: optional,
    GOOGLE_CLIENT_ID: optional,
    GOOGLE_CLIENT_SECRET: optional,
    GITHUB_CLIENT_ID: optional,
    GITHUB_CLIENT_SECRET: optional,

    // Injected by Vercel (hostnames, no protocol)
    VERCEL_URL: optional,
    VERCEL_BRANCH_URL: optional,
    VERCEL_PROJECT_PRODUCTION_URL: optional,
  })
  .superRefine((env, ctx) => {
    const isBuild = env.NEXT_PHASE === "phase-production-build";
    if (env.NODE_ENV !== "production" || isBuild) return;
    for (const key of ["DATABASE_URL", "NEXTAUTH_SECRET"] as const) {
      if (!env[key]) {
        ctx.addIssue({ code: "custom", path: [key], message: `${key} is required in production` });
      }
    }
  });

type ServerEnv = z.infer<typeof schema>;

function loadServerEnv(): ServerEnv {
  const parsed = schema.safeParse(process.env);
  if (parsed.success) return parsed.data;

  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  const message = `[env] Invalid server environment:\n${details}`;

  if (process.env.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build") {
    throw new Error(message);
  }
  console.warn(message);
  return schema.parse({ ...process.env, NODE_ENV: "development" });
}

export const serverEnv = loadServerEnv();

/** Public base URL: NEXTAUTH_URL → NEXT_PUBLIC_APP_URL → https://VERCEL_URL → localhost. */
export function getAppUrl(): string {
  const url =
    serverEnv.NEXTAUTH_URL ??
    serverEnv.NEXT_PUBLIC_APP_URL ??
    (serverEnv.VERCEL_URL ? `https://${serverEnv.VERCEL_URL}` : undefined) ??
    "http://localhost:3000";
  return url.replace(/\/+$/, "");
}
