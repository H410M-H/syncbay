# Syncbay — Project Architecture

Syncbay (`syncbay.app`) is a hybrid-compute PaaS. This document describes the system as it
is built today: the moving parts, how a request travels through them, the security model
and the contracts between modules. `CLAUDE.md` is the shorter agent guide; `ROADMAP.md`
tracks what is still open.

## 1. System overview

```
             browser / git push / API token
                         │
   ┌─────────────────────▼──────────────────────────┐
   │ Control plane — Next.js 16 on Vercel            │
   │  dashboard (App Router) · tRPC 11 · REST /v1    │
   │  src/proxy.ts (edge routing) · NextAuth v4      │
   │  orchestrator (engine.ts, runner-driver.ts)     │
   └──────┬───────────────┬──────────────┬──────────┘
          │ Prisma 5       │ HMAC-signed  │ Cloudflare API
          ▼                ▼ HTTP / SSH   ▼ (tunnels, custom hostnames, purge)
     PostgreSQL     ┌──────────────────────────────┐
     (+ optional    │ Data plane — runner daemon   │
     Upstash L2)    │ runner/ on any Linux host:   │
                    │ clone → build → run, ports,  │
                    │ managed DBs, terminals       │
                    └──────────────┬───────────────┘
                                   │ cloudflared (Cloudflare Tunnel)
                                   ▼
                    <svc>-<env>.syncbay.app / custom domains
```

- **Control plane** (`src/`): stateless Next.js app. Every piece of state that must be
  shared between serverless instances lives in Postgres, in the optional Upstash L2 store,
  or inside a signed token. No correctness depends on process memory.
- **Data plane** (`runner/`): a standalone Node daemon (`RunnerDaemon`) that builds and runs
  customer services, provisions Postgres/Redis containers and serves web-terminal shells.
- **Edge**: Cloudflare in front. Traffic for a service host either reaches the Vercel proxy
  (which rewrites to the runner) or goes straight down the tunnel to the service port.

## 2. Deploy flow

1. A deploy starts from the dashboard (`deployment.redeploy`), the REST API, a GitHub push
   webhook or a PR webhook (`pr-manager.ts`).
2. `executeDeployment()` (`src/lib/orchestrator/engine.ts`) loads the service, resolves
   `${{ ref }}` variables, merges managed-database env (`applyDatabaseEnv`) and registers
   every hostname of the service as `BUILDING` in the edge registry.
3. `getRunnerDriver()` picks a driver: `webhook` (HTTP to the daemon), `ssh`, `queue`,
   `local` (in-process `runner/src/pipeline.ts`) or `mock`. Failed remote dispatches fall back
   to local unless `RUNNER_FALLBACK_LOCAL=false` / `RUNNER_FORCE_REMOTE=true`.
4. The runner's `BuildPipeline` clones (or `git fetch` for a fast redeploy), detects Docker →
   Nixpacks → native, builds (`--no-cache` on a clean rebuild), and starts the app on a port
   from `PortManager` (10000–60000).
5. The engine polls status, probes `/health` then `/`, registers the routes `ACTIVE`, records
   the deployment and service port, and calls `requestTunnelReload()` (section 4).

## 3. Edge routing

- **Registry** (`src/lib/edge/service-registry.ts`): hostname → `{ targetPort, status,
  upstreamUrl, isLocal }`. L1 is a per-process map (ACTIVE 15 s, other states 2 s, misses 5 s);
  L2 is Upstash REST (`syncbay:edge:route:<host>`), else a read-only DB resolver
  (`src/lib/edge/resolve.ts`), else memory.
- **Proxy** (`src/proxy.ts`, Node runtime): control-plane hosts pass through; service hosts
  (`*.syncbay.app`, `*.localhost`, verified custom domains) are rewritten to their upstream, or
  to `RUNNER_URL` with `x-target-port`. Non-active services get the cold-start splash
  (`src/app/service-preview/[subdomain]`), which streams build logs, polls `/health` and offers
  a wake button (`/api/v1/services/wake`).
