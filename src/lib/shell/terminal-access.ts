import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

/**
 * Resolves the signed-in user and the service, enforcing workspace membership
 * (OWNER / ADMIN / MEMBER — viewers cannot open a shell).
 */
export async function resolveTerminalAccess(serviceId: string) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { error: "Unauthorized", status: 401 as const };

  const service = await db.service.findFirst({
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
  if (!service) return { error: "Service not found or access denied", status: 404 as const };

  return { userId, service };
}
