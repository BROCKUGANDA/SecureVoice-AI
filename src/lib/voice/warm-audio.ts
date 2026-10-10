/**
 * Warm audio — the process-local cache that makes the fixed parts of a fraud
 * call instant.
 *
 * ## The gap this closes
 *
 * The first audio out of the agent has a budget of roughly a second and a
 * quarter (see src/lib/telemetry/spans.ts: `answered_to_first_agent_word`,
 * p95 target 1,200 ms). Most of what the agent says on a call is FIXED: the
 * opening, the hang-up-safe exit, the freeze confirmation, the holding lines,
 * the never-ask refusal, the emergency fallback, the back-channel. Identical
 * bytes on every call — so synthesising them on the critical path is pure
 * waste, and the only question is WHEN the synthesis happens.
 *
 * The answer is: at the DIALING state, seconds before the customer answers,
 * triggered by the dial worker over the compose network
 * (`POST /prewarm` on the voice-stream plane, see src/worker/voice-stream.ts).
 * Between "carrier accepted the call" and "customer says hello" there are
 * several seconds of dead air in which nothing needs the CPU.
 *
 * ## Why a cache and not a pooled socket
 *
 * ElevenLabs' time-to-first-byte (~250 ms in the budget table) is per-request;
 * it cannot be amortised across calls by holding a connection open. What CAN
 * be amortised is the synthesis itself: mulaw-encoded audio for a fixed phrase
 * never changes, so the first call of the day pays for it and every call after
 * that reads it from memory in microseconds. The Deepgram half of the pre-warm
 * — the socket, which genuinely can be pooled — lives in
 * `preconnectDeepgram` (src/lib/voice/deepgram-client.ts).
 *
 * ## The contract
 *
 *   · Keyed by the RAW phrase text. The stored audio is the speech gate's
 *     rendering of that text — sanitizeShariah then prepareSpeech, the exact
 *     pipeline `safeTtsStream` runs on a live turn — so a cache hit is
 *     byte-identical to a cache miss, and the two can never drift.
 *   · Bounded: `MAX_ENTRIES_PER_LANG` phrases per language, oldest evicted.
 *     A fixed vocabulary cannot exceed it.
 *   · Never throws and never blocks a call: warming happens off the call path,
 *     a miss simply synthesises as before, and the counters are exported so the
 *     observability the pitch promises is real rather than decorative.
 */

import { createHash } from "node:crypto";

import { env } from "@/lib/config";
import type { TtsLang } from "@/lib/elevenlabs/client";
import { resolveTtsModel } from "@/lib/elevenlabs/client";
import { sanitizeShariah } from "@/lib/compliance/shariah-filter";
import { ElevenLabsStream } from "./elevenlabs-stream";

/** Phrases held per language before the oldest is evicted. */
export const MAX_ENTRIES_PER_LANG = 32;

/** Per-phrase synthesis ceiling while warming. A hung vendor call must not
 *  hold the warm loop open forever; abandoning it costs one cold phrase. */
export const WARM_PHRASE_TIMEOUT_MS = 5_000;

/** A synthesizer, injectable so tests never touch the network. It takes the
 *  language so the default can resolve the per-language voice and model from
 *  the same tables the call path uses. */
export type PhraseSynthesizer = (lang: TtsLang, text: string) => AsyncGenerator<Buffer>;

export type WarmStats = {
  /** Phrases currently cached, across all languages. */
  entries: number;
  /** Successful warm syntheses since start (or last reset). */
  warmed: number;
  /** Failed or skipped warm syntheses. */
  failed: number;
  /** Cache reads that served audio. */
  hits: number;
  /** Cache reads that missed and fell through to synthesis. */
  misses: number;
};

const cache = new Map<TtsLang, Map<string, Buffer[]>>();

const stats = { warmed: 0, failed: 0, hits: 0, misses: 0 };

/**
 * The default synthesizer: the same transport the call path uses, with the
 * voice and model resolved from the same tables (resolveTtsModel — the pinned
 * Urdu/Swahili fix), so a warmed entry and a live utterance are the same bytes
 * through the same gate.
 */
