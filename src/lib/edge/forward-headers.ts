/**
 * Request headers for traffic the edge forwards to a customer app.
 *
 * The Syncbay session cookie is scoped to `.syncbay.app` so the wake button works on service
 * hosts, which means browsers also send it to every `*.syncbay.app` app. The edge must remove it
 * (and every other NextAuth cookie) before forwarding, or a customer app would receive the
 * session tokens of the people who visit it — staff included.
 */

const PLATFORM_COOKIE = /^(?:__Secure-|__Host-)?(?:next-auth\.|authjs\.)|^sb_staff/i;

/** Removes platform auth cookies from a `Cookie` header; returns null when nothing is left. */
export function stripPlatformCookies(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const kept = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !PLATFORM_COOKIE.test(part.split("=")[0].trim()));
  return kept.length > 0 ? kept.join("; ") : null;
}

/** Applies `stripPlatformCookies` to a Headers object in place. */
export function sanitizeForwardedHeaders(headers: Headers): Headers {
  const cookie = stripPlatformCookies(headers.get("cookie"));
  if (cookie) headers.set("cookie", cookie);
  else headers.delete("cookie");
  return headers;
}
