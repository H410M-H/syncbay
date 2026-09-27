# Original User Request

## 2026-09-16T22:50:53Z

Build and complete all SRS modules and dashboard pages for Syncbay, a Railway-class PaaS: implementing the complete deployment lifecycle, Nixpacks/Dockerfile runtime auto-detection, real-time SSE build & runtime console, dual-driver orchestration (local container simulator + cloud edge proxy), managed databases, R2 buckets, custom domains with automated SSL, and GitHub push/PR preview environments.

Working directory: c:/msns/syncbay
Integrity mode: demo

## Requirements

### R1. Complete Dashboard UI & Page Hierarchy
- Implement all dashboard routes and subpages to eliminate all 404 errors:
  - Dynamic Workspace View (`/dashboard/[slug]`): Workspace overview, project listings, member roles (`OWNER`, `MEMBER`, `VIEWER`), spending caps, and audit activity logs.
  - Project Resource Console (`/dashboard/projects/[id]`): Multi-tab layout for **Services**, **Deployments & Builds**, **Live Logs**, **Metrics & Analytics**, **Databases & Buckets**, **Domains/Networking**, and **Settings**.
  - Global Settings (`/dashboard/settings`): Profile, API access tokens, authentication providers, and billing configurations.
  - New Service & Resource Creation flows (`/dashboard/projects/new`, `/dashboard/services/new`, `/dashboard/databases/new`).

### R2. Runtime Auto-Detection & Buildpack Engine
- Automatically detect runtime environments from connected Git repositories (Node.js, Python, Go, Rust, Ruby, or standard `Dockerfile`).
- Integrate a Nixpacks/Cloud Native Buildpacks (CNB) pipeline to generate OCI-compliant build manifests and container configurations without requiring manual user Dockerfiles.
- Support configurable build commands, run commands, root directories, and environment variable resolution (including inter-service references like `${{ Postgres.URL }}`).

### R3. Deployment Orchestrator & Dual-Driver Execution Engine
- Implement a robust deployment lifecycle with explicit state transitions: `QUEUED` → `BUILDING` → `DEPLOYING` → `ACTIVE` (or `FAILED` / `CRASHED` / `SLEEPING`).
- Provide a **Dual-Driver Architecture**:
  - **Local/Simulated Driver**: Out-of-the-box local execution runner that triggers simulated builds, streams realistic build steps, and activates local container runtimes without requiring external cloud accounts.
  - **Edge/Cloud Driver**: Pluggable drivers for Cloudflare Containers / Docker / Kubernetes backends when API credentials are provided.
- Zero-downtime blue/green deployment switching: new containers must pass automated HTTP health checks before incoming traffic is shifted. Instant rollback triggers if the health check fails.

### R4. Real-Time Log Console & Live Metrics
- Build a real-time console with Server-Sent Events (SSE) / chunked HTTP streaming to stream build steps and container `stdout`/`stderr` logs directly to the browser terminal view (matching Vercel/Railway UI).
- Real-time CPU usage, memory utilization, network egress, and disk usage graphs with historical inspection and live-updating telemetry.

### R5. Edge Reverse Proxy, Custom Domains & SSL
- Dynamic routing for default subdomains (`<service>-<env>.syncbay.app` or `.syncbay.run`) and custom hostnames.
- Automated CNAME/TXT verification record generation, status tracking, and automated SSL certificate provisioning flow.

### R6. Managed Databases, Object Storage & Persistent Storage
- Provision and manage Postgres, Redis/Valkey, and MySQL database instances with connection string generation, credential management, and one-click connection details.
- S3/Cloudflare R2 compatible Object Storage bucket provisioning and pre-signed URL generation.
- Persistent volume mounting configurations for stateful services.

### R7. GitHub Integration & Ephemeral PR Preview Environments
- Complete GitHub App/OAuth repository integration: list repos, select branches, and configure auto-deploy webhooks.
- Ephemeral PR Preview Environments: Listen to GitHub `pull_request` webhooks, automatically spin up an isolated preview environment with cloned variables on PR creation, and teardown resources upon merge/closure.

## Acceptance Criteria

