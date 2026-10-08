/**
 * Supported conversation languages — the single source of truth.
 *
 * Lives apart from config.ts (which is marked `server-only`) so the edge proxy
 * and browser code can import the same list without dragging the server config
 * surface into their bundle. config.ts re-exports these for its own consumers.
 */

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
