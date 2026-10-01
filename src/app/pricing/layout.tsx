import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pricing & Plans — Transparent Edge Cloud Hosting | Syncbay",
  description:
    "Syncbay pricing engineered to surpass Vercel and Railway. Unlimited developer seats, $18/mo Pro plan with 500GB included edge egress, attached PostgreSQL, and zero seat penalties.",
  keywords: [
    "Syncbay Pricing",
    "Vercel Pricing Alternative",
    "Railway Cost Comparison",
    "PaaS Pricing Calculator",
    "Cheap Docker Hosting",
    "Serverless Postgres Pricing",
    "Developer Cloud Cost",
  ],
  alternates: {
    canonical: "https://www.syncbay.app/pricing",
  },
  openGraph: {
    title: "Syncbay Pricing — Beat Vercel & Railway on Speed & Cost",
    description:
      "Save up to 80% compared to Vercel seat penalties. Unlimited seats, 6 edge POPs, 0ms cold starts, and attached managed Postgres.",
    url: "https://www.syncbay.app/pricing",
    images: [
      {
        url: "https://www.syncbay.app/og-image.png",
        width: 1200,
        height: 630,
        alt: "Syncbay Pricing & Plans",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Syncbay Pricing — Transparent, Predictable Developer Cloud",
    description: "Unlimited seats, 500GB included egress, attached PostgreSQL & Web Shell for $18/mo.",
    images: ["https://www.syncbay.app/og-image.png"],
  },
};

export default function PricingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
