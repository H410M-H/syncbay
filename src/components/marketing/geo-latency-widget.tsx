"use client";

import React from "react";
import { Globe3D } from "@/components/ui/globe-3d";
import { TiltCard } from "@/components/ui/tilt-card";

interface RoutingStep {
  id: string;
  name: string;
  detail: string;
  /** The highlighted step (where the health gate sits). */
  gate?: boolean;
}

// How a request reaches a Syncbay service (src/proxy.ts, src/lib/tunnel/, runner/src/index.ts).
const ROUTING_STEPS: RoutingStep[] = [
  { id: "DNS", name: "Cloudflare DNS & TLS", detail: "Your syncbay.app host or a verified custom domain" },
  { id: "WAF", name: "Syncbay edge rules", detail: "IP, country and path rules; rate limits" },
  { id: "Canary", name: "Optional canary split", detail: "Weighted, pinned by cookie" },
  { id: "Tunnel", name: "Cloudflare Tunnel", detail: "To the runner host; no open app ports" },
  { id: "Health", name: "Health-gated route", detail: "Only versions that answered their health check", gate: true },
  { id: "App", name: "Your container", detail: "On a Syncbay runner or your own server" },
];

export function GeoLatencyWidget() {
  return (
    <div className="space-y-8">
      {/* Section Header */}
      <div className="text-center max-w-2xl mx-auto">
        <div
          className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-bold tracking-wider uppercase mb-3"
          style={{
            background: "rgba(6, 182, 212, 0.15)",
            border: "1px solid rgba(6, 182, 212, 0.4)",
            color: "#38bdf8",
          }}
        >
          🌐 Cloudflare in Front
        </div>
        <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">
          How a Request Reaches Your App
        </h2>
        <p className="text-sm font-medium" style={{ color: "#94a3b8" }}>
          Cloudflare sits in front of every service. Requests pass your edge rules and reach the runner host over a Cloudflare Tunnel, and only versions that passed their health check receive traffic. Apps run in one runner region today.
        </p>
      </div>

      <div className="flex flex-col lg:flex-row items-center gap-8 lg:gap-12">
        {/* 3D Globe with Cyan Atmospheric Glow */}
        <div className="flex-shrink-0 relative">
          <div
            className="absolute inset-0 rounded-full"
            style={{
              background: "radial-gradient(circle, rgba(6,182,212,0.2) 0%, rgba(124,58,237,0.15) 50%, transparent 75%)",
              filter: "blur(40px)",
            }}
          />
          <Globe3D size={400} className="relative z-10" />
        </div>

        {/* Region Cards */}
        <div className="flex-1 w-full">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 font-mono">
            {ROUTING_STEPS.map((step, idx) => (
              <TiltCard
                key={step.id}
                glowColor={step.gate ? "rgba(6,182,212,0.4)" : "rgba(124,58,237,0.25)"}
                intensity={12}
              >
                <div
                  className="p-5 rounded-xl transition-all h-full"
                  style={{
                    background: step.gate
                      ? "linear-gradient(135deg, rgba(6,182,212,0.18), rgba(59,130,246,0.12))"
                      : "linear-gradient(135deg, rgba(20,20,32,0.9), rgba(10,10,18,0.95))",
                    border: step.gate
                      ? "1px solid rgba(6,182,212,0.6)"
                      : "1px solid rgba(255,255,255,0.12)",
                    boxShadow: step.gate
                      ? "0 0 25px rgba(6,182,212,0.25), inset 0 1px 0 rgba(255,255,255,0.2)"
                      : "0 8px 20px rgba(0,0,0,0.5)",
                  }}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-black text-white uppercase tracking-wider">
                      {step.id}
                    </span>
                    {step.gate ? (
                      <span
                        className="text-[10px] px-2 py-0.5 rounded-full font-bold"
                        style={{
                          background: "rgba(6,182,212,0.25)",
                          color: "#38bdf8",
                          border: "1px solid rgba(6,182,212,0.5)",
                          boxShadow: "0 0 10px rgba(6,182,212,0.4)",
                        }}
                      >
                        GATE
                      </span>
                    ) : (
                      <span className="text-[10px] font-bold" style={{ color: "#64748b" }}>
                        {String(idx + 1).padStart(2, "0")}
                      </span>
                    )}
                  </div>
                  <div className="text-xs font-black mb-2" style={{ color: step.gate ? "#4ade80" : "#38bdf8" }}>
                    {step.name}
                  </div>
                  <div className="text-[11px] font-semibold" style={{ color: "#94a3b8" }}>
                    {step.detail}
                  </div>
                </div>
              </TiltCard>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
