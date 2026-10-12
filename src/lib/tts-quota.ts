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
import { auth } from "@/lib/better-auth";
import { notify } from "@/lib/notifications";
import { headers } from "next/headers";

/**
 * The session's active organization id, or null.
 *
 * This is the server-derived tenant identity — read from the Better Auth session
 * row, never from a header or a body field. It is the single value that decides
 * which tenant's BYOK key applies.
 *
 * Returns null when signed out or when the session names no organization (the
 * shared namespace). A null orgId means "no tenant scope", which is a legitimate
 * state for a signed-in user who has not switched to an org — not an error.
 */
async function getActiveOrgId(): Promise<string | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.session.activeOrganizationId ?? null;
}

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

/**
 * A stored BYOK credential that no longer decrypts (an AUTH_SECRET rotation, or
 * a tampered row) degrades to the next key layer by deliberate ruling — the
 * ladder keeps the caller working. What it must never be is SILENT: the org
 * believes its own key is paying when the platform key is, and nothing tells
 * anyone to re-enter it. This writes one deduped admin alert per org per
 * 12-hour window; a failure in the alert pipeline must never fail the
 * resolution itself, so it is swallowed by design.
 */
async function alertUnreadableByok(
  orgId: string | null,
  scope: "organization" | "user",
): Promise<void> {
  try {
    await notify({
      orgId,
      alertType: "billing_anomaly",
      severity: "urgent",
      title: "Saved voice key could not be unlocked",
      body: `The ${scope}-level ElevenLabs key is stored but could not be decrypted — most likely an AUTH_SECRET rotation. Voice synthesis degraded to the next key layer; re-enter the key in Settings → API Keys.`,
      windowMinutes: 720,
    });
  } catch {
    // The degrade-and-continue ruling stands even if alerting is broken.
  }
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

  // ── Org-level BYOK (preferred) ────────────────────────────────────────────
  //
  // The organisation is the tenant boundary, so its own ElevenLabs key is the
  // first thing checked. A bank's fraud team shares one ElevenLabs account
  // across every analyst; the key belongs to the org, not to each user.
  //
  // The org key is read from the session's active organization, which is the
  // server-derived tenant identity — never from a header or a body field.
  const orgId = await getActiveOrgId();
  if (orgId) {
    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: { elevenKeyEnc: true },
    });
    if (org?.elevenKeyEnc) {
      const key = decryptSecret(org.elevenKeyEnc);
      if (key) return { mode: "byok", keyOverride: key };
      // Stored but unreadable: degrade (deliberate ruling — continuity), but
      // page the admins; silence here is how the platform pays forever.
      await alertUnreadableByok(orgId, "organization");
    }
  }

  // ── User-level BYOK (fallback) ────────────────────────────────────────────
  //
  // A user whose org has not configured an ElevenLabs key falls back to their
  // own. This is the pre-existing behaviour, preserved for backwards compat.
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
    // Same unreadable case at the user layer — degrade, but say so.
    await alertUnreadableByok(orgId, "user");
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
