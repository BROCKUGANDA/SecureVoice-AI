/**
 * IP address normalisation — pure, portable, shared by both runtimes.
 *
 * Deliberately has NO `server-only` marker and NO `node:` imports, because
 * `src/proxy.ts` runs on the edge runtime and needs the exact same
 * canonicalisation the server-side resolver uses. If the two spelled an address
 * differently, the value the proxy resolves and the value the server re-derives
 * would not match, and every correlation keyed on it would split silently.
 *
 * Pure string + array work only, so this file is valid on edge, Node and the
 * browser. The keyed pseudonym lives in `src/lib/client-ip.ts`, which is
 * server-only.
 */

export const IP_UNKNOWN = "unknown";
/** The request bypassed the trusted proxy, so no header may be believed. */
export const IP_UNTRUSTED = "untrusted";

/** Set by the edge for every response and echoed, so a client can quote it. */
export const REQUEST_ID_HEADER = "x-request-id";

export function isRealIp(value: string | null | undefined): value is string {
  return (
    typeof value === "string" && value.length > 0 && value !== IP_UNKNOWN && value !== IP_UNTRUSTED
  );
}

/** The header the edge proxy injects AFTER resolving the address itself. */
const PROXY_IP_HEADER = "x-securevoice-client-ip";
/**
 * Set by `src/proxy.ts` on requests it forwarded. Its absence is the signal that
 * the request reached the origin directly, and therefore that every IP header on it
 * is caller-controlled.
 */
const PROXY_MARKER = "x-securevoice-proxy";

/**
 * Resolve the client address from a request's headers.
 *
 * Order matters. `x-securevoice-client-ip` is the only value this application
 * writes, and `src/proxy.ts` writes it after its own trust gate has run — so when
 * the marker is present that header is authoritative and nothing else is consulted.
 * When the marker is ABSENT the request reached the origin directly, every IP
 * header on it is the caller's own choice, and the answer is `untrusted`.
 *
 * That is the closed failure direction on purpose: an unestablished address loses
 * rate-limit budget rather than gaining it, which is the property `clientIp()` in
 * the proxy was written to guarantee and the one this restores for every reader
 * that used to open-code it. `src/app/api/auth/[...all]/route.ts` did — and its
 * value was the key for the failed-credential budget.
 *
 * The re-derivation below the proxy header mirrors `clientIp()` in `src/proxy.ts`
 * exactly, so a path where the resolved header did not survive a rewrite produces
 * the same answer rather than degrading to `untrusted`.
 *
 * No `server-only` marker: this reads headers, which is not a server-only act, and
 * keeping it here is what lets the edge proxy and the Node server agree on one
 * canonical spelling of an address.
 */
export function resolveClientIp(headers: Headers | undefined | null): string {
  if (!headers || typeof headers.get !== "function") return IP_UNTRUSTED;
  if (headers.get(PROXY_MARKER) !== "1") return IP_UNTRUSTED;

  const resolved = normalizeIp(headers.get(PROXY_IP_HEADER));
  if (isRealIp(resolved)) return resolved;

  // On Cloudflare's proxied hostname the left-most XFF entry is Cloudflare's edge
  // (Caddy overwrites the chain with the immediate peer), so CF-Connecting-IP wins.
  const cf = normalizeIp(headers.get("cf-connecting-ip"));
  if (isRealIp(cf)) return cf;

  const xff = normalizeIp(headers.get("x-forwarded-for")?.split(",")[0]);
  if (isRealIp(xff)) return xff;

  const real = normalizeIp(headers.get("x-real-ip"));
  if (isRealIp(real)) return real;

  return IP_UNKNOWN;
}

/**
 * Normalise an address to ONE canonical spelling per address.
 *
 * Two spellings of the same address must not produce two identities, or every
 * correlation built on this value silently splits. Three normalisations matter:
 *
 *   1. IPv4-mapped IPv6 — `::ffff:203.0.113.5` and `203.0.113.5` are the same
 *      host. Node's socket layer reports the mapped form; a proxy configured to
 *      pass the client's own header through reports the bare form. This is the
 *      single most common source of a split identity, and it is why the
 *      application never keys on a raw header value.
 *   2. IPv6 leading zeros — `2001:0db8:0000::1` and `2001:db8::1`.
 *   3. IPv6 longest-run zero compression — the RFC 5952 canonical form.
 *
 * A value that does not parse as either family becomes `IP_UNKNOWN`: an address
 * nobody can normalise is not an address to key anything on.
 */
