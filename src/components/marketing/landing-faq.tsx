"use client";

import React, { useState } from "react";

interface FAQItem {
  question: string;
  answer: string;
  category: string;
}

const FAQS: FAQItem[] = [
  {
    category: "Architecture",
    question: "Where do my apps actually run?",
    answer:
      "Syncbay is a hybrid PaaS. The control plane (dashboard, API, scheduling) runs on Vercel; your apps, builds and managed databases run on Syncbay runner hosts — Linux servers running the Syncbay runner daemon — behind Cloudflare. Today there is one runner region. You can also connect your own server by running the runner daemon on it.",
  },
  {
    category: "Builds & Runtimes",
    question: "Do I need to write a Dockerfile to deploy?",
    answer:
      "No. If your repo has a Dockerfile, Syncbay uses it. Otherwise the runner detects your stack and generates a Dockerfile for Node (Express, Nest, Next.js, Nuxt, Remix, SvelteKit, Astro), static SPAs (Angular, React/Vite, Vue, Svelte, plain HTML), Python (Flask, FastAPI, Django), Go, Rust, PHP/Laravel, Java, Ruby, Deno or Bun, and falls back to Nixpacks. Your own files are never overwritten.",
  },
  {
    category: "Cold Starts",
    question: "Are there cold starts?",
    answer:
      "Not for always-on services, which is the default: they keep running between requests. If you turn on scale-to-zero for a service, it sleeps after its idle timeout and wakes on the next request, so that first request waits while the service starts.",
  },
  {
    category: "Databases",
    question: "How do managed PostgreSQL, Redis and MySQL work?",
    answer:
      "Create a database from the dashboard and Syncbay provisions it on the runner: PostgreSQL (optionally with pgvector), Redis or Valkey, or MySQL. DATABASE_URL or REDIS_URL is added to your services and merged in at deploy time without overriding variables you set. You can test the connection and browse tables in the Data view, and run queries in Query Studio, which is read-only by default.",
  },
  {
    category: "Production Reliability",
    question: "How do zero-downtime releases and rollbacks work?",
    answer:
      "A new deployment builds and starts while the current one keeps serving. Traffic moves only after the new instance answers its health check (/health, then /); a new instance has up to 120 seconds to become healthy. If the build or the check fails, the live version stays up. You can roll back to an earlier build, restart or pause a service from the console, and the health monitor restarts an instance after two failed probes in a row.",
  },
  {
    category: "Domains & Billing",
    question: "Custom domains, TLS and pricing?",
    answer:
      "Every service gets a <service>-<env>.syncbay.app host. Add your own domain, create the DNS records Syncbay shows you, and it is verified and served with TLS through Cloudflare. Billing is usage-based with no per-seat fees — see the pricing page for the rate card — and you can set a monthly spending cap that pauses services when it is reached.",
  },
];

export function LandingFaq() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  const toggle = (idx: number) => {
    setOpenIndex(openIndex === idx ? null : idx);
  };

  return (
    <section id="faq" className="relative py-24 sm:py-32 px-4 sm:px-6 lg:px-8 max-w-5xl mx-auto">
      {/* Section Header */}
      <div className="text-center max-w-3xl mx-auto mb-16">
        <div
          className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-bold tracking-wider uppercase mb-4 shadow-lg"
          style={{
            background: "rgba(6, 182, 212, 0.12)",
            border: "1px solid rgba(6, 182, 212, 0.35)",
            color: "#38bdf8",
            boxShadow: "0 0 20px rgba(6, 182, 212, 0.15)",
          }}
        >
          <span>💡 Answers & Details</span>
        </div>
        <h2 className="text-3xl sm:text-4xl md:text-5xl font-black text-white tracking-tight mb-4">
          Frequently Asked Questions
        </h2>
        <p className="text-base sm:text-lg font-medium leading-relaxed" style={{ color: "#94a3b8" }}>
          Everything you need to know about migrating, deploying, and scaling on Syncbay.
        </p>
      </div>

      {/* Accordion List */}
      <div className="space-y-4">
        {FAQS.map((faq, idx) => {
          const isOpen = openIndex === idx;
          return (
            <div
              key={faq.question}
              className="rounded-2xl transition-all duration-200 overflow-hidden"
              style={{
                background: isOpen ? "rgba(18, 18, 36, 0.85)" : "rgba(12, 12, 24, 0.6)",
                border: isOpen ? "1px solid rgba(6, 182, 212, 0.4)" : "1px solid rgba(255, 255, 255, 0.06)",
                boxShadow: isOpen ? "0 10px 30px rgba(6, 182, 212, 0.15)" : "none",
              }}
            >
              <button
                onClick={() => toggle(idx)}
                className="w-full p-6 text-left flex items-center justify-between gap-4 cursor-pointer"
              >
                <div className="flex items-center gap-3">
                  <span
                    className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-mono font-bold"
                    style={{
                      background: isOpen ? "rgba(6, 182, 212, 0.2)" : "rgba(255, 255, 255, 0.05)",
                      color: isOpen ? "#38bdf8" : "#94a3b8",
                      border: isOpen ? "1px solid rgba(6, 182, 212, 0.3)" : "none",
                    }}
                  >
                    Q{idx + 1}
                  </span>
                  <span className="text-base sm:text-lg font-bold text-white tracking-tight">
                    {faq.question}
                  </span>
                </div>
                <span
                  className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-mono font-bold transition-transform duration-200 flex-shrink-0"
                  style={{
                    background: isOpen ? "rgba(6, 182, 212, 0.2)" : "rgba(255, 255, 255, 0.05)",
                    color: isOpen ? "#38bdf8" : "#94a3b8",
                    transform: isOpen ? "rotate(45deg)" : "rotate(0deg)",
                  }}
                >
                  +
                </span>
              </button>

              {isOpen && (
                <div className="px-6 pb-6 pt-2 border-t border-white/10 text-sm font-medium leading-relaxed text-slate-300">
                  <p>{faq.answer}</p>
                  <div className="mt-4 flex items-center gap-2 text-xs font-mono text-cyan-400">
                    <span>Category: {faq.category}</span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