- **Custom domains** route exactly like the service's platform host: on verification the
  domain router copies the live registry entry (`src/lib/edge/domain-upstream.ts`), falling
  back to the DB resolver.
- **POP list**: `src/lib/edge/edge-router.ts` holds a static six-region model used for routing
  demos and the globe. It is illustrative (`illustrative: true` in API responses); Syncbay does
  not operate those POPs.
- **Cache purge**: `purgeEdgeCache()` calls Cloudflare `POST /zones/{zone}/purge_cache`
  (`purge_everything`, `tags`, `hosts`, or `files` for domain + path) when
  `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_API_TOKEN` are set; otherwise it returns
  `configured: false, success: false` and purges nothing.

## 4. Tunnel ingress

- `src/lib/tunnel/tunnel-config.ts` generates cloudflared YAML and the Cloudflare
  `PUT /accounts/{acct}/cfd_tunnel/{id}/configurations` body, and `reloadTunnel()` applies it
  (API mode, or write `TUNNEL_CONFIG_FILE` atomically + run `TUNNEL_RESTART_COMMAND`).
- `src/lib/tunnel/tunnel-sync.ts` is what keeps it current:
  - `buildIngressRoutesFromDb()` builds the **full** table: every non-deleted, non-paused
    service with an ACTIVE deployment and a port, under its default host and each ACTIVE
    domain, → `http://127.0.0.1:<port>`; the catch-all is `TUNNEL_FALLBACK_SERVICE`
    (default `http_status:404`).
  - `requestTunnelReload(reason)` debounces bursts (`TUNNEL_RELOAD_DEBOUNCE_MS`, 300 ms),
    serialises runs across instances with `pg_advisory_xact_lock`, rebuilds the table after
    taking the lock, never throws, and is a no-op when no tunnel is configured
    (API mode needs `CLOUDFLARE_TUNNEL_ID` + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`;
    local mode `CLOUDFLARE_TUNNEL_ID` + `TUNNEL_CONFIG_FILE`).
  - Called after a deploy goes ACTIVE (engine), a deployment is deleted, and a custom domain
    is verified or deleted.
- The runner also keeps its own config-file ingress in step for the hosts it serves
  (`runner/src/tunnel-driver.ts`, `runner/src/tunnel-config.ts`).

## 5. Custom domains

`src/lib/domain-service.ts` + `src/server/routers/domain.ts`:

1. `domain.create` validates and normalises the host (IDNA), rejects platform hosts, and
   registers a Cloudflare for SaaS custom hostname when `CLOUDFLARE_API_TOKEN` +
   `CLOUDFLARE_ZONE_ID` are set.
2. The user publishes `TXT _syncbay-challenge.<host> = syncbay-verification=<token>` and
   `CNAME <host> → CLOUDFLARE_CNAME_TARGET` (default `cname.syncbay.app`).
3. `domain.verify` → `verifyDomainDetailed()` resolves both with `node:dns/promises` (apex
   domains may use CNAME flattening: matching A records). Until both resolve the domain stays
   `VERIFYING` with the exact DNS errors. With Cloudflare configured the custom hostname and
   its certificate must also be `active` (`failed` → `FAILED`). Without Cloudflare, proven
   DNS → `ACTIVE`.
4. Nothing is simulated in production: `CloudflareApiClient` throws
   `CloudflareNotConfiguredError` instead of fabricating hostnames or tunnel tokens, and live
   API errors are thrown rather than replaced by simulated success. Outside production the
   client still has a labelled (`simulated: true`) offline mode for local work.

## 6. Web terminal

- UI `src/components/dashboard/web-shell.tsx` → `POST /api/services/:id/terminal`
  (create, or `{ sessionId, input }`), `GET …/terminal/stream` (SSE), `DELETE …?sessionId=`.
  Every call requires a session and OWNER/ADMIN/MEMBER membership.
- **Stateless**: `sessionId` is a signed token (`src/lib/shell/terminal-token.ts`,
  `sbt1.<claims>.<hmac>` with `TERMINAL_TOKEN_SECRET`; claims `{ sid, mode, runnerSessionId,
  serviceId, userId, exp }`, 8 h). Any instance verifies it and proxies to the runner.
- **Runner mode**: the daemon spawns `docker exec -i <container> sh` (or `sh` in a native job
  workspace) under `script -qfc`; input and SSE output go through signed runner requests.
- **Simulated mode** (no runner): cwd, the user's `export`/`unset` overrides, history and the
  masked output buffer live in a `TerminalSession` row, updated with optimistic `version`
  checks; the SSE stream polls the row, so input on one instance appears on a stream held by
  another. Idle sessions close after 10 min.
- Output always masks `isSecret` values and URL credentials; secret values are never stored.

## 7. Security model

| Boundary | Mechanism |
| --- | --- |
| Browser → control plane | NextAuth JWT session (Google, GitHub, credentials). In production the session cookie is scoped to `AUTH_COOKIE_DOMAIN` (default `.syncbay.app` when `NEXTAUTH_URL` is on syncbay.app), `Secure`, `SameSite=Lax`, so service hosts (wake button) see it. |
| API clients → `/api/v1` | Bearer API tokens (`src/lib/api/auth-token.ts`). |
| Control plane → runner | HMAC-SHA256 over `${ts}.${nonce}.${METHOD}.${path}.${body}` in `X-Syncbay-Signature`, with `X-Syncbay-Timestamp` (±5 min) and `X-Syncbay-Nonce` (16 random bytes). The daemon (`runner/src/request-auth.ts`) remembers accepted nonces for the window, so every signed request of any method is single-use; the SSE log route accepts `sig`/`ts`/`nonce` in the query string. Secret: `RUNNER_SECRET` (control plane also reads `RUNNER_WEBHOOK_SECRET` / `SYNCBAY_WEBHOOK_SECRET`); production refuses to run without it. |
| Runner → control plane | Bearer `RUNNER_SECRET` on `/api/v1/services/edge-register`. |
| Terminal sessions | `TERMINAL_TOKEN_SECRET` signed tokens bound to user + service; production answers 503 without the secret. |

## 8. Data model highlights

`Workspace → Project → Environment → Service → (Build, Deployment, Domain,
EnvironmentVariable, Volume)`; `DatabaseInstance` per environment (status
PROVISIONING → ACTIVE/UNHEALTHY/FAILED/DELETING); `TerminalSession` for simulated shells.
Migrations are hand-written folders under `prisma/migrations/`.

## 9. Interface contracts

```typescript
// src/lib/orchestrator/runner-driver.ts
export interface RunnerDriver {
  readonly type: RunnerDriverType;
  dispatchBuild(params: BuildDispatchParams): Promise<BuildDispatchResult>;
  checkStatus(jobId: string): Promise<BuildStatusResult>;
  stopContainer(containerId: string, options?: Partial<StopContainerParams>): Promise<StopContainerResult>;
}
export function signRequest(secret, method, path, body?, ts?, nonce?): { headers; signature; timestamp; nonce; headerValue };

// src/lib/edge/service-registry.ts
export function registerServiceRouteAsync(host, targetPort?, status?, upstreamUrl?, isLocal?): Promise<ServiceRouteEntry | null>;
export function resolveServiceRoute(host): Promise<ServiceRouteEntry | null>;

// src/lib/tunnel/tunnel-sync.ts
export function requestTunnelReload(reason: string): Promise<TunnelSyncResult>; // never throws

// src/lib/domain-service.ts
export function generateDefaultSubdomain(serviceName: string, envName: string): string;
export function generateVerificationRecords(domain: string): { cnameTarget; txtRecord; txtHost; cnameHost };
export function verifyDomain(domainId: string): Promise<DomainStatus>;
export function verifyDomainDetailed(domainId: string): Promise<DomainVerificationResult>;

// src/lib/edge/edge-router.ts
export function purgeEdgeCache(options?: PurgeCacheOptions): Promise<PurgeCacheResult>;

// src/lib/buildpack/knip-analyzer.ts — non-blocking static analysis of customer repos
export function runKnipAnalysis(options: KnipScanOptions): Promise<KnipAnalysisResult>;
```

## 10. Code layout

```
src/
  proxy.ts                     Next 16 Proxy: service-host routing, splash, /health
  app/
    api/services/[id]/terminal web terminal create/input/close + SSE stream
    api/v1/                    REST API (tokens), edge-register, wake, OpenAPI
    service-preview/           cold-start splash
  server/routers/              tRPC routers (deployment, domain, edge, service, …)
  lib/
    orchestrator/              engine.ts, runner-driver.ts, pr-manager.ts
    edge/                      service-registry.ts, resolve.ts, domain-upstream.ts, edge-router.ts
    tunnel/                    tunnel-config.ts, tunnel-sync.ts, cloudflare-api.ts
    shell/                     terminal-token.ts, terminal-sessions.ts, terminal-access.ts, web-shell.ts
    domain-service.ts          DNS verification
    auth.ts, auth-cookies.ts   NextAuth options and cookie scoping
    runner-client.ts           signed runner calls (managed DBs, terminals)
runner/src/
  index.ts                     RunnerDaemon (HTTP API, reverse proxy, ingress)
  request-auth.ts              canonical signature + nonce cache
  pipeline.ts, port-manager.ts build/run, port pool
  services.ts                  managed databases, terminal sessions
  tunnel-driver.ts, tunnel-config.ts  cloudflared supervision and config mirror
tests/                         tsx verifications (verify-*.ts) and e2e/
```

## 11. Testing

- Gates: `prisma generate`, `tsc --noEmit`, `knip`, `lint`, `next build` (CI), plus
  `cd runner && npm run build && npm test`.
- Focused verifications (`npm run test:*`): `fallback`, `tunnel`, `edge`, `db`, `terminal`,
  `email` (mocked DB); `terminal-stateless` (real Postgres, a runner daemon process, a Docker
  container, separate instance processes) and `domains` (real Postgres, real DNS lookups
  against a local authoritative server, Cloudflare API mocked).
- `npm test` runs the e2e tiers.

## 12. Environment variables (edge, tunnel, domains, terminal)

| Variable | Meaning | Default |
| --- | --- | --- |
| `RUNNER_URL`, `RUNNER_SECRET` | runner endpoint and shared HMAC secret | none (secret required in production) |
| `TERMINAL_TOKEN_SECRET` | signs web-terminal session tokens | required in production; dev derives one |
| `AUTH_COOKIE_DOMAIN` | production session-cookie domain (`none` disables) | `.syncbay.app` when `NEXTAUTH_URL` is on syncbay.app |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID` | custom hostnames, cache purge | unset → DNS-only verification, purge "not configured" |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_TUNNEL_ID` | remotely-managed tunnel config / token provisioning | unset → tunnel reload no-op |
| `CLOUDFLARE_CNAME_TARGET` | CNAME target for custom domains | `cname.syncbay.app` |
| `TUNNEL_CONFIG_FILE`, `TUNNEL_RESTART_COMMAND` | local-mode tunnel config and restart | unset / `systemctl restart cloudflared` |
| `TUNNEL_FALLBACK_SERVICE` | ingress catch-all | `http_status:404` |
| `TUNNEL_RELOAD_DEBOUNCE_MS` | debounce for tunnel reloads | `300` |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | L2 route store | unset → DB resolver / memory |
