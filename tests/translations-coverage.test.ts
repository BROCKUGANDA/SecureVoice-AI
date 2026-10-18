/**
 * Translation coverage — the gate that stops a half-translated language shipping.
 *
 * The failure this prevents is the default one. `t()` falls back to English for
 * any language whose strings are not translated, which is correct behaviour and
 * the worst possible behaviour at the same time: a visitor picks हिन्दी from the
 * picker and receives a page that is entirely English except the flag, and
 * nothing anywhere records that the two disagree.
 *
 * The product rule this file now enforces, decided 2026-10-18:
 *
 *   THE INTERFACE IS ENGLISH AND ARABIC. A CALL AND AN SMS ARE DELIVERED IN SIX.
 *
 * That is not a downgrade of the delivery layer — hi/ur/fr/sw keep their
 * hand-written phone and SMS copy (src/lib/outreach-copy.ts, src/lib/twilio.ts,
 * the scenario packs). What they never had, and were never supposed to advertise,
 * is a translated screen. Until this rule, `UI_LANGS` was written out as six codes
 * next to `TRANSLATED_UI_LANGS` of two, the picker offered six buttons, and four of
 * them silently rendered English. The invariants:
 *
 *   1. the picker offers exactly the languages that are translated — and it is
 *      DERIVED from that set, so offering an untranslated language is not a
 *      test failure but a compile-time absence: there is no other way to add a
 *      button to the header;
 *   2. every language the interface offers exists in the spoken set (an
 *      untranslated screen is a bug; an unspellable one is nonsense);
 *   3. the four spoken-but-not-interface languages are asserted by name, so a
 *      fifth picker button is a deliberate edit here and nowhere else;
 *   4. every SPOKEN language still declares where its banking/AML terminology
 *      would come from, because "we translated it ourselves" is how domain
 *      vocabulary ends up meaning something subtly different in a regulator's
 *      hands;
 *   5. `resolveUiLang` sends a Hindi browser to English — the browser's language
 *      is not a claim the interface can honour, and the old expectation
 *      (`resolveUiLang("HI") === "hi"`) was the bug, not the spec.
 *
 * Point 5 is why this file is not just a copy of SUPPORTED_LANGS: the voice layer
 * speaks a language the interface cannot render, and the honest outcome is a Hindi
 * call plus an English screen — stated in code, tested in both directions.
 */
import { describe, expect, test } from "bun:test";
import {
  ARABIC_SCRIPT_LANGS,
  GLOSSARY_STATUS,
  TRANSLATED_UI_LANGS,
  UI_LANG_BCP47,
  UI_LANG_SHORT,
  UI_LANGS,
  isUiLangTranslated,
  resolveUiLang,
} from "@/lib/i18n/registry";
import { SUPPORTED_LANGS, type Lang } from "@/lib/languages";
import { t } from "@/lib/store";

/** Spoken on the phone and written in SMS, but never offered as a screen. */
const DELIVERY_ONLY: readonly Lang[] = ["hi", "ur", "fr", "sw"];

