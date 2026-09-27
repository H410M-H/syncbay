# Project: Syncbay PaaS Enterprise Upgrade

## Architecture
Syncbay is a Railway/Vercel-class PaaS built with Next.js 14 (App Router), TypeScript, Tailwind CSS, tRPC, NextAuth v4, Prisma ORM (SQLite for local/edge simulation), and an edge-compatible deployment orchestrator.
- **Frontend Layer**: Next.js App Router (`src/app`), server and client components, Lucide icons, Tailwind design system, responsive mobile drawer navigation, collapsible sidebar.
- **API & RPC Layer**: tRPC router (`src/server/routers/`) with procedures for projects, deployments, services, databases, workspaces, members, invitations, and DevOps operations. NextAuth handlers in `src/app/api/auth/[...nextauth]`.
- **Database & RBAC Layer**: Prisma schema (`prisma/schema.prisma`) defining `User`, `Account`, `Session`, `Workspace`, `WorkspaceMember` (`OWNER`, `ADMIN`, `MEMBER`, `VIEWER`), `Invitation`, `AuditLog`, `Project`, `Deployment`, `Service`.
- **DevOps & Orchestration Layer**: Dual-driver execution engine (Local simulated container runner + Edge proxy router), Nixpacks auto-detector, instant rollback mechanism, edge cache purger (`src/lib/edge`), and env var synchronizer.
- **Production Delivery**: Vercel deployment pipeline (`https://www.syncbay.app`).

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F01 | NextAuth RFC 9207 Issuer Fix | Configure `issuer: "https://github.com/login/oauth"` and account linking on GitHubProvider in `src/lib/auth.ts` | M1 | R1 |
| F02 | OAuth Callback & Sign-in Redirection | Support `callbackUrl` in signin form and error-resilient callbacks | M1 | R1 |
| F03 | TypeScript & Build Compilation Unblock | Fix TS2737 BigInt literals in `src/lib/devops/waf-engine.ts` and set target `ES2022` in `tsconfig.json` | M1 | AC / Quality |
| F04 | Collapsible Sidebar & Tooltip Fix | Prevent tooltip clipping in collapsed sidebar via CSS, persist state via localStorage | M2 | R2 |
| F05 | Mobile Responsive Navigation | Add `.hide-on-mobile`, touch targets, mobile drawer sheet, zero horizontal scroll overflow on <768px | M2 | R2 |
| F06 | Dashboard Route Completeness | Eliminate 404s by adding `/dashboard/databases` and `/dashboard/team` | M2 | R2, AC |
| F07 | Prisma Schema RBAC Expansion | Add `ADMIN` role to `WorkspaceRole` enum in `prisma/schema.prisma` and generate client | M3 | R3 |
| F08 | RBAC Permission Enforcement & Deletion Guard | Restrict project deletion and billing to `OWNER` and `ADMIN`; block `MEMBER` from deletion | M3 | R3, AC |
| F09 | Team Invitation Flow & `/invite/[token]` | Support invitation token generation, `/invite/[token]` page, email invite dialog, role assignment | M3 | R3 |
| F10 | Member Management Table & Audit Logging | Member list with role changing, revocation, and audit log events | M3 | R3 |
| F11 | Tiered Pricing Engine (/pricing) | Interactive selector for Hobby ($0/mo), Pro ($18/mo, unlimited seats), Enterprise ($450/mo) | M4 | R4 |
| F12 | Competitive Comparison Matrix | Side-by-side feature comparison matrix against Vercel and Railway | M4 | R4 |
| F13 | Official US Corporate Identity & Footer | Update corporate identity to Syncbay Technologies Inc., 548 Market St, Suite 82194, San Francisco, CA 94104, United States in layout, footer, and metadata | M4 | R5 |
| F14 | Instant Deployment Rollback | Sub-second rollback shifting domain traffic without full rebuild delay | M5 | R6 |
| F15 | Environment Variable Synchronization | Bulk `.env` import, cross-environment variable copying, and workspace inheritance | M5 | R6 |
| F16 | Edge Cache Purging Engine | Edge POP cache invalidation (by tag, path, or all) integrated with rollback and CLI | M5 | R6 |
| F17 | Comprehensive E2E Test Suite Pass | 100% pass on Tiers 1-4 opaque-box tests covering all PaaS capabilities | M6 | AC |
| F18 | Adversarial Hardening (Tier 5) | White-box stress-testing, boundary edge cases, and vulnerability testing | M6 | Process |
| F19 | Production Build & Live Verification | `npm run build` cleanly succeeds and verified live on https://www.syncbay.app | M6 | AC |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Auth RFC 9207 & Build Compilation Unblock | F01, F02, F03 | none | DONE |
| M2 | Collapsible Sidebar & Universal Mobile Responsiveness | F04, F05, F06 | none | DONE |
| M3 | Workspace RBAC & Team Member Invitations | F07, F08, F09, F10 | M1 | DONE |
| M4 | Competitive Plans & Pricing Engine + Corporate Identity | F11, F12, F13 | none | DONE |
| M5 | Advanced DevOps Capabilities & Deployment Engine | F14, F15, F16 | M1 | DONE |
| M6 | Final Verification & Adversarial Hardening (Dual Track Integration) | F17, F18, F19 | M1, M2, M3, M4, M5 | DONE |

