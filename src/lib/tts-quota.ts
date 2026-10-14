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
import { env, dailyCharLimit, anonCharPerHour } from "@/lib/config";
import { consume as consumeRate, type ConsumeResult } from "@/lib/ratelimit";
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
   * A signed-out caller spending the platform key under a per-caller ceiling.
   *
   * This exists so the public demo can tell the truth. Without it, a visitor with
   * no session gets 401 from `/api/tts` and `voice-client` silently falls back to
   * the browser's `SpeechSynthesis` — the page still says the agent answered in a
   * neural voice, and the audio is the visitor's own operating system, in whatever
   * language their device happens to have. The claim and the artifact disagree, and
   * nobody can see the difference.
   *
   * There is no UserProfile row to charge, so the bound is the rate limiter's own
   * per-caller bucket sized in whole requests: `TTS_ANON_DAILY_CHAR_LIMIT /
   * MAX_TTS_CHARS` fills a day. Coarse deliberately — it caps what one anonymous
   * caller can drain, and it fails closed at 0 (the default), which is the previous
   * behaviour.
   *
   * Known sharp edge, inherited from `rateLimitId`: a request that arrives with no
   * resolvable client IP gets the literal id `anon`, so every such caller shares one
   * bucket. Through Caddy a real IP is always present, and a shared bucket only ever
   * makes the cap stricter, never looser.
   */
  /**
   * A signed-out caller spending the platform key under a per-caller ceiling.
   *
   * This exists so the public demo can tell the truth. Without it, a visitor with
   * no session gets 401 from `/api/tts` and `voice-client` silently falls back to
   * the browser's `SpeechSynthesis` — the page still says the agent answered in a
   * neural voice, and the audio is the visitor's own operating system, in whatever
   * language their device happens to have. The claim and the artifact disagree, and
   * nobody can see the difference.
   *
   * There is no UserProfile row to charge, so the bound is the limiter's own bucket,
   * charged in characters against `TTS_ANON_CHAR_LIMIT_PER_HOUR` — see
   * `anonCharPerHour()` for why that is an hourly per-caller ceiling rather than the
   * daily total the counter would give a signed-in tenant.
   *
   * Known sharp edge, inherited from `rateLimitId`: a request with no resolvable
   * client IP gets the literal id `anon`, so every such caller shares one bucket.
   * Through Caddy a real IP is always present, and a shared bucket only makes the
   * cap stricter, never looser.
   */
  | { mode: "anon"; charsPerHour: number }
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
 * Decide what an unmeterable caller may do: fall through when there is no platform
 * key to spend, allow a capped anonymous turn when the deployment opts in, refuse
 * otherwise.
 *
 * Shared by both refusal sites — signed out, and signed in with no profile row —
 * because they are the same exposure (nothing to charge) and two copies of the rule
 * would drift the first time one was edited.
 */
function anonOrRefuse(reason: string): TtsKeyResolution {
  if (!env.elevenLabsApiKey) return { mode: "unmetered" };
  const cap = anonCharPerHour();
  if (cap > 0) return { mode: "anon", charsPerHour: cap };
  return { mode: "anonymous", reason };
}

/**
 * Charge one synthesis against the anonymous per-caller ceiling.
 *
 * Lives here rather than in each route because the point of this module is that the
 * two TTS surfaces — buffered and streaming — cannot carry different policies for
 * the same spend. A cap enforced on `/api/tts` and not on `/api/tts/stream` is not a
 * cap; the demo would simply be served by the unmetered door.
 *
 * The bucket is charged in CHARACTERS, not requests: `cost` is the text length, the
 * same unit the signed-in daily counter uses, so a caller cannot spend the anonymous
 * allowance faster by sending many short requests.
 *
 * It returns the limiter's own result rather than a trimmed `{ok}` shape, because the
 * routes answer 429 from it and `rate-limit-headers` requires every bucket refusal to
 * emit `X-RateLimit-Limit` / `-Remaining` / `Retry-After`. A helper that swallowed the
 * capacity would force its callers to rebuild the trio by hand or omit it, and the
 * whole point of the shared type is that the shape cannot degrade per call site.
 */
export async function allowAnonTurn(
  res: Extract<TtsKeyResolution, { mode: "anon" }>,
  callerId: string,
  chars: number,
): Promise<ConsumeResult> {
  return consumeRate("tts-anon", callerId, chars, res.charsPerHour);
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
    // Signed out. There is no UserProfile row to charge, so `consumeCharQuota`
    // has nothing to decrement — the caller is either capped by the per-caller
    // limiter or refused, never simply allowed.
    return anonOrRefuse("sign in to use the platform voice key, or supply your own key");
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
    // cannot be charged. Same exposure as signed-out, so the same policy applies:
    // capped through the per-caller limiter, or refused — never allowed freely.
    return anonOrRefuse("voice quota is not provisioned for this account");
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
