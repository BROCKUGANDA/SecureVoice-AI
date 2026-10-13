/**
 * ElevenLabs streaming TTS for Twilio Media Streams.
 *
 * Uses the installed SDK's public `textToSpeech.stream()` endpoint, which returns
 * a ReadableStream<Uint8Array>. We yield mulaw-encoded chunks.
 *
 * ## The key now comes from the pool
 *
 * This transport used to build its client from ONE `apiKey` argument, while
 * `src/lib/elevenlabs/pool.ts` — eight keys, round-robin, 60 s parking on a 429,
 * SIX HOURS on a 422 out-of-credits, per-key spend — sat behind the buffered
 * `/api/tts` and `/api/twilio/audio` routes. Which meant the calls that actually
 * reach a customer had no TTS failover at all: one exhausted key silenced every
 * live conversation while the demo endpoints rotated happily. The egress guard's
 * own header claimed to be the only code in the repo that opened a socket to
 * ElevenLabs; this file was opening one on the hot path, unmetered and
 * unrotated.
 *
 * Opening a stream is now one pooled attempt per key, in the same rotation and
 * against the same cooldown state as the buffered path — so a key that ran out
 * mid-call is parked for the console too, and vice versa.
 *
 * ## Only the OPEN rotates
 *
 * Once chunks are flowing, retrying would splice a second copy of half-spoken
 * audio into the customer's ear. So a failure AFTER the first byte is the call's
 * to end (the worker's first-audio deadline and `cancel()` own that), never a
 * reason to try the next key.
 */

import { encodeMulaw } from "./mulaw-codec";
import { prepareSpeech, MAX_SPEECH_WORDS, type SpeechContext } from "@/lib/compliance/speech-gate";
import { env } from "@/lib/config";
import { isPoolKey, streamWithKeyPool } from "@/lib/elevenlabs/pool";

export type TtsStreamOptions = {
  /**
   * The key the CALLER wants used first. When it is the platform key it is
   * already a pool member and no special case is needed; when it is a tenant's
   * own credential it gets the first attempt and the pool is the fallback.
   */
  apiKey: string;
  voiceId: string;
  modelId?: string;
  language?: string;
  /**
   * Tenant context for the speech gate. Redaction and speakability always run;
   * Islamic terminology substitution only when the tenant has declared itself a
   * Shariah-compliant institution. Callers that have an org on hand should pass
   * it — callers that do not still get the unconditional half of the gate.
   */
  speech?: SpeechContext;
};

/**
 * The HTTP status to attribute to an SDK failure, which is what decides whether
 * the pool rotates.
 *
 * Deliberately conservative: an unrecognisable error reads as `0`, and `0` is the
 * pool's marker for a transport-level fault — the one case that is always worth
 * trying another key for. Guessing a 4xx from prose would park a healthy key on a
 * message we merely failed to parse.
 */
function statusOfElevenLabsError(err: unknown): number {
  const e = err as { statusCode?: unknown; status?: unknown; message?: unknown };
  for (const candidate of [e?.statusCode, e?.status]) {
    if (typeof candidate === "number" && candidate >= 100 && candidate <= 599) return candidate;
  }
  const message = typeof e?.message === "string" ? e.message : String(err ?? "");
  const match = /\b([45]\d{2})\b/.exec(message);
  const code = match?.[1] ? Number(match[1]) : 0;
  return code >= 400 && code <= 599 ? code : 0;
}

export class ElevenLabsStream {
  private abort = false;
  /**
   * Label of the key that served the stream (`key_3`, `primary`, `caller`), never
   * the key itself. "Which account's audio did this call speak with" is the first
   * thing an operator asks when a quota runs out mid-month.
   */
  private served: string | null = null;

  get servedKey(): string | null {
    return this.served;
  }

  async *streamText(rawText: string, opts: TtsStreamOptions): AsyncGenerator<Buffer> {
    this.abort = false;
    this.served = null;

    // The last checkpoint before a model's words become a customer's audio.
    // This transport speaks improvised turn text, so the spoken-length cap
    // applies here by default; a caller that knows better can override it.
    const text = prepareSpeech(rawText, {
      ...opts.speech,
      maxWords: opts.speech?.maxWords ?? MAX_SPEECH_WORDS,
    }).text;
    if (!text) return;

    const { ElevenLabsClient } = await import("@elevenlabs/elevenlabs-js");
    // Never a literal: a caller that forgets `modelId` must still speak with the
    // model this deployment chose, not with whatever generation was current when
    // this line was written. See tests/unit/tts-model-resolution.test.ts.
    const modelId = opts.modelId ?? env.elevenLabsModel;
    const openOn = (apiKey: string) =>
      new ElevenLabsClient({ apiKey }).textToSpeech.stream(opts.voiceId, {
        text,
        modelId,
        outputFormat: "pcm_8000",
        voiceSettings: { stability: 0.5, similarityBoost: 0.75 },
        ...(opts.language ? { language: opts.language } : {}),
      });

    // A caller-named key that is not the platform's and is not already a pool
    // member is the tenant's own credential, and gets the first attempt outside
    // the pool's bookkeeping. Comparing VALUES rather than variable names matters
    // twice over: a deployment that points a tenant at the platform key has no
    // BYOK, and a tenant key that happens to also be one of ours must not get two
    // turns of the same queue.
    const preferred =
      opts.apiKey && opts.apiKey !== env.elevenLabsApiKey && !isPoolKey(opts.apiKey)
        ? { key: opts.apiKey, label: "caller" }
        : undefined;

    const opened = await streamWithKeyPool({
      open: openOn,
      statusOf: statusOfElevenLabsError,
      chars: text.length,
      preferred,
      onServed: (label) => {
        this.served = label;
      },
    });

    const reader = opened.value.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || this.abort) break;
        if (!value) continue;
        yield encodeMulaw(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
  }

  cancel() {
    this.abort = true;
  }
}
