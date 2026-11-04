/**
 * Syncbay PaaS — Volume payload for runner builds
 *
 * A service's `Volume` rows travel to the runner in `BuildDispatchParams.volumes`
 * (`[{ id, name, mountPath, sizeGb }]`). The runner mounts them as Docker named
 * volumes (`syncbay-vol-<id>`) or bind directories for native processes
 * (`runner/src/volumes.ts`).
 */

import { db } from "@/lib/db";

export interface VolumePayload {
  id: string;
  name: string;
  mountPath: string;
  sizeGb: number;
}

/** Volumes to mount for a deployment; [] when none or the lookup fails. */
export async function loadServiceVolumes(serviceId: string): Promise<VolumePayload[]> {
  try {
    const delegate = (db as any).volume;
    if (!delegate?.findMany) return [];
    const rows = await delegate.findMany({
      where: { serviceId },
      select: { id: true, name: true, mountPath: true, sizeGb: true },
      orderBy: { createdAt: "asc" },
    });
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/** `-v` flags for a `docker run` issued directly by a driver (SSH). */
export function dockerVolumeArgs(volumes: VolumePayload[] | undefined): string {
  return (volumes || [])
    .filter((v) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(v.id) && /^\/[A-Za-z0-9_./-]*$/.test(v.mountPath) && !v.mountPath.includes(".."))
    .map((v) => `-v syncbay-vol-${v.id.toLowerCase()}:${v.mountPath}`)
    .join(" ");
}
