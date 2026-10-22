import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  tts as elevenTts,
  UpstreamError,
  DEV_VOICES,
  allowedVoices,
  isProdVoiceMode,
  requestedVoice,
  resolveTtsModel,
  type TtsLang,
} from "@/lib/elevenlabs/client";
import { generateAudioWithFailover } from "@/lib/elevenlabs/pool";
import { generatePlayhtAudio, isPlayhtConfigured } from "@/lib/elevenlabs/playht";
import type { VoicePace } from "@/lib/voice/presets";
import { getEmergencyAudio, EMERGENCY_AUDIO_CONTENT_TYPE } from "@/lib/elevenlabs/emergency-audio";
import { consume as consumeRateLimit, rateLimitId, rateLimitHeaders } from "@/lib/ratelimit";
import { append as auditAppend } from "@/lib/audit-chain";
import { transcript as redactText } from "@/lib/redact";
import {
  resolveTtsKey,
  consumeCharQuota,
  quotaExceededResponse,
  allowAnonTurn,
} from "@/lib/tts-quota";
import { SUPPORTED_LANGS, env, maxTtsChars } from "@/lib/config";
import { makeFailure, type FailureCode, type FailureInit } from "@/lib/failures/envelope";
import { logError, parseJson } from "@/lib/validation/safe-log";
import { db } from "@/lib/db";
import { countRung } from "@/lib/voice/rung-counter";

function failure(code: FailureCode, init: FailureInit = {}): NextResponse {
  const f = makeFailure(code, init);
  return NextResponse.json(f.body, {
    status: f.status,
    headers: { ...f.headers, "Cache-Control": "no-store" },
  });
}

export const dynamic = "force-dynamic";

/**
 * Neural TTS — wrapped through the ElevenLabs client (cached, idempotent,
 * rate-limited). Server-side only (API keys never reach the browser).
 *
 * Voice request forms accepted (either works in either mode):
 *   - a language key "en" | "ar" | "hi" | "ur" → resolved to the configured
 *     voice for the current backend (dev slug, or ELEVENLABS_VOICE_* in prod)
 *   - an explicit voice id valid for the current backend (dev slugs in
 *     dry-run; configured ElevenLabs voice_ids in prod)
 */

const MAX_CHARS = maxTtsChars();

const schema = z.object({
  text: z.string().min(1).max(MAX_CHARS),
  /**
   * Explicit voice override: a configured voice id, a language key, or (dev mode)
   * a library slug. Optional — omit it and the voice is resolved from `lang` +
   * `role` through `deliveryVoice()`, which is what the demo and every quick
   * interaction do so that what they play is what a real caller would hear.
   */
  voice: z.string().min(1).max(64).optional(),
  /** Whose voice a line is in. On a live call the customer is a human. */
  role: z.enum(["agent", "customer"]).default("agent"),
  speed: z.number().min(0.5).max(2.0).optional(),
  lang: z.enum(SUPPORTED_LANGS).default("en"),
  pace: z.enum(["instant", "paced"]).optional().default("paced"),
  callRef: z.string().min(3).max(64).optional(),
  /**
   * Demo/scenario paths set this so the audio is the ElevenLabs agent voice and
   * nothing else. Strict mode refuses the PlayHT rung, the emergency cue and the
   * dry-run backend; the ElevenLabs key pool is still allowed because it is the
   * same voice on another key.
   */
  strict: z.boolean().optional().default(false),
});

/**
 * Voice resolution lives in `@/lib/elevenlabs/client` (`requestedVoice`,
 * `deliveryVoice`) so both TTS routes and the live call share one answer. The
 * streaming route used to carry a byte-identical copy of the table below, which
 * is how the demo could be wrong in two places at once.
 */

/**
 * Synthesize speech with a fallback ladder.
 *
 * A fraud call cannot afford silence. If the primary TTS provider fails, the
 * call must still speak — even if the voice is different, the quality is lower,
 * or the content is a pre-recorded cue. This function tries each rung in order:
 *
 *   1. Primary: `elevenTts()` with the resolved key (BYOK or platform).
 *   2. Fallback 1 (platform only): `generateAudioWithFailover()` — the ElevenLabs
 *      key pool. Only used when the caller is on the PLATFORM key, because a
 *      BYOK tenant is entitled to bill themselves and must not spend the
 *      platform's shared quota.
 *   3. Fallback 2: `generatePlayhtAudio()` — PlayHT, a separate vendor with
 *      its own credentials and rate limits.
 *   4. Fallback 3: `getEmergencyAudio("error")` — a pre-recorded WAV cue that
 *      tells the caller "the system is still here, this is not a dead line".
 *
 * Each rung is tried only if the previous one failed. The function returns the
 * audio bytes, content type, and metadata about which rung succeeded. If every
 * rung fails, the last error is re-thrown.
 *
 * The `failed` array is accumulated across rungs and returned to the caller so
 * the audit log can record which rungs were attempted and why they failed.
 */
