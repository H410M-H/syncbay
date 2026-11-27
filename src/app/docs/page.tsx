"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import "./docs.css";

const sections = [
  {
    group: "Start here",
    items: [
      ["overview", "Overview", "The Syncbay platform model and core concepts"],
      ["quickstart", "Quickstart", "Deploy your first service from GitHub"],
      ["architecture", "Architecture", "Control plane, runner hosts and Cloudflare"],
    ],
  },
  {
    group: "Platform",
    items: [
      ["projects", "Projects & workspaces", "Teams, environments, roles and audit log"],
      ["services", "Services", "Web services, always-on and scale-to-zero"],
      ["deployments", "Deployments", "Builds, releases, rollbacks and previews"],
      ["databases", "Managed databases", "PostgreSQL, Redis/Valkey and MySQL on the runner"],
      ["buckets", "Buckets & volumes", "Cloudflare R2 buckets and persistent volumes"],
      ["crons", "Cron jobs", "Scheduled HTTP calls to your services"],
      ["edge", "Domains & routing", "Hostnames, custom domains, TLS, WAF and canaries"],
    ],
  },
  {
    group: "Developers",
    items: [
      ["configuration", "Configuration", "Environment variables, secrets and references"],
      ["builds", "Builds & runtimes", "Dockerfiles, stack templates, Nixpacks, ports, health checks"],
      ["templates", "Templates & syncbay.json", "One-click templates and the manifest format"],
      ["api", "REST API", "Tokens and resources"],
      ["openapi", "OpenAPI reference", "Download the machine-readable API contract"],
      ["integrations", "GitHub", "Sign-in, push deploys and pull request previews"],
    ],
  },
  {
    group: "Operate",
    items: [
      ["observability", "Logs & metrics", "Live logs, CPU, memory and traffic"],
      ["shell", "Web Shell", "A shell inside your running container"],
      ["security", "Security", "Isolation, secrets, WAF and abuse reports"],
      ["billing", "Usage & billing", "Rate card, credits, invoices and spending caps"],
      ["troubleshooting", "Troubleshooting", "Common failures and what to check"],
    ],
  },
];

const topics = sections.flatMap((section) => section.items.map(([id, title, description]) => ({ id, title, description, group: section.group })));

