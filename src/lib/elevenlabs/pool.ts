import "server-only";
/**
 * ElevenLabs multi-key pool — round-robin rotation with automatic failover.
 *
 * ## The gap this closes
 *
 * The single platform key has ONE monthly quota and ONE rate limit. When it is
 * rate-limited (429) or out of credits (422) every caller is dead until the
 * quota resets — which on a fraud line is the worst possible moment to be unable
 * to speak. Operators routinely hold several keys (a personal one, a team one, a
 * per-region one); the platform simply never used them together.
 *
 * This module makes the pool explicit. It reads `ELEVENLABS_KEY_1` …
 * `ELEVENLABS_KEY_8` (and, so a single-key deployment needs no re-keying, the
 * legacy `ELEVENLABS_API_KEY` as a pool of one), hands each synthesis to the
 * next available key in round-robin order, and on a key-HEALTH failure moves to
 * the next key instead of failing the call.
 *
 * ## Which failures rotate a key, and how long it is parked
 *
 *   · 429 rate-limited         → parked `POOL_RATE_LIMIT_COOLDOWN_MS`   (default 60 s)
 *   · 422 out-of-credits       → parked `POOL_CREDITS_COOLDOWN_MS`      (default 6 h)
 *   · 401 / 403 unauthorized   → parked `POOL_UNAUTHORIZED_COOLDOWN_MS` (default 1 h)
 *   · 0 / 5xx vendor or net    → parked `POOL_TRANSIENT_COOLDOWN_MS`    (default 5 s)
 *
 * A parked key is skipped until its cooldown elapses and is never removed, so
 * the pool heals itself without an operator action. A 4xx that is NOT one of the
 * key-health signals (a bad voice id, a malformed body) fails identically on
 * every key, so it aborts the rotation immediately rather than burning the pool.
 *
 * ## What this module deliberately does NOT do
 *
 *   · It does not fall back to another VENDOR. PlayHT (./playht.ts) and the
 *     pre-generated cues (./emergency-audio.ts) are separate, single-purpose
 *     modules; the ROUTE composes pool → PlayHT → emergency audio, so each
 *     layer's failure mode stays legible instead of buried in one mega-function.
 *   · It does not reserve the shared monthly budget. `billableChars: 0` is passed
 *     to the egress guard because the whole point of a pool is that each key has
 *     its OWN quota — metering every key against the single platform ceiling
 *     would cap the pool at 10k chars/month however many keys it holds. Per-key
 *     spend is measured by ./token-tracker.ts instead.
 *
 * Every attempt still runs through the shared egress guard
 * (src/lib/elevenlabs/egress.ts), so the per-caller throttle, the
 * conversation-plane breaker, the jittered retry ladder and the commercial-use
 * attestation apply to each key exactly as they do to the single-key path.
 */

import { env } from "@/lib/config";
import { fetchUpstreamBinary } from "@/lib/elevenlabs/egress";
import { trackKeyUsage } from "@/lib/elevenlabs/token-tracker";
import { logWarn } from "@/lib/validation/safe-log";

/** How many numbered keys the pool reads: `ELEVENLABS_KEY_1` … `ELEVENLABS_KEY_8`. */
export const POOL_SIZE = 8;

/* ── Env helpers ───────────────────────────────────────────────────────────── */

/**
 * Numeric env reader. Read per call, not frozen at import: a redeploy-free
 * config change has to take effect, and a suite that sets a variable after the
 * module is first imported must still see it. Same contract as `numSetting` in
 * src/lib/config.ts — a finite, non-negative number wins; anything else takes
 * the documented default.
 */
function numEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/* ── Public shapes ─────────────────────────────────────────────────────────── */

/** One member of the pool. The `key` is the secret and is never logged. */
export type PoolKey = { label: string; key: string };

/**
 * The observability view of one key. It carries the LABEL, never the key value —
 * an operator dashboard, a health endpoint or a log line built from this can be
 * published without leaking a credential.
 */
