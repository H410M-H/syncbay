"use client";

import React, { useState } from "react";
import Link from "next/link";
import {
  TEMPLATE_CATEGORIES,
  formatTemplateMetrics,
  listTemplates,
  templateDeployHref,
  type CatalogTemplate,
} from "@/lib/templates/catalog";
import { AsciiBackground } from "@/components/ui/ascii-background";
import { BrandLogo } from "@/components/ui/brand-logo";

const SERVICE_NAME: Record<string, string> = { postgres: "PostgreSQL", redis: "Redis", valkey: "Valkey" };

function servicesLabel(t: CatalogTemplate): string {
  if (t.services.length === 0) return "None";
  return t.services.map((s) => SERVICE_NAME[s.type] + (s.extensions?.includes("vector") ? " + pgvector" : "")).join(", ");
}

const ALL_TEMPLATES = listTemplates();
const CATEGORIES = ["ALL", ...TEMPLATE_CATEGORIES.filter((c) => ALL_TEMPLATES.some((t) => t.category === c))];

export default function TemplatesPage() {
  const [selectedCategory, setSelectedCategory] = useState<string>("ALL");
  const allTemplates = ALL_TEMPLATES;

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
            <span>Open-source templates · 1-click deploy</span>
          </div>

          <h1 className="text-4xl sm:text-6xl font-black text-white tracking-tight font-sans mb-6">
            Start from a template, <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-indigo-400 to-fuchsia-400">
              databases included.
            </span>
          </h1>

          <p className="text-base sm:text-lg text-zinc-400 leading-relaxed font-sans mb-8">
            Each template is a public MSNS-DEV repository with a <code className="text-cyan-400">syncbay.json</code>.
            Deploying one provisions the PostgreSQL, Redis or Valkey it declares, sets its variables and builds the app.
          </p>

          {/* Filter Pills */}
          <div className="flex flex-wrap items-center justify-center gap-2 font-mono text-xs">
            {CATEGORIES.map((cat) => (
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
              key={tmpl.slug}
              className="p-6 rounded-2xl border border-zinc-800 bg-zinc-950/80 backdrop-blur-xl flex flex-col justify-between group hover:border-cyan-500/50 transition-all"
            >
              <div>
                <div className="flex items-center justify-between mb-4">
                  <span className="text-2xl" aria-hidden>
                    {tmpl.icon}
                  </span>
                  <span className="text-xs font-mono text-cyan-400 font-bold px-2.5 py-1 rounded-md bg-cyan-950/40 border border-cyan-800/40">
                    {tmpl.category}
                  </span>
                </div>

                <h3 className="text-lg font-bold text-white mb-2 group-hover:text-cyan-400 transition-colors">
                  {tmpl.name}
                </h3>
                <p className="text-xs text-zinc-400 leading-relaxed mb-4">
                  {tmpl.description}
                </p>

                <div className="flex flex-wrap gap-1.5 mb-6">
                  {tmpl.stack.map((item) => (
                    <span key={item} className="px-2 py-0.5 rounded-md text-[10px] font-mono border border-zinc-800 bg-zinc-900/60 text-zinc-300">
                      {item}
                    </span>
                  ))}
                </div>

                <dl className="space-y-2 py-3 border-t border-zinc-800/80 text-xs font-mono text-zinc-400">
                  <div className="flex justify-between gap-4">
                    <dt>Services:</dt>
                    <dd className="text-white font-bold text-right">{servicesLabel(tmpl)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>App port:</dt>
                    <dd className="text-cyan-400">{tmpl.port}</dd>
                  </div>
                  {formatTemplateMetrics(tmpl.metrics).map((m) => (
                    <div key={m.label} className="flex justify-between">
                      <dt>{m.label}:</dt>
                      <dd className="text-white font-bold">{m.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>

              <div className="pt-4 border-t border-zinc-800/80 flex items-center gap-3">
                <Link
                  href={templateDeployHref(tmpl)}
                  className="flex-1 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black font-bold font-mono text-xs text-center transition-all shadow-[0_0_15px_rgba(6,182,212,0.3)]"
                >
                  ⚡ Deploy to Syncbay
                </Link>
                <a
                  href={tmpl.repoUrl}
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
        <p>Syncbay · Templates are open source at github.com/MSNS-DEV</p>
      </footer>
    </div>
  );
}