const defaultSynthesizer: PhraseSynthesizer = async function* (lang, text) {
  const voice = env.voiceFor(lang);
  // No configured voice for this language is a legitimate no-op, not an
  // error: the warm is skipped and the call proceeds cold rather than failing
  // a synthesis that was never going to succeed.
  if (!voice) return;
  const stream = new ElevenLabsStream();
  yield* stream.streamText(sanitizeShariah(text), {
    apiKey: env.elevenLabsApiKey ?? "",
    voiceId: voice,
    modelId: resolveTtsModel(lang),
    language: lang,
  });
};

let synthesizer: PhraseSynthesizer = defaultSynthesizer;

export function warmKey(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function bucketFor(lang: TtsLang): Map<string, Buffer[]> {
  let bucket = cache.get(lang);
  if (!bucket) {
    bucket = new Map();
    cache.set(lang, bucket);
  }
  return bucket;
}

/** Cached mulaw chunks for a phrase, or null. Counts the hit/miss. */
export function getWarmChunks(lang: TtsLang, text: string): Buffer[] | null {
  const hit = cache.get(lang)?.get(warmKey(text));
  if (hit && hit.length > 0) {
    stats.hits += 1;
    return hit;
  }
  stats.misses += 1;
  return null;
}

/** Does the cache hold audio for this phrase right now? (No counters moved.) */
export function hasWarmChunks(lang: TtsLang, text: string): boolean {
  const hit = cache.get(lang)?.get(warmKey(text));
  return !!hit && hit.length > 0;
}

/** Store chunks, evicting the oldest entry past the per-language cap. */
export function storeWarmChunks(lang: TtsLang, text: string, chunks: readonly Buffer[]): void {
  if (chunks.length === 0) return;
  const bucket = bucketFor(lang);
  bucket.set(warmKey(text), [...chunks]);
  while (bucket.size > MAX_ENTRIES_PER_LANG) {
    const oldest = bucket.keys().next();
    if (oldest.done) break;
    bucket.delete(oldest.value);
  }
}

/**
 * Synthesise one phrase into the cache. Returns true when audio is stored.
 *
 * Sequential by the caller (see prewarm.ts): a burst of concurrent synthesis
 * requests at call setup is the shape a provider rate limiter punishes.
 */
export async function warmPhrase(lang: TtsLang, text: string): Promise<boolean> {
  if (!text) return false;
  try {
    const chunks: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
    }, WARM_PHRASE_TIMEOUT_MS);
    try {
      for await (const chunk of synthesizer(lang, text)) {
        if (timedOut) break;
        chunks.push(chunk);
      }
    } finally {
      clearTimeout(timer);
    }
    if (timedOut || chunks.length === 0) {
      stats.failed += 1;
      return false;
    }
    storeWarmChunks(lang, text, chunks);
    stats.warmed += 1;
    return true;
  } catch {
    stats.failed += 1;
    return false;
  }
}

/**
 * Warm every phrase in the list. Never rejects; a warm-up allowed to fail
 * loudly becomes one that gets disabled, and a failed warm only costs a cold
 * first call.
 */
export async function warmPhrases(
  lang: TtsLang,
  texts: readonly string[],
): Promise<{ warmed: number; failed: number }> {
  let warmed = 0;
  let failed = 0;
  for (const text of texts) {
    const ok = await warmPhrase(lang, text);
    if (ok) warmed += 1;
    else failed += 1;
  }
  return { warmed, failed };
}

export function warmStats(): WarmStats {
  let entries = 0;
  for (const bucket of cache.values()) entries += bucket.size;
  return {
    entries,
    warmed: stats.warmed,
    failed: stats.failed,
    hits: stats.hits,
    misses: stats.misses,
  };
}

/**
 * Test-only: swap the synthesizer and/or empty the cache. Production code
 * never calls this — the real synthesizer is the module default and stays.
 */
export function _setSynthesizerForTests(
  fn: ((lang: TtsLang, text: string) => AsyncGenerator<Buffer>) | null,
): void {
  synthesizer = fn ?? defaultSynthesizer;
}

/** Test-only: reset the cache and the counters. */
export function _resetWarmCache(): void {
  cache.clear();
  stats.warmed = 0;
  stats.failed = 0;
  stats.hits = 0;
  stats.misses = 0;
}
