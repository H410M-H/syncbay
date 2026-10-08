# Project: Syncbay PaaS Platform — Hybrid Compute & Edge Routing

## Architecture
The Syncbay PaaS Platform provides a hybrid compute execution layer and an automated global edge routing fabric:
1. **Control Plane & Orchestration**:
   - Next.js Web Application & API layer (`src/app/`, `src/lib/orchestrator/`).
   - GitHub webhook processing and ephemeral preview environment management (`src/lib/orchestrator/pr-manager.ts`).
   - Multi-driver execution dispatcher (`src/lib/orchestrator/runner-driver.ts`).
   - Deployment build pipeline with code quality scanning (`src/lib/orchestrator/engine.ts`, `src/lib/buildpack/knip-analyzer.ts`).
2. **Execution Drivers & Runner Fabric**:
   - `WebhookRunnerDriver`: Synchronous HTTP/SSE with HMAC SHA-256 verification for fast builds.
   - `QueueRunnerDriver`: Asynchronous DB-backed polling queue for long-running builds without serverless timeouts.
   - `SshRunnerDriver`: Remote command execution and container process management on custom Linux nodes.
   - Containerized Runner Agent (`runner/`): Standalone daemon supporting Docker, Nixpacks, dynamic port binding, and git cloning.
3. **Global Edge Ingress & Tunnel Routing**:
   - Cloudflare Tunnel ingress configuration generator (`src/lib/tunnel/tunnel-config.ts`).
   - Edge Service Registry (`src/lib/edge/service-registry.ts`) for zero-latency, edge-safe route resolution.
   - Next.js Edge Middleware (`src/middleware.ts`) transparently proxying active services to upstream ports and routing booting/waking services to preview splash.
4. **Cold-Start UX**:
   - Service Preview Splash Screen (`src/app/service-preview/[subdomain]/page.tsx`) with pulsing status badges, real-time log streaming, and client-side `/health` auto-redirection.

---

## Feature Inventory

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Prisma Relation Query Fix | Fix query in `service-preview` to use `environment.project` instead of `service.project` | M1 | Survey (R5) |
| 2 | Ephemeral PR Domain Registration | Automatically generate and persist `Domain` record `${service.name}-pr-${prNumber}.syncbay.app` in `pr-manager.ts` | M1 | Survey (R3) |
| 3 | PR Lifecycle Auto-Sleep & Teardown | Configure 15–30 min idle timeout (`idleTimeoutSecs: 1800`), scale-to-zero, and cleanup hooks in `pr-manager.ts` | M1 | Survey (R3) |
| 4 | GitHub Octokit Commit Status & Comments | Post `syncbay/preview` commit status check and markdown preview comment with live badges | M1 | Survey (R3) |
| 5 | Unified `RunnerDriver` Interface | Declare `RunnerDriver` interface with `dispatchBuild()`, `checkStatus()`, and `stopContainer()` in `runner-driver.ts` | M2 | Survey (R1) |
| 6 | REST Webhook Runner Driver | Implement `WebhookRunnerDriver` with HMAC SHA-256 signature verification and SSE streaming log URL | M2 | Survey (R1) |
| 7 | Queue/DB Polling Runner Driver | Implement `QueueRunnerDriver` mapping Prisma `Build`/`Deployment` records for long-running builds | M2 | Survey (R1) |
| 8 | SSH Remote Runner Driver | Implement `SshRunnerDriver` for remote Linux provisioning, health checking, and container management | M2 | Survey (R1) |
| 9 | Containerized Runner Agent Daemon | Standalone runner in `runner/` with `package.json`, `Dockerfile`, daemon `src/index.ts` | M2 | Survey (R1) |
| 10 | Runner Build Pipeline & Port Allocator | Automated build pipeline (`pipeline.ts`) supporting Docker and Nixpacks, with dynamic port pool (`port-manager.ts`) | M2 | Survey (R1) |
| 11 | Cloudflare Tunnel Ingress Generator | Generate valid `cloudflared` YAML configuration mapping subdomains to internal container ports | M3 | Survey (R2) |
| 12 | Edge Service Registry | Edge-safe in-memory/cache store (`service-registry.ts`) for zero-latency subdomain and status lookup | M3 | Survey (R2) |
| 13 | Edge Middleware Transparent Routing | Update `src/middleware.ts` to transparently route active services to origin and waking/building to splash | M3 | Survey (R2) |
| 14 | Knip Code Quality Analyzer Module | Module in `src/lib/buildpack/knip-analyzer.ts` scanning file trees and `package.json` for unused deps/files/exports | M4 | Survey (R4) |
| 15 | Non-Blocking Knip Engine Integration | Integrate Knip scan into build phase in `src/lib/orchestrator/engine.ts` streaming `[knip]` logs non-blockingly | M4 | Survey (R4) |
| 16 | Cold-Start Live Splash Screen | Render multi-state pulsing indicators for `BUILDING` and `DEPLOYING` states in `service-preview` | M5 | Survey (R5) |
| 17 | Real-Time SSE Log Streaming Console | Display live deployment logs via `/api/deployments/${id}/logs/stream` in `service-preview` | M5 | Survey (R5) |
| 18 | Client-Side Health Probe & Redirect | Client-side probe checking `/health` every 1.5s, auto-redirecting to live application upon `200 OK` | M5 | Survey (R5) |
| 19 | E2E Test Suite (Tiers 1-4) | Comprehensive opaque-box test runner and test cases covering all R1-R5 acceptance criteria | M6 | Plan (Dual Track) |
| 20 | Adversarial Coverage Hardening (Tier 5) | White-box adversarial testing and edge case verification | M6 | Plan (Dual Track) |

