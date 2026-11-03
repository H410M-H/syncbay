/**
 * Syncbay PaaS — Web terminal session store.
 *
 * Two modes:
 * - "runner":   a real shell on the Syncbay runner (`docker exec -i <container> sh` or `sh`
 *               in the job workspace), proxied over HMAC-signed HTTP + SSE.
 * - "fallback": no runner configured / reachable. Commands go through the simulated
 *               `executeShellCommand`, with a per-session cwd, env (`export`) and history.
 *
 * All output is masked: values of `isSecret` variables and credentials embedded in URLs.
 * Sessions live in process memory and close after 10 minutes without activity.
 */

import { executeShellCommand, getPrompt, type ShellSessionState } from "@/lib/shell/web-shell";
import { runnerFetch, runnerJson } from "@/lib/runner-client";

export type TerminalEvent =
  | { type: "output"; data: string }
  | { type: "meta"; cwd: string; mode: TerminalMode }
  | { type: "exit"; code: number | null };

type TerminalMode = "runner" | "fallback";

export interface TerminalSession {
  id: string;
  serviceId: string;
  userId: string;
  mode: TerminalMode;
  runnerSessionId?: string;
  state: ShellSessionState;
  history: string[];
  secrets: string[];
  buffer: string;
  listeners: Set<(event: TerminalEvent) => void>;
  lastActivity: number;
}

export interface TerminalVariable {
  key: string;
  value: string;
  isSecret: boolean;
}

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 64 * 1024;
const MAX_HISTORY = 200;

const globalStore = globalThis as unknown as { __syncbayTerminalSessions?: Map<string, TerminalSession> };
const sessions: Map<string, TerminalSession> = (globalStore.__syncbayTerminalSessions ??= new Map());

/** Masks secret values and URL credentials (scheme://user:password@host → scheme://user:****@host). */
export function maskTerminalOutput(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("••••••••");
  }
  return out.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:)([^\s@/]+)@/gi, "$1****@");
}

function sweepIdleSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > IDLE_TIMEOUT_MS) {
      emit(session, { type: "output", data: "\r\n[syncbay] session closed after 10 min idle\r\n" });
      emit(session, { type: "exit", code: null });
      void closeTerminalSession(id);
    }
  }
}

function emit(session: TerminalSession, event: TerminalEvent): void {
  if (event.type === "output") {
    session.buffer = (session.buffer + event.data).slice(-MAX_BUFFER);
  }
  for (const listener of session.listeners) {
    try {
      listener(event);
    } catch {}
  }
}

function secretValues(variables: TerminalVariable[]): string[] {
  return variables.filter((v) => v.isSecret && v.value).map((v) => v.value);
}

export function createTerminalSession(params: {
  serviceId: string;
  userId: string;
  serviceName: string;
  containerId: string;
  variables: TerminalVariable[];
  runnerSessionId?: string;
  notice?: string;
}): TerminalSession {
  sweepIdleSessions();
  const env: Record<string, string> = {};
  for (const v of params.variables) env[v.key] = v.value;

  const session: TerminalSession = {
    id: `tsess_${crypto.randomUUID()}`,
    serviceId: params.serviceId,
    userId: params.userId,
    mode: params.runnerSessionId ? "runner" : "fallback",
    runnerSessionId: params.runnerSessionId,
    state: { cwd: "/app", env, serviceName: params.serviceName, containerId: params.containerId },
    history: [],
    secrets: secretValues(params.variables),
    buffer: "",
    listeners: new Set(),
    lastActivity: Date.now(),
  };
  sessions.set(session.id, session);

  if (session.mode === "fallback") {
    const banner =
      `\x1b[38;5;51m== SYNCBAY WEB SHELL ==\x1b[0m\n` +
      (params.notice ? `\x1b[38;5;208m${params.notice}\x1b[0m\n` : "") +
      `Simulated container shell for \x1b[38;5;46m${params.serviceName}\x1b[0m. Type '\x1b[38;5;220mhelp\x1b[0m' for commands.\n`;
    emit(session, { type: "output", data: banner + getPrompt(params.serviceName, session.state.cwd) });
  }
  return session;
}

