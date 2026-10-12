import "server-only";
/**
 * Tenant brand colour, applied before first paint.
 *
 * ## Why this is a server component reading the database, not a cookie
 *
 * The alternative is the obvious one: mirror the colour into a cookie when the
 * operator saves it, and read that cookie in the root layout. It is cheaper and
 * it is what a client-side implementation would do.
 *
 * It is also the thing this codebase already refuses elsewhere. A browser-held
 * value describing what a tenant bought is a tenant stating its own facts — the
 * same reason `GET /api/console/me` resolves the plan server-side and refuses a
 * client-supplied allowance, and the reason `/api/v1/interventions` will not take
 * a `hearing_impaired` flag from anywhere but the bank's signed payload. The
 * colour is not sensitive, but the principle is: an authority that reads its own
 * configuration from the browser has none.
 *
 * ## Why this is a server component and not a `useEffect` in the SPA
 *
 * `src/app/page.tsx` is `"use client"` and swaps between views by state — there
 * is no `/console` route to render server-side. A `useEffect` in the console
 * would therefore paint the platform green first and the bank's colour a frame
 * later, which reads as a bug to an operator and as an unbranded product to the
 * bank's own staff watching over a shoulder.
 *
 * Rendering the rule from the root layout puts it in the first byte of HTML, so
 * the very first paint is already branded.
 *
 * ## The cost, stated plainly
 *
 * Calling `headers()` opts this subtree into dynamic rendering, so the marketing
 * pages are no longer statically cached at the edge. `getSession` short-circuits
 * on the absence of a session cookie without touching the database, so an
 * anonymous visitor pays a cookie parse and nothing else. A signed-in operator
 * pays one session read and one indexed lookup on `Organization.id` — the same
 * read `requireOperator` already performs on every console route. That is the
 * trade: a per-request cost on public pages, bought with no flash of wrong
 * branding.
 *
 * ## Why the verdict is re-derived here even though the column is constrained
 *
 * `brandPrimary` is stored only after passing `evaluateBrandPrimary`, and the
 * migration adds a CHECK on the shape. Deriving the verdict again here costs
 * nothing — it is arithmetic on six hex digits — and it means a value that became
 * unreadable by some path this component does not know about paints the default
 * green instead of an unusable console. Defence in depth, and the cheap kind.
 */

import { headers } from "next/headers";
import { auth } from "@/lib/better-auth";
import { db } from "@/lib/db";
import { brandStyleSheet, evaluateBrandPrimary } from "@/lib/brand/color";

export async function TenantBrand() {
  let css: string | null = null;
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    const orgId = session?.session?.activeOrganizationId;
    if (orgId) {
      const org = await db.organization.findUnique({
        where: { id: orgId },
        select: { brandPrimary: true },
      });
      if (org?.brandPrimary) {
        css = brandStyleSheet(evaluateBrandPrimary(org.brandPrimary));
      }
    }
  } catch {
    // A failure to read the branding must never take the page down. The console
    // is a tool an analyst uses while a customer waits on hold; falling back to
    // the platform green is a cosmetic loss, a thrown error is a dead console.
    // `auth.api.getSession` throws on a malformed session cookie, and that is a
    // browser state we do not control.
    css = null;
  }

  // No wrapper element, no class, no `nonce`: a `<style>` with no stylesheet
  // around it is inert, and `brandStyleSheet` emits only hex values (asserted in
  // tests/unit/brand-color.test.ts), so there is nothing here for a tenant to
  // steer.
  if (!css) return null;
  return <style id="tenant-brand" dangerouslySetInnerHTML={{ __html: css }} />;
}
