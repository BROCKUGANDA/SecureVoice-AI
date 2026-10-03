/**
 * UNIT - the SSRF guard (src/lib/validation/ssrf.ts).
 *
 * This module decides whether a customer-supplied `callback_url` may be dialled
 * with a signed webhook body. It is the only thing between "a bank pasted a URL
 * from a support ticket" and "an unauthenticated GET to 169.254.169.254 from
 * inside our VPC", so the properties pinned here are adversarial ones: every
 * case below is a URL that a naive string-matching guard gets wrong.
 *
 * The load-bearing claims:
 *
 *   - PRIVATE AND RESERVED SPACE IS REFUSED, exhaustively. `classifyIp` is a
 *     pure predicate (`null` == publicly routable), so it is driven with a table
 *     covering every family the guard claims: loopback, all three RFC 1918
 *     ranges *including their boundaries*, link-local, CGNAT, unspecified,
 *     multicast, reserved, the IPv6 special ranges, and both IPv6 forms that
 *     embed an IPv4 address. Boundary values matter more than mid-range ones -
 *     `172.15.255.255` must be ALLOWED and `172.16.0.0` REFUSED, because an
 *     off-by-one there is a routable internal host.
 *   - CLOUD METADATA IS NOT JUST "PRIVATE". 169.254.169.254, 100.100.100.200
 *     and 192.0.0.192 are named individually, and the reasons are asserted so a
 *     refactor that demotes them to a generic link-local string loses the audit
 *     signal the log exists to produce.
 *   - THE PARSED HOST IS THE HOST THAT GETS DIALLED. `https://evil.com\@127.0.0.1`
 *     and `https://127.0.0.1.evil.com` both LOOK like parser-confusion attacks
 *     and both are, correctly, resolved to `evil.com` and then judged by what
 *     DNS returns for it. The assertion is that the resolver is asked about the
 *     real host and that a private answer for it is refused - not that the
 *     string contains "127.0.0.1".
 *   - LITERAL HOSTS NEVER TOUCH DNS. `parseIPv4` short-circuits before the
 *     resolver is called, so there is no TOCTOU window for an attacker to win
 *     a rebind race on a URL that never needed resolving. The resolver is
 *     counted, and the count must stay at zero.
 *   - DNS REBINDING IS CAUGHT BY RESOLUTION, NOT BY STRING MATCHING. A
 *     perfectly innocuous name that answers with one public and one private
 *     address is REFUSED, because the connection race is the attack. An empty
 *     answer, a throw, and an over-cap answer are all refused too.
 *   - HTTPS ONLY, and the refusal is on the PARSED protocol. `HTTP://` and
 *     every non-web scheme (`file:`, `gopher:`, `dict:`, `ftp:`, `data:`,
 *     `javascript:`) are `not_https`. Note the module is stricter than "http
 *     and https are both fine" - plaintext HTTP is refused outright, because
 *     the body carries a signature.
 *   - CREDENTIALS ARE REFUSED, NOT STRIPPED. Stripping them would leave the
 *     validator and the request disagreeing about the URL; the module rejects
 *     instead, and the rejection happens before any DNS work.
 *   - REDIRECTS ARE RE-VALIDATED. `safeFetch` forces `redirect: "manual"` even
 *     when the caller passes `redirect: "follow"`, re-runs the whole check on
 *     each hop, and refuses the chain BEFORE dialling the bad hop - the fetch
 *     count is asserted, not just the thrown code. A 302 to a private host, a
 *     protocol-relative `//10.0.0.5`, an https- -http downgrade and a
 *     credential-bearing hop are each caught.
 *   - FAIL-CLOSED ON EVERY UNPARSEABLE THING. Non-string input, an empty
 *     string, an address that is neither v4 nor v6, and a `Location` header
 *     that will not parse all end in a refusal rather than in an `ok` verdict.
 *     The `classifyIp` table asserts the stronger half of that: it NEVER
 *     returns `null` for an input it could not parse, so an unparseable
 *     resolved DNS answer cannot be mistaken for a public one.
 *
 * No network and no database: the resolver is injected and `fetch` is injected
 * through `fetchImpl`, so every case above is deterministic and offline.
 *
 * FIXED: the deprecated IPv4-COMPATIBLE IPv6 form `::127.0.0.1` (and its hex
 * spelling `::7f00:1`) used to be classified PUBLIC, because only the IPv4-MAPPED
 * prefix `::ffff:0:0/96` and the NAT64 well-known prefix `64:ff9b::/96` were
 * unwrapped -- the compatible form has g[5] === 0, not 0xffff. A separate
 * `net.connect` probe against a live 127.0.0.1 listener showed the connection
 * TIMES OUT rather than reaching it on this platform, so it was not a
 * demonstrated bypass here -- but the classification was wrong, and a stack that
 * does route `::7f00:1` would route it to loopback. `classifyIPv6` now unwraps
 * the compatible form too, with `::` and `::1` excluded so they keep their own
 * accurate reasons.
 *
 * KNOWN GAP, also pinned-as-is: `new URL(location, current.url)` in
 * `followRedirectChain` (ssrf.ts:537) and `safeFetch` (ssrf.ts:591) is not
 * wrapped, so a redirect whose `Location` will not parse (`http://[`, `///`)
 * escapes as a raw `TypeError` rather than an `SsrfBlockedError`. It still does
 * not dial the target, so this is a wrong-error-type bug, not an open door.
 */
import { describe, expect, test } from "bun:test";
import {
  SsrfBlockedError,
  classifyIp,
  defaultResolver,
  followRedirectChain,
  safeFetch,
  validateOutboundUrl,
  validateRedirectChain,
  type DnsResolver,
  type ResolvedHost,
  type SsrfCode,
  type SsrfOptions,
  type UrlVerdict,
} from "@/lib/validation/ssrf";

/** The refusing arm of a verdict, with the discriminant retained. */
type Refusal = { ok: false; code: SsrfCode; reason: string; host?: string };

// ---- Fixtures -------------------------------------------------------

/** A public answer, so a hostname case passes policy on its merits. */
const PUBLIC: readonly ResolvedHost[] = [{ address: "93.184.216.34", family: 4 }];

/** An RFC 1918 answer - the DNS-rebinding payload. */
const PRIVATE: readonly ResolvedHost[] = [{ address: "10.1.2.3", family: 4 }];

const publicResolver: DnsResolver = async () => PUBLIC;
const privateResolver: DnsResolver = async () => PRIVATE;

/**
 * A resolver that records what it was asked. Used to prove which host the
 * module actually judges - the difference between "the string contained
 * 127.0.0.1" and "we resolved the real host and checked every answer".
 */
function countingResolver(answer: readonly ResolvedHost[] = PUBLIC) {
  const asked: string[] = [];
  const resolver: DnsResolver = async (hostname) => {
    asked.push(hostname);
    return answer;
  };
  return { asked, resolver };
}

/** A minimal Response, optionally carrying a redirect. */
function stubResponse(status: number, location?: string): Response {
  const res = new Response(null, { status });
  if (location !== undefined) res.headers.set("location", location);
  return res;
}

/** Narrows a verdict to the refusing branch so `code`/`reason`/`host` are typed. */
function refusal(verdict: UrlVerdict): Refusal {
  if (verdict.ok) throw new Error(`expected a refusal, got ok for ${verdict.url.href}`);
  return verdict;
}

async function refuse(url: string | URL, opts: SsrfOptions = {}): Promise<Refusal> {
  return refusal(await validateOutboundUrl(url, opts));
}

/**
 * `fetch` carries properties (`preconnect`) a stub cannot provide, so the double
 * is bridged through `unknown` rather than pretending to be one - the convention
 * every other fetch-double in this repo already uses.
 */
