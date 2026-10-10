/**
 * Pre-warm the call's audio cache while the carrier is still setting up.
 *
 * The gap this closes: between "Twilio accepted the call" (the DIALING state)
 * and "the customer says their first word" there are several seconds during
 * which nothing is being synthesised and everything could be. The dial worker
 * fires this at the dial transition — over the compose network, at
 * `POST /prewarm` on the voice-stream plane — so the synthesis of every FIXED
 * phrase happens before the customer answers, and the call's first words are a
 * cache read instead of a vendor round-trip.
 *
 * What this used to warm, and why that was moved: the buffered `tts()` cache
 * in src/lib/elevenlabs/client.ts. That cache is process-local, and the
 * streaming TTS transport (ElevenLabsStream) never reads it — so the warm-up
 * spent three synthesis calls filling a map that the live call could not see,
 * while the path the customer actually heard stayed cold. Warm audio now lives
 * in src/lib/voice/warm-audio.ts, keyed by phrase and read by the streaming
 * path itself.
 *
 * Deliberately not awaited by the caller. A warm-up that delayed the stream's
 * `connected` frame would make the product worse to fix a latency problem: the
 * carrier's own setup would wait on our synthesis. Fire it, log it, move on.
 *
 * Failure is not an error. Warming costs a handful of synthesis calls; failing
 * to warm costs them later on the critical path. Neither is worth failing a
 * call over, and a warm-up that is allowed to fail loudly becomes one that
 * gets disabled.
 */
import type { TtsLang } from "@/lib/elevenlabs/client";
import { warmPhrases, warmStats } from "@/lib/voice/warm-audio";
import { warmablePhrases } from "@/lib/voice/backchannel";
import { logInfo } from "@/lib/validation/safe-log";

export type WarmResult = { warmed: number; failed: number };

/**
 * Warm the fixed phrases for a language.
 *
 * Sequentially, not in parallel: a burst of concurrent synthesis requests on
 * call setup is exactly the shape a provider rate limiter punishes, and the
 * last one failing is a worse outcome than taking an extra 300 ms.
 */
export async function prewarmCall(
  lang: TtsLang,
  callerId: string,
  callRef = "prewarm",
): Promise<WarmResult> {
  const phrases = warmablePhrases(lang as never);
  const result = await warmPhrases(lang, phrases);
  if (result.warmed > 0 || result.failed > 0) {
    logInfo("[voice] pre-warm complete", {
      lang,
      callRef,
      callerId,
      warmed: result.warmed,
      failed: result.failed,
    });
  }
  return result;
}

/** Fire-and-forget wrapper for call setup. Never rejects. */
export function startPrewarm(lang: TtsLang, callSid: string): void {
  void prewarmCall(lang, `prewarm:${callSid}`, callSid).catch(() => {
    /* already logged inside */
  });
}

/** Snapshot for the prewarm endpoint and for operators. */
export { warmStats };
