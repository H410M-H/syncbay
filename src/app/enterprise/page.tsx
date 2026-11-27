"use client";

import React, { useState } from "react";
import Link from "next/link";
import { AsciiBackground } from "@/components/ui/ascii-background";
import { BrandLogo } from "@/components/ui/brand-logo";

export default function EnterprisePage() {
  const [contactEmail, setContactEmail] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [details, setDetails] = useState("");

  // No backend inbox: the form opens the visitor's email client with a prefilled message.
  const handleContactSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!contactEmail.trim()) return;
    const subject = `Syncbay for ${companyName.trim() || "our team"}`;
    const body = `${details.trim()}\n\nReply to: ${contactEmail.trim()}`;
    window.location.href = `mailto:support@syncbay.app?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  return (
    <div className="min-h-screen bg-black text-white relative selection:bg-cyan-500 selection:text-black">
      <AsciiBackground theme="matrix" opacity={0.18} density="medium" />

      {/* Topbar */}
      <header className="sticky top-0 z-40 border-b border-zinc-800/80 bg-black/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <BrandLogo size="sm" suffix=".TEAMS" href="/" priority />

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
              Contact Us →
            </a>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-16 space-y-24">
        <div className="text-center max-w-3xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-cyan-500/30 bg-cyan-950/30 text-cyan-400 text-xs font-mono mb-6">
            <span>🛡️</span>
            <span>Teams · Own Servers · Spending Caps</span>
          </div>

          <h1 className="text-4xl sm:text-6xl font-black text-white tracking-tight font-sans mb-6">
            Syncbay for Teams. <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-indigo-400 to-fuchsia-400">
              On Our Runners or Yours.
            </span>
          </h1>

          <p className="text-base sm:text-lg text-zinc-400 leading-relaxed font-sans mb-8">
            Workspaces with Owner, Admin, Member and Viewer roles, an audit log, usage-based billing without per-seat
            fees, and spending caps. Run on Syncbay runner hosts, or connect your own Linux server to the same control plane.
          </p>

          <div className="flex flex-wrap items-center justify-center gap-4">
            <a
              href="#own-server"
              className="px-6 py-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black font-bold font-mono text-sm transition-all shadow-[0_0_25px_rgba(6,182,212,0.4)]"
            >
              Bring Your Own Server ↓
            </a>
            <a
              href="#contact"
              className="px-6 py-3 rounded-xl border border-zinc-700 hover:border-zinc-500 text-white font-mono text-sm transition-all bg-zinc-900/60"
            >
              Contact Us
            </a>
          </div>
        </div>

        {/* Enterprise Pillars Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="p-8 rounded-2xl border border-zinc-800 bg-zinc-950/70 backdrop-blur-xl relative group hover:border-cyan-500/50 transition-all">
            <div className="w-12 h-12 rounded-xl bg-cyan-500/10 text-cyan-400 flex items-center justify-center text-2xl mb-6">
              ⚡
            </div>
            <h3 className="text-xl font-bold text-white mb-3">Instant Rollbacks, Health-Gated Releases</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              A new release only takes traffic after it answers its health check, and a failed one leaves the live
              version up. Roll back to an earlier build without rebuilding when the instance can be revived, restart in
              place, or pause a service.
            </p>
          </div>

          <div className="p-8 rounded-2xl border border-zinc-800 bg-zinc-950/70 backdrop-blur-xl relative group hover:border-indigo-500/50 transition-all">
            <div className="w-12 h-12 rounded-xl bg-indigo-500/10 text-indigo-400 flex items-center justify-center text-2xl mb-6">
              🔒
            </div>
            <h3 className="text-xl font-bold text-white mb-3">Your Data on Your Server</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Connect your own Linux host as the runner: builds, containers, managed PostgreSQL, Redis and MySQL, and
              persistent volumes then live on hardware you control, while the control plane schedules and monitors them.
            </p>
          </div>

          <div className="p-8 rounded-2xl border border-zinc-800 bg-zinc-950/70 backdrop-blur-xl relative group hover:border-fuchsia-500/50 transition-all">
            <div className="w-12 h-12 rounded-xl bg-fuchsia-500/10 text-fuchsia-400 flex items-center justify-center text-2xl mb-6">
              🤝
            </div>
            <h3 className="text-xl font-bold text-white mb-3">Roles, Audit Log &amp; Spending Caps</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Viewers can look but cannot run queries or see database passwords. The audit log records invites, role
              changes, API tokens, rollbacks and automatic restarts. Owners and admins get an email at 80% of the
              monthly cap; running services pause at 100%.
            </p>
          </div>
        </div>

        {/* Bring Your Own Server */}
        <div id="own-server" className="p-8 sm:p-12 rounded-2xl border border-zinc-800 bg-zinc-950/80 backdrop-blur-xl">
          <div className="text-center max-w-2xl mx-auto mb-10">
            <h2 className="text-2xl sm:text-3xl font-bold text-white mb-3">
              Bring Your Own Server
            </h2>
            <p className="text-sm text-zinc-400">
              The Syncbay runner is a daemon that clones, builds and runs services on any Linux host. The repository ships a
              Docker Compose setup for it; we connect it to the control plane with a shared secret.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-center">
            <div className="space-y-4 text-sm text-zinc-300">
              {[
                ["1", "A Linux server with Docker", "The runner, its Caddy proxy and an updater run as containers; only ports 80 and 443 are public."],
                ["2", "TLS for the runner's domain", "Caddy obtains the certificate automatically for the domain you point at the server."],
                ["3", "Signed requests only", "Control plane and runner share a secret; every request is HMAC-signed and single-use."],
                ["4", "Updates on its own", "The updater pulls new runner releases and rebuilds; the dashboard warns when a runner is outdated."],
              ].map(([n, title, text]) => (
                <div key={n} className="flex items-start gap-4 p-4 rounded-xl border border-zinc-800 bg-zinc-900/50">
                  <div className="w-8 h-8 rounded-lg bg-cyan-500/10 text-cyan-400 flex items-center justify-center font-mono font-bold flex-shrink-0">
                    {n}
                  </div>
                  <div>
                    <div className="font-bold text-white">{title}</div>
                    <div className="text-xs text-zinc-400 mt-1">{text}</div>
                  </div>
                </div>
              ))}
            </div>

            <div className="p-6 rounded-xl border border-cyan-500/30 bg-cyan-950/10 space-y-4">
              <div className="text-xs font-mono uppercase tracking-wider text-cyan-400 font-bold">
                Control-plane settings for your runner
              </div>
              <pre className="text-xs font-mono text-zinc-300 whitespace-pre-wrap">{`RUNNER_DRIVER=webhook