export type PoolStatusEntry = {
  /** `key_1` … `key_8`, or `primary` for the legacy single-key deployment. */
  label: string;
  /** 1-based position in the pool, in rotation order. */
  index: number;
  /** True when the key is past its cooldown and may serve a request now. */
  available: boolean;
  /** Milliseconds until the key is eligible again (0 when available). */
  cooldownRemainingMs: number;
  consecutiveFailures: number;
  totalUses: number;
  totalFailures: number;
  /** Upstream status of the most recent attempt, or null if never used. */
  lastStatus: number | null;
  lastUsedAt: number | null;
  /** Why the key was last parked, or null when it is healthy. */
  disabledReason: string | null;
};

export type PoolAudioResult = {
  audio: Buffer;
  contentType: string;
  bytes: number;
  /** Label of the key that served the audio (`key_3`), never the key itself. */
  key: string;
  /** How many keys were attempted before one succeeded. */
  attempts: number;
  model: string;
};

/** Thrown when no key could serve the request. Carries the last upstream status. */
export class PoolExhaustedError extends Error {
  status: number;
  attempts: number;
  constructor(message: string, status: number, attempts: number) {
    super(message);
    this.name = "PoolExhaustedError";
    this.status = status;
    this.attempts = attempts;
  }
}

/* ── Pool state ────────────────────────────────────────────────────────────── */

type PoolSlot = {
  label: string;
  key: string;
  /** Epoch ms until which the key is parked; 0 means available. */
  cooldownUntil: number;
  consecutiveFailures: number;
  totalUses: number;
  totalFailures: number;
  lastStatus: number | null;
  lastUsedAt: number | null;
  disabledReason: string | null;
};

/**
 * Statuses that mean "THIS KEY is unhealthy, try the next one". Everything else
 * that is not a 2xx is a request-shaped failure that every key would repeat.
 * `0` is the egress guard's marker for a transport-level failure (no HTTP status
 * at all).
 */
const ROTATABLE_STATUS = new Set<number>([0, 401, 403, 422, 429, 500, 502, 503, 504, 529]);

/**
 * Read the configured keys, in rotation order, de-duplicated by value.
 *
 * `ELEVENLABS_API_KEY` is appended as `primary` rather than replacing the pool:
 * a deployment that only ever had the single key gets a pool of one and the
 * failover path is exercised with no re-keying, while a deployment that adds
 * numbered keys keeps using its original key too. Two identical values collapse
 * to one member — rotating onto a key that is the same key is not a failover.
 */
function readPoolKeys(): PoolKey[] {
  const out: PoolKey[] = [];
  const seen = new Set<string>();
  for (let i = 1; i <= POOL_SIZE; i++) {
    const raw = (process.env[`ELEVENLABS_KEY_${i}`] ?? "").trim();
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    out.push({ label: `key_${i}`, key: raw });
  }
  const primary = (env.elevenLabsApiKey ?? "").trim();
  if (primary && !seen.has(primary)) out.push({ label: "primary", key: primary });
  return out;
}

function newSlot(k: PoolKey): PoolSlot {
  return {
    label: k.label,
    key: k.key,
    cooldownUntil: 0,
    consecutiveFailures: 0,
    totalUses: 0,
    totalFailures: 0,
    lastStatus: null,
    lastUsedAt: null,
    disabledReason: null,
  };
}

let slots: PoolSlot[] = [];
/** Identifies the key set the current `slots` were built from. Never logged. */
let poolSignature = "";
/** Round-robin cursor: the index the NEXT call starts its search from. */
let cursor = 0;

/**
 * Rebuild the slot list when the configured key set changes, preserving the
 * state of members that survived (an env change mid-process, a new key added at
 * runtime, a test that sets variables after import). A label whose VALUE changed
 * is treated as a new member — the cooldown of the old key is not the cooldown
 * of the new one.
 */
function ensurePool(): PoolSlot[] {
  const keys = readPoolKeys();
  const signature = keys.map((k) => `${k.label}:${k.key}`).join("|");
  if (signature === poolSignature) return slots;

  const previous = new Map(slots.map((s) => [s.label, s]));
  slots = keys.map((k) => {
    const prev = previous.get(k.label);
    return prev && prev.key === k.key ? prev : newSlot(k);
  });
  cursor = slots.length ? cursor % slots.length : 0;
  poolSignature = signature;
  return slots;
}

/* ── Failure classification ────────────────────────────────────────────────── */

