import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "One-Click Templates",
  description:
    "Open-source starter apps — Next.js, FastAPI, Go, Rust, Node.js, Django and more — that declare their PostgreSQL, Redis or Valkey in syncbay.json. Syncbay provisions them and deploys the app.",
  keywords: [
    "Full-Stack Templates",
    "Next.js Starter",
    "FastAPI Deployment Template",
    "PostgreSQL Starter Kit",
    "Go Web API Template",
    "1-Click Cloud Deploy",
    "Open Source Templates",
  ],
  alternates: {
    canonical: "https://www.syncbay.app/templates",
  },
  openGraph: {
    type: "website",
    siteName: "Syncbay",
    title: "Syncbay One-Click Templates",
    description:
      "Open-source starter apps with their databases declared in syncbay.json. Deploy one and Syncbay provisions the databases and builds the app.",
    url: "https://www.syncbay.app/templates",
    images: [
      {
        url: "https://www.syncbay.app/og-image.png",
        width: 1200,
        height: 630,
        alt: "Syncbay 1-Click Templates",
        type: "image/png",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Syncbay One-Click Templates",
    description: "Open-source Next.js, Python, Go, Rust and Node starters with their databases included.",
    images: ["https://www.syncbay.app/og-image.png"],
  },
};

const templatesJsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": "Home",
          "item": "https://www.syncbay.app",
        },
        {
          "@type": "ListItem",
          "position": 2,
          "name": "Templates",
          "item": "https://www.syncbay.app/templates",
        },
      ],
    },
  ],
};

export default function TemplatesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(templatesJsonLd) }}
      />
      {children}
    </>
  );
}
