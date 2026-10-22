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

# The directory the front-door compose will actually MOUNT. Its default is
# relative to the compose file; EDGE_FRAGMENT_DIR overrides it on a box where
# the tables are collected elsewhere. Validating a different directory than
# the one that will be served certifies a table nobody runs.
FRAGMENTS="${EDGE_FRAGMENT_DIR:-$EDGE_DIR/nginx/edge.d}"

for f in "$EDGE_DIR/nginx/edge.conf" "$EDGE_DIR/compose.yml" "$FRAGMENTS"; do
	[ -e "$f" ] || note_problem "$f is missing"
done

# Every edge must be serving its own name, on its own loopback port. An edge
# that is up but not serving is the case that produces a black-holed name
# after the switch.
# Answers for `name` on its own loopback port, and says nothing either way: the
# caller decides whether a miss is a problem, because for our own edge a miss is
# the normal pre-cutover state.
probe_edge() {
	local name="$1" port="$2" code
	# `|| true`: curl exits non-zero when the connection is refused, and under
	# `set -e` an assignment from a failing substitution exits the script
	# instead of recording the 000 the caller is meant to see.
	code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 15 \
		--resolve "$name:$port:127.0.0.1" "https://$name:$port/" 2>/dev/null || true)"
	[ -n "$code" ] || code=000
	printf '%s' "$code"
}

require_edge() {
	local name="$1" port="$2" code
	code="$(probe_edge "$name" "$port")"
	if [ "$code" = "200" ]; then
		echo "    ok   $name on 127.0.0.1:$port -> $code"
	else
		note_problem "$name does not answer on 127.0.0.1:$port (got $code)"
	fi
}

# Will the edge publish this port on the loopback, once it is recreated?
#
# `docker compose config` renders the LONG form of a port mapping — `host_ip`,
# `target`, `published` — so the short syntax this compose file is written in
# (`127.0.0.1:8443:443`) does not survive into the output. A check that
# greps for the short syntax therefore never matches, and the precondition it
# guards is never satisfied: the switch refuses, and reports that the edge
# would not publish the port it is about to publish. The check has to look
# for what compose actually prints.
#
# Both renderings are accepted, so the check does not depend on the compose
# version's output format.
edge_publishes() {
	local port="$1" cfg
	cfg="$(cd "$STACK_DIR" && docker compose config 2>/dev/null || true)"
	printf '%s' "$cfg" | grep -q "127\.0\.0\.1:$port:443" && return 0
	# Compose may print `published: "8443"` or `published: 8443` depending on
	# the version; both are the same mapping.
	printf '%s' "$cfg" |
		grep -A3 'host_ip: 127\.0\.0\.1' |
		grep -Eq "published: \"?$port\"?" && return 0
	return 1
}
require_edge crucible.svalley.tech 8444
require_edge astrolabe.svalley.tech 8445

# Our own edge is the one name whose loopback binding THIS script creates, so it
# cannot be checked the same way. Demanding that securevoiceai.me already answer on
# 127.0.0.1:8443 is a circular precondition: nothing listens there until step 2
# recreates this project's edge, and step 2 runs only if every check has passed. The
# script could therefore never reach its own first action, on any box, ever.
#
# The non-circular question is the one that predicts step 2: is the compose we are
# about to bring up actually going to publish the loopback port the front door's
# table points at? If it is not, step 2 would take the public ports and leave
# nothing behind them — which is the failure the check was always meant to catch.
if [ "$(probe_edge securevoiceai.me 8443)" = "200" ]; then
	echo "    ok   our edge already answers on 127.0.0.1:8443"
elif edge_publishes 8443; then
	code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 15 https://securevoiceai.me/ 2>/dev/null)"
	[ -n "$code" ] || code=000
	if [ "$code" = "200" ]; then
		echo "    ok   our edge holds the public port ($code) and is configured to publish 127.0.0.1:8443 on recreate"
	else
		note_problem "our edge answers neither on 127.0.0.1:8443 nor publicly (got $code) — there is nothing for the front door to route to"
	fi
else
	note_problem "our edge would not publish 127.0.0.1:8443 after recreate. Set CADDY_BIND=127.0.0.1 and CADDY_HTTPS_PORT=8443 in $STACK_DIR/.env first; step 2 would otherwise release :80/:443 with nothing behind them."