const asFetch = (impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
  impl as unknown as typeof fetch;

// ---- IPv4 classification --------------------------------------------

describe("classifyIp - IPv4 families", () => {
  /** The whole table. `blocked` is the claim; `reason` is part of it. */
  const TABLE: readonly {
    ip: string;
    blocked: boolean;
    reason?: string;
    why: string;
  }[] = [
    // Cloud metadata, named ahead of the generic ranges on purpose: the
    // audit log should say "IMDS", not "link-local", when a probe is denied.
    {
      ip: "169.254.169.254",
      blocked: true,
      reason: "cloud metadata endpoint (169.254.169.254) \u2014 AWS/GCP/Azure/DigitalOcean IMDS",
      why: "IAM credentials for the whole cloud account, unauthenticated from inside",
    },
    {
      ip: "169.254.169.253",
      blocked: true,
      reason: "AWS VPC DNS resolver (169.254.169.253)",
      why: "resolves internal service names without authentication",
    },
    {
      ip: "169.254.170.2",
      blocked: true,
      reason: "AWS ECS task metadata endpoint (169.254.170.2)",
      why: "task IAM role credentials",
    },
    {
      ip: "100.100.100.200",
      blocked: true,
      reason: "Alibaba Cloud metadata endpoint (100.100.100.200)",
      why: "same bug as 169.254.169.254 with a different octet",
    },
    {
      ip: "192.0.0.192",
      blocked: true,
      reason: "Oracle Cloud metadata endpoint (192.0.0.192)",
      why: "Oracle instance-principal metadata",
    },

    // Loopback, both edges of /8.
    { ip: "127.0.0.1", blocked: true, why: "the deployment itself" },
    { ip: "127.255.255.254", blocked: true, why: "last usable host in 127/8" },
    { ip: "126.255.255.255", blocked: false, why: "one below loopback - public" },
    { ip: "128.0.0.1", blocked: false, why: "one above loopback - public" },

    // RFC 1918 10/8.
    { ip: "10.0.0.1", blocked: true, why: "RFC 1918" },
    { ip: "10.255.255.255", blocked: true, why: "last address in 10/8" },
    { ip: "9.255.255.255", blocked: false, why: "one below 10/8 - public" },
    { ip: "11.0.0.0", blocked: false, why: "one above 10/8 - public" },

    // RFC 1918 172.16/12 - the boundaries are where an off-by-one hides.
    { ip: "172.15.255.255", blocked: false, why: "one below 172.16/12 - public" },
    { ip: "172.16.0.0", blocked: true, why: "first address of 172.16/12" },
    { ip: "172.20.10.5", blocked: true, why: "mid-range 172.16/12" },
    { ip: "172.31.255.255", blocked: true, why: "last address of 172.16/12" },
    { ip: "172.32.0.0", blocked: false, why: "one above 172.16/12 - public" },

    // RFC 1918 192.168/16.
    { ip: "192.168.0.1", blocked: true, why: "RFC 1918" },
    { ip: "192.168.255.254", blocked: true, why: "last usable in 192.168/16" },
    { ip: "192.167.255.255", blocked: false, why: "one below 192.168/16 - public" },
    { ip: "192.169.0.0", blocked: false, why: "one above 192.168/16 - public" },

    // Link-local.
    { ip: "169.254.0.1", blocked: true, why: "link-local, no metadata involved" },
    { ip: "169.253.255.255", blocked: false, why: "one below link-local - public" },
    { ip: "169.255.0.0", blocked: false, why: "one above link-local - public" },

    // Unspecified / this-network. 0.0.0.0 is the classic "0.0.0.0 day" bug:
    // many kernels treat it as INADDR_ANY, i.e. the local host.
    { ip: "0.0.0.0", blocked: true, why: "INADDR_ANY - resolves to localhost" },
    { ip: "0.1.2.3", blocked: true, why: "the guard blocks all of 0/8, not just 0.0.0.0" },

    // CGNAT (RFC 6598) - carrier space that is not the public internet.
    { ip: "100.64.0.1", blocked: true, why: "CGNAT / shared address space" },
    { ip: "100.127.255.255", blocked: true, why: "last address of 100.64/10" },
    { ip: "100.63.255.255", blocked: false, why: "one below 100.64/10 - public" },
    { ip: "100.128.0.0", blocked: false, why: "one above 100.64/10 - public" },

    // Reserved / non-routable, where a misroute is still a defect.
    { ip: "192.0.0.1", blocked: true, why: "IETF protocol assignments" },
    { ip: "192.0.2.1", blocked: true, why: "TEST-NET-1 documentation range" },
    { ip: "192.88.99.1", blocked: true, why: "6to4 relay anycast" },
    { ip: "198.18.0.1", blocked: true, why: "benchmarking" },
    { ip: "198.19.255.255", blocked: true, why: "last address of 198.18/15" },
    { ip: "198.20.0.1", blocked: false, why: "one above 198.18/15 - public" },
    { ip: "198.51.100.1", blocked: true, why: "TEST-NET-2 documentation range" },
    { ip: "203.0.113.1", blocked: true, why: "TEST-NET-3 documentation range" },

    // Multicast and reserved top of the space.
    { ip: "224.0.0.1", blocked: true, why: "all-hosts multicast" },
    { ip: "239.255.255.255", blocked: true, why: "last of 224/4" },
    { ip: "223.255.255.255", blocked: false, why: "one below multicast - public" },
    { ip: "240.0.0.1", blocked: true, why: "reserved" },
    { ip: "255.255.255.255", blocked: true, why: "limited broadcast" },

    // Public, as the control group. If any of these were refused the guard
    // would refuse real customers, so they are as load-bearing as the blocks.
    { ip: "8.8.8.8", blocked: false, why: "public resolver" },
    { ip: "93.184.216.34", blocked: false, why: "public web host" },
    { ip: "1.1.1.1", blocked: false, why: "public resolver" },
  ];

  test("every family is classified the way the table claims", async () => {
    for (const row of TABLE) {
      expect({ ip: row.ip, blocked: classifyIp(row.ip) !== null }).toEqual({
        ip: row.ip,
        blocked: row.blocked,
      });
    }
  });

  test("the cloud-metadata reasons name the endpoint, not the generic range", async () => {
    // The audit log is the product here: "link-local" tells an operator
    // nothing about which bug was probed for.
    for (const row of TABLE) {
      if (row.reason === undefined) continue;
      expect(classifyIp(row.ip)).toBe(row.reason);
    }
  });

  test("no block reason is an empty string", async () => {
    // An empty reason would serialise into a log line with no explanation.
    for (const row of TABLE) {
      const reason = classifyIp(row.ip);
      if (reason === null) continue;
      expect(reason.length).toBeGreaterThan(0);
    }
  });
});

// ---- IPv6 classification --------------------------------------------

describe("classifyIp - IPv6 families", () => {
  const TABLE: readonly { ip: string; blocked: boolean; why: string }[] = [
    { ip: "::1", blocked: true, why: "IPv6 loopback" },
    { ip: "0:0:0:0:0:0:0:1", blocked: true, why: "loopback, uncompressed" },
    { ip: "::", blocked: true, why: "IPv6 unspecified" },
    { ip: "0000:0000:0000:0000:0000:0000:0000:0000", blocked: true, why: "all-zero groups" },
    // FIXED: this used to be classified PUBLIC. `::2` is the deprecated
    // IPv4-compatible form for 0.0.0.2, which is in the reserved
    // 0.0.0.0/8 "this network" range, so unwrapping it blocks. The old entry
    // was written against the buggy classifier and was simply wrong.
    { ip: "::2", blocked: true, why: "IPv4-compatible for 0.0.0.2 (0.0.0.0/8)" },

    // IPv4-mapped: the tunnel an attacker uses to walk past every v6 check.
    { ip: "::ffff:127.0.0.1", blocked: true, why: "loopback through a v6 literal" },
    { ip: "::ffff:10.0.0.1", blocked: true, why: "RFC 1918 through a v6 literal" },

    // IPv4-COMPATIBLE (the deprecated `::a.b.c.d`): the same tunnelling trick
    // through the mapped form's near-miss. FIXED - all of these used to be
    // classified PUBLIC.
    { ip: "::127.0.0.1", blocked: true, why: "compatible form for loopback" },
    { ip: "::7f00:1", blocked: true, why: "compatible form for loopback, hex" },
    { ip: "::10.0.0.1", blocked: true, why: "compatible form for RFC 1918" },
    { ip: "0:0:0:0:0:0:a00:1", blocked: true, why: "compatible form, uncompressed" },
    { ip: "::169.254.169.254", blocked: true, why: "compatible form for IMDS" },
    { ip: "::ffff:169.254.169.254", blocked: true, why: "IMDS through a v6 literal" },
    { ip: "0:0:0:0:0:ffff:7f00:1", blocked: true, why: "same prefix, hex spelling" },
    { ip: "::ffff:93.184.216.34", blocked: false, why: "mapped PUBLIC is still public" },
    { ip: "::ffff:8.8.8.8", blocked: false, why: "mapped public resolver" },

    // NAT64 well-known prefix: also carries an embedded IPv4.
    { ip: "64:ff9b::127.0.0.1", blocked: true, why: "NAT64 to loopback" },
    { ip: "64:ff9b::7f00:1", blocked: true, why: "NAT64 to loopback, hex" },
    { ip: "64:ff9b::10.0.0.1", blocked: true, why: "NAT64 to RFC 1918" },
    { ip: "64:ff9b::93.184.216.34", blocked: false, why: "NAT64 to public is public" },

    // fc00::/7 unique-local.
    { ip: "fc00::", blocked: true, why: "first address of fc00::/7" },
    { ip: "fd12:3456:789a::1", blocked: true, why: "typical ULA" },
    { ip: "fdff:ffff::1", blocked: true, why: "last address of fc00::/7" },
    { ip: "fbff:ffff::1", blocked: false, why: "one below fc00::/7 - public" },
    { ip: "fe00::1", blocked: false, why: "in fe00::/16 - above fc00::/7, below fe80::/10" },

    // fe80::/10 link-local.
    { ip: "fe80::1", blocked: true, why: "v6 link-local" },
    { ip: "febf:ffff::1", blocked: true, why: "last address of fe80::/10" },
    { ip: "fec0::1", blocked: true, why: "deprecated site-local" },
    { ip: "fe7f:ffff::1", blocked: false, why: "one below fe80::/10 - public" },

    // Multicast.
    { ip: "ff02::1", blocked: true, why: "all-nodes multicast" },
    { ip: "ff00::1", blocked: true, why: "first of ff00::/8" },

    // Other non-routable / special ranges.
    { ip: "100::1", blocked: true, why: "discard-only" },
    { ip: "2001:db8::1", blocked: true, why: "documentation range" },
    { ip: "2002::1", blocked: true, why: "6to4 tunnel" },
    { ip: "2001:0:1::1", blocked: true, why: "Teredo tunnel" },
    { ip: "2001:10::1", blocked: true, why: "ORCHID" },
    { ip: "2001:20::1", blocked: false, why: "just past ORCHID 2001:10::/28" },

    // Public control group.
    { ip: "2606:4700:4700::1111", blocked: false, why: "public resolver" },
    { ip: "2a00:1450:4001:81f::200e", blocked: false, why: "public web host" },
  ];

  test("every v6 family is classified the way the table claims", async () => {
    for (const row of TABLE) {
      expect({ ip: row.ip, blocked: classifyIp(row.ip) !== null }).toEqual({
        ip: row.ip,
        blocked: row.blocked,
      });
    }
  });

  test("a bracketed literal classifies the same as the bare one", async () => {
    // `url.hostname` keeps the brackets, so the bracketed form is the one the
    // guard actually sees. If the two diverged, one of the two URL spellings
    // would walk straight past the check.
    for (const ip of ["::1", "::", "::ffff:127.0.0.1", "fe80::1", "fd12::1", "2606:4700::1111"]) {
      expect({ ip, same: classifyIp(`[${ip}]`) === classifyIp(ip) }).toEqual({
        ip,
        same: true,
      });
    }
  });

  test("a zone id does not change the verdict", () => {
    // A scope id is irrelevant to routing, and an attacker must not be able
    // to smuggle `fe80::1%eth0` past the link-local check by suffixing it.
    // Note the bracketed form is compared against the bracketed bare form:
    // stripping the zone from `[fe80::1%25eth0]` leaves an unbalanced `[`.
    const CASES: readonly { scoped: string; bare: string }[] = [
      { scoped: "fe80::1%eth0", bare: "fe80::1" },
      { scoped: "::1%25eth0", bare: "::1" },
      { scoped: "[fe80::1%25eth0]", bare: "[fe80::1]" },
      { scoped: "[::ffff:127.0.0.1%25eth0]", bare: "[::ffff:127.0.0.1]" },
    ];
    for (const row of CASES) {
      expect({ scoped: row.scoped, same: classifyIp(row.scoped) === classifyIp(row.bare) }).toEqual(
        { scoped: row.scoped, same: true },
      );
    }
    // And the suffix never turns a blocked address into an allowed one.
    expect(classifyIp("fe80::1%eth0")).toBe("link-local (fe80::/10)");
  });

  test("a v6 address with 8 explicit groups is not confused with 9", async () => {
    expect(classifyIp("1:2:3:4:5:6:7:8")).toBeNull();
    expect(classifyIp("1:2:3:4:5:6:7:8:9")).toContain("unparseable IPv6");
  });
});

// ---- Fail-closed parsing --------------------------------------------

describe("classifyIp - unparseable input never reads as public", () => {
  const UNPARSEABLE = [
    "",
    "   ",
    "256.0.0.1",
    "1.2.3",
    "1.2.3.4.5",
    "0x7f000001",
    "999.999.999.999",
    "1.2.3.-4",
    "not-an-ip",
    "example.com",
    "::1::2",
    "gggg::1",
    "1:2:3:4:5:6:7:8:9",
    "::1:2:3:4:5:6:7:8",
    "[::1",
    ":",
    "::%",
  ];

  test("every unparseable string yields a reason, never null", async () => {
    // THE fail-closed property. If any of these returned `null`, a resolver
    // that answered with garbage would be treated as having answered with a
    // public address.
    for (const input of UNPARSEABLE) {
      expect({ input, reason: classifyIp(input) }).toEqual({
        input,
        reason: expect.any(String),
      });
    }
  });

  test("surrounding whitespace and leading zeros do not defeat the check", async () => {
    // These PARSE, so they must classify rather than fail: ` 127.0.0.1 `
    // still names loopback. Leading zeros are read as DECIMAL, not octal -
    // `010.0.0.1` is 10.0.0.1, not 8.0.0.1, which is the fail-closed
    // direction here (the octal reading would have been a public address).
    expect(classifyIp(" 127.0.0.1 ")).toContain("loopback");
    expect(classifyIp("010.0.0.1")).toBe("private (RFC 1918 10.0.0.0/8)");
    expect(classifyIp("1.2.3.4 ")).toBeNull();
  });
});

// ---- Scheme policy --------------------------------------------------

describe("scheme policy", () => {
  const REFUSED: readonly { url: string; scheme: string }[] = [
    { url: "http://example.com/", scheme: "http" },
    { url: "HTTP://example.com/", scheme: "HTTP" },
    { url: "file:///etc/passwd", scheme: "file" },
    { url: "gopher://example.com/_stats", scheme: "gopher" },
    { url: "dict://example.com/d", scheme: "dict" },
    { url: "ftp://example.com/", scheme: "ftp" },
    { url: "data:text/plain,hello", scheme: "data" },
    { url: "javascript:alert(1)", scheme: "javascript" },
  ];

  test("every non-https scheme is refused as not_https", async () => {
    // HTTPS-ONLY, not http-or-https: the webhook body carries a signature
    // and a case transcript, so plaintext is refused outright.
    for (const row of REFUSED) {
      const v = await refuse(row.url, { resolver: publicResolver });
      expect({ url: row.url, code: v.code, scheme: v.reason }).toEqual({
        url: row.url,
        code: "not_https",
        scheme: `scheme "${row.scheme.toLowerCase()}:" is not https`,
      });
    }
  });

  test("an uppercase HTTPS scheme is accepted", async () => {
    // WHATWG lowercases the scheme; refusing it would be a bug, not policy.
    const v = await validateOutboundUrl("HTTPS://example.com/", { resolver: publicResolver });
    expect(v.ok).toBe(true);
  });

  test("the scheme check runs before DNS, so a private host under http is still not_https", async () => {
    // Ordering matters: the reason a caller logs should be the scheme, not a
    // resolution result the module never needed.
    const { asked, resolver } = countingResolver();
    const v = await refuse("http://10.0.0.1/", { resolver });
    expect({ code: v.code, dnsCalls: asked.length }).toEqual({
      code: "not_https",
      dnsCalls: 0,
    });
  });
});

// ---- Parser confusion -----------------------------------------------

describe("scheme and host parser confusion", () => {
  test("the backslash form is judged by the host DNS actually returns", async () => {
    // `https://evil.com\@127.0.0.1` is the classic parser-differential. WHATWG
    // treats `\` as `/`, so the host is `evil.com` and `@127.0.0.1` is a path.
    // The guard must therefore ask DNS about `evil.com` - not reject on the
    // substring "127.0.0.1", and not accept on it either.
    const { asked, resolver } = countingResolver(PRIVATE);
    const v = await refuse("https://evil.com\\@127.0.0.1", { resolver });
    expect({ asked, code: v.code, host: v.host }).toEqual({
      asked: ["evil.com"],
      code: "private_address",
      host: "evil.com",
    });
  });

  test("the same backslash form is allowed when evil.com resolves publicly", async () => {
    // Proves the refusal above came from the resolved address, not from a
    // blanket rejection of backslashes.
    const { asked, resolver } = countingResolver();
    const v = await validateOutboundUrl("https://evil.com\\@127.0.0.1", { resolver });
    expect(v.ok && v.addresses).toEqual(PUBLIC.map((r) => r.address));
    expect(asked).toEqual(["evil.com"]);
  });

  test("a host that only LOOKS internal is judged by resolution", async () => {
    // `127.0.0.1.evil.com` is a real, publicly resolvable name. A guard that
    // substring-matched "127.0.0.1" would break a legitimate customer; a
    // guard that trusted the name without resolving would be the bypass.
    const permissive = countingResolver();
    const allowed = await validateOutboundUrl("https://127.0.0.1.evil.com", {
      resolver: permissive.resolver,
    });
    expect(allowed.ok && allowed.addresses).toEqual(["93.184.216.34"]);
    expect(permissive.asked).toEqual(["127.0.0.1.evil.com"]);

    const hostile = countingResolver(PRIVATE);
    const blocked = await refuse("https://127.0.0.1.evil.com", { resolver: hostile.resolver });
    expect({ code: blocked.code, host: blocked.host }).toEqual({
      code: "private_address",
      host: "127.0.0.1.evil.com",
    });
  });

  test("a wildcard-DNS name is resolved and the ADDRESS is judged", async () => {
    // `10-1-2-3.nip.io` is a service that hands back 10.1.2.3 for any input.
    // The name is not on the blocklist; the resolved answer is what matters,
    // so it must be refused - and only because of the answer.
    const hostile = countingResolver(PRIVATE);
    const blocked = await refuse("https://10-1-2-3.nip.io/", { resolver: hostile.resolver });
    expect({ code: blocked.code, asked: hostile.asked }).toEqual({
      code: "private_address",
      asked: ["10-1-2-3.nip.io"],
    });

    const benign = countingResolver();
    const allowed = await validateOutboundUrl("https://93-184-216-34.nip.io/", {
      resolver: benign.resolver,
    });
    expect(allowed.ok).toBe(true);
  });

  test("a CRLF in the URL is normalised away, never dialled verbatim", async () => {
    // Two spellings, two outcomes, and the difference is load-bearing. With a
    // `/` the CRLF lands in the PATH, where WHATWG strips it and
    // percent-encodes the rest - so the URL validates, but the value actually
    // dialled is the NORMALISED `url` from the verdict. Without the `/` it
    // lands where the authority is parsed and the URL is refused outright.
    // Either way no raw CRLF reaches the transport, which is the property: a
    // header-injection primitive needs the bytes to survive parsing.
    const pathForm = await validateOutboundUrl("https://example.com/\r\nX-Injected: 1", {
      resolver: publicResolver,
    });
    expect(pathForm.ok && pathForm.url.href).toBe("https://example.com/X-Injected:%201");

    const authorityForm = await refuse("https://example.com\r\nX-Injected: 1", {
      resolver: publicResolver,
    });
    expect(authorityForm.code).toBe("malformed_url");

    // A percent-encoded CRLF stays encoded in the path - it is data, not a
    // line break, so it is neither stripped nor a smuggling vector.
    const encoded = await validateOutboundUrl("https://example.com/%0d%0aX:1", {
      resolver: publicResolver,
    });
    expect(encoded.ok && encoded.url.pathname).toBe("/%0d%0aX:1");
  });

  test("a trailing dot is refused rather than normalised away", async () => {
    // `example.com.` is a legal FQDN that resolves, but accepting it would
    // mean the guard judged `example.com` while a different string is dialled
    // - and `foo.local.` is how a suffix blocklist gets evaded.
    for (const url of ["https://example.com.", "https://foo.local.", "https://example.com../"]) {
      const v = await refuse(url, { resolver: publicResolver });
      expect({ url, code: v.code }).toEqual({ url, code: "blocked_hostname" });
    }
  });

  test("a hostname with no dot is refused as not fully qualified", async () => {
    // A bare label cannot be a public name, and resolving it would consult
    // the local search domain - a classic internal-name leak.
    const { asked, resolver } = countingResolver();
    for (const url of ["https://singlelabel", "https://intranet"]) {
      const v = await refuse(url, { resolver });
      expect({ url, code: v.code }).toEqual({ url, code: "blocked_hostname" });
    }
    expect(asked).toEqual([]);
  });

  test("internal-only hostnames are refused without consulting DNS", async () => {
    const { asked, resolver } = countingResolver();
    const NAMES = [
      "https://localhost/",
      "https://LOCALHOST/",
      "https://metadata.google.internal/",
      "https://metadata/",
      "https://metadata.packet.net/",
      "https://instance-data.ec2.internal/",
      "https://printer.local/",
      "https://wiki.intranet/",
      "https://db.private/",
      "https://host.corp/",
      "https://gw.home.arpa/",
      "https://box.lan/",
      "https://x.test/",
      "https://x.invalid/",
      "https://x.example/",
      "https://x.internal.example/",
    ];
    for (const url of NAMES) {
      const v = await refuse(url, { resolver });
      expect({ url, code: v.code }).toEqual({ url, code: "blocked_hostname" });
    }
    // A blocked name must never reach the resolver: that lookup would itself
    // be the internal-name leak the blocklist exists to prevent.
    expect(asked).toEqual([]);

    // The suffix list is anchored to the END of the host, so
    // `app.internal.example.com` is NOT matched by ".internal" - it is a
    // public FQDN that happens to contain the word. Asserting the anchoring
    // is what stops someone "fixing" the blocklist into a substring match and
    // breaking legitimate customers.
    const routable = await validateOutboundUrl("https://app.internal.example.com/", {
      resolver,
    });
    expect({ ok: routable.ok, asked }).toEqual({
      ok: true,
      asked: ["app.internal.example.com"],
    });
  });
});

// ---- Literal hosts --------------------------------------------------

describe("IP literals", () => {
  const URLS: readonly { url: string; blocked: boolean; why: string }[] = [
    { url: "https://127.0.0.1/", blocked: true, why: "loopback" },
    { url: "https://127.1/", blocked: true, why: "short loopback form" },
    { url: "https://2130706433/", blocked: true, why: "decimal 127.0.0.1" },
    { url: "https://0x7f000001/", blocked: true, why: "hex 127.0.0.1" },
    { url: "https://0177.0.0.1/", blocked: true, why: "octal 127.0.0.1" },
    { url: "https://0/", blocked: true, why: "decimal 0.0.0.0" },
    { url: "https://10.0.0.1/", blocked: true, why: "RFC 1918" },
    { url: "https://172.16.0.1/", blocked: true, why: "RFC 1918" },
    { url: "https://192.168.1.1/", blocked: true, why: "RFC 1918" },
    { url: "https://169.254.169.254/", blocked: true, why: "IMDS" },
    { url: "https://100.100.100.200/", blocked: true, why: "Alibaba IMDS" },
    { url: "https://192.0.0.192/", blocked: true, why: "Oracle IMDS" },
    { url: "https://[::1]/", blocked: true, why: "v6 loopback" },
    { url: "https://[::]/", blocked: true, why: "v6 unspecified" },
    { url: "https://[fd00::1]/", blocked: true, why: "unique-local" },
    { url: "https://[fe80::1]/", blocked: true, why: "v6 link-local" },
    { url: "https://[::ffff:127.0.0.1]/", blocked: true, why: "v4-mapped loopback" },
    { url: "https://[64:ff9b::169.254.169.254]/", blocked: true, why: "NAT64 to IMDS" },
    { url: "https://93.184.216.34/", blocked: false, why: "public" },
    { url: "https://8.8.8.8/", blocked: false, why: "public" },
    { url: "https://[2606:4700:4700::1111]/", blocked: false, why: "public v6" },
  ];

  test("every literal is refused or allowed exactly as the table claims", async () => {
    for (const row of URLS) {
      const verdict = await validateOutboundUrl(row.url, { resolver: publicResolver });
      expect({ url: row.url, blocked: !verdict.ok }).toEqual({
        url: row.url,
        blocked: row.blocked,
      });
    }
  });

  test("a literal host is never sent to the resolver", async () => {
    // No DNS for a literal means no rebind window: there is nothing to race.
    // Blocked NAMES are also never resolved (asserted above), so any DNS call
    // here at all is a bug.
    const { asked, resolver } = countingResolver();
    for (const row of URLS) {
      await validateOutboundUrl(row.url, { resolver });
    }
    expect(asked).toEqual([]);
  });

  test("an allowed literal reports the literal as its address", async () => {
    const v = await validateOutboundUrl("https://8.8.8.8/x", { resolver: publicResolver });
    expect(v.ok && v.addresses).toEqual(["8.8.8.8"]);
  });

  test("a refusal carries the offending host", async () => {
    // The host is what an operator needs in order to act on the log line.
    const v = await refuse("https://169.254.169.254/latest/meta-data/", {
      resolver: publicResolver,
    });
    expect(v).toEqual({
      ok: false,
      code: "private_address",
      reason: "cloud metadata endpoint (169.254.169.254) \u2014 AWS/GCP/Azure/DigitalOcean IMDS",
      host: "169.254.169.254",
    });
  });
});

// ---- DNS rebinding --------------------------------------------------

describe("DNS rebinding", () => {
  test("an innocuous name resolving to a private address is refused", async () => {
    // The actual attack. A hostname blocklist never catches this; resolution
    // does. The host in the message must be the NAME, not the address, so the
    // log tells an operator which DNS record to look at.
    const v = await refuse("https://internal.example.com/", { resolver: privateResolver });
    expect(v).toEqual({
      ok: false,
      code: "private_address",
      reason:
        '"internal.example.com" resolves to a blocked address (private (RFC 1918 10.0.0.0/8))',
      host: "internal.example.com",
    });
  });

  test("ONE private answer among public ones refuses the whole host", async () => {
    // The connection race: an attacker who controls DNS returns one public
    // and one private address and lets the pick decide. There is no ordering
    // of the answers that makes this safe, so it is refused outright.
    const racer: DnsResolver = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ];
    const v = await refuse("https://racer.example.com/", { resolver: racer });
    expect(v.code).toBe("private_address");
    expect(v.reason).toContain("private (RFC 1918 10.0.0.0/8)");
  });

  test("a v6 answer is classified by the same table as a v4 one", async () => {
    const v6Private: DnsResolver = async () => [{ address: "::1", family: 6 }];
    const v = await refuse("https://dual.example.com/", { resolver: v6Private });
    expect(v.reason).toContain("loopback (::1)");

    const v6Public: DnsResolver = async () => [{ address: "2606:4700:4700::1111", family: 6 }];
    const ok = await validateOutboundUrl("https://dual.example.com/", { resolver: v6Public });
    expect(ok.ok && ok.addresses).toEqual(["2606:4700:4700::1111"]);
  });

  test("a resolver that answers with garbage is refused, not treated as public", async () => {
    // Fail-closed at the DNS boundary: an answer the module cannot classify
    // must not read as "no problem found".
    const garbage: DnsResolver = async () => [{ address: "not-an-ip", family: 4 }];
    const v = await refuse("https://weird.example.com/", { resolver: garbage });
    expect({ code: v.code, reason: v.reason }).toEqual({
      code: "private_address",
      reason:
        '"weird.example.com" resolves to a blocked address (unparseable IP address "not-an-ip")',
    });
  });

  test("an empty answer is refused as no_addresses", async () => {
    const empty: DnsResolver = async () => [];
    const v = await refuse("https://empty.example.com/", { resolver: empty });
    expect({ code: v.code, reason: v.reason }).toEqual({
      code: "no_addresses",
      reason: "hostname resolved to no addresses",
    });
  });

  test("a resolver that throws is refused as dns_failed, Error or not", async () => {
    // A throw is a verdict, not a crash: the caller must be able to return a
    // clean 4xx to the bank instead of a 500.
    const erroring: DnsResolver = async () => {
      throw new Error("getaddrinfo ENOTFOUND example.com");
    };
    const stringly: DnsResolver = async () => {
      // eslint-disable-next-line no-throw-literal -- a non-Error rejection is exactly the case under test
      throw "weird";
    };
    expect(await refuse("https://x.example.com/", { resolver: erroring })).toEqual({
      ok: false,
      code: "dns_failed",
      reason: "DNS resolution failed: getaddrinfo ENOTFOUND example.com",
      host: "x.example.com",
    });
    expect((await refuse("https://x.example.com/", { resolver: stringly })).reason).toBe(
      "DNS resolution failed: weird",
    );
  });

  test("the address cap refuses a rebind-by-volume answer", async () => {
    // 17 answers is how DNS exfiltration and rebinding look in practice.
    const bomb: DnsResolver = async () =>
      Array.from({ length: 17 }, (_, i) => ({ address: `93.184.216.${i}`, family: 4 }));
    const capped = await refuse("https://many.example.com/", { resolver: bomb });
    expect(capped.reason).toBe("hostname resolves to 17 addresses (cap 16)");

    const exactly: DnsResolver = async () =>
      Array.from({ length: 16 }, (_, i) => ({ address: `93.184.216.${i}`, family: 4 }));
    const ok = await validateOutboundUrl("https://many.example.com/", { resolver: exactly });
    expect(ok.ok && ok.addresses.length).toBe(16);

    // The cap is configurable, so the operator can widen or narrow it.
    const widened = await validateOutboundUrl("https://many.example.com/", {
      resolver: bomb,
      maxAddresses: 32,
    });
    expect(widened.ok && widened.addresses.length).toBe(17);
  });

  test("every accepted address is reported back to the caller", async () => {
    // The addresses are what the caller should pin the connection to;
    // dropping them would leave the check and the dialling disconnected.
    const dual: DnsResolver = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ];
    const v = await validateOutboundUrl("https://dual.example.com/", { resolver: dual });
    expect(v.ok && v.addresses).toEqual(["93.184.216.34", "2606:4700:4700::1111"]);
  });

  test("the default resolver maps dns.lookup rows to the guard's own shape", async () => {
    // No stubbing: `localhost` resolves without leaving the machine, and any
    // address it answers with must be one the guard classifies as loopback.
    // If it ever answered with something routable, that would be a hole.
    return defaultResolver("localhost").then((rows) => {
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(typeof row.address).toBe("string");
        expect(typeof row.family).toBe("number");
        expect(classifyIp(row.address)).toContain("loopback");
      }
    });
  });
});