/** How long a key is parked after a given upstream status. */
function cooldownFor(status: number): number {
  if (status === 429) return numEnv("POOL_RATE_LIMIT_COOLDOWN_MS", 60_000);
  if (status === 422) return numEnv("POOL_CREDITS_COOLDOWN_MS", 21_600_000);
  if (status === 401 || status === 403) return numEnv("POOL_UNAUTHORIZED_COOLDOWN_MS", 3_600_000);
  if (status === 0 || status >= 500) return numEnv("POOL_TRANSIENT_COOLDOWN_MS", 5_000);
  return 0;
}

/** The operator-facing reason a key was parked. */
function reasonFor(status: number): string {
  if (status === 429) return "rate_limited";
  if (status === 422) return "out_of_credits";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 0) return "network";
  return `upstream_${status}`;
}

/**
 * Is this 429 OUR egress throttle rather than the vendor's per-key limit?
 *
 * The throttle is keyed on the CALLER, not the key, so it is shared by every
 * member of the pool. Parking a key for a refusal the key never saw would, after
 * a few bursts, park the whole pool — a self-inflicted outage dressed up as
 * failover. The guard's refusal body is the one stable signal available, so it
 * is matched exactly rather than heuristically.
 */
function isLocalThrottleRefusal(body: string): boolean {
  return /egress throttle exceeded/i.test(body);
}

/* ── State transitions ─────────────────────────────────────────────────────── */

function recordSuccess(slot: PoolSlot): void {
  slot.consecutiveFailures = 0;
  slot.cooldownUntil = 0;
  slot.disabledReason = null;
  slot.totalUses += 1;
  slot.lastStatus = 200;
  slot.lastUsedAt = Date.now();
}

function recordFailure(slot: PoolSlot, status: number, body: string): void {
  slot.consecutiveFailures += 1;
  slot.totalFailures += 1;
  slot.lastStatus = status;
  slot.disabledReason = reasonFor(status);
  const ms = cooldownFor(status);
  if (ms > 0) slot.cooldownUntil = Date.now() + ms;
  // Static message, structured fields — never the key, never the request text.
  logWarn("[elevenlabs/pool] key parked", {
    label: slot.label,
    status,
    reason: slot.disabledReason,
    cooldownMs: ms,
    detail: body.slice(0, 160),
  });
}

/* ── Public surface ────────────────────────────────────────────────────────── */

/** Is at least one ElevenLabs key configured for the pool? */
export function isPoolConfigured(): boolean {
  return readPoolKeys().length > 0;
}

/**
 * The safe view of the pool. Exposed for a health/readiness endpoint or an
 * operator console; it contains no key material by construction.
 */
export function getPoolStatus(): PoolStatusEntry[] {
  const pool = ensurePool();
  const now = Date.now();
  return pool.map((s, i) => ({
    label: s.label,
    index: i + 1,
    available: now >= s.cooldownUntil,
    cooldownRemainingMs: Math.max(0, s.cooldownUntil - now),
    consecutiveFailures: s.consecutiveFailures,
    totalUses: s.totalUses,
    totalFailures: s.totalFailures,
    lastStatus: s.lastStatus,
    lastUsedAt: s.lastUsedAt,
    disabledReason: s.disabledReason,
  }));
}

/**
 * Synthesise `text` in `voiceId`, rotating across the pool until a key answers.
 *
 * @param text    The utterance. Must contain speakable content.
 * @param voiceId The ElevenLabs `voice_id` to synthesise with.
 * @param opts.callerId        Identity the egress throttle is keyed on.
 * @param opts.model           TTS model id. Defaults to `ELEVENLABS_MODEL`.
 *                             Callers voicing Urdu or Swahili should pass the
 *                             pinned model from `resolveTtsModel(lang)`.
 * @param opts.timeoutMs       Per-attempt timeout. Defaults to `ttsTimeoutMs`.
 * @param opts.maxRetriesPerKey In-key retries inside the egress guard. Defaults
 *                             to 0 when the pool has more than one key (cross-key
 *                             failover IS the retry) and to 2 for a pool of one.
 * @returns The audio bytes plus the label of the key that served them.
 * @throws  {PoolExhaustedError} when no key can serve the request.
 */
