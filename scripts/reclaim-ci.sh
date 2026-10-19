#!/usr/bin/env bash
#
# scripts/reclaim-ci.sh — the one place CI garbage is defined.
#
# WHY A SCRIPT AND NOT FOUR COPIES IN FOUR WORKFLOWS. Until 2026-10-19 this repo
# had three inline reclaim loops (compose-smoke pre-build, the `cleanup` job, and
# deploy's pre-build step) and they had DRIFTED: two reclaimed images, one
# reclaimed volumes, none reclaimed networks except at teardown, and every one of
# them selected by `grep '^svci-'`. That last filter is what let 30 GB accumulate —
# an anonymous Docker volume is a 64-char hex digest with no name, so a name filter
# cannot see it, and `postgres:16-alpine` declares `VOLUME /var/lib/postgresql/data`
# so the verify job's throwaway database minted one per run and `docker rm -f` left
# it behind. The box hit 100% three times in four days and each failure looked like
# a broken tree, because the only place a full disk says so is the runner's own
# diagnostic log. Divergent copies of "clean up" is the bug class; this is the one
# copy.
#
# WHAT IT WILL NEVER TOUCH, and each guard is enforced rather than promised:
#   * volumes and images that ANY container references — including a CI job
#     currently running on the other runner, and production's `securevoice-ai_*`
#     volumes attached to its running containers.
#   * named volumes outside `svci-`/`sv-ci-`, so `securevoice-ai_db-data`,
#     `crucible_deployed` and anything a human made by hand are not candidates.
#   * anonymous volumes younger than 24 h. A run that finished five minutes ago is
#     not garbage, and neither is a volume someone is debugging on this box.
#   * build cache younger than 72 h, because the same runner builds the production
#     image and wiping that cache makes the next deploy a full rebuild.
#
# Modes:
#   reclaim            delete what qualifies, print what was deleted (default)
#   dry-run            print what WOULD be deleted, delete nothing
#
# Measuring whether the disk is fit to build on is NOT this file's job — that is
# `scripts/runner-preflight.ts`, which reports free space, free inodes and a real
# 4 MiB fdatasync latency, and is wired into both the compose smoke job and the
# deploy. An earlier draft of this script carried a `check` mode with its own copy
# of those thresholds; two capacity thresholds in one repository is how the three
# divergent reclaim loops happened in the first place, so it was deleted rather than
# reconciled.
#
# Configuration (all optional):
#   TARGET_DIR         the repo whose compose project is cleaned, and the
#                      filesystem reported afterwards; default the current directory
#   ANON_MIN_AGE_H     anonymous-volume age floor, default 24
#   CACHE_MAX_AGE      passed to `docker builder prune --filter until=`, default 72h
set -uo pipefail

MODE="${1:-reclaim}"
case "$MODE" in reclaim | dry-run) ;; *)
  echo "usage: $0 [reclaim|dry-run]" >&2
  exit 2
  ;;
esac

TARGET_DIR="${TARGET_DIR:-$PWD}"
ANON_MIN_AGE_H="${ANON_MIN_AGE_H:-24}"
CACHE_MAX_AGE="${CACHE_MAX_AGE:-72h}"

now_epoch=$(date -u +%s)
# Only `reclaim` deletes; `dry-run` reports what it would take and touches nothing.
DELETE=0
SHOW_WOULD=0
[ "$MODE" = "reclaim" ] && DELETE=1
[ "$MODE" = "dry-run" ] && SHOW_WOULD=1
do_it="$DELETE"
removed_volumes=0
removed_named=0
removed_images=0
removed_networks=0
removed_containers=0
held_back=0

run() {
  if [ "$do_it" = "1" ]; then
    "$@" >/dev/null 2>&1
  else
    [ "$SHOW_WOULD" = "1" ] && echo "would: $*"
    return 0
  fi
}

# A name is only a candidate if this workflow family owns it.
is_ci_named() {
  case "$1" in
    svci-* | sv-ci-*) return 0 ;;
    *) return 1 ;;
    esac
}

