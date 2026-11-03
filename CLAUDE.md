@AGENTS.md

# Syncbay — Agent Guide

Syncbay (`syncbay.app`) is a hybrid-compute PaaS. The **control plane** is a Next.js 16 App Router app (tRPC 11, Prisma 5 / PostgreSQL, NextAuth v4). It runs on Vercel. The **data plane** is a standalone runner daemon (`runner/`) that clones, builds and runs customer services on any Linux host, exposed through Cloudflare Tunnels.

## Commands

| Task | Command |
| --- | --- |
| Dev server | `npm run dev` |
| Prisma client | `npx prisma generate` |
| Type-check | `npm run typecheck` (`tsc --noEmit`) |
| Dead code | `npm run knip` (config: `knip.json`) |
| Lint | `npm run lint` |
| Production build | `npm run build` (prisma generate + `next build --webpack`) |
| Runner build / test | `cd runner && npm install && npm run build && npm test` |
| Focused verifications | `npm run test:fallback`, `npm run test:tunnel` (tsx scripts under `tests/`, mocked DB) |

All five gates (prisma generate, typecheck, knip, lint, build) must pass before a change is merged. CI enforces them in `.github/workflows/ci.yml`.

## Architecture map

### Orchestration — `src/lib/orchestrator/`
- **`engine.ts` → `executeDeployment()`.**
  - Loads service, variables and environment databases, resolves `${{ ref }}` variables (`src/lib/buildpack/resolver.ts`), registers the route as `BUILDING` → `DEPLOYING` → `ACTIVE`/`FAILED`, and dispatches the job to a runner driver.
  - Runtime detection (`src/lib/buildpack/detector.ts`, nixpacks plans) happens on the runner. The engine relays every log line to `logEventBus` (`src/lib/telemetry/event-bus.ts`) and classifies it as `stderr` (`[build:error]`, `[app:error]`, `Error:` …), `system` (`[pipeline]`, `[runner]`, `[health]` … prefixes) or `stdout`.
  - After an `ACTIVE` result it probes `/health`, then `/`, on the allocated port. Failed remote dispatches (for example Cloudflare HTTP 530) fall back to the local driver unless `RUNNER_FORCE_REMOTE=true`.
  - `src/lib/buildpack/knip-analyzer.ts` is Syncbay's built-in static analysis of customer repos. It is separate from the repo's own `knip` gate.
- **`runner-driver.ts` (`getRunnerDriver()`).** Picks a driver from `RUNNER_DRIVER` / `RUNNER_URL`:
  - `WebhookRunnerDriver`: HTTP to the runner daemon. Requests are signed HMAC-SHA256 (`X-Syncbay-Signature`, `X-Syncbay-Timestamp`) with `RUNNER_SECRET`, and transient Cloudflare/5xx errors are retried.
  - `SshRunnerDriver`: runs the pipeline on a remote host over SSH (`RUNNER_SSH_*`).
  - `QueueRunnerDriver`: a DB-backed job queue for long builds.
  - `LocalRunnerDriver`: imports `runner/src/pipeline.ts` in-process (local dev / single host).
- **`pr-manager.ts`.** Handles GitHub `pull_request` webhooks:
  - Creates an ephemeral `pr-<n>` environment, service and `<svc>-pr-<n>.syncbay.app` domain, with scale-to-zero (`idleTimeoutSecs: 1800`).
  - Posts `syncbay/preview` commit statuses and a preview comment.
  - Sleeps or destroys the environment when the PR is closed.

### API — `src/server/`
- `trpc.ts` defines `publicProcedure` and `protectedProcedure` (a session is required). Routers are composed in `root.ts`. Every mutation must use `protectedProcedure` and check workspace membership.
- `routers/deployment.ts` → `redeploy`:
  - `rebuild: false` is the fast redeploy. It reuses the previous successful build record and keeps caches.
  - `rebuild: true` is the clean rebuild. It creates a new Build and sends `cleanBuild: true`. The runner then purges `node_modules`, `dist`, `.next`, `build` and `out`, and passes `--no-cache` to Docker/Nixpacks.
- The REST API lives at `src/app/api/v1/*` (token auth via `src/lib/api/auth-token.ts`, OpenAPI at `/api/v1/openapi.json`).

### Runner daemon — `runner/`
- `src/index.ts` (`RunnerDaemon`):
  - Unauthenticated: `/health` and `/api/tunnel/status`.
  - HMAC-protected: `POST /api/builds`, `GET /api/builds/:id[/logs]` (JSON or SSE) and `POST /api/containers/:id/stop`.
  - Any other request is reverse-proxied to the service port in `x-target-port`.
  - After a deploy it registers routes back to the control plane (`/api/v1/services/edge-register`).
- `src/pipeline.ts`:
  - `BuildPipeline` clones, detects the strategy (Docker → Nixpacks → native), builds, then starts the app on a port from `PortManager` (`src/port-manager.ts`, range 10000–60000).
  - A 25-line `stderr` buffer captures startup crashes. If the process exits before `/health` answers, the job fails with that trace and the exit code.
  - `MockPipelineExecutor` simulates builds in serverless environments, where git and docker are unavailable.
