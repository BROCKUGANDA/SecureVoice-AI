import "server-only";
/**
 * SSRF guard for customer-supplied outbound URLs (WP-22).
 *
 * We POST signed outcome webhooks to a `callback_url` the bank supplies. That
 * URL is attacker-controllable in exactly the situations that matter: a
 * compromised bank dashboard, a fraud operator with write access to their own
 * org's settings, or a bank that pastes a URL from a support ticket. Given that
 * ability, an attacker aims the POST at the deployment's own internals and
 * reads the response through the bank's webhook delivery log — which is why
 * every one of these checks exists:
 *
 *   - HTTPS only. Plaintext http lets a network attacker rewrite the body of a
 *     message that carries a signature and a case transcript.
 *   - No credentials in the URL. `https://user:pass@host` is a credential leak
 *     into logs and referrers, and a classic parser-confusion vector against
 *     our own validator.
 *   - No private, loopback, link-local, CGNAT, multicast or reserved targets —
 *     including every published cloud-metadata address, because
 *     169.254.169.254 hands out IAM credentials on AWS/GCP/Azure/DO and a
 *     single unauthenticated GET from inside the VPC is a full account
 *     compromise. `100.100.100.200` (Alibaba) and `192.0.0.192` (Oracle) are the
 *     same bug with a different octet.
 *   - DNS RESOLUTION, not string matching. `internal.example.com` resolving to
 *     10.0.0.5 is the actual attack; a blocklist of hostnames never catches it.
 *     Every resolved address must be public — if any one of them is private the
 *     host is rejected, because an attacker who controls DNS can hand back one
 *     public and one private address and let the connection race pick.
 *   - RE-VALIDATION AFTER EVERY REDIRECT. A validated URL that 302s to
 *     `http://169.254.169.254/` was never validated. `safeFetch` follows
 *     redirects manually with `redirect: "manual"` and re-runs this whole check
 *     on each hop; `validateRedirectChain` does the same for a chain you have
 *     already observed.
 *
 * The DNS resolver is injected (default: `dns.lookup`) so the whole module is
 * unit-testable with no network at all — which is the only way this stays
 * tested on a laptop, in CI, and in an air-gapped judging environment.
 */

import { lookup } from "node:dns/promises";

// ── Resolver ────────────────────────────────────────────────────────────────

export interface ResolvedHost {
  address: string;
  family: number;
}

/**
 * Resolve a hostname to every address it maps to. Injectable so tests never
 * touch the network.
 */
export type DnsResolver = (hostname: string) => Promise<readonly ResolvedHost[]>;

/** Default resolver: `dns.lookup` with all addresses and no reordering. */
export const defaultResolver: DnsResolver = async (hostname) => {
  const rows = await lookup(hostname, { all: true, verbatim: true });
  return rows.map((r) => ({ address: r.address, family: r.family }));
};

// ── Hostname policy ─────────────────────────────────────────────────────────

/** Hostnames that must never be dialled, regardless of what they resolve to. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
  "metadata.packet.net",
]);

/** Suffixes reserved for names that only exist inside a network. */
const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".private",
  ".corp",
  ".home.arpa",
  ".lan",
  ".test",
  ".invalid",
  ".example",
];

/**
 * Wildcard-DNS services turn any hostname into an IP. They are not blocked as
 * names because the resolved address is what matters — but a blocklist that
 * ignored them would be theatre, so they are named here and the resolved
 * address is checked anyway.
 */
const WILDCARD_DNS_SUFFIXES = [".nip.io", ".sslip.io", ".xip.io", ".localtest.me"];

// ── IP classification ───────────────────────────────────────────────────────

/** Returns null when the address is publicly routable, else the reason it is not. */
export type BlockReason = string;

/**
 * A validated dotted quad, as a 4-tuple.
 *
 * The tuple type (rather than `number[]`) is what lets `classifyIPv4` destructure
 * without a possibly-undefined element at every comparison. `noUncheckedIndexedAccess`
 * is on for this project (tests/tsconfig.test-base.json), and under it an array
 * destructuring is typed `number | undefined` even when the length is provably 4.
 * Typing the return as a tuple encodes the invariant once, here, instead of
 * asserting it 20 times inside the classifier.
 */
type IPv4Octets = readonly [a: number, b: number, c: number, d: number];

