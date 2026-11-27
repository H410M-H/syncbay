"use client";

import React, { useState } from "react";
import { TiltCard } from "@/components/ui/tilt-card";

interface WorkflowStep {
  step: string;
  badge: string;
  title: string;
  description: string;
  codeTitle: string;
  codeSnippet: string;
  timing: string;
  highlights: string[];
}

const STEPS: WorkflowStep[] = [
  {
    step: "01",
    badge: "Connect GitHub",
    title: "Pick a Repo or a Template",
    description:
      "Sign in with GitHub and choose a repository, or start from a one-click template. Pushes to your branch trigger a deploy through GitHub webhooks; pull requests get their own preview environment.",
    codeTitle: "terminal — your machine",
    codeSnippet: `# Every push to the deployed branch starts a new release
$ git commit -am "feat: new checkout flow"
$ git push origin main

# Opening a pull request creates a preview environment:
#   web-pr-42.syncbay.app  (status posted back to the PR)`,
    timing: "Triggered by git push",
    highlights: [
      "GitHub sign-in; push and pull_request webhooks",
      "PR previews with a syncbay/preview commit status",
      "Templates declare their databases in syncbay.json",
    ],
  },
  {
    step: "02",
    badge: "Build on the Runner",
    title: "Dockerfile, Syncbay Template or Nixpacks",
    description:
      "The runner clones your repo and picks a build strategy: your own Dockerfile first, then a Syncbay-generated Dockerfile for the detected stack, then Nixpacks. Your files are never overwritten.",
    codeTitle: "build log stream (sample)",
    codeSnippet: `[pipeline] Setting up build workspace
[pipeline] Cloning repository: git clone -- https://github.com/you/api
Detected FastAPI from requirements.txt; building with the Syncbay python template
Generated Dockerfile.syncbay: python:3.12-slim
[pipeline] Compiling container image: docker build ...
✔ Docker build succeeded`,
    timing: "Up to 2 builds at once per runner",
    highlights: [
      "Node/Next.js, static SPAs, Python, Go, Rust, PHP, Java, Ruby, Deno, Bun",
      "Fast redeploys reuse the clone; clean rebuilds purge caches",
      "Environment values never appear on a command line or in logs",
    ],
  },
  {
    step: "03",
    badge: "Health-Gated Release",
    title: "Zero-Downtime Switch Over",
    description:
      "The new version starts next to the live one and must answer its health check before traffic moves. If it fails, the live version keeps serving and the error is kept with the deployment. Roll back to any earlier build in one click.",
    codeTitle: "release log (sample)",
    codeSnippet: `[pipeline] Launching application container
[health] Probing http://127.0.0.1:<port>/health
✔ Health check passed — application is healthy and responding
✔ Previous deployment marked SUPERSEDED and stopped
✨ Live at https://api-production.syncbay.app`,
    timing: "Start-up window: 120 s",
    highlights: [
      "Live version serves until the new one answers /health",
      "Failed releases leave the live version up",
      "Instant rollback, restart and pause from the console",
    ],
  },
];

