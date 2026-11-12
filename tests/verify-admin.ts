/**
 * Verification: staff console access control, enforcement and the security fixes that came with it.
 *
 * Real: Postgres (DATABASE_URL, Prisma) and the real tRPC routers (direct callers), the real wake
 * and abuse REST handlers, and the real deploy engine (which must refuse a suspended workspace
 * before it reaches any runner). Mocked: nothing; no runner is needed because every path tested
 * here stops before dispatch. GitHub token checks use an injected checker.
 *
 *  1. Customer endpoints never return password hashes or TOTP secrets; proxied traffic loses
 *     Syncbay session cookies.
 *  2. Permission matrix: non-staff get NOT_FOUND, missing permissions FORBIDDEN + DENIED audit row.
 *  3. SUPER_ADMIN_EMAILS bootstraps only an OAuth-linked account and pins it.
 *  4. Reason and typed confirmation are enforced; every action is audited; the audit table is
 *     append-only in the database.
 *  5. Staff management: role ceilings, no self-changes, the last super admin cannot be removed.
 *  6. Workspace suspension: services paused, deploys fail with the suspension message, resume and
 *     wake refused, always-on skips it, the customer's own audit log shows "Syncbay staff".
 *  7. Service takedown and restore; abuse intake (honeypot, dedupe, host → service link) and
 *     resolution; suspended users are refused by tRPC and API tokens.
 *  8. GitHub token resolution for unattended deploys: workspace owner's token, revoked ones skipped.
 *
 * Usage: DATABASE_URL=postgresql://… npm run test:admin
 */

import assert from "node:assert";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";

const RUN = crypto.randomBytes(3).toString("hex");
let passed = 0;
const ok = (msg: string) => {
  passed += 1;
  console.log(`  ✔ ${msg}`);
};

