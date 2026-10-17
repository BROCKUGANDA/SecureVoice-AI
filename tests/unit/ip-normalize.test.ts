/**
 * The IP trust gate and the canonical spelling of an address.
 *
 * WHY THIS FILE EXISTS. `src/lib/ip-normalize.ts` is the module every reader of
 * "who is this request from" now goes through — the audit chain's `ipHash`, the
 * failed-credential budget in the auth route, the demo seat ledger, rate limiting.
 * It had zero tests in any environment, which means the two properties the whole
 * design rests on were asserted only in a comment:
 *
 *   1. An address is believed ONLY when `src/proxy.ts` stamped the request. Without
 *      the marker, every IP header on the request is the caller's own choice, and
 *      the answer must be `untrusted` — the closed direction, because an
 *      unestablished address must lose budget rather than gain it. The bug this
 *      replaced was `src/app/api/auth/[...all]/route.ts` reading the left-most
 *      `x-forwarded-for` entry directly, and that value was the key for the
 *      failed-sign-in budget: one header, and a attacker could mint a fresh
 *      lockout allowance per attempt.
 *   2. One address has ONE spelling. `ipPseudonym()` is an HMAC over the
 *      normalised value, so `::ffff:203.0.113.5` and `203.0.113.5` must collapse,
 *      or the same host gets two correlation keys and an abuse ladder never fills.
 *
 * Pure string work, so no database, no network, no edge runtime needed.
 */
import { expect, test } from "bun:test";
import {
  IP_UNKNOWN,
  IP_UNTRUSTED,
  clientFingerprint,
  ipBucket,
  isRealIp,
  normalizeIp,
  resolveClientIp,
} from "@/lib/ip-normalize";

const H = (init: Record<string, string>) => new Headers(init);
const MARKED = { "x-securevoice-proxy": "1" };

/** The header the app itself writes, plus any decoys a caller could add. */
function proxied(ip: string, extra: Record<string, string> = {}) {
  return H({ ...MARKED, "x-securevoice-client-ip": ip, ...extra });
}

test("resolveClientIp refuses to believe anything without the proxy marker", () => {
  // The whole anti-spoofing property, stated as: a request that did not pass
  // through src/proxy.ts has NO trustworthy address, however well-formed its
  // headers look.
  const spoofedInit: Record<string, string> = {
    "x-forwarded-for": "8.8.8.8, 1.1.1.1",
    "x-real-ip": "9.9.9.9",
    "cf-connecting-ip": "7.7.7.7",
    "x-securevoice-client-ip": "6.6.6.6",
  };
  const spoofed = H(spoofedInit);
  expect(resolveClientIp(spoofed)).toBe(IP_UNTRUSTED);

  // Marker present but not exactly "1" is the same as absent — the proxy writes
  // "1", and anything else means something else wrote it.
  expect(resolveClientIp(H({ ...spoofedInit, "x-securevoice-proxy": "yes" }))).toBe(IP_UNTRUSTED);
  expect(resolveClientIp(H({ "x-securevoice-proxy": "0", "x-real-ip": "1.2.3.4" }))).toBe(
    IP_UNTRUSTED,
  );
});

test("resolveClientIp takes the proxy's own value first and ignores decoys", () => {
  expect(
    resolveClientIp(
      proxied("203.0.113.7", { "x-forwarded-for": "1.1.1.1", "x-real-ip": "2.2.2.2" }),
    ),
  ).toBe("203.0.113.7");

  // IPv4-mapped form survives the proxy header and comes out as the bare address,
  // because the value is re-normalised rather than passed through.
  expect(resolveClientIp(proxied("::ffff:203.0.113.7"))).toBe("203.0.113.7");
});

test("resolveClientIp re-derives in the same order as src/proxy.ts", () => {
  // Documented as an exact mirror of clientIp() in the proxy: a path where the
  // resolved header did not survive a rewrite must produce the same answer rather
  // than degrade to untrusted. So the fallback chain is a contract, not a detail.
  expect(resolveClientIp(H({ ...MARKED, "cf-connecting-ip": "5.6.7.8" }))).toBe("5.6.7.8");
  expect(resolveClientIp(H({ ...MARKED, "x-forwarded-for": "9.10.11.12, 1.2.3.4" }))).toBe(
    "9.10.11.12",
  );
  expect(resolveClientIp(H({ ...MARKED, "x-real-ip": "13.14.15.16" }))).toBe("13.14.15.16");
  // Marker with nothing behind it is genuinely unknown, not untrusted: the proxy
  // did run, it just could not name a peer.
  expect(resolveClientIp(H(MARKED))).toBe(IP_UNKNOWN);
});

test("resolveClientIp survives a missing or non-header argument", () => {
  expect(resolveClientIp(null)).toBe(IP_UNTRUSTED);
  expect(resolveClientIp(undefined)).toBe(IP_UNTRUSTED);
  expect(resolveClientIp({} as unknown as Headers)).toBe(IP_UNTRUSTED);
});

