"use client";

import styles from "./admin.module.css";
import { errorMessage } from "./format";

/** Loading / error placeholder for a staff console query; renders nothing once data is there. */
export function QueryState({ isLoading, error, label }: { isLoading: boolean; error: unknown; label: string }) {
  if (error) {
    return (
      <div role="alert" className={styles.callout}>
        Could not load {label}: {errorMessage(error)}
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className={styles.empty} role="status">
        <div className="loading-bar" style={{ width: "160px", margin: "0 auto 12px" }} />
        Loading {label}…
      </div>
    );
  }
  return null;
}