export function normalizeIp(raw: string | null | undefined): string {
  if (typeof raw !== "string") return IP_UNKNOWN;
  // Strip the bracket form (`[::1]`, `[::ffff:203.0.113.5]`) HTTP uses for IPv6
  // literals, then the zone id, which is per-interface and would make the same
  // link-local address differ per network.
  const stripped =
    raw
      .trim()
      .replace(/^\[|\]$/g, "")
      .split("%")[0] ?? "";
  let v = stripped.trim().toLowerCase();
  if (!v) return IP_UNKNOWN;
  if (!/^[0-9a-f:.]+$/.test(v)) return IP_UNKNOWN;

  // Unwrap IPv4-mapped and IPv4-compatible IPv6 down to the IPv4 it carries.
  const mapped = /^::(?:ffff:(?:0{1,4}:)?)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  if (mapped) v = mapped[1]!;

  if (v.includes(":")) return normalizeV6(v);
  return normalizeV4(v);
}

function normalizeV4(v: string): string {
  const parts = v.split(".");
  if (parts.length !== 4) return IP_UNKNOWN;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return IP_UNKNOWN;
    const n = Number(p);
    if (n > 255) return IP_UNKNOWN;
    nums.push(n);
  }
  // Re-render: "010.0.0.1" and "10.0.0.1" are the same address.
  return nums.join(".");
}

function normalizeV6(v: string): string {
  const parts = v.split("::");
  // More than one "::" is not a valid address.
  if (parts.length > 2) return IP_UNKNOWN;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts[1] !== undefined && parts[1] !== "" ? parts[1].split(":") : [];
  const headEndsWithV4 = head[head.length - 1]?.includes(".") ?? false;
  const tailStartsWithV4 = tail[0]?.includes(".") ?? false;
  const explicitGroups =
    head.length + tail.length - (headEndsWithV4 ? 1 : 0) - (tailStartsWithV4 ? 1 : 0);
  const groups = [...head, ...Array(Math.max(0, 8 - explicitGroups)).fill("0"), ...tail];
  if (groups.length !== 8) return IP_UNKNOWN;

  const nums: string[] = [];
  for (const g of groups) {
    if (g.includes(".")) {
      const v4 = normalizeV4(g);
      if (v4 === IP_UNKNOWN) return IP_UNKNOWN;
      const n = v4ToInt(v4);
      // The dotted quad occupies the low 32 bits, i.e. the last two groups.
      nums.push(((n >>> 16) & 0xffff).toString(16), (n & 0xffff).toString(16));
      continue;
    }
    const stripped = g.replace(/^0+/, "");
    nums.push(stripped === "" ? "0" : stripped);
  }
  if (nums.some((g) => g.length > 4 || !/^[0-9a-f]{1,4}$/.test(g))) return IP_UNKNOWN;
  return compressV6(nums);
}

function v4ToInt(v: string): number {
  let n = 0;
  for (const part of v.split(".")) n = (n << 8) + (Number(part) & 0xff);
  return n >>> 0;
}

/** RFC 5952: lowercase, no leading zeros, longest run of zero groups compressed. */
function compressV6(groups: string[]): string {
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  let runLen = 0;
  for (let i = 0; i <= groups.length; i++) {
    if (i < groups.length && groups[i] === "0") {
      if (runStart === -1) runStart = i;
      runLen++;
      if (runLen > bestLen) {
        bestLen = runLen;
        bestStart = runStart;
      }
    } else {
      runStart = -1;
      runLen = 0;
    }
  }
  // A single zero group is not compressed: "1:0:2" is not shorter than "1::2".
  if (bestLen < 2) return groups.join(":");
  const left = groups.slice(0, bestStart).join(":");
  const right = groups.slice(bestStart + bestLen).join(":");
  return `${left}::${right}`;
}

function expandV6(norm: string): string[] | null {
  const [left, right] = norm.split("::");
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  const all = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail];
  return all.length === 8 ? all : null;
}

/**
 * Collapse an address to the network that should count as ONE actor.
 *
 * Used by rate limiting and abuse ladders, where the question is "how much budget
 * does this source get" and an attacker rotating addresses inside one prefix is
 * the same source. NOT used as an identity and NOT used for audit correlation — a
 * /64 holds so many real people that grouping audit rows by it would be a lie.
 *
 * IPv4 buckets to itself (no useful prefix convention without a netblock list);
 * IPv6 buckets to the /64, which RFC 6177 assigns to a single subscriber.
 */
export function ipBucket(ip: string): string | null {
  const norm = normalizeIp(ip);
  if (!isRealIp(norm)) return null;
  if (!norm.includes(":")) return norm;
  const groups = expandV6(norm);
  if (!groups) return null;
  return `${groups.slice(0, 4).join(":")}::/64`;
}

/**
 * A stable per-process fingerprint of a value, for logs and error envelopes.
 *
 * FNV-1a: NOT cryptographic and not reversible, deliberately — this exists so two
 * requests can be correlated in a log tail without the log ever holding an
 * address. Anything that must survive an attacker guessing it uses
 * `client-ip.ipPseudonym()` instead.
 */
export function clientFingerprint(value: string): string {
  let acc = 2166136261;
  for (let i = 0; i < value.length; i++) {
    acc ^= value.charCodeAt(i);
    acc = Math.imul(acc, 16777619) >>> 0;
  }
  return `cf_${acc.toString(16).padStart(8, "0")}`;
}
