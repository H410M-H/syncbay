"use client";

import React, { useState } from "react";
import { TiltCard } from "@/components/ui/tilt-card";

const CODE_EXAMPLES = {
  manifest: {
    filename: "syncbay.json",
    language: "json",
    description: "The syncbay.json v1 manifest a one-click template repo carries: the app's port, its health-check path, the databases to provision and the variables to ask for or generate.",
    code: `{
  "name": "FastAPI & Redis",
  "port": 8000,
  "healthcheckPath": "/health",
  "services": [
    { "type": "postgres", "env": "DATABASE_URL", "extensions": ["vector"] },
    { "type": "redis", "env": "REDIS_URL" }
  ],
  "env": [
    { "key": "JWT_SECRET", "secret": true, "generate": "secret" },
    { "key": "LOG_LEVEL", "default": "info" },
    { "key": "OPENAI_API_KEY", "required": true, "secret": true }
  ]
}`,
  },
  cli: {
    filename: "terminal — REST API",
    language: "bash",
    description: "Every deploy can also be triggered over the token-authenticated REST API (OpenAPI spec at /api/v1/openapi.json) — from CI or your own scripts.",
    code: `# Create an API token in the dashboard, then:
$ export SYNCBAY_API_TOKEN=...

# List your projects
$ curl -H "Authorization: Bearer $SYNCBAY_API_TOKEN" \\
    https://www.syncbay.app/api/v1/projects

# Trigger a deployment of a service (202 = queued)
$ curl -X POST -H "Authorization: Bearer $SYNCBAY_API_TOKEN" \\
    -H "Content-Type: application/json" \\
    -d '{"serviceId":"<service-id>"}' \\
    https://www.syncbay.app/api/v1/deployments`,
  },
  env: {
    filename: "service variables",
    language: "env",
    description: "Reference other resources with ${{ ref }} variables; they are resolved at deploy time. Managed database URLs are injected automatically without overriding keys you set yourself.",
    code: `# Injected when you attach a managed database
DATABASE_URL="postgres://<user>:<password>@<runner-host>:<port>/<db>"
REDIS_URL="redis://default:<password>@<runner-host>:<port>"

# References resolved at deploy time
API_DATABASE_HOST="\${{ Postgres.HOST }}"
MEDIA_BUCKET="\${{ media.NAME }}"
BACKEND_URL="\${{ api.URL }}"

# Set by the runner
PORT="<the port your app listens on>"`,
  },
};

