/**
 * Client-side voice utilities — talks to the server-side neural TTS/ASR
 * endpoints (API keys stay server-side). Falls back to the browser's
 * SpeechSynthesis when the neural voice is unavailable.
 */
import type { CallLang } from "@/lib/scenario";

export type VoiceRole = "agent" | "customer";

/**
 * There is deliberately no voice table here.
 *
 * This file used to own `TTS_VOICE: language -> role -> ElevenLabs library slug`,
 * and the routes aliased those slugs back to languages. The alias was lossy: `fr`
 * and `sw` both mapped to the slug `jam`, which resolves to `en`, so a French or
 * Swahili demo line played the English deployment voice while a real caller heard
 * `ELEVENLABS_VOICE_FR` — and the demo's "customer" role borrowed the production
 * voice id of an unrelated language entirely.
 *
 * The client now names a language and a role and sends them. `requestedVoice()` in
 * `src/lib/elevenlabs/client.ts` decides what speaks, using the same table the live
 * call path uses, which is the only way a demo can be trusted to sound like the
 * product.
 */

/* ————— audio cache (object URLs, session-scoped) ————— */
/**
 * `degraded` is whether the server said it could NOT synthesize this and served
 * its last resort instead. The route returns HTTP 200 with `X-Voice-Degraded: true`
 * for that — the last resort is the two-tone "the line is still alive" cue, which
 * exists so a fraud call never goes silent mid-conversation. It is bigger than the
 * empty-response threshold below, so a caller that only checks `res.ok` and blob
 * size will play a test tone and believe it heard the agent's neural voice. On a
 * live call that is the right trade. In a demo it is a false statement about the
 * product, so the flag has to reach the caller that decides what to claim.
 */
type Speech = { url: string; degraded: boolean };

/**
 * Stands in of a playable URL when the server could not synthesise.
 *
 * /api/tts answers 200 with real bytes when every rung of its fallback ladder fails:
 * the body is the pre-recorded hold cue, deliberately larger than the 512-byte floor
 * the check below enforces, because on a live fraud call a tone beats silence. The
 * route marks that response `X-Voice-Degraded: true`, and nothing used to read it —
 * so the demo played a test tone and reported the agent's neural voice. Returning a
 * sentinel rather than the cue's URL means no path can hand the tone to `Audio()` and
 * call it speech, and a cache replay carries the same verdict as the first attempt.
 */
export const DEGRADED = "degraded";

const AUDIO_CACHE = new Map<string, Speech>();
const INFLIGHT = new Map<string, Promise<Speech>>();
// Bounded: every entry holds a live object URL (~100KB of blob). Evicting
// WITHOUT revokeObjectURL leaks the blob for the tab's lifetime.
const AUDIO_CACHE_MAX = 64;

function cacheSet(key: string, speech: Speech): void {
  if (AUDIO_CACHE.size >= AUDIO_CACHE_MAX) {
    // Map iterates in insertion order — the first key is the oldest.
    const oldest = AUDIO_CACHE.keys().next().value;
    if (oldest !== undefined) {
      const old = AUDIO_CACHE.get(oldest);
      AUDIO_CACHE.delete(oldest);
      if (old) URL.revokeObjectURL(old.url);
    }
  }
  AUDIO_CACHE.set(key, speech);
}

export function prefetchSpeech(
  text: string,
  voice: string,
  lang?: CallLang,
  role: VoiceRole = "agent",
  strict = false,
): void {
  fetchSpeech(text, voice, lang, role, strict).catch(() => {});
}

/**
 * Fetch (or reuse) the neural-voice audio for the given text.
 *
 * `strict` is the demo/scenario contract: only ElevenLabs may answer. It is
 * part of the cache key so an auto-mode synthesis (which may be PlayHT or the
 * emergency cue) can never be replayed as if it were the strict agent voice.
 */
export function fetchSpeech(
  text: string,
  voice: string,
  lang?: CallLang,
  role: VoiceRole = "agent",
  strict = false,
): Promise<Speech> {
  const key = `${voice}::${lang ?? ""}::${role}::${strict ? "strict" : "auto"}::${text}`;
  const hit = AUDIO_CACHE.get(key);
  if (hit) return Promise.resolve(hit);

  const pending = INFLIGHT.get(key);
  if (pending) return pending;

  const p = (async () => {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice,
        role,
        ...(lang ? { lang } : {}),
        ...(strict ? { strict: true } : {}),
      }),
    });
    // Carrying the status into the message is what lets speakText tell a spent
    // demo budget (429) from a refused anonymous call (401) from a vendor outage.
    // Swallowing it here would leave the fallback reason a guess.
    if (!res.ok) throw new Error(`tts ${res.status}`);
    const blob = await res.blob();
    if (blob.size < 512) throw new Error("tts empty");
    const speech: Speech = {
      url: URL.createObjectURL(blob),
      degraded: res.headers.get("x-voice-degraded") === "true",
    };
    cacheSet(key, speech);
    return speech;
  })().finally(() => INFLIGHT.delete(key));

  INFLIGHT.set(key, p);
  return p;
}

