/**
 * ElevenLabs streaming TTS for Twilio Media Streams.
 *
 * Uses the installed SDK's public `textToSpeech.stream()` endpoint, which
 * returns a ReadableStream<Uint8Array>. We yield mulaw-encoded chunks.
 */

import { encodeMulaw } from "./mulaw-codec";

export type TtsStreamOptions = {
  apiKey: string;
  voiceId: string;
  modelId?: string;
  language?: string;
};

export class ElevenLabsStream {
  private abort = false;

  async *streamText(text: string, opts: TtsStreamOptions): AsyncGenerator<Buffer> {
    this.abort = false;

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