const content: Record<string, { eyebrow: string; title: string; intro: string; cards: [string, string, string][]; code?: string }> = {
  overview: {
    eyebrow: "Start here / Platform",
    title: "A hybrid PaaS for shipping from GitHub",
    intro: "A workspace contains projects; projects contain environments and services; every release of a service is a deployment with its own build, logs and status. The control plane runs on Vercel; your apps run on Syncbay runner hosts behind Cloudflare.",
    cards: [
      ["Projects", "A project groups environments, services, domains, databases and buckets.", "Names are unique per workspace."],
      ["Services", "A service is a deployable app built from a GitHub repository.", "Each service has its own variables, port, health check and deployment history."],
      ["Deployments", "Every release is a deployment with build logs, runtime logs and a status.", "Roll back to an earlier deployment from the console."],
    ],
  },
  quickstart: {
    eyebrow: "Start here / 01",
    title: "Deploy a service from GitHub",
    intro: "Sign in with GitHub, create a project, pick a repository and branch, and deploy. Syncbay uses your Dockerfile if there is one, otherwise it generates one for the detected stack or falls back to Nixpacks.",
    code: "# after the first deploy, every push to the branch deploys again\ngit commit -am \"feat: new page\"\ngit push origin main",
    cards: [
      ["1. Create a project", "Open the dashboard and choose New Project, or start from a template.", "Projects can also be created over the REST API."],
      ["2. Add a service", "Select a repository and branch. Set the port your app listens on if it is not detected.", "Your app should answer /health (or /) once it is ready."],
      ["3. Watch the release", "Follow the build and runtime logs, then open the service's syncbay.app host.", "Add a custom domain once the deployment is live."],
    ],
  },
  architecture: {
    eyebrow: "Start here / Concepts",
    title: "How Syncbay is organized",
    intro: "The control plane (dashboard, API, scheduling, billing) runs on Vercel. Builds, apps and managed databases run on runner hosts — Linux servers running the Syncbay runner daemon. Traffic reaches them through Cloudflare. Today there is one runner region.",
    cards: [
      ["Control plane", "Stores projects, deployments and logs, and sends signed jobs to the runner.", "Every control-plane-to-runner request is HMAC-signed and single-use."],
      ["Runner host", "Clones, builds and runs services in Docker containers, and provisions databases next to them.", "At most 2 builds run at once on a runner."],
      ["Edge", "Cloudflare DNS and TLS in front; a Cloudflare Tunnel to the runner; Syncbay's edge proxy applies WAF rules and canaries.", "Only versions that passed their health check receive traffic."],
    ],
  },
  projects: {
    eyebrow: "Platform / Projects",
    title: "Projects & workspaces",
    intro: "A workspace is your team and billing boundary. Members have one of four roles; projects belong to a workspace and contain environments such as production and PR previews.",
    cards: [
      ["Roles", "Owner, Admin, Member and Viewer.", "Viewers cannot run queries, list Redis keys, see database passwords or get bucket download links."],
      ["Project actions", "Redeploy, pause or resume every service in a project at once, rename it, or delete it.", "Deleting a project stops its services and releases its domains; there is no restore."],
      ["Audit log", "The workspace audit log records invites, role changes, API tokens, rollbacks and automatic restarts.", "Find it under Audit in the dashboard."],
    ],
  },
  services: {
    eyebrow: "Platform / Services",
    title: "Services",
    intro: "A service is a web app built from a repository. Services are always-on by default, so they keep running between requests and have no cold start.",
    cards: [
      ["Always-on", "The default. If an always-on service is found sleeping, Syncbay starts it again.", "Paused services stay stopped until you resume them."],
      ["Scale-to-zero", "Opt in per service. After the idle timeout the service sleeps; visitors see a start-up page.", "A signed-in workspace member wakes it from that page, or by redeploying."],
      ["Ports", "Set the port your app listens on. If the app listens on a different port, the runner detects it and maps traffic to it.", "Bind to 0.0.0.0, not 127.0.0.1."],
    ],
  },
  deployments: {
    eyebrow: "Platform / Deployments",
    title: "Deployments",
    intro: "A deployment builds your code and starts it next to the live version. Traffic moves only after the new instance answers its health check; a failed release leaves the live version serving.",
    cards: [
      ["Redeploy", "Fast redeploys reuse the existing clone and caches; a clean rebuild purges build caches and rebuilds without the Docker cache.", "Both are available from the deployment menu."],
      ["Rollback, restart, pause", "Roll back to an earlier deployment, restart an instance in place, or pause a service.", "A rollback revives the earlier instance when possible, otherwise redeploys its build."],
      ["PR previews", "Opening a pull request creates a pr-<n> environment with its own syncbay.app host.", "Syncbay posts a commit status and comment; previews scale to zero and are removed when the PR closes."],
    ],
  },
  databases: {
    eyebrow: "Platform / Databases",
    title: "Managed databases",
    intro: "Create PostgreSQL (optionally with pgvector), Redis or Valkey, or MySQL. Databases are provisioned on the runner and health-checked. Their URLs are added to your services as DATABASE_URL or REDIS_URL without overriding variables you set.",
    cards: [
      ["Connect", "Apps on the same runner reach the database over a private address; external tools use the public host and port.", "The Databases page shows how to connect pgAdmin over an SSH tunnel."],
      ["Data view", "Test the connection, see the server version, browse tables or keys and preview 50 rows read-only.", "Open it from a project's Data tab."],
      ["Query Studio", "Read-only by default: single statements in a read-only transaction, 10 s timeout, 1000-row cap.", "Write mode needs Owner or Admin; Safe Mode blocks destructive statements."],
    ],
  },
  buckets: {
    eyebrow: "Platform / Storage",
    title: "Buckets & volumes",
    intro: "Buckets are private Cloudflare R2 buckets created through the R2 API. Volumes are persistent directories mounted into a service on its runner.",
    cards: [
      ["Buckets", "List objects by folder, upload and download through presigned URLs.", "Downloads use short-lived presigned GET links."],
      ["Volumes", "Attach a volume with a mount path; it survives redeploys of the service.", "Volume size is not enforced yet."],
      ["Browse files", "The Data view lists up to 500 entries per folder and previews files up to 64 KiB, read-only.", "Symlinks are listed but never followed."],
    ],
  },
  crons: {
    eyebrow: "Platform / Crons",
    title: "Cron jobs",
    intro: "A cron job calls a path on your service on a 5-field cron schedule (UTC). Due jobs are picked up by a scheduler that runs every minute.",
    cards: [
      ["Schedules", "Standard 5-field cron expressions, evaluated in UTC.", "The finest granularity is one minute."],
      ["Retries", "Network errors, timeouts, 5xx and 429 answers are retried with a per-attempt timeout.", "Each run is recorded with its outcome."],
      ["Import", "A vercel.json importer turns Vercel crons and header rules into Syncbay cron jobs and WAF rules.", "Find it in the DevOps suite."],
    ],
  },
  edge: {
    eyebrow: "Platform / Edge",
    title: "Domains & routing",
    intro: "Every service gets a <service>-<env>.syncbay.app host. Custom domains are verified through DNS and served with TLS through Cloudflare. Syncbay's edge proxy applies WAF rules and canary splits before forwarding to the runner.",
    cards: [
      ["Custom domains", "Create the TXT and CNAME records Syncbay shows you; the domain becomes active once they resolve.", "A verified domain serves the same live version as the service's own host."],
      ["WAF & rate limits", "IP allow/block (IPv4/IPv6 CIDR), country blocks, path blocks and per-IP rate limits, answering 403 or 429.", "Rules are evaluated per service."],
      ["Canary releases", "Split traffic by weight between a stable and a canary release, pinned per visitor by cookie.", "The canary rolls back when its 5xx rate crosses your threshold."],
    ],
  },
  configuration: {
    eyebrow: "Developers / Configuration",
    title: "Configuration",
    intro: "Set environment variables per service and mark secrets. Reference other resources with ${{ Name.FIELD }} variables, resolved at deploy time.",
    code: "DATABASE_URL=${{ Postgres.URL }}\nAPI_URL=${{ api.URL }}\nMEDIA_BUCKET=${{ media.NAME }}",
    cards: [
      ["Secrets", "Secret values are masked in the console and in web shell output.", "They never appear on a command line or in a build log."],
      ["Injected variables", "Managed database URLs are added automatically; your own keys always win.", "PORT is set by the runner."],
      ["Builder", "Set SYNCBAY_BUILDER to auto, template, nixpacks or dockerfile to choose how the service is built.", "auto tries your Dockerfile, then a template, then Nixpacks."],
    ],
  },
  builds: {
    eyebrow: "Developers / Builds",
    title: "Builds & runtimes",
    intro: "The runner clones your repository and builds a Docker image: from your Dockerfile, from a Syncbay-generated Dockerfile for the detected stack, or with Nixpacks.",
    cards: [
      ["Stack templates", "Node (Express, Nest, Next.js, Nuxt, Remix, SvelteKit, Astro), static SPAs (Angular, Vite/React, Vue, Svelte, HTML), Python (Flask, FastAPI, Django), Go, Rust, PHP/Laravel, Java, Ruby, Deno, Bun.", "The generated file is Dockerfile.syncbay; your files are never overwritten."],
      ["Node versions", "Nixpacks projects that do not pin a Node version build with Node 22.", "Pin engines.node or NIXPACKS_NODE_VERSION to choose another."],
      ["Start-up", "A new instance has 120 seconds to answer its health check (/health, then /).", "If it crashes, the deployment fails with the end of its output and the exit code."],
    ],
  },
  templates: {
    eyebrow: "Developers / Templates",
    title: "Templates & syncbay.json",
    intro: "One-click templates are open-source repositories under github.com/MSNS-DEV. Each carries a syncbay.json that declares its port, health check, databases and variables; Syncbay provisions the databases and deploys the app.",
    code: "{\n  \"port\": 8000,\n  \"healthcheckPath\": \"/health\",\n  \"services\": [{ \"type\": \"postgres\", \"extensions\": [\"vector\"] }],\n  \"env\": [{ \"key\": \"JWT_SECRET\", \"secret\": true, \"generate\": \"secret\" }]\n}",
    cards: [
      ["Catalog", "Browse the templates at /templates, or deploy any repo with /new?repo=<github url>.", "Public repositories need no GitHub connection."],
      ["Services", "postgres (optionally with pgvector), redis or valkey.", "Their URLs are injected as DATABASE_URL / REDIS_URL or the key you name."],
      ["Variables", "Declare required variables, defaults and secrets; generate: \"secret\" creates a random value on the server.", "Missing required variables are reported before anything is created."],
    ],
  },
  api: {
    eyebrow: "Developers / API",
    title: "REST API",
    intro: "The REST API under /api/v1 uses Bearer API tokens created in the dashboard. Tokens are read-only, deploy-only or full access.",
    code: "curl -H \"Authorization: Bearer $SYNCBAY_API_TOKEN\" \\\n  https://www.syncbay.app/api/v1/projects",
    cards: [
      ["Resources", "Projects, services, deployments and databases.", "The OpenAPI document lists every route."],
      ["Deploy", "POST /api/v1/deployments with a serviceId queues a deployment (202).", "It answers 412 when no runner is configured, before creating anything."],
      ["Errors", "A duplicate project name answers 409 with the existing project's id.", "Revoke tokens from the dashboard at any time."],
    ],
  },
  openapi: {
    eyebrow: "Developers / Reference",
    title: "OpenAPI reference",
    intro: "Download the OpenAPI 3.1 document at /api/v1/openapi.json to generate clients or explore the API.",
    cards: [
      ["Format", "OpenAPI 3.1 JSON.", "Served by the control plane."],
      ["Auth", "Bearer API tokens.", "Create tokens in the dashboard."],
      ["Scope", "Projects, services, deployments and databases.", "Dashboard-only features are not in the REST API yet."],
    ],
  },
  integrations: {
    eyebrow: "Developers / GitHub",
    title: "GitHub",
    intro: "Sign in with GitHub to deploy private repositories. Push webhooks start deploys; pull request webhooks create preview environments.",
    cards: [
      ["Push to deploy", "A push to a service's branch starts a new deployment.", "Commit SHAs come from GitHub; Syncbay never invents them."],
      ["PR previews", "A syncbay/preview commit status and a comment link the preview to the pull request.", "The preview is removed or put to sleep when the PR closes."],
      ["Tokens", "Unattended deploys use a working GitHub token from your workspace.", "A token GitHub rejects is cleared and skipped."],
    ],
  },
  observability: {
    eyebrow: "Operate / Observability",
    title: "Logs & metrics",
    intro: "Follow build and runtime logs live, and see CPU, memory and traffic per deployment. Logs are kept for 30 days; metric and traffic samples for 35 days.",
    cards: [
      ["Live logs", "Lines stream as they happen and resume after a reconnect.", "Build errors, app errors and system lines are classified separately."],
      ["Metrics", "CPU and memory read live from the runner; history from stored samples.", "No sample or random data is ever shown."],
      ["Traffic", "Requests, status classes, errors, bytes and latency buckets per deployment.", "The dashboard error rate counts 5xx answers and network errors."],
    ],
  },
  shell: {
    eyebrow: "Operate / Shell",
    title: "Web Shell",
    intro: "Open a shell inside a running container from the browser. Sessions require a signed-in workspace member.",
    cards: [
      ["Access", "Only members of the service's workspace can open a session.", "Sessions are signed tokens; the control plane keeps no shell state."],
      ["Masking", "Secret variable values and credentials in URLs are masked in the output.", "Avoid printing secrets anyway."],
      ["Use it for", "Running migrations, inspecting files and processes, and quick checks.", "Changes inside the container are lost on the next deploy; use volumes for data."],
    ],
  },
  security: {
    eyebrow: "Operate / Security",
    title: "Security",
    intro: "What Syncbay does today to protect your apps and credentials. Syncbay holds no compliance certifications.",
    cards: [
      ["Secrets", "Environment values stay off command lines and out of logs; tokens and URL credentials are redacted from every log line.", "Encryption of stored variable values at rest is planned."],
      ["Edge", "Cloudflare in front, WAF rules and rate limits per service; Syncbay session cookies are stripped from traffic forwarded to your app.", "Your app never sees a visitor's Syncbay session."],
      ["Abuse", "Report abusive content or services at /report-abuse.", "Reports are reviewed in the staff console."],
    ],
  },
  billing: {
    eyebrow: "Operate / Billing",
    title: "Usage & billing",
    intro: "Billing is usage-based from one rate card (see /pricing). Usage is recorded per service for every completed hour and invoiced monthly through Stripe; prepaid credits are applied first.",
    cards: [
      ["Metered today", "Compute (active vCPU seconds), memory (GiB-hours) and network egress (GB).", "There is no per-seat charge."],
      ["Spending cap", "Owners and admins get an email at 80% of the monthly cap; running services pause at 100%.", "Sleeping services do not wake while the cap is reached."],
      ["Cards", "Cards are added through Stripe; Syncbay stores only the brand, last four digits and expiry.", "Top-ups are credited once Stripe confirms the payment."],
    ],
  },
  troubleshooting: {
    eyebrow: "Operate / Troubleshooting",
    title: "Troubleshooting",
    intro: "Most failed deployments come down to the port, the health check or a missing variable. The deployment keeps the error message and the end of the build or app output.",
    cards: [
      ["App not healthy", "Make sure the app listens on 0.0.0.0 and the expected port, and answers /health or / within 120 seconds.", "The log shows a hint when the app only listens on 127.0.0.1."],
      ["Template build failed", "A failed template build is not retried with another builder.", "Set SYNCBAY_BUILDER=nixpacks to try Nixpacks instead."],
      ["Runner not configured", "Deploys are refused with an explanation when no runner is connected.", "Contact support if you see this on syncbay.app."],
    ],
  },
};

