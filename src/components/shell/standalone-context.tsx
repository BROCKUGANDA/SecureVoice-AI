"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * "Am I rendering as my own route, or as a panel inside the SPA?"
 *
 * Split out of `PublicPageLayout.tsx` rather than living in it, for a reason
 * that is only visible when the build fails: a context provider is client-only
 * React API, and `PublicPageLayout` is a Server Component — it is pure markup
 * (a header, a footer, no state, no handlers) and has no reason to ship as a
 * client bundle. Declaring `"use client"` on it would work and would push the
 * whole shell across the boundary for one boolean.
 *
 * So the provider is its own Client Component. A Server Component may render one
 * and pass server-rendered children through it, which is exactly the shape here:
 *
 *   PublicPageLayout (server, pure markup)
 *     └─ StandaloneProvider (client, one boolean)
 *          └─ {children} — Docs / UseCases / Pricing / Legal, all client anyway
 *
 * ## Why the flag exists
 *
 * The standalone routes cannot use the app's in-app navigation. `launchDemo` and
 * `setView` mutate a Zustand store that only `src/app/page.tsx` subscribes to,
 * so on `/usecases` a "Launch live demo" button mutates state nothing is
 * watching and does nothing at all — a live-looking control that silently fails,
 * which is worse than having no control.
 *
 * Views read this and swap those buttons for real anchors. Default `false`, so a
 * view rendered in only one place keeps working untouched.
 */
const StandaloneContext = createContext(false);

/** True when the view is rendered as its own route rather than inside the SPA. */
export function useStandalone(): boolean {
  return useContext(StandaloneContext);
}

/** The provider half. See the module comment for why it is separate. */
export function StandaloneProvider({ children }: { children: ReactNode }) {
  return <StandaloneContext.Provider value={true}>{children}</StandaloneContext.Provider>;
}