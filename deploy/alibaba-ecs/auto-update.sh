#!/bin/sh
# Syncbay runner auto-updater (runs in the `updater` service of docker-compose.yml).
#
# Every RUNNER_AUTO_UPDATE_INTERVAL seconds (default 600) it fetches RUNNER_AUTO_UPDATE_BRANCH
# (default main) in the server's checkout. When the new commits change runner/ or
# deploy/alibaba-ecs/, it fast-forwards and rebuilds the runner and caddy services. Running apps
# and databases are separate containers and keep running. The outcome is written to
# /state/update-status.json, which the runner reports on /health ("update").
# Set RUNNER_AUTO_UPDATE=false in deploy/alibaba-ecs/.env to turn it off.
set -u

REPO="${SYNCBAY_REPO_DIR:-/opt/syncbay}"
BRANCH="${RUNNER_AUTO_UPDATE_BRANCH:-main}"
INTERVAL="${RUNNER_AUTO_UPDATE_INTERVAL:-600}"
STATUS_DIR="${RUNNER_AUTO_UPDATE_STATUS_DIR:-/state}"
COMPOSE_FILE="$REPO/deploy/alibaba-ecs/docker-compose.yml"

status() {
  # result, commit, message (quotes, backslashes and newlines stripped so the JSON stays valid)
  msg=$(printf '%s' "$3" | tr -d '"\\' | tr '\n\r\t' '   ' | cut -c1-400)
  printf '{"checkedAt":"%s","result":"%s","commit":"%s","branch":"%s","message":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$BRANCH" "$msg" > "$STATUS_DIR/update-status.json.tmp" \
    && mv "$STATUS_DIR/update-status.json.tmp" "$STATUS_DIR/update-status.json"
  echo "[auto-update] $1 ${2:-} $msg"
}

if [ "${RUNNER_AUTO_UPDATE:-true}" = "false" ]; then
  status disabled "" "RUNNER_AUTO_UPDATE=false"
  exec sleep infinity
fi

command -v git >/dev/null 2>&1 || apk add --no-cache git >/dev/null 2>&1 || { status error "" "git is not available"; exec sleep infinity; }
git config --global --add safe.directory "$REPO"

while true; do
  if ! cd "$REPO" 2>/dev/null; then
    status error "" "repository not found at $REPO (set SYNCBAY_REPO_DIR)"
  elif ! git fetch --quiet origin "$BRANCH" 2>/tmp/fetch.err; then
    status error "$(git rev-parse --short HEAD 2>/dev/null)" "git fetch failed: $(cat /tmp/fetch.err)"
  else
    LOCAL=$(git rev-parse HEAD)
    REMOTE=$(git rev-parse "origin/$BRANCH")
    NEED_BUILD=0
    # A previous build failed: keep retrying until the running runner matches the checkout.
    [ -f "$STATUS_DIR/rebuild-pending" ] && NEED_BUILD=1
    if [ "$LOCAL" != "$REMOTE" ]; then
      if ! git merge --ff-only --quiet "origin/$BRANCH" 2>/tmp/merge.err; then
        status error "$(git rev-parse --short HEAD)" "cannot fast-forward (local changes in $REPO?): $(cat /tmp/merge.err)"
        [ "${RUNNER_AUTO_UPDATE_ONCE:-}" = "1" ] && exit 0
        sleep "$INTERVAL"
        continue
      fi
      git diff --quiet "$LOCAL" "$REMOTE" -- runner deploy/alibaba-ecs || NEED_BUILD=1
    fi
    if [ "$NEED_BUILD" = "0" ]; then
      status up-to-date "$(git rev-parse --short HEAD)" "$([ "$LOCAL" != "$REMOTE" ] && echo 'pulled; no runner changes')"
    elif docker compose -f "$COMPOSE_FILE" up -d --build runner caddy >/tmp/update.log 2>&1; then
      rm -f "$STATUS_DIR/rebuild-pending"
      status updated "$(git rev-parse --short HEAD)" "runner rebuilt and restarted"
    else
      touch "$STATUS_DIR/rebuild-pending"
      status build-failed "$(git rev-parse --short HEAD)" "$(tail -c 400 /tmp/update.log)"
    fi
  fi
  [ "${RUNNER_AUTO_UPDATE_ONCE:-}" = "1" ] && exit 0
  sleep "$INTERVAL"
done
