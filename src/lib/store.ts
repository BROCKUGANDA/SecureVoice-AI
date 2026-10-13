"use client";

import { create } from "zustand";
import type { Seat } from "@/lib/auth/seat";

export type View =
  | "home"
  | "demo"
  | "dashboard"
  | "product"
  | "usecases"
  | "docs"
  | "security"
  | "pricing"
  | "privacy"
  | "terms"
  | "refund"
  | "deck"
  | "auth"
  | "console"
  | "settings"
  | "setup";

/**
 * View permission model (RBAC).
 *
 * Ordered least-privileged first, and the ORDER IS THE PERMISSION ORDER — the
 * shell compares by index (`atLeast` in @/lib/auth/seat). Inserting a level in
 * the wrong place silently widens or narrows everything above it.
 *
 *   "public"   — everyone, including signed-out visitors
 *   "judge"    — any signed-in session. Read-only: the tour and the recorded
 *                evidence. A hackathon judge or press reviewer lives here.
 *   "vendor"   — a working seat (Analyst). The queue: cases, interventions,
 *                recordings. A bank's fraud desk lives here.
 *   "operator" — Owner/Admin. Changes the organisation: settings, keys, team,
 *                billing, the setup wizard.
 *
 * "user" was the old name for what is now "judge", which read as though it
 * granted something. It granted nothing: a demo seat could open the Command
 * Center under it, and every console route refused the write it was offering.
 */
export type ViewAccess = "public" | "judge" | "vendor" | "operator";

/** The seat required by a view access level. "public" maps to no seat. */
export const ACCESS_SEAT: Record<ViewAccess, Seat | null> = {
  public: null,
  judge: "judge",
  vendor: "vendor",
  operator: "operator",
};

export const VIEW_ACCESS: Record<View, ViewAccess> = {
  home: "public",
  docs: "public",
  security: "public",
  // Public on purpose. Pricing and both refund policies are part of the public
  // commercial surface, and a listing reviewer must be able to reach them
  // without an account — a pricing page behind a sign-in wall reads as hidden.
  pricing: "public",
  privacy: "public",
  terms: "public",
  refund: "public",
  usecases: "public",
  auth: "public",
  demo: "judge",
  dashboard: "judge",
  product: "judge",
  // The team appendix is a 16-slide READ-ONLY deck — the pitch, not a working
  // surface. `judge` rather than `operator` because a reviewer evaluating the
  // submission is exactly who it is for: it renders no organisation data and has
  // no write path, so the "changes or exposes the organisation" reasoning that
  // keeps settings and setup at `operator` does not apply to it.
  //
  // `judge` and not `vendor` on purpose — the navbar offers it to the judge and
  // operator navs only. The split is about who a screen is FOR, and a working
  // seat is not offered the pitch.
  deck: "judge",
  // The Command Center is a WORKING surface: it opens cases, fires
  // interventions and reads the audit chain. It is `vendor` rather than
  // `judge` because a read-only seat that can open a case and freeze a card is
  // not read-only, and because it is what makes the seat split visible rather
  // than cosmetic — a judge genuinely gets a different console, not the same
  // one with fewer buttons.
  console: "vendor",
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

/**
 * Settings tabs, in the order Settings renders them. Lives here rather than in
 * Settings.tsx so the store can type `openSettings(tab)` without importing a
 * view module into the state layer.
 */
export type SettingsTab = "org" | "keys" | "knowledge" | "team" | "security" | "billing";

interface AppState {
  view: View;
  lang: Lang;
  /** set when the user clicks any "launch demo" CTA — Demo view auto-starts playback */
  demoIntent: boolean;
  /** session was ended by the idle-timeout guard — Auth shows the banner */
  timedOut: boolean;
  /** WCAG 2.1 AA 1.4.3/1.4.6: high-contrast theme. Persisted to localStorage so a
      low-vision analyst keeps it across sessions; defaults to the OS
      `prefers-contrast` signal when never set. Applied as
      `data-contrast="high"` on <html> — see globals.css. */
  highContrast: boolean;
  /** Which Settings tab to open. Set by `openSettings()` alongside the view
      change, so a "turn on two-factor" CTA elsewhere in the app can land the
      operator directly on the security tab instead of the default one. */
  settingsTab: SettingsTab;
  setView: (v: View) => void;
  setLang: (l: Lang) => void;
  setTimedOut: (t: boolean) => void;
  setHighContrast: (h: boolean) => void;
  openSettings: (tab: SettingsTab) => void;
  launchDemo: () => void;
  consumeDemoIntent: () => void;
}

export const useApp = create<AppState>((set) => ({
  view: "home",
  lang: "en",
  demoIntent: false,
  timedOut: false,
  highContrast: initialContrast(),
  settingsTab: "org",
  setView: (view) => set({ view }),
  setLang: (lang) => set({ lang }),
  setTimedOut: (timedOut) => set({ timedOut }),
  setHighContrast: (highContrast) => {
    try {
      window.localStorage.setItem(CONTRAST_KEY, highContrast ? "1" : "0");
    } catch {
      /* non-fatal: the theme still applies for this session */
    }
    set({ highContrast });
  },
  openSettings: (tab) => set({ view: "settings", settingsTab: tab }),
  launchDemo: () => set({ view: "demo", demoIntent: true }),
  consumeDemoIntent: () => set({ demoIntent: false }),
}));

/** Small helper: pick between en/ar strings */
export function t(en: string, ar: string, lang: Lang) {
  return lang === "ar" ? ar : en;
}
