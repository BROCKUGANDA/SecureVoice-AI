/**
 * Voice-key resolution + per-user platform-key metering, shared by BOTH TTS
 * routes (buffered /api/tts and streaming /api/tts/stream) so neither surface
 * can bypass the other's rules:
 *
 *   BYOK first — an org's own ElevenLabs key (Settings → API Keys) has NO
 *   limits. Without BYOK, the platform demo key is metered at 2,000 chars/day
 *   per user so a scraped link can't drain the shared free-tier quota.
 *
 * Concurrency: the daily counter uses an atomic INCREMENT after a date-aware
 * limit check, so two concurrent syntheses each add their own chars (a read-
 * then-write of an absolute value would lose one request's chars).
 */

import { getProfile } from "@/lib/credits";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/byok";
import { env, DAILY_CHAR_LIMIT } from "@/lib/config";

export type TtsKeyResolution =
  | { mode: "byok"; keyOverride: string }
  | { mode: "platform"; clerkUserId: string; usedToday: number }
  | { mode: "unmetered" }; // signed out, or dev dry-run — nothing to meter

export async function resolveTtsKey(): Promise<TtsKeyResolution> {
  if (env.elevenLabsDryRun) return { mode: "unmetered" };
  const profile = await getProfile();
  if (!profile) return { mode: "unmetered" };

  const row = await db.userProfile.findUnique({
    where: { clerkUserId: profile.clerkUserId },
    select: { clerkUserId: true, elevenKeyEnc: true, ttsCharsDate: true, ttsCharsToday: true },
  });
  if (!row) return { mode: "unmetered" };

  if (row.elevenKeyEnc) {
    const key = decryptSecret(row.elevenKeyEnc);
    if (key) return { mode: "byok", keyOverride: key };
  }

  if (!env.elevenLabsApiKey) return { mode: "unmetered" };
  const today = new Date().toISOString().slice(0, 10);
  const usedToday = row.ttsCharsDate === today ? row.ttsCharsToday : 0;
  return { mode: "platform", clerkUserId: row.clerkUserId, usedToday };
}

/** Charge `text.length` chars against the daily platform-key budget.
 *
 *  Atomic: a single SQL UPDATE with a WHERE guard ensures two concurrent
 *  requests cannot both pass the limit check and both increment. If the
 *  date rolled over since the last call, the counter resets to the new
 *  charge instead of adding to the stale total. */
export async function consumeCharQuota(
  res: TtsKeyResolution,
  text: string
): Promise<{ ok: true } | { ok: false; usedToday: number }> {
  if (res.mode !== "platform") return { ok: true };
  const today = new Date().toISOString().slice(0, 10);
  const chars = text.length;

  // Atomic conditional update: only succeeds if either the date changed
  // (reset) or the current total + new chars fits within the limit.
  const updated = await db.$executeRaw`
    UPDATE "UserProfile"
    SET "ttsCharsDate" = ${today},
        "ttsCharsToday" = CASE
          WHEN "ttsCharsDate" != ${today} THEN ${chars}
          ELSE "ttsCharsToday" + ${chars}
        END
    WHERE "clerkUserId" = ${res.clerkUserId}
      AND ("ttsCharsDate" != ${today} OR "ttsCharsToday" + ${chars} <= ${DAILY_CHAR_LIMIT})
  `;
  if (updated === 0) {
    // No row matched the guard — limit already reached for today
    return { ok: false, usedToday: res.usedToday };
  }
  return { ok: true };
}

/** Uniform 429 body for the metered limit — includes the BYOK upsell. */
export function quotaExceededResponse(): { error: string } {
  return {
    error:
      "Daily neural-voice limit reached on the platform key — add your own ElevenLabs key in Settings → API Keys for unlimited usage.",
  };
}