"use client";

import { useEffect } from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? "";
const POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";

/**
 * The two client-side contexts the app actually needs: the colour theme, and
 * product analytics.
 *
 * ── Why the theme half was not optional ──────────────────────────────────────
 * `tailwind.config.ts` declares `darkMode: "class"` and `globals.css` carries a
 * full `.dark` token block, and `src/components/ui/sonner.tsx` reads the theme
 * through `useTheme()`. Nothing mounted a provider, so no code path could ever
 * put `.dark` on `<html>`: the dark palette was dead CSS, the toggle promised in
 * the product tour did not exist, and the toast theme read a context with no
 * provider behind it. `suppressHydrationWarning` was already on `<html>` for
 * exactly the script next-themes injects, which is what keeps the first paint on
 * the customer's stored theme instead of flashing the wrong one (checklist 375).
 *
 * ── What this file must never carry ─────────────────────────────────────────
 * No auth state, and no cached session. Better Auth sessions are read from the
 * database per request and the browser reads them through
 * `authClient.useSession()` at the call site; putting a session in a root
 * provider would make an authorisation decision readable from a cache, which is
 * hazard AU-4 in `docs/TRUST-MODEL.md`. The comment in `layout.tsx` says the same
 * thing at the mount point — keep the two in agreement.
 *
 * Analytics is likewise not an input to any decision: PostHog observes, it does
 * not gate. When no key is configured the children render unwrapped, so a local
 * or CI build ships no analytics transport at all.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (!POSTHOG_KEY) return;

    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      // Capture pageview events automatically.
      capture_pageview: true,
      // Capture pageleave events (useful for bounce-rate analysis).
      capture_pageleave: true,
      // Disable autocapture — we want explicit, meaningful events only. A
      // console full of bank case references must not be recorded as a DOM
      // snapshot and shipped to an analytics vendor.
      autocapture: false,
      // Persist the anonymous ID across sessions.
      persistence: "localStorage",
    });
  }, []);

  const themed = (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      // `themes` is what a toggle cycles through; declaring it keeps the stored
      // value's domain explicit instead of whatever a caller invents.
      themes={["light", "dark", "system"]}
    >
      {children}
    </NextThemesProvider>
  );

  if (!POSTHOG_KEY) return themed;

  return <PostHogProvider client={posthog}>{themed}</PostHogProvider>;
}
