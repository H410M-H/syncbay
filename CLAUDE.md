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
| Focused verifications | `npm run test:fallback`, `test:tunnel`, `test:edge`, `test:email`, `test:db`, `test:terminal` (tsx scripts under `tests/`, mocked DB); `test:terminal-stateless`, `test:domains` (need `DATABASE_URL`; real Postgres, Docker, DNS stub); `test:observe` (real Postgres + runner); `test:deploy` needs a real `DATABASE_URL` and starts runner daemons on 41100/41101; `test:billing` (`TEST_DATABASE_URL`, optional `TEST_STRIPE_MOCK_URL`) and `test:r2` (optional `TEST_S3_ENDPOINT`/`TEST_S3_ACCESS_KEY_ID`/`TEST_S3_SECRET_ACCESS_KEY`, `TEST_DATABASE_URL`) |

All five gates (prisma generate, typecheck, knip, lint, build) must pass before a change is merged. CI enforces them in `.github/workflows/ci.yml`.

## Architecture map

### Orchestration — `src/lib/orchestrator/`
- **`engine.ts` → `executeDeployment()`.**
  - Loads service, variables and environment databases, resolves `${{ ref }}` variables (`src/lib/buildpack/resolver.ts`), registers the route as `BUILDING` → `DEPLOYING` → `ACTIVE`/`FAILED`, and dispatches the job to a runner driver.
  - Runtime detection (`src/lib/buildpack/detector.ts`, nixpacks plans) happens on the runner. The engine relays every log line to `logEventBus` (`src/lib/telemetry/event-bus.ts`) and classifies it as `stderr` (`[build:error]`, `[app:error]`, `Error:` …), `system` (`[pipeline]`, `[runner]`, `[health]` … prefixes) or `stdout`.
  - After an `ACTIVE` result it probes `/health`, then `/`, on the allocated port (through `RUNNER_URL` + `x-target-port` for webhook runners). The probe is skipped only when the runner reports `metadata.simulated`, or for a pull-mode runner without `RUNNER_URL` (it probed itself).
  - Call sites never fire-and-forget: they call `scheduleDeployment()` (`schedule.ts`), which writes a `DeploymentJob` row and runs the engine in `after()` (routes export `maxDuration = 300`). Polling stops after `DEPLOY_POLL_BUDGET_MS` (240 s) and hands off; `recoverStaleDeployments()` (`recovery.ts`, called from the cron) resumes lapsed orchestrator leases (`options.resume`), requeues expired runner leases and fails legacy stuck deployments.
  - On ACTIVE, `onDeploymentActive()` (`lifecycle.ts`) records `assignedPort`/`runnerDriver`, marks older live deployments `SUPERSEDED` and stops their instances, and reports the PR preview status. `lifecycle.ts` also implements real pause / delete / restart / rollback (`stopServiceInstances`, `restartServiceInstance`, `rollbackToDeployment`). `stopServiceInstances` is the single stop path: scale-to-zero's `stopServiceToSleep()` delegates to it. Every stop, restart and rollback ends with `requestTunnelReload()`. The cron reaches `recoverStaleDeployments()` through `src/lib/crons/recovery-hook.ts` (direct import).
  - No invented commit SHAs: HEAD is resolved through Octokit (`resolveHeadCommitSha`) or left null.
  - Failed remote dispatches (for example Cloudflare HTTP 530) fall back to the local driver. `RUNNER_FALLBACK_LOCAL=false` (default `true`) or `RUNNER_FORCE_REMOTE=true` disables this. An `AuthenticationError` never falls back.
  - When status polling reports `exitCode`, the engine appends it to the recorded error (`… (exit code N)`).
  - A failure is persisted in `Deployment.errorMessage` (cleared on ACTIVE); routers prefer it over the in-process `logEventBus.getError()`. The engine awaits `logEventBus.flush()` before returning.
  - `src/lib/buildpack/knip-analyzer.ts` is Syncbay's built-in static analysis of customer repos. It is separate from the repo's own `knip` gate.
