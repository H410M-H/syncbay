"use client";

import React, { useState } from "react";
import Link from "next/link";
import { getWeeklyVersionDrops, getStrategicInsights, WeeklyVersionDrop } from "@/lib/rd/trending-engine";
import { AsciiBackground } from "@/components/ui/ascii-background";
import { trpc } from "@/lib/trpc-client";
import { BrandLogo } from "@/components/ui/brand-logo";

export default function RoadmapPage() {
  const weeklyDrops: WeeklyVersionDrop[] = getWeeklyVersionDrops();
  const insights = getStrategicInsights();

  const { data: featureVotes, refetch: refetchVotes } = trpc.rd.getFeatureVotes.useQuery();
  const voteMutation = trpc.rd.voteFeature.useMutation();

  const [votedSet, setVotedSet] = useState<Record<string, boolean>>({});

  const handleVote = async (feature: string) => {
    if (votedSet[feature]) return;
    try {
      await voteMutation.mutateAsync({ feature });
      setVotedSet((prev) => ({ ...prev, [feature]: true }));
      await refetchVotes();
    } catch {
      // Allow optimistic vote
      setVotedSet((prev) => ({ ...prev, [feature]: true }));
    }
  };

  return (
    <div className="min-h-screen bg-black text-white relative selection:bg-cyan-500 selection:text-black">
      <AsciiBackground theme="matrix" opacity={0.16} density="medium" />

      {/* Topbar */}
      <header className="sticky top-0 z-40 border-b border-zinc-800/80 bg-black/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <BrandLogo size="sm" suffix=".ROADMAP" href="/" priority />

          <nav className="hidden md:flex items-center space-x-6 text-xs text-zinc-400 font-medium">
            <Link href="/" className="hover:text-white transition-colors">Platform</Link>
            <Link href="/pricing" className="hover:text-white transition-colors">Pricing</Link>
            <Link href="/enterprise" className="hover:text-white transition-colors">Enterprise</Link>
            <Link href="/templates" className="hover:text-white transition-colors">Templates</Link>
          </nav>

          <div className="flex items-center space-x-3 font-mono text-xs">
            <Link
              href="/dashboard"
              className="px-4 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black font-bold transition-all shadow-[0_0_15px_rgba(6,182,212,0.3)]"
            >
              Open Console →
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-16 space-y-24">
        <div className="text-center max-w-3xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-cyan-500/30 bg-cyan-950/30 text-cyan-400 text-xs font-mono mb-6">
            <span>⚡</span>
            <span>Weekly R&amp;D Sprint Pipeline · Fast Iteration &amp; Zero Regressions</span>
          </div>

          <h1 className="text-4xl sm:text-6xl font-black text-white tracking-tight font-sans mb-6">
            Weekly Feature Drops &amp; <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-indigo-400 to-fuchsia-400">
              R&amp;D Architecture.
            </span>
          </h1>

          <p className="text-base sm:text-lg text-zinc-400 leading-relaxed font-sans mb-8">
            Every Tuesday at 10:00 UTC, Syncbay ships production enhancements driven by high-demand developer trends,
            enterprise security mandates, and edge performance breakthroughs.
          </p>
        </div>

        {/* Weekly Version Pipeline Timeline */}
        <div className="space-y-8 max-w-4xl mx-auto">
          <h2 className="text-xl font-bold font-mono text-white flex items-center gap-2">
            <span>🗓️</span> Weekly Version Changelog &amp; Release Cadence
          </h2>

          <div className="space-y-6">
            {weeklyDrops.map((drop) => {
              const isReleased = drop.status === "RELEASED";
              const isUpcoming = drop.status === "UPCOMING";

              return (
                <div
                  key={drop.version}
                  className={`p-6 sm:p-8 rounded-2xl border backdrop-blur-xl transition-all ${
                    isReleased
                      ? "border-cyan-500/40 bg-zinc-950/90 shadow-[0_0_30px_rgba(6,182,212,0.08)]"
                      : isUpcoming
                      ? "border-indigo-500/40 bg-zinc-950/70"
                      : "border-zinc-800 bg-zinc-950/50 opacity-80"
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                    <div className="flex items-center gap-3">
                      <span className="text-xl font-black font-mono text-white">{drop.version}</span>
                      <span className="text-xs font-mono text-zinc-400">&ldquo;{drop.codename}&rdquo;</span>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-zinc-500">{drop.releaseDate}</span>
                      <span
                        className={`text-xs font-mono px-2.5 py-0.5 rounded-full font-bold ${
                          isReleased
                            ? "bg-emerald-950/60 text-emerald-400 border border-emerald-800/40"
                            : isUpcoming
                            ? "bg-indigo-950/60 text-indigo-400 border border-indigo-800/40"
                            : "bg-zinc-800 text-zinc-400"
                        }`}
                      >
                        {drop.status}
                      </span>
                    </div>
                  </div>

                  <h3 className="text-base font-bold text-cyan-300 mb-3 font-sans">
                    {drop.headline}
                  </h3>

                  <ul className="space-y-2 mb-6">
                    {drop.features.map((feat, i) => (
                      <li key={i} className="text-xs text-zinc-300 flex items-start gap-2">
                        <span className="text-cyan-400 flex-shrink-0">✓</span>
                        <span>{feat}</span>
                      </li>
                    ))}
                  </ul>

                  <div className="pt-4 border-t border-zinc-800/80 text-xs font-mono text-zinc-400 flex items-center gap-2">
                    <span className="text-amber-400 font-bold">Benchmark Impact:</span>
                    <span>{drop.performanceGains}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Strategic R&D Pillars */}
        <div className="max-w-4xl mx-auto space-y-6">
          <h2 className="text-xl font-bold font-mono text-white flex items-center gap-2">
            <span>🔬</span> Strategic R&amp;D Differentiators
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {insights.map((ins) => (
              <div
                key={ins.id}
                className="p-6 rounded-2xl border border-zinc-800 bg-zinc-950/80 backdrop-blur-xl"
              >
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-mono px-2 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-cyan-400 font-bold">
                    {ins.pillar}
                  </span>
                  <span className="text-xs font-mono text-emerald-400">Impact Score: {ins.impactScore}/100</span>
                </div>
                <h4 className="text-base font-bold text-white mb-2">{ins.title}</h4>
                <p className="text-xs text-zinc-400 leading-relaxed">{ins.strategicRationale}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Community & Enterprise Feature Voting */}
        <div className="max-w-4xl mx-auto p-8 rounded-2xl border border-zinc-800 bg-zinc-950/80 backdrop-blur-xl">
          <h2 className="text-xl font-bold font-mono text-white mb-2 flex items-center gap-2">
            <span>🗳️</span> Community &amp; Enterprise Feature Priority Queue
          </h2>
          <p className="text-xs text-zinc-400 mb-6">
            Vote for the capabilities you want included in upcoming Tuesday version releases.
          </p>

          <div className="space-y-3 font-mono text-xs">
            {featureVotes?.map((fv) => (
              <div
                key={fv.feature}
                className="flex items-center justify-between p-4 rounded-xl border border-zinc-800/80 bg-zinc-900/40"
              >
                <span className="text-zinc-200 font-medium">{fv.feature}</span>
                <div className="flex items-center gap-3">
                  <span className="text-cyan-400 font-bold">{fv.votes} votes</span>
                  <button
                    onClick={() => handleVote(fv.feature)}
                    disabled={votedSet[fv.feature]}
                    className={`px-3 py-1.5 rounded-lg transition-all ${
                      votedSet[fv.feature]
                        ? "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                        : "bg-cyan-500 hover:bg-cyan-400 text-black font-bold"
                    }`}
                  >
                    {votedSet[fv.feature] ? "Voted ✓" : "+1 Vote"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-800/80 bg-zinc-950/60 py-12 text-center text-xs text-zinc-500 font-mono">
        <p>Syncbay Technologies Inc. · 548 Market St, Suite 82194, San Francisco, CA 94104, United States</p>
      </footer>
    </div>
  );
}
