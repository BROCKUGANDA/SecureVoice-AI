/**
 * ElevenLabs streaming TTS for Twilio Media Streams.
 *
 * Uses the installed SDK's public `textToSpeech.stream()` endpoint, which
 * returns a ReadableStream<Uint8Array>. We yield mulaw-encoded chunks.
 */

import { encodeMulaw } from "./mulaw-codec";
import { prepareSpeech, MAX_SPEECH_WORDS, type SpeechContext } from "@/lib/compliance/speech-gate";

export type TtsStreamOptions = {
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

export class ElevenLabsStream {
  private abort = false;

  async *streamText(rawText: string, opts: TtsStreamOptions): AsyncGenerator<Buffer> {
    this.abort = false;

    // The last checkpoint before a model's words become a customer's audio.
    // This transport speaks improvised turn text, so the spoken-length cap
    // applies here by default; a caller that knows better can override it.
    const text = prepareSpeech(rawText, {
      ...opts.speech,
      maxWords: opts.speech?.maxWords ?? MAX_SPEECH_WORDS,
    }).text;
    if (!text) return;

    const { ElevenLabsClient } = await import("@elevenlabs/elevenlabs-js");
    const client = new ElevenLabsClient({ apiKey: opts.apiKey });

    const result = await client.textToSpeech.stream(opts.voiceId, {
      text,
      modelId: opts.modelId ?? "eleven_multilingual_v2",
      outputFormat: "pcm_8000",
      voiceSettings: { stability: 0.5, similarityBoost: 0.75 },
      ...(opts.language ? { language: opts.language } : {}),
    });

    const reader = result.getReader();
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
