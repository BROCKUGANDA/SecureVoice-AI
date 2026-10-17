/**
 * Translation coverage — the gate that stops a half-translated language shipping.
 *
 * The failure this prevents is the default one. `t()` falls back to English for
 * any language whose strings are not translated, which is correct behaviour and
 * the worst possible behaviour at the same time: a visitor picks हिन्दी from the
 * picker and receives a page that is entirely English except the flag, and
 * nothing anywhere records that the two disagree.
 *
 * So the invariant is stated as a TABLE rather than left implicit:
 *
 *   1. every language the picker offers appears in the registry (a picker entry
 *      with no registry entry cannot be resolved, and `resolveUiLang` would
 *      silently downgrade it to English at runtime);
 *   2. every registry language is offered by the picker;
 *   3. `TRANSLATED_UI_LANGS` is exactly the set `t()` will render in something
 *      other than English — i.e. a language may not be ADDED to the translated
 *      set without strings existing, and may not be translated without declaring
 *      it;
 *   4. every language with a glossary declares where its terminology came from,
 *      because "we translated it ourselves" is how banking vocabulary ends up
 *      meaning something subtly different in a regulator's hands;
 *   5. the VOICE language set and the UI language set are compared explicitly,
 *      and any difference is a deliberate, visible one. They are currently the
 *      same six, but they answer different questions and conflating them is the
 *      mistake this test exists to catch.
 *
 * Point 5 is why this file is not just a copy of SUPPORTED_LANGS: the voice
 * layer can speak a language the interface cannot render, and when that happens
 * the operator-visible fix is to translate the UI, not to hide the voice option.
 */
import { describe, expect, test } from "bun:test";
import {
  GLOSSARY_STATUS,
  TRANSLATED_UI_LANGS,
  UI_LANG_BCP47,
  UI_LANG_LABEL,
  UI_LANGS,
  isUiLangTranslated,
  resolveUiLang,
  type UiLang,
} from "@/lib/i18n/registry";
import { SUPPORTED_LANGS } from "@/lib/languages";
import { t } from "@/lib/store";

describe("UI language registry", () => {
  test("every offered language is registered, and every registered language is offered", () => {
    for (const lang of UI_LANGS) {
      expect(UI_LANG_LABEL[lang], `${lang} has no label`).toBeTruthy();
      expect(UI_LANG_BCP47[lang], `${lang} has no BCP-47 tag`).toBeTruthy();
      expect(GLOSSARY_STATUS[lang], `${lang} has no glossary provenance`).toBeTruthy();
    }
    // The label map and the list are the same set, from both directions, so
    // adding a language to one and forgetting the other fails here.
    expect(Object.keys(UI_LANG_LABEL).sort()).toEqual([...UI_LANGS].sort());
    expect(Object.keys(GLOSSARY_STATUS).sort()).toEqual([...UI_LANGS].sort());
  });

  test("the translated set is exactly what t() will render as non-English", () => {
    // The load-bearing assertion. A language added to TRANSLATED_UI_LANGS
    // without strings existing renders English under a foreign flag; one left
    // out while strings DO exist leaves finished work invisible.
    for (const lang of UI_LANGS) {
      const rendered = t("ENGLISH", "ARABIC", lang);
      // English is the SOURCE language, so `t()` returns the en slot for every
      // input and is trivially "translated". The invariant is that the registry
      // and `t()` agree:
      //   · a declared-translated non-English language renders the ar slot;
      //   · an undeclared one falls back to the en slot rather than claiming a
      //     translation that does not exist.
      const declared = isUiLangTranslated(lang);
      const rendersForeign = rendered === "ARABIC";
      expect(
        declared,
        `${lang}: registry says translated=${declared} but t() rendered ${rendered}`,
      ).toBe(rendersForeign || lang === "en");
      if (lang !== "en") {
        expect(rendered, `${lang} rendered ${rendered}`).toBe(declared ? "ARABIC" : "ENGLISH");
      }
    }
  });

  test("only Arabic is translated today, and that is recorded rather than implied", () => {
    // Pinned so that adding a language is a DELIBERATE edit to this expectation,
    // which is when the glossary decision should be revisited.
    expect([...TRANSLATED_UI_LANGS].sort()).toEqual(["ar", "en"]);
    // The three whose domain vocabulary is absent from their own Wikipedia.
    for (const lang of ["hi", "ur", "sw"] as UiLang[]) {
      expect(GLOSSARY_STATUS[lang].status, `${lang} glossary source`).toBe("translator-required");
    }
    // French is the exception: its banking/AML vocabulary IS documented, so it
    // needs a translator but not a glossary written from scratch.
    expect(GLOSSARY_STATUS.fr.status).toBe("translator-required");
  });

  test("French is sourced, because fr.wikipedia actually has the vocabulary", () => {
    // The asymmetry with hi/ur/sw is real and load-bearing, so it is asserted
    // rather than left as a comment: French banking/AML terminology IS
    // documented (fr.wikipedia `Fraude`, Code de commerce L.121-1), and the
    // other three genuinely are not. The status is still
    // `translator-required` for all four — sources make the glossary authorable,
    // they do not replace a qualified translator.
    expect(GLOSSARY_STATUS.fr.note).toContain("Fraude");
    expect(GLOSSARY_STATUS.hi.note).toContain("hi.wikipedia");
    expect(GLOSSARY_STATUS.ur.note).toContain("ur.wikipedia");
    expect(GLOSSARY_STATUS.sw.note).toContain("sw.wikipedia");
  });

  test("resolveUiLang accepts tags, sub-tags and junk, and never invents a language", () => {
    expect(resolveUiLang("ar-AE")).toBe("ar");
    expect(resolveUiLang("HI")).toBe("hi");
    expect(resolveUiLang("sw_KE")).toBe("sw");
    expect(resolveUiLang("pt-BR")).toBe("en");
    expect(resolveUiLang("")).toBe("en");
    expect(resolveUiLang(null)).toBe("en");
    // A tag that resolves to a language must actually be in the registry.
    for (const lang of UI_LANGS) {
      expect(resolveUiLang(lang)).toBe(lang);
    }
  });

  test("the voice set and the UI set are compared explicitly", () => {
    // They answer different questions: SUPPORTED_LANGS is "what can the agent
    // speak", UI_LANGS is "what can the interface render". They coincide today.
    // When they stop coinciding the difference is intentional, so this records
    // it rather than letting one quietly drift from the other.
    const voice = new Set<string>(SUPPORTED_LANGS);
    const ui = new Set<string>(UI_LANGS);
    const voiceOnly = [...voice].filter((l) => !ui.has(l));
    const uiOnly = [...ui].filter((l) => !voice.has(l));
    console.log(
      `[i18n] voice languages: ${voice.size}, UI languages: ${ui.size}` +
        (voiceOnly.length ? `, spoken but not offered in the UI: ${voiceOnly.join(", ")}` : "") +
        (uiOnly.length ? `, offered but not spoken: ${uiOnly.join(", ")}` : ""),
    );
    expect(voiceOnly, "a spoken language vanished from the UI picker").toEqual([]);
    expect(uiOnly, "the UI offers a language the agent cannot speak").toEqual([]);
  });
});
