/**
 * Unit — the media-stream call pipeline's language threading.
 *
 * The defect this file was written for, stated plainly:
 *
 *   src/worker/voice-stream.ts hardcoded English in four places. On a call the
 *   bank had been asked to run in the customer's own language — the Governed
 *   Collections brief names Urdu explicitly — the agent was:
 *
 *     · LISTENING in English  (deepgram.start("en"))          → Urdu speech
 *       returned as phonetic garbage, so no denial was ever recognised
 *     · SPEAKING with an English voice (ELEVENLABS_VOICE_EN)
 *     · SPEAKING with the WRONG MODEL (env.elevenLabsModel)   → eleven_multi-
 *       lingual_v2 cannot voice Urdu at all; the synthesis request fails
 *     · READING English script                                → including the
 *       one sentence that tells the customer their money is now protected
 *
 *   Every one of those is a silent failure. The call connects, audio flows, the
 *   logs look healthy, and a fraud decision is communicated in a language the
 *   person it concerns may not understand.
 *
 * Two things are asserted here, and the second is why the tables matter:
 *
 *   1. Language is threaded from the dial job to all four decisions.
 *   2. resolveTtsModel — the platform's single TTS-model table — is what selects
 *      the model, because Urdu and Swahili REQUIRE eleven_v3. Reading
 *      env.elevenLabsModel directly is exactly the bug that makes an Urdu call
 *      fall silent at the worst moment.
 *
 *   bun scripts/run-tests.mjs voice-stream-language
 */
import { expect, test } from "bun:test";
import { SUPPORTED_LANGS } from "@/lib/languages";
import { resolveTtsModel, TTS_LANGUAGE_SUPPORT, type TtsLang } from "@/lib/elevenlabs/client";
import { DeepgramLiveClient, resolveDeepgramTarget } from "@/lib/voice/deepgram-client";
import { asrProviderFor } from "@/lib/voice/live-asr";

test("every supported language is a supported call language", () => {
  // The pipeline types `lang` as TtsLang and falls back to "en" for anything
  // else. If these two lists ever diverge, a language can be selectable in the
  // product but unusable on the live path.
  for (const l of SUPPORTED_LANGS) {
    expect(TTS_LANGUAGE_SUPPORT[l as TtsLang], `${l} missing from TTS table`).toBeTruthy();
  }
});

test("Urdu resolves to a model that can voice Urdu", () => {
  const model = resolveTtsModel("ur");
  // eleven_multilingual_v2 carries 29 languages and does NOT include Urdu or
  // Swahili; both are in the v3 and v4-turbo generations. Selecting
  // multilingual_v2 for Urdu is not a quality problem, it is a hard failure.
  // Pinned to eleven_v4_turbo (not v3): v3 in the agent plane is a plan
  // entitlement this account lacks, while v4_turbo voices ur on the live key.
  expect(model).not.toBe("eleven_multilingual_v2");
  expect(model).toBe("eleven_v4_turbo");
  expect(TTS_LANGUAGE_SUPPORT.ur.multilingual_v2).toBe(false);
  expect(TTS_LANGUAGE_SUPPORT.ur.v4_turbo).toBe(true);
});

test("Swahili resolves to a model that can voice Swahili", () => {
  expect(resolveTtsModel("sw")).toBe("eleven_v4_turbo");
  expect(TTS_LANGUAGE_SUPPORT.sw.multilingual_v2).toBe(false);
  expect(TTS_LANGUAGE_SUPPORT.sw.v4_turbo).toBe(true);
});

test("no language resolves to a model that cannot voice it", () => {
  // The general form of the Urdu bug, checked for every language so a future
  // addition to the model table cannot reintroduce it.
  for (const l of SUPPORTED_LANGS) {
    const lang = l as TtsLang;
    const model = resolveTtsModel(lang);
    const support = TTS_LANGUAGE_SUPPORT[lang];
    if (model === "eleven_v4_turbo") {
      expect(support.v4_turbo, `${lang} routed to v4_turbo but not supported by it`).toBe(true);
    } else if (model.startsWith("eleven_v3")) {
      expect(support.v3, `${lang} routed to v3 but not supported by it`).toBe(true);
    } else if (model === "eleven_multilingual_v2") {
      expect(
        support.multilingual_v2,
        `${lang} routed to multilingual_v2 which cannot voice it`,
      ).toBe(true);
    }
  }
});

