/**
 * Strips credentials from text before it is logged or persisted. Mirrors `runner/src/redact.ts`.
 * Covers URL userinfo (`https://x-access-token:<token>@github.com/…`, `postgres://user:pass@host`)
 * and bare GitHub tokens (`gho_…`, `ghp_…`, `ghs_…`, `ghu_…`, `ghr_…`, `github_pat_…`).
 */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:'"]+:[^\s/@'"]+@/gi;
const GITHUB_TOKEN = /\b(gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

export function redactSecrets(text: string): string {
  if (!text) return text;
  return text.replace(URL_USERINFO, "$1***@").replace(GITHUB_TOKEN, "***");
}
