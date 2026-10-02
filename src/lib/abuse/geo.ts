import "server-only";
/**
 * Destination geography (WP-14, control 1 of the dial gate).
 *
 * The attack this stops: a toll-fraud run borrows a victim's Twilio account (or
 * a valid session on ours) and dials a premium-rate or high-fraud destination
 * list. Geography is the cheapest discriminator available, and it is one that
 * holds up in an audit because it is a *policy*, not a model score.
 *
 * Two properties this module is built around:
 *
 *  1. **An allowlist is a permission, a denylist is the safety net.** The
 *     allowlist says where we intend to go; the denylist is what stops a
 *     misconfigured or widened allowlist from becoming "dial anywhere". The
 *     denylist is checked independently and WINS, and it cannot be narrowed by
 *     env — see HARD_DENIED_COUNTRIES in ./config.ts.
 *
 *  2. **Resolution is deterministic and offline.** Country comes from the
 *     E.164 calling code. There is no lookup service on this path: a network
 *     call in the dial gate is a dependency we cannot fail closed on, and a
 *     number-of-record library that is 400 kB of metadata does not belong on a
 *     hot path either. Tests inject their own resolver; production can too, if
 *     the carrier's own numbering feed is ever wired in.
 *
 * RELATIONSHIP TO policy-gate.ts (WP-2)
 *   policy-gate.ts step 2 already resolves a country and checks a global
 *   env allowlist. That check stays where it is — this module does not replace
 *   it, and calling both is additive rather than contradictory. This module is
 *   the hardened form of the same question (per-org scoping, denylist
 *   inversion, injectable resolver, typed reasons). Migrating the route
 *   handlers to assertDialAllowed() and dropping the policy-gate duplicate is
 *   a follow-up owned by whoever owns those files; this work package could not
 *   touch them.
 */

import { abuseConfig, orgAllowlistEnvName, type GeoConfig } from "./config";

/* ── E.164 shape ──────────────────────────────────────────────────────────── */

/** E.164: `+`, a non-zero country digit, then 6-14 more digits (max 15 total). */
export const E164_RE = /^\+[1-9]\d{6,14}$/;

/**
 * Canonicalise a caller-supplied number without losing information: strip the
 * separators people actually type, drop a leading `00` international prefix,
 * and require `+`. Returns null for anything that is not then a valid E.164
 * number — a number we cannot canonicalise is a number we will not dial.
 */
export function normaliseE164(input: string): string | null {
  const trimmed = (input ?? "").trim();
  const cleaned = trimmed.replace(/[\s().-]/g, "").replace(/^00/, "+");
  return E164_RE.test(cleaned) ? cleaned : null;
}

export function isE164(input: string): boolean {
  return normaliseE164(input) !== null;
}

/**
 * Mask a destination for logs, alerts and audit metadata.
 *
 * `+971501234567` → `+971****4567`. Country code plus the last four survive
 * because they are what an operator needs to reconcile against the carrier
 * bill; the subscriber digits do not belong in a log line.
 */
