import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedProcedure, publicProcedure } from "@/server/trpc";
import { ErrorDetails } from "@/server/error-details";
import { listTemplates, templateByRepo } from "@/lib/templates/catalog";
import { parseTemplateSource, type ManifestFetchResult, type TemplateSource } from "@/lib/templates/manifest";
import { loadTemplateManifest, provisionTemplate, TemplateInputError } from "@/lib/templates/provision";
import { DatabaseProvisionError } from "@/lib/database-provider";

const sourceInput = z.string().trim().min(3).max(300);

function sourceOrThrow(raw: string): TemplateSource {
  const source = parseTemplateSource(raw);
  if (!source) throw new TRPCError({ code: "BAD_REQUEST", message: "Template must be a GitHub repository: owner/repo or https://github.com/owner/repo" });
  return source;
}

/** What the wizard shows. Defaults of secret entries are never sent back. */
function manifestView(result: ManifestFetchResult) {
  if (result.status !== "found") return null;
  const m = result.manifest;
  return {
    name: m.name ?? null,
    description: m.description ?? null,
    port: m.port ?? null,
    healthcheckPath: m.healthcheckPath ?? null,
    services: m.services.map((s) => ({ type: s.type, env: s.env, extensions: s.extensions ?? [] })),
    env: m.env.map((e) => ({
      key: e.key,
      description: e.description ?? null,
      default: e.secret ? null : (e.default ?? null),
      required: Boolean(e.required),
      secret: Boolean(e.secret || e.generate === "secret"),
      generated: e.generate === "secret",
    })),
  };
}

export const templateRouter = createTRPCRouter({
  /** The one-click template catalog (templates/index.json). */
  list: publicProcedure.input(z.object({ category: z.string().max(32).optional() }).optional()).query(({ input }) => listTemplates(input?.category)),

  /** Repository, default branch and the parsed syncbay.json (absent / invalid reported, not thrown). */
  preview: protectedProcedure.input(z.object({ source: sourceInput })).query(async ({ ctx, input }) => {
    const source = sourceOrThrow(input.source);
    const result = await loadTemplateManifest(source, { userId: ctx.session.user.id });
    const catalog = templateByRepo(source.fullName);
    return {
      source,
      branch: result.defaultBranch,
      catalog: catalog ? { slug: catalog.slug, name: catalog.name, description: catalog.description, icon: catalog.icon } : null,
      manifestStatus: result.status,
      manifestError: result.status === "invalid" || result.status === "unreachable" ? result.error : null,
      manifest: manifestView(result),
    };
  }),

  /**
   * Adds the template's service, databases and variables to an environment the caller can write
   * to. The manifest is fetched again here: nothing the browser sends about it is trusted.
   * The caller then triggers the first deploy with `deployment.trigger`.
   */
  provision: protectedProcedure
    .input(
      z.object({
        environmentId: z.string().min(1),
        source: sourceInput,
        env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string().max(8192)).default({}),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const source = sourceOrThrow(input.source);
      const environment = await ctx.db.environment.findFirst({
        where: {
          id: input.environmentId,
          project: {
            deletedAt: null,
            workspace: { members: { some: { userId: ctx.session.user.id, role: { in: ["OWNER", "ADMIN", "MEMBER"] } } } },
          },
        },
        include: { project: { select: { id: true, workspaceId: true } } },
      });
      if (!environment) throw new TRPCError({ code: "NOT_FOUND", message: "Environment not found or insufficient permissions" });

      const fetched = await loadTemplateManifest(source, { userId: ctx.session.user.id, projectId: environment.project.id });
      if (fetched.status === "invalid") throw new TRPCError({ code: "BAD_REQUEST", message: fetched.error });
      if (fetched.status === "unreachable") throw new TRPCError({ code: "PRECONDITION_FAILED", message: fetched.error });

      try {
        return await provisionTemplate(ctx.db, {
          workspaceId: environment.project.workspaceId,
          projectId: environment.project.id,
          environment: { id: environment.id, name: environment.name },
          source,
          branch: fetched.defaultBranch,
          manifest: fetched.status === "found" ? fetched.manifest : null,
          env: input.env,
        });
      } catch (err) {
        if (err instanceof TemplateInputError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message, cause: new ErrorDetails(err.message, { missing: err.missing.join(",") }) });
        }
        if (err instanceof DatabaseProvisionError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: err.message });
        throw err;
      }
    }),
});
