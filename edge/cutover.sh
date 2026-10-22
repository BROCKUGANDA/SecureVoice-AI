#!/bin/bash
# THE CUTOVER. Run once, on the box, after the edge split is on `main`.
#
#   ./edge/cutover.sh
#
# ── What it does, and why it is one script ────────────────────────────────────
#
# It sets the host's edge bindings and then runs the switch, back to back,
# with NOTHING in between.
#
# The bindings have to be set before the switch, because the switch's step 2
# is the recreate that publishes them. But setting them is not free of risk on
# its own: with CADDY_BIND=127.0.0.1 in the .env, ANY `docker compose up
# ... caddy` — a deploy, a restart, an operator's hand — would move the edge
# to the loopback and leave the public :80 and :443 with nothing behind them.
#
# So the two happen together, here, with no window between them. If the
# switch fails, its own rollback removes the bindings and puts the edge back
# on the public ports.
#
# ── Preconditions, all of which must hold BEFORE anything is changed ────────
#
#   · the box's checkout is on `main`, and `main` has the edge split
#   · the other two products' edges are up and serving their own names
#   · the front door's configuration validates with the image it will run
#   · the front door is installed with every project's routing table
set -euo pipefail
say() { echo "==> $*"; }

STACK_DIR="${STACK_DIR:-$HOME/securevoice-ai}"
EDGE_DIR="${EDGE_DIR:-$HOME/edge}"
ENV_FILE="$STACK_DIR/.env"

# ── 0. the box must be on the code that has the split ──────────────────────
say "the box's checkout"
cd "$STACK_DIR"
git fetch --quiet origin main
git checkout --quiet main
git pull --quiet --ff-only origin main
git log --oneline -1
if ! grep -q 'CADDY_BIND' docker-compose.yml; then
	echo "    this checkout does not have the edge split (no CADDY_BIND in docker-compose.yml)" >&2
	echo "    the switch needs the compose that publishes the edge on the loopback." >&2
	exit 1
fi
echo "    ok   the checkout has the edge split"

# ── 1. the front door must be installed and valid ───────────────────────────
say "the front door"
[ -f "$EDGE_DIR/nginx/edge.conf" ] || { echo "    $EDGE_DIR/nginx/edge.conf is missing" >&2; exit 1; }
[ -f "$EDGE_DIR/compose.yml" ] || { echo "    $EDGE_DIR/compose.yml is missing" >&2; exit 1; }
ls "$EDGE_DIR/nginx/edge.d/"
if docker run --rm \
	-v "$EDGE_DIR/nginx/edge.conf:/etc/nginx/nginx.conf:ro" \
	-v "$EDGE_DIR/nginx/edge.d:/etc/nginx/edge.d:ro" \
	nginx:1.27-alpine nginx -t >/dev/null 2>&1; then
	echo "    ok   the front door's configuration is valid"
else
	echo "    the front door's configuration does not validate" >&2
	exit 1
fi

# ── 2. the edge's loopback bindings ─────────────────────────────────────────
# The edge moves to the loopback, and the front door takes the public ports.
# The values are the ones the routing table names: 8443 for TLS, 8080 for the
# plaintext path that carries the ACME challenge and the redirect.
say "setting the edge's loopback bindings in $ENV_FILE"
cp "$ENV_FILE" "$ENV_FILE.pre-cutover" 2>/dev/null || true
for kv in "CADDY_BIND=127.0.0.1" "CADDY_HTTP_PORT=8080" "CADDY_HTTPS_PORT=8443"; do
	key="${kv%%=*}"
	if grep -q "^$key=" "$ENV_FILE" 2>/dev/null; then
		sed -i "s|^$key=.*|$kv|" "$ENV_FILE"
	else
		printf '%s\n' "$kv" >>"$ENV_FILE"
	fi
	echo "    $kv"
done

# ── 3. the switch, immediately, with nothing in between ─────────────────────
say "running the switch"
cd "$STACK_DIR"
sh "$STACK_DIR/edge/switch.sh"
rc=$?

if [ "$rc" != "0" ]; then
	say "the switch failed; restoring the edge's public bindings"
	[ -f "$ENV_FILE.pre-cutover" ] && mv "$ENV_FILE.pre-cutover" "$ENV_FILE"
	echo "    the .env has been restored to $ENV_FILE.pre-cutover"
	exit "$rc"
fi

say "done"
echo
echo "    next: bun scripts/deploy.mjs edge-isolate --yes"
echo "    then: ./edge/retire-shared-edge.sh"
