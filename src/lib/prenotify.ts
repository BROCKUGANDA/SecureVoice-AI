/**
 * Pre-notification lead — how long to hold the dial so the heads-up SMS lands
 * before the ring. Shared so the batch campaign ingest and the single-signal
 * ingest agree on ONE definition instead of each importing the other's route.
 *
 * DEFAULT 0: the submission promises the agent calls within 60s of the signal,
 * and a hold breaks that SLA. An operator who wants the pre-notification SMS to
 * reliably land before the ring opts in with PRENOTIF_LEAD_SECONDS (60–90).
 * Bounded so a misconfigured env value cannot park a fraud call indefinitely.
 */
export function preNotificationLeadMs(): number {
  const raw = Number(process.env.PRENOTIF_LEAD_SECONDS ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(90, Math.trunc(raw)) * 1000;
}
