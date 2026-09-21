/**
 * Stage 1 — narration audio.
 *
 * Narration comes straight from the ElevenLabs API with a dedicated narrator
 * voice, so the presenter never sounds like the product's own agent. The lines
 * the agent speaks inside a call go through the platform's own /api/tts, which
 * is what keeps the call scene honest.
 *
 * Results are cached by a hash of their text, so re-cutting or re-editing the
 * video costs nothing: only new or changed sentences spend quota.
 *
 * Usage: node narrate.mjs [--dry-run]
 */
import fs from "node:fs";
import path from "node:path";
import { AUDIO, BASE, ffprobeDuration, readEnv, sha, writeJson } from "./lib.mjs";
import { scenes } from "./scenes.mjs";

const env = readEnv();
const KEY = env.ELEVENLABS_API_KEY;
const MODEL = env.ELEVENLABS_MODEL || "eleven_multilingual_v2";
/** "Daniel — Steady Broadcaster": a voice the agent's Sarah won't blur into. */
const NARRATOR = process.env.NARRATOR_VOICE || "onwK4e9ZLuTAKqWW03F9";
const dry = process.argv.includes("--dry-run");

const cacheFile = path.join(AUDIO, "cache.json");
const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : {};

async function synthNarrator(text) {
  const r = await fetch(
    "https://api.elevenlabs.io/v1/text-to-speech/" + NARRATOR + "?output_format=mp3_44100_128",
    {
      method: "POST",
      headers: { "xi-api-key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: MODEL,
        voice_settings: { stability: 0.42, similarity_boost: 0.8, style: 0.15 },
      }),
    },
  );
  if (!r.ok) throw new Error("narrator TTS " + r.status + ": " + (await r.text()).slice(0, 200));
  return Buffer.from(await r.arrayBuffer());
}

async function synthAgent(text, lang) {
  const r = await fetch(BASE + "/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice: lang, lang }),
  });
  if (!r.ok) throw new Error("platform TTS " + r.status + " for lang " + lang);
  return Buffer.from(await r.arrayBuffer());
}

/** --dry-run writes silence of the right shape so the pipeline rehearses free. */
function silence() {
  const data = Buffer.alloc(44100 * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(44100, 24); h.writeUInt32LE(88200, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

async function get(kind, key, make, file) {
  if (fs.existsSync(file) && cache[key]) return;
  const buf = dry ? silence() : await make();
  fs.writeFileSync(file, buf);
  cache[key] = { file: path.basename(file), kind, at: new Date().toISOString() };
  writeJson(cacheFile, cache);
}

fs.mkdirSync(AUDIO, { recursive: true });
const out = [];
let chars = 0;

for (const sc of scenes) {
  const nf = path.join(AUDIO, sc.id + "-narr.mp3");
  chars += sc.narration.length;
  await get("narrator", sha(sc.narration), () => synthNarrator(sc.narration), nf);
  const e = { id: sc.id, kind: sc.kind, narr: path.basename(nf), agent: [] };
  e.narrDur = dry ? 6 : ffprobeDuration(nf);

  // Agent lines land after the narrator stops, spaced by their own length, so
  // the two voices never talk over each other. Timings are written here and
  // assembly consumes them verbatim — one clock, no drift between stages.
  let cursor = e.narrDur + 1.6;
  for (const [i, line] of (sc.agentLines || []).entries()) {
    const af = path.join(AUDIO, sc.id + "-agent" + i + ".mp3");
    chars += line.text.length;
    await get("agent", sha(line.lang + line.text), () => synthAgent(line.text, line.lang), af);
    const dur = dry ? 3 : ffprobeDuration(af);
    e.agent.push({ file: path.basename(af), at: Number(cursor.toFixed(2)), lang: line.lang, dur });
    cursor += dur + 2.4;
  }

  e.dur = Math.max(e.narrDur + 0.9, sc.min || 0, ...e.agent.map((a) => a.at + a.dur + 0.6));
  out.push(e);
  console.log("  " + e.id + "  narr " + e.narrDur.toFixed(1) + "s  scene " + e.dur.toFixed(1) + "s  agent x" + e.agent.length);
}

const total = out.reduce((s, e) => s + e.dur, 0);
writeJson(path.join(AUDIO, "timings.json"), { total, chars, dryRun: dry, scenes: out });
console.log("\ntimings -> " + path.join(AUDIO, "timings.json"));
console.log("  total " + total.toFixed(1) + "s  ·  " + chars + " chars" + (dry ? "  (dry run, nothing synthesised)" : " of quota"));
