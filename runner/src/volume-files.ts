/**
 * Syncbay Runner Agent — read-only access to persistent volumes (Data view)
 *
 * Serves `GET /api/volumes/:id/{stat,files,file}` for runner/src/services.ts.
 *   Docker:  the named volume `syncbay-vol-<id>`. Its mountpoint (`docker volume inspect`) is read
 *            directly when this process can read it; otherwise (rootless/remote Docker, or
 *            RUNNER_VOLUME_ACCESS=container) a short-lived, network-less, read-only helper container
 *            (`RUNNER_VOLUME_HELPER_IMAGE`, default busybox:1.36.1) lists or reads it at /v.
 *   Native:  the bind directory `<RUNNER_STATE_DIR>/volumes/<id>` (see volumes.ts), read directly.
 *
 * Path guard: a client path is relative to the volume root. NUL bytes, backslashes, absolute
 * paths and any `..` segment are refused before anything touches the disk. The resolved real path
 * must stay inside the root, so a symlink that points outside is refused (403); listings report
 * symlinks as `symlink` and never follow them. Opened descriptors are re-checked through
 * /proc/self/fd, so swapping a directory for a symlink between check and open does not escape.
 * Listings stop at 500 entries, file reads at 64 KiB.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { runnerStateDir } from "./native-db.ts";

export const VOLUME_LIST_LIMIT = 500;
export const VOLUME_READ_LIMIT = 64 * 1024;
const MAX_PATH_LENGTH = 4096;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export type VolumeEntryType = "file" | "dir" | "symlink" | "other";

export interface VolumeEntry {
  name: string;
  type: VolumeEntryType;
  size: number;
  /** ISO time of the last modification, null when unknown. */
  mtime: string | null;
}

export interface VolumeListing {
  path: string;
  entries: VolumeEntry[];
  truncated: boolean;
}

export interface VolumeFile {
  path: string;
  size: number;
  mtime: string | null;
  contentBase64: string;
  bytesReturned: number;
  truncated: boolean;
}

/** An answer for the client: `status` becomes the HTTP status, `code` tells "volume" from "path". */
export class VolumeAccessError extends Error {
  // Plain fields, not constructor parameter properties: the runner also runs under Node's
  // type-stripping, which rejects parameter properties.
  readonly status: 400 | 403 | 404 | 409 | 500 | 501;
  readonly code: string;

  constructor(status: 400 | 403 | 404 | 409 | 500 | 501, message: string, code: string) {
    super(message);
    this.name = "VolumeAccessError";
    this.status = status;
    this.code = code;
  }
}

// ─── Pure path guard ─────────────────────────────────────────────────────────

export type VolumePathCheck = { ok: true; rel: string } | { ok: false; reason: string };

/**
 * Validates a client-supplied path inside a volume and returns it normalised (`a/b`, `""` = root).
 * Never resolves anything on disk.
 */
export function normalizeVolumeRelPath(input: unknown): VolumePathCheck {
  if (input === undefined || input === null) return { ok: true, rel: "" };
  if (typeof input !== "string") return { ok: false, reason: "Path must be a string" };
  if (input.length > MAX_PATH_LENGTH) return { ok: false, reason: "Path is too long" };
  if (input.includes("\0")) return { ok: false, reason: "Path contains a NUL byte" };
  if (input.includes("\\")) return { ok: false, reason: "Backslashes are not allowed in volume paths" };
  if (input.startsWith("/") || /^[a-zA-Z]:/.test(input) || input.startsWith("~")) {
    return { ok: false, reason: "Absolute paths are not allowed; use a path relative to the volume root" };
  }
  const segments = input.split("/");
  if (segments.some((s) => s === "..")) return { ok: false, reason: "Path traversal (..) is not allowed" };
  return { ok: true, rel: segments.filter((s) => s !== "" && s !== ".").join("/") };
}

/** True when `candidate` is `root` or lies inside it (both absolute, already resolved). */
export function isWithinRoot(root: string, candidate: string): boolean {
  const base = root.endsWith(path.sep) ? root.slice(0, -1) : root;
  return candidate === base || candidate.startsWith(base + path.sep);
}

function toIso(ms: number): string | null {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function sortEntries(entries: VolumeEntry[]): VolumeEntry[] {
  return entries.sort((a, b) => (a.type === "dir") === (b.type === "dir") ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1);
}

// ─── Direct access (native dirs, readable Docker mountpoints) ────────────────

/** Where an open descriptor really points (Linux), or null when /proc is unavailable. */
function descriptorPath(fd: number): string | null {
  try {
    return fs.readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return null;
  }
}

function resolveInside(root: string, rel: string): { rootReal: string; real: string } {
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(root);
  } catch {
    throw new VolumeAccessError(404, "The volume directory does not exist on this runner", "VOLUME_NOT_FOUND");
  }
  let real: string;
  try {
    real = fs.realpathSync(path.join(rootReal, rel));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new VolumeAccessError(404, `No such file or directory: /${rel}`, "PATH_NOT_FOUND");
    if (code === "ELOOP") throw new VolumeAccessError(403, "Path resolves through a symlink loop", "PATH_ESCAPES");
    throw err;
  }
  if (!isWithinRoot(rootReal, real)) {
    throw new VolumeAccessError(403, "Path points outside the volume (symlink escape refused)", "PATH_ESCAPES");
  }
  return { rootReal, real };
}

