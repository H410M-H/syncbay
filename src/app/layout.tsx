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
    default: "Syncbay — The Cloud Hyper-Plane for Developers | Next-Gen PaaS",
    template: "%s — Syncbay PaaS",
  },
  description:
    "Syncbay is the developer PaaS engineered to surpass Vercel and Railway. Deploy any Dockerfile or Nixpacks app to 6 global edge POPs with 0ms cold starts, attached managed PostgreSQL, interactive Web Shell, and SQL Query Studio.",
  keywords: [
    "PaaS",
    "Cloud Platform",
    "Vercel Alternative",
    "Railway Alternative",
    "Render Alternative",
    "Fly.io Alternative",
    "Heroku Alternative",
    "Docker Deployment",
    "Managed PostgreSQL",
    "Serverless Containers",
    "Edge Containers",
    "Nixpacks Cloud",
    "Developer Cloud",
    "Zero Cold Starts",
    "Cloud Hyper-Plane",
    "Interactive Web Shell",
    "SQL Query Studio",
    "Next.js Hosting",
    "Fast Cloud Deployment",
    "Edge Anycast Mesh",
  ],
  authors: [{ name: "Syncbay Engineering", url: "https://www.syncbay.app" }],
  creator: "Syncbay Technologies Inc.",
  publisher: "Syncbay Technologies Inc.",
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
    title: "Syncbay — The Cloud Hyper-Plane for Modern Developers",
    description:
      "Deploy any repo to 6 global edge POPs in seconds. Managed PostgreSQL, Redis cache, live web terminal shell, and embedded SQL query studio.",
    siteName: "Syncbay",
    images: [
      {
        url: "https://www.syncbay.app/og-image.png",
        width: 1200,
        height: 630,
        alt: "Syncbay — The Cloud Hyper-Plane for Modern Developers",
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
    site: "@syncbayapp",
    creator: "@syncbayapp",
    title: "Syncbay — The Cloud Hyper-Plane for Modern Developers",
    description:
      "Next-Gen PaaS competing with Vercel and Railway. 0ms cold starts, multi-region edge containers, managed Postgres & interactive Web Shell.",
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

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://www.syncbay.app/#organization",
      "name": "Syncbay Technologies Inc.",
      "url": "https://www.syncbay.app",
      "logo": "https://www.syncbay.app/brand-logo.png",
      "image": "https://www.syncbay.app/syncbay-avatar.png",
      "slogan": "The Cloud Hyper-Plane for Modern Developers",
      "brand": {
        "@type": "Brand",
        "name": "Syncbay",
        "logo": "https://www.syncbay.app/brand-icon.png"
      },
      "sameAs": [
        "https://github.com/H410M-H/syncbay",
        "https://twitter.com/syncbayapp"
      ],
      "address": {
        "@type": "PostalAddress",
        "streetAddress": "548 Market St, Suite 82194",
        "addressLocality": "San Francisco",
        "addressRegion": "CA",
        "postalCode": "94104",
        "addressCountry": "US"
      }
    },
    {
      "@type": "WebSite",
      "@id": "https://www.syncbay.app/#website",
      "url": "https://www.syncbay.app",
      "name": "Syncbay",
      "description": "The Cloud Hyper-Plane for Modern Developers",
      "publisher": { "@id": "https://www.syncbay.app/#organization" },
      "potentialAction": {
        "@type": "SearchAction",
        "target": "https://www.syncbay.app/templates?q={search_term_string}",
        "query-input": "required name=search_term_string"
      }
    },
    {
      "@type": "SoftwareApplication",
      "@id": "https://www.syncbay.app/#application",
      "name": "Syncbay PaaS",
      "applicationCategory": "DeveloperApplication",
      "operatingSystem": "Cloud / Linux",
      "description": "Next-Gen developer PaaS with 6 global edge POPs, 0ms cold starts, attached managed PostgreSQL, interactive Web Shell, and SQL Query Studio.",
      "image": "https://www.syncbay.app/og-image.png",
      "screenshot": "https://www.syncbay.app/og-image.png",
      "offers": [
        {
          "@type": "Offer",
          "price": "0",
          "priceCurrency": "USD",
          "name": "Hobby Plan"
        },
        {
          "@type": "Offer",
          "price": "18",
          "priceCurrency": "USD",
          "name": "Pro Plan"
        },
        {
          "@type": "Offer",
          "price": "450",
          "priceCurrency": "USD",
          "name": "Enterprise Plan"
        }
      ],
      "aggregateRating": {
        "@type": "AggregateRating",
        "ratingValue": "4.9",
        "ratingCount": "1420"
      },
      "featureList": [
        "6 Global Edge POPs with Sub-15ms Anycast Routing",
        "0ms Cold Starts via Direct Edge Container Fabric",
        "Built-in Attached PostgreSQL and Redis Cache",
        "Interactive Full VT100 Browser Web Shell",
        "Visual SQL Query Studio and Schema Inspector",
        "Automated GitHub CI/CD and Ephemeral Previews",
        "Cloudflare Enterprise WAF and DDoS Protection"
      ]
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