### Navigation & Zero 404s
- [ ] Every dashboard link (`/dashboard`, `/dashboard/[slug]`, `/dashboard/projects/[id]`, `/dashboard/settings`, `/dashboard/projects/new`) renders cleanly without 404 or unhandled runtime errors.
- [ ] Responsive navigation with workspace switcher and project resource tabs.

### Deployments & Build Log Console
- [ ] Triggering a deployment transitions through `QUEUED` → `BUILDING` → `DEPLOYING` → `ACTIVE`.
- [ ] Build and runtime logs stream live to the browser terminal window via SSE without full-page reloads.
- [ ] Health checks gate routing; failed deployments auto-rollback to the previous active release.

### Infrastructure & Services
- [ ] Managed Postgres and Redis instances can be provisioned and their connection strings injected into services.
- [ ] Custom domain manager allows adding domains, displays DNS verification TXT/CNAME instructions, and simulates/provisions SSL verification.
- [ ] R2/S3 storage buckets can be created, viewed, and configured with access keys.

### Quality & Verification
- [ ] `npx tsc --noEmit` passes with 0 TypeScript compilation errors.
- [ ] `npm run build` succeeds cleanly.
- [ ] Existing database tables and schema remain consistent with `prisma/schema.prisma`.

## 2026-09-19T09:21:38Z

