import { Suspense } from "react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { SignInForm } from "./signin-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign In — Syncbay Cloud Hyper-Plane",
  description: "Sign in to your Syncbay account. Access your global edge container deployments, managed PostgreSQL databases, and interactive web shell.",
  alternates: {
    canonical: "https://www.syncbay.app/auth/signin",
  },
  openGraph: {
    title: "Sign In to Syncbay — The Cloud Hyper-Plane for Developers",
    description: "Manage high-performance edge containers, serverless Postgres, and instant preview deployments.",
    url: "https://www.syncbay.app/auth/signin",
  },
};

export default function SignInPage() {
  return (
    <main className="auth-page">
      <div className="auth-card fade-in">
        <div className="auth-logo">
          <Link href="/" className="logo-icon-lg" title="Back to Syncbay Home">
            <Image
              src="/brand-icon-tight.png"
              alt="Syncbay Logo"
              width={46}
              height={26}
              priority
            />
          </Link>
          <div>
            <h1 style={{ fontSize: "1.75rem", marginBottom: "4px" }}>
              Welcome to Syncbay
            </h1>
            <p style={{ fontSize: "0.9rem", margin: 0, color: "var(--text-secondary)" }}>
              Sign in to your account to continue
            </p>
          </div>
        </div>

        <Suspense fallback={<div style={{ textAlign: "center", color: "var(--text-secondary)", fontSize: "0.85rem", padding: "16px" }}>Loading...</div>}>
          <SignInForm />
        </Suspense>
      </div>
    </main>
  );
}

