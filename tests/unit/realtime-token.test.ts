/**
 * UNIT — the realtime grant token (src/lib/realtime-token.ts).
 *
 * This is a signing boundary shared with a SEPARATE service
 * (`mini-services/realtime/src/auth.ts`), and the two implementations must
 * produce byte-identical signatures or every socket handshake fails with
 * `unauthorized` and no obvious cause. The properties below are what keep the
 * two sides in step, plus the authority properties that keep a grant useless
 * to anyone who should not have one:
 *
 *   · Canonicalisation is RECURSIVE and key-sorted, so the signed bytes never
 *     depend on property insertion order. Two structurally identical payloads
 *     built in different orders must sign identically — that is the whole point
 *     of canonicalising, and a shallow sort would break on nested objects.
 *
 *   · Channels are DERIVED from the org, never client-supplied. A caller cannot
 *     widen its own subscription by passing a `callRefs` entry belonging to
 *     another org, so every case channel is namespaced by the SAME orgId.
 *   · The TTL is short (60s) and `exp` is a real unix second, not milliseconds.
 *   · There is deliberately NO fallback to `AGENT_TOOL_SECRET`. That secret
 *     crosses the wire on ElevenLabs tool calls, so sharing it would let a leak
 *     there mint console grants and forge live broadcasts.
 *   · No configured secret means NO token — never a token signed with an empty
 *     key, which would be forgeable by anyone.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { REALTIME_TOKEN_TTL_SEC, mintRealtimeToken, signIngestBody } from "@/lib/realtime-token";

const ENV_KEYS = ["REALTIME_INGEST_SECRET", "AGENT_TOOL_SECRET"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

/** Split `svr1.<body>.<sig>` into its parts. */
function parts(token: string): { prefix: string; body: string; sig: string } {
  const segments = token.split(".");
  return {
    prefix: segments[0]!,
    body: segments[1]!,
    sig: segments[2]!,
  };
}

function payloadOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(parts(token).body, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

describe("mintRealtimeToken — configuration", () => {
  test("refuses when no realtime secret is configured", () => {
    process.env.REALTIME_INGEST_SECRET = undefined;
    delete process.env.REALTIME_INGEST_SECRET;
    expect(mintRealtimeToken("org-1", "user-1")).toEqual({ ok: false, error: "not_configured" });
  });

  test("an empty secret is treated as unconfigured, not as an empty key", () => {
    // Signing with an empty key would produce a token anyone could forge.
    process.env.REALTIME_INGEST_SECRET = "";
    expect(mintRealtimeToken("org-1", "user-1")).toEqual({ ok: false, error: "not_configured" });
  });

  test("there is NO fallback to AGENT_TOOL_SECRET", () => {
    // The whole reason for a dedicated secret: AGENT_TOOL_SECRET crosses the
    // wire on ElevenLabs tool calls, so reusing it here would let a leak there
    // mint console grants.
    process.env.AGENT_TOOL_SECRET = "tool-secret";
    delete process.env.REALTIME_INGEST_SECRET;
    expect(mintRealtimeToken("org-1", "user-1").ok).toBe(false);
  });

  test("mints a token when the secret is present", () => {
    process.env.REALTIME_INGEST_SECRET = "realtime-secret";
    const r = mintRealtimeToken("org-1", "user-1");
    expect(r.ok).toBe(true);
  });
});

describe("mintRealtimeToken — token format", () => {
  beforeEach(() => {
    process.env.REALTIME_INGEST_SECRET = "realtime-secret";
  });

  test("the token has the svr1 prefix the verifier expects", () => {
    const r = mintRealtimeToken("org-1", "user-1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(parts(r.token).prefix).toBe("svr1");
  });

  test("the token is prefix.body.signature with a non-empty signature", () => {
    const r = mintRealtimeToken("org-1", "user-1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = parts(r.token);
    expect(p.body.length).toBeGreaterThan(0);
    expect(p.sig.length).toBeGreaterThan(0);
  });

  test("the body is base64url — no +, / or = that would need escaping in a header", () => {
    const r = mintRealtimeToken("org-1", "user-1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(parts(r.token).body).not.toMatch(/[+/=]/);
  });

  test("the signature is deterministic for the same payload and secret", () => {
    // The two services must agree byte-for-byte, so this must not vary.
    const a = mintRealtimeToken("org-1", "user-1", ["case-a"]);
    const b = mintRealtimeToken("org-1", "user-1", ["case-a"]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(parts(a.token).sig).toBe(parts(b.token).sig);
  });

  test("a different secret produces a different signature over the same body", () => {
    const first = mintRealtimeToken("org-1", "user-1", ["case-a"]);
    process.env.REALTIME_INGEST_SECRET = "a-different-secret";
    const second = mintRealtimeToken("org-1", "user-1", ["case-a"]);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(parts(first.token).sig).not.toBe(parts(second.token).sig);
  });

  test("a different org produces a different signature", () => {
    const a = mintRealtimeToken("org-1", "user-1");
    const b = mintRealtimeToken("org-2", "user-1");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(parts(a.token).sig).not.toBe(parts(b.token).sig);
  });
});

describe("mintRealtimeToken — payload", () => {
  beforeEach(() => {
    process.env.REALTIME_INGEST_SECRET = "realtime-secret";
  });

  test("the payload carries orgId, sub, chans and exp", () => {
    const r = mintRealtimeToken("org-1", "user-1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = payloadOf(r.token);
    expect(p.orgId).toBe("org-1");
    expect(p.sub).toBe("user-1");
    expect(Array.isArray(p.chans)).toBe(true);
    expect(typeof p.exp).toBe("number");
  });

  test("the payload never contains the signing secret", () => {
    const r = mintRealtimeToken("org-1", "user-1", ["case-a"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Buffer.from(parts(r.token).body, "base64url").toString("utf8")).not.toContain(
      "realtime-secret",
    );
  });

  test("the payload keys are sorted, so insert order cannot change the signature", () => {
    const r = mintRealtimeToken("org-1", "user-1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const keys = Object.keys(JSON.parse(Buffer.from(parts(r.token).body, "base64url").toString()));
    expect(keys).toEqual([...keys].sort());
  });

  test("exp is a unix SECOND about 60s out, not milliseconds", () => {
    // Milliseconds here would make the token effectively valid for 50,000 years.
    const before = Math.floor(Date.now() / 1000);
    const r = mintRealtimeToken("org-1", "user-1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const exp = payloadOf(r.token).exp as number;
    expect(exp).toBeGreaterThanOrEqual(before + REALTIME_TOKEN_TTL_SEC - 2);
    expect(exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + REALTIME_TOKEN_TTL_SEC + 2);
    // ~1.8e9 for seconds, not ~1.8e12 for milliseconds.
    expect(exp).toBeLessThan(1e11);
  });

  test("the TTL is 60 seconds", () => {
    expect(REALTIME_TOKEN_TTL_SEC).toBe(60);
  });
});

describe("mintRealtimeToken — channel derivation", () => {
  beforeEach(() => {
    process.env.REALTIME_INGEST_SECRET = "realtime-secret";
  });

  test("an org always gets its own org-wide channel", () => {
    const r = mintRealtimeToken("org-1", "user-1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(payloadOf(r.token).chans).toEqual(["org:org-1"]);
  });

  test("each requested case adds a channel namespaced by the org", () => {
    const r = mintRealtimeToken("org-1", "user-1", ["case-a", "case-b"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(payloadOf(r.token).chans).toEqual([
      "org:org-1",
      "case:org-1:case-a",
      "case:org-1:case-b",
    ]);
  });

  test("a case ref containing a colon cannot forge another org's channel", () => {
    // The channel is built as `case:${orgId}:${ref}` with orgId FIRST, so a
    // crafted ref lands inside this org's own namespace rather than escaping it.
    const r = mintRealtimeToken("org-1", "user-1", ["x:org-2"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const chans = payloadOf(r.token).chans as string[];
    expect(chans).toContain("case:org-1:x:org-2");
    // Nothing grants a bare `org-2` or an `org:org-2` channel.
    expect(chans).not.toContain("org:org-2");
  });

  test("the default callRefs is empty, not undefined leaking into the payload", () => {
    const r = mintRealtimeToken("org-1", "user-1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(payloadOf(r.token).chans).toEqual(["org:org-1"]);
  });

  test("an empty callRefs array adds nothing", () => {
    const r = mintRealtimeToken("org-1", "user-1", []);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(payloadOf(r.token).chans).toEqual(["org:org-1"]);
  });

  test("the same case ref in two orgs yields disjoint channel sets", () => {
    process.env.REALTIME_INGEST_SECRET = "realtime-secret";
    const a = mintRealtimeToken("org-1", "u", ["case-a"]);
    const b = mintRealtimeToken("org-2", "u", ["case-a"]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // Same case ref, different org → no channel is shared, so a subscription
    // granted to one org can never deliver another org's traffic.
    expect(payloadOf(a.token).chans).toEqual(["org:org-1", "case:org-1:case-a"]);
    expect(payloadOf(b.token).chans).toEqual(["org:org-2", "case:org-2:case-a"]);
  });
});

describe("signIngestBody", () => {
  const Signed = z.object({ body: z.string(), header: z.string() });
  const Unconfigured = z.object({ ok: z.literal(false), error: z.literal("not_configured") });
  const Result = z.union([Signed, Unconfigured]);

  test("refuses when no secret is configured", () => {
    delete process.env.REALTIME_INGEST_SECRET;
    expect(Result.parse(signIngestBody({ a: 1 }))).toEqual({
      ok: false,
      error: "not_configured",
    });
  });

  test("returns the body and an SV-style signature header", () => {
    process.env.REALTIME_INGEST_SECRET = "realtime-secret";
    expect(Signed.parse(signIngestBody({ a: 1 })).header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(Signed.parse(signIngestBody({ a: 1 })).body).toBe('{"a":1}');
  });
  test("the header carries the supplied timestamp", () => {
    process.env.REALTIME_INGEST_SECRET = "realtime-secret";
    expect(Signed.parse(signIngestBody({ a: 1 }, 1_700_000_000)).header).toMatch(/^t=1700000000,/);
  });

  test("signing is deterministic for the same body and timestamp", () => {
    process.env.REALTIME_INGEST_SECRET = "realtime-secret";
    const a = Signed.parse(signIngestBody({ a: 1 }, 1_700_000_000));
    const b = Signed.parse(signIngestBody({ a: 1 }, 1_700_000_000));
    expect(a.header).toBe(b.header);
  });

  test("a different timestamp produces a different signature", () => {
    process.env.REALTIME_INGEST_SECRET = "realtime-secret";
    const a = Signed.parse(signIngestBody({ a: 1 }, 1_700_000_000));
    const b = Signed.parse(signIngestBody({ a: 1 }, 1_700_000_001));
    expect(a.header).not.toBe(b.header);
  });

  test("a different body produces a different signature at the same timestamp", () => {
    process.env.REALTIME_INGEST_SECRET = "realtime-secret";
    const a = Signed.parse(signIngestBody({ a: 1 }, 1_700_000_000));
    const b = Signed.parse(signIngestBody({ a: 2 }, 1_700_000_000));
    expect(a.header).not.toBe(b.header);
  });

  test("the signed body is plain JSON, not canonicalised", () => {
    // The two paths differ on purpose: the token is canonicalised because it is
    // signed on both sides, the ingest body is signed by one side only.
    process.env.REALTIME_INGEST_SECRET = "realtime-secret";
    expect(Signed.parse(signIngestBody({ b: 1, a: 2 }, 1_700_000_000)).body).toBe('{"b":1,"a":2}');
  });
});
