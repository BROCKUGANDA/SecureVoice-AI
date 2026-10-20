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
#     `crucible_deployed` and anything a human made by hand are not candidates. The one
#     exception is a buildx builder's own `_state` volume, which is removed only as part
#     of `docker buildx rm` of a UUID-shaped builder older than the age floor — never by
#     a volume glob. See the builders block for why that is safe and what it leaves.
#   * every image except `svci-`/`sv-ci-` stacks and `securevoice-ai-app:<sha12>`
#     deploy builds; worker `:latest` images, `crucible-*`, `caddy`, `postgres`,
#     `redis` and `foundry` are not candidates at all.
#   * anonymous volumes and app deploy builds younger than 24 h. A run that finished
#     five minutes ago is not garbage, the rollback target is not garbage, and
#     neither is a volume someone is debugging on this box.
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
#   IMG_MIN_AGE_M      per-run CI image age floor, default 30 — see the images block for
#                      why "unreferenced" alone is not a safety argument for those
#   CACHE_MAX_AGE      passed to `docker builder prune --filter until=`, default 72h
#   BUILDER_KEEP       comma-separated builder names that must never be removed, even
#                      when they match the leftover shape and pass the age floor
set -uo pipefail

MODE="${1:-reclaim}"
case "$MODE" in reclaim | dry-run) ;; *)
  echo "usage: $0 [reclaim|dry-run]" >&2
  exit 2
  ;;
esac

TARGET_DIR="${TARGET_DIR:-$PWD}"
ANON_MIN_AGE_H="${ANON_MIN_AGE_H:-24}"
IMG_MIN_AGE_M="${IMG_MIN_AGE_M:-30}"
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
removed_builders=0
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
# The age floor here is not tidiness. The unreferenced check alone cannot protect a live
# job: compose-smoke BUILDS `svci-<run_id>-*` images several minutes BEFORE it creates the
# containers, and in that window the images its own run is about to start are exactly
# "unreferenced". Reclaim from the `cleanup` job on one runner can therefore delete the
# images the other runner's smoke test is mid-way through, and that failure looks like a
# broken tree, not like a cleaner. A dry run against a live CI run on 2026-10-19 named nine
# such images, which is how the gap was found. The floor is the same discriminator the
# containers loop uses — a run's own build-to-up gap is minutes, its timeout is 25.
for img in $(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E '^svci-|^sv-ci-' || true); do
  if [ -n "$(docker ps -a --filter ancestor="$img" --format '{{.Names}}' 2>/dev/null)" ]; then
    held_back=$((held_back + 1))
    continue
  fi
  born=$(docker image inspect "$img" --format '{{.Created}}' 2>/dev/null | cut -c1-19)
  [ -z "$born" ] && continue
  epoch=$(date -u -d "$born" +%s 2>/dev/null || echo 0)
  if [ "$epoch" = "0" ] || [ $((now_epoch - epoch)) -lt $((IMG_MIN_AGE_M * 60)) ]; then
    continue
  fi
  run docker rmi "$img" && removed_images=$((removed_images + 1))
done

# Deploy-built app images. Every branch deploy adds one more
# `securevoice-ai-app:<sha12>` (~571 MB) and composes the stack onto it, and nothing had
# ever removed the previous ones: twelve orphaned tags on this box, 6.3 GB, while
# `docker system df` reported 20.9 GB reclaimable in images and every loop above looked
# away because none of those names starts with `svci-`.
#
# A tag is removable only when no container at all references it — which includes the
# stopped one from the deploy before this, so the rollback target survives longer than
# the arithmetic here suggests — and only when it is older than 24 h, so a rollback
# across a bad night is always available. `:latest` tags and the worker images are not
# candidates: the pattern is the app repo with a 12-hex tag and nothing else.
for img in $(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E '^securevoice-ai-app:[0-9a-f]{12}$' || true); do
  if [ -n "$(docker ps -a --filter ancestor="$img" --format '{{.Names}}' 2>/dev/null)" ]; then
    held_back=$((held_back + 1))
    continue
  fi
  born=$(docker image inspect "$img" --format '{{.Created}}' 2>/dev/null | cut -c1-19)
  [ -z "$born" ] && continue
  epoch=$(date -u -d "$born" +%s 2>/dev/null || echo 0)
  if [ "$epoch" -gt 0 ] && [ $((now_epoch - epoch)) -gt $((ANON_MIN_AGE_H * 3600)) ]; then
    run docker rmi "$img" && removed_images=$((removed_images + 1))
  fi
done

