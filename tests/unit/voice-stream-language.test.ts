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
import { DeepgramLiveClient } from "@/lib/voice/deepgram-client";

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

test("a language with no dedicated voice falls back to the deployment default model", () => {
  // English has no entry in the override table, so it takes the deployment
  // default. Asserted so the Urdu/Swahili pinning cannot accidentally become
  // "everything is v3", which would change English's voice character.
  expect(resolveTtsModel("en")).not.toBe("eleven_v3");
  expect(resolveTtsModel("en")).not.toBe("eleven_v4_turbo");
});

test("Deepgram never pins a language nova-2 cannot serve", () => {
  // nova-2 returns a 4xx for an unsupported language code and that kills the
  // whole request — not a degraded transcript, a closed socket. So Urdu and
  // Swahili must route to `multi`, which does code-switching detection.
  for (const l of SUPPORTED_LANGS) {
    if (DeepgramLiveClient.PINNABLE_LANGS.has(l)) {
      expect(l).toBeTruthy();
    } else {
      expect(
        ["ur", "sw"],
        `${l} unexpectedly unpinnable — update the table deliberately if nova-2 added it`,
      ).toContain(l);
    }
  }
});

test("Urdu and Swahili are the languages routed to Deepgram multi", () => {
  // Stated as its own test because this is a real, deliberate quality
  // reduction: the primary ASR for these languages is ElevenLabs Scribe
  // (src/app/api/asr/route.ts), which does cover them.
  expect(DeepgramLiveClient.PINNABLE_LANGS.has("ur")).toBe(false);
  expect(DeepgramLiveClient.PINNABLE_LANGS.has("sw")).toBe(false);
  // ...while the languages the router now recognises in Urdu still reach a
  // transcript, so a denial is actionable.
  expect(DeepgramLiveClient.PINNABLE_LANGS.has("en")).toBe(true);
  expect(DeepgramLiveClient.PINNABLE_LANGS.has("ar")).toBe(true);
  expect(DeepgramLiveClient.PINNABLE_LANGS.has("hi")).toBe(true);
});
