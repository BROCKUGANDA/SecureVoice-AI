/**
 * Retention worker — the runnable loop around src/lib/privacy/retention.ts.
 *
 * The retention sweeper is a privacy OBLIGATION, not an operator chore: the
 * tiers erase on the clock whether or not anyone remembers to run them, and a
 * window that silently never fires is a window that leaks. So it runs as its
 * own compose service on the dial-worker pattern — a plain Bun loop outside
 * the web tier, where a long chain verification can never occupy an HTTP
 * request or stall the dial loop.
 *
 * The first sweep runs at boot (a worker that was down overnight owes the
 * backlog a sweep, not a polite wait), then every RETENTION_SWEEP_HOURS.
 *
 * One-shot, for CI and operators:
 *   bun src/worker/retention.ts --once            (applies the policy)
 *   bun src/worker/retention.ts --once --dry-run  (reports, writes nothing)
 */
// NOTE: deliberately NO `import "server-only"` here — see src/worker/dial.ts.

import { runRetention, type RetentionRunReport } from "@/lib/privacy/retention";
import { logError, logInfo } from "@/lib/validation/safe-log";

const SWEEP_HOURS = Number(process.env.RETENTION_SWEEP_HOURS ?? 24);
const ONCE = process.argv.includes("--once");
const DRY_RUN = process.argv.includes("--dry-run");

function summarise(report: RetentionRunReport): string {
  const tiers = (Object.keys(report.tiers) as (keyof RetentionRunReport["tiers"])[])
    .map((tier) => `${tier}:${report.tiers[tier].acted}/${report.tiers[tier].due}`)
    .join(" ");
  return (
    `at ${report.at} dryRun=${report.dryRun} orgs=${report.orgs.length} ` +
    `acted/due [${tiers}] shredded=${report.payloadsShredded} ` +
    `deleted=${report.caseRecordsDeleted} audio=${report.audioArtifactsPurged} ` +
    `errors=${report.errors.length} chainIntact=${report.chain.intact}` +
    (report.chain.intact ? "" : ` brokenAt=${report.chain.brokenAt}`)
  );
}

async function sweep(): Promise<RetentionRunReport> {
  const report = await runRetention(new Date(), { dryRun: DRY_RUN });
  const line = summarise(report);
  if (report.chain.intact && report.errors.length === 0) {
    logInfo("[retention-worker] sweep complete", { summary: line });
  } else {
    logError("[retention-worker] sweep complete with errors", { summary: line });
  }
  return report;
}

async function main(): Promise<void> {
  logInfo("[retention-worker] starting", { sweepHours: SWEEP_HOURS, dryRun: DRY_RUN });

  if (ONCE) {
    const report = await sweep();
    if (process.exitCode === undefined || process.exitCode === 0) {
      // A broken chain or a failed action is an incident, not a log line: make
      // the one-shot mode say so to any scheduler watching the exit code.
      if (!report.chain.intact || report.errors.length > 0) process.exitCode = 1;
    }
    return;
  }

  let running = true;
  const stop = () => {
    running = false;
    logInfo("[retention-worker] draining — finishing the in-flight sweep");
  };
  // Bun's typed process.on overload enumerates a narrow event union; SIGTERM
  // and SIGINT are valid at runtime and are exactly what compose sends.
  process.on("SIGTERM" as never, stop as never);
  process.on("SIGINT" as never, stop as never);

  while (running) {
    const started = Date.now();
    try {
      await sweep();
    } catch (err) {
      logError("[retention-worker] sweep failed", {
        error: err instanceof Error ? err.message : err,
      });
    }
    // Sleep to the next due time in short slices so a stop signal lands
    // promptly instead of after a day.
    const intervalMs = SWEEP_HOURS * 3_600_000;
    while (running && Date.now() - started < intervalMs) {
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  logInfo("[retention-worker] stopped cleanly");
}

if (import.meta.main) {
  main().catch((err) => {
    logError("[retention-worker] fatal", { error: err instanceof Error ? err.message : err });
    process.exit(1);
  });
}

export { summarise };
