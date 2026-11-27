"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";

// Sample deploy log, modelled on the lines the runner pipeline prints (runner/src/pipeline.ts).
const TERMINAL_LOGS = [
  { text: "$ git push origin main", color: "#f8fafc", delay: 0 },
  { text: "[pipeline] Initiating automated build pipeline for job bld_1 (Service: web)", color: "#38bdf8", delay: 350 },
  { text: "[pipeline] Cloning repository: git clone -- https://github.com/you/web", color: "#94a3b8", delay: 800 },
  { text: "✔ Detected Next.js; building with the Syncbay node template", color: "#4ade80", delay: 1300 },
  { text: "✔ Injected DATABASE_URL from your managed PostgreSQL", color: "#4ade80", delay: 1750 },
  { text: "[pipeline] Assigned dynamic host port (target container port: 3000)", color: "#94a3b8", delay: 2200 },
  { text: "[health] Probing /health — previous version keeps serving meanwhile", color: "#c084fc", delay: 2650 },
  { text: "✔ Health check passed — routing traffic to the new version", color: "#4ade80", delay: 3100 },
  { text: "✨ Live at https://web-production.syncbay.app", color: "#facc15", delay: 3500 },
];

// Product constants, not benchmarks: see CLAUDE.md (runner pipeline, health monitor, retention).
const STATS = [
  { label: "Builds at Once per Runner", value: "2", suffix: "builds", color: "#38bdf8" },
  { label: "Start-up Window", value: "120", suffix: "sec", color: "#4ade80" },
  { label: "Restart After", value: "2", suffix: "failed probes", color: "#c084fc" },
  { label: "Log Retention", value: "30", suffix: "days", color: "#facc15" },
];

