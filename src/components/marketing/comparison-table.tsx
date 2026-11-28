"use client";

import React from "react";
import Image from "next/image";
import { TiltCard } from "@/components/ui/tilt-card";

interface CapabilityRow {
  name: string;
  category: string;
  syncbay: string;
  detail: string;
  highlight?: boolean;
}

// Only what the code does today; no competitor figures.
const FEATURES: CapabilityRow[] = [
  {
    name: "Always-on services",
    category: "Compute & Builds",
    syncbay: "Default",
    detail: "Services keep running, so no cold start; opt-in scale-to-zero sleeps idle services until a member wakes them",
    highlight: true,
  },
  {
    name: "Build strategies",
    category: "Compute & Builds",
    syncbay: "Dockerfile · template · Nixpacks",
    detail: "Your Dockerfile first, then a Syncbay-generated Dockerfile for the detected stack, then Nixpacks",
  },
  {
    name: "Bring your own server",
    category: "Compute & Builds",
    syncbay: "Supported",
    detail: "Run the Syncbay runner daemon on your own Linux host and connect it to the control plane",
  },
  {
    name: "Managed PostgreSQL (pgvector)",
    category: "Databases & Storage",
    syncbay: "Built in",
    detail: "Provisioned on the runner; DATABASE_URL injected into your services",
  },
  {
    name: "Redis / Valkey and MySQL",
    category: "Databases & Storage",
    syncbay: "Built in",
    detail: "Provisioned on the runner and health-checked",
  },
  {
    name: "Buckets and volumes",
    category: "Databases & Storage",
    syncbay: "Cloudflare R2 · volumes",
    detail: "Private R2 buckets with presigned links; persistent volumes mounted into services",
  },
  {
    name: "In-browser shell",
    category: "Developer Experience",
    syncbay: "Built in",
    detail: "A shell inside the running container; secret values masked in the output",
    highlight: true,
  },
  {
    name: "Query Studio and Data view",
    category: "Developer Experience",
    syncbay: "Read-only by default",
    detail: "Test connections, browse tables, keys, bucket folders and volume files",
  },
  {
    name: "Zero-downtime releases",
    category: "DevOps & Reliability",
    syncbay: "Health-gated",
    detail: "The live version serves until the new one answers /health; failed releases leave it up",
    highlight: true,
  },
  {
    name: "Rollback, restart, pause",
    category: "DevOps & Reliability",
    syncbay: "One click",
    detail: "Roll back to an earlier build; restart in place; pause and resume",
  },
  {
    name: "Automatic restarts",
    category: "DevOps & Reliability",
    syncbay: "Health monitor",
    detail: "Probed every minute; restarted after two consecutive failures",
  },
  {
    name: "Custom domains and TLS",
    category: "Edge & Security",
    syncbay: "Via Cloudflare",
    detail: "DNS-verified domains with TLS; every service also gets a syncbay.app host",
    highlight: true,
  },
  {
    name: "WAF rules, rate limits, canaries",
    category: "Edge & Security",
    syncbay: "Built in",
    detail: "IP/CIDR, country and path rules; per-IP rate limits; weighted canary releases",
  },
  {
    name: "Per-seat fees",
    category: "Cost & Transparency",
    syncbay: "None",
    detail: "Billing is usage only, from one rate card: compute, memory and network egress",
    highlight: true,
  },
  {
    name: "Spending caps",
    category: "Cost & Transparency",
    syncbay: "Built in",
    detail: "Email at 80% of your cap; running services pause at 100%",
  },
];

const CATEGORIES = [
  "Compute & Builds",
  "Databases & Storage",
  "Developer Experience",
  "DevOps & Reliability",
  "Edge & Security",
  "Cost & Transparency",
];

