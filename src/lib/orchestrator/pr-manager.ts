import { db } from "@/lib/db";
import { scheduleDeployment } from "./schedule";
import { stopServiceInstances } from "./lifecycle";
import { slugifyHostPart } from "@/lib/domain-service";
import { Octokit } from "@octokit/rest";

function getPrismaClient(): any {
  const globalForPrisma = globalThis as unknown as { prisma?: any };
  return globalForPrisma.prisma ?? db;
}

export interface GitHubPullRequestEvent {
  action: "opened" | "synchronize" | "closed" | "reopened";
  number: number;
  pull_request: {
    title: string;
    merged: boolean;
    head: {
      ref: string;
      sha: string;
    };
    base: {
      ref: string;
    };
  };
  repository: {
    html_url: string;
    full_name: string;
    name?: string;
  };
}

export interface PostCommitStatusOptions {
  owner: string;
  repo: string;
  commitSha: string;
  previewUrl: string;
  state?: "pending" | "success" | "failure" | "error";
  description?: string;
  context?: string;
  projectId?: string;
  octokit?: Octokit;
}

export interface PostCommentOptions {
  owner: string;
  repo: string;
  prNumber: number;
  commitSha: string;
  previewUrl: string;
  branch?: string;
  projectId?: string;
  octokit?: Octokit;
  /** Deployment state the comment reports (default `success`). */
  state?: "pending" | "success" | "failure";
  errorMessage?: string;
}

/**
 * Resolves an authenticated GitHub Octokit instance.
 * Order: GITHUB_TOKEN / GITHUB_PAT env, then the triggering user's GitHub account, then a
 * GitHub account of a member of the project's workspace (owners first). It never borrows an
 * unrelated user's token; with no match it returns null.
 */
export async function getOctokitClient(projectId?: string, userId?: string): Promise<Octokit | null> {
  const envToken = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT || process.env.GITHUB_ACCESS_TOKEN;
  if (envToken) {
    return new Octokit({ auth: envToken });
  }

  try {
    const memberOfProject = projectId
      ? { memberships: { some: { workspace: { projects: { some: { id: projectId } } } } } }
      : undefined;
    const lookups: any[] = [];
    if (userId) lookups.push({ userId, ...(memberOfProject ? { user: memberOfProject } : {}) });
    if (memberOfProject) {
      lookups.push({ user: { memberships: { some: { role: "OWNER", workspace: { projects: { some: { id: projectId } } } } } } });
      lookups.push({ user: memberOfProject });
    }
    for (const where of lookups) {
      const account = await db.account.findFirst({
        where: { provider: "github", access_token: { not: null }, ...where },
        select: { access_token: true },
      });
      if (account?.access_token) return new Octokit({ auth: account.access_token });
    }
  } catch (err: any) {
    console.warn("Could not retrieve GitHub account token:", err?.message);
  }

  // In test environments or when explicitly mocked, construct default Octokit
  if (process.env.NODE_ENV === "test" || process.env.MOCK_GITHUB === "true") {
    try {
      return new Octokit();
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Posts commit status check (`syncbay/preview`) to GitHub.
 */
export async function postPreviewCommitStatus(options: PostCommitStatusOptions): Promise<boolean> {
  try {
    const octokit = options.octokit || (await getOctokitClient(options.projectId));
    if (!octokit) return false;

    await octokit.rest.repos.createCommitStatus({
      owner: options.owner,
      repo: options.repo,
      sha: options.commitSha,
      state: options.state || "pending",
      target_url: options.previewUrl,
      description: options.description || "Syncbay ephemeral preview is ready",
      context: options.context || "syncbay/preview",
    });
    return true;
  } catch (err: any) {
    console.warn("Failed to post GitHub commit status:", err?.message);
    return false;
  }
}

/**
 * Posts or updates a PR comment containing live preview URL and badges.
 */
export async function postPreviewComment(options: PostCommentOptions): Promise<boolean> {
  try {
    const octokit = options.octokit || (await getOctokitClient(options.projectId));
    if (!octokit) return false;

    const shortSha = options.commitSha ? options.commitSha.slice(0, 7) : "unknown";
    const commentMarker = "<!-- syncbay-preview-comment -->";
    const state = options.state || "success";
    const view = {
      pending: { title: "Syncbay Ephemeral Preview Deploying", badge: "Deploying-f59e0b", status: "🟡 Building / deploying" },
      success: { title: "Syncbay Ephemeral Preview Ready", badge: "Preview%20Ready-06b6d4", status: "🟢 Active" },
      failure: { title: "Syncbay Ephemeral Preview Failed", badge: "Failed-ef4444", status: "🔴 Failed" },
    }[state];
    const errorLine = state === "failure" && options.errorMessage
      ? [`- **Error**: \`${options.errorMessage.replace(/[`\r\n]+/g, " ").slice(0, 300)}\``]
      : [];
    const body = [
      `### ${state === "failure" ? "❌" : state === "pending" ? "⏳" : "🚀"} ${view.title}`,
      ``,
      `[![Syncbay Preview](https://img.shields.io/badge/Syncbay-${view.badge}?style=flat-square)](${options.previewUrl})`,
      ``,
      `- **Preview URL**: [${options.previewUrl}](${options.previewUrl})`,
      `- **Commit**: \`${shortSha}\``,
      ...(options.branch ? [`- **Branch**: \`${options.branch}\``] : []),
      `- **Status**: ${view.status}`,
      ...errorLine,
      `- **Idle Timeout**: 30m auto-sleep enabled`,
      ``,
      commentMarker,
    ].join("\n");

    const existingComments = await octokit.rest.issues.listComments({
      owner: options.owner,
      repo: options.repo,
      issue_number: options.prNumber,
    }).catch(() => ({ data: [] }));

    const existingComment = existingComments.data.find(
      (c) => c.body && (c.body.includes(commentMarker) || c.body.includes("Syncbay Ephemeral Preview"))
    );

    if (existingComment) {
      await octokit.rest.issues.updateComment({
        owner: options.owner,
        repo: options.repo,
        comment_id: existingComment.id,
        body,
      });
    } else {
      await octokit.rest.issues.createComment({
        owner: options.owner,
        repo: options.repo,
        issue_number: options.prNumber,
        body,
      });
    }
    return true;
  } catch (err: any) {
    console.warn("Failed to post/update GitHub PR comment:", err?.message);
    return false;
  }
}

