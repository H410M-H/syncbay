"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { Metadata } from "next";

const sections = [
  {
    group: "Start here",
    items: [
      ["overview", "Overview", "The Syncbay platform model and core concepts"],
      ["quickstart", "Quickstart", "Deploy your first service in minutes"],
      ["architecture", "Architecture", "Projects, services, deployments, and runtime"],
    ],
  },
  {
    group: "Platform",
    items: [
      ["projects", "Projects & workspaces", "Teams, environments, permissions, and activity"],
      ["services", "Services", "Web services, workers, jobs, and runtimes"],
      ["deployments", "Deployments", "Builds, releases, rollbacks, and previews"],
      ["databases", "Managed databases", "PostgreSQL lifecycle and connection pooling"],
      ["buckets", "Buckets", "Private object storage and file assets"],
      ["crons", "Smart Crons", "Scheduled jobs, retries, and observability"],
      ["edge", "Edge network", "Regions, routing, domains, and TLS"],
    ],
  },
  {
    group: "Developers",
    items: [
      ["configuration", "Configuration", "Environment variables, secrets, and config"],
      ["builds", "Builds & runtimes", "Nixpacks, Dockerfiles, ports, and health checks"],
      ["cli", "Syncbay CLI", "Install, authenticate, deploy, and automate"],
      ["api", "REST API", "Tokens, resources, pagination, and webhooks"],
      ["openapi", "OpenAPI reference", "Download the machine-readable API contract"],
      ["integrations", "Integrations", "GitHub, webhooks, CI, and third-party services"],
    ],
  },
  {
    group: "Operate",
    items: [
      ["observability", "Logs & observability", "Live logs, metrics, events, and alerts"],
      ["shell", "Web Shell", "Secure interactive runtime access"],
      ["security", "Security", "Tokens, isolation, WAF, and responsible disclosure"],
      ["billing", "Usage & billing", "Plans, metering, limits, and invoices"],
      ["terms", "Terms & policies", "Service terms, privacy, and acceptable use"],
      ["troubleshooting", "Troubleshooting", "Common failures and recovery playbooks"],
    ],
  },
];

const topics = sections.flatMap((section) => section.items.map(([id, title, description]) => ({ id, title, description, group: section.group })));

const content: Record<string, { eyebrow: string; title: string; intro: string; cards: [string, string, string][]; code?: string }> = {
  overview: {
    eyebrow: "Start here / Platform",
    title: "The cloud control plane for shipping software",
    intro: "Syncbay turns source code, infrastructure, and operations into one composable workflow. A workspace contains projects; projects contain services; services produce immutable deployments that run on the Syncbay edge.",
    cards: [
      ["Projects", "A project is the boundary for environments, services, deployments, domains, databases, and access policies.", "Create separate projects for production systems, previews, or internal tools."],
      ["Services", "A service is a deployable workload: web server, worker, scheduled job, or private process.", "Each service has its own source, build settings, variables, runtime, and history."],
      ["Deployments", "Every release is tracked as an immutable deployment with build logs, runtime events, and rollback metadata.", "Promote a known-good deployment instead of rebuilding it."],
    ],
  },
  quickstart: {
    eyebrow: "Start here / 01",
    title: "Deploy a service from GitHub",
    intro: "Connect a repository, choose a project, and let Syncbay detect the framework and build strategy. The same flow supports Dockerfiles, Nixpacks, monorepos, and custom commands.",
    code: "# install\ncurl -fsSL https://syncbay.app/install.sh | sh\n\n# authenticate and deploy\nsyncbay login\nsyncbay deploy --project my-app --service web",
    cards: [
      ["1. Create a project", "Open the dashboard, choose New Project, and select a workspace.", "Projects can be created from the dashboard or API."],
      ["2. Add a service", "Select GitHub, a branch, and a runtime. Syncbay reads package manifests and Docker configuration.", "Set a health path and port before the first production release."],
      ["3. Verify the release", "Watch build and live runtime logs, then open the generated preview URL.", "Attach a custom domain after the deployment is healthy."],
    ],
  },
  architecture: {
    eyebrow: "Start here / Concepts",
    title: "How Syncbay is organized",
    intro: "The platform separates ownership, source, build, and runtime concerns so teams can automate releases without losing control.",
    cards: [
      ["Workspace", "The team and billing boundary. Members receive roles and scoped access to projects.", "Roles: owner, admin, developer, and viewer."],
      ["Environment", "An environment groups variables, domains, services, and deployment policy.", "Use production, preview, and custom environments for safe promotion."],
      ["Runtime", "A deployment runs in an isolated container with a detected or explicitly selected buildpack.", "Runtime settings include region, instance size, port, health checks, and scaling."],
    ],
  },
};