fi

# The front door's own configuration, validated with the image it will run.
if docker run --rm \
	-v "$EDGE_DIR/nginx/edge.conf:/etc/nginx/nginx.conf:ro" \
	-v "$EDGE_DIR/nginx/edge.d:/etc/nginx/edge.d:ro" \
	nginx:1.27-alpine nginx -t >/dev/null 2>&1; then
	echo "    ok   the front door's configuration is valid"
else
	note_problem "the front door's configuration does not validate"
fi

# The routing table must be NON-EMPTY, and must name every hostname the
# switch is about to route.
#
# This check exists because of a real failure: the front door's compose file
# pointed at a fragment directory that did not exist, docker created an empty
# one, and nginx's `include` matching ZERO files is perfectly valid — so the
# front door started, the configuration validated, and the routing table was
# EMPTY. Every name was then refused by the fail-closed default, and the
# front door's logs had nothing to say about it.
#
# A validation that passes on an empty table is not a validation.
fragments="$FRAGMENTS"
if [ ! -d "$fragments" ]; then
	note_problem "$fragments does not exist — the front door would start with an empty routing table"
else
	routed="$(cat "$fragments"/*.sni.map 2>/dev/null | grep -vc '^[[:space:]]*\(#.*\)\?$')"
	if [ "${routed:-0}" -eq 0 ]; then
		note_problem "the routing table is EMPTY — the front door would refuse every name"
	else
		echo "    ok   the routing table has $routed entries"
		for name in securevoiceai.me crucible.svalley.tech astrolabe.svalley.tech; do
			if ! grep -q "^$name " "$fragments"/*.sni.map 2>/dev/null; then
				note_problem "$name is not in the routing table — the front door would refuse it"
			fi
		done
	fi
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

# Put the box back the way it was, and say what is still down. `set +e` on
# purpose: every line here has to be attempted, because a rollback that stops
# at its second step leaves the public ports with nothing behind them.
rollback() {
	set +e
	fail "the public path did not come up. Rolling back."
	say "stopping the front door"
	( cd "$EDGE_DIR" && docker compose -f compose.yml down >/dev/null 2>&1 )
	say "putting the shared edge back on the public ports"
	git -C "$STACK_DIR" checkout "$PREV_COMMIT" -- Caddyfile docker-compose.yml
	# Delete the loopback bindings in place. The previous grep-chain could end
	# with an empty .env.bak and still move it over .env.
	for key in CADDY_BIND CADDY_HTTP_PORT CADDY_HTTPS_PORT; do
		sed -i "/^$key=/d" "$STACK_DIR/.env"
	done
	( cd "$STACK_DIR" && docker compose up -d --no-deps caddy )
	sleep 3
	for name in securevoiceai.me www.securevoiceai.me crucible.svalley.tech astrolabe.svalley.tech; do
		code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 20 "https://$name/" 2>/dev/null || echo 000)"
		echo "    after rollback: $name -> $code"
	done
	fail "the switch was rolled back. The box is back on $PREV_COMMIT."
	fail "the front door is DOWN: names owned by the other edges remain unreachable until the switch succeeds."
}

# ── 2. the SecureVoice edge moves to the loopback ───────────────────────────
say "recreating the SecureVoice edge on the loopback (this releases :80 and :443)"
if ! ( cd "$STACK_DIR" && docker compose up -d --no-deps caddy ); then
	fail "could not recreate the SecureVoice edge on the loopback. The public ports have not moved."
	exit 1
fi

# ── 3. the front door takes the public ports ─────────────────────────────────
say "starting the front door"
if ! ( cd "$EDGE_DIR" && docker compose -f compose.yml up -d ); then
	fail "the front door did not start after the edge released the public ports."
	rollback
	exit 1
fi
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
	rollback
	exit 1
fi

say "the switch is done: the front door owns the public ports, and each name is"
say "served by its own edge."
echo
echo "    next: bun scripts/deploy.mjs edge-isolate --yes   (in $STACK_DIR)"
echo "    then: remove the retired sites.d/ directory, and retire the"
echo "          edge-attach timer that repaired the old shared edge."
