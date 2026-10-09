import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Documentation",
  description: "Complete Syncbay documentation for services, modules, configuration, APIs, CLI, integrations, and operations.",
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
