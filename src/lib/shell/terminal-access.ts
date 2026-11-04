import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import type { TerminalContext } from "@/lib/shell/terminal-sessions";

function loadService(serviceId: string, userId: string) {
  return db.service.findFirst({
    where: {
      id: serviceId,
      deletedAt: null,
      environment: {
        project: {
          deletedAt: null,
          workspace: {
            members: { some: { userId, role: { in: ["OWNER", "ADMIN", "MEMBER"] } } },
          },
        },
      },
    },
    include: {
      variables: true,
      deployments: { take: 1, orderBy: { createdAt: "desc" } },
    },
  });
}

type TerminalService = NonNullable<Awaited<ReturnType<typeof loadService>>>;

/**
 * Resolves the signed-in user and the service, enforcing workspace membership
 * (OWNER / ADMIN / MEMBER — viewers cannot open a shell).
 */
export async function resolveTerminalAccess(serviceId: string) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { error: "Unauthorized", status: 401 as const };

  const service = await loadService(serviceId, userId);
  if (!service) return { error: "Service not found or access denied", status: 404 as const };

  return { userId, service };
}

/** Builds the per-request terminal context (service name, container, variables) from an access grant. */
export function terminalContextFor(access: { userId: string; service: TerminalService }): TerminalContext {
  const latest = access.service.deployments[0];
  return {
    serviceId: access.service.id,
    userId: access.userId,
    serviceName: access.service.name,
    containerId: latest?.cfContainerId || `proc_${access.service.name}`,
    variables: access.service.variables.map((v) => ({ key: v.key, value: v.value, isSecret: v.isSecret })),
  };
}
