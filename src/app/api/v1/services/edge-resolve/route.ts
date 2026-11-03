import { NextRequest, NextResponse } from "next/server";
import { resolveServiceRouteFromDb } from "@/lib/edge/resolve";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const subdomain = searchParams.get("subdomain");
  if (!subdomain) return NextResponse.json({ error: "Missing subdomain" }, { status: 400 });

  const route = await resolveServiceRouteFromDb(subdomain);
  if (!route) return NextResponse.json({ status: "NOT_FOUND" }, { status: 404 });

  return NextResponse.json(route);
}
