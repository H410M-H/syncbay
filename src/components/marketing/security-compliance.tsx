"use client";

import React from "react";
import { TiltCard } from "@/components/ui/tilt-card";

const SECURITY_PILLARS = [
  {
    icon: "🌐",
    title: "Cloudflare in Front, Tunnel Behind",
    description:
      "Traffic reaches your service through Cloudflare, with TLS on your syncbay.app host and on DNS-verified custom domains. The runner host is reached over a Cloudflare Tunnel, so app ports are never opened to the internet.",
    badge: "Cloudflare",
    color: "#38BDF8",
    glowColor: "rgba(56, 189, 248, 0.3)",
  },
  {
    icon: "🛡️",
    title: "Edge Rules & Rate Limits",
    description:
      "Per-service WAF rules evaluated by the Syncbay edge proxy: IP allow and block lists (IPv4/IPv6 CIDR), country blocks, path blocks and per-IP rate limits, answering 403 or 429 before a request reaches your app.",
    badge: "WAF Rules",
    color: "#8B5CF6",
    glowColor: "rgba(139, 92, 246, 0.3)",
  },
  {
    icon: "🔐",
    title: "Secrets Stay Out of Logs",
    description:
      "Environment values never appear on a command line or in a build log, credentials in URLs and GitHub tokens are redacted from every log line, and the web shell masks secret values. Control plane and runner talk over HMAC-signed, single-use requests.",
    badge: "Redacted",
    color: "#10B981",
    glowColor: "rgba(16, 185, 129, 0.3)",
  },
  {
    icon: "👥",
    title: "Roles & Audit Log",
    description:
      "Owner, Admin, Member and Viewer roles per workspace. Viewers cannot run queries or see database passwords. The workspace audit log records invites, role changes, API tokens, rollbacks and automatic restarts.",
    badge: "Audit Log",
    color: "#F59E0B",
    glowColor: "rgba(245, 158, 11, 0.3)",
  },
];

export function SecurityCompliance() {
  return (
    <section id="security" className="relative py-24 sm:py-32 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">
      {/* Section Header */}
      <div className="text-center max-w-3xl mx-auto mb-16">
        <div
          className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-bold tracking-wider uppercase mb-4 shadow-lg"
          style={{
            background: "rgba(16, 185, 129, 0.12)",
            border: "1px solid rgba(16, 185, 129, 0.35)",
            color: "#34d399",
            boxShadow: "0 0 20px rgba(16, 185, 129, 0.15)",
          }}
        >
          <span>🛡️ Trust & Security</span>
        </div>
        <h2 className="text-3xl sm:text-4xl md:text-5xl font-black text-white tracking-tight mb-4">
          Security Built Into the Platform
        </h2>
        <p className="text-base sm:text-lg font-medium leading-relaxed" style={{ color: "#94a3b8" }}>
          What Syncbay does to protect your apps and credentials today — no certifications or uptime guarantees we cannot back up.
        </p>
      </div>

      {/* 4 Pillars Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-12">
        {SECURITY_PILLARS.map((pillar) => (
          <TiltCard key={pillar.title} glowColor={pillar.glowColor} intensity={10}>
            <div
              className="p-8 rounded-3xl h-full flex flex-col justify-between"
              style={{
                background: "linear-gradient(135deg, rgba(18, 18, 36, 0.9), rgba(10, 10, 22, 0.95))",
                border: "1px solid rgba(255, 255, 255, 0.08)",
                boxShadow: "0 20px 40px -15px rgba(0,0,0,0.7)",
              }}
            >
              <div>
                <div className="flex items-center justify-between mb-6">
                  <div
                    className="w-14 h-14 rounded-2xl flex items-center justify-center text-2xl shadow-lg"
                    style={{
                      background: "rgba(8, 8, 18, 0.9)",
                      border: "1px solid rgba(255, 255, 255, 0.12)",
                      boxShadow: `0 0 20px ${pillar.glowColor}`,
                    }}
                  >
                    {pillar.icon}
                  </div>
                  <span
                    className="px-3 py-1 rounded-full text-xs font-mono font-bold uppercase tracking-wider"
                    style={{
                      background: "rgba(255, 255, 255, 0.05)",
                      border: `1px solid ${pillar.color}40`,
                      color: pillar.color,
                    }}
                  >
                    {pillar.badge}
                  </span>
                </div>

                <h3 className="text-xl font-black text-white mb-3 tracking-tight">
                  {pillar.title}
                </h3>
                <p className="text-sm font-medium leading-relaxed text-slate-300">
                  {pillar.description}
                </p>
              </div>

              <div className="mt-6 pt-4 border-t border-white/10 flex items-center justify-between text-xs font-mono">
                <span className="text-slate-400">Shipped</span>
                <span className="text-emerald-400 font-bold flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" />
                  In the product
                </span>
              </div>
            </div>
          </TiltCard>
        ))}
      </div>

      {/* Trust & Guarantee Banner */}
      <div
        className="p-8 sm:p-10 rounded-3xl flex flex-col md:flex-row items-center justify-between gap-6"
        style={{
          background: "linear-gradient(135deg, rgba(6, 182, 212, 0.08), rgba(124, 58, 237, 0.08))",
          border: "1px solid rgba(6, 182, 212, 0.3)",
          backdropFilter: "blur(16px)",
        }}
      >
        <div className="flex items-center gap-5 text-left">
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl flex-shrink-0 bg-cyan-500/20 border border-cyan-400/30">
            ⚖️
          </div>
          <div>
            <h4 className="text-base font-black text-white mb-1">
              Spending Caps Instead of Surprise Bills
            </h4>
            <p className="text-xs text-slate-300 font-medium">
              Set a monthly cap: owners and admins get an email at 80%, and running services pause at 100%.
            </p>
          </div>
        </div>

        <a
          href="/pricing"
          className="px-6 py-3 rounded-xl text-xs font-bold font-mono transition-all duration-200 hover:scale-105 flex-shrink-0"
          style={{
            background: "linear-gradient(135deg, #06B6D4, #3B82F6)",
            color: "#050510",
            boxShadow: "0 0 20px rgba(6, 182, 212, 0.3)",
          }}
        >
          See Usage Pricing →
        </a>
      </div>
    </section>
  );
}
