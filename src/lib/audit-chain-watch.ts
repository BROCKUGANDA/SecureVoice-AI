import "server-only";
/**
 * The audit-chain watch: verify recently written chains on a schedule, without
 * a human opening the console.
 *
 * `verifyChain()` existed and was called from exactly one place that matters —
 * the console's audit route, per case, on request. A chain altered by anything
 * other than the app (a direct UPDATE, a spliced row, a fork planted by a second
 * writer) stayed broken until somebody happened to look at that specific case,
 * which is not a control, it is an audit you can only perform after you already
 * suspect the answer.
 *
 * This runs from the dial worker's sweep loop (the process that is always on and
 * already owns the side-effect-free maintenance passes). It verifies a bounded
 * sample of the most recently written call chains and pages the operator inbox
 * on any break — one alert per org per hour, aggregated by `notify()`'s dedupe
 * window, carrying the exact broken row id.
 *
 * Why a sample and not everything: a full-table walk is O(rows) verification
 * work per tick on a remote database, and the population that matters is the
 * RECENT one — an alteration almost always lands close to the write it alters,
 * and an old, already-verified chain is re-checked by the console on demand. The
 * window and sample size are config above, not magic numbers in a query.
 */
import { dbAudit } from "@/lib/db";
import { verifyChain } from "@/lib/audit-chain";
import { notify } from "@/lib/notifications";
import { logError } from "@/lib/validation/safe-log";

export const CHAIN_WATCH_INTERVAL_MS = 10 * 60_000;

/** Chains written within this window are candidates for the sweep. */
export const CHAIN_WATCH_WINDOW_MINUTES = 60;

/** How many distinct call chains one sweep verifies (each is 1–2 queries). */
export const CHAIN_WATCH_SAMPLE = 25;

export type ChainWatchBreak = {
  callRef: string;
  orgId: string | null;
  /** The row whose hash or link failed — exact, from `verifyChain()`. */
  brokenAt: string;
};

export type ChainWatchReport = {
  checked: number;
  broken: ChainWatchBreak[];
  at: string;
};

/**
 * Verify the most recently written chains. Read-only; never throws for a broken
 * chain (a break is a result, not an error), but DOES propagate database
 * failures so the caller can log "the watch itself failed" separately from "the
 * watch found nothing".
 */
export async function scanRecentChains(
  opts: { windowMinutes?: number; limit?: number } = {},
): Promise<ChainWatchReport> {
  const windowMinutes = opts.windowMinutes ?? CHAIN_WATCH_WINDOW_MINUTES;
  const limit = opts.limit ?? CHAIN_WATCH_SAMPLE;
  const since = new Date(Date.now() - windowMinutes * 60_000);

  // One bounded query, deduped in memory. `distinct: ["callRef"]` with an
  // `orderBy` on `createdAt` is rejected by Postgres (DISTINCT ON requires the
  // ORDER BY to lead with the distinct column), and `groupBy` cannot carry the
  // orgId without grouping by it too — the in-memory pass is the honest shape.
  const rows = await dbAudit.auditLog.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: limit * 8,
    select: { callRef: true, orgId: true },
  });
  const byRef = new Map<string, string | null>();
  for (const row of rows) {
    if (!byRef.has(row.callRef)) byRef.set(row.callRef, row.orgId ?? null);
  }
  const candidates = [...byRef.entries()].slice(0, limit);

  const broken: ChainWatchBreak[] = [];
  for (const [callRef, orgId] of candidates) {
    const v = await verifyChain(callRef, orgId);
    if (!v.ok) broken.push({ callRef, orgId, brokenAt: v.brokenAt });
  }
  return { checked: candidates.length, broken, at: new Date().toISOString() };
}

let lastRunAt = 0;

/**
 * Page the operator inbox once per broken chain in `report`.
 *
 * Separate from the tick because this is the half that can quietly stop
 * working: a break that is detected and not delivered is indistinguishable from
 * a break nobody found. Delivery failures are logged per break so one failed
 * write cannot hide the others.
 */
export async function pageBrokenChains(report: ChainWatchReport): Promise<void> {
  for (const b of report.broken) {
    try {
      await notify({
        orgId: b.orgId,
        alertType: "audit_chain_broken",
        severity: "page",
        title: `Audit chain broken at ${b.brokenAt}`,
        body:
          `Chain for ${b.callRef} failed verification (broken row ${b.brokenAt}) during the ` +
          `${CHAIN_WATCH_WINDOW_MINUTES}-minute sweep. ${report.checked} recent chains were checked. ` +
          "The record has been altered or spliced since it was written; treat it as an incident.",
        caseRef: b.callRef,
        windowMinutes: 60,
      });
    } catch (err) {
      logError("[audit-chain-watch] broken chain — the inbox row could NOT be written", {
        callRef: b.callRef,
        brokenAt: b.brokenAt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * One scheduled tick. Returns the report when it ran, `null` when it is not due
 * yet (the worker calls this every second; the sweep is every ten minutes).
 *
 * A break is paged at `page` severity: the record of a customer interaction is
 * evidence a bank relies on, and a chain that no longer proves what it recorded
 * is an incident, not a metric.
 */
export async function auditChainWatchTick(now = Date.now()): Promise<ChainWatchReport | null> {
  if (now - lastRunAt < CHAIN_WATCH_INTERVAL_MS) return null;
  lastRunAt = now;

  const report = await scanRecentChains();
  await pageBrokenChains(report);
  return report;
}

/** Test seam: forget the schedule so a tick can run immediately. */
export function resetChainWatchSchedule(): void {
  lastRunAt = 0;
}
