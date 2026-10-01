import React from "react";
import Link from "next/link";
import { BrandLogo } from "@/components/ui/brand-logo";

export const metadata = {
  title: "404 — Page Not Found | Syncbay",
  description: "The requested route does not exist on the Syncbay Cloud Hyper-Plane.",
  robots: {
    index: false,
    follow: true,
  },
};

export default function NotFound() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        alignItems: "center",
        backgroundColor: "#050510",
        color: "#f8fafc",
        padding: "32px 24px",
      }}
    >
      {/* Top Navbar */}
      <header style={{ width: "100%", maxWidth: "1100px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <BrandLogo size="md" href="/" priority />
        <Link
          href="/dashboard"
          className="btn btn-secondary btn-sm"
          style={{
            fontSize: "12px",
            padding: "8px 16px",
            borderRadius: "8px",
            border: "1px solid rgba(6,182,212,0.3)",
            background: "rgba(6,182,212,0.1)",
            color: "#38bdf8",
            textDecoration: "none",
          }}
        >
          Console Dashboard ↗
        </Link>
      </header>

      {/* Main 404 Card */}
      <main
        style={{
          width: "100%",
          maxWidth: "520px",
          textAlign: "center",
          background: "rgba(15, 23, 42, 0.65)",
          border: "1px solid rgba(6, 182, 212, 0.25)",
          borderRadius: "16px",
          padding: "48px 32px",
          boxShadow: "0 20px 40px -15px rgba(0, 0, 0, 0.7), 0 0 30px rgba(6, 182, 212, 0.1)",
          backdropFilter: "blur(12px)",
        }}
      >
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            padding: "6px 14px",
            borderRadius: "9999px",
            background: "rgba(239, 68, 68, 0.12)",
            border: "1px solid rgba(239, 68, 68, 0.3)",
            color: "#f87171",
            fontSize: "12px",
            fontWeight: 700,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            marginBottom: "20px",
          }}
        >
          <span>HTTP 404 Route Unreachable</span>
        </div>

        <h1 style={{ fontSize: "2.25rem", fontWeight: 800, letterSpacing: "-0.03em", margin: "0 0 12px 0", color: "#ffffff" }}>
          Lost in the Edge Mesh
        </h1>

        <p style={{ color: "#94a3b8", fontSize: "15px", lineHeight: 1.6, margin: "0 0 32px 0" }}>
          The deployment route or resource you are looking for has been moved, purged from the edge cache, or does not exist.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "28px" }}>
          <Link
            href="/"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "8px",
              padding: "12px 20px",
              background: "linear-gradient(135deg, #06B6D4, #3B82F6)",
              color: "#050510",
              fontWeight: 700,
              fontSize: "14px",
              borderRadius: "10px",
              textDecoration: "none",
              boxShadow: "0 0 20px rgba(6,182,212,0.4)",
            }}
          >
            ← Return to Syncbay Homepage
          </Link>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <Link
              href="/pricing"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "10px 14px",
                background: "rgba(30, 41, 59, 0.8)",
                border: "1px solid rgba(148, 163, 184, 0.2)",
                color: "#e2e8f0",
                fontSize: "13px",
                fontWeight: 600,
                borderRadius: "8px",
                textDecoration: "none",
              }}
            >
              Pricing & Plans
            </Link>
            <Link
              href="/templates"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "10px 14px",
                background: "rgba(30, 41, 59, 0.8)",
                border: "1px solid rgba(148, 163, 184, 0.2)",
                color: "#e2e8f0",
                fontSize: "13px",
                fontWeight: 600,
                borderRadius: "8px",
                textDecoration: "none",
              }}
            >
              Templates Catalog
            </Link>
          </div>
        </div>

        <div
          style={{
            fontSize: "11px",
            color: "#64748b",
            borderTop: "1px solid rgba(148, 163, 184, 0.15)",
            paddingTop: "16px",
            fontFamily: "monospace",
          }}
        >
          [syncbay-edge-pop] anycast-gateway · 0ms-cold-start-fabric
        </div>
      </main>

      {/* Footer */}
      <footer style={{ fontSize: "12px", color: "#64748b", textAlign: "center" }}>
        © {new Date().getFullYear()} Syncbay Technologies Inc. · Global Edge Cloud Platform
      </footer>
    </div>
  );
}
