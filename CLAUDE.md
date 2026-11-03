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
- `src/lib/edge/service-registry.ts` maps a hostname to `{ targetPort, status, upstreamUrl, isLocal }` and normalises hosts case-insensitively.
- `src/middleware.ts` (Next 16 "proxy"):
  - Matches `*.syncbay.app` and `*.localhost` service hosts.
  - On a registry miss it resolves the route through `/api/v1/services/edge-resolve`, which uses Prisma.
  - It rewrites `ACTIVE` services to their upstream (or to `RUNNER_URL` with `x-target-port`), and answers `/health` with 200/503/502.
  - Non-active services are sent to the splash page.
- `src/app/service-preview/[subdomain]/page.tsx` is the cold-start splash. It shows the status badge, streams live build logs over SSE from `/api/deployments/:id/logs/stream`, and polls `/health` every 1.5 s, reloading into the live app once the service turns `ACTIVE`.

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
