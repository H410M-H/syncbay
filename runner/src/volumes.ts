/**
 * Syncbay Runner Agent — persistent volumes for deployed services
 *
 * The control plane sends a service's `Volume` rows in the build payload
 * (`volumes: [{ id, name, mountPath, sizeGb }]`).
 *   Docker:  `-v syncbay-vol-<id>:<mountPath>` (a named volume that survives redeploys).
 *   Native:  a bind directory `<state>/volumes/<id>` exported to the process as
 *            SYNCBAY_VOLUME_PATH (first volume) and VOLUME_<NAME>_PATH. A relative
 *            mountPath (e.g. `data` or `./uploads`) is also symlinked into the app dir.
 * `sizeGb` is recorded but not enforced (no quota on Docker volumes or host dirs).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runnerStateDir } from "./native-db.ts";

export interface VolumeMount {
  id: string;
  name: string;
  mountPath: string;
  sizeGb?: number;
}

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/** Drops malformed entries (ids are used in volume names and paths). */
export function sanitizeVolumes(input: unknown): VolumeMount[] {
  if (!Array.isArray(input)) return [];
  const out: VolumeMount[] = [];
  for (const v of input) {
    if (!v || typeof v !== "object") continue;
    const { id, name, mountPath, sizeGb } = v as Record<string, unknown>;
    if (typeof id !== "string" || !SAFE_ID.test(id)) continue;
    if (typeof mountPath !== "string" || !mountPath.trim() || mountPath.includes("..") || /[\s:"'`$\\]/.test(mountPath)) continue;
    out.push({
      id,
      name: typeof name === "string" && name ? name : id,
      mountPath: mountPath.trim(),
      sizeGb: typeof sizeGb === "number" ? sizeGb : undefined,
    });
  }
  return out;
}

export function dockerVolumeName(volume: VolumeMount): string {
  return `syncbay-vol-${volume.id.toLowerCase()}`;
}

/** `-v` flags for `docker run`. Relative mount paths are placed under /app. */
export function dockerVolumeFlags(volumes: VolumeMount[] | undefined): string {
  return sanitizeVolumes(volumes)
    .map((v) => {
      const target = v.mountPath.startsWith("/") ? v.mountPath : path.posix.join("/app", v.mountPath);
      return `-v ${dockerVolumeName(v)}:${target}`;
    })
    .join(" ");
}

function envKey(name: string): string {
  return `VOLUME_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PATH`;
}

/**
 * Creates the bind directories for a native process and returns the env vars
 * pointing at them (and symlinks relative mount paths into `appDir`).
 */
export function prepareNativeVolumes(
  volumes: VolumeMount[] | undefined,
  appDir: string,
  baseDir: string = path.join(runnerStateDir(), "volumes")
): { env: Record<string, string>; mounts: Array<{ id: string; hostPath: string; mountPath: string }> } {
  const env: Record<string, string> = {};
  const mounts: Array<{ id: string; hostPath: string; mountPath: string }> = [];
  for (const v of sanitizeVolumes(volumes)) {
    const hostPath = path.join(baseDir, v.id);
    fs.mkdirSync(hostPath, { recursive: true, mode: 0o755 });
    if (!env.SYNCBAY_VOLUME_PATH) env.SYNCBAY_VOLUME_PATH = hostPath;
    env[envKey(v.name)] = hostPath;

    if (!v.mountPath.startsWith("/")) {
      const link = path.resolve(appDir, v.mountPath);
      if (link.startsWith(path.resolve(appDir) + path.sep)) {
        try {
          const stat = fs.lstatSync(link, { throwIfNoEntry: false });
          if (stat?.isSymbolicLink() || (stat?.isDirectory() && fs.readdirSync(link).length === 0)) fs.rmSync(link, { recursive: true, force: true });
          if (!fs.existsSync(link)) {
            fs.mkdirSync(path.dirname(link), { recursive: true });
            fs.symlinkSync(hostPath, link, "dir");
          }
        } catch {
          // a non-empty directory from the repo stays; the env var still points at the volume
        }
      }
    }
    mounts.push({ id: v.id, hostPath, mountPath: v.mountPath });
  }
  return { env, mounts };
}
