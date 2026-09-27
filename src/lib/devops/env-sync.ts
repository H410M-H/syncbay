/**
 * Syncbay PaaS — Environment Variable Synchronization & .env Parser (M5 F15)
 */

export function parseDotEnv(rawContent: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!rawContent || typeof rawContent !== "string") return result;

  const lines = rawContent.split(/\r?\n/);

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;

    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) continue;

    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();

    // Strip surrounding quotes if matched
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }

    result[key] = val;
  }

  return result;
}

export function copyVariablesBetweenEnvironments(
  sourceVars: Record<string, string>,
  targetVars: Record<string, string>,
  mode: "merge" | "overwrite"
): Record<string, string> {
  if (mode === "overwrite") {
    return { ...sourceVars };
  }
  return { ...targetVars, ...sourceVars };
}

export function inheritWorkspaceVariables(
  workspaceVars: Record<string, string>,
  serviceVars: Record<string, string>
): Record<string, string> {
  // Service variables override workspace variables
  return { ...workspaceVars, ...serviceVars };
}

export function maskSecrets(
  vars: Record<string, { value: string; isSecret: boolean }> | Record<string, string>
): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v === "object" && v !== null && "value" in v) {
      masked[k] = v.isSecret ? "••••••••" : v.value;
    } else {
      const isSecretKey = !["PORT", "NODE_ENV", "APP_ENV"].includes(k) && !k.startsWith("NEXT_PUBLIC_");
      masked[k] = isSecretKey ? "••••••••" : String(v);
    }
  }
  return masked;
}

export interface SyncVariablesInput {
  serviceId: string;
  variables?: Record<string, string>;
  rawEnv?: string;
  mode?: "merge" | "overwrite";
  includeWorkspaceShared?: boolean;
}

export async function executeSyncVariables(
  db: any,
  userId: string,
  input: SyncVariablesInput
) {
  const { TRPCError } = await import("@trpc/server");

  // 1. Verify caller has OWNER or ADMIN role
  const service = await db.service.findFirst({
    where: {
      id: input.serviceId,
      deletedAt: null,
      environment: {
        project: {
          deletedAt: null,
          workspace: {
            members: {
              some: {
                userId,
                role: { in: ["OWNER", "ADMIN"] },
              },
            },
          },
        },
      },
    },
    include: {
      environment: {
        include: {
          project: {
            include: { workspace: true },
          },
        },
      },
    },
  });

  if (!service) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only workspace Owners and Admins can synchronize environment variables.",
    });
  }

  const workspaceId = service.environment.project.workspaceId;
  const mode = input.mode || "merge";

  // 2. Parse incoming variables
  let incomingVars: Record<string, string> = {};
  if (input.rawEnv) {
    incomingVars = { ...incomingVars, ...parseDotEnv(input.rawEnv) };
  }
  if (input.variables) {
    incomingVars = { ...incomingVars, ...input.variables };
  }

  // 3. Workspace variable inheritance if requested
  if (input.includeWorkspaceShared) {
    const wsVars = await db.environmentVariable.findMany({
      where: { workspaceId, serviceId: null },
    });
    const wsDict: Record<string, string> = {};
    for (const v of wsVars) wsDict[v.key] = v.value;
    incomingVars = inheritWorkspaceVariables(wsDict, incomingVars);
  }

  // 4. Overwrite vs Merge Mode
  if (mode === "overwrite") {
    await db.environmentVariable.deleteMany({
      where: { serviceId: input.serviceId },
    });
  }

  // Upsert variables
  const entries = Object.entries(incomingVars);
  for (const [key, value] of entries) {
    const trimmedKey = key.trim();
    if (!trimmedKey) continue;

    const isRef = value.includes("${{");
    const isSecret = !["PORT", "NODE_ENV", "APP_ENV"].includes(trimmedKey) && !trimmedKey.startsWith("NEXT_PUBLIC_");

    const existing = await db.environmentVariable.findFirst({
      where: { serviceId: input.serviceId, key: trimmedKey },
    });

    if (existing) {
      await db.environmentVariable.update({
        where: { id: existing.id },
        data: { value, isSecret, isReference: isRef },
      });
    } else {
      await db.environmentVariable.create({
        data: {
          serviceId: input.serviceId,
          key: trimmedKey,
          value,
          isSecret,
          isReference: isRef,
        },
      });
    }
  }

  const syncedKeys = Object.keys(incomingVars);

  return {
    success: true,
    count: syncedKeys.length,
    mode,
    syncedKeys,
  };
}
