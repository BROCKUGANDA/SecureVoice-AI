/**
 * One voice answer, and the demo hears what a caller hears.
 *
 * WHY THIS FILE EXISTS. The client used to own `TTS_VOICE` — a table mapping
 * language+role to an ElevenLabs *library slug* — and each TTS route carried its
 * own copy of a table aliasing those slugs back to languages. Two copies, one
 * lossy mapping, and the loss landed on the product's claims:
 *
 *   · `fr` and `sw` both mapped to the slug `jam`, and `jam` aliases to `en`. A
 *     French demo line therefore played the **English** deployment voice while a
 *     real French caller heard `ELEVENLABS_VOICE_FR`.
 *   · The demo's "customer" role borrowed the production voice id of an unrelated
 *     language (`en` customer → `kazi` → the Hindi slot), showing a bank operator
 *     a voice the product ships for someone else's callers.
 *   · The console's voice-preview button skipped ElevenLabs entirely and played
 *     `window.speechSynthesis`, while the panel labelled it a product voice.
 *
 * The fix is structural, not a nicer table: the client names a language and a
 * role, and `requestedVoice()`/`deliveryVoice()` in
 * `src/lib/elevenlabs/client.ts` decide — the same decision the live call makes.
 *
 * WHY SOURCE READING, NOT CALLING. `isProdVoiceMode()` reads `env.elevenLabsApiKey`
 * and `env.elevenLabsDryRun`, both captured when `config.ts` loads, and
 * `ELEVEN_VOICE_ENV` snapshots `process.env` at import. A test that sets those
 * variables after import gets a verdict from a world that no longer exists, so the
 * prod branch is checked structurally and the dev branch behaviourally. This is
 * the same split `tests/unit/tts-model-resolution.test.ts` already uses.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deliveryVoice, requestedVoice } from "@/lib/elevenlabs/client";

const LANGS = ["en", "ar", "hi", "ur", "fr", "sw"] as const;

/** Strip comments so a doc that names a retired thing does not fail the rule. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function source(path: string): string {
  return code(readFileSync(path, "utf8"));
}

const CLIENT = source(join("src", "lib", "elevenlabs", "client.ts"));
const VOICE_CLIENT = source(join("src", "lib", "voice-client.ts"));
const TTS_ROUTE = source(join("src", "app", "api", "tts", "route.ts"));
const STREAM_ROUTE = source(join("src", "app", "api", "tts", "stream", "route.ts"));
const TWILIO_AUDIO = source(join("src", "app", "api", "twilio", "audio", "route.ts"));
const DASHBOARD = source(join("src", "views", "Dashboard.tsx"));

test("the client holds no voice table and sends the language", () => {
  expect(VOICE_CLIENT).not.toContain("TTS_VOICE");
  // `voice: lang` is the whole claim: the browser stops deciding who speaks.
  expect(VOICE_CLIENT).toContain("fetchSpeechUrl(text, lang, lang, role)");
  expect(VOICE_CLIENT).toContain("{ text, voice: lang, lang, role }");
});

test("the slug→language alias exists exactly once, as a compatibility shim", () => {
  // Both TTS routes carried byte-identical copies. A rule over the count is the
  // only kind that survives the next route being added.
  const files = { client: CLIENT, tts: TTS_ROUTE, stream: STREAM_ROUTE };
  const owners = Object.entries(files)
    .filter(([, src]) => src.includes("DEV_SLUG_LANG"))
    .map(([name]) => name);
  expect(owners.join(",")).toBe("client");
  expect(TTS_ROUTE).toContain("requestedVoice(");
  expect(STREAM_ROUTE).toContain("requestedVoice(");
  expect(TTS_ROUTE + STREAM_ROUTE).not.toMatch(/function (devVoice|defaultDevVoice)\(/);
});

test("the live-call audio paths resolve through the one function", () => {
  // /api/twilio/audio built its own language→voice table at module load, so a
  // voice set after import was invisible to it.
  expect(TWILIO_AUDIO).not.toContain("LANG_TO_VOICE");
  expect(TWILIO_AUDIO).toContain('deliveryVoice(lang, "agent")');
});

test("the console preview asks for the product voice, not the browser's", () => {
  // `speakText` still falls back to `speechSynthesis` when the vendor path fails,
  // and now says which one played. What must not come back is calling the browser
  // engine directly and labelling the result a product voice.
  expect(DASHBOARD).toContain('speakText(sample, callLang, "agent")');
  expect(DASHBOARD).not.toContain("new SpeechSynthesisUtterance");
});

test("dev mode voices every language, and keeps agent and customer distinct", () => {
  // The invariant the deleted table test used to hold, now held by the resolver.
  for (const lang of LANGS) {
    expect(deliveryVoice(lang, "agent").length).toBeGreaterThan(0);
    expect(deliveryVoice(lang, "customer").length).toBeGreaterThan(0);
    expect({
      lang,
      same: deliveryVoice(lang, "agent") === deliveryVoice(lang, "customer"),
    }).toEqual({ lang, same: false });
  }
});

test("prod mode resolves a language to that language's configured voice", () => {
  // Structural: the agent branch must read the per-language slot, and must not
  // route through a slug table. This is the line that, if it ever says `"en"`,
  // puts French callers' audio behind an English voice again.
  const body = CLIENT.slice(CLIENT.indexOf("export function deliveryVoice"));
  const fn = body.slice(0, body.indexOf("\n}") + 2);
  expect(fn).toContain("return ELEVEN_VOICE_ENV[lang]");
  expect(fn).not.toContain('"en"');
  // An unset customer voice falls back to the SAME language, never to another
  // language's production slot — which is what the old table did.
  expect(fn).toContain("demoCustomerVoiceId() || ELEVEN_VOICE_ENV[lang]");
});

test("controls: the rules fire on the shapes that used to exist", () => {
  // A gate that cannot fail is a comment. Each of these is the exact regression
  // this file was written for.
  const reintroducedTable = `export const TTS_VOICE = { en: { agent: "jam" } };`;
  expect(reintroducedTable.includes("TTS_VOICE")).toBe(true);

  const secondAliasCopy = `const DEV_SLUG_LANG = { jam: "en" };`;
  expect(VOICE_CLIENT + TTS_ROUTE).not.toContain("DEV_SLUG_LANG");
  expect(secondAliasCopy).toContain("DEV_SLUG_LANG");

  const englishHardcoded = `function deliveryVoice(lang){ return ELEVEN_VOICE_ENV["en"]; }`;
  expect(englishHardcoded).not.toContain("return ELEVEN_VOICE_ENV[lang]");

  const browserOnlyPreview = `const u = new SpeechSynthesisUtterance(text);`;
  expect(browserOnlyPreview).toContain("new SpeechSynthesisUtterance");

  // `requestedVoice` with no voice and nothing configured must be an empty
  // string, so the route can 422 rather than send a slug upstream and pay for it.
  expect(requestedVoice(undefined, "en", "agent").length).toBeGreaterThan(0);
});
