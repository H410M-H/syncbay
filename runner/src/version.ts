/**
 * Runner release version, reported on `/health`. Bump it with every runner change the control
 * plane depends on, together with `MIN_RUNNER_VERSION` in src/lib/orchestrator/runner-config.ts,
 * so the dashboard can tell an operator that their runner host still runs an older image.
 *
 * 1.3.0  start-up window, port detection, private database networking (PR #19)
 * 1.4.0  session cookies stripped from proxied traffic; version on /health
 * 1.5.0  stack templates: generated Dockerfiles for Node/SPA/Python/Go/Rust/PHP/Java/Ruby/Deno/Bun
 *        (RUNNER_BUILDER / SYNCBAY_BUILDER, RUNNER_BUILD_CA_FILE, RUNNER_BUILD_NETWORK); read-only
 *        volume routes /api/volumes/:id/{stat,files,file}; health-monitor restarting page; update status
 * 1.6.0  managed Postgres with extensions (POST /api/databases `extensions: ["vector"]` → pgvector
 *        image + CREATE EXTENSION; native mode creates it or fails clearly); `engine: "valkey"` for Redis
 */
export const RUNNER_VERSION = "1.6.0";
