"use client";

import { create } from "zustand";

export type View =
  | "home"
  | "demo"
  | "dashboard"
  | "product"
  | "docs"
  | "security"
  | "privacy"
  | "terms"
  | "deck";
export type Lang = "en" | "ar";

interface AppState {
  view: View;
  lang: Lang;
  booted: boolean;
  /** set when the user clicks any "launch demo" CTA — Demo view auto-starts playback */
  demoIntent: boolean;
  setView: (v: View) => void;
  setLang: (l: Lang) => void;
  setBooted: (b: boolean) => void;
  launchDemo: () => void;
  consumeDemoIntent: () => void;
}

export const useApp = create<AppState>((set) => ({
  view: "home",
  lang: "en",
  booted: false,
  demoIntent: false,
  setView: (view) => set({ view }),
  setLang: (lang) => set({ lang }),
  setBooted: (booted) => set({ booted }),
  launchDemo: () => set({ view: "demo", demoIntent: true }),
  consumeDemoIntent: () => set({ demoIntent: false }),
}));

/** Small helper: pick between en/ar strings */
export function t(en: string, ar: string, lang: Lang) {
  return lang === "ar" ? ar : en;
}
