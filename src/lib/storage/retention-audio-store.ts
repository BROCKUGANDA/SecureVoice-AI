import "server-only";
/**
 * The retention worker's view of the object store — the adapter that makes the
 * audio tier delete something.
 *
 * `src/lib/privacy/retention.ts` documents its audio seam as "the platform stores
 * no call recording (I-10: the provider is the system of record)", and for the
 * deployment that claim was written for, it was true. It is no longer the whole
 * truth: `src/lib/storage/recordings.ts` archives post-call audio into R2 when the
 * store is configured, so recordings ARE at rest — while nothing ever called
 * `registerAudioStore()` outside the privacy suite. The consequence was silent and
 * one-directional: the 30-day audio tier reported `audioStore: "none-configured"`,
 * `applyTierAction("audio")` returned false for every due case, and the objects
 * stayed in the bucket past the deadline the policy claims to enforce. A privacy
 * control that reports success while deleting nothing is the failure mode this file
 * exists to remove, and it is why the sweep's report counts artifacts rather than
 * trusting the tier to have run.
 *
 * ── The join, and why it is one query ────────────────────────────────────────
 * The sweep works in `caseRef`s; objects are keyed by `(orgId, conversationId)`
 * (`recordingKey()`), so the adapter resolves the case first and derives the key
 * from it. `orgId` comes from the CASE row, never from a caller: it is the tenant
 * boundary, and a sweep that took an org id from anywhere else could reach into
 * another tenant's prefix with a valid-looking key.
 *
 * A case with no `conversationId`, or with segments that cannot form a legal key,
 * has no artifact. That is reported as "nothing to delete", not an error — those
 * cases are ordinary (a signal that never became a call, an abandoned conversation)
 * and an error per row would fill the report with noise and hide the real failures.
 *
 * ── Two things this deliberately does NOT claim ───────────────────────────────
 * 1. It does not report byte counts. `hasRecording()` is a HEAD that returns
 *    existence only, and the storage client throws its response headers away, so a
 *    size here would be invented. `AudioArtifact.bytes` is `number | null` and this
 *    adapter returns `null`, because an object reported as 0 bytes reads like an
 *    empty recording, which is a different and falsifiable statement.
 * 2. `deleteForCase()` counts objects that WERE there. The store's DELETE is
 *    idempotent — deleting an absent key succeeds — so a count built from delete
 *    results alone would credit the sweep with purges it never made. The existence
 *    check before the delete is one extra round trip per due case, and audio is the
 *    rarest tier; a truthful `audioArtifactsPurged` is worth it.
 *
 * A refusal from the store THROWS rather than returning 0, so the sweep's per-row
 * catch puts it in `report.errors` with the case reference. "Could not delete" and
 * "there was nothing to delete" are not the same outcome and must never arrive at
 * the same number.
 */
import type { AudioArtifact, AudioStore } from "@/lib/privacy/retention";
import { db } from "@/lib/db";
import { deleteRecording, hasRecording, recordingKey } from "@/lib/storage/recordings";

type Locator = { orgId: string; conversationId: string; key: string };

/**
 * Resolve a case to the one object the platform may have archived for it.
 * Null when the case cannot have a recording, for any of the three reasons in the
 * header: no tenant, no conversation, or segments that will not form a legal key.
 */
async function locatorForCase(caseRef: string): Promise<Locator | null> {
  const row = await db.case.findUnique({
    where: { caseRef },
    select: { orgId: true, conversationId: true },
  });
  if (!row?.orgId || !row.conversationId) return null;
  try {
    // `recordingKey()` throws on a segment that would escape the tenant prefix.
    // Reaching it here means a row with a value the writer should have refused, so
    // the answer is "no artifact", loudly, rather than a key built from it.
    return {
      orgId: row.orgId,
      conversationId: row.conversationId,
      key: recordingKey(row.orgId, row.conversationId),
    };
  } catch {
    return null;
  }
}

export const retentionAudioStore: AudioStore = {
  async listForCase(caseRef: string): Promise<AudioArtifact[]> {
    const locator = await locatorForCase(caseRef);
    if (!locator) return [];
    if (!(await hasRecording(locator.key))) return [];
    return [{ id: locator.key, caseRef, bytes: null }];
  },

  async deleteForCase(caseRef: string): Promise<number> {
    const locator = await locatorForCase(caseRef);
    if (!locator) return 0;

    const existed = await hasRecording(locator.key);
    const result = await deleteRecording({
      orgId: locator.orgId,
      conversationId: locator.conversationId,
    });
    if (!result.ok) {
      throw new Error(
        `retention: audio purge refused for ${caseRef} (${result.error})${
          locator.key ? ` — key ${locator.key}` : ""
        }. Not counted as purged.`,
      );
    }
    return existed ? 1 : 0;
  },
};
