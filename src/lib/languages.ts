/**
 * Supported conversation languages — the single source of truth.
 *
 * Lives apart from config.ts (which is marked `server-only`) so the edge proxy
 * and browser code can import the same list without dragging the server config
 * surface into their bundle. config.ts re-exports these for its own consumers.
 */

import { logWarn } from "@/lib/validation/safe-log";

export const SUPPORTED_LANGS = ["en", "ar", "hi", "ur", "fr", "sw"] as const;

export type Lang = (typeof SUPPORTED_LANGS)[number];

export const LANG_LABEL: Record<Lang, string> = {
  en: "English",
  ar: "العربية",
  hi: "हिन्दी",
  ur: "اردو",
  fr: "Français",
  sw: "Kiswahili",
};

/**
 * Resolve whatever the bank sent (`en`, `ar-AE`, `es_MX`) to a language the
 * voice tables actually have.
 *
 * The dialect subtag is deliberately honoured: `ar-AE` must speak Arabic. It is
 * better to answer a Gulf customer in MSA than in English, and the previous
 * cast let an unknown-but-Arabic tag fall through to an English script without
 * a word of complaint. An unresolvable tag is logged, because the customer
 * cannot tell which language they were dialled in but the audit record can.
 *
 * This lives beside SUPPORTED_LANGS, not beside any caller, because there is
 * exactly one resolution rule and it used to exist twice: the dial worker and
 * the TwiML `/api/twilio/turn` plane each carried their own inline fallback
 * (`slice(0, 2)` on the latter — which turned a hostile tag into a two-
 * character garbage string instead of `en`). Two copies of a customer-facing
 * rule disagree the first time one is edited. The turn plane imports this
 * rather than the worker because the worker pulls the queue, the database and
 * the carrier into anything that imports it; this module stays dependency-
 * light so the hot webhook path and the edge proxy can share it.
 */
export function resolveDeliveryLang(requested?: string | null): Lang {
  const raw = (requested ?? "").trim().toLowerCase();
  if (!raw) return "en";
  const exact = (SUPPORTED_LANGS as readonly string[]).includes(raw);
  if (exact) return raw as Lang;
  const base = raw.split(/[-_]/)[0] ?? "";
  if ((SUPPORTED_LANGS as readonly string[]).includes(base)) return base as Lang;
  logWarn("[lang-resolve] no voice for requested language, falling back to en", {
    requested: raw.slice(0, 20),
  });
  return "en";
}