// ---- Credentials and ports ------------------------------------------

describe("credentials and ports", () => {
  test("credentials in the URL are REFUSED, not stripped", async () => {
    // The module refuses rather than strips. Stripping would leave the
    // validator judging one URL while the request carries another; refusing
    // also keeps a password out of logs and Referer headers.
    for (const url of [
      "https://user:pass@example.com/",
      "https://user@example.com/",
      "https://:pass@example.com/",
      "https://user:p%40ss@example.com/",
    ]) {
      const v = await refuse(url, { resolver: publicResolver });
      expect({ url, code: v.code, reason: v.reason }).toEqual({
        url,
        code: "credentials_in_url",
        reason: "URL must not embed credentials",
      });
    }
  });

  test("the credential check runs before DNS", async () => {
    const { asked, resolver } = countingResolver();
    const v = await refuse("https://admin:hunter2@example.com/", { resolver });
    expect({ code: v.code, dnsCalls: asked.length }).toEqual({
      code: "credentials_in_url",
      dnsCalls: 0,
    });
  });

  test("a URL instance carrying credentials is refused too", async () => {
    // A `URL` object bypasses the string path, so the credentials check has
    // to read the parsed fields rather than the input text.
    const v = await refuse(new URL("https://user:pass@example.com/"), {
      resolver: publicResolver,
    });
    expect(v.code).toBe("credentials_in_url");
  });

  test("only port 443 is permitted by default", async () => {
    const CASES: readonly { url: string; ok: boolean }[] = [
      { url: "https://example.com/", ok: true },
      { url: "https://example.com:/", ok: true },
      { url: "https://example.com:443/", ok: true },
      { url: "https://example.com:80/", ok: false },
      { url: "https://example.com:8443/", ok: false },
      { url: "https://example.com:22/", ok: false },
      { url: "https://example.com:0/", ok: false },
    ];
    for (const row of CASES) {
      const verdict = await validateOutboundUrl(row.url, { resolver: publicResolver });
      expect({ url: row.url, ok: verdict.ok }).toEqual(row);
    }
  });

  test("a private host on a blocked port is refused for the PORT, not the address", async () => {
    // Both are refusals; only the code is a contract. Reporting the port first
    // keeps the operator's fix ("do not allow 8443") visible.
    const v = await refuse("https://127.0.0.1:8443/", { resolver: publicResolver });
    expect({ code: v.code, reason: v.reason }).toEqual({
      code: "blocked_port",
      reason: "port 8443 is not permitted (allowed: 443)",
    });
  });

  test("the allowed port list is configurable", async () => {
    const denied = await refuse("https://example.com:8443/", { resolver: publicResolver });
    expect(denied.code).toBe("blocked_port");
    const allowed = await validateOutboundUrl("https://example.com:8443/", {
      resolver: publicResolver,
      allowedPorts: [443, 8443],
    });
    expect(allowed.ok && allowed.url.port).toBe("8443");
  });
});

