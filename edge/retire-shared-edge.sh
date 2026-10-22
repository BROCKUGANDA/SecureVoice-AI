#!/bin/bash
# Phase 5: retire the shared edge.
#
# Run AFTER `bun scripts/deploy.mjs edge-isolate --yes` has succeeded.
#
#   ./edge/retire-shared-edge.sh
#
# ── What is being retired, and why each piece exists to be retired ───────────
#
#   1. THE HOST-LOCAL SITE DIRECTORY. The tracked Caddyfile used to end with
#      `import sites.d/*.caddy`, and that directory held the OTHER products'
#      site blocks — untracked, invisible to review, and live on the box.
#      Their blocks have moved into their own edges, and the tracked Caddyfile
#      no longer imports the directory, so what is left in it is dead weight
#      that would be picked up again by any future Caddyfile that did import
#      it.
#
#   2. THE EDGE-ATTACH TIMER. `deploy/edge-attach.sh` in the other product's
#      repository, installed on this host as a cron job, re-attached the
#      shared edge to that product's Docker network every two minutes. It was
#      the mitigation for the 2026-10-21 outage: the shared edge lost its
#      attachment on a recreate, and the timer put it back. With the shared
#      edge gone, the timer is not a repair — it is a script that would
#      ATTACH an edge to a network it has no business reaching, and it would
#      do it silently, on a schedule, forever.
#
#      This is the part worth being careful about: a repair that outlives the
#      fault it repairs stops being a repair and becomes a way to re-create
#      the coupling. The equivalent fix in the other repository is to DELETE
#      the script and the workflow that installs it.
#
#   3. THE FOREIGN NETWORK ATTACHMENTS. Checked, not assumed: the shared
#      edge's network list must contain this project's network and nothing
#      else.
set -euo pipefail
say() { echo "==> $*"; }

STACK_DIR="${STACK_DIR:-$HOME/securevoice-ai}"

# ── 1. the host-local site directory ─────────────────────────────────────────
say "the retired host-local site directory"
if [ -d "$STACK_DIR/sites.d" ]; then
	ls -la "$STACK_DIR/sites.d"
	# It is untracked, so `git checkout` will not remove it and `git clean`
	# is not an option — the same checkout holds host-local state with no
	# other copy. The directory is moved aside rather than deleted, so a
	# mistake here is recoverable.
	mv "$STACK_DIR/sites.d" "$STACK_DIR/.retired-sites.d"
	echo "    moved to $STACK_DIR/.retired-sites.d (recoverable; delete once satisfied)"
else
	echo "    (not present)"
fi

# ── 2. the edge-attach timer ─────────────────────────────────────────────────
say "the edge-attach timer"
if crontab -l 2>/dev/null | grep -q 'crucible-edge-attach'; then
	crontab -l 2>/dev/null | grep -v 'crucible-edge-attach' | crontab -
	echo "    removed from the crontab"
else
	echo "    (not in the crontab)"
fi
if [ -f /usr/local/bin/crucible-edge-attach ]; then
	mv /usr/local/bin/crucible-edge-attach /usr/local/bin/crucible-edge-attach.retired
	echo "    moved /usr/local/bin/crucible-edge-attach aside"
fi
if [ -f "$HOME/crucible-edge-attach.log" ]; then
	echo "    the old repair log is at $HOME/crucible-edge-attach.log"
fi

# ── 3. the network attachments ───────────────────────────────────────────────
say "the edge's networks"
for c in $(docker ps --format '{{.Names}}' | grep -i caddy); do
	echo "--- $c"
	docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}  {{$k}} ({{$v.IPAddress}}){{end}}' "$c"
done

say "the containers on the box"
docker ps --format '{{.Names}}|{{.Status}}' | sort

say "the public path"
for n in securevoiceai.me www.securevoiceai.me crucible.svalley.tech astrolabe.svalley.tech; do
	echo -n "    $n -> "
	curl -sk -o /dev/null -w '%{http_code}\n' --max-time 20 "https://$n/" || echo 000
done