- **`runner-driver.ts` (`getRunnerDriver()`).** Picks a driver from the explicit type, then `RUNNER_DRIVER` (`webhook` | `ssh` | `queue` | `local` | `mock`), then `RUNNER_URL`:
  - `signRequest()` signs `${ts}.${nonce}.${METHOD}.${path}.${body}` with HMAC-SHA256 into `X-Syncbay-Signature: sha256=<hex>`, `X-Syncbay-Timestamp` and `X-Syncbay-Nonce` (16 random bytes, hex). `path` is the API pathname, and GET requests sign the job id as the body. Every retry is re-signed with a fresh timestamp and nonce.
  - `resolveRunnerSecret()` reads `RUNNER_WEBHOOK_SECRET` → `RUNNER_SECRET` → `SYNCBAY_WEBHOOK_SECRET`. With `NODE_ENV=production` and no secret it throws `AuthenticationError`; only dev falls back to a default secret.
  - Webhook and SSH requests retry with exponential backoff and jitter (500 ms·2^n, capped at 8 s, 4 attempts). Webhook retries on transient Cloudflare/gateway statuses and network errors; SSH retries on exit 255 (connection failure).
  - Drivers log through `emitLog()`. It passes lines to `params.onLog` when one is given (the engine's handler publishes to `logEventBus`); otherwise it publishes to `logEventBus` directly.
  - `WebhookRunnerDriver`: HTTP to the runner daemon.
  - `SshRunnerDriver`: runs containers on a remote host over SSH (`RUNNER_SSH_*`), with `RUNNER_SECRET` exported in the remote command environment.
  - `QueueRunnerDriver` (`RUNNER_QUEUE_MODE=pull`): queues the job in `DeploymentJob` (`job-queue.ts`). Runners claim it with HMAC `POST /api/v1/runner/jobs/claim` (`FOR UPDATE SKIP LOCKED`) and report logs, heartbeats and the result to `POST /api/v1/runner/jobs/:id/events`. Stop and restart become control jobs routed to the hosting runner.
  - `LocalRunnerDriver`: imports `runner/src/pipeline.ts` in-process (local dev / single host). `RUNNER_DRIVER=mock` uses it with `MockPipelineExecutor`.
- **`src/lib/tunnel/tunnel-config.ts`.**
  - `generateTunnelConfig()` produces YAML and `generateTunnelConfigJson()` produces the Cloudflare `PUT /accounts/{acct}/cfd_tunnel/{id}/configurations` body (`{ config: { ingress } }`). `writeTunnelConfig()` writes atomically (temp file + rename).
  - `reloadTunnel()` PUTs the config through `CloudflareApiClient.updateTunnelConfiguration()` when `CLOUDFLARE_TUNNEL_ID`, `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are all set. Otherwise it writes `TUNNEL_CONFIG_FILE` and runs `TUNNEL_RESTART_COMMAND` (default `systemctl restart cloudflared`), because cloudflared has no SIGHUP reload.
  - `src/lib/tunnel/tunnel-sync.ts` → `requestTunnelReload(reason)` rebuilds the full ingress table from the DB (non-paused services with an ACTIVE deployment + port, default host and ACTIVE domains → `http://127.0.0.1:<port>`, catch-all `TUNNEL_FALLBACK_SERVICE`), debounced (`TUNNEL_RELOAD_DEBOUNCE_MS`, 300 ms), serialised with `pg_advisory_xact_lock`, never throws, and is a no-op without a tunnel (`CLOUDFLARE_TUNNEL_ID` + API creds, or + `TUNNEL_CONFIG_FILE`). Called after deploy ACTIVE (engine), deployment delete, and domain verify/delete; call it from any new stop/pause/delete path.
- **`pr-manager.ts`.** Handles GitHub `pull_request` webhooks:
  - Creates an ephemeral `pr-<n>` environment, service and `<svc>-pr-<n>.syncbay.app` domain, with scale-to-zero (`idleTimeoutSecs: 1800`).
  - Posts a `pending` `syncbay/preview` commit status and comment; the engine updates both to success/failure (`reportPreviewDeploymentStatus`). Tokens come from env, the triggering user or a workspace member, never an unrelated account.
  - Sleeps or destroys the environment when the PR is closed.

### API — `src/server/`
- `trpc.ts` defines `publicProcedure` and `protectedProcedure` (a session is required). Routers are composed in `root.ts`. Every mutation must use `protectedProcedure` and check workspace membership.
- `routers/deployment.ts` → `redeploy`:
  - `rebuild: false` is the fast redeploy. It reuses the previous successful build record and keeps caches.
  - `rebuild: true` is the clean rebuild. It creates a new Build and sends `cleanBuild: true`. The runner then purges `node_modules`, `dist`, `.next`, `build`, `out`, `.turbo` and `.cache`, and passes `--no-cache` to Docker/Nixpacks.
- The REST API lives at `src/app/api/v1/*` (token auth via `src/lib/api/auth-token.ts`, OpenAPI at `/api/v1/openapi.json`).

### Runner daemon — `runner/`
- `src/index.ts` (`RunnerDaemon`):
  - Unauthenticated: `/health` and `/api/tunnel/status`.
  - HMAC-protected: `POST /api/builds`, `GET /api/builds/:id[/logs]` (JSON or SSE), `POST /api/containers/:id/stop`, `POST /api/containers/:id/restart` (re-launches from the kept launch spec on the same port; also revives a stopped instance for rollback) and `GET /api/metrics/:containerId`.
  - Any request with `x-target-port` is proxied to the app before the daemon's own routes.
  - `RUNNER_QUEUE_MODE=pull` + `SYNCBAY_API_URL` starts `JobPullConsumer` (`src/job-consumer.ts`, `RUNNER_ID`, `RUNNER_POLL_INTERVAL_MS`); its claim/events calls are signed with the same nonce scheme.
  - Signatures must match `signRequest()`'s canonical string (`runner/src/request-auth.ts`). Every signed request, of any method, is single-use: accepted nonces are cached for the ±5 min window, so a replay gets 401. New routes must verify through `verifySignedHeaders()` / `verifySignedRequest()` (which consume the nonce), not the pure `verifySignature()`.
  - Query-string `sig`/`ts`/`nonce` is accepted only on the SSE route `GET /api/builds/:id/logs` with `Accept: text/event-stream`, and it is bound to that path.
  - `src/metrics.ts` serves `/api/metrics/:id` (verified by `verifySignedRequest()`, GET payload = pathname, like `services.ts`): `docker stats --no-stream` for containers, `/proc/<pid>/stat` + `status` summed over the process group for `proc_<pid>` native apps (no network counters for those).
  - `GET /api/builds/:id` returns `exitCode` and `simulated`.
  - The secret comes from `RUNNER_SECRET`. In production the daemon refuses to start without one.
  - Any other request is reverse-proxied to the service port in `x-target-port`.
  - After a deploy it registers routes back to the control plane (`/api/v1/services/edge-register`) and adds `<host> → http://127.0.0.1:<port>` tunnel ingress. A stop removes it.
- `src/pipeline.ts`:
  - `BuildPipeline` clones, detects the strategy (Docker → Nixpacks → native), builds, then starts the app on a port from `PortManager` (`src/port-manager.ts`, range 10000–60000). `PipelineResult.exitCode` is 0 on success, otherwise the exit code of the failing step or of the crashed app.
  - A fast redeploy (`cleanBuild: false`) reuses an existing clone with `git fetch` + `git checkout -f FETCH_HEAD`.
  - A clean rebuild re-clones, purges `node_modules dist .next build out .turbo .cache` (logging each path) and passes `--no-cache`.
  - A 25-line `stderr` ring buffer (split into lines) captures startup crashes. If the process exits before `/health` answers, the job fails with that trace and the exit code.
  - `MockPipelineExecutor` is used only when `RUNNER_DRIVER=mock`, or when serverless (`VERCEL` / `AWS_LAMBDA_FUNCTION_NAME`) without `RUNNER_URL`. It is also a fallback, with a warning, when git is missing.
- `src/tunnel-driver.ts` runs `cloudflared` (token, quick-tunnel or config-file mode), a local proxy, or an SSH reverse tunnel.
  - Config-file mode (`TUNNEL_CONFIG_FILE` + `CLOUDFLARE_TUNNEL_ID`, optional `TUNNEL_CREDENTIALS_FILE`) runs `cloudflared tunnel --config <file> run`.
  - In that mode `updateIngress()` rewrites the YAML atomically (`src/tunnel-config.ts`, a mirror of the control plane generator) and restarts cloudflared. Unknown hosts fall through to the daemon.
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
  - For `ACTIVE` routes it calls `recordServiceRequest(host)` (`src/lib/scale/activity.ts`, via `event.waitUntil`): debounced 30 s per host, written to Upstash `syncbay:edge:last:<host>` when configured, else `Service.lastRequestAt`.
- `/api/v1/services/edge-register` (POST/DELETE) accepts `{ hostname, targetPort, status, upstreamUrl, isLocal }`.
  - Auth is Bearer `RUNNER_SECRET` / `SYNCBAY_WEBHOOK_SECRET`.
  - In production it returns 401 when neither secret is set.
- `src/app/service-preview/[subdomain]/page.tsx` is the cold-start splash.
  - An unknown status renders as `BUILDING`.
  - It streams build logs over SSE from `/api/deployments/:id/logs/stream` (session + workspace membership required; anonymous visitors get 401 and no logs). The route (`src/lib/telemetry/log-stream.ts`) replays `DeploymentLog` rows, then follows the in-process bus plus a DB tail every 2 s (cross-instance), and proxies the runner's signed `GET /api/builds/:id/logs` SSE when neither has lines. It never synthesises history. It also emits `event: status` when the deployment status changes.
  - It polls `/health` every 1.5 s, stops probing on success, and reloads into the live app.
  - The wake button POSTs to `/api/v1/services/wake`. The caller must be a workspace member session or send Bearer `RUNNER_SECRET`. The endpoint re-runs the sleeping service's latest deployment through `executeDeployment` (via `after()`) and returns 202.

### Observability, usage and scale-to-zero (crons)
- `logEventBus` (`src/lib/telemetry/event-bus.ts`) keeps a 1000-line ring buffer per deployment as a cache and batches every line into `DeploymentLog` (`src/lib/telemetry/log-store.ts`; flush at 250 ms or 200 lines, retried with backoff, only when `DATABASE_URL` is set). No `.runner_logs` files.
- `/api/deployments/:id/metrics/stream` (session + membership) and `metrics.live` read the runner live (`fetchContainerMetrics()`; in-process collector when there is no `RUNNER_URL` and not serverless), else the newest `MetricSample`. `metrics.historical` buckets stored samples (`date_bin`). No random or sine data.
- `vercel.json` crons, both `GET` with `Authorization: Bearer $CRON_SECRET` (`src/lib/crons/cron-auth.ts`, timing-safe; unset secret is allowed only outside production):
  - `/api/cron/tick` (every minute): `recoverStaleDeployments()` from `src/lib/orchestrator/recovery.ts` through a webpack `require.context` hook (`src/lib/crons/recovery-hook.ts`), plus `sampleActiveServices()` → `MetricSample`.
  - `/api/cron/sweep` (every 15 min): `sleepIdleServices()` (`src/lib/scale/idle-sleeper.ts`), `writeUsageRecords()` and `enforceSpendingCaps()` (`src/lib/usage/metering.ts`), `runMonthlyInvoicingIfDue()` (`src/lib/billing/invoicing.ts`: previous month's invoices, only on the 1st from 02:00 UTC, idempotent), and retention (logs 30 d, samples 35 d).
- Idle sleep: services with `scaleToZero` whose latest deployment is ACTIVE and whose last activity (last request, deploy completion, docker inbound traffic) is older than `idleTimeoutSecs` are stopped via the runner driver, marked SLEEPING, routed to the splash and dropped from the tunnel ingress via `requestTunnelReload()` (`src/lib/scale/service-control.ts`).
- Usage: one `UsageRecord` per service, resource and completed hour (`CPU_ACTIVE_SECONDS` = vCPU-seconds, `MEMORY_GIB_HOURS`, `EGRESS_GB`; upsert on the new unique key). `workspaceUsage` is month-to-date (UTC). At 80 % of `spendingCapCents` owners/admins get the usage-warning email, at 100 % every running service is paused and they get the billing alert (once per month each, `Workspace.usageWarnedAt` / `spendCapReachedAt`). The wake endpoint answers 402 while the cap is reached.
- `npm run test:observe` (`tests/verify-observability.ts`) needs a migrated Postgres (`TEST_DATABASE_URL` or `DATABASE_URL`) and starts a real runner daemon on port 42110.

### Other modules
- Auth: `src/lib/auth.ts` (Google, GitHub with `repo` scope, credentials/bcrypt; JWT sessions with the Prisma adapter). In production `src/lib/auth-cookies.ts` scopes the session cookie to `AUTH_COOKIE_DOMAIN` (default `.syncbay.app` when `NEXTAUTH_URL` is on syncbay.app; `none` disables) so service hosts send it to the wake endpoint.
- Email: `src/lib/email/` (Resend + React Email templates; it logs instead of sending when `RESEND_API_KEY` is unset).
- Domains and Cloudflare: `src/lib/domain-service.ts`, `src/lib/tunnel/cloudflare-api.ts`.
  - `verifyDomainDetailed()` resolves `TXT _syncbay-challenge.<host>` and the CNAME to `CLOUDFLARE_CNAME_TARGET` (or flattened A records) with `node:dns/promises`; missing records keep `VERIFYING`. With `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ZONE_ID` the custom hostname and certificate must also be `active`. Nothing is simulated in production (`CloudflareNotConfiguredError`), and live API errors are thrown, not simulated.
  - A verified domain copies the service's live route (`src/lib/edge/domain-upstream.ts`). `purgeEdgeCache()` calls Cloudflare `purge_cache` when zone + token are set, else returns `configured: false`. The static POP list is illustrative (`illustrative: true`).
- Managed DBs and buckets: `src/lib/database-provider.ts`, `src/lib/storage-provider.ts`.
  - With `RUNNER_URL` set, Postgres and Redis are provisioned as `postgres:16-alpine`/`redis:7-alpine` containers on the runner (`runner/src/services.ts`: `/api/databases`, health via `pg_isready`/`redis-cli ping`). Without it, and for MySQL, a mock `sb-db-*` instance is created. `DatabaseInstance.status` tracks PROVISIONING → ACTIVE/UNHEALTHY/FAILED/DELETING.
  - Buckets are real Cloudflare R2 buckets (`src/lib/storage-provider.ts`). Create/delete go through the R2 API (`src/lib/storage/r2-api.ts`, `/accounts/{CLOUDFLARE_ACCOUNT_ID}/r2/buckets`, Bearer `CLOUDFLARE_API_TOKEN`). Delete empties the bucket first. Object listing and presigned GET/PUT use `@aws-sdk/client-s3` at `https://<acct>.r2.cloudflarestorage.com` with `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`. `R2_ENDPOINT` overrides the endpoint for any S3-compatible server; buckets are then created through S3 `CreateBucket`. With no keys every remote call throws `StorageNotConfiguredError` (fail closed). Buckets are private (`publicUrl: null`) and no per-bucket credentials are minted.
  - `<NAME>_URL` and `DATABASE_URL` (Postgres) or `REDIS_URL` (Redis) are persisted on existing services when the DB is created. `engine.ts` also merges them in at deploy time (`applyDatabaseEnv`) without overriding user keys. Delete removes rows still pointing at the DB. Signed runner calls go through `src/lib/runner-client.ts`.
- Billing (Stripe): `src/lib/billing/`.
  - No card data ever reaches Syncbay. Cards are added through `billing.createSetupIntent` → Stripe Elements `confirmSetup` in the browser (`src/components/billing/stripe-card-setup.tsx`) → `billing.confirmSetupIntent`. That call verifies the SetupIntent and PaymentMethod belong to the workspace's Stripe customer, then stores only the `pm_…` id plus brand, last4 and expiry. Every billing input schema is `.strict()`, so any unexpected key (a card number, for example) is a 400.
  - Saved cards are listed from Stripe and the local rows are reconciled against that list. Top-ups are PaymentIntents. Credits are granted exactly once, when Stripe reports `succeeded` (via the webhook or `billing.syncTopUp`); a conditional status flip in one transaction guarantees this.
  - `buildMonthlyInvoices(periodStart)` (`invoicing.ts`) prices `UsageRecord` with `pricing.ts` (the single rate card, also used by `metering.ts` and the usage page), applies prepaid credits and issues a finalized Stripe Invoice. It is idempotent on `(workspaceId, periodKey)`. `pdfUrl` is the Stripe hosted invoice or receipt URL.
  - `POST /api/webhooks/stripe` verifies `Stripe-Signature` on the raw body with `STRIPE_WEBHOOK_SECRET` and returns 503 when unconfigured. It handles `payment_intent.*`, `setup_intent.succeeded` and `invoice.paid`/`payment_failed`, idempotent per event id (`StripeEvent`).
  - Without `STRIPE_SECRET_KEY` billing is explicitly "not configured": mutations return PRECONDITION_FAILED and the UI disables payments. `STRIPE_API_BASE` points the SDK at stripe-mock or another emulator.
- Web shell: `src/components/dashboard/web-shell.tsx` → `POST /api/services/:id/terminal` (create, or `{sessionId,input}`) + SSE `/api/services/:id/terminal/stream`, with session auth and workspace membership. The control plane is stateless: `sessionId` is a token signed with `TERMINAL_TOKEN_SECRET` (`src/lib/shell/terminal-token.ts`, `{sid, mode, runnerSessionId, serviceId, userId, exp}`; production returns 503 without the secret). Runner sessions proxy to runner `/api/terminals` (`docker exec -i <container> sh` or `sh` in the job workspace, under `script -qfc`). Without a runner the simulated `src/lib/shell/web-shell.ts` keeps cwd, env overrides, history and the masked buffer in a `TerminalSession` row (optimistic `version` writes; the SSE stream polls it; 10 min idle). Output masks `isSecret` values and URL credentials.

## Conventions
- Next.js 16 differs from older versions. Read `node_modules/next/dist/docs/` before using framework APIs.
- Keep `tests/**` out of the app's tsconfig. Tests run via `tsx` with a mocked `globalThis.prisma`.
- Branding is **Syncbay** / `syncbay.app` only.
- Every new env var goes into `.env.example`.
