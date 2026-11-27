"use client";

import React, { useState } from "react";
import type { UsageResourceType } from "@prisma/client";
import Link from "next/link";
import { AsciiBackground } from "@/components/ui/ascii-background";
import { BrandLogo } from "@/components/ui/brand-logo";
import { USAGE_RATE_CARD, estimateCostCents, formatRateDollars } from "@/lib/billing/pricing";

/** Resources the hourly metering job records today (src/lib/usage/metering.ts). */
const METERED: UsageResourceType[] = ["CPU_ACTIVE_SECONDS", "MEMORY_GIB_HOURS", "EGRESS_GB"];

/** Hours in the month the estimate assumes (an always-on service). */
const HOURS_PER_MONTH = 730;

export default function PricingPage() {
  // Estimator inputs: one always-on service.
  const [calcVcpu, setCalcVcpu] = useState<number>(0.25);
  const [calcMemGib, setCalcMemGib] = useState<number>(0.5);
  const [calcEgressGb, setCalcEgressGb] = useState<number>(20);

  const cpuSeconds = calcVcpu * HOURS_PER_MONTH * 3600;
  const memGibHours = calcMemGib * HOURS_PER_MONTH;
  const lineCents = {
    CPU_ACTIVE_SECONDS: estimateCostCents({ CPU_ACTIVE_SECONDS: cpuSeconds }),
    MEMORY_GIB_HOURS: estimateCostCents({ MEMORY_GIB_HOURS: memGibHours }),
    EGRESS_GB: estimateCostCents({ EGRESS_GB: calcEgressGb }),
  };
  const totalCents = estimateCostCents({
    CPU_ACTIVE_SECONDS: cpuSeconds,
    MEMORY_GIB_HOURS: memGibHours,
    EGRESS_GB: calcEgressGb,
  });
  const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

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
            <a href="#rates" className="hover:text-white transition-colors">
              Rate Card
            </a>
            <a href="#calculator" className="hover:text-white transition-colors">
              Cost Estimator
            </a>
            <a href="#about" className="hover:text-white transition-colors">
              Who Builds Syncbay
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
            <span>💳</span>
            <span>Usage-Based · Spending Caps · Billed Monthly via Stripe</span>
          </div>

          <h1 className="text-4xl sm:text-6xl font-black text-white tracking-tight font-sans mb-6">
            Pay for What Runs. <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-indigo-400 to-fuchsia-400">
              No Per-Seat Fees.
            </span>
          </h1>

          <p className="text-base sm:text-lg text-zinc-400 leading-relaxed font-sans mb-8">
            Syncbay bills by usage from one rate card: compute, memory and network egress, invoiced monthly. Invite your
            whole team at no extra charge, and set a spending cap so a busy month never surprises you. Built in Pakistan,
            Syncbay aims to cost less than US providers.
          </p>
        </div>

        {/* ── HOW BILLING WORKS ── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 font-mono">
          {/* 1. SIGN UP */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 backdrop-blur-xl p-6 flex flex-col justify-between hover:border-zinc-700 transition-colors">
            <div>
              <div className="text-xs uppercase tracking-widest text-zinc-400 mb-1">Sign Up</div>
              <div className="text-3xl font-black text-white font-sans mb-2">No card</div>
              <p className="text-xs text-zinc-400 font-sans leading-relaxed mb-6">
                Create an account with GitHub, Google or email. A card is only needed when you add credits or pay an invoice.
              </p>

              <div className="border-t border-zinc-800/80 pt-6 space-y-3 text-xs text-zinc-300 font-sans">
                <div className="flex items-center gap-2">
                  <span className="text-emerald-400">✓</span> Workspaces with Owner, Admin, Member, Viewer
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-emerald-400">✓</span> No per-seat charge
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-emerald-400">✓</span> One-click open-source templates
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-emerald-400">✓</span> Custom domains with TLS via Cloudflare
                </div>
              </div>
            </div>

            <Link
              href="/auth/signin"
              className="mt-8 block text-center py-3 px-4 rounded-xl border border-zinc-700 hover:border-zinc-500 text-white text-xs font-bold transition-colors"
            >
              Create Account
            </Link>
          </div>

          {/* 2. USAGE (HIGHLIGHTED) */}
          <div className="rounded-2xl border-2 border-cyan-500 bg-gradient-to-b from-cyan-950/40 via-zinc-950/90 to-black backdrop-blur-xl p-6 flex flex-col justify-between shadow-[0_0_35px_rgba(6,182,212,0.25)] relative">
            <div className="absolute -top-3 left-1/2 transform -translate-x-1/2 px-3 py-0.5 rounded-full bg-cyan-400 text-black text-[10px] font-black uppercase tracking-wider shadow-md">
              How You Pay
            </div>

            <div>
              <div className="text-xs uppercase tracking-widest text-cyan-400 mb-1">Usage</div>
              <div className="flex items-baseline gap-1 mb-2">
                <span className="text-4xl font-black text-white font-sans">Metered</span>
                <span className="text-xs text-zinc-400">/ hour</span>
              </div>
              <p className="text-xs text-zinc-300 font-sans leading-relaxed mb-6">
                Usage is recorded per service for every completed hour and priced with the rate card below.
              </p>

              <div className="border-t border-cyan-500/30 pt-6 space-y-3 text-xs text-zinc-200 font-sans">
                {METERED.map((type) => (
                  <div key={type} className="flex items-center gap-2">
                    <span className="text-cyan-400">✓</span> {USAGE_RATE_CARD[type].label}: {formatRateDollars(type)} / {USAGE_RATE_CARD[type].unit}
                  </div>
                ))}
                <div className="flex items-center gap-2">
                  <span className="text-cyan-400">✓</span> Prepaid credits are applied first
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-cyan-400">✓</span> Monthly Stripe invoice with a hosted receipt
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-cyan-400">✓</span> Paused services stop accruing compute
                </div>
              </div>
            </div>

            <Link
              href="/auth/signin"
              className="mt-8 block text-center py-3.5 px-4 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-black text-xs font-extrabold transition-all shadow-[0_0_20px_rgba(6,182,212,0.4)]"
            >
              Start Deploying →
            </Link>
          </div>

          {/* 3. SPENDING CAPS */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 backdrop-blur-xl p-6 flex flex-col justify-between hover:border-zinc-700 transition-colors">
            <div>
              <div className="text-xs uppercase tracking-widest text-fuchsia-400 mb-1">Spending Cap</div>
              <div className="flex items-baseline gap-1 mb-2">
                <span className="text-4xl font-black text-white font-sans">You set it</span>
              </div>
              <p className="text-xs text-zinc-400 font-sans leading-relaxed mb-6">
                A monthly limit per workspace, checked as usage is recorded.
              </p>

              <div className="border-t border-zinc-800/80 pt-6 space-y-3 text-xs text-zinc-300 font-sans">
                <div className="flex items-center gap-2">
                  <span className="text-fuchsia-400">✓</span> Email to owners and admins at 80%
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-fuchsia-400">✓</span> Running services pause at 100%
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-fuchsia-400">✓</span> Sleeping services do not wake past the cap
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-fuchsia-400">✓</span> Month-to-date usage in the dashboard
                </div>
              </div>
            </div>

            <a
              href="mailto:support@syncbay.app"
              className="mt-8 block text-center py-3 px-4 rounded-xl border border-zinc-700 hover:border-zinc-500 text-white text-xs font-bold transition-colors"
            >
              Questions? Email Us
            </a>
          </div>
        </div>

        {/* ── RATE CARD ── */}
        <section id="rates" className="rounded-3xl border border-zinc-800 bg-zinc-950/90 p-8 sm:p-12">
          <div className="max-w-3xl mb-8">
            <h2 className="text-2xl sm:text-3xl font-black text-white tracking-tight">Rate Card</h2>
            <p className="text-xs sm:text-sm text-zinc-400 mt-2">
              The same rates power invoices, spending caps and the usage page. Rows marked “metered” are recorded today.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono" style={{ minWidth: "520px" }}>
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-400 uppercase">
                  <th className="py-3 pr-4">Resource</th>
                  <th className="py-3 pr-4">Price</th>
                  <th className="py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {(Object.keys(USAGE_RATE_CARD) as UsageResourceType[]).map((type) => (
                  <tr key={type} className="border-b border-zinc-900">
                    <td className="py-3 pr-4 text-zinc-200">{USAGE_RATE_CARD[type].label}</td>
                    <td className="py-3 pr-4 text-cyan-300 font-bold">
                      {formatRateDollars(type)} / {USAGE_RATE_CARD[type].unit}
                    </td>
                    <td className="py-3 text-zinc-400">{METERED.includes(type) ? "Metered" : "Not metered yet"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* ── COST ESTIMATOR ── */}
        <section id="calculator" className="rounded-3xl border border-zinc-800 bg-zinc-950/90 p-8 sm:p-12">
          <div className="max-w-3xl mb-10">
            <h2 className="text-2xl sm:text-3xl font-black text-white tracking-tight">
              Cost Estimator
            </h2>
            <p className="text-xs sm:text-sm text-zinc-400 mt-2">
              Estimate one always-on service for a {HOURS_PER_MONTH}-hour month with the rate card above. Your bill
              follows what your service actually uses.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
            {/* Sliders */}
            <div className="space-y-6 font-mono text-xs">
              <div>
                <div className="flex justify-between text-zinc-300 mb-2">
                  <span>Average active vCPU:</span>
                  <strong className="text-cyan-400 text-sm font-sans">{calcVcpu.toFixed(2)} vCPU</strong>
                </div>
                <input
                  type="range"
                  min={0.05}
                  max={2}
                  step={0.05}
                  value={calcVcpu}
                  onChange={(e) => setCalcVcpu(parseFloat(e.target.value))}
                  className="w-full accent-cyan-400 cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
                  <span>0.05 vCPU</span>
                  <span>2 vCPU</span>
                </div>
              </div>

              <div>
                <div className="flex justify-between text-zinc-300 mb-2">
                  <span>Memory:</span>
                  <strong className="text-cyan-400 text-sm font-sans">{calcMemGib.toFixed(2)} GiB</strong>
                </div>
                <input
                  type="range"
                  min={0.125}
                  max={4}
                  step={0.125}
                  value={calcMemGib}
                  onChange={(e) => setCalcMemGib(parseFloat(e.target.value))}
                  className="w-full accent-cyan-400 cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
                  <span>0.125 GiB</span>
                  <span>4 GiB</span>
                </div>
              </div>

              <div>
                <div className="flex justify-between text-zinc-300 mb-2">
                  <span>Monthly Network Egress:</span>
                  <strong className="text-cyan-400 text-sm font-sans">{calcEgressGb} GB</strong>
                </div>
                <input
                  type="range"
                  min={0}
                  max={500}
                  step={5}
                  value={calcEgressGb}
                  onChange={(e) => setCalcEgressGb(parseInt(e.target.value, 10))}
                  className="w-full accent-cyan-400 cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
                  <span>0 GB</span>
                  <span>500 GB</span>
                </div>
              </div>
            </div>

            {/* Estimate Output */}
            <div className="p-8 rounded-2xl border border-cyan-500/30 bg-cyan-950/20 backdrop-blur-xl space-y-6">
              <div className="grid grid-cols-3 gap-4 text-center">
                {METERED.map((type) => (
                  <div key={type} className="p-3 rounded-xl bg-zinc-900/80 border border-zinc-800">
                    <div className="text-[10px] uppercase text-zinc-400 font-mono mb-1">{USAGE_RATE_CARD[type].unit}</div>
                    <div className="text-xl font-extrabold text-cyan-300 font-sans">{dollars(lineCents[type as keyof typeof lineCents])}</div>
                    <div className="text-[10px] text-zinc-500">/ mo</div>
                  </div>
                ))}
              </div>

              <div className="p-4 rounded-xl bg-emerald-950/30 border border-emerald-500/40 text-center">
                <div className="text-xs text-emerald-300 font-mono font-bold mb-1">
                  Estimated monthly total:
                </div>
                <div className="text-3xl font-black text-emerald-400 font-sans">
                  {dollars(totalCents)} / month
                </div>
                <div className="text-[11px] text-zinc-400 mt-1 font-sans">
                  Computed with the same function invoices use; each line is rounded to whole cents.
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── WHO BUILDS SYNCBAY ── */}
        <section id="about" className="rounded-3xl border border-zinc-800 bg-zinc-950/90 p-8 sm:p-12 relative overflow-hidden">
          <div className="absolute right-0 top-0 bottom-0 w-1/3 bg-gradient-to-l from-cyan-950/20 to-transparent pointer-events-none" />

          <div className="max-w-2xl relative z-10">
            <div className="flex items-center gap-2 text-xs font-mono text-cyan-400 mb-4">
              <span className="text-xl">🇵🇰</span>
              <span className="font-bold uppercase tracking-wider">Who Builds Syncbay</span>
            </div>

            <h2 className="text-3xl font-black text-white tracking-tight mb-4 font-sans">
              Built in Pakistan by MSNS-DEV
            </h2>

            <p className="text-sm text-zinc-300 leading-relaxed font-sans mb-6">
              Syncbay is built by <strong>MSNS-DEV</strong>, a team in Pakistan. We aim to offer lower prices than US
              providers while keeping the platform honest: the rates on this page are the rates on your invoice.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs font-mono">
              <div className="p-4 rounded-xl bg-zinc-900/80 border border-zinc-800">
                <div className="text-zinc-500 uppercase text-[10px] mb-1">Open Source Templates</div>
                <a href="https://github.com/MSNS-DEV" target="_blank" rel="noreferrer" className="text-white font-bold hover:text-cyan-300">
                  github.com/MSNS-DEV ↗
                </a>
                <div className="text-zinc-400">Starter apps with syncbay.json</div>
              </div>

              <div className="p-4 rounded-xl bg-zinc-900/80 border border-zinc-800">
                <div className="text-zinc-500 uppercase text-[10px] mb-1">Contact</div>
                <a href="mailto:support@syncbay.app" className="text-white font-bold hover:text-cyan-300">
                  support@syncbay.app
                </a>
                <div className="text-zinc-400">Billing and account questions</div>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-900 bg-black/95 py-12 px-4 sm:px-6">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6 text-xs text-zinc-500 font-mono">
          <div className="flex flex-col sm:flex-row items-center gap-2 sm:gap-4">
            <span className="text-white font-bold">SYNCBAY</span>
            <span>• Built in Pakistan by MSNS-DEV</span>
            <span>• Usage-based pricing</span>
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
          </div>
        </div>
      </footer>
    </div>
  );
}