referenced_by_container() {
  [ -n "$(docker ps -a --filter "volume=$1" --format '{{.Names}}' 2>/dev/null)" ]
}

# ── containers: a crashed run's stack outlives the job that started it ────────
# Age is the discriminator, not the name: compose-smoke's own timeout is 25
# minutes, so a CI stack older than 30 minutes belongs to a job that is already
# dead (cancelled by a superseded push, or killed by the runner) and is safe to
# remove. A live concurrent run is younger than the threshold by construction.
for c in $(docker ps --format '{{.Names}}' 2>/dev/null | grep '^svci-' || true); do
  started=$(docker inspect -f '{{.State.StartedAt}}' "$c" 2>/dev/null || true)
  [ -z "$started" ] && continue
  born=$(date -u -d "$started" +%s 2>/dev/null || echo 0)
  [ "$born" = "0" ] && continue
  if [ $((now_epoch - born)) -gt 1800 ]; then
    run docker rm -f "$c" && removed_containers=$((removed_containers + 1))
  fi
done

# ── networks: exhausted pools present as "all predefined address pools have
#    been fully subnetted", which looks like a compose bug and is a leak ───────
for n in $(docker network ls --format '{{.Name}}' 2>/dev/null | grep '^svci-' || true); do
  run docker network rm "$n" && removed_networks=$((removed_networks + 1))
done

# ── named CI volumes ──────────────────────────────────────────────────────────
for v in $(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -E '^svci-|^sv-ci-' || true); do
  if referenced_by_container "$v"; then
    held_back=$((held_back + 1))
    continue
  fi
  run docker volume rm "$v" && removed_named=$((removed_named + 1))
done

# ── anonymous volumes: the leak no name filter could see ──────────────────────
for v in $(docker volume ls -q --filter dangling=true 2>/dev/null | grep -E '^[0-9a-f]{64}$' || true); do
  if referenced_by_container "$v"; then
    held_back=$((held_back + 1))
    continue
  fi
  created=$(docker volume inspect "$v" --format '{{.CreatedAt}}' 2>/dev/null || echo "")
  if [ -z "$created" ]; then
    echo "note: anonymous volume $v reports no creation time; left alone" >&2
    held_back=$((held_back + 1))
    continue
  fi
  born=$(date -u -d "$created" +%s 2>/dev/null || echo 0)
  if [ "$born" = "0" ] || [ $((now_epoch - born)) -lt $((ANON_MIN_AGE_H * 3600)) ]; then
    continue
  fi
  run docker volume rm "$v" && removed_volumes=$((removed_volumes + 1))
done

# ── images: per-run stacks, ~2.5 GB each, and `compose down` never removes them ─
for img in $(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E '^svci-|^sv-ci-' || true); do
  if [ -n "$(docker ps -a --filter ancestor="$img" --format '{{.Names}}' 2>/dev/null)" ]; then
    held_back=$((held_back + 1))
    continue
  fi
  run docker rmi "$img" && removed_images=$((removed_images + 1))
done

# Dangling images (untagged leftovers of rebuilt layers) and old build cache.
if [ "$do_it" = "1" ]; then
  docker image prune --force >/dev/null 2>&1 || true
  docker builder prune --force --filter "until=${CACHE_MAX_AGE}" >/dev/null 2>&1 || true
elif [ "$SHOW_WOULD" = "1" ]; then
  echo "would: docker image prune --force"
  echo "would: docker builder prune --force --filter until=${CACHE_MAX_AGE}"
fi

echo "reclaim[$MODE]: containers=$removed_containers networks=$removed_networks volumes(named)=$removed_named volumes(anonymous>=${ANON_MIN_AGE_H}h)=$removed_volumes images=$removed_images held-back(referenced)=$held_back"
df -h "$TARGET_DIR" | tail -1
# Explicit, because the last statement of an earlier draft was a
# `[ "$MODE" = "check" ] && echo …` test — which evaluates false in reclaim mode,
# and a script's exit status is its last command's. A successful reclaim therefore
# exited 1: measured on the box, it deleted nothing, printed a healthy report, and
# returned failure. In CI that is the cleanup step failing because it worked.
exit 0