- `src/tunnel-driver.ts` runs `cloudflared` (token or quick-tunnel), a local proxy, or an SSH reverse tunnel. Its counterpart, `src/lib/tunnel/tunnel-config.ts`, generates `cloudflared` ingress for `<subdomain>.syncbay.app`.
- Imports inside `runner/` use explicit `.ts` extensions. They run under Node type-stripping or `tsx`, and `tsc` rewrites them to `.js` in `dist/`.

### Edge routing
- `src/lib/edge/service-registry.ts` is a two-tier registry mapping a hostname to `{ targetPort, status, upstreamUrl, isLocal }`. Hosts are normalised case-insensitively.
  - **L1** is a per-process Map. `ACTIVE` routes live 15 s, every other status 2 s (so `BUILDING` → `ACTIVE` shows up quickly), and misses are negatively cached for 5 s.
  - **L2** is an `L2Store` chosen by `getL2Store()`:
    - `UpstashRestStore`: plain `fetch` to `UPSTASH_REDIS_REST_URL` with Bearer `UPSTASH_REDIS_REST_TOKEN`. It stores JSON at `syncbay:edge:route:<host>` (`SET … EX` 7 d) and keeps an index set `syncbay:edge:routes`.
    - `DbResolveStore`: read-only, backed by `resolveServiceRouteFromDb()` in `src/lib/edge/resolve.ts`, the same lookup `/api/v1/services/edge-resolve` uses. Platform hosts use the subdomain heuristics. Custom domains need an exact, `ACTIVE` `Domain` row.
    - `MemoryStore`: used when neither is configured. When Upstash and `DATABASE_URL` are both set, an Upstash miss falls through to the DB.
  - Writers (`engine.ts`, the `domain` router, `edge-register`) call `registerServiceRouteAsync` / `removeServiceRouteAsync`, which write through to L2 and never throw.
  - Readers call `resolveServiceRoute`: a fresh L1 hit, otherwise L2 hydration, with lookups single-flighted per host. If L2 errors, the stale L1 entry is served.
  - The sync `registerServiceRoute` / `getServiceRoute` / `removeServiceRoute` are L1-only and kept for tests and in-process callers.
- `src/proxy.ts` is the Next 16 Proxy. It runs on the Node runtime and exports `proxy`; `middleware.ts` is deprecated.
  - **Bypass list:** `/api/trpc`, `/api/auth`, `/api/webhooks`, `/api/deployments`, the `edge-resolve`/`edge-register`/`wake` APIs and `/service-preview` are never rewritten.
  - **Control-plane hosts pass through:** `syncbay.app`, `www.`, `cname.`, `localhost`, any IP, `*.vercel.app`, and the `NEXTAUTH_URL` / `VERCEL_*` hosts.
  - **Service hosts:** `*.syncbay.app`, `*.localhost`, and any other host only if it resolves as a registered route (a custom domain).
  - It rewrites `ACTIVE` services to their upstream, or to `RUNNER_URL` with `x-target-port` unless `isLocal`. It answers `/health` with 200/503/502 and sends non-active services to the splash page.
- `/api/v1/services/edge-register` (POST/DELETE) accepts `{ hostname, targetPort, status, upstreamUrl, isLocal }`.
  - Auth is Bearer `RUNNER_SECRET` / `SYNCBAY_WEBHOOK_SECRET`.
  - In production it returns 401 when neither secret is set.
- `src/app/service-preview/[subdomain]/page.tsx` is the cold-start splash.
  - An unknown status renders as `BUILDING`.
  - It streams build logs over SSE from `/api/deployments/:id/logs/stream`. That route also polls the DB every 2 s and emits an `event: status` when the deployment status changes.
  - It polls `/health` every 1.5 s, stops probing on success, and reloads into the live app.
  - The wake button POSTs to `/api/v1/services/wake`. The caller must be a workspace member session or send Bearer `RUNNER_SECRET`. The endpoint re-runs the sleeping service's latest deployment through `executeDeployment` (via `after()`) and returns 202.

### Other modules
- Auth: `src/lib/auth.ts` (Google, GitHub with `repo` scope, credentials/bcrypt; JWT sessions with the Prisma adapter).
- Email: `src/lib/email/` (Resend + React Email templates; it logs instead of sending when `RESEND_API_KEY` is unset).
- Domains and Cloudflare: `src/lib/domain-service.ts`, `src/lib/tunnel/cloudflare-api.ts`.
- Managed DBs and buckets: `src/lib/database-provider.ts`, `src/lib/storage-provider.ts`.
- Web shell: `src/lib/shell/web-shell.ts`.

## Conventions
- Next.js 16 differs from older versions. Read `node_modules/next/dist/docs/` before using framework APIs.
- Keep `tests/**` out of the app's tsconfig. Tests run via `tsx` with a mocked `globalThis.prisma`.
- Branding is **Syncbay** / `syncbay.app` only.
- Every new env var goes into `.env.example`.
