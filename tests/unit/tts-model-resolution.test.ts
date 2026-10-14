/**
 * UNIT — one TTS model per language, and both routes agree.
 *
 * The streaming route used to re-derive the model locally:
 *
 *     const model = lang === "sw" ? "eleven_flash_v2_5" : (env ?? "eleven_v3");
 *
 * Two defects, both invisible in a code review that only reads the happy path:
 *
 *   1. It IGNORED ELEVENLABS_MODEL for every language except Swahili. An
 *      operator who set the env var got `eleven_v3` anyway, and had no way to
 *      discover that except a 402 from the vendor.
 *   2. `eleven_flash_v2_5` CANNOT SPEAK SWAHILI. Neither multilingual v2 nor
 *      flash v2.5 carries Swahili — only the v3 and newer v4-turbo generations
 *      do (src/lib/
 *      elevenlabs/client.ts documents this at MODEL_FOR_LANG; ur/sw now pin to
 *      eleven_v4_turbo). So the streaming
 *      path routed Swahili to a model that cannot voice it, while the buffered
 *      path did the right thing. Same user, same language, two different
 *      voices depending on which route the caller hit.
 *
 * This pins the resolution so a future per-route special case cannot come back.
 * The server route is asserted by READING its source: importing a Next route
 * handler here would pull in `next/server` and the whole request pipeline, and
 * the thing being protected is a one-line ternary — reading it is both stronger
 * evidence and cheaper than executing it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TTS_LANGUAGE_SUPPORT, resolveTtsModel, type TtsLang } from "@/lib/elevenlabs/client";

const LANGS: readonly TtsLang[] = ["en", "ar", "hi", "ur", "fr", "sw"];

const ROOT = join(import.meta.dir, "..", "..");

function routeSource(relative: string): string {
  return readFileSync(join(ROOT, "src", "app", "api", relative), "utf8");
}

describe("TTS model resolution", () => {
  test("every supported language resolves to a non-empty model id", () => {
    for (const lang of LANGS) {
      expect({ lang, model: resolveTtsModel(lang) }).toEqual({
        lang,
        model: expect.any(String),
      });
      expect(resolveTtsModel(lang).length).toBeGreaterThan(0);
    }
  });

  test("Urdu and Swahili resolve to a model that can actually voice them", () => {
    // The bug this file exists for. Swahili and Urdu are absent from BOTH
    // multilingual v2 and flash v2.5, so a fallback to either of those is a
    // silent downgrade to a model that will not speak the language at all.
    // They pin to eleven_v4_turbo (not v3): v4_turbo voices both on the key in
    // .env (verified 2026-10-09) and, unlike v3, is not gated in the agent plane.
    for (const lang of ["ur", "sw"] as const) {
      const model = resolveTtsModel(lang);
      expect({ lang, model, canSpeak: TTS_LANGUAGE_SUPPORT[lang].v4_turbo }).toEqual({
        lang,
        model: "eleven_v4_turbo",
        canSpeak: true,
      });
    }
  });

  test("no language resolves to flash v2.5 for a language it cannot voice", () => {
    // Belt and braces: whatever MODEL_FOR_LANG grows, the resolved id must be a
    // generation that covers the language. Asserted against the support table
    // rather than a literal so the two cannot drift apart silently.
    for (const lang of LANGS) {
      const model = resolveTtsModel(lang);
      const support = TTS_LANGUAGE_SUPPORT[lang];
      if (model === "eleven_v4_turbo") {
        expect(support.v4_turbo).toBe(true);
      } else if (model === "eleven_v3") {
        expect(support.v3).toBe(true);
      } else {
        expect(support.multilingual_v2).toBe(true);
      }
    }
  });

  test("the console and the live call speak the same model in every language", () => {
    // Measured on the deploy box 2026-10-13: ELEVENLABS_MODEL was
    // `eleven_multilingual_v2` while the agent the customer actually talks to runs
    // `eleven_v4_turbo`. Same sentence, two different voices depending on whether
    // you heard it in the console preview or on the phone — and nothing in the tree
    // compared the two, because the agent's model lives in agent/*.yaml and the
    // caller's lives in config.ts, and neither reads the other.
    //
    // This is the assertion that closes that gap: one model per language across both
    // planes. It fails the moment either side is changed alone.
    const yaml = readFileSync(join(ROOT, "agent", "securevoice.agent.yaml"), "utf8");
    // `""` + a throw rather than `?.[1]` trusting an assertion downstream: with no
    // model declared, every comparison below would be "" === "" and the gate would
    // certify a yaml that says nothing.
    const agentModel = yaml.match(/^tts:$(?:\n[ \t].*)*?\n[ \t]+model_id:[ \t]*(\S+)/m)?.[1] ?? "";
    if (!agentModel) {
      throw new Error(
        "agent/securevoice.agent.yaml declares no tts.model_id — this gate would " +
          "pass on an empty match, so it certifies nothing",
      );
    }
    // Measured against the SHIPPED default, not the ambient environment: a repo gate
    // cannot see a deployment's .env, and a developer machine that pins
    // ELEVENLABS_MODEL would otherwise turn this red for a reason CI cannot observe.
    // A deployment that overrides the model is on record (`.env.example`) to keep it
    // equal to the agent's, which is the same rule, just enforced by reading.
    const prev = process.env.ELEVENLABS_MODEL;
    try {
      delete process.env.ELEVENLABS_MODEL;
      for (const lang of LANGS) {
        expect({ lang, caller: resolveTtsModel(lang), agent: agentModel }).toEqual({
          lang,
          caller: agentModel,
          agent: agentModel,
        });
      }
    } finally {
      if (prev === undefined) delete process.env.ELEVENLABS_MODEL;
      else process.env.ELEVENLABS_MODEL = prev;
    }
  });

  test("the compose default is that same model, because the worker reads no env_file", () => {
    // `app` declares `env_file: .env`; `voice-stream-worker` does not. So for the
    // service that carries a live customer's audio, the `${ELEVENLABS_MODEL:-…}`
    // interpolation in docker-compose.yml IS the deployment default when `.env`
    // omits the variable — and it carried eleven_multilingual_v2, a model that
    // cannot voice Urdu or Swahili, after the code default moved to
    // eleven_v4_turbo. Every English test stayed green, which is the whole problem.
    const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
    const defaults = [
      ...compose.matchAll(/ELEVENLABS_MODEL:\s*\$\{ELEVENLABS_MODEL:-([^\}]+)\}/g),
    ].map((m) => m[1]);
    if (defaults.length === 0) {
      throw new Error(
        "docker-compose.yml no longer interpolates ELEVENLABS_MODEL with a default — " +
          "this gate is the only thing keeping the worker's model in sync, so update " +
          "it rather than letting it pass on an empty list",
      );
    }
    const prev = process.env.ELEVENLABS_MODEL;
    delete process.env.ELEVENLABS_MODEL;
    try {
      for (const lang of LANGS) {
        for (const d of defaults) {
          expect({ lang, compose: d, code: resolveTtsModel(lang) }).toEqual({
            lang,
            compose: resolveTtsModel(lang),
            code: resolveTtsModel(lang),
          });
        }
      }
    } finally {
      if (prev === undefined) delete process.env.ELEVENLABS_MODEL;
      else process.env.ELEVENLABS_MODEL = prev;
    }
  });

  test("the streaming route resolves through the shared table, not a local ternary", () => {
    const src = routeSource("tts/stream/route.ts");
    // The regression in its original form.
    expect(src).not.toMatch(/eleven_flash_v2_5/);
    expect(src).not.toMatch(/lang\s*===\s*["']sw["']\s*\?/);
    expect(src).toContain("resolveTtsModel(lang)");
  });

  test("no speech path carries a model literal that bypasses the deployment", () => {
    // elevenlabs-stream.ts defaulted to a hardcoded model when a caller omitted
    // `modelId`. Every caller supplies one today, so the literal was inert — which is
    // exactly how it would have become the bug: the first caller that forgets it puts
    // one live conversation plane on a different voice from the rest of the
    // deployment, and nothing reports the difference.
    const stream = readFileSync(join(ROOT, "src", "lib", "voice", "elevenlabs-stream.ts"), "utf8");
    expect(stream).not.toMatch(/modelId\s*\?\?\s*["']eleven_/);
    // The same file carried the voice character as literals — `stability: 0.5` —
    // while src/lib/config.ts documents a deliberate 0.7 for this agent ("this
    // agent reads money back to a frightened cardholder", and lower stability is
    // more expressive variance between utterances). The knob existed, was
    // documented in .env.example, was applied to the console preview, and never
    // reached live call audio. A settings literal here is the deployment's
    // `TTS_VOICE_*` being silently ignored on the plane customers actually hear.
    expect(stream).not.toMatch(/voiceSettings:\s*\{[^}]*stability:\s*[\d.]/);
    expect(stream).not.toMatch(/voiceSettings:\s*\{[^}]*similarityBoost:\s*[\d.]/);
    expect(stream).toContain("env.voiceStability");
    expect(stream).toContain("env.voiceSimilarityBoost");
  });
});
