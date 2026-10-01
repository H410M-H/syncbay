"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { LandingHero } from "@/components/marketing/landing-hero";
import { FeaturedServices } from "@/components/marketing/featured-services";
import { HowItWorks } from "@/components/marketing/how-it-works";
import { CliManifestShowcase } from "@/components/marketing/cli-manifest-showcase";
import { GeoLatencyWidget } from "@/components/marketing/geo-latency-widget";
import { ComparisonTable } from "@/components/marketing/comparison-table";
import { TemplatesCatalog } from "@/components/marketing/templates-catalog";
import { SecurityCompliance } from "@/components/marketing/security-compliance";
import { SocialProof } from "@/components/marketing/social-proof";
import { LandingFaq } from "@/components/marketing/landing-faq";
import { LandingFooter } from "@/components/marketing/landing-footer";
import { BrandLogo } from "@/components/ui/brand-logo";

export default function HomePage() {
  const [sessionUser, setSessionUser] = useState<{ name?: string | null; email?: string | null } | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((data) => {
        if (data?.user) setSessionUser(data.user);
      })
      .catch(() => null);
  }, []);

  return (
    <div
      className="min-h-screen relative selection:bg-cyan-500/30 selection:text-white"
      style={{ background: "#050510", color: "#f1f5f9" }}
    >
      {/* Navigation Bar with Glassmorphic 3D Bevel */}
      <header
        className="sticky top-0 z-50"
        style={{
          borderBottom: "1px solid rgba(6,182,212,0.25)",
          background: "rgba(8,8,18,0.85)",
          backdropFilter: "blur(20px) saturate(1.5)",
          WebkitBackdropFilter: "blur(20px) saturate(1.5)",
          boxShadow: "0 4px 30px rgba(0,0,0,0.5)",
        }}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <BrandLogo size="md" href="/" priority />

          {/* Desktop Nav Links */}
          <nav className="hidden lg:flex items-center space-x-7 text-xs font-semibold" style={{ color: "#94a3b8" }}>
            <a href="#services" className="hover:text-white transition-colors">
              Featured Services
            </a>
            <a href="#workflow" className="hover:text-white transition-colors">
              How It Works
            </a>
            <a href="#cli-manifest" className="hover:text-white transition-colors">
              Developer CLI
            </a>
            <a href="#latency" className="hover:text-white transition-colors">
              Edge Network
            </a>
            <a href="#comparison" className="hover:text-white transition-colors">
              Compare
            </a>
            <Link href="/templates" className="hover:text-white transition-colors">
              Templates
            </Link>
            <Link href="/enterprise" className="hover:text-white transition-colors">
              Enterprise
            </Link>
            <Link href="/roadmap" className="hover:text-white transition-colors">
              R&amp;D Roadmap
            </Link>
            <Link href="/pricing" className="font-bold transition-colors hover:text-white" style={{ color: "#38bdf8" }}>
              Pricing
            </Link>
            <a href="#faq" className="hover:text-white transition-colors">
              FAQ
            </a>
          </nav>

          {/* User Auth Buttons */}
          <div className="hidden sm:flex items-center space-x-3 font-mono text-xs">
            {sessionUser ? (
              <Link
                href="/dashboard"
                className="px-4 py-2 rounded-xl font-bold transition-all text-xs hover:scale-105"
                style={{
                  background: "linear-gradient(135deg, #06B6D4, #3B82F6)",
                  color: "#050510",
                  boxShadow: "0 0 20px rgba(6,182,212,0.4)",
                }}
              >
                Console Dashboard →
              </Link>
            ) : (
              <>
                <Link
                  href="/auth/signin"
                  className="px-3.5 py-2 rounded-xl transition-all font-semibold hover:border-cyan-400 text-xs"
                  style={{
                    border: "1px solid rgba(255,255,255,0.18)",
                    color: "#e2e8f0",
                    background: "rgba(255,255,255,0.04)",
                  }}
                >
                  Sign In
                </Link>
                <Link
                  href="/auth/signin"
                  className="px-4 py-2 rounded-xl font-bold transition-all hover:scale-105 shadow-lg text-xs"
                  style={{
                    background: "linear-gradient(135deg, #06B6D4, #3B82F6)",
                    color: "#050510",
                    boxShadow: "0 0 20px rgba(6,182,212,0.35)",
                  }}
                >
                  Deploy Free
                </Link>
              </>
            )}
          </div>

          {/* Mobile Hamburger Toggle Button */}
          <div className="flex items-center lg:hidden">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="flex items-center justify-center p-2 rounded-lg text-slate-300 hover:text-white"
              style={{ minWidth: "44px", minHeight: "44px" }}
              aria-label="Toggle navigation menu"
            >
              <span style={{ fontSize: "1.35rem" }}>{mobileMenuOpen ? "✕" : "☰"}</span>
            </button>
          </div>
        </div>

        {/* Mobile Navigation Drawer Sheet */}
        {mobileMenuOpen && (
          <div
            className="fixed inset-0 z-50 lg:hidden"
            style={{ background: "rgba(0,0,0,0.8)", backdropFilter: "blur(8px)" }}
            onClick={() => setMobileMenuOpen(false)}
          >
            <div
              className="fixed inset-y-0 right-0 w-full max-w-xs flex flex-col p-6 shadow-2xl"
              style={{
                background: "rgba(10, 10, 26, 0.98)",
                borderLeft: "1px solid rgba(6, 182, 212, 0.3)",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between pb-4 border-b border-white/10">
                <BrandLogo size="sm" href="/" />
                <button
                  onClick={() => setMobileMenuOpen(false)}
                  className="flex items-center justify-center text-slate-400 hover:text-white text-xl"
                  style={{ minWidth: "44px", minHeight: "44px" }}
                  aria-label="Close menu"
                >
                  ✕
                </button>
              </div>

              <nav className="flex flex-col space-y-1 mt-4 overflow-y-auto flex-1">
                {[
                  { href: "#services", label: "Featured Services" },
                  { href: "#workflow", label: "How It Works" },
                  { href: "#cli-manifest", label: "Developer CLI" },
                  { href: "#latency", label: "Edge Network" },
                  { href: "#comparison", label: "Compare" },
                  { href: "/templates", label: "Templates" },
                  { href: "/enterprise", label: "Enterprise" },
                  { href: "/roadmap", label: "R&D Roadmap" },
                  { href: "/pricing", label: "Plans & Pricing" },
                  { href: "#faq", label: "FAQ" },
                ].map((item) => (
                  <a
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileMenuOpen(false)}
                    className="flex items-center px-4 rounded-lg text-sm font-semibold text-slate-300 hover:text-cyan-400 hover:bg-white/5 transition-colors"
                    style={{ minHeight: "44px" }}
                  >
                    {item.label}
                  </a>
                ))}
              </nav>

              <div className="pt-4 border-t border-white/10 flex flex-col gap-2 mt-auto">
                {sessionUser ? (
                  <Link
                    href="/dashboard"
                    onClick={() => setMobileMenuOpen(false)}
                    className="flex items-center justify-center rounded-xl font-bold text-sm shadow-lg text-slate-950"
                    style={{
                      minHeight: "44px",
                      background: "linear-gradient(135deg, #06B6D4, #3B82F6)",
                    }}
                  >
                    Console Dashboard →
                  </Link>
                ) : (
                  <>
                    <Link
                      href="/auth/signin"
                      onClick={() => setMobileMenuOpen(false)}
                      className="flex items-center justify-center rounded-xl font-semibold text-sm border border-white/20 text-slate-200 hover:border-cyan-400"
                      style={{ minHeight: "44px" }}
                    >
                      Sign In
                    </Link>
                    <Link
                      href="/auth/signin"
                      onClick={() => setMobileMenuOpen(false)}
                      className="flex items-center justify-center rounded-xl font-bold text-sm text-slate-950 shadow-lg"
                      style={{
                        minHeight: "44px",
                        background: "linear-gradient(135deg, #06B6D4, #3B82F6)",
                      }}
                    >
                      Deploy Free
                    </Link>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </header>

      {/* Main Sections with Generous Spacing and Proper Padding */}
      <main className="relative z-10">
        {/* 1. 3D Realistic Hero */}
        <div className="border-b border-white/5">
          <LandingHero />
        </div>

        {/* 2. Featured Services (Dedicated Showcase with Filters & Specs) */}
        <div className="border-b border-white/5" style={{ background: "linear-gradient(180deg, rgba(8, 8, 20, 0.4) 0%, rgba(5, 5, 16, 0.8) 100%)" }}>
          <FeaturedServices />
        </div>

        {/* 3. How It Works (3-Step Interactive GitOps Pipeline) */}
        <div className="border-b border-white/5">
          <HowItWorks />
        </div>

        {/* 4. Developer-First CLI & Declarative Manifest Showcase */}
        <div className="border-b border-white/5" style={{ background: "linear-gradient(180deg, rgba(5, 5, 16, 0.8) 0%, rgba(8, 8, 20, 0.4) 100%)" }}>
          <CliManifestShowcase />
        </div>

        {/* 5. Global Anycast Edge Network & Geo Latency Telemetry */}
        <div id="latency" className="border-b border-white/5 py-24 sm:py-32 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">
          <GeoLatencyWidget />
        </div>

        {/* 6. Platform Comparison Matrix */}
        <div id="comparison" className="border-b border-white/5 py-24 sm:py-32 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto" style={{ background: "linear-gradient(180deg, rgba(8, 8, 20, 0.4) 0%, rgba(5, 5, 16, 0.8) 100%)" }}>
          <ComparisonTable />
        </div>

        {/* 7. 1-Click Templates Catalog */}
        <div id="templates" className="border-b border-white/5 py-24 sm:py-32 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">
          <TemplatesCatalog />
        </div>

        {/* 8. Enterprise Security, Compliance & Governance */}
        <div className="border-b border-white/5" style={{ background: "linear-gradient(180deg, rgba(5, 5, 16, 0.8) 0%, rgba(8, 8, 20, 0.4) 100%)" }}>
          <SecurityCompliance />
        </div>

        {/* 9. Engineer Stories & Platform Scale Metrics */}
        <div className="border-b border-white/5">
          <SocialProof />
        </div>

        {/* 10. Frequently Asked Questions */}
        <div className="border-b border-white/5" style={{ background: "linear-gradient(180deg, rgba(8, 8, 20, 0.4) 0%, rgba(5, 5, 16, 0.8) 100%)" }}>
          <LandingFaq />
        </div>

        {/* 11. 3D Realistic Cyber Call to Action */}
        <div className="py-24 sm:py-32 px-4 sm:px-6 lg:px-8 max-w-5xl mx-auto">
          <div
            className="relative rounded-3xl p-12 md:p-16 text-center overflow-hidden"
            style={{
              background: "linear-gradient(135deg, rgba(22, 22, 38, 0.95), rgba(10, 10, 20, 0.98))",
              border: "1px solid rgba(6, 182, 212, 0.45)",
              boxShadow: "0 30px 80px -15px rgba(0,0,0,0.9), 0 0 50px rgba(6, 182, 212, 0.2)",
              backdropFilter: "blur(24px)",
            }}
          >
            {/* Background glowing gradients */}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background: "radial-gradient(circle at 50% 0%, rgba(6,182,212,0.25), transparent 70%)",
              }}
            />

            <div className="relative z-10">
              <div
                className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-bold tracking-wider uppercase mb-6"
                style={{
                  background: "rgba(6, 182, 212, 0.15)",
                  border: "1px solid rgba(6, 182, 212, 0.4)",
                  color: "#38bdf8",
                }}
              >
                <span>⚡ Zero Lock-in · No Credit Card Required</span>
              </div>

              <h2
                className="text-4xl sm:text-5xl md:text-6xl font-black tracking-tight mb-4 text-white drop-shadow-md"
                style={{ fontFamily: "'Inter', system-ui, sans-serif" }}
              >
                Ready to Own the Cloud?
              </h2>
              <p
                className="text-base sm:text-lg max-w-2xl mx-auto mb-10 leading-relaxed font-medium"
                style={{ color: "#cbd5e1" }}
              >
                Join thousands of engineers deploying without limits. 6 global POPs, zero cold starts,
                attached serverless Postgres, and interactive shell terminals.
              </p>

              <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
                <Link
                  href="/auth/signin"
                  className="w-full sm:w-auto px-10 py-4 rounded-xl font-black text-sm text-center transition-all duration-200 hover:scale-105 shadow-xl"
                  style={{
                    background: "linear-gradient(135deg, #06B6D4, #3B82F6)",
                    color: "#050510",
                    boxShadow: "0 10px 30px rgba(6,182,212,0.45), inset 0 1px 0 rgba(255,255,255,0.4)",
                  }}
                >
                  🚀 Get Started Free in 30s
                </Link>
                <Link
                  href="/pricing"
                  className="w-full sm:w-auto px-8 py-4 rounded-xl font-bold text-sm text-center transition-all duration-200 hover:border-cyan-400"
                  style={{
                    border: "1px solid rgba(6, 182, 212, 0.4)",
                    background: "rgba(255,255,255,0.06)",
                    color: "#f8fafc",
                  }}
                >
                  View Plans & Pricing →
                </Link>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* 12. Comprehensive Detailed Footer */}
      <LandingFooter />

      {/* JSON-LD Structured Data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: "Syncbay PaaS",
            applicationCategory: "DevOpsApplication",
            operatingSystem: "Cloud, Linux Edge",
            offers: { "@type": "Offer", price: "0.00", priceCurrency: "USD" },
            publisher: {
              "@type": "Organization",
              name: "Syncbay Technologies Inc.",
              url: "https://www.syncbay.app",
              address: {
                "@type": "PostalAddress",
                streetAddress: "548 Market St, Suite 82194",
                addressLocality: "San Francisco",
                addressRegion: "CA",
                postalCode: "94104",
                addressCountry: "US",
              },
            },
            description:
              "The Cloud Hyper-Plane for Modern Developers. Next-Gen PaaS with 6 global edge POPs, managed PostgreSQL, web shell, and SQL Query Studio.",
          }),
        }}
      />
    </div>
  );
}
