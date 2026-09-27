/**
 * Syncbay PaaS — Interactive Web Shell tRPC Router (M7)
 * Dispatches diagnostic commands into active container runtimes and returns ANSI output.
 */

import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import { TRPCError } from "@trpc/server";
import { executeShellCommand, getPrompt } from "@/lib/shell/web-shell";

export const shellRouter = createTRPCRouter({
  /** Execute a shell command inside the service container environment */
  exec: protectedProcedure
    .input(
      z.object({
        serviceId: z.string(),
        command: z.string(),
        cwd: z.string().default("/app"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const service = await ctx.db.service.findFirst({
        where: {
          id: input.serviceId,
          environment: {
            project: {
              workspace: {
                members: {
                  some: {
                    userId: ctx.session.user.id,
                    role: { in: ["OWNER", "ADMIN", "MEMBER"] },
                  },
                },
              },
            },
          },
        },
        include: {
          variables: true,
          deployments: { take: 1, orderBy: { createdAt: "desc" } },
        },
      });

      if (!service) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Service not found or unauthorized" });
      }

      // Populate environment variables map
      const env: Record<string, string> = {};
      for (const v of service.variables) {
        env[v.key] = v.value;
      }

      const containerId = service.deployments[0]?.cfContainerId || `cf-cont-${service.name}`;

      const result = executeShellCommand(input.command, {
        cwd: input.cwd,
        env,
        serviceName: service.name,
        containerId,
      });

      return {
        ...result,
        prompt: getPrompt(service.name, result.cwd),
      };
    }),
});
