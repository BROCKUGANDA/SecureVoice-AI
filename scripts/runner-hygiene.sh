#!/usr/bin/env bash
# Runner disk hygiene and runner liveness — the preventive half of the 2026-10-19 stalls.
#
# Both self-hosted GitHub Actions runners live on this box and share its single root
# filesystem. When it fills, a job does not fail with a build error: the runner dies
# writing its own diagnostic log, the check goes red with a System.IO stack trace, and
# the promotion PR sits `mergeStateStatus: BLOCKED` while CI looks merely slow. Production
# keeps serving, so nothing looks broken from the outside.
#
# WHY A CRON AND NOT A WORKFLOW: a workflow-based cleanup cannot run when the disk is
# full, because running a job is exactly what needs the disk. The schedule has to live
# outside the thing it protects. The same argument is why the liveness check below is here
# rather than in a workflow — a runner that is down cannot report that it is down.
#
# WHAT THIS NEVER TOUCHES: any volume belonging to a running container, the production
# containers themselves, or named compose volumes. That is `scripts/reclaim-ci.sh`'s
# contract, which it enforces with reference and age checks rather than promises; this
# script no longer keeps its own copy of the docker commands. It used to, and the copy was
# wrong in a way that mattered: it called plain `docker buildx prune`, which only reaches
# the ONE builder the endpoint resolves to, so it reported success while the builders that
# actually held the disk — 14.6 GB and 2.27 GB of state volumes on 2026-10-19 — stayed
# untouched.
#
# TWO THINGS THIS FIXED, MEASURED, NOT ASSUMED:
#   1. The threshold gate. `if free >= 20 GB: exit 0` meant the box sat at 21.2 GB free with
#      17 GB of reclaimable builder cache and the cron did precisely nothing, because the
#      only rule that could have helped was behind a floor set to catch an emergency. Every
#      rule in the reclaimer is already conservative by construction (unreferenced AND older
#      than its age floor), so it now runs unconditionally and the floor only decides
#      whether to sound the alarm.
#   2. Runner liveness. `securevoice-vps-2` spent nine hours in systemd `failed` after the
#      kernel OOM killer took it mid "Compose stack smoke test": runsvc.sh exited 0, logged
#      "stop the service, no retry needed", and the generated unit carries no `Restart=` at
#      all. Nothing restarted it and nothing said so. The unit now has a drop-in
#      (Restart=always + OOMPolicy=continue, `scripts/runner-systemd-override.conf`), and
#      this check is the belt: any runner unit in `failed` is restarted and reported.
#      `OOMPolicy` is not decoration — without it an OOM kill parks the unit in `failed`
#      whatever `Restart=` says.
#
# Install (the box keeps a copy at /home/ubuntu/runner-hygiene.sh; this file is the
# reviewed source, and re-scp it after any change — see docs/RUNBOOK.md):
#   15 4 * * * /home/ubuntu/runner-hygiene.sh >> /home/ubuntu/runner-hygiene.log 2>&1
#
# HOW TO PROVE USER CRON RUNS AT ALL, without waiting for 04:15. On 2026-10-20 this was
# measured with a one-shot entry that could only fire once, then the crontab was restored
# from a snapshot and the checksum compared:
#   40 1 20 10 * /usr/bin/date -u >> /home/ubuntu/cron-probe.log 2>&1
# The file appeared with `01:40:01`, so ubuntu's crontab is executed by cron. Note what did
# NOT work as evidence: `grep "CMD (ubuntu)" /var/log/syslog` returned nothing even though
# the job had demonstrably run — this box's rsyslog records root's cron commands and not
# ubuntu's. The job's own output file is the only witness here, which is why this script
# prints its header before any threshold decision: a missing log line at 04:15 can then mean
# exactly one thing.
set -euo pipefail

# Below this much free space, shout. Not a gate on reclaiming — see note 1 above.
MIN_FREE_GB="${MIN_FREE_GB:-20}"

# The production checkout is the source of the reclaimer, so the cron and CI run the SAME
# file and cannot drift. If it is missing, that is an error to report, not a reason to
# quietly fall back to a second implementation of "clean up" — which is the bug class this
# script was written to remove.
REPO_DIR="${REPO_DIR:-$HOME/securevoice-ai}"
RECLAIMER="$REPO_DIR/scripts/reclaim-ci.sh"

avail_gb=$(df -P -k / | awk 'NR==2 {printf "%.1f", $(NF-2)/1024/1024}')
echo "== $(date -u +'%Y-%m-%dT%H:%M:%SZ') runner-hygiene: ${avail_gb} GB free, alarm floor ${MIN_FREE_GB} GB"

# Fail the same way the CI preflight does if `df` cannot be read: no free space value
# means no prune, and silence is what turned this into an incident.
if [ -z "$avail_gb" ] || [ "$avail_gb" = "NaN" ]; then
  echo "REFUSING TO GUESS: could not read free space from df"
  exit 1
fi

# ── liveness: a runner that is down is invisible to CI ────────────────────────
# Checked first, because a down runner stops this box doing any building at all, and
# "which two builders do the runners hold open" was unanswerable for a week precisely
# because nobody could see the runners' state from inside a workflow.
echo "-- runner units"
# `systemctl` reads need no privilege; reset-failed and restart do. ubuntu has
# passwordless sudo on this box and cron's stripped PATH still resolves /usr/bin/sudo —
# both proven by running this script under `env -i` rather than in a shell, which is how
# the first version of this cron learned that "installed" is not "fired".
#
# Deliberately global, not SecureVoice-only: this box also runs the crucible and astrolabe
# runners, and a unit in `failed` has no job in flight by definition, so reviving another
# project's listener cannot interrupt anything. The alternative is that those runners lie
# dead in exactly the way this one did for nine hours, with the same missing signal.
for unit in $(systemctl list-unit-files --type=service --no-legend 'actions.runner.*' | awk '{print $1}'); do
  state=$(systemctl is-active "$unit" 2>/dev/null || true)
  if [ "$state" != "active" ]; then
    result=$(systemctl show "$unit" -p Result --value 2>/dev/null || echo unknown)
    echo "   $unit is $state (last result: $result) — restarting"
    sudo systemctl reset-failed "$unit" 2>/dev/null || true
    if sudo systemctl restart "$unit" 2>/dev/null; then
      sleep 5
      echo "   after restart: $unit $(systemctl is-active "$unit" 2>/dev/null || echo unknown)"
    else
      echo "   RESTART FAILED for $unit — a person is needed"
    fi
  else
    echo "   $unit active"
  fi
done

# ── reclaim: unconditional, because every rule inside it is guarded ───────────
if [ ! -f "$RECLAIMER" ]; then
  echo "MISSING RECLAIMER: $RECLAIMER is not on this box. The checkout is behind or the"
  echo "script was never deployed; refusing to run an older private copy of these rules."
  exit 1
fi
echo "-- reclaiming CI garbage (see scripts/reclaim-ci.sh for the guards)"
TARGET_DIR="$REPO_DIR" bash "$RECLAIMER" reclaim 2>&1 | sed 's/^/   /'

if [ "$(echo "$avail_gb < $MIN_FREE_GB" | bc -l)" -eq 1 ]; then
  echo "ALARM: ${avail_gb} GB free is below the ${MIN_FREE_GB} GB floor even after reclaim."
  echo "       The next build on this box will die mid-step with null step conclusions."
fi

df -P -k / | awk 'NR==2 {printf "== after: %.1f GB free\n", $(NF-2)/1024/1024}'
exit 0
