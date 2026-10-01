"use client";

import React, { useState } from "react";
import Link from "next/link";
import { AsciiBackground } from "@/components/ui/ascii-background";
import { BrandLogo } from "@/components/ui/brand-logo";

export default function PricingPage() {
  const [billingCycle, setBillingCycle] = useState<"monthly" | "annual">("annual");

  // Calculator states
  const [calcSeats, setCalcSeats] = useState<number>(5);
  const [calcServices, setCalcServices] = useState<number>(6);
  const [calcEgressGb, setCalcEgressGb] = useState<number>(300);

  // Compute estimates:
  // Syncbay: Pro plan $18 (or $15 annual) includes unlimited seats, 500GB egress. Extra egress: $0.04/GB
  const syncbayBase = billingCycle === "annual" ? 15 : 18;
  const syncbayExtraEgress = Math.max(0, calcEgressGb - 500) * 0.04;
  const syncbayMonthly = syncbayBase + syncbayExtraEgress;

  // Vercel Pro: $20 / seat / month + $0.15 / GB egress over 1TB (or 100GB on standard)
  const vercelMonthly = calcSeats * 20 + Math.max(0, calcEgressGb - 100) * 0.15;

  // Railway: $5 base + $20/vCPU-mo + $10/GB-RAM + $0.10/GB egress (~$15/service average)
  const railwayMonthly = 5 + calcServices * 14 + calcEgressGb * 0.10;

  const annualSavingsVercel = Math.max(0, (vercelMonthly - syncbayMonthly) * 12);
  const annualSavingsRailway = Math.max(0, (railwayMonthly - syncbayMonthly) * 12);

  return (
    <div className="min-h-screen bg-black text-white relative selection:bg-cyan-500 selection:text-black">
      <AsciiBackground theme="cyber" opacity={0.22} density="medium" />

      {/* Navigation Topbar */}
      <header className="sticky top-0 z-40 border-b border-zinc-800/80 bg-black/70 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <BrandLogo size="sm" href="/" priority />

          <nav className="hidden md:flex items-center space-x-6 text-xs text-zinc-400 font-medium">
            <Link href="/" className="hover:text-white transition-colors">
              Platform
            </Link>
            <a href="#comparison" className="hover:text-white transition-colors">
              Competitor Breakdown
            </a>
            <a href="#calculator" className="hover:text-white transition-colors">
              Savings Calculator
            </a>
            <a href="#us-company" className="hover:text-white transition-colors">
              US Headquarters 🇺🇸
            </a>
          </nav>

          <div className="flex items-center space-x-3 font-mono text-xs">
            <Link
              href="/auth/signin"
              className="px-3.5 py-1.5 rounded-lg border border-zinc-800 hover:border-zinc-700 text-zinc-300 hover:text-white transition-colors"
            >
              Sign In
            </Link>
            <Link
              href="/dashboard"
              className="px-4 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black font-bold transition-all shadow-[0_0_15px_rgba(6,182,212,0.3)]"
            >
              Console →
            </Link>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-16 space-y-24">
        {/* Hero Section */}
        <div className="text-center max-w-3xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-cyan-500/30 bg-cyan-950/30 text-cyan-400 text-xs font-mono mb-6">
            <span>🇺🇸</span>
            <span>American Cloud Engineering · Transparent PaaS Economics</span>
          </div>

          <h1 className="text-4xl sm:text-6xl font-black text-white tracking-tight font-sans mb-6">
            Predictable Cloud Pricing. <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-indigo-400 to-fuchsia-400">
              Zero Seat Taxes.
            </span>
          </h1>

          <p className="text-base sm:text-lg text-zinc-400 leading-relaxed font-sans mb-8">
            Why pay $20/month per seat on Vercel or face unpredictable compute spikes on Railway?
            Syncbay delivers 6 global edge POPs, native managed PostgreSQL &amp; Redis, and automated
            zero-downtime rollbacks at unmatched value.
          </p>

          {/* Billing Cycle Toggle */}
          <div className="inline-flex items-center p-1.5 rounded-xl bg-zinc-900 border border-zinc-800">
            <button
              onClick={() => setBillingCycle("monthly")}
              className={`px-5 py-2 rounded-lg text-xs font-mono font-bold transition-all ${
                billingCycle === "monthly"
                  ? "bg-zinc-800 text-white shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              Monthly Billing
            </button>
            <button
              onClick={() => setBillingCycle("annual")}
              className={`px-5 py-2 rounded-lg text-xs font-mono font-bold transition-all flex items-center gap-2 ${
                billingCycle === "annual"
                  ? "bg-cyan-500 text-black shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <span>Annual Billing</span>
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-black/20 text-black uppercase font-black">
                Save 20%
              </span>
            </button>
          </div>
        </div>

        {/* ── PRICING CARDS ── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 font-mono">
          {/* 1. HOBBY */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 backdrop-blur-xl p-6 flex flex-col justify-between hover:border-zinc-700 transition-colors">
            <div>
              <div className="text-xs uppercase tracking-widest text-zinc-400 mb-1">Hobby</div>
              <div className="text-3xl font-black text-white font-sans mb-2">$0</div>
              <p className="text-xs text-zinc-400 font-sans leading-relaxed mb-6">
                Forever free. Ideal for side projects, personal experiments, and prototypes.
              </p>

              <div className="border-t border-zinc-800/80 pt-6 space-y-3 text-xs text-zinc-300 font-sans">
                <div className="flex items-center gap-2">
                  <span className="text-emerald-400">✓</span> 3 Active Services
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-emerald-400">✓</span> 1 Managed PostgreSQL DB (1 GB)
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-emerald-400">✓</span> 100 GB Edge Network Egress
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-emerald-400">✓</span> 6 Global Edge POPs (TLS 1.3)
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-emerald-400">✓</span> Automated SSL &amp; Custom Domains
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-emerald-400">✓</span> Automated Git CI/CD Builds
                </div>
              </div>
            </div>

            <Link
              href="/auth/signin"
              className="mt-8 block text-center py-3 px-4 rounded-xl border border-zinc-700 hover:border-zinc-500 text-white text-xs font-bold transition-colors"
            >
              Start Free
            </Link>
          </div>

          {/* 2. PRO (HIGHLIGHTED) */}
          <div className="rounded-2xl border-2 border-cyan-500 bg-gradient-to-b from-cyan-950/40 via-zinc-950/90 to-black backdrop-blur-xl p-6 flex flex-col justify-between shadow-[0_0_35px_rgba(6,182,212,0.25)] relative">
            <div className="absolute -top-3 left-1/2 transform -translate-x-1/2 px-3 py-0.5 rounded-full bg-cyan-400 text-black text-[10px] font-black uppercase tracking-wider shadow-md">
              Most Popular · Best Value
            </div>

            <div>
              <div className="text-xs uppercase tracking-widest text-cyan-400 mb-1">Pro Developer</div>
              <div className="flex items-baseline gap-1 mb-2">
                <span className="text-4xl font-black text-white font-sans">
                  ${billingCycle === "annual" ? "15" : "18"}
                </span>
                <span className="text-xs text-zinc-400">/ month</span>
              </div>
              <p className="text-xs text-zinc-300 font-sans leading-relaxed mb-6">
                Engineered for serious developers and startups who refuse to pay Vercel&apos;s $20/seat tax.
              </p>

              <div className="border-t border-cyan-500/30 pt-6 space-y-3 text-xs text-zinc-200 font-sans">
                <div className="flex items-center gap-2 font-bold text-white">
                  <span className="text-cyan-400">✓</span> Unlimited Services &amp; Projects
                </div>
                <div className="flex items-center gap-2 font-bold text-cyan-300">
                  <span className="text-cyan-400">✓</span> Unlimited Team Seats (Zero Seat Tax!)
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-cyan-400">✓</span> 0ms Cold Start Latency (Edge Containers)
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-cyan-400">✓</span> 500 GB Fast Edge Egress ($0.04/GB)
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-cyan-400">✓</span> Scale-to-Zero Auto-Sleep (0 vCPU idle)
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-cyan-400">✓</span> Attached Managed PostgreSQL + Redis + MySQL
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-cyan-400">✓</span> Interactive Web Shell &amp; SQL Studio
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-cyan-400">✓</span> Ephemeral PR Previews with Env Clones
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-cyan-400">✓</span> Blue/Green Zero-Downtime Rollback
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-cyan-400">✓</span> Automated Edge Crons &amp; Webhooks
                </div>
              </div>
            </div>

            <Link
              href="/auth/signin"
              className="mt-8 block text-center py-3.5 px-4 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-black text-xs font-extrabold transition-all shadow-[0_0_20px_rgba(6,182,212,0.4)]"
            >
              Deploy on Pro →
            </Link>
          </div>

          {/* 3. ENTERPRISE */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 backdrop-blur-xl p-6 flex flex-col justify-between hover:border-zinc-700 transition-colors">
            <div>
              <div className="text-xs uppercase tracking-widest text-fuchsia-400 mb-1">Enterprise</div>
              <div className="flex items-baseline gap-1 mb-2">
                <span className="text-4xl font-black text-white font-sans">
                  ${billingCycle === "annual" ? "360" : "450"}
                </span>
                <span className="text-xs text-zinc-400">/ month</span>
              </div>
              <p className="text-xs text-zinc-400 font-sans leading-relaxed mb-6">
                Isolated infrastructure, custom SLAs, and American regulatory compliance guarantees.
              </p>

              <div className="border-t border-zinc-800/80 pt-6 space-y-3 text-xs text-zinc-300 font-sans">
                <div className="flex items-center gap-2 font-bold text-white">
                  <span className="text-fuchsia-400">✓</span> Dedicated Isolated Edge POPs
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-fuchsia-400">✓</span> 99.99% Uptime Guarantee SLA
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-fuchsia-400">✓</span> Immutable Audit Log Streaming
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-fuchsia-400">✓</span> 24/7 Dedicated DevOps Engineer Support
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-fuchsia-400">✓</span> 5,000 GB Edge Network Egress
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-fuchsia-400">✓</span> Custom VPC Peering &amp; Private IP
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-fuchsia-400">✓</span> SOC2 Type II &amp; HIPAA Documents
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-fuchsia-400">✓</span> Invoiced Billing &amp; Custom Spending Caps
                </div>
              </div>
            </div>

            <a
              href="mailto:sales@syncbay.app"
              className="mt-8 block text-center py-3 px-4 rounded-xl border border-zinc-700 hover:border-zinc-500 text-white text-xs font-bold transition-colors"
            >
              Contact Enterprise
            </a>
          </div>
        </div>

        {/* ── INTERACTIVE VALUE SAVINGS CALCULATOR ── */}
        <section id="calculator" className="rounded-3xl border border-zinc-800 bg-zinc-950/90 p-8 sm:p-12">
          <div className="max-w-3xl mb-10">
            <h2 className="text-2xl sm:text-3xl font-black text-white tracking-tight">
              Interactive Cost Comparison Calculator
            </h2>
            <p className="text-xs sm:text-sm text-zinc-400 mt-2">
              See what your team actually pays on Vercel and Railway vs Syncbay’s transparent edge model.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
            {/* Sliders */}
            <div className="space-y-6 font-mono text-xs">
              <div>
                <div className="flex justify-between text-zinc-300 mb-2">
                  <span>Team Collaborators:</span>
                  <strong className="text-cyan-400 text-sm font-sans">{calcSeats} Seats</strong>
                </div>
                <input
                  type="range"
                  min={1}
                  max={40}
                  value={calcSeats}
                  onChange={(e) => setCalcSeats(parseInt(e.target.value, 10))}
                  className="w-full accent-cyan-400 cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
                  <span>1 dev</span>
                  <span>40 devs</span>
                </div>
              </div>

              <div>
                <div className="flex justify-between text-zinc-300 mb-2">
                  <span>Active Services &amp; APIs:</span>
                  <strong className="text-cyan-400 text-sm font-sans">{calcServices} Services</strong>
                </div>
                <input
                  type="range"
                  min={1}
                  max={25}
                  value={calcServices}
                  onChange={(e) => setCalcServices(parseInt(e.target.value, 10))}
                  className="w-full accent-cyan-400 cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
                  <span>1 service</span>
                  <span>25 services</span>
                </div>
              </div>

              <div>
                <div className="flex justify-between text-zinc-300 mb-2">
                  <span>Monthly Network Egress:</span>
                  <strong className="text-cyan-400 text-sm font-sans">{calcEgressGb} GB</strong>
                </div>
                <input
                  type="range"
                  min={50}
                  max={2000}
                  step={50}
                  value={calcEgressGb}
                  onChange={(e) => setCalcEgressGb(parseInt(e.target.value, 10))}
                  className="w-full accent-cyan-400 cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
                  <span>50 GB</span>
                  <span>2,000 GB</span>
                </div>
              </div>
            </div>

            {/* Live Comparison Output */}
            <div className="p-8 rounded-2xl border border-cyan-500/30 bg-cyan-950/20 backdrop-blur-xl space-y-6">
              <div className="grid grid-cols-3 gap-4 text-center">
                <div className="p-3 rounded-xl bg-zinc-900/80 border border-zinc-800">
                  <div className="text-[10px] uppercase text-zinc-400 font-mono mb-1">Vercel Pro</div>
                  <div className="text-xl font-extrabold text-red-400 font-sans">${vercelMonthly.toFixed(0)}</div>
                  <div className="text-[10px] text-zinc-500">/ mo</div>
                </div>

                <div className="p-3 rounded-xl bg-zinc-900/80 border border-zinc-800">
                  <div className="text-[10px] uppercase text-zinc-400 font-mono mb-1">Railway</div>
                  <div className="text-xl font-extrabold text-amber-400 font-sans">${railwayMonthly.toFixed(0)}</div>
                  <div className="text-[10px] text-zinc-500">/ mo</div>
                </div>

                <div className="p-3 rounded-xl bg-cyan-500/10 border-2 border-cyan-400">
                  <div className="text-[10px] uppercase text-cyan-300 font-mono font-bold mb-1">Syncbay</div>
                  <div className="text-2xl font-black text-cyan-300 font-sans">${syncbayMonthly.toFixed(0)}</div>
                  <div className="text-[10px] text-cyan-400 font-bold">/ mo</div>
                </div>
              </div>

              <div className="p-4 rounded-xl bg-emerald-950/30 border border-emerald-500/40 text-center">
                <div className="text-xs text-emerald-300 font-mono font-bold mb-1">
                  Estimated Annual Savings with Syncbay:
                </div>
                <div className="text-3xl font-black text-emerald-400 font-sans">
                  ${annualSavingsVercel.toLocaleString(undefined, { maximumFractionDigits: 0 })} / year
                </div>
                <div className="text-[11px] text-zinc-400 mt-1 font-sans">
                  Saved vs Vercel (${(annualSavingsRailway).toLocaleString(undefined, { maximumFractionDigits: 0 })}/yr saved vs Railway)
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── COMPETITOR FEATURE BREAKDOWN MATRIX ── */}
        <section id="comparison" className="rounded-3xl border border-zinc-800 bg-zinc-950/80 overflow-hidden">
          <div className="p-6 sm:p-8 border-b border-zinc-800 bg-zinc-900/50">
            <h3 className="text-2xl font-black text-white tracking-tight">
              Feature-by-Feature Competitor Tear-Down
            </h3>
            <p className="text-xs text-zinc-400 mt-1">
              Engineered to dominate Vercel, Railway, and Render on every developer metric.
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-xs">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900/30 text-zinc-400">
                  <th className="p-4 pl-6">Feature Dimension</th>
                  <th className="p-4 text-cyan-400 font-bold bg-cyan-950/20">Syncbay PaaS</th>
                  <th className="p-4 text-zinc-300">Vercel</th>
                  <th className="p-4 text-zinc-300">Railway</th>
                  <th className="p-4 pr-6 text-zinc-300">Render</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60 font-sans text-xs">
                <tr>
                  <td className="p-4 pl-6 font-semibold text-white">Team Seat Fees</td>
                  <td className="p-4 text-cyan-300 font-bold bg-cyan-950/10">Included (Free Seats)</td>
                  <td className="p-4 text-red-400">$20 / seat / mo tax</td>
                  <td className="p-4 text-zinc-400">$20 / seat on Pro</td>
                  <td className="p-4 text-zinc-400">$19 / user / mo</td>
                </tr>
                <tr>
                  <td className="p-4 pl-6 font-semibold text-white">Execution Timeouts</td>
                  <td className="p-4 text-cyan-300 font-bold bg-cyan-950/10">No Timeouts (Persistent)</td>
                  <td className="p-4 text-red-400">10s – 60s hard limit</td>
                  <td className="p-4 text-emerald-400">No timeout</td>
                  <td className="p-4 text-emerald-400">No timeout</td>
                </tr>
                <tr>
                  <td className="p-4 pl-6 font-semibold text-white">Cold Start Latency</td>
                  <td className="p-4 text-cyan-300 font-bold bg-cyan-950/10">0 ms (Edge Containers)</td>
                  <td className="p-4 text-zinc-400">250ms – 900ms</td>
                  <td className="p-4 text-amber-400">2,000ms – 6,000ms</td>
                  <td className="p-4 text-red-400">50,000ms (Free spin-up)</td>
                </tr>
                <tr>
                  <td className="p-4 pl-6 font-semibold text-white">Multi-Region Edge Routing</td>
                  <td className="p-4 text-cyan-300 font-bold bg-cyan-950/10">6 Tier-1 Global POPs</td>
                  <td className="p-4 text-zinc-400">Serverless Edge only</td>
                  <td className="p-4 text-red-400">Single region locked</td>
                  <td className="p-4 text-red-400">Single region locked</td>
                </tr>
                <tr>
                  <td className="p-4 pl-6 font-semibold text-white">Interactive Web Terminal</td>
                  <td className="p-4 text-cyan-300 font-bold bg-cyan-950/10">Full VT100 Web Shell</td>
                  <td className="p-4 text-red-400">Not Available</td>
                  <td className="p-4 text-zinc-400">Log viewer only</td>
                  <td className="p-4 text-zinc-400">Render Shell Add-on</td>
                </tr>
                <tr>
                  <td className="p-4 pl-6 font-semibold text-white">Embedded Query Studio</td>
                  <td className="p-4 text-cyan-300 font-bold bg-cyan-950/10">SQL &amp; Redis Runner</td>
                  <td className="p-4 text-red-400">Not Available</td>
                  <td className="p-4 text-zinc-400">Basic schema view</td>
                  <td className="p-4 text-red-400">Not Available</td>
                </tr>
                <tr>
                  <td className="p-4 pl-6 font-semibold text-white">Automated Edge Crons</td>
                  <td className="p-4 text-cyan-300 font-bold bg-cyan-950/10">Built-in (Zero extra charge)</td>
                  <td className="p-4 text-zinc-400">Limited (1/day on hobby)</td>
                  <td className="p-4 text-zinc-400">Requires worker runner</td>
                  <td className="p-4 text-zinc-400">Cron Jobs (Paid)</td>
                </tr>
                <tr>
                  <td className="p-4 pl-6 font-semibold text-white">Edge WAF &amp; Rate Limiting</td>
                  <td className="p-4 text-cyan-300 font-bold bg-cyan-950/10">Included in Team ($39)</td>
                  <td className="p-4 text-red-400">Enterprise Add-on ($$$$)</td>
                  <td className="p-4 text-red-400">Not Available</td>
                  <td className="p-4 text-red-400">Not Available</td>
                </tr>
                <tr>
                  <td className="p-4 pl-6 font-semibold text-white">Network Egress Cost</td>
                  <td className="p-4 text-cyan-300 font-bold bg-cyan-950/10">$0.04 / GB (Fair-Cost)</td>
                  <td className="p-4 text-red-400">$0.15 / GB (3.7x markup)</td>
                  <td className="p-4 text-amber-400">$0.10 / GB</td>
                  <td className="p-4 text-amber-400">$0.10 / GB</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* ── OFFICIAL AMERICAN COMPANY & HEADQUARTERS SECTION ── */}
        <section id="us-company" className="rounded-3xl border border-zinc-800 bg-zinc-950/90 p-8 sm:p-12 relative overflow-hidden">
          <div className="absolute right-0 top-0 bottom-0 w-1/3 bg-gradient-to-l from-cyan-950/20 to-transparent pointer-events-none" />

          <div className="max-w-2xl relative z-10">
            <div className="flex items-center gap-2 text-xs font-mono text-cyan-400 mb-4">
              <span className="text-xl">🇺🇸</span>
              <span className="font-bold uppercase tracking-wider">Official Corporate Location</span>
            </div>

            <h2 className="text-3xl font-black text-white tracking-tight mb-4 font-sans">
              Proudly Engineered in the United States
            </h2>

            <p className="text-sm text-zinc-300 leading-relaxed font-sans mb-6">
              Syncbay is developed and operated by <strong>Syncbay Technologies Inc.</strong>, an American corporation
              headquartered in the heart of San Francisco&apos;s Financial District. Our edge cloud orchestration
              and container backbones comply with strict US data privacy and SOC2 readiness standards.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs font-mono">
              <div className="p-4 rounded-xl bg-zinc-900/80 border border-zinc-800">
                <div className="text-zinc-500 uppercase text-[10px] mb-1">Corporate Headquarters</div>
                <div className="text-white font-bold">Syncbay Technologies Inc.</div>
                <div className="text-zinc-400">548 Market St, Suite 82194</div>
                <div className="text-zinc-400">San Francisco, CA 94104, United States</div>
              </div>

              <div className="p-4 rounded-xl bg-zinc-900/80 border border-zinc-800">
                <div className="text-zinc-500 uppercase text-[10px] mb-1">Legal Jurisdiction</div>
                <div className="text-white font-bold">State of Delaware, USA</div>
                <div className="text-zinc-400">C-Corporation Registration</div>
                <div className="text-zinc-400">US Cloud Sovereignty Guaranteed</div>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-900 bg-black/95 py-12 px-4 sm:px-6">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6 text-xs text-zinc-500 font-mono">
          <div className="flex flex-col sm:flex-row items-center gap-2 sm:gap-4">
            <span className="text-white font-bold">SYNCBAY TECHNOLOGIES INC.</span>
            <span>• San Francisco, CA, USA</span>
            <span>• Fair Cloud Economics</span>
          </div>

          <div className="flex items-center space-x-6">
            <Link href="/" className="hover:text-white transition-colors">
              Home
            </Link>
            <Link href="/auth/signin" className="hover:text-white transition-colors">
              Console Sign In
            </Link>
            <a href="mailto:support@syncbay.app" className="hover:text-white transition-colors">
              Contact Support
            </a>
            <span className="text-emerald-400 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              6/6 POPs Operational
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
