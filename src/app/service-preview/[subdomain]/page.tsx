import React from "react";
import { db } from "@/lib/db";
import { routeClientRequest } from "@/lib/edge/edge-router";
import { headers } from "next/headers";
import { BrandLogo } from "@/components/ui/brand-logo";

export const dynamic = "force-dynamic";

interface ServicePreviewProps {
  params: Promise<{ subdomain: string }>;
  searchParams?: Promise<{ status?: string; deploymentId?: string }>;
}

export default async function ServicePreviewPage({
  params,
  searchParams,
}: ServicePreviewProps) {
  const { subdomain } = await params;
  const resolvedSearchParams = searchParams ? await searchParams : {};
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
  let serviceRecord: any = null;
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
            environment: {
              include: {
                project: true,
              },
            },
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
  const fallbackEnv = parts.length > 1 ? parts.slice(1).join("-") : "production";

  if (!domainRecord?.service) {
    try {
      serviceRecord = await (db.service as any).findFirst({
        where: {
          OR: [
            { name: subdomain },
            { name: fallbackService },
          ],
        },
        include: {
          environment: {
            include: {
              project: true,
            },
          },
          deployments: {
            take: 1,
            orderBy: { createdAt: "desc" },
          },
        },
      });
    } catch (err) {
      // Fallback
    }
  }

  const service = domainRecord?.service || serviceRecord;
  const serviceName = service?.name || fallbackService;
  const envName = service?.environment?.name || fallbackEnv;
  const projectName = service?.environment?.project?.name || "Syncbay Application";
  const latestDeployment = service?.deployments?.[0];
  const port = service?.port || 3000;

  // Determine initial status:
  // Hierarchy: URL searchParams > latestDeployment.status > service.isPaused > subdomain heuristics > fallback ACTIVE
  const rawStatus = (
    resolvedSearchParams?.status ||
    latestDeployment?.status ||
    (service?.isPaused ? "SLEEPING" : "") ||
    (subdomain.includes("deploy") ? "DEPLOYING" : "") ||
    (subdomain.includes("waking") || subdomain.includes("build") ? "BUILDING" : "") ||
    (subdomain.includes("sleep") ? "SLEEPING" : "") ||
    "ACTIVE"
  ).toUpperCase();

  const status = ["BUILDING", "DEPLOYING", "SLEEPING", "ACTIVE", "FAILED"].includes(rawStatus)
    ? rawStatus
    : "ACTIVE";

  const deploymentId = latestDeployment?.id || resolvedSearchParams?.deploymentId || "";

  // Badge configuration based on status
  const badgeConfig = {
    BUILDING: {
      label: "BUILDING · Compiling Nixpacks & Container Image",
      badgeClass: "animate-pulse",
      dotClass: "animate-pulse",
      textColor: "#f59e0b",
      bgColor: "rgba(245, 158, 11, 0.12)",
      borderColor: "rgba(245, 158, 11, 0.35)",
      dotColor: "#f59e0b",
      glowColor: "#f59e0b",
      subtext: "HTTP/2 503 · Container Building",
    },
    DEPLOYING: {
      label: "DEPLOYING · Initializing Edge Ingress & Container Fabric",
      badgeClass: "animate-pulse",
      dotClass: "animate-pulse",
      textColor: "#06b6d4",
      bgColor: "rgba(6, 182, 212, 0.12)",
      borderColor: "rgba(6, 182, 212, 0.35)",
      dotColor: "#06b6d4",
      glowColor: "#06b6d4",
      subtext: "HTTP/2 503 · Deploying Container",
    },
    SLEEPING: {
      label: "SLEEPING · Scaled to Zero (Idle Timeout)",
      badgeClass: "",
      dotClass: "",
      textColor: "#818cf8",
      bgColor: "rgba(99, 102, 241, 0.12)",
      borderColor: "rgba(99, 102, 241, 0.35)",
      dotColor: "#6366f1",
      glowColor: "#6366f1",
      subtext: "HTTP/2 200 Dormant · Container Paused",
    },
    ACTIVE: {
      label: "HTTP/2 200 OK · Container Active",
      badgeClass: "",
      dotClass: "",
      textColor: "#22c55e",
      bgColor: "rgba(34, 197, 94, 0.1)",
      borderColor: "rgba(34, 197, 94, 0.3)",
      dotColor: "#22c55e",
      glowColor: "#22c55e",
      subtext: "Healthy · Zero-Downtime Blue/Green Active",
    },
    FAILED: {
      label: "FAILED · Container Build Error",
      badgeClass: "",
      dotClass: "",
      textColor: "#ef4444",
      bgColor: "rgba(239, 68, 68, 0.12)",
      borderColor: "rgba(239, 68, 68, 0.35)",
      dotColor: "#ef4444",
      glowColor: "#ef4444",
      subtext: "HTTP/2 500 · Deployment Failed",
    },
  }[status as "BUILDING" | "DEPLOYING" | "SLEEPING" | "ACTIVE" | "FAILED"] || {
    label: "HTTP/2 200 OK · Container Active",
    badgeClass: "",
    dotClass: "",
    textColor: "#22c55e",
    bgColor: "rgba(34, 197, 94, 0.1)",
    borderColor: "rgba(34, 197, 94, 0.3)",
    dotColor: "#22c55e",
    glowColor: "#22c55e",
    subtext: "Healthy · Zero-Downtime Blue/Green Active",
  };

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
      {/* Inline styles for pulsing animations */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
            @keyframes pulseGlow {
              0%, 100% { opacity: 1; transform: scale(1); }
              50% { opacity: 0.55; transform: scale(0.98); }
            }
            .animate-pulse {
              animation: pulseGlow 1.8s cubic-bezier(0.4, 0, 0.6, 1) infinite;
            }
            .terminal-scroll::-webkit-scrollbar {
              width: 8px;
            }
            .terminal-scroll::-webkit-scrollbar-track {
              background: #09090b;
            }
            .terminal-scroll::-webkit-scrollbar-thumb {
              background: #27272a;
              border-radius: 4px;
            }
            .terminal-scroll::-webkit-scrollbar-thumb:hover {
              background: #3f3f46;
            }
          `,
        }}
      />

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
          maxWidth: "860px",
          margin: "40px auto",
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
              background: `radial-gradient(circle, ${badgeConfig.glowColor}25 0%, transparent 70%)`,
              borderRadius: "50%",
              pointerEvents: "none",
            }}
          />

          {/* Status Badges Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "12px",
              marginBottom: "16px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span
                id="status-badge-container"
                className={badgeConfig.badgeClass}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "7px",
                  background: badgeConfig.bgColor,
                  color: badgeConfig.textColor,
                  border: `1px solid ${badgeConfig.borderColor}`,
                  padding: "5px 12px",
                  borderRadius: "9999px",
                  fontSize: "12px",
                  fontWeight: 600,
                  transition: "all 0.3s ease",
                }}
              >
                <span
                  id="status-dot-indicator"
                  className={badgeConfig.dotClass}
                  style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    background: badgeConfig.dotColor,
                    boxShadow: `0 0 10px ${badgeConfig.glowColor}`,
                    display: "inline-block",
                  }}
                />
                <span id="status-label-text">{badgeConfig.label}</span>
              </span>

              <span style={{ fontSize: "12px", color: "#71717a" }}>
                Edge Route: {fullHostname}
              </span>
            </div>

            {/* Health probe live counter */}
            <div
              id="health-probe-counter-badge"
              style={{
                fontSize: "11px",
                fontFamily: "monospace",
                color: "#a1a1aa",
                background: "#09090b",
                border: "1px solid #27272a",
                padding: "3px 10px",
                borderRadius: "6px",
              }}
            >
              Health Probe: initializing (1.5s interval)...
            </div>
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
            {status === "BUILDING" && "This service is compiling container artifacts and preparing runtime assets for deployment."}
            {status === "DEPLOYING" && "This service is starting container processes and mapping edge tunnel routes."}
            {status === "SLEEPING" && "This service has scaled to zero due to inactivity and can be woken instantly on request."}
            {status === "ACTIVE" && "This service is deployed and serving live traffic over the Syncbay Global Edge Network."}
            {status === "FAILED" && "This service encountered a deployment error during compilation or container launch."}
          </p>

          {/* Grid of specs */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
              gap: "14px",
              background: "#09090b",
              padding: "18px",
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

          {/* Action Buttons & Wake Trigger */}
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
            {status === "SLEEPING" && (
              <button
                id="wake-container-btn"
                type="button"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "8px",
                  background: "#4f46e5",
                  color: "#ffffff",
                  padding: "10px 18px",
                  borderRadius: "8px",
                  fontSize: "13px",
                  fontWeight: 600,
                  border: "1px solid #6366f1",
                  cursor: "pointer",
                  boxShadow: "0 0 16px rgba(99, 102, 241, 0.4)",
                  transition: "all 0.2s ease",
                }}
              >
                ⚡ Wake Container Instance
              </button>
            )}

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
              id="manual-probe-link"
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

            <div
              id="redirect-notice-banner"
              style={{
                display: "none",
                alignItems: "center",
                gap: "8px",
                color: "#22c55e",
                fontSize: "13px",
                fontWeight: 600,
                marginLeft: "auto",
              }}
            >
              ✓ Container Ready — Redirecting...
            </div>
          </div>
        </div>

        {/* Real-Time Live Deployment Log Streaming Console */}
        <div
          style={{
            marginTop: "24px",
            background: "#09090b",
            border: "1px solid #27272a",
            borderRadius: "14px",
            overflow: "hidden",
            boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.4)",
          }}
        >
          {/* Terminal Window Header */}
          <div
            style={{
              background: "#18181b",
              borderBottom: "1px solid #27272a",
              padding: "10px 16px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: "#ef4444", display: "inline-block" }} />
              <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: "#eab308", display: "inline-block" }} />
              <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: "#22c55e", display: "inline-block" }} />
              <span
                style={{
                  fontSize: "12px",
                  color: "#a1a1aa",
                  fontFamily: "monospace",
                  marginLeft: "8px",
                }}
              >
                syncbay-builder@edge: ~/{serviceName} {deploymentId ? `(dep: ${deploymentId.slice(0, 10)})` : "(queued)"}
              </span>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span
                id="terminal-sse-status"
                style={{
                  fontSize: "11px",
                  fontFamily: "monospace",
                  color: deploymentId ? "#06b6d4" : "#a1a1aa",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                <span
                  style={{
                    width: "6px",
                    height: "6px",
                    borderRadius: "50%",
                    background: deploymentId ? "#06b6d4" : "#71717a",
                  }}
                />
                {deploymentId ? "SSE LIVE STREAM" : "POLLING QUEUE"}
              </span>
            </div>
          </div>

          {/* Terminal Log Output Area */}
          <div
            id="terminal-output-container"
            className="terminal-scroll"
            style={{
              padding: "16px",
              fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Monaco, Consolas, monospace",
              fontSize: "12px",
              lineHeight: "1.65",
              color: "#d4d4d8",
              height: "260px",
              overflowY: "auto",
              backgroundColor: "#09090b",
            }}
          >
            <div style={{ color: "#71717a", marginBottom: "4px" }}>
              [syncbay-edge] Subscribing to container build pipeline...
            </div>
            <div style={{ color: "#71717a", marginBottom: "4px" }}>
              [syncbay-edge] Service: {serviceName} | Environment: {envName} | Target Port: :{port}
            </div>
            {deploymentId ? (
              <div style={{ color: "#38bdf8", marginBottom: "4px" }}>
                [syncbay-edge] Connected to SSE /api/deployments/{deploymentId}/logs/stream
              </div>
            ) : (
              <div style={{ color: "#fbbf24", marginBottom: "4px" }}>
                [syncbay-edge] Deployment ID pending... Waiting for build coordinator.
              </div>
            )}
            <div id="live-log-stream-target" />
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
          <div id="edge-trace-status">Status: {badgeConfig.subtext}</div>
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

      {/* Client-Side Live Log Streaming & Health Probe Automation Script */}
      <script
        dangerouslySetInnerHTML={{
          __html: `
            (function() {
              var serviceSubdomain = ${JSON.stringify(subdomain)};
              var deploymentId = ${JSON.stringify(deploymentId)};
              var currentStatus = ${JSON.stringify(status)};
              var probeCount = 0;
              var isRedirecting = false;
              var eventSource = null;
              var ringBufferLimit = 300;
              var logTarget = document.getElementById("live-log-stream-target");
              var terminalContainer = document.getElementById("terminal-output-container");
              var probeBadge = document.getElementById("health-probe-counter-badge");
              var statusBadge = document.getElementById("status-badge-container");
              var statusDot = document.getElementById("status-dot-indicator");
              var statusLabel = document.getElementById("status-label-text");
              var traceStatus = document.getElementById("edge-trace-status");
              var redirectNotice = document.getElementById("redirect-notice-banner");

              function updateBadgeState(newStatus) {
                currentStatus = newStatus;
                if (!statusBadge || !statusDot || !statusLabel) return;

                if (newStatus === "BUILDING") {
                  statusBadge.className = "animate-pulse";
                  statusBadge.style.background = "rgba(245, 158, 11, 0.12)";
                  statusBadge.style.color = "#f59e0b";
                  statusBadge.style.borderColor = "rgba(245, 158, 11, 0.35)";
                  statusDot.className = "animate-pulse";
                  statusDot.style.background = "#f59e0b";
                  statusDot.style.boxShadow = "0 0 10px #f59e0b";
                  statusLabel.innerText = "BUILDING · Compiling Nixpacks & Container Image";
                  if (traceStatus) traceStatus.innerText = "Status: HTTP/2 503 · Container Building";
                } else if (newStatus === "DEPLOYING") {
                  statusBadge.className = "animate-pulse";
                  statusBadge.style.background = "rgba(6, 182, 212, 0.12)";
                  statusBadge.style.color = "#06b6d4";
                  statusBadge.style.borderColor = "rgba(6, 182, 212, 0.35)";
                  statusDot.className = "animate-pulse";
                  statusDot.style.background = "#06b6d4";
                  statusDot.style.boxShadow = "0 0 10px #06b6d4";
                  statusLabel.innerText = "DEPLOYING · Initializing Edge Ingress & Container Fabric";
                  if (traceStatus) traceStatus.innerText = "Status: HTTP/2 503 · Deploying Container";
                } else if (newStatus === "SLEEPING") {
                  statusBadge.className = "";
                  statusBadge.style.background = "rgba(99, 102, 241, 0.12)";
                  statusBadge.style.color = "#818cf8";
                  statusBadge.style.borderColor = "rgba(99, 102, 241, 0.35)";
                  statusDot.className = "";
                  statusDot.style.background = "#6366f1";
                  statusDot.style.boxShadow = "0 0 8px #6366f1";
                  statusLabel.innerText = "SLEEPING · Scaled to Zero (Idle Timeout)";
                  if (traceStatus) traceStatus.innerText = "Status: HTTP/2 200 Dormant · Container Paused";
                } else if (newStatus === "ACTIVE") {
                  statusBadge.className = "";
                  statusBadge.style.background = "rgba(34, 197, 94, 0.1)";
                  statusBadge.style.color = "#22c55e";
                  statusBadge.style.borderColor = "rgba(34, 197, 94, 0.3)";
                  statusDot.className = "";
                  statusDot.style.background = "#22c55e";
                  statusDot.style.boxShadow = "0 0 8px #22c55e";
                  statusLabel.innerText = "HTTP/2 200 OK · Container Active";
                  if (traceStatus) traceStatus.innerText = "Status: Healthy · Zero-Downtime Blue/Green Active";
                }
              }

              function appendLog(rawMessage, streamType, timestamp) {
                if (!terminalContainer || !logTarget) return;

                var isSuccess = rawMessage.indexOf("\\x1b[32m") !== -1 || rawMessage.indexOf("✔") !== -1 || rawMessage.indexOf("healthy") !== -1;
                var isError = rawMessage.indexOf("\\x1b[31m") !== -1 || rawMessage.indexOf("✘") !== -1 || streamType === "stderr" || rawMessage.indexOf("ERROR") !== -1;
                var isWarn = rawMessage.indexOf("\\x1b[33m") !== -1 || rawMessage.indexOf("WARN") !== -1;
                var isCyan = rawMessage.indexOf("\\x1b[36m") !== -1 || rawMessage.indexOf("[nixpacks]") !== -1 || rawMessage.indexOf("[syncbay]") !== -1 || rawMessage.indexOf("[knip]") !== -1;

                var cleanMessage = rawMessage.replace(/\\x1b\\[[0-9;]*[a-zA-Z]/g, "");

                var color = "#d4d4d8";
                if (isSuccess) color = "#22c55e";
                else if (isError) color = "#f87171";
                else if (isWarn) color = "#fbbf24";
                else if (isCyan) color = "#38bdf8";

                var line = document.createElement("div");
                line.style.marginBottom = "3px";
                line.style.wordBreak = "break-all";

                var timeSpan = document.createElement("span");
                timeSpan.style.color = "#52525b";
                timeSpan.style.marginRight = "8px";
                timeSpan.innerText = timestamp ? "[" + timestamp.slice(11, 19) + "]" : "[" + new Date().toISOString().slice(11, 19) + "]";
                line.appendChild(timeSpan);

                var contentSpan = document.createElement("span");
                contentSpan.style.color = color;
                contentSpan.innerText = cleanMessage;
                line.appendChild(contentSpan);

                terminalContainer.insertBefore(line, logTarget);

                // FIFO Eviction: maintain ring buffer size
                var allLines = terminalContainer.children;
                while (allLines.length > ringBufferLimit) {
                  terminalContainer.removeChild(allLines[0]);
                }

                // Auto-scroll
                terminalContainer.scrollTop = terminalContainer.scrollHeight;
              }

              // 1. Connect to SSE Stream if deployment ID exists
              if (deploymentId && typeof window.EventSource !== "undefined") {
                try {
                  eventSource = new EventSource("/api/deployments/" + encodeURIComponent(deploymentId) + "/logs/stream");

                  eventSource.onmessage = function(e) {
                    try {
                      var data = JSON.parse(e.data);
                      appendLog(data.message || "", data.stream || "stdout", data.timestamp);
                      if (data.message && data.message.indexOf("Container healthy") !== -1) {
                        updateBadgeState("ACTIVE");
                      }
                    } catch (err) {
                      appendLog(e.data, "stdout");
                    }
                  };

                  eventSource.onerror = function() {
                    if (currentStatus === "ACTIVE") {
                      eventSource.close();
                      eventSource = null;
                    }
                  };
                } catch (err) {
                  appendLog("[syncbay-client] Fallback to simulated log polling.", "system");
                }
              }

              // 2. Client-side Health Probe & Automatic Live Redirect
              function triggerLiveRedirect() {
                if (isRedirecting) return;
                isRedirecting = true;

                if (eventSource) {
                  eventSource.close();
                  eventSource = null;
                }

                if (redirectNotice) {
                  redirectNotice.style.display = "inline-flex";
                }

                if (probeBadge) {
                  probeBadge.style.color = "#22c55e";
                  probeBadge.innerText = "Health Probe: 200 OK · Redirecting...";
                }

                appendLog("[syncbay-probe] Health check succeeded (HTTP 200 OK). Triggering live transition...", "system");

                // Execute automatic redirect after brief notification
                setTimeout(function() {
                  window.location.reload();
                }, 350);
              }

              async function probeHealthEndpoint() {
                if (isRedirecting) return;
                probeCount++;

                if (probeBadge) {
                  probeBadge.innerText = "Health Probe #" + probeCount + ": polling /health (1.5s)...";
                }

                try {
                  var res = await fetch("/health", {
                    method: "GET",
                    cache: "no-store",
                    headers: { "Accept": "application/json" }
                  });

                  if (res.status === 200) {
                    if (probeBadge) {
                      probeBadge.innerHTML = "<span style='color: #22c55e;'>Probe #" + probeCount + ": 200 OK</span>";
                    }

                    // Requirement: When /health returns 200 OK and status is ACTIVE, automatically trigger live redirect
                    if (currentStatus === "ACTIVE") {
                      triggerLiveRedirect();
                    } else {
                      updateBadgeState("ACTIVE");
                      triggerLiveRedirect();
                    }
                  } else {
                    if (probeBadge) {
                      probeBadge.innerHTML = "<span style='color: #fbbf24;'>Probe #" + probeCount + ": " + res.status + " (Booting)</span>";
                    }
                  }
                } catch (err) {
                  if (probeBadge) {
                    probeBadge.innerHTML = "<span style='color: #71717a;'>Probe #" + probeCount + ": Connecting...</span>";
                  }
                }
              }

              // Start health probe polling every 1.5 seconds (1500 ms)
              var probeTimer = setInterval(probeHealthEndpoint, 1500);

              // Run immediate probe if already ACTIVE
              if (currentStatus === "ACTIVE") {
                probeHealthEndpoint();
              }

              // 3. Wake Trigger Handler for SLEEPING status
              var wakeBtn = document.getElementById("wake-container-btn");
              if (wakeBtn) {
                wakeBtn.addEventListener("click", function() {
                  wakeBtn.disabled = true;
                  wakeBtn.innerText = "⚡ Waking Container...";
                  wakeBtn.style.opacity = "0.7";

                  updateBadgeState("DEPLOYING");
                  appendLog("[syncbay-wake] Wake trigger received. Provisioning container from scale-to-zero sleep...", "system");

                  // Trigger wake signal and accelerate probe
                  fetch("/health", { method: "GET", cache: "no-store" }).catch(function() {});
                  probeHealthEndpoint();
                });
              }
            })();
          `,
        }}
      />
    </div>
  );
}
