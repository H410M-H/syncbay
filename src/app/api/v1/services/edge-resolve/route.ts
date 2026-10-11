import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const subdomain = searchParams.get("subdomain");
  if (!subdomain) return NextResponse.json({ error: "Missing subdomain" }, { status: 400 });

  // Generated hostnames include the service name plus an environment and
  // deployment suffix (for example, portfolio-production-fpk1). Resolve the
  // owning service instead of treating the complete hostname as its name.
  const serviceSlug = subdomain.split("-")[0];
  const service = await db.service.findFirst({
    where: {
      OR: [
        { name: subdomain },
        { id: subdomain },
        { name: serviceSlug },
        { name: { startsWith: `${serviceSlug}-` } },
      ],
    },
    include: { deployments: { orderBy: { createdAt: "desc" }, take: 1 } },
  });

  if (!service) return NextResponse.json({ status: "NOT_FOUND" }, { status: 404 });

  const latest = service.deployments[0];
  const status = latest?.status || "NOT_FOUND";
  const targetPort = service.port || 3000;
  
  return NextResponse.json({
    hostname: subdomain,
    targetPort,
    status: status === "ACTIVE" ? "ACTIVE" : status,
    upstreamUrl: `http://127.0.0.1:${targetPort}`,
    updatedAt: Date.now(),
  });
}
