/**
 * Record the agent's REAL voice for the demo film.
 *
 * The film's sound is the product's own voice, not a stock voice-over: each
 * line is synthesised by the live /api/tts/stream endpoint on production, so
 * what the viewer hears is the same voice the agent uses on a call. The mp3s
 * are written into demo-film/assets/ for the composition to time.
 */
import fs from "node:fs";
import path from "node:path";

const BASE =
  process.argv.find((a) => a.startsWith("--base-url="))?.slice("--base-url=".length) ||
  "https://securevoiceai.me";
const OUT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
  "..",
  "demo-film",
  "assets",
);
fs.mkdirSync(OUT, { recursive: true });

// The agent's real lines, per locale, exactly as the live panel renders them.
const LINES = [
  {
    name: "voice-ar",
    lang: "ar",
    role: "agent",
    text: "هذه المكالمة مسجلة لحمايتك. أنا مساعد آلي يعمل بالذكاء الاصطناعي، ولست إنساناً. أأسف لما حدث — تصرفك صحيح تماماً. أبلغت عن هذه العملية كاحتيال، ووضعت قيداً مؤقتاً على بطاقتك بينما يراجعها اختصاصي في الاحتيال.",
  },
  {
    name: "voice-en",
    lang: "en",
    role: "agent",
    text: "This call is recorded to protect you. I am an automated AI assistant, not a human. I'm sorry that happened — you did the right thing reporting it. I have flagged this transaction as fraud and placed a temporary restriction on your card while a human fraud specialist reviews it.",
  },
  {
    name: "voice-en-question",
    lang: "en",
    role: "customer",
    text: "That transaction is not mine.",
  },
];

for (const line of LINES) {
  const r = await fetch(`${BASE}/api/tts/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: line.text, lang: line.lang, role: line.role }),
  });
  if (!r.ok) {
    console.log(`  ✗ ${line.name} → ${r.status}`);
    continue;
  }
  const bytes = Buffer.from(await r.arrayBuffer());
  const file = path.join(OUT, `${line.name}.mp3`);
  fs.writeFileSync(file, bytes);
  console.log(`  ✓ ${line.name}.mp3  ${(bytes.length / 1024).toFixed(0)} KB`);
}
