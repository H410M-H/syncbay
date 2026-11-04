/**
 * Syncbay PaaS — Signed web-terminal session tokens.
 *
 * The control plane keeps no terminal state in memory. `POST /api/services/:id/terminal`
 * returns this token as `sessionId`; every input/stream/close call verifies it, so any
 * instance can serve any session.
 *
 * Format: `sbt1.<base64url(JSON claims)>.<base64url(HMAC-SHA256(secret, "sbt1." + payload))>`
 * Secret: `TERMINAL_TOKEN_SECRET`. Production refuses to mint or verify without it; dev
 * falls back to a key derived from `NEXTAUTH_SECRET` (or a fixed dev default).
 */

import crypto from "node:crypto";

export type TerminalMode = "runner" | "fallback";

export interface TerminalTokenClaims {
  v: 1;
  /** Control-plane session id (`tsess_…`); the TerminalSession row id in fallback mode. */
  sid: string;
  mode: TerminalMode;
  runnerSessionId?: string;
  serviceId: string;
  userId: string;
  /** Expiry, ms since the epoch. */
  exp: number;
}

const PREFIX = "sbt1";
/** Absolute token lifetime; idle sessions are closed sooner (runner idle timer / row sweep). */
export const TERMINAL_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

export class TerminalTokenConfigError extends Error {}

export function resolveTerminalTokenSecret(): string {
  const secret = process.env.TERMINAL_TOKEN_SECRET?.trim();
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new TerminalTokenConfigError("TERMINAL_TOKEN_SECRET is not configured; web terminal is disabled");
  }
  return crypto
    .createHash("sha256")
    .update(`syncbay-dev-terminal:${process.env.NEXTAUTH_SECRET || "dev"}`)
    .digest("hex");
}

function mac(secret: string, data: string): Buffer {
  return crypto.createHmac("sha256", secret).update(data).digest();
}

export function signTerminalToken(
  claims: Omit<TerminalTokenClaims, "v" | "exp"> & { exp?: number },
  secret: string = resolveTerminalTokenSecret()
): string {
  const full: TerminalTokenClaims = { v: 1, ...claims, exp: claims.exp ?? Date.now() + TERMINAL_TOKEN_TTL_MS };
  const payload = Buffer.from(JSON.stringify(full)).toString("base64url");
  return `${PREFIX}.${payload}.${mac(secret, `${PREFIX}.${payload}`).toString("base64url")}`;
}

/**
 * Returns the claims when the token is authentic, unexpired and bound to this user and
 * service; otherwise null.
 */
export function verifyTerminalToken(
  token: string,
  expected: { userId: string; serviceId: string },
  secret: string = resolveTerminalTokenSecret(),
  now: number = Date.now()
): TerminalTokenClaims | null {
  if (typeof token !== "string" || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, payload, sig] = parts;

  const provided = Buffer.from(sig, "base64url");
  const wanted = mac(secret, `${PREFIX}.${payload}`);
  if (provided.length !== wanted.length || !crypto.timingSafeEqual(provided, wanted)) return null;

  let claims: TerminalTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (claims?.v !== 1 || typeof claims.exp !== "number" || claims.exp <= now) return null;
  if (claims.userId !== expected.userId || claims.serviceId !== expected.serviceId) return null;
  if (claims.mode !== "runner" && claims.mode !== "fallback") return null;
  if (claims.mode === "runner" && !claims.runnerSessionId) return null;
  return claims;
}
