import type { Metadata } from "next";
import AppRoot from "@/app/page";

export const dynamic = "force-dynamic";

/**
 * GET /console, /console/settings, /console/demo, … — the signed-in shell at a
 * real address.
 *
 * ## Why a route exists at all
 *
 * The console used to be one URL (`/`) plus a client-side `view` string. That had
 * two consequences the operator felt every day: the browser back button did
 * nothing, because no history entry was ever written, and nothing in the console
 * could be linked — a support thread, a runbook step, or a second monitor could
 * only ever say "open the app and click through".
 *
 * The route renders the SAME component the root page renders (`AppRoot`), so
 * there is one shell, one RBAC gate, and one set of views. The optional catch-all
 * means `/console` and every sub-path resolve here rather than 404ing on refresh.
 *
 * ## What this does NOT change about the security story
 *
 * The shell is the authorisation boundary, and it has not moved: `VIEW_ACCESS`
 * still decides who may see a view, and the effect in `src/app/page.tsx` still
 * sends a session that lacks the role to the sign-in view. Every read behind it is
 * still guarded per-request on the server (`requireSignedIn` / `requireOperator`),
 * so this route is a nicer URL, not a new trust boundary — and not a weaker one.
 *
 * ## Indexing
 *
 * `noindex` here, in the metadata, as well as in `robots.ts` and the
 * `X-Robots-Tag` the middleware puts on every unlisted path. Three layers because
 * the content behind this URL is an operator console: an audit chain, live call
 * state, and a bank's white-label configuration. A path added under `/console/`
 * later is covered by the prefix rule in `src/proxy.ts` without anyone
 * remembering to list it.
 */
export const metadata: Metadata = {
  title: "Command Center",
  description: "The SecureVoice AI operator console.",
  robots: { index: false, follow: false },
};

export default function ConsoleRoute() {
  return <AppRoot />;
}
