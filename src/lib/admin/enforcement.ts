/**
 * Staff enforcement actions. Each one stops what must stop through the deploy lifecycle's own
 * stop path (`setServicePaused` → `stopServiceInstances`, which also reloads the tunnel), records
 * the state on the row, and leaves a line in the customer's own audit log ("Syncbay staff").
 * Lifting a suspension or a takedown does not start anything: the owner resumes their services.
 */

import { db } from "@/lib/db";
import { setServicePaused } from "@/lib/orchestrator/service-actions";

type Client = any;

export interface EnforcementResult {
  stopped: string[];
  failed: Array<{ serviceId: string; error: string }>;
}

async function customerAudit(client: Client, workspaceId: string, action: string, metadata: Record<string, unknown>) {
  await client.auditLogEntry
    .create({ data: { workspaceId, actorUserId: null, action, metadata: { by: "Syncbay staff", ...metadata } } })
    .catch(() => null);
}

async function pauseServices(client: Client, serviceIds: string[]): Promise<EnforcementResult> {
  const result: EnforcementResult = { stopped: [], failed: [] };
  for (const serviceId of serviceIds) {
    try {
      await setServicePaused(client, serviceId, true);
      result.stopped.push(serviceId);
    } catch (err) {
      // Mark it paused anyway so nothing restarts it; the stop is retried by the next action.
      await client.service.update({ where: { id: serviceId }, data: { isPaused: true } }).catch(() => null);
      result.failed.push({ serviceId, error: (err as Error)?.message || String(err) });
    }
  }
  return result;
}

export async function suspendWorkspace(workspaceId: string, actorUserId: string, reason: string, client: Client = db): Promise<EnforcementResult> {
  await client.workspace.update({
    where: { id: workspaceId },
    data: { suspendedAt: new Date(), suspendedReason: reason, suspendedById: actorUserId },
  });
  const services = await client.service.findMany({
    where: { deletedAt: null, environment: { project: { workspaceId } } },
    select: { id: true },
  });
  const result = await pauseServices(client, services.map((s: { id: string }) => s.id));
  await customerAudit(client, workspaceId, "workspace.suspended", { reason, servicesStopped: result.stopped.length });
  return result;
}

export async function unsuspendWorkspace(workspaceId: string, reason: string, client: Client = db): Promise<void> {
  await client.workspace.update({
    where: { id: workspaceId },
    data: { suspendedAt: null, suspendedReason: null, suspendedById: null },
  });
  await customerAudit(client, workspaceId, "workspace.unsuspended", { reason });
}

export async function takedownService(serviceId: string, reason: string, client: Client = db): Promise<EnforcementResult & { workspaceId: string | null }> {
  const service = await client.service.update({
    where: { id: serviceId },
    data: { moderationLockedAt: new Date(), moderationReason: reason },
    select: { id: true, name: true, environment: { select: { project: { select: { workspaceId: true } } } } },
  });
  const result = await pauseServices(client, [serviceId]);
  const workspaceId = service.environment?.project?.workspaceId ?? null;
  if (workspaceId) await customerAudit(client, workspaceId, "service.taken_down", { serviceId, service: service.name, reason });
  return { ...result, workspaceId };
}

export async function restoreService(serviceId: string, reason: string, client: Client = db): Promise<string | null> {
  const service = await client.service.update({
    where: { id: serviceId },
    data: { moderationLockedAt: null, moderationReason: null },
    select: { name: true, environment: { select: { project: { select: { workspaceId: true } } } } },
  });
  const workspaceId = service.environment?.project?.workspaceId ?? null;
  if (workspaceId) await customerAudit(client, workspaceId, "service.restored", { serviceId, service: service.name, reason });
  return workspaceId;
}

export async function setUserSuspended(userId: string, suspended: boolean, reason: string, client: Client = db): Promise<void> {
  await client.user.update({
    where: { id: userId },
    data: suspended ? { suspendedAt: new Date(), suspendedReason: reason } : { suspendedAt: null, suspendedReason: null },
  });
  // Staff access ends with the suspension.
  if (suspended) await client.staffMember.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}