describe("UI language registry", () => {
  test("the picker offers exactly the translated languages, derived not duplicated", () => {
    // The derivation IS the rule. If `UI_LANGS` is ever written out as its own
    // literal again, this fails and someone has to decide on purpose.
    expect([...UI_LANGS].sort()).toEqual([...TRANSLATED_UI_LANGS].sort());
    // Every label the header can draw exists for every offered language, from
    // both directions, so adding a language to one list and forgetting the other
    // fails here rather than rendering an undefined pill.
    const offered = [...UI_LANGS].sort();
    expect(Object.keys(UI_LANG_SHORT).sort()).toEqual(offered);
    expect(Object.keys(UI_LANG_BCP47).sort()).toEqual(offered);
    for (const lang of UI_LANGS) {
      // The two maps the shell actually renders: the pill label and the
      // `<html lang>` tag. A missing entry renders an undefined pill or drops
      // the language tag, so both are asserted from both directions.
      expect(UI_LANG_SHORT[lang], `${lang} has no pill label`).toBeTruthy();
      expect(UI_LANG_BCP47[lang], `${lang} has no BCP-47 tag`).toBeTruthy();
    }
  });

  test("the interface pair is English and Arabic, and nothing else", () => {
    // Pinned by value, so widening the palette is a deliberate edit to this line
    // rather than a side effect of adding a voice language.
    expect([...UI_LANGS].sort()).toEqual(["ar", "en"]);
  });

  test("glossary provenance covers every SPOKEN language, not just the screen", () => {
    // This is the question that has to be answered BEFORE a language can join the
    // interface: is there a citable source for "card freeze" and "unauthorised
    // transaction" in it. Keyed by the spoken set so the four delivery-only
    // languages keep their recorded answer instead of going unasserted.
    expect(Object.keys(GLOSSARY_STATUS).sort()).toEqual([...SUPPORTED_LANGS].sort());
    for (const lang of SUPPORTED_LANGS) {
      expect(GLOSSARY_STATUS[lang].status, `${lang} declares no glossary source`).toBeOneOf([
        "authoritative",
        "translator-required",
      ]);
      expect(GLOSSARY_STATUS[lang].note, `${lang} has an empty glossary note`).toBeTruthy();
    }
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
    expect([...TRANSLATED_UI_LANGS].sort()).toEqual(["ar", "en"]);
    // The three whose domain vocabulary is absent from their own Wikipedia.
    for (const lang of ["hi", "ur", "sw"] as Lang[]) {
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

  test("resolveUiLang offers a screen only when it can render one", () => {
    expect(resolveUiLang("ar-AE")).toBe("ar");
    expect(resolveUiLang("ar")).toBe("ar");
    expect(resolveUiLang("en-GB")).toBe("en");
    expect(resolveUiLang("pt-BR")).toBe("en");
    expect(resolveUiLang("")).toBe("en");
    expect(resolveUiLang(null)).toBe("en");
    // A tag that resolves to a language must actually be in the registry.
    for (const lang of UI_LANGS) {
      expect(resolveUiLang(lang)).toBe(lang);
    }
    // The four delivery-only languages resolve to English. This is the customer-
    // visible half of the rule: a Hindi browser gets an English interface, and it
    // is asserted rather than fallen-into, because the previous version of this
    // test demanded `resolveUiLang("HI") === "hi"` — which is precisely how a
    // visitor ended up on an English page wearing a हिन्दी button.
    for (const lang of DELIVERY_ONLY) {
      expect(resolveUiLang(lang), `${lang} must not be offered as a screen`).toBe("en");
      expect(resolveUiLang(`${lang}-XX`)).toBe("en");
    }
    expect(resolveUiLang("HI")).toBe("en");
    expect(resolveUiLang("sw_KE")).toBe("en");
    expect(resolveUiLang("ur-PK")).toBe("en");
  });

  test("the spoken set and the interface set differ by exactly the four delivery languages", () => {
    // THE point of this file. Two sets answer two questions: SUPPORTED_LANGS is
    // "what can the agent speak and the SMS carry", UI_LANGS is "what can the
    // interface render". They are NOT equal, and the difference is the product
    // rule, so it is asserted in both directions by name rather than allowed to
    // drift either way.
    const spoken = new Set<string>(SUPPORTED_LANGS);
    const ui = new Set<string>(UI_LANGS);

    // No screen language may be unspellable.
    const uiOnly = [...ui].filter((l) => !spoken.has(l));
    expect(uiOnly, "the interface offers a language the voice layer cannot speak").toEqual([]);

    const spokenOnly = [...spoken].filter((l) => !ui.has(l)).sort();
    expect(spokenOnly, "the spoken-but-not-shown set changed; that is a product decision").toEqual([
      "fr",
      "hi",
      "sw",
      "ur",
    ]);
    expect(spokenOnly).toEqual([...DELIVERY_ONLY].sort());

    // And the four really are still delivered — shrinking the screen must not have
    // quietly deleted the phone and SMS capability. Membership in the spoken set is
    // what every delivery table is keyed by, so this is the guard against a cut made
    // in the wrong file.
    for (const lang of DELIVERY_ONLY) {
      expect(SUPPORTED_LANGS).toContain(lang);
    }
  });

  test("the Arabic-script set is a property of the script, not of the palette", () => {
    // `ur` needs the Arabic webfont and is not an interface language. If this ever
    // reads as a mistake, the thing to change is the font rule's keying, not the
    // palette.
    expect([...ARABIC_SCRIPT_LANGS].sort()).toEqual(["ar", "ur"]);
    for (const lang of ARABIC_SCRIPT_LANGS) {
      expect(SUPPORTED_LANGS).toContain(lang);
    }
    expect(ARABIC_SCRIPT_LANGS).toContain("ur");
    expect([...UI_LANGS]).not.toContain("ur");
  });
});
