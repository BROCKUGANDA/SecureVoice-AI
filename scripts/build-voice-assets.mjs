/**
 * Render the fixed voice assets — the back-channel lines and the warm phrases.
 *
 * Like `seed-demo-audio.mjs`, this is honest about what it cannot do: without an
 * ElevenLabs key it writes nothing and says why, rather than emitting a silent
 * file that a customer would experience as a dead line.
 *
 * The one design constraint that must not be "fixed" later: these are
 * PRE-RECORDED assets served from disk, never text handed to a model at call
 * time. A filler synthesised live in the agent's own voice reads as evasive,
 * which is the one impression a fraud-intervention call cannot afford — see
 * src/lib/voice/backchannel.ts.
 *
 * Run: bun run voice:assets
 */
import { mkdir, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { ElevenLabs } from "@elevenlabs/elevenlabs-js";
import { BACKCHANNEL_TEXT, backchannelAssetPath } from "../src/lib/voice/backchannel.ts";

const OUT_DIR = path.join(process.cwd(), "public", "voice", "backchannel");
const LANGS = Object.keys(BACKCHANNEL_TEXT);

const exists = (p) =>
  access(p, constants.F_OK).then(
    () => true,
    () => false,
  );

async function synthesize(client, text, voiceId, file) {
  const audio = await client.textToSpeech.convert({
    text,
    modelId: "eleven_multilingual_v2",
    voiceId,
    outputFormat: "mp3_44100_128",
  });
  const bytes =
    audio instanceof ArrayBuffer ? Buffer.from(audio) : Buffer.from(await audio.arrayBuffer());
  if (bytes.length === 0) throw new Error("provider returned zero bytes");
  await writeFile(file, bytes);
  return bytes.length;
}

async function main() {
  const apiKey = process.env.ELEVENLABS_API_KEY ?? "";
  if (apiKey.length < 8) {
    console.warn(
      "⚠ ELEVENLABS_API_KEY is not set — no back-channel assets written.\n" +
        "  The voice worker degrades to silence in the processing gap, which is\n" +
        "  correct but costs roughly 300–800 ms of perceptible dead air per turn.",
    );
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });
  const client = new ElevenLabs({ apiKey });

  let written = 0;
  let skipped = 0;
  let failed = 0;

  for (const lang of LANGS) {
    const file = path.join(process.cwd(), "public", backchannelAssetPath(lang));
    if (await exists(file)) {
      skipped++;
      console.log(`· ${lang} — already present, skipped`);
      continue;
    }
    const voiceId = process.env[`DEMO_VOICE_${lang.toUpperCase()}`] ?? "";
    if (!voiceId) {
      // Deliberate: guessing the default voice would bake one locale's timbre
      // into every other language's back-channel.
      failed++;
      console.warn(`✗ ${lang} — no DEMO_VOICE_${lang.toUpperCase()} configured`);
      continue;
    }
    try {
      const bytes = await synthesize(client, BACKCHANNEL_TEXT[lang], voiceId, file);
      written++;
      console.log(`✓ ${lang} — ${(bytes / 1024).toFixed(0)} KB`);
    } catch (err) {
      failed++;
      console.warn(`✗ ${lang} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(
    `done — ${written} written, ${skipped} skipped, ${failed} failed → ${path.relative(
      process.cwd(),
      OUT_DIR,
    )}`,
  );
}

main().catch((e) => {
  console.error("voice:assets failed:", e.message);
  process.exit(1);
});
