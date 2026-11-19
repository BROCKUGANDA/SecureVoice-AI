/**
 * Live speech-to-text behind one interface: the streaming provider choice is a
 * factory, not a call-site decision.
 *
 * WHY: Swahili has no Deepgram streaming model at all (Deepgram's vendor
 * table has no `sw`; the TTS side already learned the analogous lesson for
 * Urdu/Swahili playback). Sending a Swahili call to `language=multi` on
 * nova-2 produced nothing — `multi` there is Spanish+English only — the
 * register's own "deliberate quality reduction" was, on a live call, a silent
 * transcript void. ElevenLabs Scribe DOES serve Swahili, so the live ASR for
 * those languages is ElevenLabs, not Deepgram.
 *
 *   - `sw` (with an ElevenLabs key configured) → `ScribeLiveClient`: batch
 *     transcription behind silence-based finalization, shaped like the
 *     Deepgram stream's contract so the worker's turn accounting is unchanged.
 *   - everything else (and `sw` when no key is configured) → `DeepgramLiveClient`,
 *     the existing vendor. The fallback preserves today's behavior rather than
 *     failing the call when the ElevenLabs key is absent.
 *
 * Provider selection is exported (`asrProviderFor`) so the prewarm path can
 * skip parking a Deepgram socket for a language that never adopts it — a
 * parked-but-never-consumed socket bills for nothing.
 */

import { env } from "@/lib/config";
import {
  DeepgramLiveClient,
  type AsrListener,
  type TranscriptListener,
  type UtteranceEndListener,
} from "@/lib/voice/deepgram-client";
import { ScribeLiveClient } from "@/lib/voice/scribe-live-client";

/** The worker's ASR contract — what voice-stream.ts needs from a live client. */
export interface LiveAsrClient {
  onTranscript(fn: TranscriptListener): unknown;
  onUtteranceEnd(fn: UtteranceEndListener): unknown;
  onAsrEvent(fn: AsrListener): unknown;
  start(lang?: string): unknown;
  sendMulaw(buffer: Buffer): void;
  stop(): void;
}

export type AsrProvider = "deepgram" | "elevenlabs";

/**
 * Which ASR family serves this language. Pure and exported so the prewarm
 * path, the worker, and the tests all read the same answer.
 */
export function asrProviderFor(lang: string): AsrProvider {
  if (lang === "sw" && env.elevenLabsApiKey) return "elevenlabs";
  return "deepgram";
}

/**
 * Totally-transcribable ASR counts: the languages a live client must have a
 * real path for. Used as a tripwire against a platform language silently
 * falling to a `multi` bucket that cannot contain it.
 */
export function isLiveTranscribable(lang: string): boolean {
  // Every platform language pins on Deepgram EXCEPT sw, which is served by
  // ElevenLabs above. Anything else (unknown future language) is not.
  if (lang === "sw") return asrProviderFor(lang) === "elevenlabs";
  return true;
}

export function createLiveAsrClient(lang: string): LiveAsrClient {
  if (asrProviderFor(lang) === "elevenlabs") return new ScribeLiveClient();
  return new DeepgramLiveClient(env.deepgramApiKey ?? "");
}