Comprehensive enterprise upgrade for Syncbay PaaS (https://www.syncbay.app): resolve GitHub OAuth RFC 9207 callback error, implement modern automated collapsible sidebar with complete mobile responsiveness across all dashboard views, full RBAC workspace invitation workflows, hyper-competitive multi-tier pricing engine, official US corporate identity, and automated DevOps capabilities exceeding Vercel and Railway.

Working directory: /data/data/com.termux/files/home/portway
Integrity mode: development

## Requirements

### R1. Authentication & OAuth Handshake Hardening
Resolve the [next-auth][error][OAUTH_CALLBACK_ERROR] (issuer must be configured on the issuer) by setting issuer: "https://github.com/login/oauth" on GitHubProvider to adhere to RFC 9207. Ensure seamless OAuth account linking, workspace auto-provisioning, and error-resilient callbacks in production.

### R2. Modern Collapsible Sidebar & Universal Mobile Responsiveness
Implement a high-polish, responsive navigation system:
- Desktop/Tablet: Automate collapsible states (expanded full icons+labels, collapsed icon-only with tooltips), with user preference persistence via localStorage.
- Mobile: Integrated hamburger drawer with slide-out sheet navigation, active route highlights, touch-optimized tap targets, and zero horizontal scroll overflow across all dashboard routes (/dashboard, /dashboard/projects, /dashboard/databases, /dashboard/settings, /dashboard/team).

### R3. Workspace RBAC & Team Member Invitations
Implement full collaborative team management:
- Workspace invitations dialog supporting role assignment (OWNER, ADMIN, MEMBER, VIEWER).
- Invitation token generation, secure invite links (/invite/[token]), acceptance workflows, and audit log events.
- Workspace member management table with role changing, revocation, and permission enforcement across destructive actions.

### R4. Competitive Plans & Pricing Engine
Design and implement an industry-leading pricing page (/pricing) and dashboard billing management:
- Hobby ($0/mo): Free edge deployments, shared compute, 1 managed DB instance, community support.
- Pro ($18/mo): 0ms cold starts, attached managed PostgreSQL + Redis cache, 6 global edge POPs, unlimited team members, custom domains with auto-SSL.
- Enterprise ($450/mo): Dedicated POP clusters, SLA guarantees, audit log streaming, 24/7 DevOps engineer support.
- Direct side-by-side feature comparison table with Vercel and Railway showing Syncbay's superior price-to-performance ratio.

### R5. Official US Corporate Identity & Legal Footer
Establish official Syncbay corporate branding across marketing and legal touchpoints:
- Headquarters: Syncbay Technologies Inc., 548 Market St, Suite 82194, San Francisco, CA 94104, United States.
- Updated metadata, OpenGraph tags, footer copy, and legal contact disclosures.

### R6. Advanced DevOps Capabilities & Production Delivery
Analyze Vercel CLI features and incorporate superior automation:
- One-click instant deployment rollback, environment variable synchronization, and edge cache purging.
- Execute full test suite verification and deploy directly to Vercel production with end-to-end smoke testing.

## Acceptance Criteria

### Authentication
- [ ] GitHub OAuth sign-in redirects to /dashboard without OAuthCallback or issuer must be configured on the issuer errors.

### UI & Navigation
- [ ] Sidebar collapses/expands smoothly with tooltip indicators in collapsed state.
- [ ] Mobile navigation renders cleanly on viewports under 768px with full access to all project routes and settings.

### Team & RBAC
- [ ] Team members can be invited via email with designated roles and accept invitations via unique secure URLs.
- [ ] Non-admin members are restricted from deleting projects or modifying billing.

### Pricing & Positioning
- [ ] Public /pricing route displays interactive tier selectors and comparison matrix against Vercel and Railway.
- [ ] Footer and metadata display official US corporate presence.

### Production Validation
- [ ] All unit and E2E tests pass (npm test).
- [ ] Production deployment builds cleanly and verifies live on https://www.syncbay.app.


## 2026-09-27T19:34:34Z

Implement all 6 planned milestones (19 features) for Syncbay, a production Railway/Vercel-class PaaS platform built with Next.js 16 (App Router), TypeScript, tRPC v11, NextAuth v4, Prisma (PostgreSQL), and Tailwind CSS. The codebase is functional and builds cleanly (`npm run build` exits 0), but has RBAC gaps, incomplete mobile responsiveness, pricing discrepancies, and DevOps features at stub state. Bring every milestone from PLANNED to DONE.

Working directory: /data/data/com.termux/files/home/portway
Integrity mode: development

Reference documents (read these first):
- `PROJECT.md` — Feature inventory, milestone table, interface contracts
- `ORIGINAL_REQUEST.md` — Original product requirements
- `plan.md` — Implementation plan
- `TEST_INFRA.md` and `TEST_READY.md` — Test infrastructure details

## Requirements

### R1. Auth Hardening & callbackUrl Preservation (Milestone M1)

The auth system (`src/lib/auth.ts`) already has `issuer` and `allowDangerousEmailAccountLinking` configured. The sign-in form (`src/app/auth/signin/signin-form.tsx`) already preserves `callbackUrl`. What's missing:

1. Add an explicit `redirect` callback in `authOptions.callbacks` that safely handles internal URLs and prevents open redirects.
2. In `src/app/dashboard/layout.tsx`, the unauthenticated redirect (`redirect("/auth/signin")`) drops the current path. Change it to redirect to `/auth/signin?callbackUrl=<current_pathname>` so users return to their intended page after login.
3. In `src/app/invite/[token]/page.tsx` and `src/app/invite/page.tsx`, when the user is unauthenticated, show a "Sign in to Accept" button linking to `/auth/signin?callbackUrl=/invite/<token>` instead of letting the accept mutation fail with UNAUTHORIZED.

### R2. Mobile Responsiveness, Collapsible Sidebar & Route Completeness (Milestone M2)

The dashboard shell (`src/app/dashboard/dashboard-shell.tsx`) has partial mobile drawer and collapsible sidebar support. Fix and complete:

1. Ensure sidebar tooltips render fully visible when collapsed (no CSS clipping — use `overflow: visible` on the sidebar container or `position: fixed` tooltips with `z-index` above the sidebar).
2. On viewports < 768px: verify the sidebar is fully hidden and the mobile drawer sheet works correctly with touch swipe-to-close. All touch targets must be at minimum 44×44px.
3. Eliminate any horizontal overflow on mobile — no horizontal scroll on any dashboard or public page at < 768px.
4. Add a mobile hamburger/navigation drawer to the landing page (`src/app/page.tsx`) header — currently desktop nav links are `hidden lg:flex` with no mobile alternative.
5. Ensure all dashboard routes render without 404: `/dashboard`, `/dashboard/projects`, `/dashboard/databases`, `/dashboard/team`, `/dashboard/services`, `/dashboard/buckets`, `/dashboard/crons`, `/dashboard/members`, `/dashboard/audit`, `/dashboard/settings`, `/dashboard/usage`. (These routes already exist but verify they all render properly.)
6. Add a `viewport` export to `src/app/layout.tsx` for proper mobile scaling.

### R3. Workspace RBAC, Team Management & Invitations (Milestone M3)

The `WorkspaceRole` enum in `prisma/schema.prisma` is currently `{ OWNER, MEMBER, VIEWER }` — missing `ADMIN`. Multiple routers have RBAC bugs:

1. Add `ADMIN` to `WorkspaceRole` enum in `prisma/schema.prisma` and run `prisma generate`.
2. In `src/server/routers/project.ts`: the `delete` procedure only blocks `VIEWER` — `MEMBER` can delete projects. Fix: only allow `OWNER` and `ADMIN` to delete projects (return `FORBIDDEN` for `MEMBER` and `VIEWER`).
3. In `src/server/routers/workspace.ts`: the `invite` procedure only allows `OWNER`. Update to allow both `OWNER` and `ADMIN`. Also expand the invite role input to include `ADMIN`. Apply the same OWNER||ADMIN pattern to `updateSpendingCap`, `auditLog`, `revokeInvite`, `updateMemberRole`, and `removeMember`.
4. In `src/server/routers/deployment.ts`: role filters use `{ in: ["OWNER", "MEMBER"] }` — add `"ADMIN"` to all of them.
5. In `src/server/routers/service.ts`: same issue — add `"ADMIN"` to all role filter arrays. Also fix `deleteVariable` which doesn't check role at all (VIEWER can delete variables).
6. In `src/server/routers/devops.ts`: the `assertDevopsAccess` helper's type signature and defaults exclude `"ADMIN"`. Update both.
7. Update the invite role selector in the dashboard shell to include `ADMIN` as an option.
8. Ensure audit log entries are created for role changes, member removals, and invite revocations.

### R4. Pricing Engine & Corporate Identity (Milestone M4)

The pricing page exists but has discrepancies from the spec:

1. The pricing page (`src/app/pricing/page.tsx`) shows Pro at $12/mo and Enterprise at $199/mo. Per PROJECT.md F11, the tiers should be: Hobby ($0/mo), Pro ($18/mo, unlimited seats), Enterprise ($450/mo). Update the pricing cards to match.
2. The JSON-LD in `src/app/layout.tsx` lists Pro Plan at `"price": "12"` — update to `"18"`.
3. Update `publisher` from `"Syncbay Inc."` to `"Syncbay Technologies Inc."` and `creator` from `"MSNS-DEV™"` to `"Syncbay Technologies Inc."` in `src/app/layout.tsx`.
4. The pricing page US headquarters section shows `100 Montgomery St, Suite 1400`. Per PROJECT.md F13, the official address is: `548 Market St, Suite 82194, San Francisco, CA 94104, United States`. Update all references.
5. Verify the comparison matrix on the pricing page displays Syncbay vs Vercel vs Railway features correctly.
6. Update the landing page footer (`src/components/marketing/landing-footer.tsx`) to use the correct corporate address.

### R5. Advanced DevOps Capabilities (Milestone M5)

The DevOps router (`src/server/routers/devops.ts`) has WAF, canary, and cron features but lacks the three M5 features:

1. **Instant Rollback (F14)**: Add `SUPERSEDED` to `DeploymentStatus` enum in `prisma/schema.prisma`. Implement an `instantRollback` procedure in the devops or deployment router that: takes a `deploymentId`, sets the target deployment to `ACTIVE`, marks the current active deployment as `SUPERSEDED`, and triggers `purgeEdgeCache({ all: true })`. Must be sub-second (no rebuild). Restrict to `OWNER` and `ADMIN` roles.
2. **Environment Variable Synchronization (F15)**: Implement `syncVariables(serviceId, variables: Record<string, string>, mode: "merge" | "overwrite")` — bulk `.env` import that either merges with or overwrites existing variables. Support workspace-level shared variables.
3. **Edge Cache Purging (F16)**: Implement `purgeEdgeCache(options: { domain?, path?, tag?, all? })` that simulates invalidation across all 6 edge POPs (iad1, sfo1, fra1, lhr1, sin1, syd1). Integrate with instant rollback. Expose via tRPC.

Follow the interface contracts defined in PROJECT.md for all three functions.

### R6. Final Verification & Build Integrity (Milestone M6)

1. Run `npm run build` and ensure it completes with exit code 0 and no TypeScript errors.
2. Run the existing E2E test suite (`npm run test`) and ensure all tests pass.
3. Verify all dashboard routes render correctly.
4. Verify the auth flow completes end-to-end (sign-in → callback → dashboard).
5. Update `PROJECT.md` milestone statuses from `PLANNED` to `DONE` for all completed milestones.

## Acceptance Criteria

### Build & Compilation
- [ ] `npm run build` completes with exit code 0 and no TypeScript errors
- [ ] `tsconfig.json` targets ES2022 or later (already done, verify preserved)

### Authentication & Redirect
- [ ] `authOptions.callbacks` includes an explicit `redirect` callback that handles internal URLs
- [ ] Dashboard layout redirects unauthenticated users to `/auth/signin?callbackUrl=<path>`
- [ ] Invite pages show "Sign in to Accept" for unauthenticated users with proper `callbackUrl`

### Mobile & Sidebar
- [ ] Sidebar tooltips render fully visible when collapsed (no clipping)
- [ ] Sidebar collapse state persists in localStorage
- [ ] On < 768px: sidebar hidden, mobile drawer available, zero horizontal overflow
- [ ] Mobile touch targets ≥ 44×44px
- [ ] Landing page has mobile navigation hamburger/drawer
- [ ] Root layout exports `viewport` metadata

### Dashboard Routes
- [ ] All routes render without 404: `/dashboard`, `/dashboard/projects`, `/dashboard/databases`, `/dashboard/team`, `/dashboard/services`, `/dashboard/buckets`, `/dashboard/crons`, `/dashboard/members`, `/dashboard/audit`, `/dashboard/settings`, `/dashboard/usage`

### RBAC & Permissions
- [ ] `WorkspaceRole` enum includes OWNER, ADMIN, MEMBER, VIEWER
- [ ] Prisma client regenerated after schema change
- [ ] Project deletion returns FORBIDDEN for MEMBER and VIEWER (only OWNER and ADMIN allowed)
- [ ] Billing/spending cap modification: OWNER and ADMIN only
- [ ] Invitation creation: OWNER and ADMIN only
- [ ] All deployment/service mutations include ADMIN in role filters
- [ ] `deleteVariable` in service router blocks VIEWER role
- [ ] Audit log entries created for role changes and member management actions

### Team Invitations
- [ ] Invitation tokens generated and stored in database
- [ ] `/invite/[token]` renders and accepts valid tokens
- [ ] Accepting invitation adds user to workspace with assigned role
- [ ] Invalid/expired tokens show appropriate error
- [ ] Invite modal includes ADMIN as a role option

### Pricing & Identity
- [ ] `/pricing` shows: Hobby ($0), Pro ($18/mo), Enterprise ($450/mo)
- [ ] Comparison matrix: Syncbay vs Vercel vs Railway
- [ ] JSON-LD Pro Plan price is "18"
- [ ] All corporate references: "Syncbay Technologies Inc."
- [ ] All address references: "548 Market St, Suite 82194, San Francisco, CA 94104"

### DevOps Engine
- [ ] `DeploymentStatus` includes `SUPERSEDED`
- [ ] `instantRollback(deploymentId)` sets target to ACTIVE, previous to SUPERSEDED
- [ ] Rollback triggers automatic edge cache purge
- [ ] `syncVariables()` supports "merge" and "overwrite" modes
- [ ] `purgeEdgeCache()` accepts domain, path, tag, and all options
- [ ] All three DevOps features restricted to OWNER and ADMIN roles

### E2E Tests
- [ ] `npm run test` completes with all tests passing
- [ ] PROJECT.md milestones updated to DONE
