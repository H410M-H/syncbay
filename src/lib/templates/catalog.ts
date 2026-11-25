/**
 * Syncbay template catalog: the one list of one-click templates (`templates/index.json` at the repo
 * root). The marketing pages, the /templates page and the R&D router all read it from here.
 *
 * `metrics` are measured by the template pipeline (image size, idle memory, cold start). They stay
 * null until a measurement exists, and the UI shows nothing for a null value.
 */

import { z } from "zod";
import rawCatalog from "../../../templates/index.json";

export const TEMPLATE_CATEGORIES = ["FRONTEND", "API", "REALTIME", "AI", "DATA", "MICROSERVICES"] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

/** `<owner>/<repo>` as accepted by `/new?template=`. */
export const TEMPLATE_REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

const metric = z.number().nonnegative().nullable();

const templateSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(240),
  stack: z.array(z.string().min(1)).min(1),
  tags: z.array(z.string().min(1)),
  category: z.enum(TEMPLATE_CATEGORIES),
  icon: z.string().min(1).max(8),
  repo: z.string().regex(TEMPLATE_REPO_PATTERN),
  repoUrl: z.string().url(),
  deployUrl: z.string().url(),
  services: z.array(
    z.object({
      type: z.enum(["postgres", "redis", "valkey"]),
      extensions: z.array(z.string()).optional(),
    })
  ),
  port: z.number().int().min(1).max(65535),
  metrics: z.object({ imageSizeMB: metric, idleMemMB: metric, coldStartMs: metric }),
});

export type CatalogTemplate = z.infer<typeof templateSchema>;

const catalogSchema = z.object({
  version: z.literal(1),
  templates: z.array(templateSchema).min(1),
});

/** Validates a catalog document; throws on a malformed entry or a duplicate slug. */
export function parseTemplateCatalog(input: unknown): CatalogTemplate[] {
  const { templates } = catalogSchema.parse(input);
  const seen = new Set<string>();
  for (const t of templates) {
    if (seen.has(t.slug)) throw new Error(`Duplicate template slug: ${t.slug}`);
    seen.add(t.slug);
    if (t.repoUrl !== `https://github.com/${t.repo}`) throw new Error(`Template ${t.slug}: repoUrl does not match repo`);
  }
  return templates;
}

const TEMPLATES: readonly CatalogTemplate[] = Object.freeze(parseTemplateCatalog(rawCatalog));

export function listTemplates(category?: string): CatalogTemplate[] {
  if (!category || category.toUpperCase() === "ALL") return [...TEMPLATES];
  return TEMPLATES.filter((t) => t.category === category.toUpperCase());
}

export function templateBySlug(slug: string): CatalogTemplate | undefined {
  return TEMPLATES.find((t) => t.slug === slug);
}

/** Catalog entry for a `<owner>/<repo>` (case-insensitive), if it is one of ours. */
export function templateByRepo(repo: string): CatalogTemplate | undefined {
  const wanted = repo.toLowerCase();
  return TEMPLATES.find((t) => t.repo.toLowerCase() === wanted);
}

/** Link that starts a one-click deploy of a catalog template on this site. */
export function templateDeployHref(t: Pick<CatalogTemplate, "repo">): string {
  return `/new?template=${t.repo}`;
}

/** Measured metrics as display strings; a metric that has not been measured is omitted. */
export function formatTemplateMetrics(m: CatalogTemplate["metrics"]): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  if (m.imageSizeMB != null) out.push({ label: "Image size", value: `${m.imageSizeMB} MB` });
  if (m.idleMemMB != null) out.push({ label: "Idle memory", value: `${m.idleMemMB} MB` });
  if (m.coldStartMs != null) out.push({ label: "Cold start", value: m.coldStartMs >= 1000 ? `${(m.coldStartMs / 1000).toFixed(1)} s` : `${m.coldStartMs} ms` });
  return out;
}
