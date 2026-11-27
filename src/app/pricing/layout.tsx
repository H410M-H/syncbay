import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Usage Pricing",
  description:
    "Syncbay bills by usage from one rate card — compute, memory and network egress, invoiced monthly via Stripe — with no per-seat fees and a monthly spending cap you set.",
  keywords: [
    "Syncbay Pricing",
    "Usage-Based PaaS Pricing",
    "Spending Cap",
    "Docker Hosting Pricing",
    "Managed Postgres Hosting",
    "No Per-Seat Fees",
  ],
  alternates: {
    canonical: "https://www.syncbay.app/pricing",
  },
  openGraph: {
    type: "website",
    siteName: "Syncbay",
    title: "Syncbay Pricing — Usage-Based, No Per-Seat Fees",
    description:
      "One rate card for compute, memory and egress, invoiced monthly. Set a spending cap: email at 80%, services pause at 100%.",
    url: "https://www.syncbay.app/pricing",
    images: [
      {
        url: "https://www.syncbay.app/og-image.png",
        width: 1200,
        height: 630,
        alt: "Syncbay Usage Pricing",
        type: "image/png",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Syncbay Pricing — Usage-Based, No Per-Seat Fees",
    description: "Compute, memory and egress from one rate card, with a spending cap you set.",
    images: ["https://www.syncbay.app/og-image.png"],
  },
};

const pricingJsonLd = {
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
          "name": "Pricing",
          "item": "https://www.syncbay.app/pricing",
        },
      ],
    },
  ],
};

export default function PricingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(pricingJsonLd) }}
      />
      {children}
    </>
  );
}
