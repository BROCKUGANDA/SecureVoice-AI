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
