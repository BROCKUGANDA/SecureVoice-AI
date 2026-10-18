/**
 * UI language registry — which languages the INTERFACE can render.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * The voice layer has spoken all six languages for a while: `SUPPORTED_LANGS`
 * in src/lib/languages.ts carries en/ar/hi/ur/fr/sw, and the agent speaks the
 * opening disclosure, the freeze confirmation and the handoff in each. The UI
 * has two (`UiLang = "en" | "ar"`), because a four-language UI is four thousand
 * translations and nobody had committed to them.
 *
 * The tempting shortcut is to widen the `UiLang` union and let the four new
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
 * So the registry separates the two questions, and the split is now a product
 * rule rather than an accident of progress: **the interface is English and
 * Arabic; a phone call and an SMS are delivered in six.** `UI_LANGS` is derived
 * from `TRANSLATED_UI_LANGS` instead of being written next to it, so adding a
 * language to the picker is impossible without also shipping its translations —
 * the invariant `tests/translations-coverage.test.ts` used to have to assert.
 *
 * The two sets stay distinct types on purpose. A value typed `Lang` (spoken) may
 * legitimately be `ur` and must NOT be handed to a UI render path; a value typed
 * `UiLang` may only ever be `en` or `ar`. Before this split the unions were
 * textually identical, so every voice path that imported the store's `Lang`
 * type-checked while the two concepts had already diverged in behaviour.
 *
 * ── On the four untranslated languages ───────────────────────────────────────
 *
 * They are not second-class: they are spoken on the phone and written in SMS,
 * with hand-written copy in every delivery table (see src/lib/outreach-copy.ts).
 * What they lack is interface translation, and the glossary work behind that
 * surfaced something worth recording here, because it changes how the translation
 * should be sourced:
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
 * qualified translators, and `GLOSSARY_STATUS` records that — keyed by the
 * SPOKEN set, because it describes the terminology of a language the agent can
 * speak, not of an interface the product can render.
 */

import { type Lang, SUPPORTED_LANGS } from "@/lib/languages";

/** A language the interface can be switched to. English and Arabic only. */
export type UiLang = "en" | "ar";

/** BCP-47, for `<html lang>` and any `Intl` call. */
export const UI_LANG_BCP47: Record<UiLang, string> = {
  en: "en-GB",
  ar: "ar-AE",
};

/**
 * The labels the language control draws — header pill and mobile row alike.
 *
 * These were shortened for a SIX-language picker, where "Kiswahili" and
 * "Français" wrapped the `text-[11.5px]` `shrink-0` cluster and changed the
 * header height. The palette is now two (§33), so that pressure is gone and the
 * reason this map exists rather than the endonym is no longer the one written
 * here first. It is kept because it is what both controls render today and both
 * are asserted against it: switching the pill to "English" / "العربية" is a
 * visible design change, not a cleanup, and belongs to whoever decides the
 * header's typography.
 *
 * There is deliberately no endonym map here. `CALL_LANG_LABEL`
 * (src/lib/scenario.ts) already carries the six names in their own languages and
 * is what the hero's "CALL IN" control renders; a second copy keyed by the
 * two-member interface set was dead the moment the palette shrank, and a dead
 * duplicate of a live map is the kind of thing gets cited as evidence later.
 */
export const UI_LANG_SHORT: Record<UiLang, string> = {
  en: "EN",
  ar: "عربي",
};

/**
 * Languages whose script needs the Arabic webfont, not the Latin one.
 *
 * Keyed by the spoken set: `ur` is not an interface language, but Urdu text
 * still reaches the screen wherever a delivered message is displayed, and the
 * font requirement is a property of the script rather than of the surface.
 */
export const ARABIC_SCRIPT_LANGS: readonly Lang[] = ["ar", "ur"];

/**
 * Languages whose UI strings are actually translated.
 *
 * English is the source language and therefore trivially complete; Arabic is the
 * only translated one. The other four are spoken on the phone and written in SMS
 * but their interface is English, and this set is what keeps that distinction
 * honest.
 */
export const TRANSLATED_UI_LANGS: readonly UiLang[] = ["en", "ar"];

/**
 * Every language the picker may offer — DERIVED from the translated set.
 *
 * This line is the rule "the interface is English and Arabic" expressed as a
 * type-level constraint rather than a comment: a language joins the picker by
 * joining `TRANSLATED_UI_LANGS`, which means real reviewed strings, and there is
 * no other way to add a button to the header.
 */
export const UI_LANGS: readonly UiLang[] = TRANSLATED_UI_LANGS;

/**
 * Where the terminology for each SPOKEN language has to come from.
 *
 * `authoritative` means there is a citable, sourced reference for the banking and
 * AML vocabulary. `translator-required` means the references do not exist in
 * that language's Wikipedia/Wiktionary and the glossary must be written by a
 * qualified translator — see the note at the top of this file for the searches
 * that established it.
 *
 * Keyed by `Lang` (six) and asserted total over `SUPPORTED_LANGS` by the test,
 * because the question it answers is "could we translate the interface into this
 * language, and from what source" — which is exactly the thing that has to be
 * answered before a fifth picker button can exist.
 */
export const GLOSSARY_STATUS: Record<
  Lang,
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

/**
 * True when the interface is fully translated into `lang`.
 *
 * Every `UiLang` is translated now that the palette is derived, so this reads as
 * a tautology — and it is kept as the single place `t()` consults, so the day a
 * language is added to the palette before its strings land, the failure is one
 * predicate wide rather than scattered across every bilingual call site.
 */
export function isUiLangTranslated(lang: UiLang): boolean {
  return TRANSLATED_UI_LANGS.includes(lang);
}

/**
 * Resolve whatever the browser or a stored preference offers to a UI language.
 *
 * Unlike the VOICE resolver (src/lib/languages.ts, which answers "which language
 * can the agent speak"), this answers "which language can the INTERFACE render".
 * A visitor on a Hindi browser gets a Hindi CALL and an English interface, which
 * is the correct and honest outcome rather than a half-translated page.
 */
export function resolveUiLang(requested?: string | null): UiLang {
  const raw = (requested ?? "").trim().toLowerCase();
  if (!raw) return "en";
  if ((UI_LANGS as readonly string[]).includes(raw)) return raw as UiLang;
  const base = raw.split(/[-_]/)[0] ?? "";
  if ((UI_LANGS as readonly string[]).includes(base)) return base as UiLang;
  return "en";
}

/** The spoken set, re-exported so a consumer can state the contrast in one import. */
export { SUPPORTED_LANGS };
