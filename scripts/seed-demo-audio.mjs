/**
 * Seed playable demo recordings — real synthesized audio, not silence.
 *
 * The dashboard's "mock data" chip is honest about the CASE ROWS being mock, but
 * a play button that produces nothing is worse than no play button: a judge
 * clicks it, hears a dead element, and concludes the audio pipeline is a prop.
 * So this script generates five short, scripted intervention calls with the same
 * provider the live product speaks with.
 *
 * It is deliberately HONEST when it cannot do that:
 *   - no ELEVENLABS_API_KEY  → warn, write nothing, `recordingUrl` stays null and
 *     the table shows a "sealed" chip, which is the real state of a system with
 *     no recording.
 *   - a provider error       → warn per case, continue with the others, so one
 *     bad voice id does not cost four recordings.
 *   - the file already exists→ skip. Re-running the seed must not re-bill the
 *     synthesis calls or churn the assets.
 *
 * Run: bun scripts/seed-demo-audio.mjs   (or: bun run db:seed:audio)
 */

import { mkdir, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { ElevenLabs } from "@elevenlabs/elevenlabs-js";

const OUT_DIR = path.join(process.cwd(), "public", "demo-audio");

/**
 * The five cases that carry a recording, mirroring `RECENT_CALLS` in
 * src/lib/data.ts. Languages and voices follow `TTS_VOICE` in
 * src/lib/voice-client.ts — a demo recording in a different voice from the live
 * path would be a small lie about what the product sounds like.
 */
const CASES = [
  {
    ref: "SV-8642",
    lang: "ar",
    voiceId: process.env.DEMO_VOICE_AR ?? "21m00Tcm4TlvDq8ikWAM",
    lines: [
      { text: "This call is from your bank fraud team. Is now a good time?" },
      {
        text: "We are calling about a transaction of two thousand five hundred dirhams at Electronics World. Did you make it?",
      },
      {
        text: "Understood. We have placed a temporary hold on the card ending four four one seven.",
      },
    ],
  },
  {
    ref: "SV-8641",
    lang: "en",
    voiceId: process.env.DEMO_VOICE_EN ?? "21m00Tcm4TlvDq8ikWAM",
    lines: [
      { text: "Hi Priya, this is the fraud team at your bank. Is now a good time?" },
      {
        text: "We are calling about eight thousand one hundred twenty dirhams to an online currency exchange. Did you make it?",
      },
      { text: "We have placed a temporary hold on the card ending seven seven zero two." },
    ],
  },
  {
    ref: "SV-8640",
    lang: "en",
    voiceId: process.env.DEMO_VOICE_EN ?? "21m00Tcm4TlvDq8ikWAM",
    lines: [
      { text: "Assalam-o-alaikum, this is the fraud team calling about your account." },
      {
        text: "We are calling about nine hundred fifty dirhams in telecom top-ups. Did you make these?",
      },
      { text: "I am transferring you to a fraud specialist now. Please stay on the line." },
    ],
  },
  {
    ref: "SV-8639",
    lang: "en",
    voiceId: process.env.DEMO_VOICE_EN ?? "21m00Tcm4TlvDq8ikWAM",
    lines: [
      { text: "Hi Grace, this is the fraud team at your bank. Is now a good time?" },
      { text: "We are calling about a grocery transaction abroad. Did you make it?" },
      { text: "Thank you for confirming. No action has been taken on your card." },
    ],
  },
  {
    ref: "SV-8638",
    lang: "ar",
    voiceId: process.env.DEMO_VOICE_AR ?? "21m00Tcm4TlvDq8ikWAM",
    lines: [
      { text: "This call is from your bank fraud team about a transaction." },
      { text: "We were unable to reach you. We will try again at nine in the morning." },
    ],
  },
];

const exists = (p) =>
  access(p, constants.F_OK).then(
    () => true,
    () => false,
  );

async function synthesize(client, { ref, voiceId, lines }) {
  // One request per case, with the lines joined — ElevenLabs' per-request cost
  // makes a five-request-per-case loop materially more expensive for a marginally
  // better pause between sentences.
  const text = lines.map((l) => l.text).join(" ");
  const audio = await client.textToSpeech.convert({
    text,
    modelId: "eleven_multilingual_v2",
    voiceId,
    outputFormat: "mp3_44100_128",
  });
  // The SDK returns a stream for some output formats and an ArrayBuffer for
  // others; normalize rather than assuming, because a silent zero-byte file is
  // exactly the failure this script exists to prevent.
  const bytes =
    audio instanceof ArrayBuffer ? Buffer.from(audio) : Buffer.from(await audio.arrayBuffer());
  if (bytes.length === 0) throw new Error("provider returned zero bytes");
  const file = path.join(OUT_DIR, `${ref}.mp3`);
  await writeFile(file, bytes);
  return { file, bytes: bytes.length };
}

async function main() {
  const apiKey = process.env.ELEVENLABS_API_KEY ?? "";
  if (apiKey.length < 8) {
    console.warn(
      "⚠ ELEVENLABS_API_KEY is not set — no demo recordings written.\n" +
        "  The dashboard will show a 'sealed' chip instead of a play button, which is the\n" +
        "  honest state: there is no recording, because none was ever made.",
    );
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });
  const client = new ElevenLabs({ apiKey });

  let written = 0;
  let skipped = 0;
  let failed = 0;

  for (const c of CASES) {
    const file = path.join(OUT_DIR, `${c.ref}.mp3`);
    if (await exists(file)) {
      skipped++;
      console.log(`· ${c.ref} — already present, skipped`);
      continue;
    }
    try {
      const { bytes } = await synthesize(client, c);
      written++;
      console.log(`✓ ${c.ref} — ${(bytes / 1024).toFixed(0)} KB`);
    } catch (err) {
      failed++;
      // One failure must not cost the other four recordings.
      console.warn(`✗ ${c.ref} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(
    `done — ${written} written, ${skipped} skipped, ${failed} failed → ${path.relative(process.cwd(), OUT_DIR)}`,
  );
  if (failed > 0) {
    console.warn("  Rows with no file render as 'sealed'; that is the intended honest fallback.");
  }
}

main().catch((e) => {
  console.error("seed-demo-audio failed:", e.message);
  process.exit(1);
});
