import { execFile } from "node:child_process";

/**
 * Actionable hints for build failures caused by the runner host's toolchain rather than the app.
 */

export const RUNNER_UPDATE_COMMAND =
  "cd /opt/syncbay && git pull && docker compose -f deploy/alibaba-ecs/docker-compose.yml up -d --build";

const BUILDX_MISSING = /buildx component is missing|docker: 'buildx' is not a docker command|unknown command "buildx"/i;

/** Appends a fix-it hint when a Docker/Nixpacks build failed because the docker buildx plugin is missing. */
export function withBuildToolHint(message: string): string {
  if (!BUILDX_MISSING.test(message)) return message;
  return `${message}\nHint: the runner's Docker CLI has no buildx plugin (BuildKit builds need it). Update the runner image: ${RUNNER_UPDATE_COMMAND}`;
}

/** Logs once at startup whether `docker buildx` is usable, so a broken image shows up in the runner logs. */
export function logBuildToolchain(log: (line: string) => void = console.log): void {
  execFile("docker", ["buildx", "version"], { timeout: 5000 }, (err, stdout) => {
    if (!err) return log(`[runner-daemon] docker buildx: ${String(stdout).trim()}`);
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT" ? "docker CLI not found" : "buildx plugin missing";
    log(`[runner-daemon] WARNING: ${missing}; Docker/Nixpacks builds will fail. Update the runner image: ${RUNNER_UPDATE_COMMAND}`);
  });
}
