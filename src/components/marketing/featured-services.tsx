"use client";

import React, { useState } from "react";
import Link from "next/link";
import { TiltCard } from "@/components/ui/tilt-card";

interface ServiceItem {
  id: string;
  category: "compute" | "database" | "storage" | "dx" | "devops";
  icon: string;
  title: string;
  subtitle: string;
  description: string;
  badge: string;
  badgeColor: string;
  glowColor: string;
  gradient: string;
  metrics: string;
  specs: string[];
  ctaText: string;
  ctaHref: string;
}

const SERVICES: ServiceItem[] = [
  {
    id: "web-services",
    category: "compute",
    icon: "🚀",
    title: "Web Services from GitHub",
    subtitle: "Containers on Syncbay Runner Hosts",
    description:
      "Deploy a repo with your own Dockerfile, a Syncbay-generated Dockerfile (Node/Next.js, static SPAs, Python, Go, Rust, PHP/Laravel, Java, Ruby, Deno, Bun) or Nixpacks. Services stay running by default; scale-to-zero is opt-in.",
    badge: "Push to Deploy",
    badgeColor: "#06B6D4",
    glowColor: "rgba(6, 182, 212, 0.4)",
    gradient: "linear-gradient(135deg, rgba(6, 182, 212, 0.16), rgba(59, 130, 246, 0.08))",
    metrics: "Always-on by default",
    specs: [
      "Zero-downtime, health-checked releases",
      "Instant rollback, restart and pause",
      "PR preview environments on GitHub",
      "Fast redeploys reuse the clone and caches",
    ],
    ctaText: "Deploy Web Service →",
    ctaHref: "/dashboard/projects/new",
  },
  {
    id: "managed-databases",
    category: "database",
    icon: "🐘",
    title: "Managed Databases",
    subtitle: "PostgreSQL, Redis/Valkey & MySQL",
    description:
      "PostgreSQL (with pgvector on request), Redis or Valkey, and MySQL, provisioned on the runner next to your apps. DATABASE_URL / REDIS_URL are injected into your services without overriding your own variables.",
    badge: "On the Runner",
    badgeColor: "#10B981",
    glowColor: "rgba(16, 185, 129, 0.4)",
    gradient: "linear-gradient(135deg, rgba(16, 185, 129, 0.16), rgba(6, 182, 212, 0.08))",
    metrics: "Health-checked instances",
    specs: [
      "Query Studio, read-only by default",
      "Data view: test connections, browse tables",
      "Connection URLs injected at deploy time",
      "Passwords masked for Viewers",
    ],
    ctaText: "Launch Database →",
    ctaHref: "/dashboard/databases/new",
  },
  {
    id: "object-storage",
    category: "storage",
    icon: "📦",
    title: "Buckets & Volumes",
    subtitle: "Cloudflare R2 + Persistent Volumes",
    description:
      "Create private Cloudflare R2 buckets from the dashboard, browse folders and download through short-lived presigned links. Attach persistent volumes to services and browse their files read-only.",
    badge: "Cloudflare R2",
    badgeColor: "#F59E0B",
    glowColor: "rgba(245, 158, 11, 0.4)",
    gradient: "linear-gradient(135deg, rgba(245, 158, 11, 0.16), rgba(239, 68, 68, 0.08))",
    metrics: "Private by default",
    specs: [
      "Real R2 buckets, created via the R2 API",
      "Presigned GET/PUT URLs",
      "Persistent volumes mounted into services",
      "Read-only file browser for volumes",
    ],
    ctaText: "Create Bucket →",
    ctaHref: "/dashboard/buckets/new",
  },
  {
    id: "domains-edge",
    category: "compute",
    icon: "🌐",
    title: "Domains & Routing via Cloudflare",
    subtitle: "Cloudflare in Front of Every App",
    description:
      "Each service gets its own <service>-<env>.syncbay.app host. Add custom domains with TLS through Cloudflare; traffic reaches the runner over a Cloudflare Tunnel and goes only to versions that passed their health check.",
    badge: "Cloudflare",
    badgeColor: "#8B5CF6",
    glowColor: "rgba(139, 92, 246, 0.4)",
    gradient: "linear-gradient(135deg, rgba(139, 92, 246, 0.16), rgba(236, 72, 153, 0.08))",
    metrics: "Health-gated routing",
    specs: [
      "Custom domains with TLS via Cloudflare",
      "DNS-verified domain ownership",
      "Cloudflare Tunnel to the runner host",
      "Cloudflare cache purge from the console",
    ],
    ctaText: "How Routing Works →",
    ctaHref: "#latency",
  },
  {
    id: "web-shell-studio",
    category: "dx",
    icon: "📟",
    title: "Web Shell, Logs & Metrics",
    subtitle: "In-Browser Shell into Your Container",
    description:
      "Open a shell inside a running container from the browser, with secret values masked in the output. Follow live build and runtime logs, and watch CPU, memory and traffic metrics per deployment.",
    badge: "Built In",
    badgeColor: "#EC4899",
    glowColor: "rgba(236, 72, 153, 0.4)",
    gradient: "linear-gradient(135deg, rgba(236, 72, 153, 0.16), rgba(124, 58, 237, 0.08))",
    metrics: "Live logs · 30-day retention",
    specs: [
      "Shell sessions scoped to workspace members",
      "Live log streaming with reconnect",
      "CPU, memory and request metrics",
      "Rule-based diagnostics that suggest, never apply",
    ],
    ctaText: "Explore Console →",
    ctaHref: "/dashboard",
  },
  {
    id: "devops-canary",
    category: "devops",
    icon: "🛡️",
    title: "Crons, WAF Rules & Canaries",
    subtitle: "Operations Built Into the Edge Proxy",
    description:
      "Schedule HTTP cron jobs against your services, block or allow traffic with WAF rules and rate limits, and split traffic between a stable and a canary release. A vercel.json importer brings over crons and rules.",
    badge: "DevOps Suite",
    badgeColor: "#38BDF8",
    glowColor: "rgba(56, 189, 248, 0.4)",
    gradient: "linear-gradient(135deg, rgba(56, 189, 248, 0.16), rgba(16, 185, 129, 0.08))",
    metrics: "Rules · Canaries · Crons",
    specs: [
      "5-field cron schedules (UTC) with retries",
      "IP, CIDR, country and path rules; rate limits",
      "Weighted canary releases with sticky cookie",
      "Canary rollback on 5xx error rate",
    ],
    ctaText: "View DevOps Suite →",
    ctaHref: "/dashboard",
  },
];

