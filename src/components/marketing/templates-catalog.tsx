"use client";

import React from "react";
import Link from "next/link";
import { TiltCard } from "@/components/ui/tilt-card";
import {
  formatTemplateMetrics,
  listTemplates,
  templateDeployHref,
  type CatalogTemplate,
  type TemplateCategory,
} from "@/lib/templates/catalog";

const TEMPLATES = listTemplates();

/** Card colours per catalog category (presentation only). */
const CATEGORY_STYLE: Record<TemplateCategory, { gradient: string; glowColor: string }> = {
  FRONTEND: { gradient: "linear-gradient(135deg, rgba(6,182,212,0.18), rgba(59,130,246,0.12))", glowColor: "rgba(6,182,212,0.3)" },
  API: { gradient: "linear-gradient(135deg, rgba(124,58,237,0.18), rgba(236,72,153,0.12))", glowColor: "rgba(124,58,237,0.3)" },
  AI: { gradient: "linear-gradient(135deg, rgba(236,72,153,0.18), rgba(124,58,237,0.12))", glowColor: "rgba(236,72,153,0.3)" },
  REALTIME: { gradient: "linear-gradient(135deg, rgba(6,182,212,0.18), rgba(16,185,129,0.12))", glowColor: "rgba(6,182,212,0.3)" },
  DATA: { gradient: "linear-gradient(135deg, rgba(59,130,246,0.18), rgba(124,58,237,0.12))", glowColor: "rgba(59,130,246,0.3)" },
  MICROSERVICES: { gradient: "linear-gradient(135deg, rgba(34,197,94,0.18), rgba(6,182,212,0.12))", glowColor: "rgba(34,197,94,0.3)" },
};

const SERVICE_NAME: Record<string, string> = { postgres: "Postgres", redis: "Redis", valkey: "Valkey" };

/** "Postgres + pgvector · Redis" for a template's backing services. */
function servicesLabel(t: CatalogTemplate): string {
  if (t.services.length === 0) return "No database";
  return t.services.map((s) => SERVICE_NAME[s.type] + (s.extensions?.includes("vector") ? " + pgvector" : "")).join(" · ");
}

export function TemplatesCatalog() {
  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="text-center max-w-2xl mx-auto">
        <div
          className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-bold tracking-wider uppercase mb-3"
          style={{
            background: "rgba(124, 58, 237, 0.15)",
            border: "1px solid rgba(124, 58, 237, 0.4)",
            color: "#c084fc",
          }}
        >
          ⚡ Instant Architecture
        </div>
        <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">
          1-Click Production Templates
        </h2>
        <p className="text-sm font-medium" style={{ color: "#94a3b8" }}>
          Open-source starter apps with their databases declared in <code>syncbay.json</code>: Syncbay provisions them and deploys the app.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {TEMPLATES.map((tpl) => {
          const look = CATEGORY_STYLE[tpl.category];
          const metrics = formatTemplateMetrics(tpl.metrics);
          return (
          <TiltCard key={tpl.slug} glowColor={look.glowColor} intensity={14}>
            <div
              className="p-6 rounded-2xl h-full flex flex-col justify-between"
              style={{
                background: look.gradient,
              }}
            >
              <div>
                <div className="flex items-start justify-between mb-4">
                  <div
                    className="w-12 h-12 rounded-xl flex items-center justify-center text-xl font-bold shadow-lg"
                    style={{
                      background: "rgba(18, 18, 28, 0.9)",
                      border: "1px solid rgba(255, 255, 255, 0.2)",
                    }}
                  >
                    {tpl.icon}
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className="px-2.5 py-1 rounded-md text-[11px] font-mono font-bold"
                      style={{
                        background: "rgba(0,0,0,0.5)",
                        border: "1px solid rgba(255, 255, 255, 0.15)",
                        color: "#38bdf8",
                      }}
                    >
                      {servicesLabel(tpl)}
                    </span>
                  </div>
                </div>

                <h3 className="text-base font-extrabold text-white mb-2 tracking-tight">
                  {tpl.name}
                </h3>
                <p className="text-xs font-medium leading-relaxed mb-4 text-slate-300">
                  {tpl.description}
                </p>

                {metrics.length > 0 && (
                  <dl className="flex flex-wrap gap-x-4 gap-y-1 mb-4 text-[11px] font-mono text-slate-300">
                    {metrics.map((m) => (
                      <div key={m.label} className="flex gap-1">
                        <dt className="text-slate-400">{m.label}</dt>
                        <dd className="text-white font-bold">{m.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}

                <div className="flex flex-wrap gap-1.5 mb-6">
                  {tpl.stack.map((tag) => (
                    <span
                      key={tag}
                      className="px-2.5 py-1 rounded-md text-[10px] font-medium"
                      style={{
                        background: "rgba(255,255,255,0.08)",
                        border: "1px solid rgba(255,255,255,0.12)",
                        color: "#e2e8f0",
                      }}
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>

              <Link
                href={templateDeployHref(tpl)}
                className="w-full block py-2.5 rounded-xl text-center text-xs font-bold transition-all duration-200 hover:scale-[1.02]"
                style={{
                  background: "linear-gradient(135deg, rgba(6,182,212,0.9), rgba(59,130,246,0.9))",
                  color: "#050510",
                  boxShadow: "0 4px 15px rgba(6,182,212,0.3)",
                }}
              >
                Deploy Template →
              </Link>
            </div>
          </TiltCard>
          );
        })}
      </div>
    </div>
  );
}
