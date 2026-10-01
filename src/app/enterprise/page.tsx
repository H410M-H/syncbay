"use client";

import React, { useState } from "react";
import Link from "next/link";
import { AsciiBackground } from "@/components/ui/ascii-background";
import { BrandLogo } from "@/components/ui/brand-logo";

export default function EnterprisePage() {
  const [teamSize, setTeamSize] = useState<number>(50);
  const [monthlyBandwidthTb, setMonthlyBandwidthTb] = useState<number>(10);
  const [dedicatedPop, setDedicatedPop] = useState<boolean>(true);
  const [submitted, setSubmitted] = useState(false);
  const [contactEmail, setContactEmail] = useState("");
  const [companyName, setCompanyName] = useState("");

  // Enterprise pricing model vs Vercel Enterprise:
  // Vercel Enterprise typically charges $50k+/year minimum ($4,000+/mo) plus high seat & egress fees.
  // Syncbay Enterprise: $450/mo base with unlimited seats, custom POP cluster, 99.999% SLA.
  const syncbayCost = 450 + (dedicatedPop ? 300 : 0) + (monthlyBandwidthTb > 5 ? (monthlyBandwidthTb - 5) * 40 : 0);
  const competitorCost = Math.max(3500, teamSize * 45 + monthlyBandwidthTb * 150);
  const annualSavings = (competitorCost - syncbayCost) * 12;

  const handleContactSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!contactEmail.trim()) return;
    setSubmitted(true);
  };

  return (
    <div className="min-h-screen bg-black text-white relative selection:bg-cyan-500 selection:text-black">
      <AsciiBackground theme="matrix" opacity={0.18} density="medium" />

      {/* Topbar */}
      <header className="sticky top-0 z-40 border-b border-zinc-800/80 bg-black/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <BrandLogo size="sm" suffix=".ENTERPRISE" href="/" priority />

          <nav className="hidden md:flex items-center space-x-6 text-xs text-zinc-400 font-medium">
            <Link href="/" className="hover:text-white transition-colors">Platform</Link>
            <Link href="/pricing" className="hover:text-white transition-colors">Pricing</Link>
            <Link href="/templates" className="hover:text-white transition-colors">Templates</Link>
            <Link href="/roadmap" className="hover:text-white transition-colors">R&amp;D Roadmap</Link>
          </nav>

          <div className="flex items-center space-x-3 font-mono text-xs">
            <Link
              href="/auth/signin"
              className="px-3.5 py-1.5 rounded-lg border border-zinc-800 hover:border-zinc-700 text-zinc-300 hover:text-white transition-colors"
            >
              Sign In
            </Link>
            <a
              href="#contact"
              className="px-4 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black font-bold transition-all shadow-[0_0_15px_rgba(6,182,212,0.3)]"
            >
              Talk to Sales →
            </a>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-16 space-y-24">
        <div className="text-center max-w-3xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-cyan-500/30 bg-cyan-950/30 text-cyan-400 text-xs font-mono mb-6">
            <span>🛡️</span>
            <span>Enterprise Sovereign Mesh · 99.999% SLA · SOC2 &amp; HIPAA Ready</span>
          </div>

          <h1 className="text-4xl sm:text-6xl font-black text-white tracking-tight font-sans mb-6">
            Enterprise Cloud PaaS. <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-indigo-400 to-fuchsia-400">
              Without the Enterprise Tax.
            </span>
          </h1>

          <p className="text-base sm:text-lg text-zinc-400 leading-relaxed font-sans mb-8">
            Empower your engineering organization with dedicated edge POP clusters, sub-second deployment rollbacks,
            unlimited seats, private VPC peering, and 24/7 dedicated DevOps engineer support.
          </p>

          <div className="flex flex-wrap items-center justify-center gap-4">
            <a
              href="#calculator"
              className="px-6 py-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black font-bold font-mono text-sm transition-all shadow-[0_0_25px_rgba(6,182,212,0.4)]"
            >
              Calculate Enterprise ROI ↓
            </a>
            <a
              href="#contact"
              className="px-6 py-3 rounded-xl border border-zinc-700 hover:border-zinc-500 text-white font-mono text-sm transition-all bg-zinc-900/60"
            >
              Request Custom SLA &amp; BAA
            </a>
          </div>
        </div>

        {/* Enterprise Pillars Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="p-8 rounded-2xl border border-zinc-800 bg-zinc-950/70 backdrop-blur-xl relative group hover:border-cyan-500/50 transition-all">
            <div className="w-12 h-12 rounded-xl bg-cyan-500/10 text-cyan-400 flex items-center justify-center text-2xl mb-6">
              ⚡
            </div>
            <h3 className="text-xl font-bold text-white mb-3">Sub-Second Incident Rollbacks</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              When bad commits hit production, don&apos;t wait 10 minutes for container image rebuilds.
              Syncbay keeps warm healthy replicas at all 6 global edge POPs, shifting DNS traffic in under 400ms.
            </p>
          </div>

          <div className="p-8 rounded-2xl border border-zinc-800 bg-zinc-950/70 backdrop-blur-xl relative group hover:border-indigo-500/50 transition-all">
            <div className="w-12 h-12 rounded-xl bg-indigo-500/10 text-indigo-400 flex items-center justify-center text-2xl mb-6">
              🔒
            </div>
            <h3 className="text-xl font-bold text-white mb-3">Sovereign Data &amp; Private VPC</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Deploy inside dedicated single-tenant VPCs with automated point-in-time recovery (PITR) for PostgreSQL,
              encrypted R2/S3 storage, and real-time SIEM audit log streaming for SOC2 &amp; HIPAA audits.
            </p>
          </div>

          <div className="p-8 rounded-2xl border border-zinc-800 bg-zinc-950/70 backdrop-blur-xl relative group hover:border-fuchsia-500/50 transition-all">
            <div className="w-12 h-12 rounded-xl bg-fuchsia-500/10 text-fuchsia-400 flex items-center justify-center text-2xl mb-6">
              🤝
            </div>
            <h3 className="text-xl font-bold text-white mb-3">Named DevOps Lead &amp; Slack Sync</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Every enterprise contract includes a dedicated US-based Staff DevOps Engineer in your private Slack/Teams channel
              with 15-minute emergency SLA response times and custom architecture reviews.
            </p>
          </div>
        </div>

        {/* Enterprise Cost Calculator */}
        <div id="calculator" className="p-8 sm:p-12 rounded-2xl border border-zinc-800 bg-zinc-950/80 backdrop-blur-xl">
          <div className="text-center max-w-2xl mx-auto mb-10">
            <h2 className="text-2xl sm:text-3xl font-bold text-white mb-3">
              Enterprise Cost Comparison &amp; ROI Simulator
            </h2>
            <p className="text-sm text-zinc-400">
              See what your organization saves by eliminating per-seat developer charges and arbitrary egress markups.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-center">
            {/* Controls */}
            <div className="space-y-6">
              <div>
                <div className="flex justify-between text-sm font-mono mb-2">
                  <span className="text-zinc-300">Engineering Team Seats:</span>
                  <span className="text-cyan-400 font-bold">{teamSize} developers</span>
                </div>
                <input
                  type="range"
                  min="10"
                  max="500"
                  step="5"
                  value={teamSize}
                  onChange={(e) => setTeamSize(parseInt(e.target.value, 10))}
                  className="w-full accent-cyan-400 bg-zinc-800"
                />
              </div>

              <div>
                <div className="flex justify-between text-sm font-mono mb-2">
                  <span className="text-zinc-300">Monthly Edge Egress:</span>
                  <span className="text-cyan-400 font-bold">{monthlyBandwidthTb} TB / month</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="100"
                  step="1"
                  value={monthlyBandwidthTb}
                  onChange={(e) => setMonthlyBandwidthTb(parseInt(e.target.value, 10))}
                  className="w-full accent-cyan-400 bg-zinc-800"
                />
              </div>

              <div className="flex items-center justify-between p-4 rounded-xl border border-zinc-800 bg-zinc-900/50">
                <div>
                  <div className="text-sm font-bold text-white">Dedicated Regional POP Cluster</div>
                  <div className="text-xs text-zinc-400">Isolated compute nodes in Tokyo, Frankfurt, or San Francisco</div>
                </div>
                <input
                  type="checkbox"
                  checked={dedicatedPop}
                  onChange={(e) => setDedicatedPop(e.target.checked)}
                  className="w-5 h-5 accent-cyan-400"
                />
              </div>
            </div>

            {/* Results Display */}
            <div className="p-6 rounded-xl border border-cyan-500/30 bg-cyan-950/10 space-y-4">
              <div className="text-xs font-mono uppercase tracking-wider text-cyan-400 font-bold">
                Projected Annual Savings
              </div>
              <div className="text-4xl sm:text-5xl font-black text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-emerald-400 font-mono">
                ${Math.round(annualSavings).toLocaleString()} / year
              </div>

              <div className="space-y-2 pt-4 border-t border-zinc-800 text-xs font-mono">
                <div className="flex justify-between text-zinc-300">
                  <span>Syncbay Enterprise (Unlimited Seats):</span>
                  <span className="font-bold text-white">${Math.round(syncbayCost)}/mo</span>
                </div>
                <div className="flex justify-between text-zinc-500 line-through">
                  <span>Legacy Competitor (Vercel/AWS Seats):</span>
                  <span>${Math.round(competitorCost)}/mo</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Enterprise Lead Inquiry Form */}
        <div id="contact" className="p-8 sm:p-12 rounded-2xl border border-zinc-800 bg-zinc-950/80 backdrop-blur-xl max-w-2xl mx-auto">
          <div className="text-center mb-8">
            <h2 className="text-2xl font-bold text-white mb-2">Connect With an Enterprise Architect</h2>
            <p className="text-sm text-zinc-400">
              Get custom terms, high-volume pricing, migration credits, and a dedicated pilot environment.
            </p>
          </div>

          {submitted ? (
            <div className="p-8 rounded-xl border border-emerald-500/30 bg-emerald-950/20 text-center space-y-3">
              <div className="text-3xl">✓</div>
              <h3 className="text-lg font-bold text-emerald-400">Inquiry Received</h3>
              <p className="text-xs text-zinc-300">
                A Syncbay enterprise solutions architect will respond within 4 business hours to arrange your customized proof-of-concept.
              </p>
            </div>
          ) : (
            <form onSubmit={handleContactSubmit} className="space-y-4 font-mono text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-zinc-400 mb-1">Company / Organization</label>
                  <input
                    type="text"
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    placeholder="Acme Corp"
                    className="w-full px-3.5 py-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-white focus:border-cyan-400 focus:outline-none"
                    required
                  />
                </div>
                <div>
                  <label className="block text-zinc-400 mb-1">Work Email</label>
                  <input
                    type="email"
                    value={contactEmail}
                    onChange={(e) => setContactEmail(e.target.value)}
                    placeholder="cto@acme.com"
                    className="w-full px-3.5 py-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-white focus:border-cyan-400 focus:outline-none"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-zinc-400 mb-1">Current Infrastructure &amp; Pain Points</label>
                <textarea
                  rows={3}
                  placeholder="Currently spending $4k/mo on Vercel seats; looking for managed Postgres, 0ms cold starts, and custom domains."
                  className="w-full px-3.5 py-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-white focus:border-cyan-400 focus:outline-none"
                />
              </div>

              <button
                type="submit"
                className="w-full py-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black font-bold font-mono transition-all shadow-[0_0_20px_rgba(6,182,212,0.3)]"
              >
                Submit Enterprise Request →
              </button>
            </form>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-800/80 bg-zinc-950/60 py-12 text-center text-xs text-zinc-500 font-mono">
        <p>Syncbay Technologies Inc. · 548 Market St, Suite 82194, San Francisco, CA 94104, United States</p>
        <p className="mt-1">SOC2 Type II &amp; HIPAA Compliant · 99.999% Service Level Agreement Guarantee</p>
      </footer>
    </div>
  );
}
