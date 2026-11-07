/**
 * Project name uniqueness (Team A, v1.2). A workspace may not hold two non-deleted projects with
 * the same name (trimmed, case-insensitive), so a retried wizard cannot create "portfolio" ×3.
 * The check runs under a per-workspace transaction advisory lock, so concurrent creates or
 * renames cannot both pass it. Used by `project.create` / `project.update` and `POST /api/v1/projects`.
 */

type Client = any;

export function findProjectByName(
  client: Client,
  workspaceId: string,
  name: string,
  excludeProjectId?: string
): Promise<{ id: string; name: string } | null> {
  return client.project.findFirst({
    where: {
      workspaceId,
      deletedAt: null,
      name: { equals: name.trim(), mode: "insensitive" },
      ...(excludeProjectId ? { id: { not: excludeProjectId } } : {}),
    },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
}

/** Runs `fn` in a transaction holding the workspace's project-name lock. */
export function withProjectNameLock<T>(client: Client, workspaceId: string, fn: (tx: Client) => Promise<T>): Promise<T> {
  return client.$transaction(async (tx: Client) => {
    const key = `syncbay:project-name:${workspaceId}`;
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${key})::bigint)`;
    return fn(tx);
  });
}
