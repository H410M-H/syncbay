/**
 * Syncbay PaaS — Edge Service Route Registration API
 * Allows runner daemons and orchestrator to register active service container
 * ports into the zero-latency Edge Service Registry.
 */

import { NextRequest, NextResponse } from "next/server";
import { registerServiceRoute, getServiceRoute, removeServiceRoute, normalizeHostname } from "@/lib/edge/service-registry";

export const dynamic = "force-dynamic";

function verifyRunnerAuth(req: NextRequest): boolean {
  const configuredSecret = process.env.RUNNER_SECRET || process.env.SYNCBAY_WEBHOOK_SECRET;
  if (!configuredSecret) return true; // Open in local dev / simulated test environments

  const authHeader = req.headers.get("authorization") || req.headers.get("x-runner-secret");
  if (!authHeader) return false;

  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
  return token === configuredSecret;
}

export async function POST(req: NextRequest) {
  try {
    if (!verifyRunnerAuth(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { hostname, targetPort, status = "ACTIVE", upstreamUrl } = body;

    if (!hostname || typeof hostname !== "string") {
      return NextResponse.json({ error: "Hostname is required" }, { status: 400 });
    }

    const cleanHost = normalizeHostname(hostname);
    if (!cleanHost) {
      return NextResponse.json({ error: "Invalid hostname" }, { status: 400 });
    }

    if (targetPort !== undefined && (typeof targetPort !== "number" || targetPort < 1 || targetPort > 65535)) {
      return NextResponse.json({ error: "Invalid targetPort (must be integer between 1 and 65535)" }, { status: 400 });
    }

    registerServiceRoute(cleanHost, targetPort, status, upstreamUrl);

    return NextResponse.json({
      success: true,
      route: getServiceRoute(cleanHost),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    if (!verifyRunnerAuth(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const hostname = searchParams.get("hostname");

    if (!hostname) {
      return NextResponse.json({ error: "Hostname is required" }, { status: 400 });
    }

    const cleanHost = normalizeHostname(hostname);
    const removed = removeServiceRoute(cleanHost);
    return NextResponse.json({ success: true, removed });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