export function HowItWorks() {
  const [activeStep, setActiveStep] = useState(0);

  return (
    <section id="workflow" className="relative py-24 sm:py-32 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">
      {/* Section Header */}
      <div className="text-center max-w-3xl mx-auto mb-16">
        <div
          className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-bold tracking-wider uppercase mb-4 shadow-lg"
          style={{
            background: "rgba(124, 58, 237, 0.15)",
            border: "1px solid rgba(124, 58, 237, 0.4)",
            color: "#c084fc",
            boxShadow: "0 0 20px rgba(124, 58, 237, 0.15)",
          }}
        >
          <span>🔄 Workflow Pipeline</span>
        </div>
        <h2 className="text-3xl sm:text-4xl md:text-5xl font-black text-white tracking-tight mb-4">
          From `git push` to Live in 3 Steps
        </h2>
        <p className="text-base sm:text-lg font-medium leading-relaxed" style={{ color: "#94a3b8" }}>
          No YAML pipelines, no cluster nodes to babysit. Push code, watch the build log, and go live only when the new version is healthy.
        </p>
      </div>

      {/* Step Selector Pills */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-10">
        {STEPS.map((s, idx) => {
          const isSelected = activeStep === idx;
          return (
            <button
              key={s.step}
              onClick={() => setActiveStep(idx)}
              className="p-5 rounded-2xl text-left transition-all duration-300 cursor-pointer flex items-start gap-4"
              style={{
                background: isSelected
                  ? "linear-gradient(135deg, rgba(6, 182, 212, 0.18), rgba(124, 58, 237, 0.15))"
                  : "rgba(15, 15, 31, 0.6)",
                border: isSelected
                  ? "1px solid rgba(6, 182, 212, 0.6)"
                  : "1px solid rgba(255, 255, 255, 0.06)",
                boxShadow: isSelected
                  ? "0 10px 30px rgba(6, 182, 212, 0.2)"
                  : "none",
              }}
            >
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center font-mono font-black text-base flex-shrink-0"
                style={{
                  background: isSelected
                    ? "linear-gradient(135deg, #06B6D4, #7C3AED)"
                    : "rgba(255, 255, 255, 0.05)",
                  color: isSelected ? "#050510" : "#94a3b8",
                }}
              >
                {s.step}
              </div>
              <div>
                <div className="text-xs font-mono font-bold uppercase mb-1" style={{ color: isSelected ? "#38bdf8" : "#64748b" }}>
                  {s.badge}
                </div>
                <h4 className="text-sm font-black text-white leading-tight">
                  {s.title}
                </h4>
              </div>
            </button>
          );
        })}
      </div>

      {/* Active Step Showcase */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
        {/* Left Side: Step Details */}
        <div
          className="lg:col-span-5 p-8 rounded-3xl flex flex-col justify-between"
          style={{
            background: "linear-gradient(135deg, rgba(20, 20, 38, 0.8), rgba(10, 10, 24, 0.9))",
            border: "1px solid rgba(6, 182, 212, 0.25)",
            backdropFilter: "blur(20px)",
          }}
        >
          <div>
            <div className="flex items-center gap-2 mb-4">
              <span
                className="px-3 py-1 rounded-full text-xs font-mono font-bold uppercase"
                style={{ background: "rgba(6, 182, 212, 0.15)", color: "#38bdf8", border: "1px solid rgba(6, 182, 212, 0.3)" }}
              >
                Step {STEPS[activeStep].step} · {STEPS[activeStep].badge}
              </span>
              <span className="text-xs font-mono text-emerald-400 font-bold">
                ⚡ {STEPS[activeStep].timing}
              </span>
            </div>

            <h3 className="text-2xl font-black text-white tracking-tight mb-4">
              {STEPS[activeStep].title}
            </h3>

            <p className="text-sm font-medium leading-relaxed text-slate-300 mb-6">
              {STEPS[activeStep].description}
            </p>

            <div className="space-y-3 pt-4 border-t border-white/10 text-xs font-medium text-slate-300">
              {STEPS[activeStep].highlights.map((h, i) => (
                <div key={i} className="flex items-start gap-2.5">
                  <span className="text-cyan-400 font-bold mt-0.5">✔</span>
                  <span>{h}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-8 pt-4 border-t border-white/10 flex items-center justify-between">
            <span className="text-xs font-mono text-slate-400">
              Step {activeStep + 1} of {STEPS.length}
            </span>
            <div className="flex gap-2">
              <button
                disabled={activeStep === 0}
                onClick={() => setActiveStep((prev) => Math.max(0, prev - 1))}
                className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all disabled:opacity-30 cursor-pointer"
                style={{ border: "1px solid rgba(255, 255, 255, 0.15)", background: "rgba(255,255,255,0.05)" }}
              >
                ← Prev
              </button>
              <button
                disabled={activeStep === STEPS.length - 1}
                onClick={() => setActiveStep((prev) => Math.min(STEPS.length - 1, prev + 1))}
                className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all disabled:opacity-30 cursor-pointer"
                style={{
                  background: "linear-gradient(135deg, #06B6D4, #3B82F6)",
                  color: "#050510",
                }}
              >
                Next Step →
              </button>
            </div>
          </div>
        </div>

        {/* Right Side: Interactive Terminal & Code View */}
        <div className="lg:col-span-7">
          <TiltCard glowColor="rgba(6, 182, 212, 0.35)" intensity={8}>
            <div
              className="rounded-3xl p-6 sm:p-8 h-full flex flex-col justify-between font-mono"
              style={{
                background: "rgba(7, 7, 16, 0.95)",
                border: "1px solid rgba(6, 182, 212, 0.35)",
                boxShadow: "0 25px 60px -15px rgba(0,0,0,0.8), 0 0 35px rgba(6,182,212,0.15)",
              }}
            >
              {/* Window Controls Bar */}
              <div className="flex items-center justify-between pb-4 mb-4 border-b border-white/10">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-rose-500/80" />
                  <div className="w-3 h-3 rounded-full bg-amber-500/80" />
                  <div className="w-3 h-3 rounded-full bg-emerald-500/80" />
                  <span className="ml-2 text-xs font-medium text-slate-400">
                    {STEPS[activeStep].codeTitle}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <span className="w-2 h-2 rounded-full bg-cyan-400 shadow-[0_0_8px_#22d3ee] animate-pulse" />
                  <span>LIVE CONSOLE</span>
                </div>
              </div>

              {/* Code Pre Block */}
              <div className="overflow-x-auto text-xs sm:text-sm leading-relaxed text-slate-300 py-2">
                <pre style={{ margin: 0 }}>
                  <code>{STEPS[activeStep].codeSnippet}</code>
                </pre>
              </div>

              {/* Terminal Footer Indicator */}
              <div className="pt-4 mt-4 border-t border-white/10 flex items-center justify-between text-xs text-slate-400">
                <span>Syncbay runner pipeline</span>
                <span className="text-cyan-400 font-bold">Automated</span>
              </div>
            </div>
          </TiltCard>
        </div>
      </div>
    </section>
  );
}
