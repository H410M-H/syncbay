"use client";

import styles from "./data.module.css";
import { errorText } from "./format";

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  serverVersion?: string;
  error?: string;
  hint?: string;
  runner?: { healthy: boolean; latencyMs: number | null; message: string | null } | null;
  backend?: string;
  entries?: number;
  hasObjects?: boolean;
}

/** "Test connection" button plus a live-region result (latency, version, error, hint). */
export function ConnectionTest({
  onTest,
  pending,
  result,
  resourceName,
}: {
  onTest: () => void;
  pending: boolean;
  result: ConnectionTestResult | undefined;
  resourceName: string;
}) {
  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onTest} disabled={pending} aria-label={`Test connection to ${resourceName}`}>
        {pending ? "Testing…" : "Test connection"}
      </button>
      <div aria-live="polite" className={styles.srOnly}>
        {pending ? `Testing ${resourceName}` : result ? (result.ok ? `${resourceName} reachable` : `${resourceName} unreachable`) : ""}
      </div>
    </>
  );
}

/** Result box shown under the resource header. */
export function ConnectionResult({ result, error }: { result: ConnectionTestResult | undefined; error: unknown }) {
  if (error) {
    return (
      <div className={`${styles.result} ${styles.resultFail}`} role="status">
        <span className={styles.failText}>Test failed</span>
        <span>{errorText(error)}</span>
      </div>
    );
  }
  if (!result) return null;
  const details: string[] = [`${result.latencyMs} ms`];
  if (result.serverVersion) details.push(`server ${result.serverVersion}`);
  if (result.backend) details.push(`${result.backend} volume`);
  if (typeof result.entries === "number") details.push(`${result.entries} top-level entr${result.entries === 1 ? "y" : "ies"}`);
  if (typeof result.hasObjects === "boolean") details.push(result.hasObjects ? "has objects" : "empty");
  return (
    <div className={`${styles.result} ${result.ok ? styles.resultOk : styles.resultFail}`} role="status">
      <span className={result.ok ? styles.okText : styles.failText}>
        {result.ok ? "Connected" : "Not reachable"} · {details.join(" · ")}
      </span>
      {result.error && <span>{result.error}</span>}
      {result.hint && <span className={styles.hint}>{result.hint}</span>}
      {result.runner && (
        <span className={styles.hint}>
          Runner probe: {result.runner.healthy ? "healthy" : "unhealthy"}
          {result.runner.latencyMs !== null ? ` (${result.runner.latencyMs} ms)` : ""}
          {result.runner.message ? ` — ${result.runner.message}` : ""}
        </span>
      )}
    </div>
  );
}
