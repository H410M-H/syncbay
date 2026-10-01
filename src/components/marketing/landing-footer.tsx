"use client";

import React, { useState } from "react";
import Link from "next/link";
import { BrandLogo } from "@/components/ui/brand-logo";

const FOOTER_COLUMNS = [
  {
    title: "Featured Services",
    links: [
      { label: "Serverless Edge Containers", href: "#services" },
      { label: "Managed PostgreSQL", href: "#services" },
      { label: "Redis / Valkey Cache", href: "#services" },
      { label: "Managed MySQL", href: "#services" },
      { label: "S3 Object Storage", href: "#services" },
      { label: "6-POP Edge Network", href: "#latency" },
      { label: "Interactive Web Shell", href: "/dashboard" },
      { label: "SQL Query Studio", href: "/dashboard" },
    ],
  },
  {
    title: "Platform & Engine",
    links: [
      { label: "Nixpacks Build Engine", href: "#workflow" },
      { label: "Blue/Green Deployments", href: "#workflow" },
      { label: "Automated Rollbacks", href: "#workflow" },
      { label: "Ephemeral PR Previews", href: "#workflow" },
      { label: "Custom Domains & Auto-SSL", href: "#services" },
      { label: "Wildcard Subdomains", href: "#services" },
      { label: "Persistent Volumes", href: "/dashboard" },
      { label: "Syncbay CLI & Manifest", href: "#cli-manifest" },
    ],
  },
  {
    title: "DevOps & Security",
    links: [
      { label: "Cloudflare Enterprise WAF", href: "#security" },
      { label: "Smart Cron Engine", href: "/dashboard/crons" },
      { label: "Canary Traffic Splitting", href: "#services" },
      { label: "AI Root-Cause Diagnostics", href: "#services" },
      { label: "Vercel / Railway Migrator", href: "#comparison" },
      { label: "Granular RBAC Permissions", href: "#security" },
      { label: "Immutable Audit Logs", href: "/dashboard/audit" },
      { label: "Multi-Factor TOTP Auth", href: "/auth/signin" },
    ],
  },
  {
    title: "Resources & Docs",
    links: [
      { label: "Platform Documentation", href: "/dashboard" },
      { label: "OpenAPI 3.1 Specification", href: "/api/v1/openapi.json", external: true },
      { label: "Geo Latency Telemetry", href: "/api/geo/locate", external: true },
      { label: "1-Click Templates Catalog", href: "/templates" },
      { label: "R&D Weekly Roadmap", href: "/roadmap" },
      { label: "Platform Comparison Matrix", href: "#comparison" },
      { label: "CLI Quickstart Guide", href: "#cli-manifest" },
      { label: "Live System Status Page", href: "#latency" },
    ],
  },
  {
    title: "Company & Legal",
    links: [
      { label: "About Syncbay", href: "/" },
      { label: "Plans & Pricing", href: "/pricing" },
      { label: "Enterprise Sovereign Mesh", href: "/enterprise" },
      { label: "SOC 2 Type II Security", href: "#security" },
      { label: "Privacy Policy", href: "/" },
      { label: "Terms of Service", href: "/" },
      { label: "Acceptable Use Policy", href: "/" },
      { label: "Support & Contact Sales", href: "mailto:support@syncbay.app" },
    ],
  },
];

const EDGE_POPS = [
  { code: "iad1", name: "N. Virginia", ping: "8ms", status: "Healthy" },
  { code: "sfo1", name: "San Francisco", ping: "11ms", status: "Healthy" },
  { code: "fra1", name: "Frankfurt", ping: "16ms", status: "Healthy" },
  { code: "lhr1", name: "London", ping: "14ms", status: "Healthy" },
  { code: "sin1", name: "Singapore", ping: "24ms", status: "Healthy" },
  { code: "syd1", name: "Sydney", ping: "31ms", status: "Healthy" },
];

