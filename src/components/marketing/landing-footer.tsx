"use client";

import React from "react";
import Link from "next/link";
import { BrandLogo } from "@/components/ui/brand-logo";

const FOOTER_COLUMNS = [
  {
    title: "Featured Services",
    links: [
      { label: "Web Services from GitHub", href: "#services" },
      { label: "Managed PostgreSQL", href: "#services" },
      { label: "Redis / Valkey", href: "#services" },
      { label: "Managed MySQL", href: "#services" },
      { label: "Cloudflare R2 Buckets", href: "#services" },
      { label: "Routing via Cloudflare", href: "#latency" },
      { label: "Interactive Web Shell", href: "/dashboard" },
      { label: "SQL Query Studio", href: "/dashboard" },
    ],
  },
  {
    title: "Platform & Engine",
    links: [
      { label: "Dockerfile, Templates & Nixpacks", href: "#workflow" },
      { label: "Zero-Downtime Releases", href: "#workflow" },
      { label: "Instant Rollbacks", href: "#workflow" },
      { label: "PR Preview Environments", href: "#workflow" },
      { label: "Custom Domains & TLS", href: "#services" },
      { label: "Persistent Volumes", href: "/dashboard" },
      { label: "syncbay.json Manifest", href: "#cli-manifest" },
    ],
  },
  {
    title: "DevOps & Security",
    links: [
      { label: "WAF Rules & Rate Limits", href: "#security" },
      { label: "Cron Jobs", href: "/dashboard/crons" },
      { label: "Canary Releases", href: "#services" },
      { label: "Health Monitor", href: "#what-you-get" },
      { label: "vercel.json Importer", href: "/dashboard" },
      { label: "Roles & Permissions", href: "#security" },
      { label: "Workspace Audit Log", href: "/dashboard/audit" },
    ],
  },
  {
    title: "Resources & Docs",
    links: [
      { label: "Platform Documentation", href: "/docs" },
      { label: "OpenAPI 3.1 Specification", href: "/api/v1/openapi.json", external: true },
      { label: "1-Click Templates Catalog", href: "/templates" },
      { label: "Templates on GitHub", href: "https://github.com/MSNS-DEV", external: true },
      { label: "R&D Roadmap", href: "/roadmap" },
      { label: "Capability Matrix", href: "#comparison" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About Syncbay", href: "/" },
      { label: "Usage Pricing", href: "/pricing" },
      { label: "Teams & Own Servers", href: "/enterprise" },
      { label: "Report Abuse", href: "/report-abuse" },
      { label: "Contact Support", href: "mailto:support@syncbay.app" },
    ],
  },
];

// The path a request takes (src/proxy.ts, src/lib/tunnel/, runner/src/index.ts).
const REQUEST_PATH = [
  { code: "cloudflare", name: "DNS & TLS" },
  { code: "edge", name: "WAF rules" },
  { code: "canary", name: "Optional split" },
  { code: "tunnel", name: "Cloudflare Tunnel" },
  { code: "runner", name: "Health-gated" },
  { code: "app", name: "Your container" },
];

export function LandingFooter() {
  return (
    <footer
      className="relative z-10 border-t pt-20 pb-12 px-4 sm:px-6 lg:px-8 text-xs"
      style={{
        borderTop: "1px solid rgba(6, 182, 212, 0.25)",
        background: "linear-gradient(180deg, rgba(8, 8, 18, 0.95) 0%, rgba(4, 4, 10, 0.99) 100%)",
        color: "#94a3b8",
      }}
    >
      <div className="max-w-7xl mx-auto space-y-16">
        {/* Top Tier: Brand, Mission, Live Status & Newsletter */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 pb-16 border-b border-white/10">
          {/* Brand Info & Mission Statement */}
          <div className="lg:col-span-6 space-y-4">
            <BrandLogo size="lg" href="/" />

            <p className="text-sm font-medium leading-relaxed max-w-lg text-slate-300">
              A hybrid PaaS: the control plane runs on Vercel, your apps run on Syncbay runner hosts (or your own server) behind Cloudflare. Push-to-deploy from GitHub, health-checked zero-downtime releases, managed PostgreSQL, Redis and MySQL, an in-browser shell and Query Studio.
            </p>

            {/* Live Status Badge */}
            <div className="flex flex-wrap items-center gap-4 pt-2">
              <div
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-mono font-bold"
                style={{
                  background: "rgba(16, 185, 129, 0.1)",
                  border: "1px solid rgba(16, 185, 129, 0.3)",
                  color: "#34d399",
                }}
              >
                <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399] animate-pulse" />
                <span>Always-on by default · Scale-to-zero opt-in</span>
              </div>
              <span className="text-xs font-mono text-slate-400">
                Built by MSNS-DEV
              </span>
            </div>

            {/* Social Links */}
            <div className="flex items-center gap-3 pt-3">
              <a
                href="https://github.com/MSNS-DEV"
                target="_blank"
                rel="noreferrer"
                className="w-9 h-9 rounded-xl flex items-center justify-center text-sm transition-all duration-200 hover:scale-110"
                style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "#fff" }}
                title="MSNS-DEV on GitHub"
              >
                🐙
              </a>
              <a
                href="/api/v1/openapi.json"
                target="_blank"
                rel="noreferrer"
                className="w-9 h-9 rounded-xl flex items-center justify-center text-sm transition-all duration-200 hover:scale-110"
                style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "#fff" }}
                title="OpenAPI 3.1 Spec"
              >
                ⚡
              </a>
            </div>
          </div>

          {/* Follow Along */}
          <div className="lg:col-span-6 flex flex-col justify-center">
            <div
              className="p-6 sm:p-8 rounded-3xl"
              style={{
                background: "rgba(18, 18, 36, 0.7)",
                border: "1px solid rgba(6, 182, 212, 0.25)",
                backdropFilter: "blur(16px)",
              }}
            >
              <div className="flex items-center gap-2 text-xs font-mono font-bold uppercase mb-2" style={{ color: "#38bdf8" }}>
                <span>📬 Follow Along</span>
              </div>
              <h3 className="text-lg font-black text-white mb-2">
                See What We Are Building Next
              </h3>
              <p className="text-xs text-slate-300 font-medium mb-4 leading-relaxed">
                The roadmap lists what is planned; the templates are open source on GitHub. Questions go to support@syncbay.app.
              </p>

              <div className="flex flex-col sm:flex-row gap-3">
                <Link
                  href="/roadmap"
                  className="flex-1 px-6 py-3 rounded-xl text-xs font-bold font-mono text-center transition-all duration-200 hover:scale-105 whitespace-nowrap shadow-lg"
                  style={{
                    background: "linear-gradient(135deg, #06B6D4, #3B82F6)",
                    color: "#050510",
                  }}
                >
                  View Roadmap →
                </Link>
                <a
                  href="https://github.com/MSNS-DEV"
                  target="_blank"
                  rel="noreferrer"
                  className="flex-1 px-6 py-3 rounded-xl text-xs font-bold font-mono text-center text-white transition-all whitespace-nowrap"
                  style={{
                    background: "rgba(8, 8, 18, 0.9)",
                    border: "1px solid rgba(255, 255, 255, 0.15)",
                  }}
                >
                  MSNS-DEV on GitHub ↗
                </a>
              </div>
            </div>
          </div>
        </div>

        {/* Middle Tier: 5 Comprehensive Navigation Columns */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-8">
          {FOOTER_COLUMNS.map((col) => (
            <div key={col.title} className="space-y-4">
              <h4 className="text-xs font-mono font-bold uppercase tracking-wider text-white">
                {col.title}
              </h4>
              <ul className="space-y-2.5">
                {col.links.map((link) => (
                  <li key={link.label}>
                    {link.external ? (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noreferrer"
                        className="text-slate-400 hover:text-white transition-colors duration-150 inline-flex items-center gap-1"
                      >
                        {link.label}
                        <span className="text-[10px] text-cyan-400">↗</span>
                      </a>
                    ) : (
                      <Link
                        href={link.href}
                        className="text-slate-400 hover:text-white transition-colors duration-150"
                      >
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Request Path Bar */}
        <div
          className="p-6 rounded-2xl"
          style={{
            background: "rgba(12, 12, 26, 0.6)",
            border: "1px solid rgba(255, 255, 255, 0.06)",
          }}
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
            <span className="text-xs font-mono font-bold text-white flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-cyan-400 shadow-[0_0_8px_#22d3ee]" />
              HOW A REQUEST REACHES YOUR APP
            </span>
            <span className="text-xs text-slate-400 font-mono">
              One runner region today
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {REQUEST_PATH.map((pop) => (
              <div
                key={pop.code}
                className="p-2.5 rounded-xl flex items-center justify-between"
                style={{
                  background: "rgba(255, 255, 255, 0.03)",
                  border: "1px solid rgba(255, 255, 255, 0.06)",
                }}
              >
                <div>
                  <div className="text-[11px] font-mono font-bold text-white">
                    {pop.code}
                  </div>
                  <div className="text-[10px] text-slate-400">
                    {pop.name}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom Tier: Maker & Copyright */}
        <div className="pt-8 border-t border-white/10 flex flex-col md:flex-row items-center justify-between gap-6 text-center md:text-left">
          <div className="space-y-1">
            <div className="font-extrabold text-sm tracking-tight text-white font-mono flex items-center justify-center md:justify-start gap-2">
              <span>SYNCBAY<span style={{ color: "#06B6D4" }}>.APP</span></span>
              <span className="text-slate-600">|</span>
              <span className="text-xs text-slate-400 font-normal">
                by MSNS-DEV
              </span>
            </div>
            <p className="text-[11px] text-slate-500">
              Built in Pakistan by MSNS-DEV · Aiming at lower prices than US providers
            </p>
            <p className="text-[11px] text-slate-500">
              © {new Date().getFullYear()} MSNS-DEV. Syncbay — syncbay.app.
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-6 font-semibold text-xs">
            <Link href="/pricing" className="text-cyan-400 hover:text-white transition-colors">
              Usage Pricing
            </Link>
            <Link href="/auth/signin" className="hover:text-white transition-colors">
              Console Sign In
            </Link>
            <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer" className="hover:text-white transition-colors">
              OpenAPI 3.1
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
