import type { Metadata, Viewport } from "next";
import "./globals.css";
import { TRPCProvider } from "@/lib/trpc-client";

export const viewport: Viewport = {
  themeColor: "#050510",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  colorScheme: "dark",
};

function getBaseUrl() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (appUrl) {
    return appUrl.startsWith("http") ? appUrl : `https://${appUrl}`;
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return "http://localhost:3000";
}

export const metadata: Metadata = {
  title: {
    default: "Syncbay — Hybrid PaaS: Deploy GitHub Repos with Zero-Downtime Releases",
    template: "%s — Syncbay",
  },
  description:
    "Syncbay is a hybrid PaaS by MSNS-DEV. Deploy GitHub repos (Dockerfile, Syncbay-generated Dockerfiles or Nixpacks) to Syncbay runner hosts behind Cloudflare, with health-checked zero-downtime releases, managed PostgreSQL, Redis and MySQL, Cloudflare R2 buckets, an in-browser shell and Query Studio.",
  keywords: [
    "PaaS",
    "Hybrid PaaS",
    "Docker Deployment",
    "Deploy from GitHub",
    "Nixpacks",
    "Managed PostgreSQL",
    "pgvector",
    "Managed Redis",
    "Valkey",
    "Managed MySQL",
    "Cloudflare R2",
    "PR Preview Environments",
    "Zero-Downtime Deploys",
    "Web Shell",
    "SQL Query Studio",
    "Next.js Hosting",
    "Bring Your Own Server",
  ],
  authors: [{ name: "MSNS-DEV", url: "https://github.com/MSNS-DEV" }],
  creator: "MSNS-DEV",
  publisher: "MSNS-DEV",
  metadataBase: new URL(getBaseUrl()),
  alternates: {
    canonical: "https://www.syncbay.app",
  },
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand-icon.png", sizes: "256x256", type: "image/png" },
    ],
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
    other: [
      { rel: "mask-icon", url: "/brand-icon.svg", color: "#06B6D4" },
    ],
  },
  manifest: "/site.webmanifest",
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://www.syncbay.app",
    title: "Syncbay — Hybrid PaaS for GitHub Deploys",
    description:
      "Push to deploy on Syncbay runner hosts behind Cloudflare. Health-checked zero-downtime releases, managed PostgreSQL, Redis and MySQL, R2 buckets, web shell and Query Studio.",
    siteName: "Syncbay",
    images: [
      {
        url: "https://www.syncbay.app/og-image.png",
        width: 1200,
        height: 630,
        alt: "Syncbay — Hybrid PaaS for GitHub Deploys",
        type: "image/png",
      },
      {
        url: "https://www.syncbay.app/brand-logo.png",
        width: 600,
        height: 160,
        alt: "Syncbay Official Brand Logo",
        type: "image/png",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Syncbay — Hybrid PaaS for GitHub Deploys",
    description:
      "Push to deploy on runner hosts behind Cloudflare: zero-downtime releases, managed Postgres, Redis and MySQL, R2 buckets and an in-browser shell.",
    images: ["https://www.syncbay.app/og-image.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  verification: {
    google: "qVvnSnZjUZ8x-pkUnZD5ZQJ9-YbWL51GUgHE30sgNSs",
  },
};

import { GlobalSpaceBackground } from "@/components/ui/global-space-background";
import { FAQS } from "@/components/marketing/faq-data";

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://www.syncbay.app/#organization",
      "name": "MSNS-DEV",
      "url": "https://github.com/MSNS-DEV",
      "logo": "https://www.syncbay.app/brand-logo.png",
      "image": "https://www.syncbay.app/syncbay-avatar.png",
      "brand": {
        "@type": "Brand",
        "name": "Syncbay",
        "logo": "https://www.syncbay.app/brand-icon.png"
      },
      "sameAs": ["https://github.com/MSNS-DEV"],
      "address": {
        "@type": "PostalAddress",
        "addressCountry": "PK"
      }
    },
    {
      "@type": "WebSite",
      "@id": "https://www.syncbay.app/#website",
      "url": "https://www.syncbay.app",
      "name": "Syncbay",
      "description": "Hybrid PaaS for GitHub deploys",
      "publisher": { "@id": "https://www.syncbay.app/#organization" }
    },
    {
      "@type": "SoftwareApplication",
      "@id": "https://www.syncbay.app/#application",
      "name": "Syncbay",
      "applicationCategory": "DeveloperApplication",
      "operatingSystem": "Linux (runner hosts), web dashboard",
      "description": "Syncbay is a hybrid PaaS by MSNS-DEV. Deploy GitHub repos (Dockerfile, Syncbay-generated Dockerfiles or Nixpacks) to Syncbay runner hosts behind Cloudflare, with health-checked zero-downtime releases, managed PostgreSQL, Redis and MySQL, Cloudflare R2 buckets, an in-browser shell and Query Studio.",
      "image": "https://www.syncbay.app/og-image.png",
      "screenshot": "https://www.syncbay.app/og-image.png",
      "publisher": { "@id": "https://www.syncbay.app/#organization" },
      "featureList": [
        "Deploy from GitHub with Dockerfile, Syncbay-generated Dockerfiles or Nixpacks",
        "Health-checked zero-downtime releases, instant rollback, restart and pause",
        "Always-on services by default; opt-in scale-to-zero",
        "PR preview environments",
        "Managed PostgreSQL (pgvector), Redis/Valkey and MySQL",
        "Cloudflare R2 buckets and persistent volumes",
        "In-browser web shell and read-only-by-default Query Studio",
        "Custom domains with TLS via Cloudflare, WAF rules, rate limits and canary releases",
        "Usage-based billing with spending caps"
      ]
    },
    {
      "@type": "FAQPage",
      "@id": "https://www.syncbay.app/#faq",
      "mainEntity": FAQS.map((faq) => ({
        "@type": "Question",
        "name": faq.question,
        "acceptedAnswer": { "@type": "Answer", "text": faq.answer }
      }))
    }
  ]
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body>
        <TRPCProvider>
          <GlobalSpaceBackground />
          {children}
        </TRPCProvider>
      </body>
    </html>
  );
}
