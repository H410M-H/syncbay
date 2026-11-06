/**
 * Syncbay PaaS — Deploy log diagnoser (heuristic)
 *
 * Rule-based pattern matching over build/runtime log lines (no model is
 * called). Each report names the matched rule; `confidenceScore` is the fixed
 * weight of that rule, not a measured probability. `automatedFixCommand` is a
 * suggestion — nothing is run or applied.
 */

export interface AiDiagnosticReport {
  issueCategory:
    | "MISSING_DEPENDENCY"
    | "PORT_BINDING_MISMATCH"
    | "MISSING_ENVIRONMENT_VARIABLE"
    | "OUT_OF_MEMORY"
    | "TYPESCRIPT_SYNTAX_ERROR"
    | "UNKNOWN_RUNTIME_ERROR";
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  summary: string;
  rootCause: string;
  suggestedSolution: string;
  automatedFixCommand?: string;
  /** Fixed per-rule weight (0.0 - 1.0), not a calibrated probability. */
  confidenceScore: number;
  detectedPatterns: string[];
  method: "heuristic";
}

export function diagnoseBuildLogs(logLines: string[]): AiDiagnosticReport {
  const fullLog = logLines.join("\n");

  // 1. Missing Node.js dependency
  if (
    fullLog.includes("Cannot find module") ||
    fullLog.includes("Module not found: Can't resolve") ||
    fullLog.includes("Error: Cannot find module")
  ) {
    const match =
      fullLog.match(/Cannot find module ['"]([^'"]+)['"]/i) ||
      fullLog.match(/Can't resolve ['"]([^'"]+)['"]/i);
    const moduleName = match ? match[1] : "required dependency";

    return {
      issueCategory: "MISSING_DEPENDENCY",
      severity: "CRITICAL",
      summary: `Missing npm dependency: "${moduleName}"`,
      rootCause: `Application imports "${moduleName}" but it is not listed in package.json dependencies or failed during install phase.`,
      suggestedSolution: `Add "${moduleName}" to your package.json dependencies or install it via npm/pnpm before building.`,
      automatedFixCommand: `npm install --save ${moduleName}`,
      confidenceScore: 0.96,
      method: "heuristic",
      detectedPatterns: ["Cannot find module", moduleName],
    };
  }

  // 2. Missing Python dependency
  if (fullLog.includes("ModuleNotFoundError: No module named")) {
    const match = fullLog.match(/ModuleNotFoundError: No module named ['"]([^'"]+)['"]/i);
    const moduleName = match ? match[1] : "python-package";

    return {
      issueCategory: "MISSING_DEPENDENCY",
      severity: "CRITICAL",
      summary: `Missing Python module: "${moduleName}"`,
      rootCause: `Python import failed for module "${moduleName}". Not found in virtual environment.`,
      suggestedSolution: `Add "${moduleName}" to requirements.txt or pyproject.toml.`,
      automatedFixCommand: `echo "${moduleName}" >> requirements.txt`,
      confidenceScore: 0.95,
      method: "heuristic",
      detectedPatterns: ["ModuleNotFoundError", moduleName],
    };
  }

  // 3. Port Binding Issue
  if (
    fullLog.includes("EADDRINUSE") ||
    fullLog.includes("address already in use") ||
    fullLog.includes("listen EACCES 0.0.0.0:80")
  ) {
    return {
      issueCategory: "PORT_BINDING_MISMATCH",
      severity: "HIGH",
      summary: "Port binding conflict or privileged port allocation error",
      rootCause: "The service attempted to bind to a port that is already in use or requires root privileges (<1024).",
      suggestedSolution: "Configure your service to read process.env.PORT (default 3000 or 8080) and bind to 0.0.0.0 instead of localhost.",
      automatedFixCommand: `export PORT=3000 && npm start`,
      confidenceScore: 0.94,
      method: "heuristic",
      detectedPatterns: ["EADDRINUSE", "port conflict"],
    };
  }

  // 4. Missing Environment Variable
  if (
    fullLog.includes("DATABASE_URL is not set") ||
    fullLog.includes("Missing environment variable") ||
    fullLog.includes("NEXTAUTH_SECRET is missing") ||
    fullLog.includes("process.env.")
  ) {
    const match = fullLog.match(/([A-Z0-9_]{3,}) (?:is not set|is missing|is required)/i);
    const varName = match ? match[1] : "DATABASE_URL";

    return {
      issueCategory: "MISSING_ENVIRONMENT_VARIABLE",
      severity: "HIGH",
      summary: `Missing required secret environment variable: ${varName}`,
      rootCause: `Code requires "${varName}" at startup, but it was not provided in the environment variable console.`,
      suggestedSolution: `Navigate to Settings & Variables tab and add "${varName}" or link it using Syncbay's reference syntax \${{ Postgres.URL }}.`,
      automatedFixCommand: `syncbay env set ${varName}="<YOUR_SECRET_VALUE>"`,
      confidenceScore: 0.91,
      method: "heuristic",
      detectedPatterns: ["Missing environment variable", varName],
    };
  }

  // 5. Out of Memory (OOM)
  if (
    fullLog.includes("JavaScript heap out of memory") ||
    fullLog.includes("fatal error: runtime: out of memory") ||
    fullLog.includes("Killed")
  ) {
    return {
      issueCategory: "OUT_OF_MEMORY",
      severity: "CRITICAL",
      summary: "Container process terminated due to Out-Of-Memory (OOM)",
      rootCause: "Memory consumption exceeded the instance allocation limits during compilation or bundling.",
      suggestedSolution: "Upgrade service instance tier from 'lite' (512MB) to 'standard-1' (2GB) or pass NODE_OPTIONS='--max-old-space-size=1536'.",
      automatedFixCommand: `NODE_OPTIONS="--max-old-space-size=1536" npm run build`,
      confidenceScore: 0.98,
      method: "heuristic",
      detectedPatterns: ["JavaScript heap out of memory", "OOM Killer"],
    };
  }

  // 6. TypeScript Compilation Error
  if (fullLog.includes("Type error:") || fullLog.includes("TS2322") || fullLog.includes("TS2339")) {
    const match = fullLog.match(/(Type error:[^\n]+)/i);
    const errSnippet = match ? match[1] : "Type mismatch detected";

    return {
      issueCategory: "TYPESCRIPT_SYNTAX_ERROR",
      severity: "HIGH",
      summary: `TypeScript compilation error: ${errSnippet.slice(0, 60)}...`,
      rootCause: "Strict TypeScript compiler checks failed during the build step.",
      suggestedSolution: "Fix the type mismatch in your code or run 'npx tsc --noEmit' locally to inspect all type errors.",
      automatedFixCommand: `npx tsc --noEmit`,
      confidenceScore: 0.93,
      method: "heuristic",
      detectedPatterns: ["Type error", "TS2322"],
    };
  }

  // Fallback diagnostic
  return {
    issueCategory: "UNKNOWN_RUNTIME_ERROR",
    severity: "MEDIUM",
    summary: "Generic build exit failure detected",
    rootCause: "Process returned a non-zero exit code during execution step.",
    suggestedSolution: "Inspect full build step logs above. Check your repository buildCommand and startCommand.",
    confidenceScore: 0.70,
    method: "heuristic",
    detectedPatterns: ["Process exited with code 1"],
  };
}