// ---- Malformed input ------------------------------------------------

describe("malformed input is refused, never thrown", () => {
  /** Anything that is not a string and not a URL. */
  const NOT_A_STRING = [
    null,
    undefined,
    42,
    true,
    {},
    [],
    Symbol("url"),
    () => "https://example.com/",
  ];

  test("non-string, non-URL input yields malformed_url and does not throw", async () => {
    // A webhook URL arrives from a JSON body, so the type is only as good as
    // the schema that preceded it. `raw.trim()` on a number would throw
    // inside the parse; the guard's try/catch turns that into a verdict, and
    // the verdict is a refusal.
    for (const input of NOT_A_STRING) {
      const v = await validateOutboundUrl(input as unknown as string, {
        resolver: publicResolver,
      });
      expect({ input: String(input), code: refusal(v).code }).toEqual({
        input: String(input),
        code: "malformed_url",
      });
    }
  });

  const UNPARSEABLE = [
    "",
    "   ",
    "not a url",
    "example.com",
    "//example.com",
    "https://",
    "https://?",
    "/relative/only",
    "://missing-scheme",
    "https://exa mple.com/",
    "%%%",
  ];

  test("every unparseable string is malformed_url", async () => {
    for (const url of UNPARSEABLE) {
      const v = await refuse(url, { resolver: publicResolver });
      expect({ url, code: v.code }).toEqual({ url, code: "malformed_url" });
    }
  });

  test("a malformed URL is refused before any DNS work", async () => {
    const { asked, resolver } = countingResolver();
    await validateOutboundUrl("not a url", { resolver });
    expect(asked).toEqual([]);
  });

  test("whitespace around a good URL is trimmed rather than refused", async () => {
    // Trailing/leading whitespace is trimmed, and the value actually dialled
    // is the NORMALISED `url` from the verdict - never the raw input. That
    // is what makes trimming safe rather than a bypass: the string that gets
    // validated and the string that gets fetched are the same object.
    for (const raw of ["  https://example.com/  ", "https://example.com/\n", "\thttps://x.com\t"]) {
      const v = await validateOutboundUrl(raw, { resolver: publicResolver });
      expect(v.ok && v.url.toString()).toBe(v.ok ? new URL(v.url.toString()).toString() : "");
      expect(v.ok && v.url.hostname).not.toContain(" ");
    }
  });

  test("a host that parses as neither v4 nor v6 is refused", async () => {
    // Two layers. At the classifier boundary `fe80` is a bare label, not an
    // address. Through the URL path, a malformed bracketed literal is
    // rejected by `new URL` before the module's own IPv6 branch is reached,
    // so the refusal is `malformed_url` - which is still the fail-closed
    // answer, just produced one layer earlier than the comment above it.
    expect(classifyIp("fe80")).toContain("unparseable");
    expect(await refuse("https://[fe80::1::2]/", { resolver: publicResolver })).toEqual({
      ok: false,
      code: "malformed_url",
      reason: "not a valid absolute URL",
    });
  });

  test("a URL instance is accepted and its normalised form is what is returned", async () => {
    const input = new URL("https://example.com/path");
    input.pathname = "/mutated";
    const v = await validateOutboundUrl(input, { resolver: publicResolver });
    // A mutated `URL` object must be judged as it is NOW, not as it was when
    // the caller built it - otherwise a caller could validate one host and
    // dial another.
    expect(v.ok && v.url.pathname).toBe("/mutated");
  });
});

