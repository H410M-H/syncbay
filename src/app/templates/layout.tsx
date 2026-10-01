import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "1-Click Full-Stack Templates Catalog | Syncbay",
  description:
    "Deploy production-ready Next.js, Node.js, Python FastAPI, Go, Rust, and PostgreSQL templates with zero configuration on Syncbay's edge cloud.",
  keywords: [
    "Full-Stack Templates",
    "Next.js Starter",
    "FastAPI Deployment Template",
    "PostgreSQL Starter Kit",
    "Go Web API Template",
    "1-Click Cloud Deploy",
    "Nixpacks Templates",
  ],
  alternates: {
    canonical: "https://www.syncbay.app/templates",
  },
  openGraph: {
    title: "1-Click Full-Stack Templates Catalog — Syncbay Edge Platform",
    description:
      "Instant architecture templates for Next.js, FastAPI, Go, and PostgreSQL. Launch in seconds with automated CI/CD and attached storage.",
    url: "https://www.syncbay.app/templates",
    images: [
      {
        url: "https://www.syncbay.app/og-image.png",
        width: 1200,
        height: 630,
        alt: "Syncbay 1-Click Templates",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Syncbay 1-Click Templates Catalog",
    description: "Launch production-grade Next.js, Python, and Go microservices in seconds.",
    images: ["https://www.syncbay.app/og-image.png"],
  },
};

export default function TemplatesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
