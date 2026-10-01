"use client";

import React from "react";
import Image from "next/image";
import { TiltCard } from "@/components/ui/tilt-card";

interface ComparisonFeature {
  name: string;
  category: string;
  syncbay: string;
  vercel: string;
  railway: string;
  highlight?: boolean;
}

const FEATURES: ComparisonFeature[] = [
  {
    name: "Container Cold Starts",
    category: "Compute & Architecture",
    syncbay: "0 ms (Edge Containers)",
    vercel: "250 – 800 ms (Serverless)",
    railway: "2,000 – 5,000 ms (Spin-up)",
    highlight: true,
  },
  {
    name: "Multi-Region Edge Failover",
    category: "Compute & Architecture",
    syncbay: "6 Tier-1 Global Edge POPs",
    vercel: "Serverless Edge Functions only",
    railway: "Single region per service",
    highlight: true,
  },
  {
    name: "Managed Serverless PostgreSQL",
    category: "Databases & Storage",
    syncbay: "Built-in, 1-Click Provisioning",
    vercel: "Third-party Neon Add-on",
    railway: "Raw Docker Container",
  },
  {
    name: "Managed Redis / Valkey Cache",
    category: "Databases & Storage",
    syncbay: "Built-in with Connection Helpers",
    vercel: "Third-party Upstash Add-on",
    railway: "Separate Service Billing",
  },
  {
    name: "Interactive Web Terminal Shell",
    category: "Developer Experience",
    syncbay: "Full VT100 Interactive Shell",
    vercel: "Not Available",
    railway: "CLI Only (No Web Shell)",
    highlight: true,
  },
  {
    name: "Built-in SQL Query Studio",
    category: "Developer Experience",
    syncbay: "Visual Query Studio + Schema Tree",
    vercel: "Third-party Dashboard",
    railway: "Basic Table View",
  },
  {
    name: "Blue/Green Instant Rollbacks",
    category: "DevOps & Reliability",
    syncbay: "Sub-Second Traffic Shift",
    vercel: "Instant (Serverless only)",
    railway: "Full Rebuild Required (~3 min)",
    highlight: true,
  },
  {
    name: "Build Engine",
    category: "DevOps & Reliability",
    syncbay: "Nixpacks + Dockerfile Auto-Detect",
    vercel: "Proprietary Build Framework",
    railway: "Nixpacks only",
  },
  {
    name: "Subdomain SSL Routing",
    category: "Edge Networking",
    syncbay: "Wildcard TLS 1.3 & HTTP/3 QUIC",
    vercel: "Let's Encrypt Wildcard",
    railway: "Standard Let's Encrypt",
    highlight: true,
  },
  {
    name: "Team Collaborator Seats",
    category: "Cost & Transparency",
    syncbay: "Unlimited Seats (Free on Pro)",
    vercel: "$20 / seat / month tax",
    railway: "$20 / seat on Pro",
    highlight: true,
  },
  {
    name: "Egress Bandwidth Pricing",
    category: "Cost & Transparency",
    syncbay: "Included Free (0 egress fees)",
    vercel: "$0.15 / GB overage",
    railway: "$0.10 / GB overage",
  },
];

const CATEGORIES = [
  "Compute & Architecture",
  "Databases & Storage",
  "Developer Experience",
  "DevOps & Reliability",
  "Edge Networking",
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
          ⚔ Platform Comparison
        </div>
        <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">
          Engineered to Outperform Vercel & Railway
        </h2>
        <p className="text-sm font-medium" style={{ color: "#94a3b8" }}>
          A side-by-side technical breakdown. Built for modern developers and engineering teams.
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
                Feature-by-feature architectural comparison
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
              Syncbay PaaS 2.0
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs" style={{ fontFamily: "'Inter', sans-serif", minWidth: "620px" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.12)" }}>
                  <th
                    className="py-4 px-6 font-bold w-2/5"
                    style={{ color: "#cbd5e1", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.06em" }}
                  >
                    Feature
                  </th>
                  <th
                    className="py-4 px-6 font-black w-1/5"
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
                  <th className="py-4 px-6 font-bold w-1/5" style={{ color: "#94a3b8" }}>
                    ▲ Vercel
                  </th>
                  <th className="py-4 px-6 font-bold w-1/5" style={{ color: "#94a3b8" }}>
                    🚂 Railway
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
                          colSpan={4}
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
                          <td className="py-3.5 px-6 text-slate-400 font-medium">{feat.vercel}</td>
                          <td className="py-3.5 px-6 text-slate-400 font-medium">{feat.railway}</td>
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
