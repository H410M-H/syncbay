#!/usr/bin/env node
/**
 * Vercel build entrypoint (`npm run vercel-build`; Vercel prefers it over `build`).
 *
 * 1. prisma generate
 * 2. production only: prisma migrate deploy, so the schema the code expects exists before the
 *    new deployment goes live. A failure stops the build and the previous deployment keeps serving.
 * 3. next build
 *
 * Preview and development builds never touch the database. Set SKIP_DB_MIGRATE=1 to skip step 2.
 * Connection strings are never printed.
 */
import { spawnSync } from "node:child_process";

const PRISMA = ["node_modules/prisma/build/index.js"];
const NEXT = ["node_modules/next/dist/bin/next", "build", "--webpack"];

function run(args, { capture = false, env = process.env } = {}) {
  const res = spawnSync(process.execPath, args, {
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (capture) {
    // Prisma output names the database host, never the password; still redact credentials defensively.
    const redact = (s) => (s || "").replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/gi, "$1***@");
    process.stdout.write(redact(res.stdout));
    process.stderr.write(redact(res.stderr));
  }
  return { code: res.status ?? 1, output: `${res.stdout || ""}${res.stderr || ""}` };
}

function step(title) {
  console.log(`\n[vercel-build] ${title}`);
}

function migrationNames(output) {
  return [...new Set((output.match(/\b\d{14}_[a-z0-9_]+\b/gi) || []).map((m) => m.trim()))];
}

function shouldMigrate() {
  if (process.env.SKIP_DB_MIGRATE === "1") return { ok: false, why: "SKIP_DB_MIGRATE=1" };
  if (process.env.VERCEL_ENV !== "production") return { ok: false, why: `VERCEL_ENV=${process.env.VERCEL_ENV || "unset"} (production only)` };
  if (!process.env.DATABASE_URL) return { ok: false, why: "DATABASE_URL is not set" };
  return { ok: true };
}

function migrate() {
  const env = { ...process.env };
  if (!env.DIRECT_URL) {
    env.DIRECT_URL = env.DATABASE_URL;
    console.warn("[vercel-build] DIRECT_URL is not set; using DATABASE_URL for migrations.");
  }
  if (/-pooler\.|pgbouncer=true/i.test(env.DIRECT_URL)) {
    console.warn(
      "[vercel-build] The migration URL looks pooled (pgbouncer / -pooler). Prisma migrations need a direct connection: set DIRECT_URL to the non-pooled URL if this step fails."
    );
  }

  step("prisma migrate status");
  const status = run([...PRISMA, "migrate", "status"], { capture: true, env });

  const pending = /following migrations? have not yet been applied/i.test(status.output)
    ? migrationNames(status.output.split(/have not yet been applied/i)[1] || "")
    : [];
  if (pending.length) console.log(`[vercel-build] Pending migrations: ${pending.join(", ")}`);

  step("prisma migrate deploy");
  const deploy = run([...PRISMA, "migrate", "deploy"], { capture: true, env });
  if (deploy.code !== 0) {
    if (/P3005/.test(deploy.output)) {
    // The DB has tables but no migration history: refuse to guess, explain how to baseline.
    console.error(`
[vercel-build] The production database has tables but no Prisma migration history (P3005).
It was probably created with \`prisma db push\`. Baseline it once from your machine, then redeploy:

  1. DATABASE_URL=... DIRECT_URL=... npx prisma migrate diff \\
       --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --script
     (shows what is missing compared with the current schema)
  2. For every migration in prisma/migrations whose changes already exist in the database:
       npx prisma migrate resolve --applied <migration_folder_name>
  3. npx prisma migrate deploy   (applies the remaining migrations)

Or set SKIP_DB_MIGRATE=1 to deploy without migrating (the app will fail on missing columns).
`);
      process.exit(1);
    }

    console.error("[vercel-build] prisma migrate deploy failed; stopping the build so the current deployment stays live.");
    process.exit(deploy.code || 1);
  }
}

step("prisma generate");
if (run([...PRISMA, "generate"]).code !== 0) process.exit(1);

const decision = shouldMigrate();
if (decision.ok) migrate();
else console.log(`\n[vercel-build] Skipping database migrations: ${decision.why}`);

step("next build");
process.exit(run(NEXT).code);