function classifyIPv4(octets: IPv4Octets): BlockReason | null {
  const [a, b, c, d] = octets;

  // Cloud metadata first, so the audit log names the actual bug.
  if (a === 169 && b === 254 && c === 169 && d === 254) {
    return "cloud metadata endpoint (169.254.169.254) — AWS/GCP/Azure/DigitalOcean IMDS";
  }
  if (a === 169 && b === 254 && c === 170 && d === 2)
    return "AWS ECS task metadata endpoint (169.254.170.2)";
  if (a === 169 && b === 254 && c === 169 && d === 253)
    return "AWS VPC DNS resolver (169.254.169.253)";
  if (a === 100 && b === 100 && c === 100 && d === 200)
    return "Alibaba Cloud metadata endpoint (100.100.100.200)";
  if (a === 192 && b === 0 && c === 0 && d === 192)
    return "Oracle Cloud metadata endpoint (192.0.0.192)";

  if (a === 0) return "unspecified / this-network (0.0.0.0/8)";
  if (a === 10) return "private (RFC 1918 10.0.0.0/8)";
  if (a === 127) return "loopback (127.0.0.0/8)";
  if (a === 169 && b === 254) return "link-local (169.254.0.0/16) — includes cloud metadata";
  if (a === 172 && b >= 16 && b <= 31) return "private (RFC 1918 172.16.0.0/12)";
  if (a === 192 && b === 168) return "private (RFC 1918 192.168.0.0/16)";
  if (a === 100 && b >= 64 && b <= 127)
    return "carrier-grade NAT / shared address space (100.64.0.0/10)";
  if (a === 192 && b === 0 && c === 0) return "IETF protocol assignments (192.0.0.0/24)";
  if (a === 192 && b === 0 && c === 2) return "documentation range (192.0.2.0/24)";
  if (a === 192 && b === 88 && c === 99) return "6to4 relay anycast (192.88.99.0/24)";
  if (a === 198 && (b === 18 || b === 19)) return "benchmarking (198.18.0.0/15)";
  if (a === 198 && b === 51 && c === 100) return "documentation range (198.51.100.0/24)";
  if (a === 203 && b === 0 && c === 113) return "documentation range (203.0.113.0/24)";
  if (a >= 224 && a <= 239) return "multicast (224.0.0.0/4)";
  if (a >= 240) return "reserved / broadcast (240.0.0.0/4)";
  return null;
}

function parseIPv4(input: string): IPv4Octets | null {
  const parts = input.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out.push(n);
  }
  // Exactly four validated octets — the length check above guarantees it, so the
  // tuple cast carries no runtime assumption.
  return out as unknown as IPv4Octets;
}

/**
 * Expand an IPv6 literal to its 8 canonical 16-bit groups (0x0000–0xFFFF).
 *
 * Returns GROUPS, not bytes: `classifyIPv6` compares g[0]/g[1] against 16-bit
 * prefixes such as 0xfe80, so a byte-expanded form would silently fail every
 * range test while still looking correct. Handles `::` compression, a
 * bracketed form, a zone id, and a trailing embedded IPv4 (`::ffff:127.0.0.1`).
 */
/**
 * The 8 canonical groups of a valid IPv6 address, as a tuple.
 *
 * Every return path below either produces exactly 8 groups or returns null, so
 * the tuple records an invariant that is already enforced at runtime. Without it,
 * `classifyIPv6` reads `g[0]`/`g[1]` as possibly-undefined under
 * noUncheckedIndexedAccess and every prefix comparison needs an assertion.
 */
type IPv6Groups = readonly [number, number, number, number, number, number, number, number];
function expandIPv6(input: string): IPv6Groups | null {
  let s = input.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone); // scope id — irrelevant to routing
  if (!s) return null;

  const doubleAt = s.indexOf("::");
  if (doubleAt !== s.lastIndexOf("::")) return null; // at most one "::"

  const headText = doubleAt >= 0 ? s.slice(0, doubleAt) : s;
  const tailText = doubleAt >= 0 ? s.slice(doubleAt + 2) : "";
  const head = headText ? headText.split(":") : [];
  const tail = tailText ? tailText.split(":") : [];

  // A token is either one 16-bit hex group, or a trailing dotted-quad that
  // expands to the final two groups.
  const parseToken = (token: string): number[] | null => {
    if (token.includes(".")) {
      const v4 = parseIPv4(token);
      if (!v4) return null;
      return [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    }
    if (!/^[0-9A-Fa-f]{1,4}$/.test(token)) return null;
    return [parseInt(token, 16)];
  };

  const groups: number[] = [];
  for (const token of head) {
    const g = parseToken(token);
    if (!g) return null;
    groups.push(...g);
  }
  const tailStart = groups.length;
  for (const token of tail) {
    const g = parseToken(token);
    if (!g) return null;
    groups.push(...g);
  }

  if (doubleAt < 0) return groups.length === 8 ? (groups as unknown as IPv6Groups) : null;

  const fill = 8 - groups.length;
  if (fill < 1) return null; // "::" must stand for at least one zero group
  if (tailStart > 8 - fill) return null; // the head alone overflowed 8 groups
  // Splice the zero run in exactly where "::" was.
  // Spliced to exactly 8 groups: `fill` was computed as 8 - groups.length and
  // the overflow checks above reject any head that would overshoot.
  return [
    ...groups.slice(0, tailStart),
    ...new Array<number>(fill).fill(0),
    ...groups.slice(tailStart),
  ] as unknown as IPv6Groups;
}

