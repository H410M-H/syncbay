/**
 * Syncbay PaaS — Web terminal sessions (stateless control plane).
 *
 * Two modes:
 * - "runner":   a real shell on the Syncbay runner (`docker exec -i <container> sh` or `sh`
 *               in the job workspace), proxied over HMAC-signed HTTP + SSE.
 * - "fallback": no runner configured / reachable. Commands go through the simulated
 *               `executeShellCommand`, with a per-session cwd, env (`export`) and history.
 *
 * Nothing lives in process memory. The client's `sessionId` is a signed token
 * (`terminal-token.ts`: {sid, mode, runnerSessionId, serviceId, userId, exp}), so any
 * instance can verify it and proxy to the runner. Fallback state (cwd, env overrides,
 * history, masked output buffer) is a `TerminalSession` row; the SSE stream polls it, so
 * input handled by one instance shows up on a stream held by another.
 *
 * All output is masked: values of `isSecret` variables and credentials embedded in URLs.
 * Fallback sessions close after 10 minutes without input; runner shells use the runner's
 * own idle timer.
 */

import { db } from "@/lib/db";
import { executeShellCommand, getPrompt, type ShellSessionState } from "@/lib/shell/web-shell";
import { runnerFetch, runnerJson } from "@/lib/runner-client";
import { signTerminalToken, verifyTerminalToken, type TerminalMode, type TerminalTokenClaims } from "@/lib/shell/terminal-token";

export type TerminalEvent =
  | { type: "output"; data: string }
  | { type: "meta"; cwd: string; mode: TerminalMode }
  | { type: "exit"; code: number | null };

export interface TerminalVariable {
  key: string;
  value: string;
  isSecret: boolean;
}

/** Per-request context, rebuilt from the DB by the route on every call. */
export interface TerminalContext {
  serviceId: string;
  userId: string;
  serviceName: string;
  containerId: string;
  variables: TerminalVariable[];
}

export interface TerminalHandle {
  sessionId: string;
  claims: TerminalTokenClaims;
  context: TerminalContext;
  mode: TerminalMode;
  cwd: string;
}

type EnvOverrides = Record<string, string | null>;

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 64 * 1024;
const MAX_HISTORY = 200;
const MAX_WRITE_RETRIES = 8;
const DEFAULT_POLL_MS = 300;

/** Masks secret values and URL credentials (scheme://user:password@host → scheme://user:****@host). */
export function maskTerminalOutput(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("••••••••");
  }
  return out.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:)([^\s@/]+)@/gi, "$1****@");
}

function secretValues(variables: TerminalVariable[]): string[] {
  return variables.filter((v) => v.isSecret && v.value).map((v) => v.value);
}

function buildEnv(variables: TerminalVariable[], overrides: EnvOverrides): Record<string, string> {
  const env: Record<string, string> = {};
  for (const v of variables) env[v.key] = v.value;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}

function asOverrides(value: unknown): EnvOverrides {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as EnvOverrides) : {};
}