// ---- Redirect chains ------------------------------------------------

describe("validateRedirectChain", () => {
  test("an empty chain is refused", async () => {
    // Fail-closed: an empty chain has no entry point, so there is nothing
    // that could have been validated.
    expect(await validateRedirectChain([])).toEqual({
      ok: false,
      code: "malformed_url",
      reason: "empty redirect chain",
    });
  });

  test("a chain of public hosts is accepted", async () => {
    const v = await validateRedirectChain(
      ["https://93.184.216.34/a", "https://93.184.216.34/b", "https://8.8.8.8/c"],
      { resolver: publicResolver },
    );
    // The verdict reports the LAST hop, not the first: a chain is only as
    // safe as where it ended up, and the caller dials from there.
    expect(v.ok && v.addresses).toEqual(["8.8.8.8"]);
  });

  test("a private hop is refused as redirect_blocked", async () => {
    // Distinct from the entry-point codes so the caller can tell "your bank
    // configured a bad URL" from "the server we called tried to redirect us
    // somewhere internal".
    const v = await validateRedirectChain(["https://93.184.216.34/a", "https://10.0.0.1/b"]);
    expect(v).toEqual({
      ok: false,
      code: "redirect_blocked",
      reason: "redirect target rejected \u2014 private (RFC 1918 10.0.0.0/8)",
      host: "10.0.0.1",
    });
  });

  test("a bad ENTRY keeps its own code and is not relabelled redirect_blocked", async () => {
    // The distinction is the whole reason the two codes exist.
    const v = await validateRedirectChain(["https://10.0.0.1/a", "https://10.0.0.2/b"]);
    expect(v).toEqual({
      ok: false,
      code: "private_address",
      reason: "private (RFC 1918 10.0.0.0/8)",
      host: "10.0.0.1",
    });
  });

  test("every hop is validated, not just the first", async () => {
    const v = await validateRedirectChain([
      "https://93.184.216.34/a",
      "https://8.8.8.8/b",
      "https://169.254.169.254/c",
    ]);
    expect(v.ok).toBe(false);
    expect(refusal(v).code).toBe("redirect_blocked");
  });
});

