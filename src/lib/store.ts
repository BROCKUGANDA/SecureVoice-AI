"use client";

import { create } from "zustand";

export type View =
  | "home"
  | "demo"
  | "dashboard"
  | "product"
  | "usecases"
  | "docs"
  | "security"
  | "privacy"
  | "terms"
  | "deck"
  | "auth"
  | "console"
  | "settings"
  | "setup";

/**
 * View permission model (RBAC):
 *   "public"   — everyone, including signed-out visitors
 *   "user"     — any authenticated session (demo or operator roles)
 *   "operator" — operator role only (full platform)
 */
export type ViewAccess = "public" | "user" | "operator";

export const VIEW_ACCESS: Record<View, ViewAccess> = {
  home: "public",
  docs: "public",
  security: "public",
  privacy: "public",
  terms: "public",
  usecases: "public",
  auth: "public",
  demo: "user",
  dashboard: "user",
  product: "user",
  deck: "operator", // team appendix
  console: "user", // single app — demo-role users get the same Command Center with a Demo Mode badge
  settings: "operator",
  // Institution setup configures the TENANT (telecom identity, BYOK, webhooks),
  // so it is operator-only like settings. It is NOT the product tour, which is a
  // per-user concern and lives behind /api/onboarding.
  setup: "operator",
};
export type Lang = "en" | "ar";

const CONTRAST_KEY = "sv-high-contrast";

function initialContrast(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const stored = window.localStorage.getItem(CONTRAST_KEY);
    if (stored !== null) return stored === "1";
  } catch {
    /* private mode / blocked storage — fall through to media query */
  }
  try {
    return window.matchMedia("(prefers-contrast: more)").matches;
  } catch {
    return false;
  }
}

interface AppState {
  view: View;
  lang: Lang;
  booted: boolean;
  /** set when the user clicks any "launch demo" CTA — Demo view auto-starts playback */
  demoIntent: boolean;
  /** session was ended by the idle-timeout guard — Auth shows the banner */
  timedOut: boolean;
  /** WCAG 2.1 AA 1.4.3/1.4.6: high-contrast theme. Persisted to localStorage so a
      low-vision analyst keeps it across sessions; defaults to the OS
      `prefers-contrast` signal when never set. Applied as
      `data-contrast="high"` on <html> — see globals.css. */
  highContrast: boolean;
  setView: (v: View) => void;
  setLang: (l: Lang) => void;
  setBooted: (b: boolean) => void;
  setTimedOut: (t: boolean) => void;
  setHighContrast: (h: boolean) => void;
  launchDemo: () => void;
  consumeDemoIntent: () => void;
}

export const useApp = create<AppState>((set) => ({
  view: "home",
  lang: "en",
  booted: false,
  demoIntent: false,
  timedOut: false,
  highContrast: initialContrast(),
  setView: (view) => set({ view }),
  setLang: (lang) => set({ lang }),
  setBooted: (booted) => set({ booted }),
  setTimedOut: (timedOut) => set({ timedOut }),
  setHighContrast: (highContrast) => {
    try {
      window.localStorage.setItem(CONTRAST_KEY, highContrast ? "1" : "0");
    } catch {
      /* non-fatal: the theme still applies for this session */
    }
    set({ highContrast });
  },
  launchDemo: () => set({ view: "demo", demoIntent: true }),
  consumeDemoIntent: () => set({ demoIntent: false }),
}));

/** Small helper: pick between en/ar strings */
export function t(en: string, ar: string, lang: Lang) {
  return lang === "ar" ? ar : en;
}