const fallbackContent = (topic: (typeof topics)[number]) => ({
  eyebrow: `${topic.group} / Reference`,
  title: topic.title,
  intro: topic.description + ".",
  cards: [] as [string, string, string][],
});

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
          <div className="docs-search"><label htmlFor="docs-search">Search docs</label><input id="docs-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search services, API, builds..." /></div>
          {query ? <div className="docs-results">{results.map((topic) => <button key={topic.id} type="button" onClick={() => navigate(topic.id)}><strong>{topic.title}</strong><span>{topic.group}</span></button>)}{results.length === 0 && <p>No matching guides.</p>}</div> : sections.map((section) => <div className="docs-nav-group" key={section.group}><p>{section.group}</p>{section.items.map(([id, title]) => <button key={id} type="button" className={id === activeId ? "is-active" : ""} onClick={() => navigate(id)}>{title}</button>)}</div>)}
          <div className="docs-sidebar-footer"><span>Questions</span><a href="mailto:support@syncbay.app">support@syncbay.app ↗</a></div>
        </aside>
        <main className="docs-main">
          <div className="docs-breadcrumb">Docs <span>/</span> {page.eyebrow.split(" / ")[0]} <span>/</span> {page.title}</div>
          <article className="docs-article">
            <div className="docs-article-heading"><div><p className="docs-eyebrow">{page.eyebrow}</p><h1>{page.title}</h1><p className="docs-intro">{page.intro}</p></div><button type="button" className="docs-copy-link" onClick={() => navigator.clipboard?.writeText(window.location.href)}>Copy link</button></div>
            <div className="docs-pills"><span>Syncbay platform</span><span>{page.eyebrow.split(" / ")[0]}</span></div>
            <div className="docs-cards">{page.cards.map(([title, description, detail]) => <section className="docs-card" key={title}><h2>{title}</h2><p>{description}</p><small>{detail}</small></section>)}</div>
            {page.code && <div className="docs-code"><div><span>Terminal</span><button type="button" onClick={() => navigator.clipboard?.writeText(page.code ?? "")}>Copy</button></div><pre><code>{page.code}</code></pre></div>}
            <section className="docs-detail"><h2>Details and recommended practice</h2><p>Open a pull request to try a change in a preview environment, check its health and logs, then merge to deploy. Keep secrets in service variables, give automation the narrowest API token scope it needs, and keep an earlier deployment to roll back to.</p><h3>Common workflow</h3><ol><li>Create or select the project and environment.</li><li>Set the repository, branch, port, variables and health check.</li><li>Deploy and follow the build output, live logs and metrics.</li><li>Roll back, restart or pause from the dashboard; trigger deploys from GitHub or the API.</li></ol><h3>Related references</h3><div className="docs-related">{topics.filter((topic) => topic.id !== activeId).slice(0, 4).map((topic) => <button key={topic.id} type="button" onClick={() => navigate(topic.id)}>{topic.title}<span>Read guide →</span></button>)}</div></section>
          </article>
          <footer className="docs-footer"><span>© {new Date().getFullYear()} MSNS-DEV</span><span>Built in Pakistan.</span><Link href="/">Back to syncbay.app</Link></footer>
        </main>
      </div>
    </div>
  );
}


