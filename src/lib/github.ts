import { db } from "@/lib/db";
import { Octokit } from "@octokit/rest";

type TokenCheck = (token: string) => Promise<"valid" | "revoked" | "unknown">;

/** Asks GitHub whether a token still works (401 = revoked; network trouble = unknown, used anyway). */
const checkToken: TokenCheck = async (token) => {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "syncbay" },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 401) return "revoked";
    return res.ok ? "valid" : "unknown";
  } catch {
    return "unknown";
  }
};

/**
 * A GitHub token for work done on behalf of a project, including work nobody is signed in for
 * (push webhooks, cron recovery, always-on restarts). Order: `GITHUB_TOKEN` / `GITHUB_PAT` /
 * `GITHUB_ACCESS_TOKEN`, the triggering user, the project workspace's owners, then its other
 * members. It never borrows the token of someone outside the workspace. A token GitHub rejects
 * as revoked is cleared (the user is asked to reconnect) and the next candidate is tried.
 */
export async function resolveGithubToken(
  opts: { projectId?: string | null; userId?: string | null; check?: TokenCheck } = {}
): Promise<string | null> {
  const envToken = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT || process.env.GITHUB_ACCESS_TOKEN;
  if (envToken) return envToken;

  const memberOfProject = opts.projectId
    ? { memberships: { some: { workspace: { projects: { some: { id: opts.projectId } } } } } }
    : undefined;
  const lookups: Record<string, unknown>[] = [];
  if (opts.userId) lookups.push({ userId: opts.userId, ...(memberOfProject ? { user: memberOfProject } : {}) });
  if (memberOfProject) {
    lookups.push({ user: { memberships: { some: { role: "OWNER", workspace: { projects: { some: { id: opts.projectId } } } } } } });
    lookups.push({ user: memberOfProject });
  }

  // GITHUB_TOKEN_VALIDATION=off skips the live check (tests with placeholder tokens, offline runs).
  const check: TokenCheck = opts.check || (process.env.GITHUB_TOKEN_VALIDATION === "off" ? async () => "unknown" : checkToken);
  const tried = new Set<string>();
  for (const where of lookups) {
    const accounts = await db.account.findMany({
      where: { provider: "github", access_token: { not: null }, ...where },
      select: { id: true, access_token: true },
      take: 5,
    });
    for (const account of accounts) {
      if (!account.access_token || tried.has(account.id)) continue;
      tried.add(account.id);
      const state = await check(account.access_token);
      if (state === "revoked") {
        await db.account.update({ where: { id: account.id }, data: { access_token: null } }).catch(() => null);
        continue;
      }
      return account.access_token;
    }
  }
  return null;
}

/**
 * Creates an Octokit instance for the given user's GitHub account.
 * Requires the user to have connected their GitHub account via NextAuth
 * and for us to have their access_token saved in the Account model.
 */
export async function getGitHubClientForUser(userId: string) {
  const account = await db.account.findFirst({
    where: {
      userId: userId,
      provider: "github",
    },
  });

  if (!account || !account.access_token) {
    throw new Error("GitHub account not connected or access token missing");
  }

  return new Octokit({ auth: account.access_token });
}

/**
 * Creates a webhook on a specific GitHub repository.
 */
export async function createRepoWebhook(
  userId: string,
  owner: string,
  repo: string,
  webhookUrl: string,
  secret: string
) {
  const octokit = await getGitHubClientForUser(userId);

  try {
    const response = await octokit.rest.repos.createWebhook({
      owner,
      repo,
      name: "web",
      active: true,
      events: ["push", "pull_request"],
      config: {
        url: webhookUrl,
        content_type: "json",
        secret: secret,
        insecure_ssl: "0",
      },
    });

    return response.data;
  } catch (error: any) {
    // If webhook already exists, GitHub might return 422
    if (error.status === 422) {
      console.warn(`Webhook already exists for ${owner}/${repo}`);
      return null;
    }
    throw error;
  }
}

/**
 * Fetches the list of repositories the user has access to.
 */
export async function listUserRepos(userId: string) {
  const octokit = await getGitHubClientForUser(userId);
  
  // Use pagination if needed, taking first 100 for now
  const response = await octokit.rest.repos.listForAuthenticatedUser({
    sort: "updated",
    per_page: 100,
  });

  return response.data;
}
