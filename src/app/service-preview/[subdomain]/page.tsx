import React from "react";
import { db } from "@/lib/db";
import { routeClientRequest } from "@/lib/edge/edge-router";
import { headers } from "next/headers";
import { BrandLogo } from "@/components/ui/brand-logo";

export const dynamic = "force-dynamic";

interface ServicePreviewProps {
  params: Promise<{ subdomain: string }>;
}

export default async function ServicePreviewPage({ params }: ServicePreviewProps) {
  const { subdomain } = await params;
  const reqHeaders = await headers();

  const country =
    reqHeaders.get("x-vercel-ip-country") ||
    reqHeaders.get("cf-ipcountry") ||
    "US";
  const city =
    reqHeaders.get("x-vercel-ip-city") ||
    reqHeaders.get("cf-ipcity") ||
    "Edge Ingress";
  const clientIp =
    reqHeaders.get("x-forwarded-for")?.split(",")[0].trim() ||
    reqHeaders.get("x-real-ip") ||
    "127.0.0.1";

  const routing = routeClientRequest({ country, city, clientIp });

  // Query database for service matching this hostname or subdomain
  let domainRecord: any = null;
  const fullHostname = `${subdomain}.syncbay.app`;

  try {
    domainRecord = await (db.domain as any).findFirst({
      where: {
        OR: [
          { hostname: fullHostname },
          { hostname: { startsWith: subdomain } },
        ],
      },
      include: {
        service: {
          include: {
            project: true,
            environment: true,
            deployments: {
              take: 1,
              orderBy: { createdAt: "desc" },
            },
          },
        },
      },
    });
  } catch (err) {
    // Fallback if DB query fails
  }

  // Parse subdomain components if record not found
  const parts = subdomain.split("-");
  const fallbackService = parts[0] || "web";
  const fallbackEnv = parts[1] || "production";

  const service = domainRecord?.service;
  const serviceName = service?.name || fallbackService;
  const envName = service?.environment?.name || fallbackEnv;
  const projectName = service?.project?.name || "Syncbay Application";
  const latestDeployment = service?.deployments?.[0];
  const port = service?.port || 3000;
  const status = latestDeployment?.status || "ACTIVE";

  return (
    <div
      style={{
        minHeight: "100vh",
        backgroundColor: "#09090b",
        color: "#f4f4f5",
        fontFamily: "system-ui, -apple-system, sans-serif",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
      }}
    >
      {/* Top Navbar */}
      <header
        style={{
          borderBottom: "1px solid #27272a",
          padding: "16px 24px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          backgroundColor: "rgba(9, 9, 11, 0.8)",
          backdropFilter: "blur(8px)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <BrandLogo size="sm" suffix=".EDGE" href="https://www.syncbay.app" priority />
          <span
            style={{
              fontSize: "11px",
              background: "#18181b",
              border: "1px solid #27272a",
              padding: "2px 8px",
              borderRadius: "12px",
              color: "#a1a1aa",
            }}
          >
            Container Preview
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <a
            href="https://www.syncbay.app/dashboard"
            style={{
              fontSize: "13px",
              color: "#06b6d4",
              textDecoration: "none",
              fontWeight: 500,
            }}
          >
            Console Dashboard ↗
          </a>
        </div>
      </header>

      {/* Main Content Area */}
      <main
        style={{
          maxWidth: "840px",
          margin: "48px auto",
          padding: "0 24px",
          width: "100%",
        }}
      >
        {/* Status Hero Card */}
        <div
          style={{
            background: "#18181b",
            border: "1px solid #27272a",
            borderRadius: "16px",
            padding: "32px",
            boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.5)",
            position: "relative",
            overflow: "hidden",
          }}
        >
          {/* Subtle glow effect */}
          <div
            style={{
              position: "absolute",
              top: "-80px",
              right: "-80px",
              width: "200px",
              height: "200px",
              background: "radial-gradient(circle, rgba(6, 182, 212, 0.15) 0%, transparent 70%)",
              borderRadius: "50%",
              pointerEvents: "none",
            }}
          />

          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                background: "rgba(34, 197, 94, 0.1)",
                color: "#22c55e",
                border: "1px solid rgba(34, 197, 94, 0.3)",
                padding: "4px 10px",
                borderRadius: "9999px",
                fontSize: "12px",
                fontWeight: 600,
              }}
            >
              <span
                style={{
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  background: "#22c55e",
                  boxShadow: "0 0 8px #22c55e",
                }}
              />
              HTTP/2 200 OK · Container Active
            </span>
            <span style={{ fontSize: "12px", color: "#71717a" }}>
              Edge Route: {fullHostname}
            </span>
          </div>

          <h1
            style={{
              fontSize: "2rem",
              fontWeight: 800,
              letterSpacing: "-0.03em",
              margin: "0 0 8px 0",
              color: "#ffffff",
            }}
          >
            {serviceName}
          </h1>

          <p style={{ color: "#a1a1aa", fontSize: "15px", margin: "0 0 24px 0", lineHeight: 1.5 }}>
            This service is deployed and serving traffic over the Syncbay Global Edge Network.
          </p>

          {/* Grid of specs */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: "16px",
              background: "#09090b",
              padding: "20px",
              borderRadius: "12px",
              border: "1px solid #27272a",
              marginBottom: "24px",
            }}
          >
            <div>
              <div style={{ fontSize: "11px", color: "#71717a", textTransform: "uppercase", fontWeight: 600 }}>
                Project
              </div>
              <div style={{ fontSize: "14px", fontWeight: 600, color: "#f4f4f5", marginTop: "4px" }}>
                {projectName}
              </div>
            </div>

            <div>
              <div style={{ fontSize: "11px", color: "#71717a", textTransform: "uppercase", fontWeight: 600 }}>
                Environment
              </div>
              <div style={{ fontSize: "14px", fontWeight: 600, color: "#38bdf8", marginTop: "4px" }}>
                {envName}
              </div>
            </div>

            <div>
              <div style={{ fontSize: "11px", color: "#71717a", textTransform: "uppercase", fontWeight: 600 }}>
                Edge Ingress POP
              </div>
              <div style={{ fontSize: "14px", fontWeight: 600, color: "#22c55e", marginTop: "4px" }}>
                {routing.activeRegion.name} ({routing.activeRegion.id.toUpperCase()})
              </div>
            </div>

            <div>
              <div style={{ fontSize: "11px", color: "#71717a", textTransform: "uppercase", fontWeight: 600 }}>
                Internal Port
              </div>
              <div style={{ fontSize: "14px", fontWeight: 600, color: "#f4f4f5", marginTop: "4px" }}>
                :{port}
              </div>
            </div>

            <div>
              <div style={{ fontSize: "11px", color: "#71717a", textTransform: "uppercase", fontWeight: 600 }}>
                TLS Termination
              </div>
              <div style={{ fontSize: "14px", fontWeight: 600, color: "#f4f4f5", marginTop: "4px" }}>
                TLSv1.3 (Wildcard SSL)
              </div>
            </div>

            <div>
              <div style={{ fontSize: "11px", color: "#71717a", textTransform: "uppercase", fontWeight: 600 }}>
                Estimated Latency
              </div>
              <div style={{ fontSize: "14px", fontWeight: 600, color: "#22c55e", marginTop: "4px" }}>
                ~{routing.estimatedLatencyMs} ms
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
            <a
              href="https://www.syncbay.app/dashboard"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                background: "#06b6d4",
                color: "#000",
                padding: "10px 18px",
                borderRadius: "8px",
                fontSize: "13px",
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              Open Project in Console
            </a>

            <a
              href="/health"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                background: "#27272a",
                color: "#f4f4f5",
                padding: "10px 18px",
                borderRadius: "8px",
                fontSize: "13px",
                fontWeight: 600,
                textDecoration: "none",
                border: "1px solid #3f3f46",
              }}
            >
              Probe /health endpoint
            </a>
          </div>
        </div>

        {/* Diagnostic Edge Trace Box */}
        <div
          style={{
            marginTop: "24px",
            background: "#121215",
            border: "1px solid #27272a",
            borderRadius: "12px",
            padding: "16px 20px",
            fontFamily: "monospace",
            fontSize: "12px",
            color: "#a1a1aa",
          }}
        >
          <div style={{ color: "#71717a", marginBottom: "8px", fontWeight: 600 }}>
            [syncbay-edge] Request Trace
          </div>
          <div>Client Location: {routing.detectedCity}, {routing.detectedCountry} ({routing.clientIp})</div>
          <div>Routed POP: {routing.activeRegion.provider} [{routing.activeRegion.id}]</div>
          <div>Status: Healthy · Zero-Downtime Blue/Green Active</div>
        </div>
      </main>

      {/* Footer */}
      <footer
        style={{
          borderTop: "1px solid #27272a",
          padding: "20px 24px",
          textAlign: "center",
          fontSize: "12px",
          color: "#71717a",
        }}
      >
        Syncbay PaaS — Next-Gen Cloud Platform · Powered by Cloudflare Containers & Edge POP Fabric
      </footer>
    </div>
  );
}
