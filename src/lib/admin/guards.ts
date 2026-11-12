/**
 * Moderation guards used by every path that starts customer code: deployments (engine, so all
 * entry points are covered), resume, wake and the always-on reconciler. A service locked by
 * staff, or any service of a suspended workspace, is not started.
 */

import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";

type Client = any;

/** A FORBIDDEN tRPC error, so routers surface the message as-is; elsewhere it is a plain Error. */
export class ServiceBlockedError extends TRPCError {
  constructor(message: string) {
    super({ code: "FORBIDDEN", message });
    this.name = "ServiceBlockedError";
  }
}

/** Why a service may not run, or null when it may. */
export async function serviceBlockReason(serviceId: string, client: Client = db): Promise<string | null> {
  const service = await client.service
    .findUnique({
      where: { id: serviceId },
      select: {
        moderationLockedAt: true,
        moderationReason: true,
        environment: { select: { project: { select: { workspace: { select: { suspendedAt: true } } } } } },
      },
    })
    .catch(() => null);
  if (!service) return null;
  if (service.environment?.project?.workspace?.suspendedAt) {
    return "This workspace is suspended by Syncbay. Contact support@syncbay.app.";
  }
  if (service.moderationLockedAt) {
    return `This service was taken down by Syncbay${service.moderationReason ? ` (${service.moderationReason})` : ""}. Contact support@syncbay.app.`;
  }
  return null;
}

export async function assertServiceMayRun(serviceId: string, client: Client = db): Promise<void> {
  const reason = await serviceBlockReason(serviceId, client);
  if (reason) throw new ServiceBlockedError(reason);
}