/** Back-compat for callers that only need the playable URL. */
export function fetchSpeechUrl(
  text: string,
  voice: string,
  lang?: CallLang,
  role: VoiceRole = "agent",
  strict = false,
): Promise<string> {
  return fetchSpeech(text, voice, lang, role, strict).then((s) => (s.degraded ? DEGRADED : s.url));
}

/* ————— single active audio channel ————— */
let currentAudio: HTMLAudioElement | null = null;
/**
 * Resolves the browser-TTS promise when `stopVoice()` cancels an utterance.
 * `speechSynthesis.cancel()` does not reliably fire `onend`, so without this a
 * caller awaiting completion would wait forever after a language switch.
 */
let pendingUtteranceFinish: (() => void) | null = null;

function finishPendingUtterance(): void {
  const finish = pendingUtteranceFinish;
  pendingUtteranceFinish = null;
  finish?.();
}

export function stopVoice(): void {
  if (currentAudio) {
    try {
      currentAudio.pause();
      currentAudio.currentTime = 0;
    } catch {}
    currentAudio = null;
  }
  try {
    window.speechSynthesis?.cancel();
  } catch {}
  finishPendingUtterance();
}

/**
 * Play a cached speech URL.
 *
 * Resolves when playback FINISHES (or is stopped), not when it starts. The
 * previous contract resolved at `play()`, and the demo clock treated that as
 * "the agent has finished speaking": it advanced to the next scenario beat and
 * called `stopVoice()` while the line was still audible, cutting the agent off
 * mid-sentence on every fallback path. A caller that only needs "audio is now
 * playing" should not await this function.
 */
export async function playUrl(url: string, rate = 1): Promise<void> {
  stopVoice();
  const a = new Audio(url);
  a.playbackRate = Math.min(2, Math.max(0.5, rate));
  try {
    // keep pitch natural when sped up
    (a as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
  } catch {}
  currentAudio = a;
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      a.removeEventListener("ended", done);
      a.removeEventListener("error", done);
      a.removeEventListener("pause", done);
      if (currentAudio === a) currentAudio = null;
      resolve();
    };
    a.addEventListener("ended", done);
    a.addEventListener("error", done);
    // `stopVoice()` pauses the element; without the pause listener the await
    // would hang on a superseded or unmounted line.
    a.addEventListener("pause", done);
    void a.play().catch(done);
  });
}

/**
 * Best-effort browser TTS fallback. Resolves when the utterance ends, errors,
 * is cancelled, or exceeds a length-derived ceiling (a speech engine that
 * never fires `onend` must not freeze the caller's clock forever).
 */
export function browserSpeak(text: string, lang: CallLang, rate = 1): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      const synth = window.speechSynthesis;
      if (!synth) {
        resolve();
        return;
      }
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      // map every supported call language — falling ur/fr/sw back to an en-US
      // voice renders unintelligible gibberish
      u.lang =
        lang === "ar"
          ? "ar-SA"
          : lang === "hi"
            ? "hi-IN"
            : lang === "ur"
              ? "ur-PK"
              : lang === "fr"
                ? "fr-FR"
                : lang === "sw"
                  ? "sw-KE"
                  : "en-US";
      u.rate = rate;
      const v = synth.getVoices().find((x) => x.lang.startsWith(u.lang.slice(0, 2)));
      if (v) u.voice = v;
      let settled = false;
      function done() {
        if (settled) return;
        settled = true;
        clearTimeout(ceiling);
        u.onend = null;
        u.onerror = null;
        if (pendingUtteranceFinish === done) pendingUtteranceFinish = null;
        resolve();
      }
      // ~700 ms per word covers a 0.5× rate with margin.
      const ceiling = setTimeout(done, Math.max(4_000, text.split(/\s+/).length * 700));
      u.onend = done;
      u.onerror = done;
      pendingUtteranceFinish = done;
      synth.speak(u);
    } catch {
      resolve();
    }
  });
}

/**
 * Why the neural voice did not answer, as far as the browser can tell.
 *
 * `browserSpeak` is a real fallback — the line still gets spoken — but it is the
 * visitor's own operating-system voice, not the product's. A demo that swaps between
 * them invisibly is making a claim about ElevenLabs that the audio does not support,
 * so the reason travels with the result instead of being swallowed.
 */
