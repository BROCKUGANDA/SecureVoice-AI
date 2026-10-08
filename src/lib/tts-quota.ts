import "server-only";
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
import { env, dailyCharLimit } from "@/lib/config";

export type TtsKeyResolution =
  | { mode: "byok"; keyOverride: string }
  | { mode: "platform"; userId: string; usedToday: number }
  | { mode: "unmetered" }
  /**
   * No profile and no BYOK, so there is no per-user budget to charge.
   *
   * BEFORE this variant existed, an unauthenticated caller fell through to
   * `unmetered` and synthesised against the PLATFORM'S ElevenLabs key with no
   * quota check at all. The only guard was `consumeRateLimit("tts-stream",
   * rateLimitId(req))`, and `rateLimitId` returns the literal string "anon"
   * whenever no client-IP header is present, so every anonymous caller shared
   * ONE bucket and an attacker controlling their own egress simply spread
   * requests across IPs to reset it. That is a direct drain of a paid vendor key
   * by an unauthenticated caller (hazard P-9, trial and signup abuse).
   *
   * The caller must REFUSE this mode whenever a real key is configured.
   * Refusal lives here rather than in each route so the two TTS surfaces cannot
   * drift apart, which is the whole reason this module is shared.
   */
  | { mode: "anonymous"; reason: string };

/** True when this resolution must not be allowed to spend a vendor key. */
export function isAnonymousUnmetered(res: TtsKeyResolution): boolean {
  return res.mode === "anonymous";
}

export async function resolveTtsKey(): Promise<TtsKeyResolution> {
  if (env.elevenLabsDryRun) return { mode: "unmetered" };
  const profile = await getProfile();
  if (!profile) {
    // Signed out. Never hand an anonymous caller the platform key: there is no
    // UserProfile row to charge, so `consumeCharQuota` has nothing to
    // decrement and would return ok:true forever.
    return env.elevenLabsApiKey
      ? {
          mode: "anonymous",
          reason: "sign in to use the platform voice key, or supply your own key",
        }
      : { mode: "unmetered" };
  }

  const row = await db.userProfile.findUnique({
    where: { userId: profile.userId },
    select: { userId: true, elevenKeyEnc: true, ttsCharsDate: true, ttsCharsToday: true },
  });
  if (!row) {
    // The signed-in user has no profile row, so the per-user daily counter
    // cannot be charged. Same exposure as signed-out, so it is refused the
    // same way rather than silently falling through to the platform key.
    return env.elevenLabsApiKey
      ? { mode: "anonymous", reason: "voice quota is not provisioned for this account" }
      : { mode: "unmetered" };
  }

  if (row.elevenKeyEnc) {
    const key = decryptSecret(row.elevenKeyEnc);
    if (key) return { mode: "byok", keyOverride: key };
  }

  if (!env.elevenLabsApiKey) return { mode: "unmetered" };
  const today = new Date().toISOString().slice(0, 10);
  const usedToday = row.ttsCharsDate === today ? row.ttsCharsToday : 0;
  return { mode: "platform", userId: row.userId, usedToday };
}

/** Charge `text.length` chars against the daily platform-key budget.
 *
 *  Atomic: a single SQL UPDATE with a WHERE guard ensures two concurrent
 *  requests cannot both pass the limit check and both increment. If the
 *  date rolled over since the last call, the counter resets to the new
 *  charge instead of adding to the stale total. */
export async function consumeCharQuota(
  res: TtsKeyResolution,
  text: string,
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
    WHERE "userId" = ${res.userId}
      AND ("ttsCharsDate" != ${today} OR "ttsCharsToday" + ${chars} <= ${dailyCharLimit()})
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
