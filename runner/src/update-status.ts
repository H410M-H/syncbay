import * as fs from "node:fs";
import * as path from "node:path";
import { redactSecrets } from "./redact.ts";

/**
 * Last result of the host's auto-updater (deploy/alibaba-ecs/auto-update.sh writes
 * `<RUNNER_STATE_DIR>/update-status.json`). Null when no updater runs on this host.
 */
export interface UpdateStatus {
  checkedAt: string;
  result: string; // up-to-date | updated | build-failed | error | disabled
  commit?: string;
  branch?: string;
  message?: string;
}

export function readUpdateStatus(stateDir = process.env.RUNNER_STATE_DIR): UpdateStatus | null {
  if (!stateDir) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, "update-status.json"), "utf8"));
    if (!raw || typeof raw.result !== "string") return null;
    return {
      checkedAt: String(raw.checkedAt || ""),
      result: raw.result.slice(0, 32),
      commit: typeof raw.commit === "string" ? raw.commit.slice(0, 40) : undefined,
      branch: typeof raw.branch === "string" ? raw.branch.slice(0, 64) : undefined,
      // Served on the public /health: git and build errors can quote a remote URL with a token.
      message: typeof raw.message === "string" ? redactSecrets(raw.message).slice(0, 400) : undefined,
    };
  } catch {
    return null;
  }
}
