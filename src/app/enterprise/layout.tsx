import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Teams & Own Servers",
  description:
    "Syncbay for teams: workspace roles, an audit log, usage-based billing without per-seat fees and spending caps. Run on Syncbay runner hosts or connect your own Linux server.",
  keywords: [
    "PaaS for Teams",
    "Bring Your Own Server",
    "Self-Hosted Runner",
    "Spending Caps",
    "Usage-Based Billing",
    "Audit Log",
  ],
  alternates: {
    canonical: "https://www.syncbay.app/enterprise",
  },
  openGraph: {
    type: "website",
    siteName: "Syncbay",
    title: "Syncbay for Teams — Our Runners or Yours",
    description:
      "Workspace roles, audit log, usage-based billing with spending caps, and the option to connect your own Linux server as the runner.",
    url: "https://www.syncbay.app/enterprise",
    images: [
      {
        url: "https://www.syncbay.app/og-image.png",
        width: 1200,
        height: 630,
        alt: "Syncbay for Teams",
        type: "image/png",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Syncbay for Teams — Our Runners or Yours",
    description: "Roles, audit log, spending caps, and your own server as the runner.",
    images: ["https://www.syncbay.app/og-image.png"],
  },
};

const enterpriseJsonLd = {
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
          "name": "Teams & Own Servers",
          "item": "https://www.syncbay.app/enterprise",
        },
      ],
    },
  ],
};

export default function EnterpriseLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(enterpriseJsonLd) }}
      />
      {children}
    </>
  );
}
