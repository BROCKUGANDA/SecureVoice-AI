"use client";

import { create } from "zustand";

export type View = "home" | "demo" | "dashboard" | "product" | "deck";
export type Lang = "en" | "ar";

interface AppState {
  view: View;
  lang: Lang;
  booted: boolean;
  setView: (v: View) => void;
  setLang: (l: Lang) => void;
  setBooted: (b: boolean) => void;
}

export const useApp = create<AppState>((set) => ({
  view: "home",
  lang: "en",
  booted: false,
  setView: (view) => set({ view }),
  setLang: (lang) => set({ lang }),
  setBooted: (booted) => set({ booted }),
}));

/** Small helper: pick between en/ar strings */
export function t(en: string, ar: string, lang: Lang) {
  return lang === "ar" ? ar : en;
}
