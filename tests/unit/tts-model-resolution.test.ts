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
 *      flash v2.5 carries Swahili — only the v3 generation does (src/lib/
 *      elevenlabs/client.ts documents this at MODEL_FOR_LANG). So the streaming
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
    for (const lang of ["ur", "sw"] as const) {
      const model = resolveTtsModel(lang);
      expect({ lang, model, canSpeak: TTS_LANGUAGE_SUPPORT[lang].v3 }).toEqual({
        lang,
        model: "eleven_v3",
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
      if (model === "eleven_v3") {
        expect(TTS_LANGUAGE_SUPPORT[lang].v3).toBe(true);
      } else {
        expect(TTS_LANGUAGE_SUPPORT[lang].multilingual_v2).toBe(true);
      }
    }
  });

  test("the streaming route resolves through the shared table, not a local ternary", () => {
    const src = routeSource("tts/stream/route.ts");
    // The regression in its original form.
    expect(src).not.toMatch(/eleven_flash_v2_5/);
    expect(src).not.toMatch(/lang\s*===\s*["']sw["']\s*\?/);
    expect(src).toContain("resolveTtsModel(lang)");
  });
});
