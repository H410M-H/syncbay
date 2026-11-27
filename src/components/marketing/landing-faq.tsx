"use client";

import React, { useState } from "react";
import { FAQS } from "@/components/marketing/faq-data";

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
