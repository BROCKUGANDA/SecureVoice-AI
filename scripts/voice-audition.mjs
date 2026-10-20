#!/usr/bin/env bun
/**
 * bun scripts/voice-audition.mjs — listen before you choose a voice identity.
 *
 * WHY THIS EXISTS. The product decision on the table is "one agent, six delivery
 * languages" — the same voice for English, Arabic, Hindi, Urdu, French and Swahili,
 * so a caller who switches language is not suddenly talking to a different person.
 * Nothing in this repository can make that choice for you:
 *
 *   · `voice:check` proves a voice produces the right WORDS in the right SCRIPT. It
 *     cannot hear an accent, and its own header says so.
 *   · The vendor exposes no usable capability metadata for the voices on this
 *     account. Measured 2026-10-20: `GET /v1/voices` returns 25 voices for every
 *     language filter; their labels carry gender, age, accent and native language,
 *     but the top-level `language` field is inconsistent (some `en`, some the
 *     native language) and nothing states which of the six delivery languages a
 *     voice can actually speak. A label is not a capability claim.
 *
 * So the only instrument left is a human with headphones, and the blocker was never
 * the model — it was that listening needed six API calls per candidate typed by hand.
 * This makes it one command: synthesize the sentence the product actually opens a
 * call with, in every language, for each voice you name, into files you can play.
 *
 * WHAT IT DOES NOT DO. It does not pick, rank, or score. It does not write
 * configuration. When you have heard enough, the answer is one ElevenLabs voice id
 * put in all six `ELEVENLABS_VOICE_<LANG>` slots on the deployment — the resolver in
 * `src/lib/elevenlabs/client.ts` reads those per language, so one id in six slots is
 * already one identity across the product, on the live call and in the demo alike.
 * A cloned voice additionally needs a `Voice` row with `consentUrl`/`consentAt`;
 * cloning is disabled on this account, and which voice represents the brand is a
 * bank-facing decision, not an API lookup.
 *
 * Spends vendor quota (one short synthesis per language per candidate) and therefore
 * is NOT wired into CI, matching `voice:check`. It refuses to run without a real key.
 *
 * Usage:
 *   bun scripts/voice-audition.mjs <voiceId|voiceName> [more...] [--out DIR]
 *   bun scripts/voice-audition.mjs --list          # names+ids on this account
 *
 * Exit 0 every file was written; 1 something failed (the table says what).
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SUPPORTED_LANGS } from "../src/lib/languages.ts";

const KEY = process.env.ELEVENLABS_API_KEY;
const DRY_RUN = (process.env.ELEVENLABS_DRY_RUN ?? "").toLowerCase() === "true";
if (!KEY || DRY_RUN) {
  console.error(
    !KEY
      ? "ELEVENLABS_API_KEY is not set — this tool talks to the real vendor."
      : "ELEVENLABS_DRY_RUN=true — unset it, this tool must hit the real vendor.",
  );
  process.exit(2);
}

const BASE = process.env.ELEVENLABS_API_BASE_URL || "https://api.elevenlabs.io";
const HEADERS = { "xi-api-key": KEY, "content-type": "application/json" };

/**
 * The sentence per language, identical to the one `voice-language-check.mjs`
 * measures. Deliberately the real opening disclosure rather than a tongue twister:
 * the thing being judged is whether this voice can open a bank's fraud call in
 * Arabic, not whether it can read Arabic.
 */
const PHRASE = {
  en: "This call is recorded to protect you.",
  ar: "يتم تسجيل هذه المكالمة لحمايتك",
  hi: "यह कॉल आपकी सुरक्षा के लिए रिकॉर्ड की गई है",
  ur: "یہ کال آپ کی حفاظت کے لیے ریکارڈ کی گئی ہے",
  fr: "Cet appel est enregistré pour vous protéger.",
  sw: "Simu hii inarekodiwa ili kukulinda.",
};

/**
 * Same model resolution as the product (and the same defaults as `voice:check`),
 * because auditioning a voice on a model the deployment will not use tells you
 * nothing. `eleven_multilingual_v2` cannot voice ur/sw at all.
 */
function modelFor(lang) {
  if (lang === "ur") return process.env.ELEVENLABS_TTS_MODEL_UR || "eleven_v4_turbo";
  if (lang === "sw") return process.env.ELEVENLABS_TTS_MODEL_SW || "eleven_v4_turbo";
  return process.env.ELEVENLABS_MODEL || "eleven_v4_turbo";
}

/**
 * Voice settings copied from `voice:check`, which copies the paced preset. A
 * candidate auditioned at a different stability than it will ship at is a
 * different-sounding voice, and the whole point is the sound.
 */
const VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.75, speed: 0.92 };