function asHistory(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

async function sweepIdleSessions(): Promise<void> {
  await db.terminalSession
    .deleteMany({ where: { lastActivityAt: { lt: new Date(Date.now() - IDLE_TIMEOUT_MS) } } })
    .catch(() => null);
}

/**
 * Opens a session. With `runnerSessionId` the token alone carries the session; otherwise a
 * fallback row is created with the banner and first prompt in its buffer.
 */
export async function createTerminalSession(
  params: TerminalContext & { runnerSessionId?: string; notice?: string }
): Promise<{ sessionId: string; mode: TerminalMode; cwd: string }> {
  const sid = `tsess_${crypto.randomUUID()}`;
  const mode: TerminalMode = params.runnerSessionId ? "runner" : "fallback";
  const cwd = "/app";

  if (mode === "fallback") {
    await sweepIdleSessions();
    const banner =
      `\x1b[38;5;51m== SYNCBAY WEB SHELL ==\x1b[0m\n` +
      (params.notice ? `\x1b[38;5;208m${params.notice}\x1b[0m\n` : "") +
      `Simulated container shell for \x1b[38;5;46m${params.serviceName}\x1b[0m. Type '\x1b[38;5;220mhelp\x1b[0m' for commands.\n`;
    const buffer = maskTerminalOutput(banner + getPrompt(params.serviceName, cwd), secretValues(params.variables));
    await db.terminalSession.create({
      data: {
        id: sid,
        serviceId: params.serviceId,
        userId: params.userId,
        cwd,
        envOverrides: {},
        history: [],
        buffer,
        outputSeq: buffer.length,
      },
    });
  }

  const sessionId = signTerminalToken({
    sid,
    mode,
    runnerSessionId: params.runnerSessionId,
    serviceId: params.serviceId,
    userId: params.userId,
  });
  return { sessionId, mode, cwd };
}

/**
 * Verifies the token against this user and service. Fallback sessions must still have a
 * live (non-idle) row. Returns null for anything else (the route answers 404).
 */
export async function openTerminalSession(sessionId: string, context: TerminalContext): Promise<TerminalHandle | null> {
  const claims = verifyTerminalToken(sessionId, { userId: context.userId, serviceId: context.serviceId });
  if (!claims) return null;
  if (claims.mode === "runner") {
    return { sessionId, claims, context, mode: "runner", cwd: "/app" };
  }

  const row = await db.terminalSession.findUnique({ where: { id: claims.sid } });
  if (!row || row.userId !== context.userId || row.serviceId !== context.serviceId) return null;
  if (Date.now() - row.lastActivityAt.getTime() > IDLE_TIMEOUT_MS) {
    await db.terminalSession.deleteMany({ where: { id: row.id } }).catch(() => null);
    return null;
  }
  return { sessionId, claims, context, mode: "fallback", cwd: row.cwd };
}

function expandVariables(line: string, env: Record<string, string>): string {
  return line.replace(/\$\{(\w+)\}|\$(\w+)/g, (_m, a, b) => env[a || b] ?? "");
}

function runFallbackLine(state: ShellSessionState, overrides: EnvOverrides, history: string[], line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "";

  const exportMatch = trimmed.match(/^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (exportMatch) {
    const value = expandVariables(exportMatch[2].replace(/^(['"])(.*)\1$/, "$2"), state.env);
    state.env[exportMatch[1]] = value;
    overrides[exportMatch[1]] = value;
    return "";
  }
  if (/^unset\s+/.test(trimmed)) {
    for (const key of trimmed.split(/\s+/).slice(1)) {
      delete state.env[key];
      overrides[key] = null;
    }
    return "";
  }
  if (trimmed === "history") {
    return history.map((cmd, i) => `${String(i + 1).padStart(5)}  ${cmd}`).join("\n") + "\n";
  }
  if (/^echo(\s|$)/.test(trimmed)) {
    return expandVariables(trimmed.slice(4).trim().replace(/^(['"])(.*)\1$/, "$2"), state.env) + "\n";
  }

  const result = executeShellCommand(trimmed, state);
  state.cwd = result.cwd;
  return result.stdout + result.stderr;
}

/**
 * Feeds input into a session; complete lines are executed (fallback) or forwarded (runner).
 * Fallback writes use optimistic concurrency on `version`, so concurrent input handled by
 * different instances is applied in some serial order and never lost.
 */
export async function writeTerminalInput(handle: TerminalHandle, input: string): Promise<{ cwd: string }> {
  if (handle.mode === "runner") {
    await runnerJson(`/api/terminals/${encodeURIComponent(handle.claims.runnerSessionId!)}/input`, {
      method: "POST",
      body: { input },
      timeoutMs: 15000,
    });
    return { cwd: handle.cwd };
  }

  const { context } = handle;
  const secrets = secretValues(context.variables);
  for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt += 1) {
    const row = await db.terminalSession.findUnique({ where: { id: handle.claims.sid } });
    if (!row) throw new Error("Terminal session closed");

    const overrides = { ...asOverrides(row.envOverrides) };
    const history = asHistory(row.history);
    const state: ShellSessionState = {
      cwd: row.cwd,
      env: buildEnv(context.variables, overrides),
      serviceName: context.serviceName,
      containerId: context.containerId,
    };

    for (const line of input.split(/\r?\n/)) {
      const cmd = line.trim();
      if (cmd) history.push(cmd);
    }
    while (history.length > MAX_HISTORY) history.shift();

    let output = "";
    for (const line of input.replace(/\r?\n$/, "").split(/\r?\n/)) {
      let chunk = `${line}\n`;
      if (line.includes("\x03")) {
        chunk = "^C\n";
      } else if (line.trim() === "clear") {
        chunk = "\x1b[2J\x1b[H";
      } else {
        chunk += runFallbackLine(state, overrides, history, line);
      }
      output += chunk + getPrompt(context.serviceName, state.cwd);
    }
    output = maskTerminalOutput(output, secrets);

    const updated = await db.terminalSession.updateMany({
      where: { id: row.id, version: row.version },
      data: {
        cwd: state.cwd,
        envOverrides: overrides,
        history,
        buffer: (row.buffer + output).slice(-MAX_BUFFER),
        outputSeq: row.outputSeq + output.length,
        version: row.version + 1,
        lastActivityAt: new Date(),
      },
    });
    if (updated.count === 1) {
      handle.cwd = state.cwd;
      return { cwd: state.cwd };
    }
  }
  throw new Error("Terminal session is busy; retry");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Streams a session into `send` until it ends or `signal` aborts.
 * - runner: pipes the runner's SSE stream (the runner replays its own buffer first).
 * - fallback: replays the stored buffer, then polls the row and sends new output and cwd
 *   changes, whichever instance wrote them.
 */
export async function streamTerminal(
  handle: TerminalHandle,
  send: (event: TerminalEvent) => void,
  signal: AbortSignal,
  pollMs: number = DEFAULT_POLL_MS
): Promise<void> {
  send({ type: "meta", cwd: handle.cwd, mode: handle.mode });
  if (handle.mode === "runner") {
    await pipeRunnerTerminal(handle, send, signal);
    return;
  }

  const id = handle.claims.sid;
  const first = await db.terminalSession.findUnique({ where: { id }, select: { buffer: true, outputSeq: true, cwd: true } });
  if (!first) {
    send({ type: "exit", code: null });
    return;
  }
  if (first.buffer) send({ type: "output", data: first.buffer });
  let seq = first.outputSeq;
  let cwd = first.cwd;

  while (!signal.aborted) {
    await sleep(pollMs, signal);
    if (signal.aborted) break;
    const head = await db.terminalSession.findUnique({
      where: { id },
      select: { outputSeq: true, cwd: true, lastActivityAt: true },
    });
    if (!head) {
      send({ type: "output", data: "\r\n[syncbay] session closed\r\n" });
      send({ type: "exit", code: null });
      return;
    }
    if (Date.now() - head.lastActivityAt.getTime() > IDLE_TIMEOUT_MS) {
      await db.terminalSession.deleteMany({ where: { id } }).catch(() => null);
      send({ type: "output", data: "\r\n[syncbay] session closed after 10 min idle\r\n" });
      send({ type: "exit", code: null });
      return;
    }
    if (head.outputSeq > seq) {
      const body = await db.terminalSession.findUnique({ where: { id }, select: { buffer: true, outputSeq: true } });
      if (body && body.outputSeq > seq) {
        const delta = body.outputSeq - seq;
        send({ type: "output", data: delta >= body.buffer.length ? body.buffer : body.buffer.slice(-delta) });
        seq = body.outputSeq;
      }
    }
    if (head.cwd !== cwd) {
      cwd = head.cwd;
      send({ type: "meta", cwd, mode: "fallback" });
    }
  }
}

/**
 * Pipes the runner's SSE terminal stream into `send`, masking output. Resolves when the
 * runner stream ends or `signal` aborts.
 */
async function pipeRunnerTerminal(
  handle: TerminalHandle,
  send: (event: TerminalEvent) => void,
  signal: AbortSignal
): Promise<void> {
  const runnerSessionId = handle.claims.runnerSessionId;
  if (!runnerSessionId) return;
  const secrets = secretValues(handle.context.variables);
  const res = await runnerFetch(`/api/terminals/${encodeURIComponent(runnerSessionId)}/stream`, {
    method: "GET",
    signal,
  });
  if (!res.ok || !res.body) {
    send({ type: "output", data: `\r\n[syncbay] runner terminal stream unavailable (HTTP ${res.status})\r\n` });
    send({ type: "exit", code: null });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const frames = pending.split("\n\n");
    pending = frames.pop() || "";
    for (const frame of frames) {
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      try {
        const event = JSON.parse(dataLine.slice(6));
        if (event.type === "output" && typeof event.data === "string") {
          send({ type: "output", data: maskTerminalOutput(event.data, secrets) });
        } else if (event.type === "exit") {
          send({ type: "exit", code: typeof event.code === "number" ? event.code : null });
        }
      } catch {}
    }
  }
}

export async function closeTerminalSession(handle: TerminalHandle): Promise<void> {
  if (handle.mode === "runner") {
    await runnerJson(`/api/terminals/${encodeURIComponent(handle.claims.runnerSessionId!)}`, {
      method: "DELETE",
      timeoutMs: 10000,
    }).catch(() => null);
    return;
  }
  await db.terminalSession.deleteMany({ where: { id: handle.claims.sid } }).catch(() => null);
}