function openChecked(real: string, rootReal: string, flags: number): number {
  let fd: number;
  try {
    fd = fs.openSync(real, flags | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new VolumeAccessError(403, "Path changed into a symlink; refused", "PATH_ESCAPES");
    if (code === "ENOENT") throw new VolumeAccessError(404, "No such file or directory", "PATH_NOT_FOUND");
    if (code === "ENOTDIR") throw new VolumeAccessError(409, "Not a directory", "NOT_A_DIRECTORY");
    if (code === "EACCES" || code === "EPERM") throw new VolumeAccessError(403, "The runner may not read this path", "PERMISSION_DENIED");
    throw err;
  }
  const actual = descriptorPath(fd);
  if (actual !== null && !isWithinRoot(rootReal, actual)) {
    fs.closeSync(fd);
    throw new VolumeAccessError(403, "Path points outside the volume (symlink escape refused)", "PATH_ESCAPES");
  }
  return fd;
}

export function listDirectoryDirect(root: string, rel: string, limit: number = VOLUME_LIST_LIMIT): VolumeListing {
  const { rootReal, real } = resolveInside(root, rel);
  if (!fs.statSync(real).isDirectory()) throw new VolumeAccessError(409, `Not a directory: /${rel}`, "NOT_A_DIRECTORY");
  const fd = openChecked(real, rootReal, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
  try {
    // Read through the verified descriptor when /proc is there, so the directory cannot be swapped.
    const dirPath = descriptorPath(fd) !== null ? `/proc/self/fd/${fd}` : real;
    const dir = fs.opendirSync(dirPath);
    const entries: VolumeEntry[] = [];
    let truncated = false;
    try {
      for (let dirent = dir.readSync(); dirent; dirent = dir.readSync()) {
        if (entries.length >= limit) {
          truncated = true;
          break;
        }
        let size = 0;
        let mtime: string | null = null;
        try {
          const st = fs.lstatSync(path.join(dirPath, dirent.name));
          size = st.size;
          mtime = toIso(st.mtimeMs);
        } catch {
          // vanished between readdir and lstat
        }
        const type: VolumeEntryType = dirent.isSymbolicLink() ? "symlink" : dirent.isDirectory() ? "dir" : dirent.isFile() ? "file" : "other";
        entries.push({ name: dirent.name, type, size, mtime });
      }
    } finally {
      dir.closeSync();
    }
    return { path: rel, entries: sortEntries(entries), truncated };
  } finally {
    fs.closeSync(fd);
  }
}

export function readFileDirect(root: string, rel: string, limit: number = VOLUME_READ_LIMIT): VolumeFile {
  if (!rel) throw new VolumeAccessError(409, "The volume root is a directory", "NOT_A_FILE");
  const { rootReal, real } = resolveInside(root, rel);
  // Never open a FIFO or device: opening a FIFO blocks the daemon's event loop until a writer
  // appears, and opening a device can have side effects. O_NONBLOCK covers a swap after this check.
  if (!fs.lstatSync(real).isFile()) throw new VolumeAccessError(409, `Not a regular file: /${rel}`, "NOT_A_FILE");
  const fd = openChecked(real, rootReal, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOCTTY ?? 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new VolumeAccessError(409, `Not a regular file: /${rel}`, "NOT_A_FILE");
    const buf = Buffer.alloc(Math.min(st.size, limit));
    let read = 0;
    while (read < buf.length) {
      const n = fs.readSync(fd, buf, read, buf.length - read, read);
      if (n === 0) break;
      read += n;
    }
    return {
      path: rel,
      size: st.size,
      mtime: toIso(st.mtimeMs),
      contentBase64: buf.subarray(0, read).toString("base64"),
      bytesReturned: read,
      truncated: st.size > read,
    };
  } finally {
    fs.closeSync(fd);
  }
}

// ─── Docker helper container ─────────────────────────────────────────────────

interface BufferResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

function runBuffer(cmd: string, args: string[], timeoutMs: number): Promise<BufferResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "buffer" }, (err, stdout, stderr) => {
      const raw = (err as { code?: unknown } | null)?.code;
      const code = err ? (typeof raw === "number" ? raw : 1) : 0;
      resolve({ code, stdout: stdout || Buffer.alloc(0), stderr: String(stderr || "") || (err ? err.message : "") });
    });
  });
}