async function listVoices() {
  const r = await fetch(`${BASE}/v1/voices`, { headers: HEADERS });
  if (!r.ok) {
    console.error(`GET /v1/voices -> HTTP ${r.status}`);
    process.exit(1);
  }
  const { voices } = await r.json();
  for (const v of voices ?? []) {
    const l = v.labels ?? {};
    const label = [l.gender, l.age, l.accent, l.language].filter(Boolean).join(", ") || "no labels";
    console.log(`${v.voice_id}  ${v.name}  [${label}]`);
  }
  console.log(
    `\n${voices?.length ?? 0} voices. Labels describe the voice, not which of ` +
      "this product's six delivery languages it can speak — the top-level " +
      "`language` field is inconsistent, so the label is not a capability claim. " +
      "That is why you are listening.",
  );
  process.exit(0);
}

async function resolveByName(name) {
  const r = await fetch(`${BASE}/v1/voices`, { headers: HEADERS });
  if (!r.ok) return null;
  const { voices } = await r.json();
  const hit = (voices ?? []).find((v) => v.name.toLowerCase() === name.toLowerCase());
  return hit?.voice_id ?? null;
}

async function synth(voiceId, text, model) {
  const r = await fetch(`${BASE}/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: "POST",
    headers: { ...HEADERS, accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: model, voice_settings: VOICE_SETTINGS }),
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`HTTP ${r.status} ${detail.slice(0, 120)}`);
  }
  return Buffer.from(await r.arrayBuffer());
}

const args = process.argv.slice(2);
if (args.includes("--list")) await listVoices();

const outIdx = args.indexOf("--out");
const OUT = resolve(outIdx >= 0 ? args.splice(outIdx, 2)[1] : ".voice-audition");
const requested = args.filter((a) => !a.startsWith("--"));
if (requested.length === 0) {
  console.error(
    "usage: bun scripts/voice-audition.mjs <voiceId|Voice Name> [...] [--out DIR]\n" +
      "       bun scripts/voice-audition.mjs --list",
  );
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });
const langs = [...SUPPORTED_LANGS];
const rows = [];
let failed = 0;

for (const wanted of requested) {
  const voiceId = /^[a-zA-Z0-9]{16,}$/.test(wanted) ? wanted : await resolveByName(wanted);
  if (!voiceId) {
    console.error(`no voice on this account matches '${wanted}' (try --list)`);
    failed++;
    continue;
  }
  for (const lang of langs) {
    const model = modelFor(lang);
    const file = join(OUT, `${voiceId}-${lang}.mp3`);
    try {
      const audio = await synth(voiceId, PHRASE[lang], model);
      writeFileSync(file, audio);
      rows.push({
        voice: wanted,
        voiceId,
        lang,
        model,
        bytes: audio.length,
        sha: createHash("sha256").update(audio).digest("hex"),
        file,
        error: "",
      });
    } catch (err) {
      failed++;
      rows.push({
        voice: wanted,
        voiceId,
        lang,
        model,
        bytes: 0,
        sha: "",
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// Byte-size equality is not evidence of duplicate audio (CBR pads different
// sentences to the same length), so duplicates are judged by content hash. An
// identical hash across candidates or languages means the vendor returned the
// same audio for text that should differ — the files are not six auditions.
const bySha = new Map();
for (const r of rows) {
  if (r.error) continue;
  const group = bySha.get(r.sha) ?? [];
  group.push(r);
  bySha.set(r.sha, group);
}
const duplicates = [...bySha.values()].filter((g) => g.length > 1);
if (duplicates.length) {
  failed += duplicates.length;
  console.error("\nDUPLICATE AUDIO — the same bytes were returned for different requests:");
  for (const g of duplicates) {
    console.error(
      `  ${g[0].sha.slice(0, 12)}  ${g.map((r) => `${r.voiceId.slice(0, 8)}/${r.lang}`).join(", ")}`,
    );
  }
}

// The table is the deliverable: which file to play, in which language, on which
// model. A silent success that writes files nobody can map back to a candidate is
// how an audition turns into a re-run and a second bill.
console.log(`\nvoice              lang  model                bytes   file`);
for (const r of rows) {
  console.log(
    `${r.voiceId.slice(0, 18).padEnd(18)} ${r.lang}   ${r.model.padEnd(20)} ${String(r.bytes).padStart(7)}  ${r.file}` +
      (r.error ? `\n     ! ${r.error}` : ""),
  );
}
const voices = new Set(rows.map((r) => r.voiceId)).size;
console.log(
  `\n${rows.filter((r) => !r.error).length}/${rows.length} files written for ${voices} voice(s) × ${langs.length} languages.`,
);
console.log(
  "Listen for: does the SAME voice carry all six, and does each one sound like a\n" +
    "person who speaks that language? When you have a winner, put its id in all six\n" +
    "ELEVENLABS_VOICE_<LANG> slots on the deployment — the resolver reads those per\n" +
    "language, so one id in six slots is already one identity across the product.",
);
process.exit(failed ? 1 : 0);
