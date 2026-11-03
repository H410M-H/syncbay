/**
 * Syncbay PaaS — Edge Service Route Registration API
 * Allows runner daemons and orchestrator to register active service container
 * ports into the zero-latency Edge Service Registry.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  registerServiceRouteAsync,
  removeServiceRouteAsync,
  normalizeHostname,
} from "@/lib/edge/service-registry";
import { hasValidRunnerSecret } from "@/lib/edge/runner-auth";

export const dynamic = "force-dynamic";

function verifyRunnerAuth(req: NextRequest): boolean {
  const configuredSecret = process.env.RUNNER_SECRET || process.env.SYNCBAY_WEBHOOK_SECRET;
  if (!configuredSecret) {
    // Open only in local dev / simulated test environments; production must configure a secret
    return process.env.NODE_ENV !== "production";
  }
  return hasValidRunnerSecret(req.headers);
}

export async function POST(req: NextRequest) {
  try {
    if (!verifyRunnerAuth(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { hostname, targetPort, status = "ACTIVE", upstreamUrl, isLocal } = body;

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

    if (isLocal !== undefined && typeof isLocal !== "boolean") {
      return NextResponse.json({ error: "Invalid isLocal (must be boolean)" }, { status: 400 });
    }

    const route = await registerServiceRouteAsync(cleanHost, targetPort, status, upstreamUrl, isLocal);

    return NextResponse.json({
      success: true,
      route,
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
    const removed = await removeServiceRouteAsync(cleanHost);
    return NextResponse.json({ success: true, removed });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