/** Shared prologue: resolve `/v/$1` inside the container and refuse anything outside /v. */
const RESOLVE = `t=$(readlink -f -- "/v/$1" 2>/dev/null) || { echo "ERR 404"; exit 0; }
[ -n "$t" ] || { echo "ERR 404"; exit 0; }
case "$t" in /v|/v/*) ;; *) echo "ERR 403"; exit 0;; esac
[ -e "$t" ] || { echo "ERR 404"; exit 0; }`;

const LIST_SCRIPT = `${RESOLVE}
[ -d "$t" ] || { echo "ERR 409"; exit 0; }
cd -- "$t" || { echo "ERR 404"; exit 0; }
echo OK
n=0
for e in * .[!.]* ..?*; do
  [ -e "$e" ] || [ -L "$e" ] || continue
  n=$((n+1)); [ "$n" -gt ${VOLUME_LIST_LIMIT + 1} ] && break
  if [ -L "$e" ]; then k=symlink; elif [ -d "$e" ]; then k=dir; elif [ -f "$e" ]; then k=file; else k=other; fi
  m=$(stat -c '%s %Y' -- "$e" 2>/dev/null || echo "0 0")
  printf '%s %s %s\\n' "$k" "$m" "$(printf '%s' "$e" | base64 | tr -d '\\n')"
done`;

const READ_SCRIPT = `${RESOLVE}
[ "$t" != /v ] || { echo "ERR 409"; exit 0; }
[ -f "$t" ] || { echo "ERR 409"; exit 0; }
printf 'OK %s\\n' "$(stat -c '%s %Y' -- "$t")"
head -c ${VOLUME_READ_LIMIT} -- "$t"`;

const STAT_SCRIPT = `[ -d /v ] || { echo "ERR 404"; exit 0; }
echo "OK $(ls -A /v | head -n ${VOLUME_LIST_LIMIT + 1} | wc -l)"`;

function helperError(status: string, rel: string): VolumeAccessError {
  if (status === "403") return new VolumeAccessError(403, "Path points outside the volume (symlink escape refused)", "PATH_ESCAPES");
  if (status === "409") return new VolumeAccessError(409, `Wrong entry type at /${rel}`, "WRONG_TYPE");
  return new VolumeAccessError(404, `No such file or directory: /${rel}`, "PATH_NOT_FOUND");
}

export type VolumeAccessMode = "auto" | "direct" | "container";
export type VolumeBackend = "docker" | "native";

export interface VolumeBrowserOptions {
  /** Base dir of native volumes; default `<runnerStateDir()>/volumes`. */
  nativeBaseDir?: string;
  access?: VolumeAccessMode;
  helperImage?: string;
}

interface ResolvedVolume {
  backend: VolumeBackend;
  access: "direct" | "container";
  /** Directory read directly (native dir or Docker mountpoint). */
  root?: string;
  dockerVolume?: string;
}

export class VolumeBrowser {
  private readonly nativeBaseDir?: string;
  private readonly access: VolumeAccessMode;
  private readonly helperImage: string;

  constructor(options: VolumeBrowserOptions = {}) {
    this.nativeBaseDir = options.nativeBaseDir;
    const envAccess = process.env.RUNNER_VOLUME_ACCESS as VolumeAccessMode | undefined;
    this.access = options.access || (envAccess && ["auto", "direct", "container"].includes(envAccess) ? envAccess : "auto");
    this.helperImage = options.helperImage || process.env.RUNNER_VOLUME_HELPER_IMAGE?.trim() || "busybox:1.36.1";
  }

  private nativeDir(id: string): string {
    return path.join(this.nativeBaseDir || path.join(runnerStateDir(), "volumes"), id);
  }

  /** Finds the volume: the Docker named volume when it exists, else the native bind dir. */
  private async resolve(id: string): Promise<ResolvedVolume> {
    if (!SAFE_ID.test(id)) throw new VolumeAccessError(400, "Invalid volume id", "INVALID_ID");
    const dockerVolume = `syncbay-vol-${id.toLowerCase()}`;
    const inspect = await runBuffer("docker", ["volume", "inspect", "--format", "{{.Mountpoint}}", dockerVolume], 10000);
    if (inspect.code === 0) {
      const mountpoint = inspect.stdout.toString("utf8").trim();
      if (this.access !== "container" && mountpoint && isReadableDir(mountpoint)) {
        return { backend: "docker", access: "direct", root: mountpoint, dockerVolume };
      }
      if (this.access === "direct") {
        throw new VolumeAccessError(403, "The runner process cannot read the Docker volume's mountpoint (RUNNER_VOLUME_ACCESS=direct)", "PERMISSION_DENIED");
      }
      return { backend: "docker", access: "container", dockerVolume };
    }
    const dir = this.nativeDir(id);
    if (isReadableDir(dir)) return { backend: "native", access: "direct", root: dir };
    throw new VolumeAccessError(
      404,
      "Volume not found on this runner. It is created when a deployment that mounts it starts here.",
      "VOLUME_NOT_FOUND"
    );
  }