export type VoiceFallback = "degraded" | "rate_limited" | "unauthorized" | "failed";

export type SpeechOutcome = { neural: boolean; reason?: VoiceFallback };

/**
 * What to tell the visitor, per reason. Written for a bank's customer, not an
 * operator: each one names the voice they are about to hear, and the two that are
 * actionable say what would change it.
 */
export const VOICE_FALLBACK_COPY: Record<VoiceFallback, string> = {
  degraded: "Neural voice unavailable right now — playing with your device's voice.",
  rate_limited: "Demo voice budget spent — sign in for the full neural voice.",
  unauthorized: "Neural voice needs a signed-in session — using your device's voice.",
  failed: "Could not reach the voice service — using your device's voice.",
};

/**
 * Strict-mode copy. The device voice is NOT played in this mode, so the
 * fallback text above would be false. The demo says what actually happened: the
 * ElevenLabs agent voice is unavailable and no other voice was substituted.
 */
export const STRICT_VOICE_UNAVAILABLE = {
  en: "ElevenLabs agent voice unavailable — no other voice was substituted.",
  ar: "صوت وكيل ElevenLabs غير متاح — لم يُستخدم صوت بديل.",
} as const;

function classify(err: unknown): VoiceFallback {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (/429/.test(msg)) return "rate_limited";
  if (/401/.test(msg)) return "unauthorized";
  return "failed";
}

/** Neural speech with automatic browser fallback. Reports which one you got. */
export async function speakText(
  text: string,
  lang: CallLang,
  role: VoiceRole,
  rate = 1,
  opts: { strict?: boolean } = {},
): Promise<SpeechOutcome> {
  let url: string;
  try {
    // `voice` is the language, on purpose: the server resolves language+role to
    // the voice the live call would use. Passing a slug here is what let the demo
    // drift away from the product once already.
    url = await fetchSpeechUrl(text, lang, lang, role, opts.strict === true);
  } catch (err) {
    if (opts.strict) return { neural: false, reason: classify(err) };
    await browserSpeak(text, lang, rate);
    return { neural: false, reason: classify(err) };
  }
  if (url === DEGRADED) {
    // The server could not synthesise and sent the hold-cue tone instead. Right on
    // a live fraud call; in a strict demo, a tone is not the agent voice and is
    // not played at all.
    if (opts.strict) return { neural: false, reason: "degraded" };
    await browserSpeak(text, lang, rate);
    return { neural: false, reason: "degraded" };
  }
  await playUrl(url, rate);
  return { neural: true };
}

/* ————— streaming playback with barge-in ————— */

/**
 * Streams neural TTS through /api/tts/stream and starts playback as soon as
 * the first chunks land (MediaSource feeds the <audio> progressively).
 * Barge-in: while playing, a live mic monitor watches loudness — if the user
 * starts speaking (RMS above threshold), playback aborts immediately and the
 * promise resolves { bargeIn: true }. Falls back to buffered speakText()
 * when MediaSource is unavailable or the stream route is in dev mode.
 */
