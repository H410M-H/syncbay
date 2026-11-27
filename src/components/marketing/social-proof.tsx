"use client";

import React from "react";
import { TiltCard } from "@/components/ui/tilt-card";

interface Fact {
  text: string;
  title: string;
  source: string;
  /** Where to read more (a page on this site or a public repository). */
  href: string;
  avatar: string;
  highlight: string;
}

// "What you get": each card is a shipped behaviour, with where it lives.
const FACTS: Fact[] = [
  {
    text:
      "A new release starts next to the live one and only takes traffic once it answers its health check. If the build or the check fails, the live version keeps serving and the error stays on the deployment.",
    title: "Zero-downtime releases",
    source: "Deploy engine",
    href: "/docs",
    avatar: "🚦",
    highlight: "Health-Gated Releases",
  },
  {
    text:
      "Every live instance is probed once a minute through the same path your visitors use. After two failures in a row Syncbay restarts it — or redeploys the same build — and records it in your audit log.",
    title: "Health monitor",
    source: "Runs every minute",
    href: "/docs",
    avatar: "🩺",
    highlight: "Auto-Restart",
  },
  {
    text:
      "Services are always-on by default, so they have no cold start. Turn on scale-to-zero per service to save money on idle apps: they sleep after the idle timeout and wake on the next request.",
    title: "Always-on, or scale-to-zero",
    source: "Per-service setting",
    href: "/docs",
    avatar: "⚡",
    highlight: "Your Choice per Service",
  },
  {
    text:
      "Nine open-source starter apps — Next.js, FastAPI, Go, Rust, Node, Django and more — each with a syncbay.json that declares its databases. Read the code, fork it, or deploy it in one click.",
    title: "Open-source templates",
    source: "github.com/MSNS-DEV",
    href: "https://github.com/MSNS-DEV",
    avatar: "📦",
    highlight: "9 Templates on GitHub",
  },
];

// Product constants (see CLAUDE.md), not measurements.
const METRICS = [
  { value: "120 s", label: "Start-up Window", desc: "Time a new instance has to become healthy" },
  { value: "1 min", label: "Health Probe", desc: "Restart after two consecutive failures" },
  { value: "2", label: "Builds at Once", desc: "Concurrent builds per runner host" },
  { value: "30 days", label: "Log Retention", desc: "Build and runtime logs kept per deployment" },
];

export function SocialProof() {
  return (
    <section id="what-you-get" className="relative py-24 sm:py-32 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">
      {/* Platform Scale Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-20">
        {METRICS.map((metric) => (
          <div
            key={metric.label}
            className="p-6 rounded-2xl text-center"
            style={{
              background: "rgba(15, 15, 30, 0.6)",
              border: "1px solid rgba(6, 182, 212, 0.25)",
              boxShadow: "0 10px 30px -10px rgba(0,0,0,0.5)",
            }}
          >
            <div className="text-3xl sm:text-4xl font-black font-mono tracking-tight mb-2 text-white">
              <span
                style={{
                  background: "linear-gradient(135deg, #06B6D4, #3B82F6)",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                }}
              >
                {metric.value}
              </span>
            </div>
            <div className="text-xs font-mono font-bold text-cyan-400 uppercase tracking-wider mb-1">
              {metric.label}
            </div>
            <div className="text-xs text-slate-400 font-medium">
              {metric.desc}
            </div>
          </div>
        ))}
      </div>

      {/* Section Header */}
      <div className="text-center max-w-3xl mx-auto mb-16">
        <div
          className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-bold tracking-wider uppercase mb-4 shadow-lg"
          style={{
            background: "rgba(236, 72, 153, 0.12)",
            border: "1px solid rgba(236, 72, 153, 0.35)",
            color: "#f472b6",
            boxShadow: "0 0 20px rgba(236, 72, 153, 0.15)",
          }}
        >
          <span>✅ What You Get</span>
        </div>
        <h2 className="text-3xl sm:text-4xl md:text-5xl font-black text-white tracking-tight mb-4">
          Built by MSNS-DEV in Pakistan
        </h2>
        <p className="text-base sm:text-lg font-medium leading-relaxed" style={{ color: "#94a3b8" }}>
          Syncbay aims to offer lower prices than US providers. Here is what you get when you deploy — and where each behaviour comes from.
        </p>
      </div>

      {/* Testimonials Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {FACTS.map((t) => (
          <TiltCard key={t.title} glowColor="rgba(6, 182, 212, 0.25)" intensity={8}>
            <div
              className="p-8 rounded-3xl h-full flex flex-col justify-between"
              style={{
                background: "linear-gradient(135deg, rgba(16, 16, 32, 0.9), rgba(8, 8, 20, 0.95))",
                border: "1px solid rgba(255, 255, 255, 0.08)",
                boxShadow: "0 20px 40px -15px rgba(0,0,0,0.8)",
              }}
            >
              <div>
                {/* Highlight Badge */}
                <div className="inline-block px-3 py-1 rounded-full text-xs font-mono font-bold text-cyan-400 bg-cyan-950/40 border border-cyan-800/40 mb-4">
                  ★ {t.highlight}
                </div>

                <p className="text-sm sm:text-base font-medium leading-relaxed text-slate-200 mb-8">
                  {t.text}
                </p>
              </div>

              {/* Author Info */}
              <div className="pt-4 border-t border-white/10 flex items-center gap-4">
                <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl bg-white/5 border border-white/10">
                  {t.avatar}
                </div>
                <div>
                  <h4 className="text-sm font-black text-white leading-tight">
                    {t.title}
                  </h4>
                  <p className="text-xs text-slate-400 font-medium">
                    {t.source} ·{" "}
                    <a href={t.href} className="text-cyan-400 font-semibold hover:text-white transition-colors">
                      Learn more
                    </a>
                  </p>
                </div>
              </div>
            </div>
          </TiltCard>
        ))}
      </div>
    </section>
  );
}
