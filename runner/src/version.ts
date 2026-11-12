/**
 * Runner release version, reported on `/health`. Bump it with every runner change the control
 * plane depends on, together with `MIN_RUNNER_VERSION` in src/lib/orchestrator/runner-config.ts,
 * so the dashboard can tell an operator that their runner host still runs an older image.
 *
 * 1.3.0  start-up window, port detection, private database networking (PR #19)
 * 1.4.0  session cookies stripped from proxied traffic; version on /health
 */
export const RUNNER_VERSION = "1.4.0";
