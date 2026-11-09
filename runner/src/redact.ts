/**
 * Removes credentials from text before it is logged or returned to the control plane:
 * userinfo in URLs (https://x-access-token:TOKEN@github.com/...) and bare GitHub tokens.
 */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:'"]+:[^\s/@'"]+@/gi;
const GITHUB_TOKEN = /\b(gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

export function redactSecrets(text: string): string {
  if (!text) return text;
  return text.replace(URL_USERINFO, "$1***@").replace(GITHUB_TOKEN, "***");
}
