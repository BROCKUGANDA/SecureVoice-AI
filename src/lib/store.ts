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
  | "settings";

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
};
export type Lang = "en" | "ar";

interface AppState {
  view: View;
  lang: Lang;
  booted: boolean;
  /** set when the user clicks any "launch demo" CTA — Demo view auto-starts playback */
  demoIntent: boolean;
  /** session was ended by the idle-timeout guard — Auth shows the banner */
  timedOut: boolean;
  setView: (v: View) => void;
  setLang: (l: Lang) => void;
  setBooted: (b: boolean) => void;
  setTimedOut: (t: boolean) => void;
  launchDemo: () => void;
  consumeDemoIntent: () => void;
}

export const useApp = create<AppState>((set) => ({
  view: "home",
  lang: "en",
  booted: false,
  demoIntent: false,
  timedOut: false,
  setView: (view) => set({ view }),
  setLang: (lang) => set({ lang }),
  setBooted: (booted) => set({ booted }),
  setTimedOut: (timedOut) => set({ timedOut }),
  launchDemo: () => set({ view: "demo", demoIntent: true }),
  consumeDemoIntent: () => set({ demoIntent: false }),
}));

/** Small helper: pick between en/ar strings */
export function t(en: string, ar: string, lang: Lang) {
  return lang === "ar" ? ar : en;
}