---

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Core Platform Bug Fixes & PR Pipeline | Features 1, 2, 3, 4: Prisma relation bug fix, PR domain registration, PR lifecycle & Octokit checks in `pr-manager.ts` | None | DONE (worker_m1) |
| M2 | Hybrid Runner Driver Subsystem & Agent | Features 5, 6, 7, 8, 9, 10: `runner-driver.ts` (Webhook, Queue, SSH), and `runner/` containerized agent | None | DONE (worker_m2) |
| M3 | Global Edge Ingress & Tunnel Routing | Features 11, 12, 13: `tunnel-config.ts`, `service-registry.ts`, and `src/middleware.ts` | M1 | DONE (worker_m3) |
| M4 | Knip Code Quality & Dead-Code Analyzer | Features 14, 15: `knip-analyzer.ts` and non-blocking integration in `engine.ts` | None | DONE (worker_m4) |
| M5 | Cold-Start UX & Health Probe Splash Screen | Features 16, 17, 18: Live pulsing splash screen, SSE log console, `/health` auto-redirection in `service-preview` | M1 | DONE (worker_m5) |
| M6 | Final Verification: 100% E2E Test Pass & Adversarial Hardening | Features 19, 20: Tiers 1-4 test suite pass + Tier 5 adversarial hardening | M1, M2, M3, M4, M5 | DONE (PASS) |

---

## Interface Contracts

### 1. `RunnerDriver` ↔ `Orchestrator Engine`
- **Location**: `src/lib/orchestrator/runner-driver.ts`
- **Signatures**:
  ```typescript
  export interface RunnerDriver {
    readonly type: RunnerDriverType;
    dispatchBuild(params: BuildDispatchParams): Promise<BuildDispatchResult>;
    checkStatus(jobId: string): Promise<BuildStatusResult>;
    stopContainer(containerId: string, options?: Partial<StopContainerParams>): Promise<StopContainerResult>;
  }
  ```
- **Error Handling**: Custom error types `RunnerDriverError`, `AuthenticationError`, `TimeoutError`. Driver methods must reject or return structured error results without throwing uncaught process exceptions.

### 2. `Cloudflare Tunnel Config Generator` ↔ `Edge Ingress`
- **Location**: `src/lib/tunnel/tunnel-config.ts`
- **Signatures**:
  ```typescript
  export interface RouteMapping {
    hostname: string;
    targetPort: number;
    path?: string;
  }
  export function generateTunnelConfig(params: {
    tunnelId: string;
    credentialsFile?: string;
    routes: RouteMapping[];
    controlPlaneFallback?: string;
    catchAllService?: string;
  }): string;
  ```
- **Guarantees**: Valid YAML, hostname validation, port bounds (1..65535), specific rules precedes wildcard `*.syncbay.app`, always ends with `service: http_status:404`.

### 3. `Edge Service Registry` ↔ `Next.js Edge Middleware`
- **Location**: `src/lib/edge/service-registry.ts`
- **Signatures**:
  ```typescript
  export function registerServiceRoute(hostname: string, targetPort: number, status: string, upstreamUrl?: string): void;
  export function getServiceRoute(hostname: string): { status: string; targetPort?: number; upstreamUrl?: string } | null;
  export function clearServiceRoutes(): void;
  ```
- **Edge Runtime Compatibility**: Zero Node.js native dependencies (`fs`, `child_process`, `net`, `@prisma/client`). 100% web-standard runtime compatible.

### 4. `Knip Analyzer` ↔ `Engine Build Pipeline`
- **Location**: `src/lib/buildpack/knip-analyzer.ts`
- **Signatures**:
  ```typescript
  export interface KnipScanOptions {
    rootDir?: string;
    files: string[];
    packageJsonContent?: string | object;
  }
  export interface KnipAnalysisResult {
    unusedDependencies: string[];
    unreferencedFiles: string[];
    unusedExports: { file: string; exportName: string }[];
    recommendations: string[];
    formattedLogs: string[];
  }
  export function runKnipAnalysis(options: KnipScanOptions): Promise<KnipAnalysisResult>;
  ```
- **Guarantees**: Non-blocking. In `src/lib/orchestrator/engine.ts`, errors during Knip execution are caught and logged; builds never fail due to code quality warnings.

---

## Code Layout

```
C:\dev\syncbay\
├── src\
│   ├── app\
│   │   ├── service-preview\
│   │   │   └── [subdomain]\
│   │   │       └── page.tsx            (M1 & M5: Prisma relation fix & Cold-Start splash UI)
│   ├── lib\
│   │   ├── orchestrator\
│   │   │   ├── pr-manager.ts           (M1: Domain registration, lifecycle, Octokit checks)
│   │   │   ├── runner-driver.ts        (M2: Unified RunnerDriver & Webhook/Queue/SSH drivers)
│   │   │   └── engine.ts               (M4: Knip integration in build phase)
│   │   ├── tunnel\
│   │   │   └── tunnel-config.ts        (M3: Cloudflare Tunnel ingress YAML generator)
│   │   ├── edge\
│   │   │   └── service-registry.ts     (M3: Edge-safe route & status store)
│   │   └── buildpack\
│   │       └── knip-analyzer.ts        (M4: Repository dead code & dependency analyzer)
│   └── middleware.ts                   (M3: Next.js Edge Middleware active pass-through)
├── runner\                             (M2: Standalone containerized runner agent)
│   ├── package.json
│   ├── Dockerfile
│   └── src\
│       ├── index.ts                    (Daemon entrypoint)
│       ├── pipeline.ts                 (Build pipeline: Docker & Nixpacks)
│       └── port-manager.ts             (Dynamic port allocation)
└── tests\
    └── e2e\                            (M6: End-to-end tests across Tiers 1-5)
```