const fallbackContent = (topic: (typeof topics)[number]) => ({
  eyebrow: `${topic.group} / Reference`,
  title: topic.title,
  intro: topic.description + ". This guide covers the complete lifecycle, dashboard controls, automation hooks, and operational details for this Syncbay module.",
  cards: [
    ["Configure", `Open ${topic.title} from the dashboard or use the matching API resource. Choose an environment, set ownership, and review defaults before saving.`, "Configuration changes are validated before they reach the runtime."],
    ["Operate", `Use the ${topic.title} activity view to inspect status, events, logs, and recent changes. Every action is recorded for workspace auditability.`, "Prefer reversible actions and confirm production changes."],
    ["Automate", `Use Syncbay CLI, REST API, webhooks, or CI to integrate ${topic.title} into your release workflow.`, "Use scoped tokens and idempotency keys for automation."],
  ],
});

export const metadata: Metadata = {
  title: "Documentation",
  description: "Complete Syncbay documentation for services, modules, configuration, APIs, CLI, integrations, and operations.",
};

export default function DocsPage() {
  const [activeId, setActiveId] = useState("overview");
  const [query, setQuery] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);
  const activeTopic = topics.find((topic) => topic.id === activeId) ?? topics[0];
  const page = content[activeId] ?? fallbackContent(activeTopic);
  const results = useMemo(() => topics.filter((topic) => `${topic.title} ${topic.description} ${topic.group}`.toLowerCase().includes(query.toLowerCase())), [query]);

  const navigate = (id: string) => {
    setActiveId(id);
    setMobileOpen(false);
    window.history.replaceState(null, "", `/docs#${id}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="docs-page">
      <header className="docs-topbar">
        <div className="docs-brand"><Link href="/">SYNCBAY</Link><span>DOCS</span></div>
        <div className="docs-top-actions"><Link href="/dashboard">Dashboard</Link><a href="/api/v1/openapi.json" target="_blank" rel="noreferrer">OpenAPI</a><button type="button" onClick={() => setMobileOpen(!mobileOpen)} className="docs-mobile-button">Menu</button></div>
      </header>
      <div className="docs-layout">
        <aside className={`docs-sidebar ${mobileOpen ? "is-open" : ""}`}>
          <div className="docs-search"><label htmlFor="docs-search">Search docs</label><input id="docs-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search services, API, CLI..." /></div>
          {query ? <div className="docs-results">{results.map((topic) => <button key={topic.id} type="button" onClick={() => navigate(topic.id)}><strong>{topic.title}</strong><span>{topic.group}</span></button>)}{results.length === 0 && <p>No matching guides.</p>}</div> : sections.map((section) => <div className="docs-nav-group" key={section.group}><p>{section.group}</p>{section.items.map(([id, title]) => <button key={id} type="button" className={id === activeId ? "is-active" : ""} onClick={() => navigate(id)}>{title}</button>)}</div>)}
          <div className="docs-sidebar-footer"><span>API status</span><a href="https://status.syncbay.app" target="_blank" rel="noreferrer">All systems operational ↗</a></div>
        </aside>
        <main className="docs-main">
          <div className="docs-breadcrumb">Docs <span>/</span> {page.eyebrow.split(" / ")[0]} <span>/</span> {page.title}</div>
          <article className="docs-article">
            <div className="docs-article-heading"><div><p className="docs-eyebrow">{page.eyebrow}</p><h1>{page.title}</h1><p className="docs-intro">{page.intro}</p></div><button type="button" className="docs-copy-link" onClick={() => navigator.clipboard?.writeText(window.location.href)}>Copy link</button></div>
            <div className="docs-pills"><span>Updated Oct 2026</span><span>Syncbay platform</span><span>Production ready</span></div>
            <div className="docs-cards">{page.cards.map(([title, description, detail]) => <section className="docs-card" key={title}><h2>{title}</h2><p>{description}</p><small>{detail}</small></section>)}</div>
            {page.code && <div className="docs-code"><div><span>Terminal</span><button type="button" onClick={() => navigator.clipboard?.writeText(page.code ?? "")}>Copy</button></div><pre><code>{page.code}</code></pre></div>}
            <section className="docs-detail"><h2>Details and recommended practice</h2><p>Syncbay is designed for repeatable, observable changes. Start in a preview environment, validate health and logs, then promote the deployment to production. Keep secrets in environment configuration, use least-privilege tokens for automation, and retain a rollback target for every release.</p><h3>Common workflow</h3><ol><li>Create or select the project and environment.</li><li>Configure source, runtime, region, variables, and health checks.</li><li>Deploy and inspect build output, live logs, metrics, and events.</li><li>Promote, rollback, or scale from the dashboard, CLI, or API.</li></ol><h3>Related references</h3><div className="docs-related">{topics.filter((topic) => topic.id !== activeId).slice(0, 4).map((topic) => <button key={topic.id} type="button" onClick={() => navigate(topic.id)}>{topic.title}<span>Read guide →</span></button>)}</div></section>
          </article>
          <footer className="docs-footer"><span>© 2026 Syncbay Technologies Inc.</span><span>Built for teams that ship.</span><Link href="/">Back to syncbay.app</Link></footer>
        </main>
      </div>
    </div>
  );
}

export { sections, topics, content };

import "./docs.css";

export const dynamic = "force-static";
export const revalidate = 3600;