export function LandingHero() {
  const [copied, setCopied] = useState(false);
  const [visibleLogs, setVisibleLogs] = useState(0);
  const terminalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timers = TERMINAL_LOGS.map((log, i) =>
      setTimeout(() => setVisibleLogs(i + 1), log.delay + 300)
    );
    return () => timers.forEach(clearTimeout);
  }, []);

  const copyCmd = () => {
    navigator.clipboard.writeText("git push origin main");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section className="relative z-10 pt-16 sm:pt-24 pb-16 px-4 max-w-7xl mx-auto">
      {/* 3D Glowing Version Pill */}
      <div className="flex justify-center mb-8">
        <div
          className="inline-flex items-center gap-3 px-6 py-2.5 rounded-full text-xs font-bold tracking-wider uppercase transition-all duration-300 hover:scale-105"
          style={{
            background: "linear-gradient(135deg, rgba(6,182,212,0.2) 0%, rgba(124,58,237,0.2) 100%)",
            border: "1px solid rgba(6,182,212,0.5)",
            color: "#67e8f9",
            boxShadow: "0 0 25px rgba(6,182,212,0.25), inset 0 1px 0 rgba(255,255,255,0.2)",
            backdropFilter: "blur(12px)",
          }}
        >
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-80" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-cyan-400 shadow-[0_0_8px_#22d3ee]" />
          </span>
          SYNCBAY HYBRID PAAS — Runner Hosts behind Cloudflare
        </div>
      </div>

      {/* Main 4K Title with 3D Depth */}
      <h1
        className="text-center text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-black tracking-tight leading-[1.05] mb-6"
        style={{
          fontFamily: "'Inter', system-ui, sans-serif",
          textShadow: "0 10px 40px rgba(0,0,0,0.8)",
        }}
      >
        <span className="text-white drop-shadow-[0_0_25px_rgba(255,255,255,0.2)]">
          Push to Deploy.
        </span>
        <br />
        <span
          style={{
            background: "linear-gradient(135deg, #38bdf8 0%, #818cf8 35%, #c084fc 70%, #f472b6 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
            filter: "drop-shadow(0 0 35px rgba(56,189,248,0.35))",
          }}
        >
          Stay Live While You Ship.
        </span>
      </h1>

      {/* High-Readability Subtitle */}
      <p
        className="text-center text-base sm:text-lg md:text-xl max-w-3xl mx-auto mb-12 leading-relaxed"
        style={{ color: "#cbd5e1", textShadow: "0 2px 10px rgba(0,0,0,0.8)" }}
      >
        Deploy any GitHub repo — your Dockerfile, a Syncbay-generated one, or Nixpacks — to Syncbay runner hosts behind
        Cloudflare. Health-checked zero-downtime releases, managed PostgreSQL, Redis and MySQL, an in-browser shell
        and a read-only-by-default Query Studio.
      </p>

      {/* CTA Buttons with 3D Bevels */}
      <div className="flex flex-col sm:flex-row items-center justify-center gap-5 mb-16">
        <Link href="/auth/signin" className="group relative w-full sm:w-auto">
          <div
            className="absolute -inset-1 rounded-2xl opacity-80 group-hover:opacity-100 transition-opacity duration-300 blur-md"
            style={{ background: "linear-gradient(135deg, #06b6d4, #8b5cf6, #ec4899)" }}
          />
          <div
            className="relative px-8 py-4 rounded-xl font-black text-sm text-center transition-transform duration-200 group-hover:scale-[1.02]"
            style={{
              background: "linear-gradient(135deg, #06b6d4 0%, #38bdf8 100%)",
              color: "#050510",
              boxShadow: "0 10px 25px rgba(6,182,212,0.4), inset 0 1px 0 rgba(255,255,255,0.4)",
            }}
          >
            🚀 Launch a Project
          </div>
        </Link>

        {/* CLI Command Pill with 4K Metallic Border */}
        <div
          className="flex items-center gap-3 px-5 py-3.5 rounded-xl text-xs font-mono"
          style={{
            background: "rgba(18, 18, 30, 0.85)",
            border: "1px solid rgba(6, 182, 212, 0.35)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.1)",
            backdropFilter: "blur(14px)",
            color: "#e2e8f0",
          }}
        >
          <span style={{ color: "#38bdf8", fontWeight: 700 }}>$</span>
          <code style={{ color: "#f8fafc", fontWeight: 600 }}>git push origin main</code>
          <button
            type="button"
            onClick={copyCmd}
            className="px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all hover:scale-105"
            style={{
              background: copied ? "rgba(34, 197, 94, 0.2)" : "rgba(6, 182, 212, 0.15)",
              color: copied ? "#4ade80" : "#38bdf8",
              border: copied ? "1px solid #4ade80" : "1px solid rgba(6, 182, 212, 0.4)",
            }}
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>

      {/* 3D Realistic Metallic Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-5xl mx-auto mb-16">
        {STATS.map((stat) => (
          <div
            key={stat.label}
            className="text-center p-5 rounded-2xl transition-all duration-300 hover:scale-105"
            style={{
              background: "linear-gradient(135deg, rgba(24, 24, 38, 0.85) 0%, rgba(12, 12, 22, 0.95) 100%)",
              border: "1px solid rgba(255, 255, 255, 0.12)",
              boxShadow: "0 12px 30px -5px rgba(0, 0, 0, 0.7), 0 0 15px rgba(6, 182, 212, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.15)",
              backdropFilter: "blur(12px)",
            }}
          >
            <div
              className="text-4xl sm:text-5xl font-black tracking-tight"
              style={{
                color: stat.color,
                textShadow: `0 0 20px ${stat.color}66`,
              }}
            >
              {stat.value}
              <span className="text-sm font-semibold ml-1.5" style={{ color: "#94a3b8" }}>
                {stat.suffix}
              </span>
            </div>
            <div
              className="text-xs font-bold mt-2 tracking-wider uppercase"
              style={{ color: "#cbd5e1" }}
            >
              {stat.label}
            </div>
          </div>
        ))}
      </div>

      {/* 3D Realistic Floating Cyber Terminal */}
      <div className="max-w-4xl mx-auto" style={{ perspective: "1400px" }}>
        <div
          className="rounded-2xl overflow-hidden transition-all duration-500 hover:scale-[1.01]"
          style={{
            transform: "rotateX(3deg)",
            transformStyle: "preserve-3d",
            background: "linear-gradient(180deg, rgba(16, 16, 26, 0.96) 0%, rgba(8, 8, 14, 0.98) 100%)",
            border: "1px solid rgba(6, 182, 212, 0.4)",
            boxShadow:
              "0 30px 80px -15px rgba(0,0,0,0.9), 0 0 45px rgba(6,182,212,0.18), inset 0 1px 1px rgba(255,255,255,0.2)",
            backdropFilter: "blur(20px)",
          }}
        >
          {/* Terminal Header */}
          <div
            className="flex items-center justify-between px-6 py-3.5"
            style={{
              borderBottom: "1px solid rgba(6, 182, 212, 0.2)",
              background: "rgba(255, 255, 255, 0.03)",
            }}
          >
            <div className="flex items-center gap-2.5">
              <div className="w-3.5 h-3.5 rounded-full shadow-[0_0_8px_#ef4444]" style={{ background: "#ef4444" }} />
              <div className="w-3.5 h-3.5 rounded-full shadow-[0_0_8px_#f59e0b]" style={{ background: "#f59e0b" }} />
              <div className="w-3.5 h-3.5 rounded-full shadow-[0_0_8px_#22c55e]" style={{ background: "#22c55e" }} />
              <span
                className="ml-3 text-xs font-bold font-mono tracking-wide"
                style={{ color: "#94a3b8" }}
              >
                syncbay-runner · deploy log (sample)
              </span>
            </div>
            <div className="flex items-center gap-3 text-xs font-mono">
              <span
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full font-bold"
                style={{
                  background: "rgba(34, 197, 94, 0.15)",
                  color: "#4ade80",
                  border: "1px solid rgba(34, 197, 94, 0.3)",
                }}
              >
                <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_#4ade80] animate-pulse" />
                Health-Gated Release
              </span>
            </div>
          </div>

          {/* Terminal Body */}
          <div ref={terminalRef} className="p-7 font-mono text-[13.5px] space-y-2 min-h-[300px]">
            {TERMINAL_LOGS.slice(0, visibleLogs).map((log, idx) => (
              <div
                key={idx}
                className="leading-relaxed"
                style={{
                  color: log.color,
                  animation: "fadeSlideIn 0.3s ease-out forwards",
                  fontWeight: idx === TERMINAL_LOGS.length - 1 ? 700 : 500,
                  textShadow: idx === TERMINAL_LOGS.length - 1 ? "0 0 10px rgba(250,204,21,0.4)" : "none",
                }}
              >
                {log.text}
              </div>
            ))}
            {visibleLogs >= TERMINAL_LOGS.length && (
              <div className="flex items-center pt-3 font-semibold" style={{ color: "#38bdf8" }}>
                <span
                  className="inline-block w-2.5 h-5 mr-2.5"
                  style={{ background: "#38bdf8", animation: "blink 1s step-end infinite", boxShadow: "0 0 10px #38bdf8" }}
                />
                Serving through Cloudflare with TLS on your syncbay.app host...
              </div>
            )}
          </div>
        </div>

        {/* 3D Specular Reflection Floor */}
        <div
          className="h-20 rounded-b-3xl mx-6"
          style={{
            background: "linear-gradient(to bottom, rgba(6,182,212,0.12), transparent)",
            filter: "blur(12px)",
            transform: "scaleY(-0.4) translateY(-25px)",
          }}
        />
      </div>
    </section>
  );
}