## Interface Contracts

### Auth ↔ NextAuth Handler
- GitHubProvider config: `{ clientId, clientSecret, issuer: "https://github.com/login/oauth", allowDangerousEmailAccountLinking: true }`
- Sign-in redirect: `callbackUrl` query parameter preserved and respected.

### Workspace & RBAC ↔ Routers
- `WorkspaceRole`: `"OWNER" | "ADMIN" | "MEMBER" | "VIEWER"`
- Permissions:
  - `deleteProject`: `role === "OWNER" || role === "ADMIN"` (MEMBER and VIEWER get `FORBIDDEN`)
  - `inviteMember`: `role === "OWNER" || role === "ADMIN"`
  - `modifyBilling`: `role === "OWNER" || role === "ADMIN"`
- Invitations: Token-based `/invite/[token]` accepting invite redirects to `/dashboard` or prompts signin with `callbackUrl=/invite/[token]`.

### DevOps & Deployment Engine ↔ Edge Router
- `instantRollback(deploymentId: string)`:
  - Updates target deployment to `ACTIVE`, previous to `SUPERSEDED`.
  - Shifts edge domain routing to target deployment snapshot.
  - Automatically invokes `purgeEdgeCache({ all: true })`.
- `syncVariables(serviceId: string, variables: Record<string, string>, mode: "merge" | "overwrite")`
- `purgeEdgeCache(options: { domain?: string, path?: string, tag?: string, all?: boolean })`

## Code Layout
- `src/app/`: Next.js 14 App Router routes and pages
  - `src/app/dashboard/`: Dashboard views (`/dashboard`, `/dashboard/projects`, `/dashboard/databases`, `/dashboard/team`, `/dashboard/settings`)
  - `src/app/pricing/`: Public pricing engine and comparison matrix
  - `src/app/invite/[token]/`: Secure team invitation acceptance page
  - `src/app/auth/`: Sign-in and authentication pages
- `src/components/`: Reusable UI components (Sidebar, Topbar, Modals, ComparisonTable)
- `src/lib/`: Core libraries (auth, prisma, edge router, devops)
  - `src/lib/auth.ts`: NextAuth configuration
  - `src/lib/edge/`: Edge POP routing, caching, and cache purging
  - `src/lib/devops/`: Buildpack engine, WAF, metrics, rollback
- `src/server/routers/`: tRPC backend routers (`workspace.ts`, `project.ts`, `deployment.ts`, `service.ts`, `devops.ts`)
- `prisma/schema.prisma`: Prisma schema and SQLite database definitions
- `tests/e2e/`: E2E test suite runners and test files
