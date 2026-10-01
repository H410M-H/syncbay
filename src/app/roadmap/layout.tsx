import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "R&D Weekly Roadmap & Community Feature Voting | Syncbay",
  description:
    "Explore Syncbay's public product roadmap, weekly version drops, edge engine milestones, and cast your vote on upcoming cloud developer primitives.",
  keywords: [
    "Syncbay Roadmap",
    "PaaS Public Roadmap",
    "Developer Feature Voting",
    "Edge Compute Changelog",
    "Cloud Release Notes",
  ],
  alternates: {
    canonical: "https://www.syncbay.app/roadmap",
  },
  openGraph: {
    type: "website",
    siteName: "Syncbay",
    title: "Syncbay Public R&D Roadmap & Feature Voting",
    description:
      "See what we are building next. Vote on upcoming edge primitives, database enhancements, and developer tooling.",
    url: "https://www.syncbay.app/roadmap",
    images: [
      {
        url: "https://www.syncbay.app/og-image.png",
        width: 1200,
        height: 630,
        alt: "Syncbay R&D Roadmap",
        type: "image/png",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Syncbay Public R&D Roadmap",
    description: "Weekly version drops, runtime telemetry, and community feature voting.",
    images: ["https://www.syncbay.app/og-image.png"],
  },
};

const roadmapJsonLd = {
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
          "name": "Roadmap",
          "item": "https://www.syncbay.app/roadmap",
        },
      ],
    },
  ],
};

export default function RoadmapLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(roadmapJsonLd) }}
      />
      {children}
    </>
  );
}