function classifyIPv6(g: IPv6Groups): BlockReason | null {
  const hi = g[0];
  const second = g[1];

  if (g.every((x) => x === 0)) return "unspecified (::)";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback (::1)";

  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 well-known prefix (64:ff9b::/96) —
  // classify the embedded IPv4, otherwise an attacker walks straight past
  // every v6 check by tunnelling a private address through a v6 literal.
  // Note: only the RFC 6052 WELL-KNOWN /96 prefix is unwrapped here. The
  // network-specific prefixes (/32 through /64) need per-operator data we do
  // not have; an operator using one should reject v6 literals by policy.
  const isIpv4Mapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
  // IPv4-COMPATIBLE (the deprecated `::a.b.c.d`, where g[5] is 0 rather than
  // 0xffff) reaches the same v4 stack over the same tunnelling trick, so it has
  // to be unwrapped too. It was missed because the check above only recognised
  // the MAPPED form, and `::ffff:0:0/96` does not cover it.
  //
  // `::` and `::1` are already returned above, and both have g[5] === 0, so
  // excluding them here is not redundant — without the guard, `::1` would be
  // reported as "IPv4-mapped to 0.0.0.1" and lose its own accurate reason.
  // `::` and `::1` both have every low group zero too, so requiring the last
  // two groups to be non-zero excludes exactly the degenerate cases.
  const isIpv4Compatible = g.slice(0, 6).every((x) => x === 0) && (g[6] !== 0 || g[7] !== 0);
  const isNat64WellKnown = hi === 0x0064 && second === 0xff9b;
  if (isIpv4Mapped || isIpv4Compatible || isNat64WellKnown) {
    const embedded = classifyIPv4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
    return embedded ? `IPv4-mapped IPv6 to a blocked address (${embedded})` : null;
  }

  if (hi === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return "discard-only (100::/64)";
  if (hi === 0x2001 && second === 0x0000) return "Teredo tunnel (2001::/32)";
  if (hi === 0x2001 && second === 0x0db8) return "documentation range (2001:db8::/32)";
  if (hi === 0x2001 && second >= 0x0010 && second <= 0x001f) return "ORCHID (2001:10::/28)";
  if (hi === 0x2002) return "6to4 tunnel (2002::/16)";
  if ((hi & 0xfe00) === 0xfc00) return "unique local address (fc00::/7)";
  if ((hi & 0xffc0) === 0xfe80) return "link-local (fe80::/10)";
  if ((hi & 0xffc0) === 0xfec0) return "deprecated site-local (fec0::/10)";
  if ((hi & 0xff00) === 0xff00) return "multicast (ff00::/8)";

  return null;
}

/** Classify any IP literal. Returns null if publicly routable. */
export function classifyIp(address: string): BlockReason | null {
  const trimmed = address.trim();
  if (trimmed.startsWith("[")) {
    const groups = expandIPv6(trimmed);
    if (!groups) return `unparseable IPv6 address "${address}"`;
    return classifyIPv6(groups);
  }
  if (trimmed.includes(":")) {
    const groups = expandIPv6(trimmed);
    if (!groups) return `unparseable IPv6 address "${address}"`;
    return classifyIPv6(groups);
  }
  const octets = parseIPv4(trimmed);
  if (!octets) return `unparseable IP address "${address}"`;
  return classifyIPv4(octets);
}

// ── Verdicts ────────────────────────────────────────────────────────────────

export type SsrfCode =
  | "malformed_url"
  | "not_https"
  | "credentials_in_url"
  | "blocked_port"
  | "blocked_hostname"
  | "dns_failed"
  | "no_addresses"
  | "private_address"
  | "redirect_blocked"
  | "too_many_redirects";

export type UrlVerdict =
  | { ok: true; url: URL; addresses: readonly string[] }
  | { ok: false; code: SsrfCode; reason: string; host?: string };

export interface SsrfOptions {
  /** Injected DNS resolver. Defaults to `defaultResolver` (dns.lookup). */
  resolver?: DnsResolver;
  /** Ports permitted. Default: 443 only. */
  allowedPorts?: readonly number[];
  /** Refuse if a hostname resolves to more than this many addresses. Default 16. */
  maxAddresses?: number;
}

const DEFAULT_ALLOWED_PORTS: readonly number[] = [443];

export class SsrfBlockedError extends Error {
  constructor(
    readonly code: SsrfCode,
    message: string,
  ) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

// ── Core validation ─────────────────────────────────────────────────────────

function isBlockedHostname(host: string): boolean {
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  return BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Validate a single outbound URL. Resolves DNS when the host is a name, and
 * checks every resolved address — a host with one public and one private answer
 * is rejected, because the connection race is the attack.
 */
export async function validateOutboundUrl(
  raw: string | URL,
  opts: SsrfOptions = {},
): Promise<UrlVerdict> {
  const resolver = opts.resolver ?? defaultResolver;
  const allowedPorts = opts.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
  const maxAddresses = opts.maxAddresses ?? 16;

  let url: URL;
  try {
    url = raw instanceof URL ? new URL(raw.toString()) : new URL(raw.trim());
  } catch {
    return { ok: false, code: "malformed_url", reason: "not a valid absolute URL" };
  }

  if (url.protocol !== "https:") {
    return {
      ok: false,
      code: "not_https",
      reason: `scheme "${url.protocol}" is not https`,
      host: url.hostname,
    };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      code: "credentials_in_url",
      reason: "URL must not embed credentials",
      host: url.hostname,
    };
  }

  const port = url.port === "" ? 443 : Number(url.port);
  if (!allowedPorts.includes(port)) {
    return {
      ok: false,
      code: "blocked_port",
      reason: `port ${port} is not permitted (allowed: ${allowedPorts.join(", ")})`,
      host: url.hostname,
    };
  }

  // url.hostname keeps the brackets on an IPv6 literal; drop them for policy.
  const host = url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");

  if (isBlockedHostname(host)) {
    return {
      ok: false,
      code: "blocked_hostname",
      reason: `hostname "${host}" is internal-only`,
      host,
    };
  }

  // IP literal — no DNS needed, and no DNS to poison.
  const v4 = parseIPv4(host);
  if (v4) {
    const reason = classifyIPv4(v4);
    return reason
      ? { ok: false, code: "private_address", reason, host }
      : { ok: true, url, addresses: [host] };
  }
  if (host.includes(":")) {
    const groups = expandIPv6(host);
    if (!groups)
      return { ok: false, code: "malformed_url", reason: `unparseable IPv6 host "${host}"`, host };
    const reason = classifyIPv6(groups);
    return reason
      ? { ok: false, code: "private_address", reason, host }
      : { ok: true, url, addresses: [host] };
  }

  // A bare label with no dot cannot be a public FQDN.
  if (!host.includes(".") || /\.$/.test(host)) {
    return {
      ok: false,
      code: "blocked_hostname",
      reason: `hostname "${host}" is not a fully qualified name`,
      host,
    };
  }

  let resolved: readonly ResolvedHost[];
  try {
    resolved = await resolver(host);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, code: "dns_failed", reason: `DNS resolution failed: ${detail}`, host };
  }

  if (resolved.length === 0) {
    return { ok: false, code: "no_addresses", reason: "hostname resolved to no addresses", host };
  }
  if (resolved.length > maxAddresses) {
    return {
      ok: false,
      code: "private_address",
      reason: `hostname resolves to ${resolved.length} addresses (cap ${maxAddresses})`,
      host,
    };
  }

  const addresses: string[] = [];
  for (const entry of resolved) {
    const reason = classifyIp(entry.address);
    if (reason) {
      return {
        ok: false,
        code: "private_address",
        reason: `"${host}" resolves to a blocked address (${reason})`,
        host,
      };
    }
    addresses.push(entry.address);
  }

  return { ok: true, url, addresses };
}

// ── Redirects ───────────────────────────────────────────────────────────────

export interface FollowOptions extends SsrfOptions {
  /** Maximum redirect hops. Default 5. */
  maxRedirects?: number;
  /** Injected fetch, so redirect handling is testable with no network. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. Ignored when `init.signal` is supplied. */
  timeoutMs?: number;
}

/**
 * Validate every URL in an already-observed redirect chain. A chain is only as
 * safe as its least safe hop: validating the entry point and then letting
 * `fetch` follow redirects is the classic SSRF bypass, because the 302 target
 * is chosen by the server we just called.
 */
export async function validateRedirectChain(
  chain: readonly (string | URL)[],
  opts: SsrfOptions = {},
): Promise<UrlVerdict> {
  if (chain.length === 0) {
    return { ok: false, code: "malformed_url", reason: "empty redirect chain" };
  }
  let last: UrlVerdict | null = null;
  for (const [index, hop] of chain.entries()) {
    const verdict = await validateOutboundUrl(hop, opts);
    if (!verdict.ok) {
      // Distinguish "the entry point was bad" from "a redirect went bad".
      return index === 0
        ? verdict
        : {
            ...verdict,
            code: "redirect_blocked",
            reason: `redirect target rejected — ${verdict.reason}`,
          };
    }
    last = verdict;
  }
  return last as UrlVerdict & { ok: true };
}

export interface FollowResult {
  url: URL;
  addresses: readonly string[];
  /** Every URL visited, in order, including the entry point. */
  chain: readonly string[];
  response: Response;
}

/**
 * Walk a redirect chain manually, re-validating each hop. Stops at the first
 * non-redirect response and returns it. Rejects the whole chain if any hop
 * fails validation — before that hop is ever dialled.
 */
export async function followRedirectChain(
  start: string | URL,
  opts: FollowOptions = {},
): Promise<FollowResult> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const doFetch = opts.fetchImpl ?? fetch;

  const first = await validateOutboundUrl(start, opts);
  if (!first.ok) throw new SsrfBlockedError(first.code, first.reason);

  const chain: string[] = [first.url.toString()];
  let current = first;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await doFetch(current.url.toString(), { redirect: "manual" });
    const isRedirect = response.status >= 300 && response.status < 400;
    const location = response.headers.get("location");
    if (!isRedirect || !location) {
      return { url: current.url, addresses: current.addresses, chain, response };
    }
    if (hop === maxRedirects) {
      throw new SsrfBlockedError("too_many_redirects", `exceeded ${maxRedirects} redirects`);
    }

    const next = new URL(location, current.url);
    const verdict = await validateOutboundUrl(next, opts);
    if (!verdict.ok) {
      throw new SsrfBlockedError(
        "redirect_blocked",
        `redirect target rejected — ${verdict.reason}`,
      );
    }
    chain.push(verdict.url.toString());
    current = verdict;
  }

  throw new SsrfBlockedError("too_many_redirects", `exceeded ${maxRedirects} redirects`);
}

