/**
 * Syncbay PaaS — NextAuth session-cookie scoping.
 *
 * Service hosts (`<svc>-<env>.syncbay.app`) are siblings of the dashboard host, so a
 * host-only session cookie never reaches them and the splash page's wake button gets 401.
 * In production the session cookie is scoped to `AUTH_COOKIE_DOMAIN`:
 * - set → that domain (e.g. `.syncbay.app`); `none` / `off` disables scoping;
 * - unset → `.syncbay.app` when NEXTAUTH_URL is on syncbay.app, otherwise host-only
 *   (a `.syncbay.app` cookie on a `*.vercel.app` preview would be rejected by the browser).
 * Outside production the NextAuth defaults are kept.
 */

import type { CookiesOptions } from "next-auth";

const PLATFORM_DOMAIN = "syncbay.app";

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The cookie domain to use, or null for host-only cookies. */
export function resolveAuthCookieDomain(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NODE_ENV !== "production") return null;
  const explicit = env.AUTH_COOKIE_DOMAIN?.trim().toLowerCase();
  if (explicit) {
    if (explicit === "none" || explicit === "off") return null;
    return explicit.startsWith(".") ? explicit : `.${explicit}`;
  }
  const host = hostOf(env.NEXTAUTH_URL);
  if (host && (host === PLATFORM_DOMAIN || host.endsWith(`.${PLATFORM_DOMAIN}`))) return `.${PLATFORM_DOMAIN}`;
  return null;
}

/** `authOptions.cookies` override: the session token scoped to the cookie domain, secure, lax. */
export function buildAuthCookies(env: NodeJS.ProcessEnv = process.env): Partial<CookiesOptions> | undefined {
  const domain = resolveAuthCookieDomain(env);
  if (!domain) return undefined;
  return {
    sessionToken: {
      name: "__Secure-next-auth.session-token",
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: true, domain },
    },
  };
}
