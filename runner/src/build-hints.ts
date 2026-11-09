import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Build toolchain checks for the runner host.
 *
 * Docker CLI 23+ builds with BuildKit, and Nixpacks needs BuildKit (`RUN --mount=type=cache`), so
 * the `docker buildx` CLI plugin must be present. The runner image ships it, the ECS compose file
 * also mounts the host's plugin directory, and as a last resort `ensureBuildx()` installs it into
 * `~/.docker/cli-plugins` at startup. The result is reported on `/health` (`toolchain`).
 */

export const RUNNER_UPDATE_COMMAND =
  "cd /opt/syncbay && git pull && docker compose -f deploy/alibaba-ecs/docker-compose.yml up -d --build";

const BUILDX_VERSION = process.env.RUNNER_BUILDX_VERSION || "0.17.1";
const BUILDX_MISSING = /buildx component is missing|docker: 'buildx' is not a docker command|unknown command "buildx"/i;

export interface ToolchainStatus {
  docker: boolean;
  buildx: string | null; // version line, or null when unavailable
  nixpacks: string | null;
  buildxInstalledByRunner?: boolean;
  checkedAt: string;
}

let toolchain: ToolchainStatus | null = null;
let ensuring: Promise<ToolchainStatus> | null = null;

/** Appends a fix-it hint when a Docker/Nixpacks build failed because the docker buildx plugin is missing. */
export function withBuildToolHint(message: string): string {
  if (!BUILDX_MISSING.test(message)) return message;
  return `${message}\nHint: the runner's Docker CLI has no buildx plugin (BuildKit builds need it). Update the runner image: ${RUNNER_UPDATE_COMMAND}`;
}

function run(cmd: string, args: string[]): Promise<{ ok: boolean; out: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        out: `${stdout || ""}${stderr || ""}`.trim().split("\n")[0] || "",
        missing: (err as NodeJS.ErrnoException | null)?.code === "ENOENT",
      });
    });
  });
}

async function probe(): Promise<ToolchainStatus> {
  const [docker, buildx, nixpacks] = await Promise.all([
    run("docker", ["--version"]),
    run("docker", ["buildx", "version"]),
    run("nixpacks", ["--version"]),
  ]);
  return {
    docker: docker.ok,
    buildx: buildx.ok ? buildx.out : null,
    nixpacks: nixpacks.ok ? nixpacks.out : null,
    checkedAt: new Date().toISOString(),
  };
}

function buildxArch(): string | null {
  switch (process.arch) {
    case "x64":
      return "amd64";
    case "arm64":
      return "arm64";
    default:
      return null;
  }
}

/** Downloads the buildx plugin into ~/.docker/cli-plugins (the per-user plugin dir the CLI always searches). */
async function installBuildx(log: (line: string) => void): Promise<boolean> {
  const arch = buildxArch();
  if (!arch) return false;
  const url = `https://github.com/docker/buildx/releases/download/v${BUILDX_VERSION}/buildx-v${BUILDX_VERSION}.linux-${arch}`;
  const dir = path.join(process.env.DOCKER_CONFIG || path.join(os.homedir(), ".docker"), "cli-plugins");
  const target = path.join(dir, "docker-buildx");
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      // A real plugin is a multi-MB ELF binary; refuse anything else (error pages, truncated bodies).
      if (bytes.length < 1_000_000 || bytes.subarray(0, 4).toString("latin1") !== "\x7fELF") throw new Error("not an ELF binary");
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${target}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, bytes, { mode: 0o755 });
      fs.renameSync(tmp, target);
      return true;
    } catch (err) {
      log(`[runner-daemon] buildx install attempt ${attempt} failed: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
  return false;
}

/**
 * Checks the build toolchain and, when Docker is present but buildx is not, installs buildx.
 * Safe to call repeatedly: concurrent callers share one check, and a working toolchain is cached.
 */
export function ensureBuildx(log: (line: string) => void = console.log): Promise<ToolchainStatus> {
  if (toolchain?.buildx) return Promise.resolve(toolchain);
  if (ensuring) return ensuring;
  ensuring = (async () => {
    let status = await probe();
    if (status.docker && !status.buildx && process.env.RUNNER_AUTO_INSTALL_BUILDX !== "false") {
      log(`[runner-daemon] docker buildx missing; installing v${BUILDX_VERSION} into the Docker CLI plugin directory`);
      if (await installBuildx(log)) {
        status = { ...(await probe()), buildxInstalledByRunner: true };
      }
    }
    if (status.buildx) log(`[runner-daemon] docker buildx: ${status.buildx}`);
    else if (status.docker)
      log(`[runner-daemon] WARNING: buildx plugin missing; Docker/Nixpacks builds will fail. Update the runner image: ${RUNNER_UPDATE_COMMAND}`);
    else log("[runner-daemon] Docker CLI not available; only native builds will run");
    toolchain = status;
    return status;
  })().finally(() => {
    ensuring = null;
  });
  return ensuring;
}

/** Last known toolchain status (null until the startup check finishes). */
export function getToolchainStatus(): ToolchainStatus | null {
  return toolchain;
}
