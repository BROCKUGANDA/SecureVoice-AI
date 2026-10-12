import "server-only";
/**
 * Emergency audio — the pre-generated cue that plays when NOTHING else can speak.
 *
 * ## The gap this closes
 *
 * The last line of defence on a fraud call is not silence. If the ElevenLabs pool
 * (./pool.ts) is exhausted AND the PlayHT fallback (./playht.ts) is unreachable,
 * a caller hears a dropped line — indistinguishable from a scammer hanging up,
 * which is exactly the wrong impression on a call whose whole purpose is to be
 * trusted. A short, recognisable cue tells the customer "the system is still
 * here, this is not a dead line" and buys the route a few seconds to recover or
 * to hand off to a human.
 *
 * ## Why the audio is generated, not shipped as files
 *
 * The three cues are fixed, short and non-speech, so they are synthesised once,
 * deterministically, into valid 16 kHz mono 16-bit PCM WAV buffers the first time
 * each is asked for and cached for the life of the process. That keeps the
 * deliverable self-contained (no binary blobs in the repo, no build step) and
 * byte-identical on every call — the same reasoning as `SILENT_WAV` in
 * ./client.ts, which this module generalises.
 *
 * The cues are deliberately non-speech: a spoken phrase would have to pick a
 * language, and a caller who does not speak it is back to not understanding. A
 * distinct tone is language-neutral.
 *
 * ## The three cues
 *
 *   · `error`  — a descending two-tone: the recognisable "that did not work".
 *   · `retry`  — an ascending two-tone: "still trying, please hold".
 *   · `silent` — one second of silence, for the case where even a cue is wrong
 *                (the caller is already hearing carrier hold music, or the route
 *                needs to pad a gap without drawing attention to it).
 */

/** The cue types this module can produce. */
export type EmergencyAudioType = "error" | "retry" | "silent";

/** Every cue type, for a caller that wants to enumerate them. */
export const EMERGENCY_AUDIO_TYPES: readonly EmergencyAudioType[] = [
  "error",
  "retry",
  "silent",
] as const;

/** Every cue is a WAV, so the route can label the response without guessing. */
export const EMERGENCY_AUDIO_CONTENT_TYPE = "audio/wav";

/** Sample rate of every cue. 16 kHz mono PCM is what the voice plane already uses. */
export const EMERGENCY_SAMPLE_RATE = 16_000;

/** Narrowing guard for a value arriving from a query string or a queue message. */
export function isEmergencyAudioType(value: unknown): value is EmergencyAudioType {
  return typeof value === "string" && (EMERGENCY_AUDIO_TYPES as readonly string[]).includes(value);
}

/* ── WAV synthesis ─────────────────────────────────────────────────────────── */

/**
 * Wrap mono 16-bit PCM samples in a canonical 44-byte WAV header. Identical
 * header arithmetic to `SILENT_WAV` in ./client.ts, so both produce files the
 * same players accept.
 */
function buildWav(samples: Int16Array, sampleRate: number): Buffer {
  const dataSize = samples.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i]!, 44 + i * 2);
  return buf;
}

/**
 * A single sine tone with a 5 ms fade in/out. The fade is not cosmetic: a tone
 * that starts or stops at a non-zero sample clicks, and a click on a phone line
 * sounds like a fault.
 */
function tone(freq: number, ms: number, sampleRate: number, amplitude = 0.35): Int16Array {
  const n = Math.max(1, Math.round((ms / 1000) * sampleRate));
  const peak = Math.max(1, Math.round(amplitude * 32767));
  const fadeSamples = Math.max(1, Math.round(0.005 * sampleRate));
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const fade = Math.min(1, i / fadeSamples, (n - i) / fadeSamples);
    out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * peak * fade);
  }
  return out;
}

/** A run of silence. `Buffer.alloc` already zeroes the data section. */
function silence(ms: number, sampleRate: number): Int16Array {
  return new Int16Array(Math.max(1, Math.round((ms / 1000) * sampleRate)));
}

/** Concatenate sample runs into one PCM buffer. */
function concat(parts: readonly Int16Array[]): Int16Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/* ── Cue definitions ───────────────────────────────────────────────────────── */

/** Render one cue to WAV bytes. Pure; the cache below is the only state. */
function renderCue(type: EmergencyAudioType): Buffer {
  const sr = EMERGENCY_SAMPLE_RATE;
  switch (type) {
    case "error":
      // Descending: 480 Hz → 360 Hz, ~0.48 s total.
      return buildWav(concat([tone(480, 180, sr), silence(40, sr), tone(360, 260, sr)]), sr);
    case "retry":
      // Ascending: 620 Hz → 780 Hz, ~0.38 s total.
      return buildWav(concat([tone(620, 140, sr), silence(60, sr), tone(780, 180, sr)]), sr);
    case "silent":
      return buildWav(silence(1_000, sr), sr);
  }
}

const cache = new Map<EmergencyAudioType, Buffer>();

/**
 * The WAV bytes for a cue.
 *
 * The returned buffer is the cached, shared instance and MUST be treated as
 * read-only — the same contract `SILENT_WAV` has in ./client.ts. Callers hand it
 * to a player or a Twilio `<Play>`; none of them mutate it.
 */
export function getEmergencyAudio(type: EmergencyAudioType): Buffer {
  const hit = cache.get(type);
  if (hit) return hit;
  const buf = renderCue(type);
  cache.set(type, buf);
  return buf;
}

/** Byte length of a cue, without forcing the caller to hold the buffer. */
export function emergencyAudioBytes(type: EmergencyAudioType): number {
  return getEmergencyAudio(type).length;
}
