#!/usr/bin/env bash
# Boot the built app and probe the feature flags against it, in one shot.
#
# Long-running servers started in a separate tool call do not survive in this
# environment (the process is orphaned and never accepts connections), so the
# boot and the probe have to share a single invocation. The realtime service
# proved this: started standalone it never bound its port; started here it
# answered 200 immediately.
#
# Usage: bash tests/run-live-flag-probe.sh
set -uo pipefail

cd "$(dirname "$0")/.."
# Absolute bun path: nested shells here can lose PATH, which silently no-ops.
BUN="/c/Users/HP/.bun/bin/bun"
PORT="${PROBE_PORT:-3171}"
# TMPDIR is often unset in this env; LOCALAPPDATA/Temp is the real temp dir.
LOG="${TMPDIR:-$LOCALAPPDATA/Temp}/svprobe-$PORT.log"

cleanup() {
  [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null
  wait "${SRV_PID:-}" 2>/dev/null
  return 0
}
trap cleanup EXIT

# A concurrent `bun run build` wipes .next, so the bundle can vanish between
# the two cases and fail with MODULE_NOT_FOUND instead of a real result.
SERVER_JS=".next/standalone/server.js"

boot() {
  local realtime="$1" feed="$2" secret="$3"
  cleanup
  if [ ! -f "$SERVER_JS" ]; then
    echo "  $SERVER_JS missing - run `bun run build` first" >&2
    return 1
  fi
  # Generous budgets: the edge limiter in src/proxy.ts is 600/hour by default and
  # would otherwise rate-limit the probe itself into a 429.
  # Hostname matters: Next's standalone server binds IPv4 but proxies some work
  # internally through `localhost`, which on this host resolves to ::1 first —
  # so binding 0.0.0.0 while requesting `localhost` produced ECONNREFUSED on
  # every route. `127.0.0.1` is used throughout instead.
  PORT="$PORT" HOSTNAME=127.0.0.1 \
    EDGE_RATE_LIMIT_PER_HOUR=1000000 RATE_LIMIT_PER_HOUR=1000000 \
    FEATURE_REALTIME="$realtime" FEATURE_CONSOLE_LIVE_FEED="$feed" \
    REALTIME_INGEST_SECRET="$secret" \
    node "$SERVER_JS" > "$LOG" 2>&1 &
  SRV_PID=$!
  for _ in $(seq 1 40); do
    sleep 2
    local code
    # Force IPv4 and bypass any proxy: this host resolves `localhost` to ::1
    # first, which the IPv4-bound standalone server never answers on.
    code=$(curl -4 --noproxy '*' -s -o /dev/null -w "%{http_code}" --max-time 6 "http://127.0.0.1:$PORT/api/status" || true)
    if [ "$code" != "000" ] && [ -n "$code" ]; then return 0; fi
  done
  echo "server on :$PORT never became ready; log:" >&2
  tail -20 "$LOG" >&2
  return 1
}

rc=0

echo "=== CASE 1: FEATURE_REALTIME=false, FEATURE_CONSOLE_LIVE_FEED=false ==="
if boot false false ""; then
  EXPECT_LIVE_FEED=false PROBE_BASE="http://127.0.0.1:$PORT" "$BUN" tests/live-flag-probe.ts || rc=1
else
  rc=1
fi

echo
echo "=== CASE 2: FEATURE_REALTIME=true, FEATURE_CONSOLE_LIVE_FEED=true, secret set ==="
if boot true true "probe-secret-not-real-but-consistent"; then
  EXPECT_LIVE_FEED=true PROBE_BASE="http://127.0.0.1:$PORT" "$BUN" tests/live-flag-probe.ts || rc=1
else
  rc=1
fi

echo
if [ "$rc" -eq 0 ]; then echo "LIVE FLAG PROBE: ALL CASES PASSED"; else echo "LIVE FLAG PROBE: FAILURES ABOVE"; fi
exit "$rc"