/** Splits a GitHub repo URL (`https://github.com/o/r(.git)`, `git@github.com:o/r`) into owner/repo. */
export function parseGitHubRepo(repoUrl?: string | null): { owner: string; repo: string } | null {
  if (!repoUrl) return null;
  const m = repoUrl.trim().match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * Resolves the HEAD commit SHA of `branch` (or the default branch) through the GitHub API.
 * Returns null when the repo is not on GitHub, no token is available or the call fails:
 * callers store null instead of inventing a SHA.
 */
export async function resolveHeadCommitSha(
  repoUrl: string | null | undefined,
  branch?: string | null,
  opts: { projectId?: string; userId?: string; octokit?: Octokit } = {}
): Promise<string | null> {
  const parsed = parseGitHubRepo(repoUrl);
  if (!parsed) return null;
  try {
    const octokit = opts.octokit || (await getOctokitClient(opts.projectId, opts.userId));
    if (!octokit) return null;
    let ref = branch || "";
    if (!ref) {
      const repo = await octokit.rest.repos.get({ owner: parsed.owner, repo: parsed.repo });
      ref = repo.data.default_branch;
    }
    const res = await octokit.rest.repos.getCommit({ owner: parsed.owner, repo: parsed.repo, ref });
    return res.data.sha || null;
  } catch (err: any) {
    console.warn(`Could not resolve HEAD of ${parsed.owner}/${parsed.repo}@${branch || "default"}:`, err?.message);
    return null;
  }
}

/**
 * Engine hook: posts the `syncbay/preview` commit status and rewrites the PR comment for a
 * PR-environment deployment once it reaches a terminal state. No-op for other deployments.
 */
export async function reportPreviewDeploymentStatus(
  deploymentId: string,
  state: "pending" | "success" | "failure",
  clientArg?: any,
  octokit?: Octokit
): Promise<boolean> {
  const client = clientArg || getPrismaClient();
  if (typeof client?.deployment?.findUnique !== "function") return false;
  const dep = await client.deployment.findUnique({
    where: { id: deploymentId },
    include: { build: true, service: { include: { domains: true, environment: true } } },
  });
  const env = dep?.service?.environment;
  if (!dep || !env?.isPrEnv || !env.prNumber) return false;
  const repo = parseGitHubRepo(dep.service.repoUrl);
  if (!repo) return false;

  const prHost =
    dep.service.domains?.find((d: any) => /-pr-\d+\.syncbay\.app$/.test(d.hostname))?.hostname ||
    `${slugifyHostPart(dep.service.name)}-pr-${env.prNumber}.syncbay.app`;
  const previewUrl = `https://${prHost}`;
  const commitSha: string = dep.build?.commitSha || "";
  const errorMessage = state === "failure" ? (await import("@/lib/telemetry/event-bus")).logEventBus.getError(deploymentId) : undefined;
  const client2 = octokit || (await getOctokitClient(env.projectId));
  if (!client2) return false;

  const description = {
    pending: "Syncbay ephemeral preview deploying...",
    success: "Syncbay ephemeral preview is live",
    failure: "Syncbay ephemeral preview failed to deploy",
  }[state];
  const statusOk = commitSha
    ? await postPreviewCommitStatus({ ...repo, commitSha, previewUrl, state, description, octokit: client2 })
    : false;
  const commentOk = await postPreviewComment({
    ...repo,
    prNumber: env.prNumber,
    commitSha,
    previewUrl,
    branch: dep.service.branch || undefined,
    state,
    errorMessage: errorMessage || undefined,
    octokit: client2,
  });
  return statusOk || commentOk;
}

/**
 * Transitions active deployments of a PR ephemeral environment to SLEEPING.
 */
export async function sleepPreviewEnvironment(
  prNumberOrOptions: number | { prNumber: number; projectId?: string },
  projectIdArg?: string
) {
  const prNumber = typeof prNumberOrOptions === "number" ? prNumberOrOptions : prNumberOrOptions.prNumber;
  const projectId = typeof prNumberOrOptions === "object" ? prNumberOrOptions.projectId : projectIdArg;
  const envName = `pr-${prNumber}`;
  const client = getPrismaClient();

  const prEnv = await client.environment.findFirst({
    where: {
      name: envName,
      ...(projectId ? { projectId } : {}),
    },
    include: {
      services: true,
    },
  });

  if (!prEnv) {
    return { success: false, message: `Preview environment ${envName} not found` };
  }

  const serviceIds = (prEnv.services || []).map((s: any) => s.id);
  // Stop the running preview instances and route their hosts to the sleeping splash.
  for (const id of serviceIds) {
    await stopServiceInstances(id, "pause", client).catch((err: any) =>
      console.warn(`Could not stop preview service ${id}:`, err?.message)
    );
  }
  if (serviceIds.length > 0) {
    await client.deployment.updateMany({
      where: {
        serviceId: { in: serviceIds },
        status: { in: ["ACTIVE", "DEPLOYING", "BUILDING", "QUEUED"] },
      },
      data: {
        status: "SLEEPING",
      },
    });

    await client.service.updateMany({
      where: {
        id: { in: serviceIds },
      },
      data: {
        isPaused: true,
      },
    });
  }

  return {
    success: true,
    environmentId: prEnv.id,
    prNumber,
    status: "SLEEPING",
    message: `PR #${prNumber} preview environment put to sleep`,
  };
}

/**
 * Destroys ephemeral preview environment and cascades cleanup of services, domains, and variables.
 */
export async function destroyPreviewEnvironment(
  prNumberOrOptions: number | { prNumber: number; projectId?: string },
  projectIdArg?: string
) {
  const prNumber = typeof prNumberOrOptions === "number" ? prNumberOrOptions : prNumberOrOptions.prNumber;
  const projectId = typeof prNumberOrOptions === "object" ? prNumberOrOptions.projectId : projectIdArg;
  const envName = `pr-${prNumber}`;
  const client = getPrismaClient();

  const prEnv = await client.environment.findFirst({
    where: {
      name: envName,
      ...(projectId ? { projectId } : {}),
    },
    include: {
      services: true,
    },
  });

  if (!prEnv) {
    return {
      success: false,
      prNumber,
      message: `Preview environment ${envName} not found`,
    };
  }

  // Stop instances, free ports and drop routes/tunnel ingress before the rows cascade away.
  for (const svc of prEnv.services || []) {
    await stopServiceInstances(svc.id, "delete", client).catch((err: any) =>
      console.warn(`Could not stop preview service ${svc.id}:`, err?.message)
    );
  }

  await client.environment.delete({
    where: { id: prEnv.id },
  }).catch((err: any) => {
    console.warn(`Error deleting environment ${prEnv.id}:`, err?.message);
  });

  return {
    success: true,
    environmentId: prEnv.id,
    prNumber,
    action: "destroyed",
    message: `PR #${prNumber} preview environment destroyed`,
  };
}

/**
 * Handles GitHub pull_request webhook events (opened, synchronize, closed, reopened).
 */
export async function handlePullRequestWebhook(event: GitHubPullRequestEvent) {
  const rawRepoUrl = event.repository.html_url || "";
  const normalizedRepoUrl = rawRepoUrl.replace(/\/$/, "").replace(/\.git$/, "");
  const prNumber = event.number;
  const branch = event.pull_request.head.ref;
  const commitSha = event.pull_request.head.sha;

  const client = getPrismaClient();

  // Find all services referencing this repo
  const services = await client.service.findMany({
    where: {
      OR: [
        { repoUrl: rawRepoUrl },
        { repoUrl: normalizedRepoUrl },
        { repoUrl: `${normalizedRepoUrl}.git` },
        { repoUrl: `${normalizedRepoUrl}/` },
      ],
      sourceType: "github",
      deletedAt: null,
    },
    include: {
      variables: true,
      environment: {
        include: {
          project: true,
        },
      },
    },
  });

  if (services.length === 0) return { matched: 0, results: [] };

  const results = [];

  for (const service of services) {
    const project = service.environment.project;
    const envName = `pr-${prNumber}`;

    if (event.action === "closed") {
      // PR merged or closed — teardown preview environment
      const cleanupResult = await destroyPreviewEnvironment(prNumber, project.id);
      results.push({
        serviceId: service.id,
        action: "cleaned_up",
        ...cleanupResult,
      });
      continue;
    }

    if (event.action === "opened" || event.action === "synchronize" || event.action === "reopened") {
      // Find or create the ephemeral environment
      let prEnv = await client.environment.findFirst({
        where: {
          projectId: project.id,
          name: envName,
        },
      });

      if (!prEnv) {
        prEnv = await client.environment.create({
          data: {
            projectId: project.id,
            name: envName,
            isPrEnv: true,
            prNumber,
          },
        });
      }

      // Find or clone service in the preview environment
      let prService = await client.service.findFirst({
        where: {
          environmentId: prEnv.id,
          name: service.name,
        },
        include: {
          variables: true,
        },
      });

      if (!prService) {
        prService = await client.service.create({
          data: {
            environmentId: prEnv.id,
            name: service.name,
            sourceType: "github",
            repoUrl: service.repoUrl,
            branch,
            port: service.port,
            buildCommand: service.buildCommand,
            startCommand: service.startCommand,
            instanceType: service.instanceType || "lite",
            scaleToZero: true,
            idleTimeoutSecs: 1800,
          },
          include: {
            variables: true,
          },
        });

        // Clone variables from the base service
        for (const v of service.variables) {
          await client.environmentVariable.create({
            data: {
              serviceId: prService.id,
              key: v.key,
              value: v.value,
              isSecret: v.isSecret,
            },
          }).catch(() => null);
        }
      } else {
        // Ensure scaleToZero and idleTimeoutSecs are updated
        await client.service.update({
          where: { id: prService.id },
          data: {
            scaleToZero: true,
            idleTimeoutSecs: 1800,
            branch,
            isPaused: false,
          },
        }).catch(() => null);
      }

      // Persist valid Domain record for ephemeral preview
      const previewHostname = `${slugifyHostPart(service.name)}-pr-${prNumber}.syncbay.app`;
      const domain = await client.domain.upsert({
        where: { hostname: previewHostname },
        update: {
          serviceId: prService.id,
          isGenerated: true,
          status: "ACTIVE",
          verifiedAt: new Date(),
        },
        create: {
          serviceId: prService.id,
          hostname: previewHostname,
          isGenerated: true,
          status: "ACTIVE",
          verifiedAt: new Date(),
        },
      });
      const previewUrl = `https://${previewHostname}`;

      // Trigger build & deployment
      const build = await client.build.create({
        data: {
          serviceId: prService.id,
          commitSha,
          commitMessage: event.pull_request.title,
          triggeredBy: `github-pr-${prNumber}`,
          status: "QUEUED",
        },
      });

      const deployment = await client.deployment.create({
        data: {
          serviceId: prService.id,
          buildId: build.id,
          triggeredBy: `github-pr-${prNumber}`,
          status: "QUEUED",
        },
      });

      // Post the pending commit status and PR comment first; the engine updates both on completion
      const repoFullName = event.repository.full_name || "";
      const [owner, repo] = repoFullName
        ? repoFullName.split("/")
        : (rawRepoUrl.replace(/\/$/, "").split("/").slice(-2) as [string, string]);

      if (owner && repo) {
        await postPreviewCommitStatus({
          owner,
          repo,
          commitSha,
          previewUrl,
          state: "pending",
          description: "Syncbay ephemeral preview deploying...",
          projectId: project.id,
        });

        await postPreviewComment({
          owner,
          repo,
          prNumber,
          commitSha,
          previewUrl,
          branch,
          projectId: project.id,
          state: "pending",
        });
      }

      await scheduleDeployment(deployment.id, build.id, prService.id, {
        serviceId: prService.id,
        commitSha,
        commitMessage: `PR #${prNumber}: ${event.pull_request.title}`,
      });

      results.push({
        serviceId: prService.id,
        deploymentId: deployment.id,
        prNumber,
        previewUrl,
        domainId: domain.id,
        hostname: previewHostname,
      });
    }
  }

  return { matched: services.length, results };
}