export function ComparisonTable() {
  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="text-center max-w-2xl mx-auto">
        <div
          className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-bold tracking-wider uppercase mb-3"
          style={{
            background: "rgba(6, 182, 212, 0.15)",
            border: "1px solid rgba(6, 182, 212, 0.4)",
            color: "#38bdf8",
          }}
        >
          ✔ Capability Matrix
        </div>
        <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">
          What Syncbay Does Today
        </h2>
        <p className="text-sm font-medium" style={{ color: "#94a3b8" }}>
          Every row is a shipped feature, with a line on how it works. No benchmark numbers we cannot back up.
        </p>
      </div>

      <TiltCard intensity={4} glowColor="rgba(6,182,212,0.25)">
        <div
          className="rounded-2xl overflow-hidden"
          style={{
            background: "linear-gradient(135deg, rgba(16, 16, 28, 0.95) 0%, rgba(8, 8, 16, 0.98) 100%)",
            border: "1px solid rgba(6, 182, 212, 0.35)",
            backdropFilter: "blur(20px)",
            boxShadow: "0 25px 60px -12px rgba(0,0,0,0.8), 0 0 35px rgba(6,182,212,0.15)",
          }}
        >
          {/* Table Header */}
          <div
            className="p-6 flex items-center justify-between"
            style={{
              borderBottom: "1px solid rgba(6, 182, 212, 0.25)",
              background: "linear-gradient(135deg, rgba(6,182,212,0.08), rgba(124,58,237,0.08))",
            }}
          >
            <div>
              <h3 className="text-lg font-bold text-white tracking-tight">
                Platform Capability Matrix
              </h3>
              <p className="text-xs mt-1 font-semibold" style={{ color: "#94a3b8" }}>
                Feature by feature, as built
              </p>
            </div>
            <span
              className="text-xs font-bold font-mono px-3 py-1.5 rounded-lg"
              style={{
                background: "rgba(6, 182, 212, 0.15)",
                color: "#38bdf8",
                border: "1px solid rgba(6, 182, 212, 0.3)",
              }}
            >
              Syncbay
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs" style={{ fontFamily: "'Inter', sans-serif", minWidth: "620px" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.12)" }}>
                  <th
                    className="py-4 px-6 font-bold w-1/4"
                    style={{ color: "#cbd5e1", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.06em" }}
                  >
                    Capability
                  </th>
                  <th
                    className="py-4 px-6 font-black w-1/4"
                    style={{
                      color: "#38bdf8",
                      background: "rgba(6,182,212,0.08)",
                      borderLeft: "1px solid rgba(6,182,212,0.3)",
                      borderRight: "1px solid rgba(6,182,212,0.3)",
                    }}
                  >
                    <span className="inline-flex items-center gap-2">
                      <Image src="/brand-icon-tight.png" alt="Syncbay" width={18} height={10} className="inline-block" />
                      <span>Syncbay</span>
                    </span>
                  </th>
                  <th className="py-4 px-6 font-bold w-1/2" style={{ color: "#94a3b8" }}>
                    How it works
                  </th>
                </tr>
              </thead>
              <tbody>
                {CATEGORIES.map((cat) => {
                  const catFeatures = FEATURES.filter((f) => f.category === cat);
                  return (
                    <React.Fragment key={cat}>
                      <tr
                        style={{
                          background: "rgba(255,255,255,0.04)",
                          borderBottom: "1px solid rgba(255,255,255,0.08)",
                        }}
                      >
                        <td
                          colSpan={3}
                          className="py-2.5 px-6 font-mono font-bold text-[11px] uppercase tracking-wider"
                          style={{ color: "#38bdf8" }}
                        >
                          {"// "}{cat}
                        </td>
                      </tr>
                      {catFeatures.map((feat) => (
                        <tr
                          key={feat.name}
                          className="transition-colors hover:bg-white/[0.04]"
                          style={{
                            borderBottom: "1px solid rgba(255,255,255,0.06)",
                            background: feat.highlight ? "rgba(6,182,212,0.02)" : "transparent",
                          }}
                        >
                          <td className="py-3.5 px-6 font-semibold text-slate-200">
                            {feat.name}
                          </td>
                          <td
                            className="py-3.5 px-6 font-bold"
                            style={{
                              color: "#38bdf8",
                              background: "rgba(6,182,212,0.06)",
                              borderLeft: "1px solid rgba(6,182,212,0.25)",
                              borderRight: "1px solid rgba(6,182,212,0.25)",
                            }}
                          >
                            <span className="flex items-center gap-1.5">
                              <span className="text-cyan-400 font-bold">✔</span>
                              {feat.syncbay}
                            </span>
                          </td>
                          <td className="py-3.5 px-6 text-slate-400 font-medium">{feat.detail}</td>
                        </tr>
                      ))}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </TiltCard>
    </div>
  );
}
