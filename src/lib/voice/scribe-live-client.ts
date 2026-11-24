/**
 * Live Swahili STT via ElevenLabs Scribe — batch transcription behind
 * silence-based finalization, behind the same contract the worker already
 * codes against (`LiveAsrClient`).
 *
 * WHY THIS EXISTS: Deepgram has no Swahili streaming model (and `multi` on
 * nova-2 is Spanish+English only), so a Swahili call on Deepgram produced no
 * transcript. Scribe serves Swahili natively. Scribe is a REST batch API —
 * not a WebSocket stream — so "live" here means the deployment's existing
 * end-of-utterance discipline (silence window) segments the audio and scopes
 * one batch call per utterance:
 *
 *   sendMulaw frames accumulate; energy decides speech vs silence per frame;
 *   trailing silence ≥ the deployment's utterance-end window (the same value
 *   Deepgram's `utterance_end_ms` carried — one knob, one answer) finalizes
 *   the utterance: WAV → POST /v1/speech-to-text (language pinned Swahili)
 *   → `onTranscript(text, isFinal=true)` + `onUtteranceEnd`.
 *
 * Honesty rules, same as the Deepgram client:
 *   - `UtteranceEnd.lastWordEndMs` is the buffered audio duration — derived,
 *     not measured per word, and labeled as such. A span built from it is
 *     approximate, never fabricated.
 *   - A failed chunk is logged and dropped, never emitted as an empty final:
 *     an empty turn on a fraud call is worse than a missed one (silence is
 *     recoverable by the nudge machinery; a phantom turn is not).
 *   - `onAsrEvent` never emits "dead": a dropped chunk is not a dead
 *     transcriber (there is no socket to die), and the worker treats "dead"
 *     as "end the call". The liveness signal for this client is its absence
 *     of a socket, not a fake resilience event.
 *   - `stop()` discards the buffered tail, like a closed socket discarding
 *     unfinalized audio. Listeners are cleared first, so an in-flight batch
 *     that resolves afterwards finds nobody to call.
 */

import { env } from "@/lib/config";
import { decodeMulaw } from "@/lib/voice/mulaw-codec";
import type {
  AsrListener,
  TranscriptListener,
  UtteranceEndEvent,
  UtteranceEndListener,
} from "@/lib/voice/deepgram-client";
import { logWarn } from "@/lib/validation/safe-log";

/** Dep ships for tests: a fake transcriber bypasses the real vendor call. */
export type ScribeTranscriber = (wav: Buffer, languageCode: string) => Promise<string>;

async function elevenLabsTranscribe(wav: Buffer, languageCode: string): Promise<string> {
  const { elevenLabsStt } = await import("@/lib/elevenlabs/egress");
  const r = await elevenLabsStt(wav, "audio/wav", env.elevenLabsSttModel, {
    languageCode,
  });
  if (!r.ok) throw new Error(`ElevenLabs Scribe ${r.status}: ${r.body.slice(0, 160)}`);
  const data = (await r.response.json()) as { text?: unknown };
  return (data.text ?? "").toString().trim();
}