test("normalizeIp gives one address one spelling", () => {
  const cases: [string, string][] = [
    // IPv4-mapped IPv6 — the single most common source of a split identity,
    // because Node's socket layer reports the mapped form and a proxy may not.
    ["::ffff:203.0.113.5", "203.0.113.5"],
    ["::FFFF:0:203.0.113.5", "203.0.113.5"],
    // Leading zeros and the padded octet form.
    ["010.0.0.001", "10.0.0.1"],
    // Bracketed literal and zone id, both per-interface or per-syntax noise.
    ["[::1]", "::1"],
    ["fe80::1%eth0", "fe80::1"],
    // RFC 5952: longest run of zero groups compressed, single zero left alone.
    ["2001:0DB8:0000:0000:0000:0000:0000:0001", "2001:db8::1"],
    ["2001:db8:0:0:1:0:0:1", "2001:db8::1:0:0:1"],
    ["2001:db8:0:1:0:0:0:1", "2001:db8:0:1::1"],
    ["1:0:2:0:0:3:4:5", "1:0:2::3:4:5"],
    // Dotted quad embedded in the low 32 bits of an IPv6 address.
    ["64:ff9b::192.0.2.33", "64:ff9b::c000:221"],
    ["::", "::"],
  ];
  for (const [raw, want] of cases) expect(normalizeIp(raw), raw).toBe(want);
});

test("normalizeIp refuses what is not an address", () => {
  // Anything that does not parse becomes IP_UNKNOWN: a value nobody can normalise
  // is not a value to key a correlation on.
  for (const bad of [
    "",
    "   ",
    "not-an-ip",
    "1.2.3",
    "1.2.3.4.5",
    "256.1.1.1",
    "1.1.1.-1",
    "1.1.1.1x",
    "2001:db8:::1",
    "gg00::1",
    "1.2.3.4:80",
    // Without a "::" an IPv6 literal must carry all eight groups; padding a short
    // one to eight turns a typo into an address.
    "1:2:3:4",
    "2001:db8:1",
    // Two compressions is not an address.
    "2001::db8::1",
    // A dotted quad belongs in the low 32 bits and only once.
    "192.0.2.1:2001::1",
    "192.0.2.1:192.0.2.2::1",
    "2001:db8::192.0.2.1:2",
  ])
    expect(normalizeIp(bad), bad).toBe(IP_UNKNOWN);

  expect(normalizeIp(null)).toBe(IP_UNKNOWN);
  expect(normalizeIp(undefined)).toBe(IP_UNKNOWN);
});

test("the two spellings that must collapse actually collapse", () => {
  // The property the pseudonym depends on, asserted as equality of the canonical
  // value rather than of the function's shape.
  expect(normalizeIp("::ffff:198.51.100.9")).toBe(normalizeIp("198.51.100.9"));
  expect(normalizeIp("[2001:DB8::1]")).toBe(normalizeIp("2001:0db8:0000:0000:0000:0000:0000:0001"));
});

test("ipBucket groups an IPv6 /64 and leaves IPv4 alone", () => {
  // Rate limiting asks "how much budget does this source get"; a subscriber gets
  // one /64 (RFC 6177), so addresses rotating inside it are one actor.
  expect(ipBucket("2001:db8:1234:5678::1")).toBe("2001:db8:1234:5678::/64");
  expect(ipBucket("2001:db8:1234:5678:abcd::ff")).toBe(ipBucket("2001:db8:1234:5678::9"));
  // IPv4 buckets to itself: no useful prefix convention without a netblock list,
  // and guessing one would merge unrelated people behind a carrier NAT.
  expect(ipBucket("203.0.113.5")).toBe("203.0.113.5");
  expect(ipBucket("::ffff:203.0.113.5")).toBe("203.0.113.5");
  // Not an address, so no bucket — a caller must not silently bucket garbage.
  expect(ipBucket("nonsense")).toBeNull();
  expect(ipBucket(IP_UNTRUSTED)).toBeNull();
  expect(ipBucket(IP_UNKNOWN)).toBeNull();
});

test("isRealIp rejects both sentinel spellings, not just emptiness", () => {
  expect(isRealIp("203.0.113.5")).toBe(true);
  expect(isRealIp("::1")).toBe(true);
  expect(isRealIp(IP_UNKNOWN)).toBe(false);
  expect(isRealIp(IP_UNTRUSTED)).toBe(false);
  expect(isRealIp("")).toBe(false);
  expect(isRealIp(null)).toBe(false);
  expect(isRealIp(undefined)).toBe(false);
});

test("clientFingerprint is stable, hex, and carries no address", () => {
  const a = clientFingerprint("203.0.113.5");
  expect(a).toBe(clientFingerprint("203.0.113.5"));
  expect(a).toMatch(/^cf_[0-9a-f]{8}$/);
  expect(a).not.toBe(clientFingerprint("203.0.113.6"));
  // It is a fingerprint of the string it was given, so it must not leak it.
  expect(a).not.toContain("203");
  expect(clientFingerprint("")).toMatch(/^cf_[0-9a-f]{8}$/);
});
