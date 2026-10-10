/**
 * Deepgram live transcription client for Twilio Media Streams.
 *
 * Uses Deepgram's native WebSocket API directly, without the SDK, to avoid
 * adding a dependency that is not present in this project's installed modules.
 */

import { decodeMulaw } from "./mulaw-codec";

export type TranscriptListener = (text: string, isFinal: boolean) => void;

/**
 * Sockets opened before a call exists, waiting for one to need them.
 *
 * The dialing state — carrier accepted, customer has not answered — is the
 * only window in which ASR setup can happen for free. `preconnectDeepgram`
 * parks one socket per language there; `start()` adopts it if it is still
 * open (see the adoption note there). Keyed by the RESOLVED Deepgram language
 * (`multi` for Urdu/Swahili) because that is what goes in the URL.
 */
const pooledSockets = new Map<string, WebSocket>();

/**
 * Open a Deepgram socket now so the first call of this language can adopt it.
 *
 * Returns the socket (also parked), or null when one could not be opened —
 * a pre-connect failure is invisible to the call, which simply opens its own.
 * A socket that dies while parked removes itself from the pool on close, so
 * `start()` can never adopt a corpse.
 */
export function preconnectDeepgram(lang: string, apiKey: string): WebSocket | null {
  const dgLang = DeepgramLiveClient.PINNABLE_LANGS.has(lang) ? lang : "multi";
  // One pooled socket per language: adopting is first-come, and a queue of
  // parked sockets is a queue of idle billable streams.
  const existing = pooledSockets.get(dgLang);
  if (existing && existing.readyState === WebSocket.OPEN) return existing;
  if (existing) pooledSockets.delete(dgLang);

  const url =
    `wss://api.deepgram.com/v1/listen?model=nova-2&encoding=mulaw&sample_rate=8000` +
    `&language=${dgLang}&smart_format=true&interim_results=true`;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url, ["token", apiKey]);
  } catch {
    return null;
  }
  ws.onclose = () => {
    if (pooledSockets.get(dgLang) === ws) pooledSockets.delete(dgLang);
  };
  ws.onerror = () => {
    if (pooledSockets.get(dgLang) === ws) pooledSockets.delete(dgLang);
  };
  pooledSockets.set(dgLang, ws);
  return ws;
}

/** How many sockets are parked right now (for the prewarm endpoint's reply). */
export function pooledSocketCount(): number {
  let n = 0;
  for (const ws of pooledSockets.values()) if (ws.readyState === WebSocket.OPEN) n += 1;
  return n;
}

/** Test-only: drop the pool. */
export function _resetDeepgramPool(): void {
  for (const ws of pooledSockets.values()) {
    try {
      ws.close();
    } catch {
      // already closed
    }
  }
  pooledSockets.clear();
}

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

    // Adopt a pooled socket opened at the DIALING state when one is available
    // and still open. The handshake (~100–300 ms) is the only part of ASR
    // setup that can be moved off the critical path, and the dialing window
    // is exactly when to do it. A pooled socket that Deepgram has since
    // closed (idle timeout) simply falls through to a fresh connection — the
    // adoption is an optimisation, never a dependency.
    const pooled = pooledSockets.get(dgLang);
    if (pooled) {
      pooledSockets.delete(dgLang);
      if (pooled.readyState === WebSocket.OPEN) {
        this.ws = pooled;
      } else {
        // A dead pooled socket carries no listeners worth keeping; drop it.
        try {
          pooled.close();
        } catch {
          // already closing
        }
        this.ws = new WebSocket(url, ["token", this.apiKey]);
      }
    } else {
      this.ws = new WebSocket(url, ["token", this.apiKey]);
    }

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
