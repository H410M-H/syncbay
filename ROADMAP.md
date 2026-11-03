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

## Next
- [ ] Shared terminal-session store (sessions are in-memory per control-plane instance; Vercel needs sticky routing or Redis)
- [ ] Call `reloadTunnel()` from the control plane with the full active-route table (runner-side config-file hook already live)
- [ ] Single-use nonces for signed GET requests (POSTs are already replay-protected)
- [ ] Widen the NextAuth cookie domain to `.syncbay.app` so the splash-page wake button works for signed-in users on service hosts
- [ ] Update `PROJECT.md`, which still describes the M1–M8 era layout

## Tech debt
- [ ] Resolve the React Compiler advisories (`react-hooks/set-state-in-effect`, `preserve-manual-memoization`). They're downgraded to warnings in `eslint.config.mjs`.
- [ ] Reduce the remaining ~360 lint warnings, mostly `no-explicit-any` and unused vars.
- [ ] Encrypt `EnvironmentVariable.value` at rest.