# Buildx builders — what was actually eating this box, found by measuring the disk
# rather than by reading the reclaim rules. The state volumes of the `docker-container`
# builders hold the disk's real high-water mark, and each is ATTACHED TO A RUNNING
# buildkit container, so `docker system df` reports 0 B reclaimable in volumes and every
# guard above is correctly, uselessly conservative.
#
# Why `docker buildx prune` freed 3.2 GB and left 9.9 GB behind: it prunes the builder its
# endpoint resolves to, which is ONE of them. So cache is reclaimed from every builder by
# name — and then the leftover builders themselves are removed, which is the only operation
# that frees the state volume. Measured on 2026-10-19: two leftovers were holding 14.6 GB
# and 2.27 GB (17.01 GB of buildkit cache reported by `buildx du`), and removing them took
# the root filesystem from 22 GB free to 40 GB.
#
# WHY REMOVING THEM IS SAFE, which is the question the first draft of this block left
# unanswered and therefore left the builders alone:
#   * they are created per-run by `docker/setup-buildx-action` — release.yml is the only
#     workflow that calls it — with a random name, and the action disposes its own builder
#     when the job ends cleanly. Both survivors here belonged to FINISHED runs, one of them
#     the failed v0.2.37 release. Nothing accumulates so much as a failure leaving one.
#   * nothing on this box refers to a builder across runs: `grep -rn builder` over the
#     runners' own `run.sh`/`.env` found no `--builder` at all, and `buildx ls` after the
#     removal shows only `default`, which is what `docker build` uses.
#   * the cache worth keeping is not local: release.yml sends it to `type=gha`, so a
#     destroyed leftover builder costs a rebuild of layers Actions already has.
# Age is what separates a leftover from a live builder — a job bootstraps its builder
# seconds before using it, so anything older than 24 h is not in front of a build.
#
# WHAT THIS STILL WILL NOT TOUCH, deliberately: a builder with a human-chosen name. This
# box also hosts the crucible and astrolabe runners, and an age-only filter would delete
# another project's long-lived builder to reclaim this one's disk. The trade is stated
# rather than hidden: a leak that someone named on purpose keeps accumulating here, and the
# report below says so instead of pretending the rule is complete. A UUID-shaped leftover
# from another project IS a candidate — the same finished-run argument that makes this
# repo's leftovers removable applies to theirs.
# `buildx ls --format '{{.Name}}'` lists NODE rows as well as builders, and node names are
# the builder's with a driver suffix, so each candidate is confirmed against `buildx
# inspect` before it is named — a dry run that promises to prune something that does not
# exist teaches the next reader to distrust it.
BUILDER_KEEP=",${BUILDER_KEEP:-},"

builder_age_epoch() {
  # The builder's buildkit container is the thing that was created; docker's `name=`
  # filter is a substring match, so this finds the node container whatever suffix it has.
  local created
  created=$(docker ps -a --filter "name=buildx_buildkit_$1" --format '{{.CreatedAt}}' 2>/dev/null | head -1)
  [ -z "$created" ] && return 1
  date -u -d "$created" +%s 2>/dev/null || return 1
}

is_leftover_shape() {
  case "$1" in
    builder-????????-????-????-????-????????????) return 0 ;;
    sv-rel-*) return 0 ;;
    *) return 1 ;;
    esac
}

for b in $(docker buildx ls --format '{{.Name}}' 2>/dev/null | grep -v '^default$' | sort -u || true); do
  [ -n "$(docker buildx inspect "$b" 2>/dev/null | grep -m1 '^Name:')" ] || continue
  case "$BUILDER_KEEP" in *,"$b",*) echo "buildx ${b}: kept by BUILDER_KEEP"; continue ;; esac
  if is_leftover_shape "$b"; then
    born=$(builder_age_epoch "$b" || echo 0)
    if [ "$born" != "0" ] && [ $((now_epoch - born)) -gt $((ANON_MIN_AGE_H * 3600)) ]; then
      if [ "$do_it" = "1" ]; then
        # Removing the builder also removes its state volume, so the cache prune below is
        # skipped for it — pruning something about to be deleted is noise in the report.
        if docker buildx rm "$b" >/dev/null 2>&1; then
          removed_builders=$((removed_builders + 1))
          echo "buildx ${b}: removed (builder older than ${ANON_MIN_AGE_H}h, leftover shape)"
          continue
        fi
        echo "buildx ${b}: removal refused (a build is using it); pruning cache instead"
      else
        echo "would: docker buildx rm $b"
        continue
      fi
    else
      echo "buildx ${b}: leftover shape but younger than ${ANON_MIN_AGE_H}h — kept"
    fi
  else
    echo "buildx ${b}: not a leftover name — cache only, builder kept"
  fi
  if [ "$do_it" = "1" ]; then
    freed=$(docker buildx prune --builder "$b" --force --filter "until=${CACHE_MAX_AGE}" 2>/dev/null | tail -1)
    [ -n "$freed" ] && echo "buildx ${b}: ${freed}"
  else
    echo "would: docker buildx prune --builder $b --force --filter until=${CACHE_MAX_AGE}"
  fi
done

# Dangling images (untagged leftovers of rebuilt layers) and old build cache.
if [ "$do_it" = "1" ]; then
  docker image prune --force >/dev/null 2>&1 || true
  docker builder prune --force --filter "until=${CACHE_MAX_AGE}" >/dev/null 2>&1 || true
elif [ "$SHOW_WOULD" = "1" ]; then
  echo "would: docker image prune --force"
  echo "would: docker builder prune --force --filter until=${CACHE_MAX_AGE}"
fi

echo "reclaim[$MODE]: containers=$removed_containers networks=$removed_networks volumes(named)=$removed_named volumes(anonymous>=${ANON_MIN_AGE_H}h)=$removed_volumes images=$removed_images builders=$removed_builders held-back(referenced)=$held_back"
df -h "$TARGET_DIR" | tail -1
# Explicit, because the last statement of an earlier draft was a
# `[ "$MODE" = "check" ] && echo …` test — which evaluates false in reclaim mode,
# and a script's exit status is its last command's. A successful reclaim therefore
# exited 1: measured on the box, it deleted nothing, printed a healthy report, and
# returned failure. In CI that is the cleanup step failing because it worked.
exit 0
