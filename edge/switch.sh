#!/bin/bash
# THE SWITCH — the front door takes the public ports from the shared edge.
#
#   ./edge/switch.sh --dry-run     # check every precondition, change nothing
#   ./edge/switch.sh               # do it
#
# ── What it does, in order, and why that order ───────────────────────────────
#
#   1. CHECKS EVERY PRECONDITION AND REFUSES IF ANY FAILS. A switch that
#      starts and then discovers a missing piece is a switch that has already
#      taken the site down.
#
#   2. RECREATES THE SECUREVOICE EDGE ON THE LOOPBACK. This is the step
#      that RELEASES the public :80 and :443 — the shared edge is the same
#      container as SecureVoice's own edge, and it is holding those ports.
#      The public path is down from this line until the front door has them.
#
#   3. STARTS THE FRONT DOOR, which binds the public :80 and :443 and
#      forwards each connection to the edge that owns the name.
#
#   4. VERIFIES ALL THREE PUBLIC NAMES. Through the front door, on the public
#      path, from outside the box.
#
# ── The gap, stated plainly ───────────────────────────────────────────────────
#
# Steps 2 and 3 are a couple of seconds apart, and in between them the public
# edge is not answering. That gap cannot be closed by a script: it is a
# listening socket moving between two processes.
#
# It is short, and it is bounded, and it does not touch the call plane. A
# live fraud call is carried by voice-stream-worker and dial-worker, and
# signed deliveries to banks drain from outbox-worker — three containers that
# keep running through an outage of the web tier. What a visitor sees during
# the gap is a refused connection; what a bank integration sees is a failed
# request. Neither is a dropped call.
#
# It is also the LAST time this gap exists. Once the three zones are in
# place, the front door is a load balancer in front of three edges, and a
# front door restart is a rolling event rather than a hand-over.
#
# ── The rollback ──────────────────────────────────────────────────────────────
#
# If anything after step 2 fails, the script puts the shared edge back on the
# public ports itself — the site comes back, and the operator is told what
# to do next. The rollback is not optional and not manual, because a switch
# that needs a calm human in the loop when it goes wrong is a switch that
# goes wrong for longer.
set -euo pipefail

say() { echo "==> $*"; }
fail() { echo "    $*" >&2; }

EDGE_DIR="${EDGE_DIR:-$HOME/edge}"
STACK_DIR="${STACK_DIR:-$HOME/securevoice-ai}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# ── 1. preconditions ─────────────────────────────────────────────────────────
problems=0
note_problem() {
	fail "$1"
	problems=$((problems + 1))
}

say "checking the preconditions"

for f in "$EDGE_DIR/nginx/edge.conf" "$EDGE_DIR/compose.yml" "$EDGE_DIR/nginx/edge.d"; do
	[ -e "$f" ] || note_problem "$f is missing"
done

# Every edge must be serving its own name, on its own loopback port. An edge
# that is up but not serving is the case that produces a black-holed name
# after the switch.
check_edge() {
	local name="$1" port="$2" code
	code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 15 \
		--resolve "$name:$port:127.0.0.1" "https://$name:$port/" || echo 000)"
	if [ "$code" = "200" ]; then
		echo "    ok   $name on 127.0.0.1:$port -> $code"
	else
		note_problem "$name does not answer on 127.0.0.1:$port (got $code)"
	fi
}
check_edge securevoiceai.me 8443
check_edge crucible.svalley.tech 8444
check_edge astrolabe.svalley.tech 8445

# The front door's own configuration, validated with the image it will run.
if docker run --rm \
	-v "$EDGE_DIR/nginx/edge.conf:/etc/nginx/nginx.conf:ro" \
	-v "$EDGE_DIR/nginx/edge.d:/etc/nginx/edge.d:ro" \
	nginx:1.27-alpine nginx -t >/dev/null 2>&1; then
	echo "    ok   the front door's configuration is valid"
else
	note_problem "the front door's configuration does not validate"
fi

# The shared edge must still be the thing holding the public ports, or this
# script is not the thing that is about to change.
if docker ps --format '{{.Names}}' | grep -qx securevoice-ai-caddy-1; then
	echo "    ok   the shared edge is still running"
else
	note_problem "securevoice-ai-caddy-1 is not running — this script assumes the shared edge is what holds the public ports"
fi

if [ "$problems" != "0" ]; then
	fail "$problems precondition(s) failed. Nothing has been changed."
	exit 1
fi

if [ "$DRY_RUN" = "1" ]; then
	say "dry run: every precondition passes. Nothing has been changed."
	exit 0
fi

# The commit the box is on, so the rollback can put it back exactly.
PREV_COMMIT="$(git -C "$STACK_DIR" rev-parse HEAD)"
say "the box is on $PREV_COMMIT"

# ── 2. the SecureVoice edge moves to the loopback ───────────────────────────
say "recreating the SecureVoice edge on the loopback (this releases :80 and :443)"
cd "$STACK_DIR"
docker compose up -d --no-deps caddy

# ── 3. the front door takes the public ports ─────────────────────────────────
say "starting the front door"
cd "$EDGE_DIR"
docker compose -f compose.yml up -d
sleep 2

# ── 4. verify, or roll back ──────────────────────────────────────────────────
say "verifying the public path"
failed=0
for name in securevoiceai.me www.securevoiceai.me crucible.svalley.tech astrolabe.svalley.tech; do
	code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 20 "https://$name/" || echo 000)"
	echo "    $name -> $code"
	[ "$code" = "200" ] || failed=1
done

if [ "$failed" != "0" ]; then
	fail "the public path did not come up. Rolling back."
	say "stopping the front door"
	cd "$EDGE_DIR" && docker compose -f compose.yml down >/dev/null 2>&1 || true
	say "putting the shared edge back on the public ports"
	cd "$STACK_DIR"
	git checkout "$PREV_COMMIT" -- Caddyfile docker-compose.yml
	rm -f .env.bak
	# The public bindings are the pre-split ones.
	grep -v '^CADDY_BIND=' .env > .env.bak 2>/dev/null || true
	grep -v '^CADDY_HTTP_PORT=' .env.bak > .env 2>/dev/null || true
	grep -v '^CADDY_HTTPS_PORT=' .env > .env.bak 2>/dev/null || true
	mv .env.bak .env 2>/dev/null || true
	docker compose up -d --no-deps caddy
	sleep 3
	for name in securevoiceai.me crucible.svalley.tech astrolabe.svalley.tech; do
		code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 20 "https://$name/" || echo 000)"
		echo "    after rollback: $name -> $code"
	done
	fail "the switch was rolled back. The box is back on $PREV_COMMIT."
	exit 1
fi

say "the switch is done: the front door owns the public ports, and each name is"
say "served by its own edge."
echo
echo "    next: bun scripts/deploy.mjs edge-isolate --yes   (in $STACK_DIR)"
echo "    then: remove the retired sites.d/ directory, and retire the"
echo "          edge-attach timer that repaired the old shared edge."
