-- Data-only migration: scrub credentials that older runners and engines wrote into
-- deployment logs and error messages (for example the GitHub token embedded in
-- "git clone https://x-access-token:<token>@github.com/..."). New lines are redacted
-- at write time (src/lib/telemetry/redact.ts, runner/src/redact.ts). No schema change.

UPDATE "deployment_logs"
SET "line" = regexp_replace(
      regexp_replace("line", '([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@[:space:]:''"]+:[^/@[:space:]''"]+@', '\1***@', 'g'),
      '(gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})', '***', 'g')
WHERE "line" ~ '://[^/@[:space:]]+:[^/@[:space:]]+@|gh[opsur]_[A-Za-z0-9]{20,}|github_pat_';

UPDATE "deployments"
SET "errorMessage" = regexp_replace(
      regexp_replace("errorMessage", '([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@[:space:]:''"]+:[^/@[:space:]''"]+@', '\1***@', 'g'),
      '(gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})', '***', 'g')
WHERE "errorMessage" ~ '://[^/@[:space:]]+:[^/@[:space:]]+@|gh[opsur]_[A-Za-z0-9]{20,}|github_pat_';

UPDATE "deployment_jobs"
SET "errorMessage" = regexp_replace(
      regexp_replace("errorMessage", '([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@[:space:]:''"]+:[^/@[:space:]''"]+@', '\1***@', 'g'),
      '(gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})', '***', 'g')
WHERE "errorMessage" ~ '://[^/@[:space:]]+:[^/@[:space:]]+@|gh[opsur]_[A-Za-z0-9]{20,}|github_pat_';