// ---- safeFetch ------------------------------------------------------

describe("safeFetch - redirect handling", () => {
  test("safeFetch forces redirect: manual even when the caller asks to follow", async () => {
    // The defence IS `redirect: "manual"`. If a caller-supplied
    // `redirect: "follow"` ever reached the transport, the re-validation loop
    // would be decorative and a 302 to IMDS would go straight through.
    // "never called" is tracked as a sentinel count rather than a null value, so
    // the assertion below stays a plain comparison on a RequestRedirect.
    let calls = 0;
    let seen: RequestRedirect | undefined;
    const fetchImpl = asFetch(async (_input, init) => {
      calls += 1;
      seen = init?.redirect;
      return stubResponse(200);
    });
    await safeFetch(
      "https://93.184.216.34/a",
      { redirect: "follow" },
      { fetchImpl, resolver: publicResolver },
    );
    expect({ calls, seen }).toEqual({ calls: 1, seen: "manual" });
  });

  const HOSTILE_HOPS: readonly { location: string; why: string; expectCode: SsrfCode }[] = [
    {
      location: "https://169.254.169.254/latest/meta-data/",
      why: "cloud metadata over an already-validated https host",
      expectCode: "redirect_blocked",
    },
    {
      location: "//10.0.0.5/steal",
      why: "protocol-relative hop inherits the scheme and aims at RFC 1918",
      expectCode: "redirect_blocked",
    },
    {
      location: "http://93.184.216.34/plain",
      why: "https downgrade",
      expectCode: "redirect_blocked",
    },
    {
      location: "https://user:pass@93.184.216.34/x",
      why: "credentials smuggled into a hop",
      expectCode: "redirect_blocked",
    },
    {
      location: "https://93.184.216.34:8443/x",
      why: "port policy bypassed by a hop",
      expectCode: "redirect_blocked",
    },
    {
      location: "http://169.254.169.254/",
      why: "metadata with a downgrade in one hop",
      expectCode: "redirect_blocked",
    },
    {
      location: "https://[::ffff:169.254.169.254]/",
      why: "metadata smuggled through an IPv4-mapped IPv6 literal",
      expectCode: "redirect_blocked",
    },
  ];

  test("a redirect to a private address is refused before it is dialled", async () => {
    // The fetch COUNT is the assertion, not just the code: a guard that
    // validated the hop after fetching it would look identical from the
    // outside, and the metadata endpoint would already have answered.
    for (const hop of HOSTILE_HOPS) {
      const dialled: string[] = [];
      let n = 0;
      const fetchImpl = asFetch(async (input) => {
        dialled.push(String(input));
        n += 1;
        return n === 1 ? stubResponse(302, hop.location) : stubResponse(200);
      });
      const err = await safeFetch(
        "https://93.184.216.34/start",
        {},
        { fetchImpl, resolver: publicResolver },
      ).then(
        () => null,
        (e: unknown) => e,
      );
      expect({ why: hop.why, isBlocked: err instanceof SsrfBlockedError }).toEqual({
        why: hop.why,
        isBlocked: true,
      });
      const blocked = err as SsrfBlockedError;
      expect({ why: hop.why, code: blocked.code }).toEqual({
        why: hop.why,
        code: hop.expectCode,
      });
      // Exactly one request went out: the entry point. The rejected hop
      // was never contacted.
      expect({ why: hop.why, dialled }).toEqual({
        why: hop.why,
        dialled: ["https://93.184.216.34/start"],
      });
    }
  });

  test("every 3xx in the redirect range is re-validated", async () => {
    for (const status of [300, 301, 302, 303, 307, 308]) {
      let n = 0;
      const fetchImpl = asFetch(async () => {
        n += 1;
        return n === 1 ? stubResponse(status, "https://10.0.0.5/x") : stubResponse(200);
      });
      const err = await safeFetch(
        "https://93.184.216.34/start",
        {},
        { fetchImpl, resolver: publicResolver },
      ).then(
        () => null,
        (e: unknown) => e as SsrfBlockedError,
      );
      expect({ status, code: err?.code, fetches: n }).toEqual({
        status,
        code: "redirect_blocked",
        fetches: 1,
      });
    }
  });

  test("a non-redirect status carrying a Location header is NOT followed", async () => {
    // A 200 with a Location is not a redirect. Following it would let a
    // server smuggle a hop into a body, and - worse - would make the guard
    // treat a 4xx error page as an instruction.
    for (const status of [200, 204, 299, 400, 500]) {
      let n = 0;
      const fetchImpl = asFetch(async () => {
        n += 1;
        const res = stubResponse(status);
        res.headers.set("location", "https://10.0.0.5/x");
        return res;
      });
      const res = await safeFetch(
        "https://93.184.216.34/start",
        {},
        { fetchImpl, resolver: publicResolver },
      );
      expect({ status, returned: res.status, fetches: n }).toEqual({
        status,
        returned: status,
        fetches: 1,
      });
    }
  });

  test("a 3xx with no Location header terminates the walk", async () => {
    // Not a redirect we can act on: return it rather than spinning or
    // inventing a target.
    let n = 0;
    const fetchImpl = asFetch(async () => {
      n += 1;
      return stubResponse(304);
    });
    const res = await safeFetch(
      "https://93.184.216.34/start",
      {},
      { fetchImpl, resolver: publicResolver },
    );
    expect({ status: res.status, fetches: n }).toEqual({ status: 304, fetches: 1 });
  });

  test("a public hop is followed and the FINAL response is returned", async () => {
    // Intermediate 3xx bodies are discarded so a caller can never read a
    // redirect target's content - the assertion is on the body, not the status.
    let n = 0;
    const fetchImpl = asFetch(async () => {
      n += 1;
      if (n === 1) return stubResponse(301, "/landed");
      return new Response("final-body", { status: 200 });
    });
    const res = await safeFetch(
      "https://93.184.216.34/start",
      {},
      { fetchImpl, resolver: publicResolver },
    );
    expect({ status: res.status, body: await res.text(), fetches: n }).toEqual({
      status: 200,
      body: "final-body",
      fetches: 2,
    });
  });

  test("the redirect budget bounds the walk", async () => {
    // Unbounded following is a second SSRF primitive and a hang. The budget
    // is hops, so the fetch count is budget + 1.
    for (const maxRedirects of [0, 1, 5]) {
      let n = 0;
      const fetchImpl = asFetch(async () => {
        n += 1;
        return stubResponse(302, "https://93.184.216.34/loop");
      });
      const err = await safeFetch(
        "https://93.184.216.34/start",
        {},
        { fetchImpl, resolver: publicResolver, maxRedirects },
      ).then(
        () => null,
        (e: unknown) => e as SsrfBlockedError,
      );
      expect({ maxRedirects, code: err?.code, fetches: n }).toEqual({
        maxRedirects,
        code: "too_many_redirects",
        fetches: maxRedirects + 1,
      });
    }
  });

  test("a blocked entry point is refused before any request goes out", async () => {
    let dialled = 0;
    const fetchImpl = asFetch(async () => {
      dialled += 1;
      return stubResponse(200);
    });
    const err = await safeFetch(
      "https://169.254.169.254/",
      {},
      { fetchImpl, resolver: publicResolver },
    ).then(
      () => null,
      (e: unknown) => e as SsrfBlockedError,
    );
    expect({ code: err?.code, dialled }).toEqual({ code: "private_address", dialled: 0 });
  });

  test("the refusal is a typed SsrfBlockedError carrying its code", async () => {
    // The caller must be able to branch on `code` without string matching a
    // reason, and `instanceof Error` must hold for the existing catch sites.
    const err = await safeFetch("http://example.com/", {}, { resolver: publicResolver }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SsrfBlockedError);
    expect(err).toBeInstanceOf(Error);
    const blocked = err as SsrfBlockedError;
    expect({ name: blocked.name, code: blocked.code }).toEqual({
      name: "SsrfBlockedError",
      code: "not_https",
    });
    expect(blocked.message).toBe('scheme "http:" is not https');
  });

  test("timeoutMs synthesises a signal, and a caller-supplied signal wins", async () => {
    // A timeout the caller cannot cancel would be a bug in its own right, so
    // an explicit `init.signal` must be left alone.
    const seen: (AbortSignal | null | undefined)[] = [];
    const fetchImpl = asFetch(async (_input, init) => {
      seen.push(init?.signal);
      return stubResponse(200);
    });
    const opts = { fetchImpl, resolver: publicResolver, timeoutMs: 5_000 };
    await safeFetch("https://93.184.216.34/a", {}, opts);
    expect(seen[0] instanceof AbortSignal).toBe(true);

    await safeFetch("https://93.184.216.34/a", {}, { fetchImpl, resolver: publicResolver });
    expect(seen[1]).toBeUndefined();

    const own = AbortSignal.abort();
    await safeFetch("https://93.184.216.34/a", { signal: own }, opts);
    expect(seen[2]).toBe(own);
  });

  test("KNOWN GAP: an unparseable Location escapes as a raw TypeError", async () => {
    // ssrf.ts:591 wraps `new URL(location, current.url)` in nothing. The
    // target is still never dialled, so this is not an open door - but a
    // caller catching only `SsrfBlockedError` gets an unclassified throw,
    // which becomes a 500 rather than the 4xx this module exists to produce.
    for (const location of ["http://[", "///", "https://"]) {
      let n = 0;
      const fetchImpl = asFetch(async () => {
        n += 1;
        return stubResponse(302, location);
      });
      const err = await safeFetch(
        "https://93.184.216.34/start",
        {},
        { fetchImpl, resolver: publicResolver },
      ).then(
        () => null,
        (e: unknown) => e,
      );
      expect({ location, isSsrfError: err instanceof SsrfBlockedError, fetches: n }).toEqual({
        location,
        isSsrfError: false,
        fetches: 1,
      });
      expect((err as Error).name).toBe("TypeError");
    }
  });
});

