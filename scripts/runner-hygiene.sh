#!/usr/bin/env bash
# Runner disk hygiene — the preventive half of the 2026-10-19 deploy stall.
#
# Both self-hosted GitHub Actions runners live on this box and share its single root
# filesystem. When it fills, a job does not fail with a build error: the runner dies
# writing its own diagnostic log, the check goes red with a System.IO stack trace, and
# the promotion PR sits `mergeStateStatus: BLOCKED` while CI looks merely slow. Production
# keeps serving, so nothing looks broken from the outside.
#
# WHY A CRON AND NOT A WORKFLOW: a workflow-based cleanup cannot run when the disk is
# full, because running a job is exactly what needs the disk. The schedule has to live
# outside the thing it protects.
#
# WHAT THIS NEVER TOUCHES: any volume belonging to a running container, the production
# containers themselves, or named compose volumes. `docker volume prune -f` removes only
# ANONYMOUS unused volumes, and the leaked CI stacks are anonymous hex names; the named
# `securevoice-ai_*` volumes of live services are unreachable by that command by design.
# Images in use by any existing container (running or stopped) are kept by the
# `until=24h` filter as well as by docker's own reference rules.
#
# Install (the box keeps a copy at /home/ubuntu/runner-hygiene.sh; this file is the
# reviewed source, and re-scp it after any change — see docs/RUNBOOK.md):
#   15 4 * * * /home/ubuntu/runner-hygiene.sh >> /home/ubuntu/runner-hygiene.log 2>&1
set -euo pipefail

# Below this much free space, reclaim. Chosen from the measured shape of the problem:
# a `next build` plus five worker images needs several GB, and the box is 96 GB total.
MIN_FREE_GB="${MIN_FREE_GB:-20}"

avail_gb=$(df -P -k / | awk 'NR==2 {printf "%.1f", $(NF-2)/1024/1024}')
echo "== $(date -u +'%Y-%m-%dT%H:%M:%SZ') runner-hygiene: ${avail_gb} GB free, threshold ${MIN_FREE_GB} GB"

# Fail the same way the CI preflight does if `df` cannot be read: no free space value
# means no prune, and silence is what turned this into an incident.
if [ -z "$avail_gb" ] || [ "$avail_gb" = "NaN" ]; then
  echo "REFUSING TO GUESS: could not read free space from df"
  exit 1
fi

if [ "$(echo "$avail_gb < $MIN_FREE_GB" | bc -l)" -eq 0 ]; then
  echo "above threshold — nothing to do"
  exit 0
fi

echo "below threshold — reclaiming build cache"
docker buildx prune -f 2>&1 | tail -1 || echo "buildx prune failed (continuing)"

echo "reclaiming images older than 24h and not referenced by any container"
docker image prune -af --filter until=24h 2>&1 | tail -1 || echo "image prune failed (continuing)"

echo "reclaiming anonymous unused volumes (leaked CI stacks)"
docker volume prune -f 2>&1 | tail -1 || echo "volume prune failed (continuing)"

df -P -k / | awk 'NR==2 {printf "== after: %.1f GB free\n", $(NF-2)/1024/1024}'