RUNNER_URL=https://<your-runner-domain>
RUNNER_SECRET=<shared secret>`}</pre>
              <div className="pt-4 border-t border-zinc-800 text-xs text-zinc-400">
                Contact us to connect a server; we set these on the control plane for you.
              </div>
            </div>
          </div>
        </div>

        {/* Enterprise Lead Inquiry Form */}
        <div id="contact" className="p-8 sm:p-12 rounded-2xl border border-zinc-800 bg-zinc-950/80 backdrop-blur-xl max-w-2xl mx-auto">
          <div className="text-center mb-8">
            <h2 className="text-2xl font-bold text-white mb-2">Talk to Us</h2>
            <p className="text-sm text-zinc-400">
              Tell us about your team or the server you want to connect. Submitting opens your email client with a message to support@syncbay.app.
            </p>
          </div>

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
                <label className="block text-zinc-400 mb-1">What do you want to run?</label>
                <textarea
                  rows={3}
                  value={details}
                  onChange={(e) => setDetails(e.target.value)}
                  placeholder="What you run today, and whether you want to use your own server."
                  className="w-full px-3.5 py-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-white focus:border-cyan-400 focus:outline-none"
                />
              </div>

              <button
                type="submit"
                className="w-full py-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black font-bold font-mono transition-all shadow-[0_0_20px_rgba(6,182,212,0.3)]"
              >
                Email Us →
              </button>
            </form>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-800/80 bg-zinc-950/60 py-12 text-center text-xs text-zinc-500 font-mono">
        <p>Syncbay · Built in Pakistan by MSNS-DEV</p>
        <p className="mt-1">support@syncbay.app</p>
      </footer>
    </div>
  );
}