export async function streamSpeech(
  text: string,
  lang: CallLang,
  role: VoiceRole,
  rate = 1,
  opts: { bargeIn?: boolean; strict?: boolean } = {},
): Promise<{ streamed: boolean; bargeIn: boolean; neural: boolean; reason?: string }> {
  if (typeof MediaSource === "undefined" || !MediaSource.isTypeSupported("audio/mpeg")) {
    // `neural` is reported rather than assumed because the copy beside this player
    // claims a neural voice: when the vendor path is skipped, the visitor is hearing
    // their own device's speech engine and is entitled to be told.
    const outcome = await speakText(text, lang, role, rate, { strict: opts.strict });
    return { streamed: false, bargeIn: false, neural: outcome.neural, reason: outcome.reason };
  }

  let mediaSource: MediaSource;
  try {
    mediaSource = new MediaSource();
  } catch {
    const outcome = await speakText(text, lang, role, rate, { strict: opts.strict });
    return { streamed: false, bargeIn: false, neural: outcome.neural, reason: outcome.reason };
  }

  const audio = new Audio();
  audio.playbackRate = Math.min(2, Math.max(0.5, rate));
  currentAudio = audio;
  const objectUrl = URL.createObjectURL(mediaSource);
  audio.src = objectUrl;

  const cleanup = () => {
    try {
      URL.revokeObjectURL(objectUrl);
    } catch {}
    stopMicMonitor();
  };

  return new Promise((resolve) => {
    let settled = false;
    const done = (bargeIn: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Reaching this resolve means vendor chunks were appended to the MediaSource,
      // so the voice the visitor heard is the platform's neural voice.
      resolve({ streamed: true, bargeIn, neural: true });
    };

    mediaSource.addEventListener("sourceopen", async () => {
      try {
        const sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
        const queue: Uint8Array[] = [];
        let appending = false;
        const flush = () => {
          if (appending || sourceBuffer.updating || queue.length === 0) return;
          appending = true;
          const chunk = queue.shift()!;
          sourceBuffer.addEventListener(
            "updateend",
            () => {
              appending = false;
              flush();
            },
            { once: true },
          );
          try {
            sourceBuffer.appendBuffer(chunk as unknown as ArrayBuffer);
          } catch {
            /* buffer full or closed — drop chunk, keep playing */
          }
        };

        // Barge-in monitor: echo-cancelled mic + sustained-speech gate — the
        // agent's own speaker bleed must NOT trigger a self-cutoff. A TYPED
        // turn opts out: there is no caller speech to interrupt, and opening
        // the mic would both prompt for permission and give speaker bleed a
        // way to cut an otherwise uninterrupted reply.
        if (opts.bargeIn !== false) {
          startMicMonitor(() => {
            audio.pause();
            try {
              mediaSource.endOfStream();
            } catch {}
            done(true);
          });
        }

        const res = await fetch("/api/tts/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            voice: lang,
            lang,
            role,
            ...(opts.strict ? { strict: true } : {}),
          }),
        });
        if (!res.ok || !res.body) {
          stopMicMonitor();
          // Strict mode still tries the buffered route — it is the same
          // ElevenLabs voice — but never the device voice.
          await speakText(text, lang, role, rate, { strict: opts.strict });
          done(false);
          return;
        }

        const reader = res.body.getReader();
        // playback starts as soon as the first chunk lands; if the browser
        // blocks it (autoplay policy), fall back cleanly — never kill a
        // playing stream on a timer
        audio.play().catch(() => {
          audio.pause();
          done(false);
          void speakText(text, lang, role, rate);
        });
        for (;;) {
          const { done: finished, value } = await reader.read();
          if (finished) break;
          queue.push(value);
          flush();
        }
        try {
          mediaSource.endOfStream();
        } catch {}
        audio.onended = () => done(false);
      } catch {
        stopMicMonitor();
        await speakText(text, lang, role, rate);
        done(false);
      }
    });
  });
}

/* mic monitor for barge-in — echo-cancelled, sustained-speech gated.
 * The agent's own voice comes out of the speakers; echoCancellation plus a
 * multi-frame threshold (a burst must persist ~150ms) keeps speaker bleed
 * from cutting the agent off. */
let monitorCtx: AudioContext | null = null;
let monitorStream: MediaStream | null = null;

async function startMicMonitor(onSpeak: () => void): Promise<void> {
  try {
    monitorStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const AC: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    monitorCtx = new AC();
    const source = monitorCtx.createMediaStreamSource(monitorStream);
    const analyser = monitorCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let hotFrames = 0;
    const armedAt = Date.now() + 600; // ignore echo tail right after playback starts

    const tick = () => {
      if (!monitorCtx) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        // The `i < data.length` loop bound is what proves the index exists;
        // the assertion records that for the checker rather than adding a
        // dead branch.
        const v = (data[i]! - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      // speech threshold (~-24 dBFS) sustained across consecutive frames
      if (rms > 0.09) {
        hotFrames++;
        if (hotFrames >= 8 && Date.now() > armedAt) {
          onSpeak();
          return;
        }
      } else {
        hotFrames = Math.max(0, hotFrames - 2);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } catch {
    // mic denied — no barge-in, playback continues normally
  }
}

function stopMicMonitor(): void {
  try {
    monitorStream?.getTracks().forEach((t) => t.stop());
    void monitorCtx?.close();
  } catch {}
  monitorStream = null;
  monitorCtx = null;
}

/* ————— microphone recording → 16 kHz mono WAV base64 ————— */

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    // The `i < samples.length` loop bound is what proves the index exists; the
    // assertion records that for the checker rather than adding a dead branch.
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: "audio/wav" });
}

/** Convert any browser recording (webm/opus…) into 16 kHz mono WAV base64. */
export async function blobToWavBase64(blob: Blob): Promise<string> {
  const arr = await blob.arrayBuffer();
  const AC: typeof AudioContext =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const tmp = new AC();
  try {
    const decoded = await tmp.decodeAudioData(arr);
    const rate = 16000;
    const OfflineCtx: typeof OfflineAudioContext =
      window.OfflineAudioContext ||
      (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext })
        .webkitOfflineAudioContext;
    const off = new OfflineCtx(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    const wav = encodeWav(rendered.getChannelData(0), rate);
    const bytes = new Uint8Array(await wav.arrayBuffer());
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  } finally {
    tmp.close().catch(() => {});
  }
}
