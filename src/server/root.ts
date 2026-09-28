import { createTRPCRouter } from "@/server/trpc";
import { workspaceRouter } from "@/server/routers/workspace";
import { projectRouter } from "@/server/routers/project";
import { serviceRouter } from "@/server/routers/service";
import { deploymentRouter } from "@/server/routers/deployment";
import { githubRouter } from "@/server/routers/github";
import { databaseRouter } from "@/server/routers/database";
import { bucketRouter } from "@/server/routers/bucket";
import { domainRouter } from "@/server/routers/domain";
import { volumeRouter } from "@/server/routers/volume";
import { metricsRouter } from "@/server/routers/metrics";
import { tokenRouter } from "@/server/routers/token";
import { edgeRouter } from "@/server/routers/edge";
import { shellRouter } from "@/server/routers/shell";
import { queryStudioRouter } from "@/server/routers/query-studio";
import { devopsRouter } from "@/server/routers/devops";
import { rdRouter } from "@/server/routers/rd";
import { billingRouter } from "@/server/routers/billing";

/**
 * Root tRPC router — all sub-routers are merged here.
 * The dashboard and public API consume this same router.
 */
export const appRouter = createTRPCRouter({
  workspace: workspaceRouter,
  project: projectRouter,
  service: serviceRouter,
  deployment: deploymentRouter,
  github: githubRouter,
  database: databaseRouter,
  bucket: bucketRouter,
  domain: domainRouter,
  volume: volumeRouter,
  metrics: metricsRouter,
  token: tokenRouter,
  edge: edgeRouter,
  shell: shellRouter,
  queryStudio: queryStudioRouter,
  devops: devopsRouter,
  rd: rdRouter,
  billing: billingRouter,
});

export type AppRouter = typeof appRouter;
