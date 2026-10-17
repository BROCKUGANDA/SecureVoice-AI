/**
 * UI language registry — which languages EXIST and which are actually TRANSLATED.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * The voice layer has spoken all six languages for a while: `SUPPORTED_LANGS`
 * in src/lib/languages.ts carries en/ar/hi/ur/fr/sw, and the agent speaks the
 * opening disclosure, the freeze confirmation and the handoff in each. The UI
 * had only two (`Lang = "en" | "ar"`), because a four-language UI is four
 * thousand translations and nobody had committed to them.
 *
 * The tempting shortcut is to widen the `Lang` union and let the four new
 * languages fall through to English. That is what this file exists to make
 * IMPOSSIBLE to do quietly:
 *
 *   · `t()` already returns the English string for anything that is not "ar",
 *     so an untranslated language renders a fully English page with a foreign
 *     language flag in the header. No error, no test failure, no log line — a
 *     visitor selects हिन्दी and silently receives English.
 *   · Nothing tracked the gap, so "the language picker offers six" read as
 *     "the product speaks six".
 *
 * So the registry separates the two questions. `UI_LANGS` is what the product
 * can speak on the phone. `TRANSLATED_UI_LANGS` is what the interface has
 * actually been translated into, and `t()` consults the latter. A language
 * cannot appear in the picker without also declaring whether it is translated,
 * and tests/translations-coverage.test.ts fails if the picker and the
 * translation set disagree in either direction.
 *
 * ── On the four untranslated languages ───────────────────────────────────────
 *
 * The glossary work behind adding hi/ur/fr/sw surfaced something worth recording
 * here, because it changes how the translation should be sourced:
 *
 * FRENCH has authoritative references. fr.wikipedia's `Fraude` article is a
 * properly sourced legal entry with the Code de commerce and Code criminel
 * article numbers, and French banking/AML terminology is documented.
 *
 * HINDI, URDU and SWAHILI do not, at least not for this domain. Checked
 * against the Wikipedias directly rather than assumed:
 *
 *   · hi.wikipedia has no article for banking fraud, card freezing or an
 *     unauthorised transaction. Searching the Hindi word for "fraud" returns
 *     unrelated entries.
 *   · ur.wikipedia returns فطی for the Urdu transliteration of "fraud", which is
 *     the physics term for ATOMIC — no banking article exists to disambiguate.
 *   · sw.wikipedia has no fraud article; searching returns unrelated results.
 *   · en.wiktionary returns English-only entries for the domain terms.
 *
 * So scraping "their dictionaries and Wikipedia" cannot produce this glossary.
 * The Hindi/Urdu/Kiswahili banking and AML vocabulary has to come from
 * qualified translators, and `GLOSSARY_STATUS` records that so the next person
 * does not repeat the search.
 */

/** A language the interface can be switched to. */
export type UiLang = "en" | "ar" | "hi" | "ur" | "fr" | "sw";

/** Endonym — the language's name in itself, which is what a picker shows. */
export const UI_LANG_LABEL: Record<UiLang, string> = {
  en: "English",
  ar: "العربية",
  hi: "हिन्दी",
  ur: "اردو",
  fr: "Français",
  sw: "Kiswahili",
};

/** BCP-47, for `<html lang>` and any `Intl` call. */
export const UI_LANG_BCP47: Record<UiLang, string> = {
  en: "en-GB",
  ar: "ar-AE",
  hi: "hi-IN",
  ur: "ur-PK",
  fr: "fr-FR",
  sw: "sw-KE",
};

/**
 * Compact labels for the language pill.
 *
 * The pill is `text-[11.5px]` inside a `shrink-0` cluster, so the full endonym
 * ("Kiswahili", "Français") does not fit without wrapping and breaking the header
 * height — the exact failure the Navbar comment above the nav describes. These
 * are deliberately shorter than `UI_LANG_LABEL` and are NOT a second source of
 * truth for the language's name: the picker shows these, everywhere else shows
 * the endonym.
 */
export const UI_LANG_SHORT: Record<UiLang, string> = {
  en: "EN",
  ar: "عربي",
  hi: "हि",
  ur: "ا",
  fr: "FR",
  sw: "SW",
};

/** Languages whose script needs the Arabic webfont, not the Latin one. */
export const ARABIC_SCRIPT_LANGS: readonly UiLang[] = ["ar", "ur"];

/** Every language the picker may offer. */
export const UI_LANGS: readonly UiLang[] = ["en", "ar", "hi", "ur", "fr", "sw"];

/**
 * Languages whose UI strings are actually translated.
 *
 * English is the source language and therefore trivially complete; Arabic is the
 * only translated one. The other four are spoken on the phone but their UI is
 * English, and this set is what keeps that distinction honest.
 */
export const TRANSLATED_UI_LANGS: readonly UiLang[] = ["en", "ar"];

/**
 * Where the terminology for each language has to come from.
 *
 * `authoritative` means there is a citable, sourced reference for the banking and
 * AML vocabulary. `translator-required` means the references do not exist in
 * that language's Wikipedia/Wiktionary and the glossary must be written by a
 * qualified translator — see the note at the top of this file for the searches
 * that established it.
 */
export const GLOSSARY_STATUS: Record<
  UiLang,
  { status: "authoritative" | "translator-required"; note: string }
> = {
  en: { status: "authoritative", note: "source language" },
  ar: {
    status: "authoritative",
    note: "UAE PDPL / Federal Decree-Law 45 of 2021 vocabulary; reviewed in-repo",
  },
  fr: {
    status: "translator-required",
    note: "fr.wikipedia `Fraude` IS a sourced legal entry (Code de commerce L.121-1, Code criminel art. 380) and French banking/AML vocabulary is documented, so the glossary is authorable from sources — but producing 1,235 reviewed French UI strings is still a translator's job, not a scrape",
  },
  hi: {
    status: "translator-required",
    note: "hi.wikipedia has no banking-fraud, card-freeze or unauthorised-transaction article; searching the Hindi word for fraud returns unrelated entries",
  },
  ur: {
    status: "translator-required",
    note: "ur.wikipedia returns فطی (physics: atomic) for the Urdu transliteration of 'fraud'; no banking article exists to disambiguate",
  },
  sw: {
    status: "translator-required",
    note: "sw.wikipedia has no fraud article; searching returns unrelated results. en.wiktionary is English-only for this domain",
  },
};

/** True when the interface is fully translated into `lang`. */
export function isUiLangTranslated(lang: UiLang): boolean {
  return TRANSLATED_UI_LANGS.includes(lang);
}

/**
 * Resolve whatever the browser or a stored preference offers to a UI language.
 *
 * Unlike the VOICE resolver (src/lib/languages.ts, which answers "which language
 * can the agent speak"), this answers "which language can the INTERFACE render",
 * and those two sets differ. A visitor on a Hindi browser gets a Hindi CALL and
 * an English interface, which is the correct and honest outcome rather than a
 * half-translated page.
 */
export function resolveUiLang(requested?: string | null): UiLang {
  const raw = (requested ?? "").trim().toLowerCase();
  if (!raw) return "en";
  if ((UI_LANGS as readonly string[]).includes(raw)) return raw as UiLang;
  const base = raw.split(/[-_]/)[0] ?? "";
  if ((UI_LANGS as readonly string[]).includes(base)) return base as UiLang;
  return "en";
}