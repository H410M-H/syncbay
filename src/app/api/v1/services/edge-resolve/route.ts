import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const subdomain = searchParams.get("subdomain");
  if (!subdomain) return NextResponse.json({ error: "Missing subdomain" }, { status: 400 });

  const service = await db.service.findFirst({
    where: { OR: [{ name: subdomain }, { id: subdomain }] },
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