  private async helper(dockerVolume: string, script: string, rel: string): Promise<{ status: string; header: string; body: Buffer }> {
    const result = await runBuffer(
      "docker",
      [
        "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--cap-add", "DAC_READ_SEARCH",
        "--security-opt", "no-new-privileges", "--log-driver", "none",
        "-v", `${dockerVolume}:/v:ro`, this.helperImage, "sh", "-c", script, "sh", rel,
      ],
      60000
    );
    if (result.code !== 0) {
      throw new VolumeAccessError(500, `Volume helper container failed: ${result.stderr.trim().slice(0, 300)}`, "HELPER_FAILED");
    }
    const nl = result.stdout.indexOf(0x0a);
    const header = (nl === -1 ? result.stdout : result.stdout.subarray(0, nl)).toString("utf8").trim();
    const body = nl === -1 ? Buffer.alloc(0) : result.stdout.subarray(nl + 1);
    const [status, ...rest] = header.split(" ");
    return { status: status === "OK" ? "OK" : rest[0] || "404", header: rest.join(" "), body };
  }

  async stat(id: string): Promise<{ id: string; backend: VolumeBackend; access: "direct" | "container"; entries: number; truncated: boolean }> {
    const vol = await this.resolve(id);
    if (vol.access === "direct") {
      const listing = listDirectoryDirect(vol.root!, "");
      return { id, backend: vol.backend, access: "direct", entries: listing.entries.length, truncated: listing.truncated };
    }
    const out = await this.helper(vol.dockerVolume!, STAT_SCRIPT, "");
    if (out.status !== "OK") throw helperError(out.status, "");
    const count = Number(out.header) || 0;
    return { id, backend: vol.backend, access: "container", entries: Math.min(count, VOLUME_LIST_LIMIT), truncated: count > VOLUME_LIST_LIMIT };
  }

  async list(id: string, rawPath: unknown): Promise<VolumeListing & { backend: VolumeBackend; access: "direct" | "container" }> {
    const checked = normalizeVolumeRelPath(rawPath);
    if (!checked.ok) throw new VolumeAccessError(400, checked.reason, "INVALID_PATH");
    const vol = await this.resolve(id);
    if (vol.access === "direct") return { ...listDirectoryDirect(vol.root!, checked.rel), backend: vol.backend, access: "direct" };

    const out = await this.helper(vol.dockerVolume!, LIST_SCRIPT, checked.rel);
    if (out.status !== "OK") throw helperError(out.status, checked.rel);
    const entries: VolumeEntry[] = [];
    let truncated = false;
    for (const line of out.body.toString("utf8").split("\n")) {
      const [type, size, mtime, name64] = line.trim().split(" ");
      if (!type || !name64) continue;
      if (entries.length >= VOLUME_LIST_LIMIT) {
        truncated = true;
        break;
      }
      entries.push({
        name: Buffer.from(name64, "base64").toString("utf8"),
        type: (["file", "dir", "symlink"].includes(type) ? type : "other") as VolumeEntryType,
        size: Number(size) || 0,
        mtime: toIso(Number(mtime) * 1000),
      });
    }
    return { path: checked.rel, entries: sortEntries(entries), truncated, backend: vol.backend, access: "container" };
  }

  async read(id: string, rawPath: unknown): Promise<VolumeFile & { backend: VolumeBackend; access: "direct" | "container" }> {
    const checked = normalizeVolumeRelPath(rawPath);
    if (!checked.ok) throw new VolumeAccessError(400, checked.reason, "INVALID_PATH");
    if (!checked.rel) throw new VolumeAccessError(409, "The volume root is a directory", "NOT_A_FILE");
    const vol = await this.resolve(id);
    if (vol.access === "direct") return { ...readFileDirect(vol.root!, checked.rel), backend: vol.backend, access: "direct" };

    const out = await this.helper(vol.dockerVolume!, READ_SCRIPT, checked.rel);
    if (out.status !== "OK") throw helperError(out.status, checked.rel);
    const [size, mtime] = out.header.split(" ").map(Number);
    const body = out.body.subarray(0, VOLUME_READ_LIMIT);
    return {
      path: checked.rel,
      size: size || body.length,
      mtime: toIso(mtime * 1000),
      contentBase64: body.toString("base64"),
      bytesReturned: body.length,
      truncated: (size || 0) > body.length,
      backend: vol.backend,
      access: "container",
    };
  }
}

function isReadableDir(dir: string): boolean {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
