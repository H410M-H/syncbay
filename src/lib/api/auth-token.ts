/**
 * Syncbay PaaS — Public API Bearer Token Authentication (M6)
 * Validates bearer tokens against database hash and returns authorized workspace & scope.
 */

import crypto from "crypto";
import { db } from "@/lib/db";
import { ApiTokenScope } from "@prisma/client";

export interface AuthorizedApiContext {
  tokenId: string;
  tokenName: string;
  workspaceId: string;
  userId: string | null;
  scope: ApiTokenScope;
  workspaceName: string;
}

/**
 * Validates an Authorization header string ("Bearer <token>")
 */
export async function validateBearerToken(
  authHeader: string | null | undefined
): Promise<AuthorizedApiContext> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error("Missing or malformed Authorization header. Expected: Bearer <token>");
  }

  const rawToken = authHeader.replace(/^Bearer\s+/, "").trim();
  if (!rawToken) {
    throw new Error("Empty API token provided");
  }


  // Tokens start with pw_live_ or sb_live_
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

  const tokenRecord = await db.apiToken.findUnique({
    where: { tokenHash },
    include: {
      workspace: true,
      user: true,
    },
  });

  if (!tokenRecord) {
    throw new Error("Invalid API token");
  }

  if (tokenRecord.revokedAt) {
    throw new Error("API token has been revoked");
  }

  // Update lastUsedAt asynchronously
  await db.apiToken.update({
    where: { id: tokenRecord.id },
    data: { lastUsedAt: new Date() },
  }).catch(() => null);

  return {
    tokenId: tokenRecord.id,
    tokenName: tokenRecord.name,
    workspaceId: tokenRecord.workspaceId,
    userId: tokenRecord.userId,
    scope: tokenRecord.scope,
    workspaceName: tokenRecord.workspace.name,
  };
}

/**
 * Checks if the granted scope satisfies the required scope
 */
export function checkScope(
  granted: ApiTokenScope,
  required: "READ_ONLY" | "DEPLOY_ONLY" | "FULL_ACCESS"
): boolean {
  if (granted === "FULL_ACCESS") return true;
  if (required === "READ_ONLY") return true; // all active tokens can read
  if (required === "DEPLOY_ONLY") return granted === "DEPLOY_ONLY";
  return false;
}