export function CliManifestShowcase() {
  const [activeTab, setActiveTab] = useState<"manifest" | "cli" | "env">("manifest");
  const [copied, setCopied] = useState(false);

  const activeExample = CODE_EXAMPLES[activeTab];

  const handleCopy = () => {
    navigator.clipboard.writeText(activeExample.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section id="cli-manifest" className="relative py-24 sm:py-32 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">
      {/* Section Header */}
      <div className="text-center max-w-3xl mx-auto mb-16">
        <div
          className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-bold tracking-wider uppercase mb-4 shadow-lg"
          style={{
            background: "rgba(6, 182, 212, 0.12)",
            border: "1px solid rgba(6, 182, 212, 0.35)",
            color: "#38bdf8",
            boxShadow: "0 0 20px rgba(6, 182, 212, 0.15)",
          }}
        >
          <span>💻 Developer-First Experience</span>
        </div>
        <h2 className="text-3xl sm:text-4xl md:text-5xl font-black text-white tracking-tight mb-4">
          Declarative Templates. Scriptable Deploys.
        </h2>
        <p className="text-base sm:text-lg font-medium leading-relaxed" style={{ color: "#94a3b8" }}>
          Templates describe their port, health check, databases and variables in `syncbay.json`; everything else is a git push or one REST call away.
        </p>
      </div>

      {/* Code Showcase Window with Tabs */}
      <TiltCard glowColor="rgba(6, 182, 212, 0.3)" intensity={6}>
        <div
          className="rounded-3xl p-6 sm:p-10 font-mono relative overflow-hidden"
          style={{
            background: "rgba(8, 8, 18, 0.95)",
            border: "1px solid rgba(6, 182, 212, 0.35)",
            boxShadow: "0 30px 80px -20px rgba(0,0,0,0.9), 0 0 40px rgba(6,182,212,0.15)",
          }}
        >
          {/* Top Bar with Tabs and Copy Button */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 mb-6 border-b border-white/10">
            {/* Tab Buttons */}
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setActiveTab("manifest")}
                className="px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2"
                style={{
                  background: activeTab === "manifest" ? "rgba(6, 182, 212, 0.2)" : "rgba(255, 255, 255, 0.04)",
                  color: activeTab === "manifest" ? "#38bdf8" : "#94a3b8",
                  border: activeTab === "manifest" ? "1px solid rgba(6, 182, 212, 0.5)" : "1px solid transparent",
                }}
              >
                <span>📄</span>
                <span>syncbay.json</span>
              </button>
              <button
                onClick={() => setActiveTab("cli")}
                className="px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2"
                style={{
                  background: activeTab === "cli" ? "rgba(124, 58, 237, 0.2)" : "rgba(255, 255, 255, 0.04)",
                  color: activeTab === "cli" ? "#c084fc" : "#94a3b8",
                  border: activeTab === "cli" ? "1px solid rgba(124, 58, 237, 0.5)" : "1px solid transparent",
                }}
              >
                <span>⚡</span>
                <span>REST API</span>
              </button>
              <button
                onClick={() => setActiveTab("env")}
                className="px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2"
                style={{
                  background: activeTab === "env" ? "rgba(16, 185, 129, 0.2)" : "rgba(255, 255, 255, 0.04)",
                  color: activeTab === "env" ? "#34d399" : "#94a3b8",
                  border: activeTab === "env" ? "1px solid rgba(16, 185, 129, 0.5)" : "1px solid transparent",
                }}
              >
                <span>🔐</span>
                <span>Secret References</span>
              </button>
            </div>

            {/* Copy Button */}
            <button
              onClick={handleCopy}
              className="px-4 py-2 rounded-xl text-xs font-bold transition-all duration-200 cursor-pointer flex items-center gap-2 self-start sm:self-auto"
              style={{
                background: "rgba(255, 255, 255, 0.06)",
                border: "1px solid rgba(255, 255, 255, 0.15)",
                color: copied ? "#4ade80" : "#f1f5f9",
              }}
            >
              <span>{copied ? "✔" : "📋"}</span>
              <span>{copied ? "Copied to Clipboard!" : "Copy Code"}</span>
            </button>
          </div>

          {/* Description of active tab */}
          <p className="text-xs text-slate-400 font-sans font-medium mb-4">
            {activeExample.description}
          </p>

          {/* Code Viewer */}
          <div
            className="p-5 rounded-2xl overflow-x-auto text-xs sm:text-sm leading-relaxed"
            style={{
              background: "rgba(4, 4, 10, 0.8)",
              border: "1px solid rgba(255, 255, 255, 0.05)",
              color: "#e2e8f0",
            }}
          >
            <pre style={{ margin: 0 }}>
              <code>{activeExample.code}</code>
            </pre>
          </div>

          {/* Footer Highlights */}
          <div className="mt-6 pt-4 border-t border-white/10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-xs text-slate-400 font-sans">
            <div className="flex flex-wrap items-center gap-4">
              <span className="flex items-center gap-1.5">
                <span className="text-cyan-400">✔</span> Your repo, your Dockerfile
              </span>
              <span className="flex items-center gap-1.5">
                <span className="text-cyan-400">✔</span> Standard Docker images
              </span>
              <span className="flex items-center gap-1.5">
                <span className="text-cyan-400">✔</span> Manifest validated on import
              </span>
            </div>
            <span className="font-mono text-cyan-400 font-bold">syncbay.json v1</span>
          </div>
        </div>
      </TiltCard>
    </section>
  );
}