/**
 * The one rung result that is not a result: the caller's budget ran out while this
 * attempt was still in flight. A symbol, so it can never be confused with an audio
 * buffer that happens to be empty.
 */
const BUDGET_EXHAUSTED = Symbol("tts-budget-exhausted");

/**
 * Ladder position of each source, for the `TtsSynthesis.rung` column. `byok` is
 * rung 1 because it IS the primary rung, reached with the tenant's own key; cache
 * hits never enter the ladder and are absent by design.
 */
const RUNG_BY_SOURCE: Record<string, number> = {
  elevenlabs: 1,
  byok: 1,
  "elevenlabs-pool": 2,
  playht: 3,
  emergency: 4,
};

/**
 * Await `work`, but stop waiting after `ms`.
 *
 * The abandoned call keeps running — it is a socket into a vendor, not a child
 * process we can kill — so this bounds the CALLER'S latency, not the spend. That is
 * the honest scope: the ladder's job on a live call is to put sound on the line
 * within a deadline, and a rung that answers after the deadline is worth less to the
 * customer than the emergency cue that would have played on time.
 */
async function withinBudget<T>(ms: number, work: Promise<T>): Promise<T | typeof BUDGET_EXHAUSTED> {
  if (ms <= 0) return BUDGET_EXHAUSTED;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof BUDGET_EXHAUSTED>((resolve) => {
        timer = setTimeout(() => resolve(BUDGET_EXHAUSTED), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function synthesizeWithLadder(args: {
  text: string;
  voice: string;
  lang: TtsLang;
  speed?: number;
  callerId: string;
  callRef: string;
  keyOverride?: string;
  model?: string;
  pace?: "instant" | "paced";
  strict?: boolean;
}): Promise<{
  audio: Buffer;
  contentType: string;
  bytes: number;
  source: string;
  degraded: boolean;
  failed: Array<{ rung: string; error: string }>;
}> {
  const { text, voice, lang, speed, callerId, callRef, keyOverride, model, pace, strict } = args;
  const failed: Array<{ rung: string; error: string }> = [];

  // The ladder's deadline, measured from here rather than from the HTTP request,
  // because the part the customer waits on is this function. Every rung below is
  // raced against what is left, and a rung with nothing left is not attempted —
  // it is recorded as skipped, which is the difference between "we tried everything
  // slowly" and "we stopped trying in time to say something".
  const budgetMs = env.ttsRequestBudgetMs;
  const startedAt = Date.now();
  const remainingMs = () => Math.max(0, budgetMs - (Date.now() - startedAt));
  const exhaustedLabel = (rung: string) =>
    `budget_exhausted: no time left in the ${budgetMs} ms ladder before ${rung}`;

  // Rung 1: primary ElevenLabs (BYOK or platform key).
  try {
    const raced = await withinBudget(
      remainingMs(),
      elevenTts({ text, voice, speed, lang, callerId, callRef, pace }, { keyOverride }),
    );
    if (raced === BUDGET_EXHAUSTED) {
      failed.push({ rung: "elevenlabs", error: exhaustedLabel("elevenlabs") });
    } else {
      return {
        audio: raced.audio,
        contentType: raced.contentType,
        bytes: raced.bytes,
        source: keyOverride ? "byok" : "elevenlabs",
        degraded: false,
        failed,
      };
    }
  } catch (err) {
    failed.push({
      rung: "elevenlabs",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Rung 2: ElevenLabs key pool (platform key only).
  //
  // A BYOK tenant has their own ElevenLabs account with its own quota. Sending
  // their traffic through the platform's key pool would spend the platform's
  // shared monthly quota on a call the tenant is entitled to bill themselves —
  // precisely the confusion the BYOK path exists to prevent.
  if (!keyOverride) {
    if (remainingMs() <= 0) {
      failed.push({ rung: "elevenlabs-pool", error: exhaustedLabel("elevenlabs-pool") });
    } else {
      try {
        const raced = await withinBudget(
          remainingMs(),
          generateAudioWithFailover(text, voice, {
            callerId,
            model: model ?? resolveTtsModel(lang),
            speed,
            pace: pace ?? "paced",
            lang,
          }),
        );
        if (raced === BUDGET_EXHAUSTED) {
          failed.push({ rung: "elevenlabs-pool", error: exhaustedLabel("elevenlabs-pool") });
        } else {
          return {
            audio: raced.audio,
            contentType: raced.contentType,
            bytes: raced.bytes,
            source: "elevenlabs-pool",
            // The pool is the same ElevenLabs product and voice on another
            // key. Strict mode accepts it; non-strict still flags the failover.
            degraded: strict ? false : true,
            failed,
          };
        }
      } catch (err) {
        failed.push({
          rung: "elevenlabs-pool",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Strict demo/scenario mode stops here: every rung above is ElevenLabs, and
  // every rung below is a different vendor or a non-speech cue. Returning a
  // PlayHT voice (or a tone) while the page claims the ElevenLabs agent voice
  // is the misrepresentation this mode exists to prevent.
  if (strict) {
    throw new UpstreamError(
      "Strict ElevenLabs mode: no ElevenLabs rung produced audio",
      503,
      "voice_strict_unavailable",
    );
  }

  // Rung 3: PlayHT.
  const playhtVoiceId = process.env.PLAYHT_VOICE_ID;
  if (isPlayhtConfigured() && playhtVoiceId) {
    if (remainingMs() <= 0) {
      failed.push({ rung: "playht", error: exhaustedLabel("playht") });
    } else {
      try {
        const raced = await withinBudget(
          remainingMs(),
          generatePlayhtAudio(text, playhtVoiceId, { callerId, speed }),
        );
        if (raced === BUDGET_EXHAUSTED) {
          failed.push({ rung: "playht", error: exhaustedLabel("playht") });
        } else {
          return {
            audio: raced.audio,
            contentType: raced.contentType,
            bytes: raced.bytes,
            source: "playht",
            degraded: true,
            failed,
          };
        }
      } catch (err) {
        failed.push({
          rung: "playht",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Rung 4: emergency audio.
  //
  // The last resort. A short, recognisable cue that tells the caller the system
  // is still here. It is not speech — it cannot convey the transaction details
  // — but it prevents the silence that a scammer's hangup would produce.
  const emergency = getEmergencyAudio("error");
  return {
    audio: emergency,
    contentType: EMERGENCY_AUDIO_CONTENT_TYPE,
    bytes: emergency.length,
    source: "emergency",
    degraded: true,
    failed,
  };
}

export async function POST(req: NextRequest) {
  const started = Date.now();
  const callerId = rateLimitId(req);

  // 1. Body parse + validation
  const body = await parseJson(req);
  if (body === null) return failure("malformed_request", { detail: "Invalid JSON body" });
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return failure("semantically_invalid", { detail: "Invalid TTS request" });
  }
  if (parsed.data.strict && !isProdVoiceMode()) {
    return failure("dependency_unavailable", {
      detail:
        "Strict ElevenLabs voice requested, but this deployment is in dry-run/no-key mode. " +
        "The demo will not substitute a dev or device voice.",
    });
  }
  const {
    text,
    speed,
    lang,
    callRef = `SV-T-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
  } = parsed.data;

  // 2. Resolve + validate the voice against the current backend's registry.
  //    An omitted `voice` is the normal path for the demo and every quick
  //    interaction: the language and role decide it through `deliveryVoice()`,
  //    the same resolver the live call uses.
  const role = parsed.data.role;
  const voice = requestedVoice(parsed.data.voice, lang, role);
  const allowed = allowedVoices();
  if (!allowed.has(voice)) {
    // The two ways to get here need different sentences. Nothing configured for
    // the language is a deployment gap and must name the variable to set; a bad
    // explicit override is the caller's mistake. Collapsing them would send an
    // operator hunting through request bodies for a missing env var.
    const detail = parsed.data.voice
      ? `Unknown voice '${parsed.data.voice}'. ${
          isProdVoiceMode()
            ? "voice must be a language key (en|ar|hi|ur|fr|sw) or a configured ElevenLabs voice_id"
            : `voice must be a language key (en|ar|hi|ur|fr|sw) or a dev voice (${[...DEV_VOICES].join(", ")})`
        }`
      : `No voice is configured for language '${lang}' in the ${role} role. Set ELEVENLABS_VOICE_${lang.toUpperCase()} — the demo will not silently borrow another language's production voice.`;
    return failure("semantically_invalid", { detail });
  }

  // 3. Rate-limit BEFORE the upstream call (the wrapper has its own, but a
  //    fast reject here keeps the audit log clean of "denied" entries)
  const rl = await consumeRateLimit("tts", callerId);
  if (!rl.ok) {
    return failure("rate_limited", {
      retryAfterSec: Math.ceil(rl.retryAfterMs / 1000),
      headers: rateLimitHeaders(rl),
    });
  }

  // 4. Synthesize via the wrapper (cached + idempotent + upstream).
  //    Key logic (per org): BYOK first — an operator's own ElevenLabs key has
  //    NO limits. Without BYOK, the platform demo key is metered at 2,000
  //    chars/day/user so a scraped link can't drain the shared quota.
  const keyRes = await resolveTtsKey();
  if (keyRes.mode === "anonymous") {
    // Refuse BEFORE any vendor call. An unauthenticated caller must not be able
    // to spend the platform's ElevenLabs key: there is no profile row to charge,
    // so the daily quota cannot be enforced and every request is free.
    return failure("unauthenticated", { detail: keyRes.reason });
  }
  if (keyRes.mode === "platform") {
    const charged = await consumeCharQuota(keyRes, text);
    if (!charged.ok) {
      return failure("rate_limited", {
        retryAfterSec: 3600,
        detail: quotaExceededResponse().error,
      });
    }
  }
  if (keyRes.mode === "anon") {
    // The public demo, under the deployment's anonymous ceiling. Refused here
    // rather than quietly downgraded: the caller is told the demo budget is spent,
    // and the browser fallback says what it is (see src/lib/voice-client.ts).
    // The limiter result is handed to `tooManyRequests` whole so the refusal carries
    // the canonical trio; rebuilding Retry-After here is what the header contract
    // in tests/unit/rate-limit-headers.test.ts exists to prevent.
    const rl = await allowAnonTurn(keyRes, callerId, text.length);
    if (!rl.ok) {
      return failure("rate_limited", {
        retryAfterSec: Math.ceil(rl.retryAfterMs / 1000),
        headers: rateLimitHeaders(rl),
        detail: "Demo voice budget spent — sign in, or supply your own ElevenLabs key.",
      });
    }
  }
  const keyOverride = keyRes.mode === "byok" ? keyRes.keyOverride : undefined;

  try {
    // Default to "paced" for agent-facing speech. Callers that pass no pace
    // get the deliberate, slightly-slower setting the pitch describes (see
    // `src/lib/deck.ts` and `src/lib/voice/presets.ts`). A caller that knows
    // exactly what it wants — e.g. the agent's filler/prompt path — passes
    // `pace: "instant"` explicitly.
    const pace = (parsed.data.pace as VoicePace | undefined) ?? "paced";
    const result = await synthesizeWithLadder({
      text,
      voice,
      lang,
      speed,
      callerId,
      callRef,
      keyOverride,
      pace,
      strict: parsed.data.strict,
    });

    // The served rung as a row, not only as text inside the audit's meta blob.
    // Until this existed, "how often did synthesis fall back to PlayHT last week"
    // could not be asked as a query at all. Fire-and-forget after the audio is
    // already being returned: an observability insert must never add latency to
    // the path whose latency it is measuring.
    countRung(result.source, result.degraded);
    void db.ttsSynthesis
      .create({
        data: {
          callRef,
          source: result.source,
          rung: RUNG_BY_SOURCE[result.source] ?? null,
          degraded: result.degraded,
          bytes: result.bytes,
          latencyMs: Date.now() - started,
        },
      })
      .catch((err) =>
        logError("[tts] synthesis row not persisted", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );

    // 5. Audit-chain append — redacted text only
    auditAppend({
      callRef,
      action: "tts",
      callerId,
      redactedText: redactText(text).slice(0, 200),
      meta: {
        lang,
        voice: result.source,
        bytes: result.bytes,
        cached: false,
        replayed: false,
        model: result.source,
        latencyMs: Date.now() - started,
        degraded: result.degraded,
        failed_rungs: result.failed,
      },
    }).catch((err) => {
      logError("[tts] audit append failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return new NextResponse(new Uint8Array(result.audio), {
      status: 200,
      headers: {
        "Content-Type": result.contentType,
        "Content-Length": String(result.bytes),
        "Cache-Control": "private, max-age=86400",
        "X-Voice-Source": result.source,
        "X-Voice-Degraded": result.degraded ? "true" : "false",
      },
    });
  } catch (err) {
    if (err instanceof UpstreamError) {
      // Error generalization: the upstream detail (provider, key state, raw
      // body) stays in server logs — clients get a coarse, safe message.
      logError("[tts] upstream error", { status: err.status, error: err.message });
      if (err.status === 429) {
        return failure("rate_limited", { retryAfterSec: 60 });
      }
      const generic =
        err.status === 401 || err.status === 403
          ? "Voice service authentication failed — contact the operator."
          : "Speech synthesis is temporarily unavailable — try again shortly.";
      return failure("dependency_unavailable", { detail: generic, retryAfterSec: 1 });
    }
    logError("[tts] generation failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return failure("dependency_unavailable", {
      detail: "Speech generation unavailable",
      retryAfterSec: 1,
    });
  }
}
