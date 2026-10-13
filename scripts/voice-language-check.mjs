#!/usr/bin/env bun
/**
 * bun run voice:check — does each language actually get spoken in that language?
 *
 * WHY THIS EXISTS AT ALL. The repo has a table of which TTS model can voice which
 * language (`TTS_LANGUAGE_SUPPORT`) and a route that pins Urdu/Swahili away from
 * eleven_multilingual_v2 because that generation cannot voice them. None of that
 * proves anything a customer would recognise: HTTP 200 with audio bytes comes back
 * for a mis-pronounced sentence too. So this measures the thing itself — synthesize
 * the sentence, transcribe it back with Scribe, compare the words — which is the only
 * check that distinguishes "the model spoke Urdu" from "the model read Urdu text as
 * English and nobody noticed".
 *
 * WHAT IT CANNOT TELL YOU, stated rather than implied: the vendor exposes no usable
 * per-language capability metadata for the voices on this account. Measured
 * 2026-10-13: `GET /v1/voices?supported_languages=ar` returns the same 23 voices for
 * every language, each with an EMPTY `supported_languages` array, all labelled
 * `language: en`. So this check passes for the current configuration — eleven
 * multilingual voices really do produce Arabic, Hindi, Urdu, French and Swahili text
 * — while every one of those voices is an English speaker's voice model. Accent and
 * voice identity are a human listening decision, and a cloned replacement has to be
 * registered in TWO places: the `ELEVENLABS_VOICE_<LANG>` environment AND a `Voice`
 * row carrying `consentUrl`/`consentAt`, which the cloning endpoints require.
 *
 * Spends a little vendor quota on purpose (one short sentence plus one transcription
 * per language) and is therefore NOT wired into CI: it needs the platform key and it
 * bills. Run it after any change to voice ids, models, or the language list, and
 * before a release that claims a language.
 *
 * Exit 0 every language cleared the word-overlap floor; 1 otherwise.
 */
import { SUPPORTED_LANGS } from "../src/lib/languages.ts";

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) {
  console.error("ELEVENLABS_API_KEY is not set — this check talks to the real vendor.");
  process.exit(2);
}
const BASE = process.env.ELEVENLABS_API_BASE_URL || "https://api.elevenlabs.io";
const JSON_H = { "xi-api-key": KEY, "content-type": "application/json" };

/** The line the product would actually open a call with, per language. */
const PHRASE = {
  en: "This call is recorded to protect you.",
  ar: "يتم تسجيل هذه المكالمة لحمايتك",
  hi: "यह कॉल आपकी सुरक्षा के लिए रिकॉर्ड की गई है",
  ur: "یہ کال آپ کی حفاظت کے لیے ریکارڈ کی گئی ہے",
  fr: "Cet appel est enregistré pour vous protéger.",
  sw: "Simu hii inarekodiwa ili kukulinda.",
};

const STT_MODEL = process.env.ELEVENLABS_STT_MODEL || "scribe_v2";
/**
 * The floor, in words of the intended sentence that must survive the round trip.
 * 0.6 is not arbitrary: transliteration of loanwords ("call", "record") is how these
 * voices legitimately render bank vocabulary, so hi/ur measure 0.8-0.9 today, while a
 * voice that read the wrong script collapses toward 0.
 */
const MIN_OVERLAP = 0.6;

function modelFor(lang) {
  if (lang === "ur") return process.env.ELEVENLABS_TTS_MODEL_UR || "eleven_v4_turbo";
  if (lang === "sw") return process.env.ELEVENLABS_TTS_MODEL_SW || "eleven_v4_turbo";
  return process.env.ELEVENLABS_MODEL || "eleven_v4_turbo";
}

async function synth(voiceId, text, model) {
  const r = await fetch(`${BASE}/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: "POST",
    headers: { ...JSON_H, accept: "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: model,
      voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 0.92 },
    }),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  if (!r.ok) {
    let detail = buf.toString("utf8").slice(0, 200);
    try {
      detail = JSON.stringify(JSON.parse(detail).detail ?? detail).slice(0, 200);
    } catch {}
    return { error: `synth ${r.status}: ${detail}` };
  }
  if (buf.length < 1500) return { error: `synth returned ${buf.length} bytes — not speech` };
  return { buf };
}

async function transcribe(buf, lang) {
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: "audio/mpeg" }), "check.mp3");
  fd.append("model_id", STT_MODEL);
  // Pinned to the language we asked for: Scribe will still return text when the
  // audio is in another language, and the overlap below is what catches that.
  fd.append("language_code", lang);
  const r = await fetch(`${BASE}/v1/speech-to-text`, {
    method: "POST",
    headers: { "xi-api-key": KEY },
    body: fd,
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) return { error: `stt ${r.status}: ${JSON.stringify(j).slice(0, 160)}` };
  return { text: (j.text || "").trim() };
}

/** Content words only: punctuation and case are not what this measures. */
function words(s) {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

console.log(`voice language check — stt=${STT_MODEL}, ${SUPPORTED_LANGS.length} languages\n`);
const rows = [];
for (const lang of SUPPORTED_LANGS) {
  const voiceId = process.env[`ELEVENLABS_VOICE_${lang.toUpperCase()}`] || "";
  const model = modelFor(lang);
  const intended = PHRASE[lang];
  if (!intended) {
    rows.push({ lang, verdict: "FAIL", note: `no probe sentence for "${lang}"` });
    continue;
  }
  if (!voiceId) {
    rows.push({ lang, verdict: "FAIL", note: `ELEVENLABS_VOICE_${lang.toUpperCase()} is unset` });
    continue;
  }
  const s = await synth(voiceId, intended, model);
  if (s.error) {
    rows.push({ lang, verdict: "FAIL", note: s.error });
    continue;
  }
  const t = await transcribe(s.buf, lang);
  if (t.error) {
    rows.push({ lang, verdict: "FAIL", note: t.error });
    continue;
  }
  const want = words(intended);
  const got = words(t.text);
  const hit = want.filter((w) => got.includes(w)).length;
  const overlap = want.length ? hit / want.length : 0;
  rows.push({
    lang,
    verdict: overlap >= MIN_OVERLAP ? "PASS" : "FAIL",
    overlap: `${hit}/${want.length}`,
    model,
    voice: voiceId,
    heard: t.text.slice(0, 78),
  });
}

for (const r of rows) {
  const line = `${r.verdict === "PASS" ? "ok  " : "FAIL"} ${r.lang.padEnd(3)} ${
    r.overlap ?? "-"
  }  ${r.model ?? ""} ${r.note ?? `heard: "${r.heard}"`}`;
  console.log(line);
}
const failed = rows.filter((r) => r.verdict !== "PASS").length;
console.log(
  `\n${rows.length - failed}/${rows.length} languages spoke their own language back at >= ${
    MIN_OVERLAP * 100
  }% word overlap.`,
);
console.log(
  "Reminder: PASS here means in-language content, not a native voice. This account's\n" +
    "voices are all labelled language=en and the vendor offers no per-language metadata\n" +
    "to check against — see the header of this file.",
);
process.exit(failed ? 1 : 0);
