/**
 * Overage billing worker — the runnable loop around src/lib/payments/overage-run.ts.
 *
 * The rater in `overage.ts` has been complete and tested since it was written,
 * with one problem: nothing called it. A billing path that only a test file
 * reaches does not bill anyone, so this is the production caller, on the same
 * shape as `src/worker/retention.ts` — a plain Bun loop outside the web tier,
 * first pass at boot, then every OVERAGE_SWEEP_HOURS.
 *
 * It runs as a service rather than a cron note for the reason that applies to
 * retention: a period that closes while nobody remembers to run the job still
 * closed, and the invoice for it should not depend on someone's calendar.
 *
 * Nothing is written unless `OVERAGE_INVOICING_ENABLED=1`. Without it every
 * tenant is rated and reported as `would_bill`, which is how a deployment
 * checks the arithmetic against a real period before any of it reaches a bank's
 * accounts team. The live-key guard is NOT duplicated here — the Paddle adapter
 * refuses a `pdl_live_` key unless `PADDLE_ALLOW_LIVE_KEYS=1`, and two answers
 * to "may this reach production" is one too many.
 *
 * One-shot, for CI and operators:
 *   bun src/worker/overage.ts --once                (rate, write nothing unless enabled)
 *   bun src/worker/overage.ts --once --org=<orgId>  (one tenant)
 */
// NOTE: deliberately NO `import "server-only"` here — see src/worker/dial.ts.

import {
  INVOICING_ENABLED_ENV,
  runOverageBilling,
  type OverageRunReport,
} from "@/lib/payments/overage-run";
import { logError, logInfo } from "@/lib/validation/safe-log";
import { installProcessCrashHandlers } from "@/lib/process-crash-handlers";

const SWEEP_HOURS = Number(process.env.OVERAGE_SWEEP_HOURS ?? 24);
const ONCE = process.argv.includes("--once");
const orgArg = process.argv.find((a) => a.startsWith("--org="));
const ONLY_ORG = orgArg ? orgArg.slice("--org=".length) : undefined;

/** One line per tenant, so a log reader can see who was billed and who was not. */
export function summarise(report: OverageRunReport): string {
  const perOrg = report.results
    .map((r) => {
      const money =
        typeof r.amountMinor === "number" ? ` ${r.amountMinor}r${r.currency ?? ""}` : "";
      const units = typeof r.billableUnits === "number" ? ` +${r.billableUnits}u` : "";
      return `${r.orgId.slice(0, 8)}:${r.outcome}${units}${money}${r.reason ? ` (${r.reason})` : ""}`;
    })
    .join(" ");
  return (
    `enabled=${report.invoicingEnabled} candidates=${report.totals.candidates} ` +
    `billed=${report.totals.billed} wouldBill=${report.totals.wouldBill} ` +
    `duplicates=${report.totals.duplicates} nothingToBill=${report.totals.nothingToBill} ` +
    `skipped=${report.totals.skipped} failed=${report.totals.failed}` +
    (report.refused ? ` REFUSED:${report.refused.reason} — ${report.refused.detail}` : "") +
    ` [${perOrg}]`
  );
}

async function sweep(): Promise<OverageRunReport> {
  const report = await runOverageBilling(ONLY_ORG ? { orgId: ONLY_ORG } : {});
  const line = summarise(report);
  const anyFailure = report.totals.failed > 0 || Boolean(report.refused);
  if (anyFailure) logError("[overage-worker] run finished with failures", { summary: line });
  else logInfo("[overage-worker] run complete", { summary: line });
  return report;
}

async function main(): Promise<void> {
  logInfo("[overage-worker] starting", {
    sweepHours: SWEEP_HOURS,
    invoicingEnabled: process.env[INVOICING_ENABLED_ENV] === "1",
    envVar: INVOICING_ENABLED_ENV,
  });

  if (ONCE) {
    const report = await sweep();
    // A failed gateway push is a receivable that was not sent: make one-shot
    // mode say so to any scheduler watching the exit code.
    if (report.totals.failed > 0 || report.refused) process.exitCode = 1;
    return;
  }

  let running = true;
  const stop = () => {
    running = false;
    logInfo("[overage-worker] draining — finishing the in-flight run");
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
      logError("[overage-worker] run failed", {
        error: err instanceof Error ? err.message : err,
      });
    }
    // Short slices, so a stop signal lands promptly instead of after a day.
    const intervalMs = SWEEP_HOURS * 3_600_000;
    while (running && Date.now() - started < intervalMs) {
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  logInfo("[overage-worker] stopped cleanly");
}

if (import.meta.main) {
  installProcessCrashHandlers();
  main().catch((err) => {
    logError("[overage-worker] fatal", { error: err instanceof Error ? err.message : err });
    process.exit(1);
  });
}