// ---- followRedirectChain --------------------------------------------

describe("followRedirectChain", () => {
  test("returns the final response, the landed URL and the whole chain", async () => {
    // The chain is the audit trail: which hosts we dialled, in order.
    const script = [stubResponse(301, "https://93.184.216.34/landed"), stubResponse(200)];
    let n = 0;
    const fetchImpl = asFetch(async () => script[n++] as Response);
    const result = await followRedirectChain("https://93.184.216.34/start", {
      fetchImpl,
      resolver: publicResolver,
    });
    expect({
      status: result.response.status,
      url: result.url.href,
      chain: result.chain,
      addresses: result.addresses,
    }).toEqual({
      status: 200,
      url: "https://93.184.216.34/landed",
      chain: ["https://93.184.216.34/start", "https://93.184.216.34/landed"],
      addresses: ["93.184.216.34"],
    });
  });

  test("a private hop throws redirect_blocked and is not added to the chain", async () => {
    const script = [stubResponse(302, "https://169.254.169.254/latest/meta-data/")];
    let n = 0;
    const dialled: string[] = [];
    const fetchImpl = asFetch(async (input) => {
      dialled.push(String(input));
      return script[n++] as Response;
    });
    const err = await followRedirectChain("https://93.184.216.34/start", {
      fetchImpl,
      resolver: publicResolver,
    }).then(
      () => null,
      (e: unknown) => e as SsrfBlockedError,
    );
    expect({ code: err?.code, dialled }).toEqual({
      code: "redirect_blocked",
      dialled: ["https://93.184.216.34/start"],
    });
    expect(err?.message).toContain("cloud metadata endpoint");
  });

  test("a blocked entry point throws with the ENTRY code, not redirect_blocked", async () => {
    let dialled = 0;
    const fetchImpl = asFetch(async () => {
      dialled += 1;
      return stubResponse(200);
    });
    const err = await followRedirectChain("https://127.0.0.1/start", {
      fetchImpl,
      resolver: publicResolver,
    }).then(
      () => null,
      (e: unknown) => e as SsrfBlockedError,
    );
    expect({ code: err?.code, dialled }).toEqual({ code: "private_address", dialled: 0 });
  });

  test("a 3xx without a Location returns that response", async () => {
    const script = [stubResponse(304)];
    let n = 0;
    const fetchImpl = asFetch(async () => script[n++] as Response);
    const result = await followRedirectChain("https://93.184.216.34/start", {
      fetchImpl,
      resolver: publicResolver,
    });
    expect({ status: result.response.status, chain: result.chain }).toEqual({
      status: 304,
      chain: ["https://93.184.216.34/start"],
    });
  });

  test("the hop budget is enforced and the entry point is always fetched", async () => {
    const dialled: string[] = [];
    const fetchImpl = asFetch(async (input) => {
      dialled.push(String(input));
      return stubResponse(302, "https://93.184.216.34/loop");
    });
    const err = await followRedirectChain("https://93.184.216.34/start", {
      fetchImpl,
      resolver: publicResolver,
    }).then(
      () => null,
      (e: unknown) => e as SsrfBlockedError,
    );
    expect({ code: err?.code, fetches: dialled.length }).toEqual({
      code: "too_many_redirects",
      fetches: 6,
    });
    // The entry point is fetched first, then the looped target until the
    // budget runs out. Every request went to the validated host - the budget
    // is what stops the walk, not a refusal.
    expect(dialled).toEqual([
      "https://93.184.216.34/start",
      "https://93.184.216.34/loop",
      "https://93.184.216.34/loop",
      "https://93.184.216.34/loop",
      "https://93.184.216.34/loop",
      "https://93.184.216.34/loop",
    ]);
  });
});