async function rejects(p: Promise<unknown>, code: string, match?: RegExp) {
  try {
    await p;
  } catch (err: any) {
    assert.strictEqual(err?.code, code, `expected ${code}, got ${err?.code}: ${err?.message}`);
    if (match) assert.match(String(err?.message), match);
    return;
  }
  assert.fail(`expected ${code}`);
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required (real Postgres)");
  for (const k of ["RUNNER_URL", "RUNNER_DRIVER", "GITHUB_TOKEN", "GITHUB_PAT", "GITHUB_ACCESS_TOKEN", "UPSTASH_REDIS_REST_URL"]) delete process.env[k];
  const bootEmail = `boss-${RUN}@test.syncbay.app`;
  process.env.SUPER_ADMIN_EMAILS = `${bootEmail}, pw-only-${RUN}@test.syncbay.app`;
  process.env.RUNNER_SECRET = crypto.randomBytes(16).toString("hex");

  const prisma = new PrismaClient();
  (globalThis as any).prisma = prisma;
  const { appRouter } = await import("../src/server/root");
  const { stripPlatformCookies } = await import("../src/lib/edge/forward-headers");
  const { isRunnerOutdated } = await import("../src/lib/orchestrator/runner-config");
  const { resolveGithubToken } = await import("../src/lib/github");
  const { executeDeployment } = await import("../src/lib/orchestrator/engine");
  const { wakeAlwaysOnServices } = await import("../src/lib/scale/always-on");
  const { validateBearerToken } = await import("../src/lib/api/auth-token");
  const wakeRoute = await import("../src/app/api/v1/services/wake/route");
  const abuseRoute = await import("../src/app/api/v1/abuse/route");
  const { NextRequest } = await import("next/server");

  const caller = (userId: string) => appRouter.createCaller({ db: prisma, session: { user: { id: userId } }, headers: new Headers({ "user-agent": "verify-admin", "x-forwarded-for": "203.0.113.7" }) } as any);
  const mkUser = (tag: string, data: Record<string, unknown> = {}) =>
    prisma.user.create({ data: { email: `${tag}-${RUN}@test.syncbay.app`, name: tag, passwordHash: "$2a$10$secret-hash", totpSecret: "TOTPSECRET", ...data } });
  const linkOAuth = (userId: string, provider = "github", token: string | null = `gho_${RUN}${provider}${userId.slice(-4)}`) =>
    prisma.account.create({ data: { userId, type: "oauth", provider, providerAccountId: `${provider}-${userId}`, access_token: token } });

  const boss = await mkUser("boss");
  await linkOAuth(boss.id, "google");
  const pwOnly = await mkUser("pw-only");
  const owner = await mkUser("owner");
  const member = await mkUser("member");
  const mod = await mkUser("mod");
  const support = await mkUser("support");
  const viewer = await mkUser("viewer");
  const outsider = await mkUser("outsider");
  const users = [boss, pwOnly, owner, member, mod, support, viewer, outsider];

  const workspace = await prisma.workspace.create({
    data: { name: `Acme ${RUN}`, slug: `acme-${RUN}`, members: { create: [{ userId: owner.id, role: "OWNER" }, { userId: member.id, role: "MEMBER" }] } },
  });
  const project = await prisma.project.create({ data: { workspaceId: workspace.id, name: "shop" } });
  const env = await prisma.environment.create({ data: { projectId: project.id, name: "production", isDefault: true } });
  const svc = await prisma.service.create({
    data: { environmentId: env.id, name: `web${RUN}`, sourceType: "empty", startCommand: "node server.js", port: 3000, variables: { create: [{ key: "STRIPE_KEY", value: "sk_live_SECRET", isSecret: true }] } },
  });
  const host = `web${RUN}-production.syncbay.app`;
  await prisma.domain.create({ data: { serviceId: svc.id, hostname: host, isGenerated: true, status: "ACTIVE" } });
  const mkDeployment = async (status: string, extra: Record<string, unknown> = {}) => {
    const build = await prisma.build.create({ data: { serviceId: svc.id, status: "SUCCEEDED" } as any });
    return prisma.deployment.create({ data: { serviceId: svc.id, buildId: build.id, status, ...extra } as any });
  };

  const cleanup = async () => {
    await prisma.deploymentJob.deleteMany({ where: { serviceId: svc.id } }).catch(() => null);
    await prisma.deployment.deleteMany({ where: { serviceId: svc.id } }).catch(() => null);
    await prisma.abuseReport.deleteMany({ where: { OR: [{ workspaceId: workspace.id }, { url: { contains: RUN } }] } }).catch(() => null);
    await prisma.auditLogEntry.deleteMany({ where: { workspaceId: workspace.id } }).catch(() => null);
    await prisma.apiToken.deleteMany({ where: { workspaceId: workspace.id } }).catch(() => null);
    await prisma.workspace.delete({ where: { id: workspace.id } }).catch(() => null);
    await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } }).catch(() => null);
    await prisma.$disconnect();
  };

  try {
    // ─── 1. Secrets never leave ───────────────────────────────────────────────
    console.log("\n[1] Customer endpoints and proxied traffic");
    const ws = await caller(owner.id).workspace.bySlug({ slug: workspace.slug });
    const json = JSON.stringify(ws);
    assert.ok(!json.includes("passwordHash") && !json.includes("secret-hash") && !json.includes("TOTPSECRET"), "bySlug leaks no credentials");
    const log = await caller(owner.id).workspace.auditLog({ workspaceId: workspace.id, limit: 5 });
    assert.ok(!JSON.stringify(log).includes("passwordHash"));
    assert.strictEqual(
      stripPlatformCookies("theme=dark; __Secure-next-auth.session-token=abc; next-auth.csrf-token=x; __Host-next-auth.csrf-token=y; cart=1"),
      "theme=dark; cart=1"
    );
    assert.strictEqual(stripPlatformCookies("__Secure-next-auth.session-token=abc"), null);
    ok("workspace.bySlug / auditLog return no password hash or TOTP secret; session cookies are stripped before proxying");
    assert.deepStrictEqual([isRunnerOutdated(null), isRunnerOutdated("1.3.9"), isRunnerOutdated("1.4.0"), isRunnerOutdated("1.10.0")], [true, true, false, false]);
    ok("a runner that reports no version, or one older than the minimum, is flagged as outdated");

    // ─── 2. Matrix ───────────────────────────────────────────────────────────
    console.log("\n[2] Who may enter");
    assert.strictEqual(await caller(outsider.id).admin.me(), null);
    await rejects(caller(outsider.id).admin.overview(), "NOT_FOUND");
    await rejects(caller(owner.id).admin.workspaces(), "NOT_FOUND");
    ok("customers (even workspace owners) get NOT_FOUND: the console is not revealed");

    // ─── 3. Bootstrap ────────────────────────────────────────────────────────
    console.log("\n[3] SUPER_ADMIN_EMAILS bootstrap");
    assert.strictEqual(await caller(pwOnly.id).admin.me(), null, "a password-only account is not trusted for the allowlist");
    const me = await caller(boss.id).admin.me();
    assert.strictEqual(me?.role, "SUPER_ADMIN");
    assert.strictEqual(me?.pinned, true);
    assert.ok(await prisma.staffAuditEvent.findFirst({ where: { actorUserId: boss.id, action: "staff.bootstrap" } }));
    ok("an allowlisted account with a Google/GitHub sign-in becomes a pinned SUPER_ADMIN (audited); password-only does not");

    // ─── 4/5. Staff management, reasons, confirmations ───────────────────────
    console.log("\n[4] Staff management");
    const B = caller(boss.id).admin;
    await rejects(B.grantStaff({ email: mod.email, role: "MODERATOR", reason: "short" }), "BAD_REQUEST", /reason/);
    await B.grantStaff({ email: mod.email, role: "MODERATOR", reason: "Trust & safety on-call" });
    await B.grantStaff({ email: support.email, role: "SUPPORT", reason: "Support team member" });
    await B.grantStaff({ email: viewer.email, role: "VIEWER", reason: "Read-only finance review" });
    await rejects(B.grantStaff({ email: member.email, role: "ADMIN", reason: "Promote to admin please" }), "BAD_REQUEST", /Type/);
    assert.strictEqual((await caller(mod.id).admin.me())?.role, "MODERATOR");
    await rejects(caller(support.id).admin.staff(), "FORBIDDEN");
    assert.ok(await prisma.staffAuditEvent.findFirst({ where: { actorUserId: support.id, outcome: "DENIED", permission: "staff.read" } }), "denied attempt audited");
    await rejects(caller(mod.id).admin.grantStaff({ email: member.email, role: "VIEWER", reason: "Not allowed for moderators" }), "FORBIDDEN");
    await rejects(B.revokeStaff({ userId: boss.id, reason: "Leaving the company", confirm: boss.email }), "BAD_REQUEST", /own/);
    ok("reasons ≥ 8 chars, typed confirmation for ADMIN grants, role ceilings, DENIED attempts audited, no self-revoke");

    // Super admins and the last-super-admin guard (un-pin boss so the env allowlist does not shield it).
    process.env.SUPER_ADMIN_EMAILS = "";
    const second = await mkUser("second");
    users.push(second);
    await B.grantStaff({ email: second.email, role: "SUPER_ADMIN", reason: "Backup super admin", confirm: second.email });
    await prisma.$executeRawUnsafe(`UPDATE staff_members SET "revokedAt" = now() WHERE "role" = 'SUPER_ADMIN' AND "revokedAt" IS NULL AND "userId" NOT IN ('${boss.id}', '${second.id}')`);
    // Two super admins revoke each other at the same moment: exactly one succeeds.
    const race = await Promise.allSettled([
      B.revokeStaff({ userId: second.id, reason: "Concurrent removal A", confirm: second.email }),
      caller(second.id).admin.revokeStaff({ userId: boss.id, reason: "Concurrent removal B", confirm: boss.email }),
    ]);
    assert.strictEqual(race.filter((r) => r.status === "fulfilled").length, 1, JSON.stringify(race.map((r) => r.status)));
    // The loser is refused either by the lock-protected count or because its own access is already gone.
    const loser = (race.find((r) => r.status === "rejected") as PromiseRejectedResult).reason;
    assert.ok(/last super admin/.test(String(loser?.message)) || loser?.code === "NOT_FOUND", String(loser?.message));
    assert.strictEqual(await prisma.staffMember.count({ where: { role: "SUPER_ADMIN", revokedAt: null, userId: { in: [boss.id, second.id] } } }), 1);
    const revokedOne = race[0].status === "fulfilled" ? second : boss;
    await rejects(caller(revokedOne.id).admin.overview(), "NOT_FOUND");
    await prisma.staffMember.update({ where: { userId: revokedOne.id }, data: { revokedAt: null } });
    await prisma.staffMember.update({ where: { userId: second.id }, data: { role: "ADMIN" } });
    await rejects(caller(second.id).admin.revokeStaff({ userId: boss.id, reason: "Admin tries to remove SA", confirm: boss.email }), "FORBIDDEN");
    process.env.SUPER_ADMIN_EMAILS = bootEmail;
    ok("revoking ends access at once; an ADMIN cannot revoke a super admin; two super admins cannot remove each other at once");

    await assert.rejects(prisma.$executeRawUnsafe(`DELETE FROM staff_audit_events WHERE "actorUserId" = '${boss.id}'`), /append-only/);
    await assert.rejects(prisma.$executeRawUnsafe(`UPDATE staff_audit_events SET reason = 'x' WHERE "actorUserId" = '${boss.id}'`), /append-only/);
    ok("the staff audit log rejects UPDATE and DELETE at the database");

    // ─── Customer 360 hides secrets and billing from moderators ──────────────
    const detail = await caller(mod.id).admin.workspace({ id: workspace.id });
    const detailJson = JSON.stringify(detail);
    assert.ok(detailJson.includes("STRIPE_KEY") && !detailJson.includes("sk_live_SECRET"), "variable names only");
    assert.ok(!detailJson.includes("passwordHash") && !detailJson.includes("TOTPSECRET"));
    assert.strictEqual(detail.billing, null, "moderators see no billing");
    assert.ok((await B.workspace({ id: workspace.id })).billing, "super admins see billing");
    const found = await caller(viewer.id).admin.workspaces({ q: host, filter: "all" });
    assert.ok(found.items.some((w: any) => w.id === workspace.id), "search by service hostname");
    assert.ok((await caller(viewer.id).admin.workspaces({ q: owner.email, filter: "all" })).items.some((w: any) => w.id === workspace.id), "search by owner email");
    ok("customer 360: env var names but not values, no credentials, billing only for billing roles; search by host and email");

    // ─── 6. Suspension ───────────────────────────────────────────────────────
    console.log("\n[6] Workspace suspension");
    const live = await mkDeployment("ACTIVE", { completedAt: new Date() });
    const M = caller(mod.id).admin;
    await rejects(caller(support.id).admin.suspendWorkspace({ workspaceId: workspace.id, reason: "Support cannot suspend", confirm: workspace.slug }), "FORBIDDEN");
    await rejects(M.suspendWorkspace({ workspaceId: workspace.id, reason: "Phishing kit hosted here", confirm: "wrong" }), "BAD_REQUEST", /Type/);
    const res = await M.suspendWorkspace({ workspaceId: workspace.id, reason: "Phishing kit hosted here", confirm: workspace.slug });
    assert.deepStrictEqual(res.stopped, [svc.id]);
    const wsRow = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    assert.ok(wsRow.suspendedAt && wsRow.suspendedReason === "Phishing kit hosted here" && wsRow.suspendedById === mod.id);
    assert.strictEqual((await prisma.service.findUniqueOrThrow({ where: { id: svc.id } })).isPaused, true);
    assert.strictEqual((await prisma.deployment.findUniqueOrThrow({ where: { id: live.id } })).status, "SLEEPING");
    assert.ok(await prisma.auditLogEntry.findFirst({ where: { workspaceId: workspace.id, action: "workspace.suspended" } }), "customer sees it in their audit log");
    ok("suspend (MODERATOR, typed slug): services paused and the live deployment stopped; customer audit shows it");

    const blocked = await mkDeployment("QUEUED");
    await assert.rejects(executeDeployment(blocked.id, blocked.buildId, svc.id, { serviceId: svc.id }), /suspended/);
    const blockedRow = await prisma.deployment.findUniqueOrThrow({ where: { id: blocked.id } });
    assert.strictEqual(blockedRow.status, "FAILED");
    assert.match(blockedRow.errorMessage || "", /suspended by Syncbay/);
    await rejects(caller(owner.id).service.setPaused({ serviceId: svc.id, paused: false }), "FORBIDDEN", /suspended/);
    const wake = await wakeRoute.POST(
      new NextRequest("http://localhost/api/v1/services/wake", { method: "POST", headers: { authorization: `Bearer ${process.env.RUNNER_SECRET}`, "content-type": "application/json" }, body: JSON.stringify({ serviceId: svc.id }) })
    );
    assert.strictEqual(wake.status, 403);
    await prisma.service.update({ where: { id: svc.id }, data: { isPaused: false } });
    assert.ok(!(await wakeAlwaysOnServices()).woken.some((w) => w.serviceId === svc.id), "always-on skips suspended workspaces");
    await prisma.service.update({ where: { id: svc.id }, data: { isPaused: true } });
    ok("while suspended: deploys fail with the suspension message, the owner cannot resume, wake answers 403, always-on skips it");

    await M.unsuspendWorkspace({ workspaceId: workspace.id, reason: "Owner removed the kit" });
    assert.strictEqual((await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).suspendedAt, null);
    ok("unsuspend clears the flag (services stay paused until the owner resumes them)");

    // ─── 7. Takedown, abuse intake, user suspension ──────────────────────────
    console.log("\n[7] Takedown, abuse reports, suspended users");
    const post = (body: Record<string, unknown>, ip = "198.51.100.9") =>
      abuseRoute.POST(new NextRequest("http://localhost/api/v1/abuse", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) }));
    const form = { category: "PHISHING", url: `https://${host}/login?r=${RUN}`, description: "Fake bank login page collecting passwords", reporterEmail: "reporter@example.org", renderedAt: Date.now() - 10_000 };
    assert.strictEqual((await post({ ...form, unexpected: 1 })).status, 400, "strict schema");
    const r1 = await post(form);
    assert.strictEqual(r1.status, 202);
    const ref = (await r1.json()).reference as string;
    const report = await prisma.abuseReport.findUniqueOrThrow({ where: { id: ref } });
    assert.deepStrictEqual([report.serviceId, report.workspaceId, report.priority, report.targetHost], [svc.id, workspace.id, 0, host]);
    assert.strictEqual((await (await post(form)).json()).reference, ref, "duplicate open report is merged");
    const bot = await post({ ...form, url: `https://x${RUN}.example/`, website: "spam" });
    assert.strictEqual(bot.status, 202);
    assert.strictEqual(await prisma.abuseReport.count({ where: { url: `https://x${RUN}.example/` } }), 0, "honeypot submissions are dropped silently");
    const queue = await M.reports();
    const listed = queue.find((r: any) => r.id === ref);
    assert.ok(listed && !("reporterIp" in listed), "reporter IP stays server-side");
    await M.assignReport({ reportId: ref, assigneeId: "me" });
    await rejects(M.resolveReport({ reportId: ref, action: "TAKEDOWN_SERVICE", reason: "Confirmed phishing", confirm: "nope" }), "BAD_REQUEST");
    await M.resolveReport({ reportId: ref, action: "TAKEDOWN_SERVICE", reason: "Confirmed phishing page", confirm: svc.name });
    const locked = await prisma.service.findUniqueOrThrow({ where: { id: svc.id } });
    assert.ok(locked.moderationLockedAt && locked.isPaused);
    assert.strictEqual((await prisma.abuseReport.findUniqueOrThrow({ where: { id: ref } })).status, "ACTIONED");
    await rejects(caller(owner.id).service.setPaused({ serviceId: svc.id, paused: false }), "FORBIDDEN", /taken down/);
    await M.restoreService({ serviceId: svc.id, reason: "Owner cleaned up the site" });
    assert.strictEqual((await prisma.service.findUniqueOrThrow({ where: { id: svc.id } })).moderationLockedAt, null);
    ok("public report → linked to service/workspace (P0) → assigned → take-down blocks resume → restore; honeypot and dedupe work");

    await rejects(M.setUserSuspended({ userId: member.id, suspended: true, reason: "Repeated abuse", confirm: "wrong@x" }), "BAD_REQUEST", /Type/);
    await M.setUserSuspended({ userId: member.id, suspended: true, reason: "Repeated abuse from account", confirm: member.email });
    await rejects(caller(member.id).workspace.list(), "FORBIDDEN", /suspended/);
    const tokenValue = `sb_live_${RUN}${crypto.randomBytes(8).toString("hex")}`;
    await prisma.apiToken.create({ data: { workspaceId: workspace.id, userId: member.id, name: "ci", tokenHash: crypto.createHash("sha256").update(tokenValue).digest("hex") } as any });
    await assert.rejects(validateBearerToken(`Bearer ${tokenValue}`), /suspended/);
    await rejects(M.setUserSuspended({ userId: boss.id, suspended: true, reason: "Moderator vs super admin", confirm: boss.email }), "FORBIDDEN");
    ok("suspended users are refused by tRPC and API tokens; staff cannot suspend someone at or above their role");

    const audit = await B.audit();
    const actions = new Set(audit.items.map((a: any) => a.action));
    for (const a of ["workspace.suspend", "workspace.unsuspend", "service.restore", "report.resolve.takedown_service", "user.suspend", "staff.grant"]) assert.ok(actions.has(a), `audited: ${a}`);
    const runActors = new Set(users.map((u) => u.id));
    assert.ok(audit.items.filter((a: any) => runActors.has(a.actorUserId) && a.action !== "staff.bootstrap").every((a: any) => a.ip === "203.0.113.7"), "IP recorded");
    assert.strictEqual((await caller(mod.id).admin.audit()).scope, "own");
    ok("every action is in the staff audit log with actor, reason and IP; moderators see only their own entries");

    const overview = await B.overview();
    assert.ok(overview.workspaces >= 1 && overview.openReports >= 0 && overview.revenue);
    assert.strictEqual((await caller(mod.id).admin.overview()).revenue, null, "revenue hidden from moderators");
    ok("overview numbers; revenue only for roles with ops.revenue.read");

    // ─── 8. GitHub token for unattended deploys ──────────────────────────────
    console.log("\n[8] GitHub token resolution");
    await linkOAuth(owner.id, "github", `gho_owner_${RUN}`);
    await linkOAuth(member.id, "github", `gho_member_${RUN}`);
    await linkOAuth(outsider.id, "github", `gho_outsider_${RUN}`);
    const seen: string[] = [];
    const check = async (t: string) => {
      seen.push(t);
      return t === `gho_owner_${RUN}` ? ("revoked" as const) : ("valid" as const);
    };
    const token = await resolveGithubToken({ projectId: project.id, check });
    assert.strictEqual(token, `gho_member_${RUN}`, "owner's revoked token skipped, member's used");
    assert.ok(!seen.includes(`gho_outsider_${RUN}`), "never a token from outside the workspace");
    assert.strictEqual((await prisma.account.findFirstOrThrow({ where: { userId: owner.id, provider: "github" } })).access_token, null, "revoked token cleared");
    assert.strictEqual(await resolveGithubToken({ projectId: project.id, userId: outsider.id, check }), `gho_member_${RUN}`, "an outsider's own token is not used for this project");
    ok("cron/webhook deploys use a working token of the project's workspace; revoked tokens are cleared and skipped");

    console.log(`\n✅ verify-admin: ${passed} checks passed (real Postgres, real routers and route handlers)`);
  } finally {
    await cleanup();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("\nverify-admin FAILED:", err);
    process.exit(1);
  }
);
