/**
 * Syncbay PaaS — Signed runner HTTP client for managed databases & terminals.
 * Uses the driver's canonical `${ts}.${nonce}.${METHOD}.${path}.${payload}` signature: POST payload
 * is the raw body, GET/DELETE payload is the request pathname (matches runner/src/services.ts).
 * Every call gets a fresh `X-Syncbay-Nonce`, which the runner accepts only once.
 */

import { resolveRunnerSecret, signRequest } from "@/lib/orchestrator/runner-driver";

export function getRunnerBaseUrl(): string | null {
  const raw = process.env.RUNNER_URL?.trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw)
    ? raw
    : /^(localhost|127\.|0\.0\.0\.0)/.test(raw)
    ? `http://${raw}`
    : `https://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

export async function runnerFetch(
  pathname: string,
  init: { method?: "GET" | "POST" | "DELETE"; body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<Response> {
  const base = getRunnerBaseUrl();
  if (!base) throw new Error("RUNNER_URL is not configured");

  const method = init.method || (init.body !== undefined ? "POST" : "GET");
  const bodyStr = method === "POST" ? JSON.stringify(init.body ?? {}) : undefined;
  const { headers: signedHeaders } = signRequest(resolveRunnerSecret(), method, pathname, bodyStr ?? pathname);

  const controller = new AbortController();
  const timer = init.timeoutMs ? setTimeout(() => controller.abort(), init.timeoutMs) : null;
  init.signal?.addEventListener("abort", () => controller.abort(), { once: true });

  try {
    return await fetch(`${base}${pathname}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...signedHeaders,
      },
      body: bodyStr,
      signal: controller.signal,
      cache: "no-store",
    });
  } finally {
    // Streaming callers pass no timeout, so the timer only bounds request/response calls.
    if (timer) clearTimeout(timer);
  }
}

export async function runnerJson<T = any>(
  pathname: string,
  init: Parameters<typeof runnerFetch>[1] = {}
): Promise<T> {
  const res = await runnerFetch(pathname, { timeoutMs: 30000, ...init });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 200) };
  }
  if (!res.ok) {
    throw new Error(`Runner ${init.method || "GET"} ${pathname} failed (HTTP ${res.status}): ${data.error || "unknown error"}`);
  }
  return data as T;
}