const CATEGORIES = [
  { id: "all", label: "All Services", icon: "✨" },
  { id: "compute", label: "Compute & Routing", icon: "🚀" },
  { id: "database", label: "Managed DBs", icon: "🐘" },
  { id: "storage", label: "Storage", icon: "📦" },
  { id: "dx", label: "Web Shell & DX", icon: "📟" },
  { id: "devops", label: "DevOps & WAF", icon: "🛡️" },
];

export function FeaturedServices() {
  const [activeCategory, setActiveCategory] = useState<string>("all");

  const filteredServices =
    activeCategory === "all"
      ? SERVICES
      : SERVICES.filter((s) => s.category === activeCategory);

  return (
    <section id="services" className="relative py-24 sm:py-32 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">
      {/* Ambient background glow */}
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-4xl h-96 pointer-events-none opacity-20"
        style={{
          background: "radial-gradient(circle, rgba(6, 182, 212, 0.35) 0%, rgba(124, 58, 237, 0.2) 50%, transparent 70%)",
          filter: "blur(60px)",
        }}
      />

      {/* Section Header */}
      <div className="relative z-10 text-center max-w-3xl mx-auto mb-16">
        <div
          className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-bold tracking-wider uppercase mb-4 shadow-lg"
          style={{
            background: "rgba(6, 182, 212, 0.12)",
            border: "1px solid rgba(6, 182, 212, 0.35)",
            color: "#38bdf8",
            boxShadow: "0 0 20px rgba(6, 182, 212, 0.15)",
          }}
        >
          <span>⚡ Platform Capabilities</span>
        </div>
        <h2 className="text-3xl sm:text-4xl md:text-5xl font-black text-white tracking-tight mb-4">
          Everything Your App Needs, in One Console
        </h2>
        <p className="text-base sm:text-lg font-medium leading-relaxed" style={{ color: "#94a3b8" }}>
          Deploy, run and watch your services without maintaining Kubernetes clusters or wiring up VPCs — with usage-based billing and spending caps.
        </p>

        {/* Category Filter Tabs */}
        <div className="flex flex-wrap items-center justify-center gap-2 mt-8 p-1.5 rounded-2xl max-w-2xl mx-auto"
          style={{
            background: "rgba(15, 15, 31, 0.75)",
            border: "1px solid rgba(255, 255, 255, 0.08)",
            backdropFilter: "blur(12px)",
          }}
        >
          {CATEGORIES.map((cat) => {
            const isSelected = activeCategory === cat.id;
            return (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className="px-4 py-2 rounded-xl text-xs font-bold transition-all duration-200 flex items-center gap-2 cursor-pointer"
                style={{
                  background: isSelected
                    ? "linear-gradient(135deg, rgba(6, 182, 212, 0.25), rgba(124, 58, 237, 0.25))"
                    : "transparent",
                  color: isSelected ? "#ffffff" : "#94a3b8",
                  border: isSelected ? "1px solid rgba(6, 182, 212, 0.5)" : "1px solid transparent",
                  boxShadow: isSelected ? "0 0 15px rgba(6, 182, 212, 0.25)" : "none",
                }}
              >
                <span>{cat.icon}</span>
                <span>{cat.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Services Grid with Generous Responsive Padding */}
      <div className="relative z-10 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
        {filteredServices.map((service) => (
          <TiltCard key={service.id} glowColor={service.glowColor} intensity={12}>
            <div
              className="p-8 rounded-3xl h-full flex flex-col justify-between transition-all duration-300 relative overflow-hidden"
              style={{
                background: service.gradient,
                border: "1px solid rgba(255, 255, 255, 0.08)",
                boxShadow: "0 20px 40px -15px rgba(0,0,0,0.7)",
              }}
            >
              {/* Top Row: Icon + Badge */}
              <div>
                <div className="flex items-center justify-between mb-6">
                  <div
                    className="w-14 h-14 rounded-2xl flex items-center justify-center text-2xl shadow-xl"
                    style={{
                      background: "rgba(10, 10, 22, 0.9)",
                      border: "1px solid rgba(255, 255, 255, 0.15)",
                      boxShadow: `0 0 25px ${service.glowColor}`,
                    }}
                  >
                    {service.icon}
                  </div>
                  <span
                    className="px-3 py-1 rounded-full text-xs font-extrabold uppercase tracking-wider"
                    style={{
                      background: "rgba(10, 10, 25, 0.8)",
                      border: `1px solid ${service.badgeColor}40`,
                      color: service.badgeColor,
                    }}
                  >
                    {service.badge}
                  </span>
                </div>

                <div className="text-xs font-mono font-bold tracking-wider uppercase mb-1.5" style={{ color: "#38bdf8" }}>
                  {service.subtitle}
                </div>
                <h3 className="text-xl font-black text-white mb-3 tracking-tight">
                  {service.title}
                </h3>
                <p className="text-sm font-medium leading-relaxed text-slate-300 mb-6">
                  {service.description}
                </p>

                {/* Specs List */}
                <ul className="space-y-2.5 mb-6 pt-4 border-t border-white/10 text-xs font-medium text-slate-300">
                  {service.specs.map((spec, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <span className="text-cyan-400 font-bold">✔</span>
                      <span>{spec}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Bottom Card Footer */}
              <div className="pt-5 border-t border-white/10 flex items-center justify-between">
                <span className="text-xs font-mono text-slate-400 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" />
                  {service.metrics}
                </span>

                <Link
                  href={service.ctaHref}
                  className="inline-flex items-center gap-1 text-xs font-bold transition-all duration-200 hover:translate-x-1"
                  style={{ color: "#38bdf8" }}
                >
                  {service.ctaText}
                </Link>
              </div>
            </div>
          </TiltCard>
        ))}
      </div>
    </section>
  );
}
