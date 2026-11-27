/**
 * Syncbay PaaS — R&D Strategies & Weekly Trending Features Engine
 * Tracks weekly version drops, developer tech stack trends, and enterprise roadmap demands.
 */

import { listTemplates, type CatalogTemplate } from "@/lib/templates/catalog";

export interface WeeklyVersionDrop {
  version: string;
  codename: string;
  headline: string;
  features: string[];
  /** What a customer can see or do because of this release. */
  outcome: string;
  status: "RELEASED" | "UPCOMING" | "IN_RESEARCH";
}

export interface RDStrategyInsight {
  id: string;
  pillar: "SPEED" | "TRENDING_TECH" | "ENTERPRISE_DEMAND" | "AI_AUTOMATION";
  title: string;
  strategicRationale: string;
  implementationStatus: "ACTIVE" | "PLANNED" | "EVALUATING";
}

// ─── 1. Release history (mirrors ROADMAP.md) ────────────────────────────────

const WEEKLY_DROPS: WeeklyVersionDrop[] = [
  {
    version: "v1.1",
    codename: "Backend De-Mocked",
    headline: "Real deploys, logs, metrics, billing and data services",
    features: [
      "Health-checked deploys; pause, delete, restart and rollback that really stop and start instances",
      "Persistent deployment logs, runner CPU/memory metrics, hourly usage metering and spending caps",
      "DNS-verified custom domains; Stripe cards, top-ups and invoices without card data on Syncbay",
      "Cloudflare R2 buckets, cron jobs, WAF rules and canary routing; Query Studio read-only by default",
    ],
    outcome: "Every dashboard action maps to a real operation on the runner, Cloudflare or Stripe",
    status: "RELEASED",
  },
  {
    version: "v1.2",
    codename: "Operations",
    headline: "Runner preflight, project actions and traffic analytics",
    features: [
      "Clear errors when the runner is not configured, before anything is created",
      "Redeploy, pause, resume, rename and delete a whole project",
      "Per-deployment request counters; canary rollback uses real 5xx data",
      "Secrets redacted from build and runtime logs",
    ],
    outcome: "Live dashboard analytics from recorded traffic, not sample data",
    status: "RELEASED",
  },
  {
    version: "v1.3",
    codename: "Availability",
    headline: "Always-on by default and zero-downtime deploys",
    features: [
      "Services stay running unless you turn on scale-to-zero",
      "The live version keeps serving while a new one builds, and after a failed release",
      "120-second start-up window with crash output and detection of the port your app really uses",
      "At most 2 builds at once per runner; readable build failures",
    ],
    outcome: "A bad release no longer takes a working service down",
    status: "RELEASED",
  },
  {
    version: "v1.4",
    codename: "Staff Console & Security",
    headline: "Moderation, abuse reports and security fixes",
    features: [
      "Syncbay session cookies stripped from traffic forwarded to customer apps",
      "Staff console with reason-gated actions and an append-only staff audit log",
      "Public abuse reports at /report-abuse",
    ],
    outcome: "Customer apps never see Syncbay session cookies",
    status: "RELEASED",
  },
  {
    version: "v1.5",
    codename: "Keep Apps Up, Build Any Stack",
    headline: "Health monitor, stack templates and the Data view",
    features: [
      "Live apps probed every minute and restarted after two failed probes",
      "Generated Dockerfiles for Node/Next.js, static SPAs, Python, Go, Rust, PHP, Java, Ruby, Deno and Bun",
      "Data view: test connections and browse databases, buckets and volumes",
      "Runner auto-updater with status in the dashboard",
    ],
    outcome: "Most repositories deploy without writing a Dockerfile",
    status: "RELEASED",
  },
  {
    version: "Next",
    codename: "Planned",
    headline: "Backups, isolation and more runners",
    features: [
      "Database backups (scheduled pg_dump to R2) and restore",
      "Per-environment Docker networks between tenants on one runner",
      "Encrypt environment variable values and database credentials at rest",
      "Several runners per workspace, with placement and capacity reporting",
    ],
    outcome: "Planned work; not available yet",
    status: "UPCOMING",
  },
];

// ─── 3. Product principles ──────────────────────────────────────────────────

const STRATEGIC_INSIGHTS: RDStrategyInsight[] = [
  {
    id: "strat_speed",
    pillar: "SPEED",
    title: "Rollback Without Waiting",
    strategicRationale:
      "Rolling back revives the earlier instance from its kept launch spec when the runner still has it, and otherwise redeploys that build — no new commit needed.",
    implementationStatus: "ACTIVE",
  },
  {
    id: "strat_trending_tech",
    pillar: "TRENDING_TECH",
    title: "Long-Running Containers for AI Apps",
    strategicRationale:
      "Services are ordinary always-on containers, so streaming responses (SSE, WebSockets) and long LLM calls are not cut short by a function timeout. pgvector and Valkey are available as managed services.",
    implementationStatus: "ACTIVE",
  },
  {
    id: "strat_enterprise",
    pillar: "ENTERPRISE_DEMAND",
    title: "No Per-Seat Fees",
    strategicRationale:
      "Billing is usage only — compute, memory and egress from one rate card — so inviting a teammate to read logs or review a preview costs nothing.",
    implementationStatus: "ACTIVE",
  },
  {
    id: "strat_ai_automation",
    pillar: "AI_AUTOMATION",
    title: "Rule-Based Deploy Diagnostics",
    strategicRationale:
      "Heuristics read a failed deployment's logs and suggest likely fixes (missing variables, lockfile or build-script problems). They only suggest; nothing is changed automatically.",
    implementationStatus: "ACTIVE",
  },
];

// In-memory store for community feature votes (per server instance; resets on restart).
const featureVotesStore: Map<string, number> = new Map([
  ["Database backups and restore", 0],
  ["Several runners per workspace", 0],
  ["Volume snapshots", 0],
  ["Alerts when a service is auto-restarted", 0],
]);

export function getWeeklyVersionDrops(): WeeklyVersionDrop[] {
  return WEEKLY_DROPS;
}

/** Developer stacks Syncbay ships templates for: the template catalog (templates/index.json). */
export function getTrendingStacks(category?: string): CatalogTemplate[] {
  return listTemplates(category);
}

export function getStrategicInsights(): RDStrategyInsight[] {
  return STRATEGIC_INSIGHTS;
}

export function getFeatureVotes(): { feature: string; votes: number }[] {
  return Array.from(featureVotesStore.entries()).map(([feature, votes]) => ({
    feature,
    votes,
  }));
}

/** Per-user vote dedupe (in-memory, keyed by `${voterId}\u0000${feature}`). */
const featureVoters: Set<string> = new Set();

export function voteForFeature(
  feature: string,
  voterId?: string
): { feature: string; totalVotes: number; alreadyVoted?: boolean } {
  const current = featureVotesStore.get(feature) || 0;
  if (voterId) {
    const key = `${voterId}\u0000${feature}`;
    if (featureVoters.has(key)) {
      return { feature, totalVotes: current, alreadyVoted: true };
    }
    featureVoters.add(key);
  }
  const updated = current + 1;
  featureVotesStore.set(feature, updated);
  return { feature, totalVotes: updated };
}
