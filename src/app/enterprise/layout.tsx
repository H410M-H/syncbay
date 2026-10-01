import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Enterprise Sovereign Mesh — Global Edge Infrastructure | Syncbay",
  description:
    "Syncbay Enterprise delivers dedicated edge POP clusters, 99.999% SLA, custom VPC peering, SOC 2 compliance, and dedicated 24/7 SRE support for mission-critical workloads.",
  keywords: [
    "Enterprise PaaS",
    "Private Edge Cloud",
    "Dedicated POP Cluster",
    "Sovereign Cloud Mesh",
    "SOC 2 Cloud Platform",
    "Enterprise Vercel Alternative",
    "Multi-Cloud Deployment",
  ],
  alternates: {
    canonical: "https://www.syncbay.app/enterprise",
  },
  openGraph: {
    title: "Syncbay Enterprise — Sovereign Mesh & Dedicated Global Edge",
    description:
      "Enterprise cloud infrastructure at a fraction of hyperscaler lock-in costs. Dedicated POPs, 99.999% SLA, and custom VPC peering.",
    url: "https://www.syncbay.app/enterprise",
    images: [
      {
        url: "https://www.syncbay.app/og-image.png",
        width: 1200,
        height: 630,
        alt: "Syncbay Enterprise Infrastructure",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Syncbay Enterprise — High-Throughput Edge Infrastructure",
    description: "Dedicated POPs, 99.999% uptime guarantee, and custom VPC peering.",
    images: ["https://www.syncbay.app/og-image.png"],
  },
};

export default function EnterpriseLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
