/**
 * Per-instance counters for which TTS rung served.
 *
 * Written by every synthesis that goes through the ladder and read by
 * `/api/metrics` as `sv_tts_rung_total{rung=…}`. The point is a scrape-able number
 * that MOVES when the voice engine degrades: until this existed, a rung drop was
 * visible in a log line and (later) in a `TtsSynthesis` row, but `/api/metrics`
 * had twenty collectors and none of them degradation — so a 40% slowdown tripped
 * nothing anywhere.
 *
 * In-memory and per-instance, deliberately, like the span log: counting these in
 * the database on the voice path would put a write where the latency budget is,
 * and a fleet aggregate is what a scraper is for (sum across instances, or read
 * the `TtsSynthesis` table for history). What a single instance's counter buys is
 * the answer to "is THIS process falling back right now", cheaply, on every
 * scrape.
 */

const RUNGS = ["elevenlabs", "byok", "elevenlabs-pool", "playht", "emergency"] as const;

export type TtsRungName = (typeof RUNGS)[number];

/**
 * The whole label vocabulary this module can emit, exported so the scrape guard
 * asserts against the producer instead of against a hand-copied list that can drift.
 */
export const TTS_RUNG_LABELS = [...RUNGS, "other"] as const;

const counts = new Map<string, number>();
let degradedCount = 0;

/** Record one synthesis served by `source` (an unknown source is still counted). */
export function countRung(source: string, degraded = false): void {
  counts.set(source, (counts.get(source) ?? 0) + 1);
  if (degraded) degradedCount += 1;
}

/**
 * Snapshot for the metrics endpoint: one series per known rung, and one for
 * anything else.
 *
 * The label domain is closed by construction. An unknown source is still
 * counted — a metric that loses events exactly when something new happens is
 * worse than no metric — but it lands in `other` instead of being handed a
 * series of its own, because a label whose values come from data is unbounded
 * cardinality, and `/api/metrics` exists to be scraped by the system that has
 * to survive it.
 */
export function rungSnapshot(): { rung: TtsRungName | "other"; total: number }[] {
  const out: { rung: TtsRungName | "other"; total: number }[] = RUNGS.map((rung) => ({
    rung,
    total: counts.get(rung) ?? 0,
  }));
  let other = 0;
  for (const [source, total] of counts) {
    if (!(RUNGS as readonly string[]).includes(source)) other += total;
  }
  if (other > 0) out.push({ rung: "other", total: other });
  return out;
}

/** Syntheses that did NOT come from rung 1 — the degradation signal itself. */
export function degradedSnapshot(): number {
  return degradedCount;
}

/** Test seam. */
export function resetRungCounters(): void {
  counts.clear();
  degradedCount = 0;
}
