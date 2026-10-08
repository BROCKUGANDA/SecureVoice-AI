/**
 * Deepgram live transcription client for Twilio Media Streams.
 *
 * Uses Deepgram's native WebSocket API directly, without the SDK, to avoid
 * adding a dependency that is not present in this project's installed modules.
 */

import { decodeMulaw } from "./mulaw-codec";

export type TranscriptListener = (text: string, isFinal: boolean) => void;

export class DeepgramLiveClient {
  private ws: WebSocket | null = null;
  private listeners: TranscriptListener[] = [];

  constructor(private apiKey: string) {}

  onTranscript(fn: TranscriptListener) {
    this.listeners.push(fn);
    return this;
  }

  /**
   * Languages Deepgram nova-2 can pin. Anything else must be sent as `multi`.
   *
   * nova-2 has no Urdu or Swahili model, and pinning an unsupported code fails
   * the ENTIRE request with a 4xx — not a degraded transcript, a closed
   * socket. So those two go to `multi`, which does code-switching detection.
   * That is a real quality reduction and is stated rather than hidden: the
   * platform's primary ASR for those languages is ElevenLabs Scribe
   * (see src/app/api/asr/route.ts), which does cover them, and the router
   * accepts Urdu so a `multi` transcript that does come back is still
   * actionable.
   */
  static readonly PINNABLE_LANGS: ReadonlySet<string> = new Set([
    "en",
    "ar",
    "fr",
    "hi",
    "es",
    "de",
    "it",
    "pt",
    "nl",
    "ru",
  ]);

  start(lang = "en") {
    const dgLang = DeepgramLiveClient.PINNABLE_LANGS.has(lang) ? lang : "multi";
    const url =
      `wss://api.deepgram.com/v1/listen?model=nova-2&encoding=mulaw&sample_rate=8000` +
      `&language=${dgLang}&smart_format=true&interim_results=true`;

    this.ws = new WebSocket(url, ["token", this.apiKey]);

    this.ws.onopen = () => {
      // connection ready
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string);
        const transcript = data.channel?.alternatives?.[0]?.transcript;
        if (!transcript) return;
        const isFinal = data.is_final ?? false;
        for (const fn of this.listeners) {
          fn(transcript, isFinal);
        }
      } catch {
        // ignore non-JSON messages
      }
    };

    this.ws.onerror = (err) => {
      console.error("[deepgram] websocket error", err);
    };

    this.ws.onclose = () => {
      // connection closed
    };

    return this.ws;
  }

  sendMulaw(buffer: Buffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const pcm = decodeMulaw(buffer);
    this.ws.send(pcm);
  }

  stop() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.listeners = [];
  }
}
