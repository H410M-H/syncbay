import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Documentation",
  description: "Syncbay documentation: deploying from GitHub, builds, services, databases, buckets, domains, the REST API, logs, the web shell, security and billing.",
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