export async function generateAudioWithFailover(
  text: string,
  voiceId: string,
  opts: {
    callerId?: string;
    model?: string;
    timeoutMs?: number;
    maxRetriesPerKey?: number;
    speed?: number;
  } = {},
): Promise<PoolAudioResult> {
  const body = text ?? "";
  if (!body.trim()) throw new PoolExhaustedError("no text to synthesise", 422, 0);
  if (!voiceId) throw new PoolExhaustedError("no voice id supplied", 422, 0);

  const pool = ensurePool();
  if (pool.length === 0) {
    throw new PoolExhaustedError(
      "no ElevenLabs keys configured (set ELEVENLABS_KEY_1 … ELEVENLABS_KEY_8)",
      503,
      0,
    );
  }

  const model = opts.model ?? env.elevenLabsModel;
  const maxRetriesPerKey =
    opts.maxRetriesPerKey ?? numEnv("POOL_MAX_RETRIES_PER_KEY", pool.length > 1 ? 0 : 2);
  const callerId = opts.callerId ?? "elevenlabs-pool";

  const start = cursor % pool.length;
  let attempts = 0;
  let lastStatus = 0;
  let lastBody = "";

  for (let i = 0; i < pool.length; i++) {
    const idx = (start + i) % pool.length;
    const slot = pool[idx]!;
    if (Date.now() < slot.cooldownUntil) continue; // still parked

    attempts += 1;

    const res = await fetchUpstreamBinary(
      "POST",
      `/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      {
        headers: { "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({
          text: body,
          model_id: model,
          voice_settings: {
            stability: env.voiceStability,
            similarity_boost: env.voiceSimilarityBoost,
            use_speaker_boost: env.voiceUseSpeakerBoost,
            speed: opts.speed ?? env.voiceDefaultSpeed,
          },
        }),
        // Each pooled key carries its own quota; reserving the shared platform
        // budget here would cap the pool at one key's worth of characters.
        billableChars: 0,
        apiKey: slot.key,
        callerId,
        timeoutMs: opts.timeoutMs ?? env.ttsTimeoutMs,
        maxRetries: maxRetriesPerKey,
      },
    );

    if (res.ok) {
      const ab = await res.response.arrayBuffer();
      const buf = Buffer.from(new Uint8Array(ab));
      if (buf.length < 512) {
        // A 2xx with no audio is a vendor failure, not a success: park and rotate
        // rather than return silence to a live call.
        recordFailure(slot, 502, "empty audio");
        lastStatus = 502;
        lastBody = "empty audio";
        continue;
      }
      recordSuccess(slot);
      cursor = (idx + 1) % pool.length;
      // Per-key spend is measured here, not reserved against the shared budget.
      // Fire-and-forget: accounting must never be able to fail a synthesis.
      void trackKeyUsage(slot.key, body.length);
      return {
        audio: buf,
        contentType: res.response.headers.get("content-type") ?? "audio/mpeg",
        bytes: buf.length,
        key: slot.label,
        attempts,
        model,
      };
    }

    // Our own egress throttle is not the key's fault and would refuse every key
    // alike, so stop instead of cooling the whole pool.
    if (res.status === 429 && isLocalThrottleRefusal(res.body)) {
      throw new PoolExhaustedError("ElevenLabs egress throttle exceeded", 429, attempts);
    }

    recordFailure(slot, res.status, res.body);
    lastStatus = res.status;
    lastBody = res.body;

    if (!ROTATABLE_STATUS.has(res.status)) {
      // A request-shaped 4xx: every key answers the same way, so fail fast.
      throw new PoolExhaustedError(
        `ElevenLabs rejected the request (${res.status}): ${res.body.slice(0, 200)}`,
        res.status,
        attempts,
      );
    }
  }

  if (attempts === 0) {
    throw new PoolExhaustedError(`all ${pool.length} ElevenLabs key(s) are cooling down`, 503, 0);
  }
  throw new PoolExhaustedError(
    `all ${pool.length} ElevenLabs key(s) failed (last status ${lastStatus || "n/a"})${
      lastBody ? `: ${lastBody.slice(0, 200)}` : ""
    }`,
    lastStatus || 503,
    attempts,
  );
}

/**
 * Reset the pool's in-process state. Suites that drive the pool through several
 * failures need this, or a cooldown (or the cursor) leaks into the next test.
 */
export function _resetPoolForTest(): void {
  slots = [];
  poolSignature = "";
  cursor = 0;
}
