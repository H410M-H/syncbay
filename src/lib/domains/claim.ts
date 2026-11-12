/**
 * Gives a service its generated platform hostname (a `Domain` row with `isGenerated`).
 *
 * `Domain.hostname` is globally unique, so the row is the ownership record. The first service
 * to ask gets `<service>-<env>.syncbay.app`; a later service with the same name and environment
 * gets a suffixed host built from its id. A row left behind by a deleted service is taken over.
 */

import { generateDefaultSubdomain } from "./service-hosts";

type Client = any;

export interface ClaimableService {
  id: string;
  name: string;
  environment?: { name?: string | null } | null;
}

export async function claimDefaultHostname(client: Client, service: ClaimableService): Promise<string> {
  const own = await client.domain.findFirst({
    where: { serviceId: service.id, isGenerated: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, hostname: true, status: true },
  });
  if (own) {
    if (own.status !== "ACTIVE") {
      await client.domain.update({ where: { id: own.id }, data: { status: "ACTIVE" } }).catch(() => null);
    }
    return own.hostname;
  }

  const envName = service.environment?.name || "production";
  const idTail = service.id.toLowerCase().replace(/[^a-z0-9]/g, "");
  const candidates = [
    generateDefaultSubdomain(service.name, envName),
    generateDefaultSubdomain(service.name, envName, idTail.slice(-4)),
    generateDefaultSubdomain(service.name, envName, idTail.slice(-10)),
  ];

  for (const hostname of candidates) {
    const holder = await client.domain.findUnique({
      where: { hostname },
      select: { id: true, serviceId: true, service: { select: { deletedAt: true } } },
    });
    const claim = { serviceId: service.id, isGenerated: true, status: "ACTIVE", verifiedAt: new Date() };
    if (holder) {
      const free = holder.serviceId === service.id || Boolean(holder.service?.deletedAt);
      if (!free) continue;
      await client.domain.update({ where: { id: holder.id }, data: claim });
      return hostname;
    }
    try {
      await client.domain.create({ data: { ...claim, hostname } });
      return hostname;
    } catch {
      // Another request created it first: try the next candidate.
    }
  }
  throw new Error(`Could not allocate a hostname for service ${service.id}`);
}