/** 8 kHz mono 16-bit WAV, little-endian — the shape Scribe's file endpoint eats. */
function wavFromPcm(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Silence threshold on 16-bit PCM frames, in RMS units over the int16 range.
 * Below is silence. Tuned loose (a quiet caller should still count as
 * speaking — a false silence cuts the utterance; a false speech just extends
 * the buffer): mixed-era browser code used ~-24dBFS, and -32dBFS (≈ 800) is
 * safer for the finalization direction.
 */
const SPEECH_RMS_THRESHOLD = 800;
/** Less than this of actual speech never becomes an utterance. */
const MIN_SPEECH_MS = 250;
/**
 * Force-finalize on babble: an unbroken 15 s of buffered audio is transcribed
 * rather than waiting for a silence that may never come (the Deepgram side
 * gets this from the provider's own cap; here it is ours to enforce).
 */
const MAX_BUFFER_MS = 15_000;
/** 8 kHz, one mulaw byte per sample → 8 bytes per millisecond of audio. */
const BYTES_PER_MS = 8;

function rmsOf(pcm: Buffer): number {
  const samples = pcm.length / 2;
  if (samples === 0) return 0;
  let sum = 0;
  for (let s = 0; s < samples; s += 8) {
    const v = pcm.readInt16LE(s * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / (samples / 8));
}

export class ScribeLiveClient {
  private listeners: TranscriptListener[] = [];
  private utteranceEndListeners: UtteranceEndListener[] = [];
  private asrListeners: AsrListener[] = [];
  private lang = "sw";
  private stopped = false;

  private chunks: Buffer[] = [];
  private bufferedMs = 0;
  private bufferedSpeechMs = 0;
  private trailingSilenceMs = 0;
  private firstAudioAtMs: number | null = null;
  private transcribing = false;

  constructor(private transcribe: ScribeTranscriber = elevenLabsTranscribe) {}

  onTranscript(fn: TranscriptListener) {
    this.listeners.push(fn);
    return this;
  }

  onUtteranceEnd(fn: UtteranceEndListener) {
    this.utteranceEndListeners.push(fn);
    return this;
  }

  onAsrEvent(fn: AsrListener) {
    this.asrListeners.push(fn);
    return this;
  }

  start(lang = "sw") {
    this.lang = lang;
  }

  sendMulaw(buffer: Buffer) {
    if (this.stopped) return;
    const pcm = decodeMulaw(buffer);
    if (this.firstAudioAtMs === null) this.firstAudioAtMs = Date.now();
    const frameMs = buffer.length / BYTES_PER_MS;
    if (rmsOf(pcm) > SPEECH_RMS_THRESHOLD) {
      this.bufferedSpeechMs += frameMs;
      this.trailingSilenceMs = 0;
    } else {
      this.trailingSilenceMs += frameMs;
    }
    this.bufferedMs += frameMs;
    this.chunks.push(pcm);

    const silenceMs = env.deepgramUtteranceEndMs;
    if (this.bufferedSpeechMs >= MIN_SPEECH_MS && this.trailingSilenceMs >= silenceMs) {
      void this.finalize();
    } else if (this.bufferedMs >= MAX_BUFFER_MS) {
      void this.finalize();
    }
  }

  private async finalize() {
    if (this.transcribing || this.stopped || this.bufferedMs === 0) return;
    this.transcribing = true;
    const pcm = Buffer.concat(this.chunks);
    const durationMs = this.bufferedMs;
    const firstAudio = this.firstAudioAtMs;
    this.chunks = [];
    this.bufferedMs = 0;
    this.bufferedSpeechMs = 0;
    this.trailingSilenceMs = 0;
    this.firstAudioAtMs = null;
    try {
      const text = await this.transcribe(wavFromPcm(pcm), this.lang);
      if (this.stopped || !text) return;
      for (const fn of this.listeners) {
        try {
          fn(text, true);
        } catch {
          // a listener that throws must not stop the others from hearing it
        }
      }
      const event: UtteranceEndEvent = {
        channel: 0,
        lastWordEndMs: durationMs,
        streamAudioStartedAtMs: firstAudio,
        receivedAtMs: Date.now(),
      };
      for (const fn of this.utteranceEndListeners) {
        try {
          fn(event);
        } catch {
          // same discipline
        }
      }
    } catch (err) {
      logWarn("[scribe-live] utterance transcription failed; chunk dropped", {
        error: err instanceof Error ? err.message : String(err),
      });
      // Dropped, never emitted empty. The liveness machinery (nudge/dead-air)
      // is the recovery path; a phantom empty final would be a phantom turn.
    } finally {
      this.transcribing = false;
    }
  }

  stop() {
    // Listeners first (same order as DeepgramLiveClient.stop): an in-flight
    // batch that resolves after the call has ended must find nobody to call.
    this.stopped = true;
    this.listeners = [];
    this.utteranceEndListeners = [];
    this.asrListeners = [];
    this.chunks = [];
    this.bufferedMs = 0;
    this.bufferedSpeechMs = 0;
    this.trailingSilenceMs = 0;
    this.firstAudioAtMs = null;
  }
}