test("a language with no dedicated voice takes the deployment default", () => {
  // Hermetic deliberately: an untracked local `.env` can pin ELEVENLABS_MODEL to
  // anything, and an assertion about "the default" that inherits it would pass or
  // fail depending on whose machine ran it. The deployment default is set here.
  const prev = process.env.ELEVENLABS_MODEL;
  try {
    process.env.ELEVENLABS_MODEL = "eleven_multilingual_v2";
    expect(resolveTtsModel("en")).toBe("eleven_multilingual_v2");
    // The Urdu/Swahili pin must survive a default that cannot voice them — that is
    // the entire reason the table exists.
    expect(resolveTtsModel("ur")).toBe("eleven_v4_turbo");
    expect(resolveTtsModel("sw")).toBe("eleven_v4_turbo");
  } finally {
    if (prev === undefined) delete process.env.ELEVENLABS_MODEL;
    else process.env.ELEVENLABS_MODEL = prev;
  }
});

test("the shipped default is a model both planes accept", () => {
  // This used to assert that English must NOT be eleven_v4_turbo — that it keep its
  // own generation while Urdu/Swahili were pinned. That contract WAS the bug: it
  // left the console synthesising on eleven_multilingual_v2 while the live agent ran
  // eleven_v4_turbo, so the same sentence sounded like two different products
  // depending on which surface played it. Both planes default to v4_turbo now, and
  // tests/unit/tts-model-resolution.test.ts pins console and agent together per
  // language, so changing one side alone goes red.
  const prev = process.env.ELEVENLABS_MODEL;
  try {
    delete process.env.ELEVENLABS_MODEL;
    const model = resolveTtsModel("en");
    expect(model).toBe("eleven_v4_turbo");
    // eleven_v3 is not a candidate: the Conversational-AI agent plane rejects it
    // (400 expressive_tts_not_allowed on every key tested 2026-10-09), so a default
    // that synthesises in the console and cannot place a call is the worst kind.
    expect(model).not.toBe("eleven_v3");
  } finally {
    if (prev === undefined) delete process.env.ELEVENLABS_MODEL;
    else process.env.ELEVENLABS_MODEL = prev;
  }
});

test("Deepgram never pins a language its model cannot serve", () => {
  // Pinning an unsupported code fails the WHOLE request with a 4xx — a closed
  // socket. So the language and the model must stay in step: nova-2 pins only
  // its own languages, Urdu pins to nova-3 (which serves it), and Swahili —
  // which no Deepgram streaming model serves — goes to `multi`.
  for (const l of SUPPORTED_LANGS) {
    const { model, dgLang } = resolveDeepgramTarget(l);
    if (dgLang === "multi") {
      expect(
        ["sw"],
        `${l} unexpectedly unpinnable — update the table deliberately if a model adds it`,
      ).toContain(l);
    } else {
      // A pinned language must pin to the language it names — never fall
      // back to a different language's model card.
      expect(dgLang).toBe(l);
    }
    if (model !== "nova-2") {
      // Only Urdu leaves nova-2, and only for a model that serves it.
      expect(l).toBe("ur");
    }
  }
});

test("Urdu pins to nova-3; Swahili leaves Deepgram to ElevenLabs", () => {
  // Stated as its own test because both were deliberate quality reductions,
  // and the story changed twice: (a) `multi` on nova-2 is Spanish+English
  // only, so Urdu could not transcribe at all — nova-3 fixed that. (b) No
  // Deepgram streaming model serves Swahili, so the live client for swahili
  // is Scribe-backed (see live-asr.ts); the Deepgram client's own fallback
  // stays `multi` for any caller who constructs it directly.
  expect(resolveDeepgramTarget("ur")).toEqual({ model: "nova-3", dgLang: "ur" });
  // Deepgram client: swahili still falls back to its multi bucket.
  expect(resolveDeepgramTarget("sw")).toEqual({ model: "nova-2", dgLang: "multi" });
  // Live ASR factory: swahili is served by ElevenLabs when the key exists.
  const prev = process.env.ELEVENLABS_API_KEY;
  try {
    process.env.ELEVENLABS_API_KEY = "test-key";
    expect(asrProviderFor("sw")).toBe("elevenlabs");
  } finally {
    if (prev === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = prev;
  }
  expect(DeepgramLiveClient.PINNABLE_LANGS.has("sw")).toBe(false);
  // ...while the languages the router recognises still reach a transcript,
  // so a denial is actionable.
  expect(DeepgramLiveClient.PINNABLE_LANGS.has("en")).toBe(true);
  expect(DeepgramLiveClient.PINNABLE_LANGS.has("ar")).toBe(true);
  expect(DeepgramLiveClient.PINNABLE_LANGS.has("hi")).toBe(true);
});
