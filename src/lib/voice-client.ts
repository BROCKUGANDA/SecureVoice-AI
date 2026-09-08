/**
 * Client-side voice utilities — talks to the server-side neural TTS/ASR
 * endpoints (API keys stay server-side). Falls back to the browser's
 * SpeechSynthesis when the neural voice is unavailable.
 */
import type { CallLang } from "@/lib/scenario";

export type VoiceRole = "agent" | "customer";

/** Neural voice routing per call language. */
export const TTS_VOICE: Record<CallLang, Record<VoiceRole, string>> = {
  en: { agent: "jam", customer: "kazi" },
  ar: { agent: "tongtong", customer: "chuichui" },
  hi: { agent: "kazi", customer: "douji" },
  ur: { agent: "luodo", customer: "xiaochen" },
  fr: { agent: "jam", customer: "kazi" },
  sw: { agent: "jam", customer: "kazi" },
};

/* ————— audio cache (object URLs, session-scoped) ————— */
const AUDIO_CACHE = new Map<string, string>();
const INFLIGHT = new Map<string, Promise<string>>();

export function prefetchSpeech(text: string, voice: string): void {
  fetchSpeechUrl(text, voice).catch(() => {});
}

/** Fetch (or reuse) a neural-voice WAV object URL for the given text. */
export function fetchSpeechUrl(text: string, voice: string): Promise<string> {
  const key = `${voice}::${text}`;
  const hit = AUDIO_CACHE.get(key);
  if (hit) return Promise.resolve(hit);

  const pending = INFLIGHT.get(key);
  if (pending) return pending;

  const p = (async () => {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice }),
    });
    if (!res.ok) throw new Error(`tts ${res.status}`);
    const blob = await res.blob();
    if (blob.size < 512) throw new Error("tts empty");
    const url = URL.createObjectURL(blob);
    AUDIO_CACHE.set(key, url);
    return url;
  })().finally(() => INFLIGHT.delete(key));

  INFLIGHT.set(key, p);
  return p;
}

/* ————— single active audio channel ————— */
let currentAudio: HTMLAudioElement | null = null;

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
}

/** Play a cached speech URL. Resolves when playback starts. */
export async function playUrl(url: string, rate = 1): Promise<void> {
  stopVoice();
  const a = new Audio(url);
  a.playbackRate = Math.min(2, Math.max(0.5, rate));
  try {
    // keep pitch natural when sped up
    (a as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
  } catch {}
  currentAudio = a;
  await a.play().catch(() => {});
}

/** Best-effort browser TTS fallback. */
export function browserSpeak(text: string, lang: CallLang, rate = 1): void {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang === "ar" ? "ar-SA" : lang === "hi" ? "hi-IN" : "en-US";
    u.rate = rate;
    const v = synth.getVoices().find((x) => x.lang.startsWith(u.lang.slice(0, 2)));
    if (v) u.voice = v;
    synth.speak(u);
  } catch {
    /* not supported — silent */
  }
}

/** Neural speech with automatic browser fallback. Resolves true if neural. */
export async function speakText(
  text: string,
  lang: CallLang,
  role: VoiceRole,
  rate = 1
): Promise<boolean> {
  try {
    const url = await fetchSpeechUrl(text, TTS_VOICE[lang][role]);
    await playUrl(url, rate);
    return true;
  } catch {
    browserSpeak(text, lang, rate);
    return false;
  }
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
  rate = 1
): Promise<{ streamed: boolean; bargeIn: boolean }> {
  if (typeof MediaSource === "undefined" || !MediaSource.isTypeSupported("audio/mpeg")) {
    await speakText(text, lang, role, rate);
    return { streamed: false, bargeIn: false };
  }

  let mediaSource: MediaSource;
  try {
    mediaSource = new MediaSource();
  } catch {
    await speakText(text, lang, role, rate);
    return { streamed: false, bargeIn: false };
  }

  const audio = new Audio();
  audio.playbackRate = Math.min(2, Math.max(0.5, rate));
  currentAudio = audio;
  const objectUrl = URL.createObjectURL(mediaSource);
  audio.src = objectUrl;

  const cleanup = () => {
    try { URL.revokeObjectURL(objectUrl); } catch {}
    stopMicMonitor();
  };

  return new Promise((resolve) => {
    let settled = false;
    const done = (bargeIn: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ streamed: true, bargeIn });
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
          sourceBuffer.addEventListener("updateend", () => {
            appending = false;
            flush();
          }, { once: true });
          try {
            sourceBuffer.appendBuffer(chunk as unknown as ArrayBuffer);
          } catch {
            /* buffer full or closed — drop chunk, keep playing */
          }
        };

        // barge-in monitor: open the mic and watch RMS while audio plays
        const bargeInPromise = startMicMonitor(() => {
          audio.pause();
          try { mediaSource.endOfStream(); } catch {}
          done(true);
        });

        const res = await fetch("/api/tts/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, voice: TTS_VOICE[lang][role], lang }),
        });
        if (!res.ok || !res.body) {
          stopMicMonitor();
          await speakText(text, lang, role, rate);
          done(false);
          return;
        }

        const reader = res.body.getReader();
        audio.play().catch(() => {});
        for (;;) {
          const { done: finished, value } = await reader.read();
          if (finished) break;
          queue.push(value);
          flush();
        }
        try { mediaSource.endOfStream(); } catch {}
        audio.onended = () => done(false);
        // if playback never started (autoplay block), fall back
        setTimeout(() => { if (!settled && audio.paused) done(false); }, 2500);
        void bargeInPromise;
      } catch {
        stopMicMonitor();
        await speakText(text, lang, role, rate);
        done(false);
      }
    });
  });
}

/* mic monitor for barge-in — one live analyser watching loudness */
let monitorCtx: AudioContext | null = null;
let monitorStream: MediaStream | null = null;

async function startMicMonitor(onSpeak: () => void): Promise<void> {
  try {
    monitorStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const AC: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    monitorCtx = new AC();
    const source = monitorCtx.createMediaStreamSource(monitorStream);
    const analyser = monitorCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let lastTrigger = 0;
    const tick = () => {
      if (!monitorCtx) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      // speech threshold (~-30 dBFS); debounce 800ms so one word doesn't machine-gun
      if (rms > 0.05 && Date.now() - lastTrigger > 800) {
        lastTrigger = Date.now();
        onSpeak();
        return;
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
    const s = Math.max(-1, Math.min(1, samples[i]));
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
