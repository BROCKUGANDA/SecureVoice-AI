import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * The buyer's country, resolved SERVER-SIDE for localised pricing.
 *
 * Returns an ISO-3166-1 alpha-2 code, or `null` when the country is not known.
 *
 * ## Why null matters
 *
 * `null` is a meaningful answer, not a failure. `Paddle.PricePreview()` resolves
 * the visitor's location from their own IP when no country is passed, which is
 * more accurate than anything we could infer — so a null here is passed on as
 * "no country" and Paddle does the work.
 *
 * The alternative — substituting a sentinel like `"OTHERS"`, or worst of all
 * defaulting to a real code like `"AE"` — would feed Paddle a country that is not
 * the buyer's and show them a price for somewhere they do not live. A null is
 * strictly better than a wrong answer.
 *
 * ## Sources
 *
 * This deployment is behind Caddy, which sets `x-securevoice-country` from the
 * connection (see Caddyfile). There is deliberately no `x-vercel-ip-country`
 * handling: we do not run on Vercel, and reading a header a CDN sets when no CDN
 * is in front of us would be trusting a client-supplied value.
 */

const COUNTRY_HEADER = "x-securevoice-country";

export function countryFrom(req: NextRequest): string | null {
  const raw = req.headers.get(COUNTRY_HEADER)?.trim().toUpperCase();
  // The regex is the validation, not the length: an attacker-supplied two-letter
  // string is exactly as easy to send as an invalid one, and both must fail.
  if (!raw || !/^[A-Z]{2}$/.test(raw)) return null;
  return raw;
}

/** Exposed so a test can assert the "absent header means null" behaviour. */
export const COUNTRY_HEADER_NAME = COUNTRY_HEADER;

/** Helper for a route that only needs JSON. */
export function countryJson(req: NextRequest): NextResponse {
  return NextResponse.json({ country: countryFrom(req) });
}