export function LandingFooter() {
  const [email, setEmail] = useState("");
  const [subscribed, setSubscribed] = useState(false);

  const handleSubscribe = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setSubscribed(true);
    setTimeout(() => {
      setSubscribed(false);
      setEmail("");
    }, 4000);
  };

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
              The Cloud Hyper-Plane for Modern Developers. Next-Gen PaaS engineered to surpass Vercel and Railway with 6 global edge POPs, 0ms cold starts, attached managed PostgreSQL, live interactive Web Shell, and SQL Query Studio.
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
                <span>All 6 Edge POPs Operational · 99.99% SLA</span>
              </div>
              <span className="text-xs font-mono text-slate-400">
                Anycast Mesh v2.4
              </span>
            </div>

            {/* Social Links */}
            <div className="flex items-center gap-3 pt-3">
              <a
                href="https://github.com/H410M-H/syncbay"
                target="_blank"
                rel="noreferrer"
                className="w-9 h-9 rounded-xl flex items-center justify-center text-sm transition-all duration-200 hover:scale-110"
                style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "#fff" }}
                title="GitHub"
              >
                🐙
              </a>
              <a
                href="https://twitter.com"
                target="_blank"
                rel="noreferrer"
                className="w-9 h-9 rounded-xl flex items-center justify-center text-sm transition-all duration-200 hover:scale-110"
                style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "#fff" }}
                title="Twitter / X"
              >
                𝕏
              </a>
              <a
                href="https://discord.gg"
                target="_blank"
                rel="noreferrer"
                className="w-9 h-9 rounded-xl flex items-center justify-center text-sm transition-all duration-200 hover:scale-110"
                style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "#fff" }}
                title="Discord Community"
              >
                💬
              </a>
              <a
                href="https://youtube.com"
                target="_blank"
                rel="noreferrer"
                className="w-9 h-9 rounded-xl flex items-center justify-center text-sm transition-all duration-200 hover:scale-110"
                style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "#fff" }}
                title="YouTube"
              >
                📺
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

          {/* Newsletter / Radar Signup */}
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
                <span>📬 Developer Release Radar</span>
              </div>
              <h3 className="text-lg font-black text-white mb-2">
                Subscribe to Engineering Changelogs
              </h3>
              <p className="text-xs text-slate-300 font-medium mb-4 leading-relaxed">
                Receive release notes, runtime updates, edge benchmarks, and security advisories once a month. No spam ever.
              </p>

              <form onSubmit={handleSubscribe} className="flex flex-col sm:flex-row gap-3">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="developer@acme.corp"
                  required
                  className="flex-1 px-4 py-3 rounded-xl text-xs text-white placeholder-slate-500 font-mono outline-none transition-all"
                  style={{
                    background: "rgba(8, 8, 18, 0.9)",
                    border: "1px solid rgba(255, 255, 255, 0.15)",
                  }}
                />
                <button
                  type="submit"
                  className="px-6 py-3 rounded-xl text-xs font-bold font-mono transition-all duration-200 hover:scale-105 cursor-pointer whitespace-nowrap shadow-lg"
                  style={{
                    background: "linear-gradient(135deg, #06B6D4, #3B82F6)",
                    color: "#050510",
                  }}
                >
                  {subscribed ? "✔ Subscribed!" : "Subscribe →"}
                </button>
              </form>
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

        {/* Global Edge Mesh Status Bar */}
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
              ACTIVE ANYCAST POP NODES
            </span>
            <span className="text-xs text-slate-400 font-mono">
              Auto-Failover Threshold: &lt;500ms
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {EDGE_POPS.map((pop) => (
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
                <div className="text-right">
                  <div className="text-[11px] font-mono font-bold text-emerald-400">
                    {pop.ping}
                  </div>
                  <div className="text-[9px] text-slate-500 uppercase">
                    {pop.status}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom Tier: US Corporate Entity, Delaware Registration, Compliance & Copyright */}
        <div className="pt-8 border-t border-white/10 flex flex-col md:flex-row items-center justify-between gap-6 text-center md:text-left">
          <div className="space-y-1">
            <div className="font-extrabold text-sm tracking-tight text-white font-mono flex items-center justify-center md:justify-start gap-2">
              <span>SYNCBAY<span style={{ color: "#06B6D4" }}>.APP</span></span>
              <span className="text-slate-600">|</span>
              <span className="text-xs text-slate-400 font-normal">
                Syncbay Technologies Inc.
              </span>
            </div>
            <p className="text-[11px] text-slate-500">
              548 Market St, Suite 82194, San Francisco, CA 94104 · Incorporated in Delaware, USA · Tier-1 American Cloud Infrastructure
            </p>
            <p className="text-[11px] text-slate-500">
              © {new Date().getFullYear()} Syncbay Technologies Inc. All rights reserved. Built with precision for developers worldwide.
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-6 font-semibold text-xs">
            <Link href="/pricing" className="text-cyan-400 hover:text-white transition-colors">
              Pricing & Plans
            </Link>
            <Link href="/auth/signin" className="hover:text-white transition-colors">
              Console Sign In
            </Link>
            <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer" className="hover:text-white transition-colors">
              OpenAPI 3.1
            </a>
            <a href="/api/geo/locate" target="_blank" rel="noreferrer" className="hover:text-white transition-colors">
              Geo Telemetry
            </a>
            <span className="flex items-center gap-1.5 text-emerald-400">
              <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#4ade80]" />
              99.99% SLA
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