/** Returns the session only if it belongs to this user and service. */
export function getTerminalSession(id: string, userId: string, serviceId: string): TerminalSession | null {
  sweepIdleSessions();
  const session = sessions.get(id);
  if (!session || session.userId !== userId || session.serviceId !== serviceId) return null;
  return session;
}

export function subscribeTerminal(session: TerminalSession, listener: (event: TerminalEvent) => void): () => void {
  session.listeners.add(listener);
  return () => session.listeners.delete(listener);
}

function expandVariables(line: string, env: Record<string, string>): string {
  return line.replace(/\$\{(\w+)\}|\$(\w+)/g, (_m, a, b) => env[a || b] ?? "");
}

function runFallbackLine(session: TerminalSession, line: string): string {
  const { state } = session;
  const trimmed = line.trim();
  if (!trimmed) return "";

  const exportMatch = trimmed.match(/^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (exportMatch) {
    state.env[exportMatch[1]] = expandVariables(exportMatch[2].replace(/^(['"])(.*)\1$/, "$2"), state.env);
    return "";
  }
  if (/^unset\s+/.test(trimmed)) {
    for (const key of trimmed.split(/\s+/).slice(1)) delete state.env[key];
    return "";
  }
  if (trimmed === "history") {
    return session.history.map((cmd, i) => `${String(i + 1).padStart(5)}  ${cmd}`).join("\n") + "\n";
  }
  if (/^echo(\s|$)/.test(trimmed)) {
    return expandVariables(trimmed.slice(4).trim().replace(/^(['"])(.*)\1$/, "$2"), state.env) + "\n";
  }

  const result = executeShellCommand(trimmed, state);
  state.cwd = result.cwd;
  return result.stdout + result.stderr;
}

/** Feeds input into a session; complete lines are executed (fallback) or forwarded (runner). */
export async function writeTerminalInput(session: TerminalSession, input: string): Promise<void> {
  session.lastActivity = Date.now();
  for (const line of input.split(/\r?\n/)) {
    const cmd = line.trim();
    if (cmd) {
      session.history.push(cmd);
      if (session.history.length > MAX_HISTORY) session.history.shift();
    }
  }

  if (session.mode === "runner" && session.runnerSessionId) {
    await runnerJson(`/api/terminals/${encodeURIComponent(session.runnerSessionId)}/input`, {
      method: "POST",
      body: { input },
      timeoutMs: 15000,
    });
    return;
  }

  const lines = input.replace(/\r?\n$/, "").split(/\r?\n/);
  for (const line of lines) {
    let output = `${line}\n`;
    if (line.includes("\x03")) {
      output = "^C\n";
    } else if (line.trim() === "clear") {
      output = "\x1b[2J\x1b[H";
    } else {
      output += runFallbackLine(session, line);
    }
    output += getPrompt(session.state.serviceName, session.state.cwd);
    emit(session, { type: "output", data: maskTerminalOutput(output, session.secrets) });
  }
  emit(session, { type: "meta", cwd: session.state.cwd, mode: session.mode });
}

/**
 * Pipes the runner's SSE terminal stream into `send`, masking output. Resolves when the
 * runner stream ends or `signal` aborts.
 */
export async function pipeRunnerTerminal(
  session: TerminalSession,
  send: (event: TerminalEvent) => void,
  signal: AbortSignal
): Promise<void> {
  if (!session.runnerSessionId) return;
  const res = await runnerFetch(`/api/terminals/${encodeURIComponent(session.runnerSessionId)}/stream`, {
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
    session.lastActivity = Date.now();
    pending += decoder.decode(value, { stream: true });
    const frames = pending.split("\n\n");
    pending = frames.pop() || "";
    for (const frame of frames) {
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      try {
        const event = JSON.parse(dataLine.slice(6));
        if (event.type === "output" && typeof event.data === "string") {
          send({ type: "output", data: maskTerminalOutput(event.data, session.secrets) });
        } else if (event.type === "exit") {
          send({ type: "exit", code: typeof event.code === "number" ? event.code : null });
        }
      } catch {}
    }
  }
}

export async function closeTerminalSession(id: string): Promise<void> {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  session.listeners.clear();
  if (session.mode === "runner" && session.runnerSessionId) {
    await runnerJson(`/api/terminals/${encodeURIComponent(session.runnerSessionId)}`, {
      method: "DELETE",
      timeoutMs: 10000,
    }).catch(() => null);
  }
}
