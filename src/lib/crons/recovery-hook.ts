/**
 * Calls `recoverStaleDeployments()` from `src/lib/orchestrator/recovery.ts`
 * (deploy-core) when that module exists in the build.
 *
 * webpack's `require.context` with an exact-file pattern compiles to an empty
 * context when the file is absent, so this module builds either way and picks
 * the function up automatically once recovery.ts lands. Outside webpack (tsx
 * scripts) it reports the hook as unavailable.
 */

type RecoveryModule = { recoverStaleDeployments?: () => Promise<unknown> };
type WebpackContext = { keys(): string[]; (id: string): RecoveryModule };

function loadRecoveryModule(): RecoveryModule | null {
  try {
    // Must stay a direct `require.context(<literals>)` call so webpack can analyse it.
    const ctx: WebpackContext = (require as unknown as { context: (d: string, s: boolean, r: RegExp) => WebpackContext }).context(
      "../orchestrator",
      false,
      /^\.\/recovery\.ts$/
    );
    const key = ctx.keys()[0];
    return key ? ctx(key) : null;
  } catch {
    // Not bundled by webpack (tsx), or the module failed to load.
    return null;
  }
}

export async function runDeploymentRecovery(): Promise<{ ran: boolean; result?: unknown; error?: string }> {
  const fn = loadRecoveryModule()?.recoverStaleDeployments;
  if (typeof fn !== "function") return { ran: false, error: "recoverStaleDeployments() is not available in this build" };
  try {
    return { ran: true, result: await fn() };
  } catch (err) {
    return { ran: true, error: (err as Error)?.message || String(err) };
  }
}
