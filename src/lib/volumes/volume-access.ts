/**
 * Syncbay — read-only volume access through the runner (Data view).
 *
 * Volumes live on the runner that runs the service (Docker volume `syncbay-vol-<id>` or the bind
 * dir `<state>/volumes/<id>`), so every call is a signed GET to the runner
 * (`/api/volumes/:id/{stat,files,file}`, runner/src/services.ts + volume-files.ts). The runner
 * owns the path guard; errors keep its HTTP status and `code` so the router can map them.
 */

import { getRunnerBaseUrl, runnerFetch } from "@/lib/runner-client";

export const NO_RUNNER_MESSAGE = "Volumes live on a runner; none is configured.";
const NO_RUNNER_HINT = "Set RUNNER_URL and RUNNER_SECRET on Syncbay to the runner that hosts this service.";
const OUTDATED_HINT = "This runner does not serve volume browsing yet: the runner needs updating. Update the runner on the host and try again.";

export class VolumeRunnerError extends Error {
  constructor(
    /** HTTP status from the runner, 0 when there was no answer. */
    readonly status: number,
    message: string,
    readonly code: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = "VolumeRunnerError";
  }
}

export interface RunnerVolumeEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  mtime: string | null;
}

interface RunnerVolumeStat {
  backend: "docker" | "native";
  access: "direct" | "container";
  entries: number;
  truncated: boolean;
}

interface RunnerVolumeListing {
  path: string;
  entries: RunnerVolumeEntry[];
  truncated: boolean;
  backend: "docker" | "native";
}

interface RunnerVolumeFile {
  path: string;
  size: number;
  mtime: string | null;
  contentBase64: string;
  bytesReturned: number;
  truncated: boolean;
}

/** A field every successful answer of the current runner carries, per route. */
const SHAPE_KEY = { stat: "backend", files: "entries", file: "contentBase64" } as const;

async function volumeGet<T>(volumeId: string, action: "stat" | "files" | "file", relPath?: string): Promise<T> {
  if (!getRunnerBaseUrl()) throw new VolumeRunnerError(0, NO_RUNNER_MESSAGE, "NO_RUNNER", NO_RUNNER_HINT);
  const query = relPath !== undefined ? `?${new URLSearchParams({ path: relPath })}` : "";
  let res: Response;
  try {
    res = await runnerFetch(`/api/volumes/${encodeURIComponent(volumeId)}/${action}${query}`, { method: "GET", timeoutMs: 70_000 });
  } catch (err) {
    throw new VolumeRunnerError(0, `The runner did not answer: ${(err as Error)?.message || "network error"}`, "RUNNER_UNREACHABLE", "Check that the runner is online (Analytics shows its status).");
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  let isJson = false;
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
      isJson = true;
    }
  } catch {
    data = {};
  }
  // A runner that predates these routes has no handler for them: it answers its generic
  // `404 {"error":"Route not found"}` (no `code`), or, while exactly one app runs on it, proxies
  // the request to that app (any status, usually not our JSON). Current runners always send a
  // `code` with errors and the expected fields with successes.
  if (res.ok) {
    if (isJson && SHAPE_KEY[action] in data) return data as T;
    throw new VolumeRunnerError(502, "The runner answered this volume request with an unexpected response", "RUNNER_OUTDATED", OUTDATED_HINT);
  }
  const code = isJson && typeof data.code === "string" ? data.code : "";
  if (!code && res.status !== 401 && (res.status === 404 || !isJson)) {
    throw new VolumeRunnerError(res.status, "The runner has no volume routes", "RUNNER_OUTDATED", OUTDATED_HINT);
  }
  const message = typeof data.error === "string" ? data.error : `Runner answered HTTP ${res.status}`;
  if (res.status === 401) {
    throw new VolumeRunnerError(401, "The runner rejected Syncbay's signature", "RUNNER_AUTH", "RUNNER_SECRET on Syncbay must match the runner's RUNNER_SECRET.");
  }
  const hint =
    code === "VOLUME_NOT_FOUND"
      ? "The volume is created on the runner when a deployment that mounts it starts. Deploy the service first."
      : code === "PATH_ESCAPES"
      ? "Only paths inside the volume can be opened; symlinks pointing outside it are refused."
      : undefined;
  throw new VolumeRunnerError(res.status, message, code || `HTTP_${res.status}`, hint);
}

export function statVolume(volumeId: string): Promise<RunnerVolumeStat> {
  return volumeGet<RunnerVolumeStat>(volumeId, "stat");
}

export function listVolumeFiles(volumeId: string, relPath: string): Promise<RunnerVolumeListing> {
  return volumeGet<RunnerVolumeListing>(volumeId, "files", relPath);
}

export function readVolumeFile(volumeId: string, relPath: string): Promise<RunnerVolumeFile> {
  return volumeGet<RunnerVolumeFile>(volumeId, "file", relPath);
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  pdf: "application/pdf", zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
  json: "application/json", txt: "text/plain", md: "text/markdown", csv: "text/csv", html: "text/html", log: "text/plain",
  sqlite: "application/vnd.sqlite3", db: "application/octet-stream", wasm: "application/wasm", mp4: "video/mp4", mp3: "audio/mpeg",
};

function mimeFor(name: string): string {
  const ext = name.toLowerCase().split(".").pop() || "";
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

export type VolumePreview =
  | { kind: "text"; path: string; size: number; mtime: string | null; text: string; truncated: boolean }
  | { kind: "binary"; path: string; size: number; mtime: string | null; mimeType: string; truncated: boolean };

/**
 * Text when the bytes are valid UTF-8 without NUL bytes (a multi-byte character cut at the
 * 64 KiB limit is tolerated), otherwise binary: size and type only, the bytes are not returned.
 */
export function toVolumePreview(file: RunnerVolumeFile): VolumePreview {
  const bytes = Buffer.from(file.contentBase64 || "", "base64");
  const base = { path: file.path, size: file.size, mtime: file.mtime, truncated: file.truncated };
  const sample = bytes.subarray(0, 8192);
  if (sample.includes(0)) return { kind: "binary", ...base, mimeType: mimeFor(file.path) };
  // Drop at most 3 trailing bytes of a character the size limit cut in half.
  let end = bytes.length;
  if (file.truncated) {
    for (let back = 1; back <= 3 && end - back >= 0; back++) {
      const b = bytes[end - back];
      if ((b & 0xc0) === 0xc0) {
        const needed = (b & 0xf0) === 0xf0 ? 4 : (b & 0xe0) === 0xe0 ? 3 : 2;
        if (back < needed) end -= back; // incomplete sequence at the cut
        break;
      }
      if ((b & 0x80) === 0) break;
    }
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
    return { kind: "text", ...base, text };
  } catch {
    return { kind: "binary", ...base, mimeType: mimeFor(file.path) };
  }
}
