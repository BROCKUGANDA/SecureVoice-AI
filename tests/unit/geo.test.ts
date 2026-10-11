/**
 * `src/lib/geo.ts` — the buyer's country, from a header, for localised pricing.
 *
 * The whole module is seven lines and one decision, and the decision is the
 * point: **unknown is null, never a guess**. Paddle's `PricePreview` resolves
 * the visitor's location from their own IP when no country is passed, which is
 * strictly more accurate than anything this function could infer — so a null
 * here is passed on as "no country" and Paddle does the work.
 *
 * The sentinel case is what makes it worth a test file at all. `"OTHERS"`
 * (Paddle's own selector for "no specific country") would be a value a
 * reasonable engineer reaches for, and it is wrong here: it is not a country, it
 * is a price bucket, and sending it means the buyer is quoted as if they lived
 * nowhere. Defaulting to a real code like `"AE"` is worse — it shows someone in
 * Cairo a price for a pound.
 *
 * The other half is that the value is UNTRUSTED. `x-securevoice-country` is set
 * by Caddy from the connection in this deployment, but a function that reads a
 * header cannot know that about itself, and any future proxy that forwards
 * client-supplied values would make this directly attacker-controlled. So the
 * two-letter shape is validated rather than assumed.
 */
import { describe, expect, test } from "bun:test";

import { countryFromHeaders, COUNTRY_HEADER_NAME } from "@/lib/geo";

/** A `Headers` with exactly the one header this module reads. */
const withCountry = (value: string) => new Headers({ [COUNTRY_HEADER_NAME]: value });

describe("countryFromHeaders", () => {
  test("reads, uppercases and trims the country header", () => {
    expect(countryFromHeaders(withCountry("gb"))).toBe("GB");
    expect(countryFromHeaders(withCountry("  us  "))).toBe("US");
    expect(countryFromHeaders(withCountry("ae"))).toBe("AE");
  });

  test("an ABSENT header is null, not a default", () => {
    expect(countryFromHeaders(new Headers())).toBeNull();
    expect(countryFromHeaders(undefined)).toBeNull();
  });

  test("an EMPTY or whitespace-only header is null, not a default", () => {
    // A proxy that sets the header to "" is common. Empty means unknown.
    expect(countryFromHeaders(withCountry(""))).toBeNull();
    expect(countryFromHeaders(withCountry("   "))).toBeNull();
  });

  test("anything not exactly two letters is null", () => {
    // Note what is NOT here: `"GB "` with trailing whitespace. It is trimmed to
    // "GB" and ACCEPTED — trimming is the tolerant half, and a test asserting
    // otherwise would be inventing a rule the code does not have.
    //
    // Also note what IS: `"\u00c9A"` (A with an accent). A non-ASCII country
    // code is constructible as a header value — `Headers` enforces Latin-1, so
    // Arabic-Indic or emoji values throw before they ever reach the function —
    // and must be rejected by the regex rather than by whatever happened to be
    // thrown upstream.
    for (const bad of ["U", "USA", "G1", "U S", "u.s", "GB-XY", "X", "\u00c9A"]) {
      expect(countryFromHeaders(withCountry(bad)), `${JSON.stringify(bad)}`).toBeNull();
    }
  });

  test("a two-letter code is NOT validated against the ISO list — only its shape", () => {
    // "XX" and "ZZ" are not countries. They are returned anyway, and that is the
    // designed behaviour, not a gap: this header is set by OUR proxy from the
    // connection, so the set of possible values is ours to constrain, not the
    // browser's to forge — and "is this a real, purchasable country" is Paddle's
    // domain (it resolves its own regional prices). Validating the whole ISO
    // list here would add a stale table to answer a question we do not need to
    // answer. Pinned so a future "sanity" check is a deliberate decision.
    expect(countryFromHeaders(withCountry("XX"))).toBe("XX");
    expect(countryFromHeaders(withCountry("ZZ"))).toBe("ZZ");
  });

  test("the two-letter shape is a LENGTH-and-shape check, not a substring match", () => {
    // The reason the regex is `/^[A-Z]{2}$/` and not `.length === 2`: a value
    // that merely CONTAINS two letters must not pass. This is what makes an
    // attacker-supplied "PA<PA>y" style value unusable as a country selector.
    expect(countryFromHeaders(withCountry("XX<script>"))).toBeNull();
    expect(countryFromHeaders(withCountry("A\tB"))).toBeNull();
  });

  test("NO sentinel and NO default country is ever substituted", () => {
    // The failure this pins: "OTHERS" is Paddle's no-specific-country price
    // bucket, and returning it from here would quote every browser we cannot
    // resolve as if they lived nowhere. It is not a country.
    expect(countryFromHeaders(withCountry("OTHERS"))).toBeNull();
    // Two-letter strings that ARE shape-valid are returned as themselves —
    // never rewritten into a different country. Asserting XX stays XX is the
    // actual "no default substituted" property.
    expect(countryFromHeaders(withCountry("XX"))).toBe("XX");
    expect(countryFromHeaders(withCountry("ZZ"))).toBe("ZZ");
    // And an unknown country is never claimed as a real one.
    expect(countryFromHeaders(new Headers())).not.toBe("AE");
    expect(countryFromHeaders(new Headers())).not.toBe("US");
    expect(countryFromHeaders(new Headers())).not.toBe("OTHERS");
  });

  test("the header name is the deployment's, and not a CDN's", () => {
    // `x-vercel-ip-country` is deliberately NOT read: this app does not run on
    // Vercel, and honouring a header a CDN sets when no CDN is in front of us
    // means trusting a client-supplied value. Asserted so the day someone adds
    // that convenience it fails here instead of shipping.
    expect(COUNTRY_HEADER_NAME).toBe("x-securevoice-country");
  });

  test("other headers on the same request are ignored", () => {
    // The pricing page passes the whole request's headers in; unrelated ones
    // (a session cookie, accept-language) must not influence the country.
    const headers = new Headers({
      "accept-language": "ar-AE,ar;q=0.9",
      cookie: "better-auth.session_token=abc",
      [COUNTRY_HEADER_NAME]: "sa",
    });
    expect(countryFromHeaders(headers)).toBe("SA");
  });

  test("accept-language alone does NOT imply a country", () => {
    // Tempting, and wrong: a browser in Dubai with an English locale is not
    // someone who should be quoted AED. The country comes from the connection,
    // or from Paddle's own IP resolution.
    expect(countryFromHeaders(new Headers({ "accept-language": "ar-AE" }))).toBeNull();
  });
});
