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

## Next
- [ ] Per-deployment request / 5xx counters so canary auto-rollback has real input (`MetricSample` has CPU/memory/network only)
- [ ] Build over SSH: `SshRunnerDriver` only runs a pre-built `syncbay-<svc>:<sha>` image; it does not clone/build
- [ ] TLS for custom domains on a zone without Cloudflare SSL for SaaS (DNS-only verification works; certificates must come from elsewhere, e.g. Vercel domains)
- [ ] MySQL provisioning / Query Studio against a real MySQL server (untested: Docker Hub rate limit)
- [ ] Monthly invoicing catch-up if the sweep cron is down on the 1st
- [ ] Query Studio tunnel through the runner for DBs on private hosts
- [ ] Bring the `syncbay` Cloudflare tunnel connector up on a runner host (tunnel exists, status `down`)

## Tech debt
- [ ] Resolve the React Compiler advisories (`react-hooks/set-state-in-effect`, `preserve-manual-memoization`). They're downgraded to warnings in `eslint.config.mjs`.
- [ ] Reduce the remaining ~360 lint warnings, mostly `no-explicit-any` and unused vars.
- [ ] Encrypt `EnvironmentVariable.value` at rest.
