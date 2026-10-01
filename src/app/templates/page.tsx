"use client";

import React, { useState } from "react";
import Link from "next/link";
import { getTrendingStacks, TrendingStack } from "@/lib/rd/trending-engine";
import { AsciiBackground } from "@/components/ui/ascii-background";
import { BrandLogo } from "@/components/ui/brand-logo";

export default function TemplatesPage() {
  const [selectedCategory, setSelectedCategory] = useState<string>("ALL");
  const allTemplates: TrendingStack[] = getTrendingStacks("ALL");

  const filtered = allTemplates.filter((t) => {
    if (selectedCategory === "ALL") return true;
    return t.category === selectedCategory;
  });

  return (
    <div className="min-h-screen bg-black text-white relative selection:bg-cyan-500 selection:text-black">
      <AsciiBackground theme="cyber" opacity={0.16} density="medium" />

      {/* Topbar */}
      <header className="sticky top-0 z-40 border-b border-zinc-800/80 bg-black/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <BrandLogo size="sm" suffix=".TEMPLATES" href="/" priority />

          <nav className="hidden md:flex items-center space-x-6 text-xs text-zinc-400 font-medium">
            <Link href="/" className="hover:text-white transition-colors">Platform</Link>
            <Link href="/pricing" className="hover:text-white transition-colors">Pricing</Link>
            <Link href="/enterprise" className="hover:text-white transition-colors">Enterprise</Link>
            <Link href="/roadmap" className="hover:text-white transition-colors">R&amp;D Roadmap</Link>
          </nav>

          <div className="flex items-center space-x-3 font-mono text-xs">
            <Link
              href="/dashboard/projects/new"
              className="px-4 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black font-bold transition-all shadow-[0_0_15px_rgba(6,182,212,0.3)]"
            >
              Deploy Now →
            </Link>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-16 space-y-16">
        <div className="text-center max-w-3xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-cyan-500/30 bg-cyan-950/30 text-cyan-400 text-xs font-mono mb-6">
            <span>🚀</span>
            <span>Trending Developer Stacks · 1-Click Zero-Config Deployment</span>
          </div>

          <h1 className="text-4xl sm:text-6xl font-black text-white tracking-tight font-sans mb-6">
            Deploy Trending Stacks in <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-indigo-400 to-fuchsia-400">
              Under 30 Seconds.
            </span>
          </h1>

          <p className="text-base sm:text-lg text-zinc-400 leading-relaxed font-sans mb-8">
            Battle-tested architecture blueprints configured with automated CI/CD, attached managed PostgreSQL,
            Redis caching, and instant edge routing.
          </p>

          {/* Filter Pills */}
          <div className="flex flex-wrap items-center justify-center gap-2 font-mono text-xs">
            {["ALL", "FRONTEND", "AI_AGENTS", "MICROSERVICES", "DATABASE"].map((cat) => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`px-4 py-2 rounded-xl transition-all ${
                  selectedCategory === cat
                    ? "bg-cyan-500 text-black font-bold shadow-[0_0_15px_rgba(6,182,212,0.4)]"
                    : "border border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-white"
                }`}
              >
                {cat.replace("_", " ")}
              </button>
            ))}
          </div>
        </div>

        {/* Templates Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {filtered.map((tmpl) => (
            <div
              key={tmpl.id}
              className="p-6 rounded-2xl border border-zinc-800 bg-zinc-950/80 backdrop-blur-xl flex flex-col justify-between group hover:border-cyan-500/50 transition-all"
            >
              <div>
                <div className="flex items-center justify-between mb-4">
                  <span className="text-xs font-mono text-cyan-400 font-bold px-2.5 py-1 rounded-md bg-cyan-950/40 border border-cyan-800/40">
                    {tmpl.runtime}
                  </span>
                  <span className="text-xs font-mono text-emerald-400 flex items-center gap-1">
                    ★ {tmpl.githubStarsTrend}
                  </span>
                </div>

                <h3 className="text-lg font-bold text-white mb-2 group-hover:text-cyan-400 transition-colors">
                  {tmpl.name}
                </h3>
                <p className="text-xs text-zinc-400 leading-relaxed mb-6">
                  {tmpl.description}
                </p>

                <div className="space-y-2 py-3 border-t border-zinc-800/80 text-xs font-mono text-zinc-400">
                  <div className="flex justify-between">
                    <span>Average Deploy:</span>
                    <span className="text-white font-bold">{tmpl.deployTimeSec} seconds</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Buildpack Engine:</span>
                    <span className="text-cyan-400">{tmpl.defaultBuildpack}</span>
                  </div>
                </div>
              </div>

              <div className="pt-4 border-t border-zinc-800/80 flex items-center gap-3">
                <Link
                  href={`/dashboard/projects/new?template=${tmpl.id}`}
                  className="flex-1 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black font-bold font-mono text-xs text-center transition-all shadow-[0_0_15px_rgba(6,182,212,0.3)]"
                >
                  ⚡ Deploy to Syncbay
                </Link>
                <a
                  href={tmpl.templateRepo}
                  target="_blank"
                  rel="noreferrer"
                  className="px-3 py-2.5 rounded-xl border border-zinc-800 hover:border-zinc-600 text-zinc-300 font-mono text-xs transition-colors"
                >
                  GitHub
                </a>
              </div>
            </div>
          ))}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-800/80 bg-zinc-950/60 py-12 text-center text-xs text-zinc-500 font-mono">
        <p>Syncbay Technologies Inc. · 548 Market St, Suite 82194, San Francisco, CA 94104, United States</p>
      </footer>
    </div>
  );
}