export function maskE164(e164: string): string {
  const norm = normaliseE164(e164);
  if (!norm) return "[invalid-number]";
  const digits = norm.slice(1);
  if (digits.length <= 4) return `+${"*".repeat(digits.length)}`;
  return `+${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

/** Significant digits of a destination used as the velocity "prefix" key. */
export const PREFIX_DIGITS = 5;

/** `+971501234567` → `+97150` (country code + the mobile/area block). */
export function destinationPrefix(e164: string): string {
  const norm = normaliseE164(e164) ?? "";
  return `+${norm.slice(1, 1 + PREFIX_DIGITS)}`;
}

/* ── Country resolution ───────────────────────────────────────────────────── */

/**
 * A resolver maps a canonical E.164 number to an ISO-3166 alpha-2 code, or
 * null when it cannot be determined. Injectable so the gate is testable
 * without a network call and without a metadata library.
 */
export type CountryResolver = (e164: string) => string | null;

/**
 * E.164 calling code → ISO country.
 *
 * Deliberately a calling-code table, NOT a full numbering-plan library, and
 * the gap is worth stating: +1 is the whole North American Numbering Plan, so
 * US and CA are indistinguishable here and +1 resolves to US — the same
 * simplification policy-gate.ts makes. That is a real limitation for an
 * allowlist that must separate US from CA; the fix is to inject a resolver
 * backed by real metadata (setCountryResolver), not to grow this table.
 *
 * Shared-cost / premium service ranges (+800, +979, …) are intentionally
 * ABSENT: they resolve to null and are therefore refused, with the hard prefix
 * denylist as the second line of defence.
 */
export const COUNTRY_BY_CALLING_CODE: Readonly<Record<string, string>> = Object.freeze({
  // 1-digit
  "1": "US", // NANP zone (US/CA treated as one — see note above)
  "7": "RU",
  // 2-digit
  "20": "EG", "27": "ZA", "30": "GR", "31": "NL", "32": "BE", "33": "FR",
  "34": "ES", "36": "HU", "39": "IT", "40": "RO", "41": "CH", "43": "AT",
  "44": "GB", "45": "DK", "46": "SE", "47": "NO", "48": "PL", "49": "DE",
  "51": "PE", "52": "MX", "53": "CU", "54": "AR", "55": "BR", "56": "CL",
  "57": "CO", "58": "VE", "60": "MY", "61": "AU", "62": "ID", "63": "PH",
  "64": "NZ", "65": "SG", "66": "TH", "81": "JP", "82": "KR", "84": "VN",
  "86": "CN", "90": "TR", "91": "IN", "92": "PK", "93": "AF", "94": "LK",
  "95": "MM", "98": "IR", "212": "MA", "213": "DZ", "216": "TN", "218": "LY",
  "220": "GM", "221": "SN", "233": "GH", "234": "NG", "251": "ET",
  "254": "KE", "255": "TZ", "256": "UG", "260": "ZM", "263": "ZW",
  // 3-digit
  "855": "KH", "856": "LA", "880": "BD", "886": "TW", "852": "HK",
  "853": "MO", "960": "MV",
  "961": "LB", "962": "JO", "963": "SY", "964": "IQ", "965": "KW",
  "966": "SA", "967": "YE", "968": "OM", "970": "PS", "971": "AE",
  "972": "IL", "973": "BH", "974": "QA", "975": "BT", "976": "MN",
  "977": "NP", "992": "TJ", "993": "TM", "994": "AZ", "995": "GE",
  "996": "KG", "998": "UZ",
});

/** Maximum country calling code length in E.164. */
const MAX_CALLING_CODE_DIGITS = 3;

/**
 * The default resolver: longest calling-code prefix wins, so a 3-digit code
 * can never be shadowed by a 1- or 2-digit one.
 */
export function prefixCountryResolver(): CountryResolver {
  return (e164) => {
    const norm = normaliseE164(e164);
    if (!norm) return null;
    const digits = norm.slice(1);
    for (let len = MAX_CALLING_CODE_DIGITS; len >= 1; len--) {
      const hit = COUNTRY_BY_CALLING_CODE[digits.slice(0, len)];
      if (hit) return hit;
    }
    return null;
  };
}

let defaultResolver: CountryResolver = prefixCountryResolver();

/**
 * Swap the process-wide resolver (wire a carrier/lookup-backed one at boot, or
 * a stub in tests). Pass null to restore the E.164 prefix resolver.
 */
export function setCountryResolver(resolver: CountryResolver | null): void {
  defaultResolver = resolver ?? prefixCountryResolver();
}

/** Resolve a country. Deterministic; null means "unknown", which fails closed. */
export function resolveCountry(e164: string, resolver?: CountryResolver | null): string | null {
  try {
    const norm = normaliseE164(e164);
    if (!norm) return null;
    const value = (resolver ?? defaultResolver)(norm);
    return typeof value === "string" && /^[A-Za-z]{2}$/.test(value)
      ? value.toUpperCase()
      : null;
  } catch {
    // A throwing resolver must fail the dial, never the request handler.
    return null;
  }
}

/* ── Policy ───────────────────────────────────────────────────────────────── */

export type GeoPolicy = {
  allowlist: readonly string[];
  denylist: readonly string[];
  deniedPrefixes: readonly string[];
};

/**
 * Values that mean "anywhere" if a human puts them in an allowlist. They are
 * refused rather than honoured: a wildcard allowlist plus a 4-country denylist
 * is a dial-the-world configuration wearing a safety net, and the whole point
 * of this control is that "dial the world" is not a state we can be in.
 */
const WILDCARD_TOKENS = new Set(["*", "all", "any", "0", "ANY"]);

/** Per-org policy registry, injected by the tenant service at runtime. */
const ORG_POLICIES = new Map<string, Partial<GeoPolicy>>();

/**
 * Cap + sanitise an org key before it becomes a Map key anywhere in the abuse
 * state. An unsanitised key is unbounded memory and unbounded collision
 * surface; an over-long one silently truncates two orgs into one bucket.
 */
export function safeOrgKey(orgId: string | null | undefined): string {
  return (orgId ?? "").replace(/[^\w.:-]/g, "").slice(0, 64);
}

/** Register (or clear, with null) a per-org geography policy. */
export function setOrgGeoPolicy(orgId: string, policy: Partial<GeoPolicy> | null): void {
  const key = safeOrgKey(orgId);
  if (!key) return;
  if (policy === null) ORG_POLICIES.delete(key);
  else ORG_POLICIES.set(key, policy);
}

export function clearOrgGeoPolicies(): void {
  ORG_POLICIES.clear();
}

/**
 * Effective policy for an org. Precedence: explicit registry → per-org env
 * (`ABUSE_ALLOWED_COUNTRIES__ORG_ACME`) → global config. An org-specific value
 * replaces only the keys it sets; the hard denylist always survives.
 */
export function geoPolicyFor(orgId: string | null | undefined, override?: Partial<GeoPolicy>): GeoPolicy {
  const cfg = abuseConfig().geo;
  const base: GeoPolicy = {
    allowlist: cfg.allowlist,
    denylist: cfg.denylist,
    deniedPrefixes: cfg.deniedPrefixes,
  };

  const key = safeOrgKey(orgId);
  const envAllowlist = key ? (process.env[orgAllowlistEnvName(key)] ?? "").split(",") : [];
  const envList = envAllowlist.map((s) => s.trim().toUpperCase()).filter(Boolean);

  const registered = key ? ORG_POLICIES.get(key) : undefined;
  return {
    allowlist: registered?.allowlist ?? (envList.length ? envList : base.allowlist),
    // The denylist only ever grows: config defaults + org additions.
    denylist: [...new Set([...base.denylist, ...(registered?.denylist ?? [])].map((c) => c.toUpperCase()))],
    deniedPrefixes: [...new Set([...base.deniedPrefixes, ...(registered?.deniedPrefixes ?? [])])],
  };
}

/* ── The control ──────────────────────────────────────────────────────────── */

export type GeoRejectReason =
  /** Not a canonical E.164 number. */
  | "invalid_e164"
  /** Canonical number, but no country could be determined. */
  | "country_unresolvable"
  /** No allowlist configured for this org — nothing is diallable. */
  | "geo_allowlist_unconfigured"
  /** Allowlist contains a wildcard ("*"), which is refused by design. */
  | "geo_allowlist_misconfigured"
  /** Country resolved, denylist hit. The inverse control. */
  | "country_denied"
  /** E.164 prefix is a shared-cost / premium / non-geographic service range. */
  | "destination_prefix_denied"
  /** Country resolved and simply not on this org's allowlist. */
  | "country_not_allowed";

export type GeoDecision =
  | { ok: true; country: string; policy: GeoPolicy }
  | { ok: false; reason: GeoRejectReason; detail: string; country: string | null };

export type GeoInput = {
  e164: string;
  orgId?: string | null;
  /** Per-call policy override (a route that resolved the tenant already). */
  policy?: Partial<GeoPolicy>;
  /** Per-call resolver override. */
  resolver?: CountryResolver | null;
};

const listIsWildcard = (xs: readonly string[]): boolean => xs.some((x) => WILDCARD_TOKENS.has(x.trim().toLowerCase()));

/**
 * May this org dial this destination, geographically?
 *
 * Order is deliberate:
 *   1. shape          — refuse what we cannot canonicalise
 *   2. denied prefix  — cheaper than a country lookup, and stricter
 *   3. country        — resolve (null = refuse)
 *   4. DENYLIST       — independent of, and overriding, the allowlist
 *   5. allowlist shape— empty = misconfigured; wildcard = refused by design
 *   6. allowlist      — membership
 *
 * Total function: no I/O, no throwing paths, no clock. Every failure carries a
 * typed reason a test can assert on individually.
 */
export function checkDestinationGeo(input: GeoInput): GeoDecision {
  const norm = normaliseE164(input.e164);
  if (!norm) {
    return { ok: false, reason: "invalid_e164", detail: "destination is not a valid E.164 number", country: null };
  }

  const policy: GeoPolicy = geoPolicyFor(input.orgId ?? null, input.policy);
  const masked = maskE164(norm);

  // 2. Denied prefixes — service ranges that are not countries at all.
  for (const prefix of policy.deniedPrefixes) {
    if (prefix && norm.startsWith(prefix)) {
      return {
        ok: false,
        reason: "destination_prefix_denied",
        detail: `destination ${masked} matches denied prefix ${prefix}`,
        country: null,
      };
    }
  }

  // 3. Country.
  const country = resolveCountry(norm, input.resolver ?? null);
  if (!country) {
    return {
      ok: false,
      reason: "country_unresolvable",
      detail: `no country could be determined for destination ${masked}`,
      country: null,
    };
  }

  // 4. Denylist — the inverse control, checked independently of the allowlist.
  if (policy.denylist.includes(country)) {
    return {
      ok: false,
      reason: "country_denied",
      detail: `country ${country} is on the hard denylist`,
      country,
    };
  }

  // 5. Allowlist shape.
  if (policy.allowlist.length === 0) {
    return {
      ok: false,
      reason: "geo_allowlist_unconfigured",
      detail:
        "no destination allowlist is configured for this organisation (set ABUSE_ALLOWED_COUNTRIES or register a per-org policy); nothing is diallable",
      country,
    };
  }
  if (listIsWildcard(policy.allowlist)) {
    return {
      ok: false,
      reason: "geo_allowlist_misconfigured",
      detail:
        "allowlist contains a wildcard entry; a dial-anywhere configuration is refused by design — list the countries explicitly",
      country,
    };
  }

  // 6. Membership.
  const upper = policy.allowlist.map((c) => c.trim().toUpperCase());
  if (!upper.includes(country)) {
    return {
      ok: false,
      reason: "country_not_allowed",
      detail: `country ${country} is not on this organisation's allowlist (${upper.join(", ")})`,
      country,
    };
  }

  return { ok: true, country, policy };
}

/** Convenience: the countries an org may dial right now, denylist removed. */
export function effectiveAllowlist(orgId: string | null | undefined): string[] {
  const policy = geoPolicyFor(orgId ?? null);
  return policy.allowlist.map((c) => c.toUpperCase()).filter((c) => !policy.denylist.includes(c) && !listIsWildcard([c]));
}

export type { GeoConfig };