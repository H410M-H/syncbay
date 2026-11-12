# Syncbay Roadmap

## Completed
- [x] **M1–M6** Core platform, which includes:
  - PR preview pipeline
  - runner drivers (Webhook / Queue / SSH / Local)
  - runner daemon and port allocator
  - tunnel ingress generator
  - edge registry and middleware
  - Knip customer-repo analyzer
  - cold-start splash
  - E2E suites
- [x] **M7** Deployment logs sync, auto-deploy webhook, dashboard UX
- [x] **M8** Global Edge Tunnel & Custom Domain Ingress, plus the HTTP 530 resilient local fallback
- [x] Google sign-in and generated-hostname resolution (PR #10)
- [x] **v1.0 Baseline**, which includes:
  - repository-level `knip` gate (`knip.json`)
  - runner `build` script with `.ts`-extension ESM imports
  - lint baseline at 0 errors
  - dead-code purge
  - invitation emails wired to Resend
  - Syncbay-only branding
  - rewritten CLAUDE.md / README.md

## Completed — v1.0 Sprint
- [x] **Persistent edge registry.** Two-tier registry: an L1 TTL Map plus an L2 Upstash REST store, falling back to the DB. Migrate `middleware.ts` → `proxy.ts`. Fix preview auto-refresh on the BUILDING/SLEEPING → ACTIVE transition.
- [x] **Runner and tunnel fabric.** Signed requests with fresh timestamps, exponential backoff, logs published to `logEventBus`, and exit codes surfaced. Use the mock executor only in serverless environments. Generate cloudflared YAML/JSON ingress with a reload hook.
- [x] **Managed databases and terminal.** Postgres and Redis containers on the runner, health checks, `DATABASE_URL`/`REDIS_URL` auto-injection, and an SSE/POST web terminal with a simulated fallback.
- [x] **CI/CD and environment validation.** GitHub Actions CI, OAuth callback hardening for Vercel previews, a React Email build check, and a complete `.env.example`.

## Completed — v1.1 (backend de-mocked)
- [x] Stateless web terminal: signed session tokens, `TerminalSession` rows; works across Vercel instances
- [x] `requestTunnelReload()` rebuilds cloudflared ingress from the DB after every deploy, stop, sleep, domain change
- [x] Single-use nonces on every signed runner request (GET replay closed)
- [x] Session cookie scoped to `.syncbay.app` (`AUTH_COOKIE_DOMAIN`) so the wake button works on service hosts
- [x] `PROJECT.md` rewritten to the current architecture
- [x] Real `/health` probing on Vercel; durable deploys (`DeploymentJob` + `after()` + cron recovery); pull-mode runners
- [x] Supersede/stop on redeploy; real pause, delete, restart, rollback; PR commit status success/failure
- [x] Persistent deployment logs, real runner metrics, hourly usage metering, spending caps, scale-to-zero crons
- [x] Real DNS domain verification; Cloudflare calls fail closed in production; real cache purge
- [x] Stripe SetupIntents/PaymentIntents/invoices/webhooks (no card data on Syncbay); real R2 buckets
- [x] DB-backed cron jobs, WAF (enforced in `proxy.ts`), canary routing; real Query Studio (read-only by default)
- [x] Runner-native Postgres/Redis provisioning without Docker; volume mounts

## Completed — v1.2 (operations)
- [x] Runner configuration preflight with actionable errors; project actions (redeploy/pause/resume/rename/delete)
- [x] Live dashboard analytics and per-deployment traffic counters (`TrafficSample`); canary rollback uses real 5xx data
- [x] Runner image ships `docker buildx` and repairs a missing plugin itself; secrets redacted from logs

## Completed — v1.3 (availability and build reliability)
- [x] **Always-on by default.** `scaleToZero` defaults to off; the every-minute cron starts a sleeping always-on service again (`src/lib/scale/always-on.ts`)
- [x] **One owner per hostname.** A service routes only its own `Domain` rows; a second service with the same name and environment gets a suffixed host (`src/lib/domains/`)
- [x] **Zero-downtime deploys.** The live version keeps its route while a new one builds and after a failed release (engine, DB resolver)
- [x] **App port vs host port.** `Service.port` is the app's port; `Deployment.assignedPort` is the runner's host port and drives routing and tunnel ingress
- [x] **Runner start-up checks.** 120 s health window, crash detection with the container's output, detection of the port an app really listens on, hint for apps bound to 127.0.0.1
- [x] **Readable build failures.** Errors carry the end of the build output; Node 22 for unpinned Nixpacks projects; at most 2 builds at once
- [x] **Secrets stay out of commands.** Environment values travel in the CLI's process environment, never on a command line or in a log; git never sees service variables
- [x] **Private database networking.** Apps reach a database on the same runner through the Docker bridge; the registry of databases survives a runner restart; optional `RUNNER_DB_PORT_RANGE`
- [x] Repository cleanup: stale planning files, generated graph output and a committed tunnel script removed

## Completed — v1.4 (staff console and security)
- [x] Syncbay session cookies are stripped from traffic forwarded to customer apps (edge and runner); workspace endpoints no longer return password hashes
- [x] Staff console `/admin`: roles (super admin, admin, support, moderator, billing, viewer), reason-gated actions, append-only staff audit, `SUPER_ADMIN_EMAILS` bootstrap
- [x] Customer 360 (search by email/slug/host/Stripe id, notes, lifecycle, tags), workspace and user suspension, service take-down, public abuse reports and moderation queue
- [x] Unattended deploys use a working GitHub token of the project's workspace; log streams end before the 300 s function limit and resume
- [x] pgAdmin over an SSH tunnel documented in the Databases page

## Next
- [ ] Staff console: separate staff session and passkeys; "suspended" page and customer emails with appeals; runner host cost registry and margin; dunning and refunds; automatic abuse signals (Web Risk, crypto-mining); CSV exports
- [ ] Per-environment Docker networks so tenants on one runner cannot reach each other's containers
- [ ] Persist runner launch specs so restart and rollback work after the runner itself restarts
- [ ] Health monitoring of live instances (mark CRASHED, restart, alert) between deploys
- [ ] Database backups (scheduled `pg_dump` to R2) and restore
- [ ] Volume size enforcement and volume snapshots
- [ ] Encrypt `EnvironmentVariable.value` and database credentials at rest
- [ ] Build cache shared between deployments of a service (BuildKit cache mounts keyed by service)
- [ ] Runner fleet: several runners per workspace with placement and capacity reporting
- [ ] Build over SSH: `SshRunnerDriver` only runs a pre-built `syncbay-<svc>:<sha>` image; it does not clone/build
- [ ] TLS for custom domains on a zone without Cloudflare SSL for SaaS (DNS-only verification works; certificates must come from elsewhere, e.g. Vercel domains)
- [ ] MySQL provisioning / Query Studio against a real MySQL server (untested: Docker Hub rate limit)
- [ ] Monthly invoicing catch-up if the sweep cron is down on the 1st
- [ ] Query Studio tunnel through the runner for DBs on private hosts
- [ ] Bring the `syncbay` Cloudflare tunnel connector up on a runner host (tunnel exists, status `down`)

## Tech debt
- [ ] Resolve the React Compiler advisories (`react-hooks/set-state-in-effect`, `preserve-manual-memoization`). They're downgraded to warnings in `eslint.config.mjs`.
- [ ] Reduce the remaining ~360 lint warnings, mostly `no-explicit-any` and unused vars.
