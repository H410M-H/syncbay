import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Roadmap & Release History",
  description:
    "What each Syncbay release changed for customers, the work planned next, and a place to vote for planned features.",
  keywords: [
    "Syncbay Roadmap",
    "PaaS Public Roadmap",
    "Developer Feature Voting",
    "Syncbay Changelog",
    "PaaS Release Notes",
  ],
  alternates: {
    canonical: "https://www.syncbay.app/roadmap",
  },
  openGraph: {
    type: "website",
    siteName: "Syncbay",
    title: "Syncbay Roadmap & Release History",
    description:
      "What shipped in each release and what is planned next: backups, tenant isolation, more runners.",
    url: "https://www.syncbay.app/roadmap",
    images: [
      {
        url: "https://www.syncbay.app/og-image.png",
        width: 1200,
        height: 630,
        alt: "Syncbay Roadmap",
        type: "image/png",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Syncbay Roadmap",
    description: "Release history, planned work and feature voting.",
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
