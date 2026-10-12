import type { View } from "@/lib/store";

/**
 * The URL for every view, and the view for every URL.
 *
 * Until now the app had one address and a client-side `view` string. That is why
 * the browser's back button did nothing: nothing was ever written to the history
 * stack, so "go back" left the console and returned to the same page. It is also
 * why no part of the operator experience could be linked, bookmarked, or opened
 * in a new tab — a support thread could only ever say "go to the settings and
 * then the security tab".
 *
 * The routes are real Next pages now (see `src/app/console/[[...path]]/page.tsx`),
 * all rendering the same client shell. This module is the single mapping both
 * directions go through, because the failure mode of the two directions drifting
 * is a back button that lands on the wrong screen — which is exactly the bug this
 * exists to fix.
 *
 * ## What is NOT here
 *
 * The public marketing and legal pages (`/pricing`, `/docs`, `/security`, …) keep
 * their own routes and their own components, and are deliberately absent from the
 * console map. They are indexable; a console path must never be. The split is
 * asserted in `tests/surface/console-routes.test.ts` rather than trusted.
 */

/** Authenticated views and the path they live at. `/console/...` by convention. */
export const PATH_FOR_VIEW: Partial<Record<View, string>> = {
  // The landing view is `/` itself. Listed because the sync that writes the URL
  // has to be total: a view with no entry leaves the address bar showing the
  // screen the user has already navigated away from.
  home: "/",
  console: "/console",
  dashboard: "/console/overview",
  product: "/console/tour",
  demo: "/console/demo",
  deck: "/console/deck",
  settings: "/console/settings",
  setup: "/console/setup",
  auth: "/sign-in",
};

/** The inverse. Built once from the forward map so the two cannot disagree. */
const VIEW_FOR_PATH = new Map<string, View>(
  Object.entries(PATH_FOR_VIEW).map(([view, path]) => [path as string, view as View]),
);

/**
 * The paths that belong to the signed-in shell and must never be indexed.
 *
 * `/` is excluded — it is in the map above only so URL sync stays total, and it is
 * the one page on this site that most wants to be indexed.
 */
export const SHELL_PATHS: readonly string[] = Object.values(PATH_FOR_VIEW).filter((p) => p !== "/");

/**
 * The view a pathname should render, or null when the path is not one of the
 * shell's (a public page, an asset, an API route).
 *
 * A trailing slash is normalised away rather than refused: `/console/` and
 * `/console` are the same screen, and a browser that lands on the slash form must
 * not fall through to the home view and look like a broken link.
 */
export function viewForPath(pathname: string | null | undefined): View | null {
  if (!pathname) return null;
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return VIEW_FOR_PATH.get(clean) ?? null;
}

/** The path a view should be shown at, or null when it has no URL of its own. */
export function pathForView(view: View): string | null {
  return PATH_FOR_VIEW[view] ?? null;
}

/**
 * True when a path belongs to the signed-in shell and must never be indexed.
 *
 * Prefix-matched on purpose: `/console/anything` is console material even if
 * someone adds a sub-page without registering it here, and the safe default for
 * an unregistered console path is "not indexable".
 */
export function isShellPath(pathname: string): boolean {
  return pathname === "/sign-in" || pathname === "/console" || pathname.startsWith("/console/");
}