/**
 * Safe outbound fetch: validates the URL, forces manual redirect handling, and
 * re-validates every hop. The returned Response is the FINAL one; intermediate
 * 3xx bodies are discarded so a caller can never read a redirect target's
 * content.
 *
 * Use this instead of `fetch` for every request whose URL came from a customer.
 */
export async function safeFetch(
  url: string | URL,
  init: RequestInit = {},
  opts: FollowOptions = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs;

  let signal = init.signal ?? undefined;
  if (
    timeoutMs !== undefined &&
    !signal &&
    typeof AbortSignal !== "undefined" &&
    typeof AbortSignal.timeout === "function"
  ) {
    signal = AbortSignal.timeout(timeoutMs);
  }

  const first = await validateOutboundUrl(url, opts);
  if (!first.ok) throw new SsrfBlockedError(first.code, first.reason);

  let current = first;
  for (let hop = 0; ; hop += 1) {
    const response = await doFetch(current.url.toString(), { ...init, redirect: "manual", signal });
    const isRedirect = response.status >= 300 && response.status < 400;
    const location = response.headers.get("location");
    if (!isRedirect || !location) return response;
    if (hop >= maxRedirects) {
      throw new SsrfBlockedError("too_many_redirects", `exceeded ${maxRedirects} redirects`);
    }
    const next = await validateOutboundUrl(new URL(location, current.url), opts);
    if (!next.ok)
      throw new SsrfBlockedError("redirect_blocked", `redirect target rejected — ${next.reason}`);
    current = next;
  }
}
