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
   * Transport-level cancellation.
   *
   * `abort` ALONE was not cancellation, it was a flag checked between chunks —
   * specifically at the top of the read loop, AFTER `await reader.read()`
   * returned. So it could not interrupt a read already in flight, and there was no
   * AbortController and no `reader.cancel()` behind it at all.
   *
   * The consequence was not a slow stream, it was a WEDGED CALL: if the vendor
   * emitted one chunk and then stalled (TCP blackhole, or a barge-in while a read
   * was pending with nothing behind it), `reader.read()` never settled, so this
   * generator never returned, so `safeTtsStream` never resolved, so
   * `state.turnChain` never advanced and NO further transcript on that call ever
   * routed for the rest of it. The only thing that ended it was the worker's
   * 180 s hard cap.
   *
   * An abort signal the vendor SDK actually watches, plus an explicit
   * `reader.cancel()`, means a barge-in tears the socket down instead of waiting
   * for the vendor to notice.
   */
  private controller: AbortController | null = null;
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
    this.controller = new AbortController();

    // The last checkpoint before a model's words become a customer's audio.
    // This transport speaks improvised turn text, so the spoken-length cap
    // applies here by default; a caller that knows better can override it.
    const text = prepareSpeech(rawText, {
      ...opts.speech,
      maxWords: opts.speech?.maxWords ?? MAX_SPEECH_WORDS,
    }).text;
    if (!text) return;

    // ElevenLabs ToS §1(c)(i) confines a Free User to non-commercial use and PUP
    // §9(a) names commercial use on a free account as prohibited, so a deployment
    // has to attest its plan before it spends the key on a customer. `egress.ts`
    // has enforced that on the app plane from the start; this generator is the
    // repo's other socket to the same vendor, and the one that speaks into a live
    // call, so the rule is enforced here too rather than assumed.
    //
    // It throws instead of returning quietly: the worker catches, logs the reason,
    // and plays the emergency cue, so an unattested deployment still answers the
    // caller and an operator still finds out why the voice changed. A silent empty
    // stream would look like a vendor timeout.
    if (!env.commercialUseAttested) {
      throw new Error(
        "live ElevenLabs streaming requires ELEVENLABS_COMMERCIAL_USE=true; the free tier " +
          "permits non-commercial use only (ToS §1(c)(i), PUP §9(a))",
      );
    }

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
        // From the deployment's settings, not a literal. `config.ts` documents
        // why stability is 0.7 rather than 0.5 — this agent reads a money
        // decision back to a frightened cardholder, and lower stability means
        // more variance between utterances — and that reasoning did not reach
        // live call audio, because this file was the streaming path's only
        // writer of voice settings and it carried 0.5. `TTS_VOICE_STABILITY`
        // now moves the phone call as well as the console preview.
        voiceSettings: {
          stability: env.voiceStability,
          similarityBoost: env.voiceSimilarityBoost,
        },
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
        // Race the read against the abort signal. This is the line that makes
        // cancel() real: without it a pending `reader.read()` can outlive the
        // caller that wanted it gone, and every await downstream of it inherits
        // the stall. `controller.abort()` resolves the race, the reader is
        // cancelled in the finally, and the socket is actually closed.
        const { done, value } = await Promise.race([reader.read(), this.aborted()]);
        if (this.abort) break;
        if (done || this.abort) break;
        if (!value) continue;
        yield encodeMulaw(Buffer.from(value));
      }
    } finally {
      // Cancel the underlying body, not just release the lock: releasing a lock
      // while a stream is still open leaves the vendor socket streaming (and
      // billing) with nobody reading it.
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  /** Resolves as soon as this stream is cancelled; never rejects. */
  private aborted(): Promise<{ done: true; value?: undefined }> {
    return new Promise((resolve) => {
      if (this.abort) {
        resolve({ done: true });
        return;
      }
      this.controller?.signal.addEventListener("abort", () => resolve({ done: true }), {
        once: true,
      });
    });
  }

  /**
   * Stop this stream NOW.
   *
   * Sets the flag (so a loop between chunks exits promptly), aborts the signal
   * (so a loop blocked on a read exits immediately rather than whenever the
   * vendor next speaks), and cancels the reader (so the vendor socket is closed
   * rather than left streaming into nothing).
   */
  cancel() {
    this.abort = true;
    this.controller?.abort();
    this.controller = null;
  }
}
