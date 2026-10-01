import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { DEFAULT_TTL_SEC, sign, verify } from "../src/auth.ts";

const SECRET = "test-shared-secret";
const NOW = 1_800_000_000;

function grant(over: Partial<Parameters<typeof sign>[0]> = {}) {
  return {
    orgId: "org_alpha",
    sub: "operator-1",
    chans: ["case:org_alpha:SV-1", "org:org_alpha"],
    exp: NOW + DEFAULT_TTL_SEC,
    ...over,
  };
}

describe("grant tokens", () => {
  test("round-trips a valid token", () => {
    const g = verify(sign(grant(), SECRET), SECRET, NOW);
    expect(g.ok).toBe(true);
    if (g.ok) {
      expect(g.orgId).toBe("org_alpha");
      expect(g.sub).toBe("operator-1");
      expect(g.chans).toEqual(["case:org_alpha:SV-1", "org:org_alpha"]);
    }
  });

  test("signature is stable across key insertion order", () => {
    const a = sign({ orgId: "o", sub: "s", chans: ["c"], exp: 1 }, SECRET);
    const b = sign({ exp: 1, chans: ["c"], sub: "s", orgId: "o" }, SECRET);
    expect(a).toBe(b);
  });

  test("rejects a token signed with a different secret", () => {
    const token = sign(grant(), SECRET);
    const g = verify(token, "other-secret", NOW);
    expect(g).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("rejects a payload swapped for a wider channel list", () => {
    // The realistic attack: mint a token for org A, then re-encode the body with
    // org B's channels. Without the HMAC this would grant cross-org reads.
    const forged = sign(grant({ chans: ["case:org_beta:SV-9"] }), "attacker-secret");
    expect(verify(forged, SECRET, NOW).ok).toBe(false);
  });

  test("rejects an expired token", () => {
    const token = sign(grant({ exp: NOW - 3600 }), SECRET);
    expect(verify(token, SECRET, NOW)).toEqual({ ok: false, reason: "expired" });
  });

  test("tolerates small clock skew but not a token past the window", () => {
    const slightly = sign(grant({ exp: NOW - 3 }), SECRET);
    expect(verify(slightly, SECRET, NOW).ok).toBe(true);

    const past = sign(grant({ exp: NOW - 60 }), SECRET);
    expect(verify(past, SECRET, NOW).ok).toBe(false);
  });

  test("rejects malformed shapes without throwing", () => {
    for (const bad of ["", "a.b", "svr1.!!!.???", "svr2.e30.abc", "svr1..abc", "svr1.e30."]) {
      expect(verify(bad, SECRET, NOW).ok).toBe(false);
    }
    expect(verify(null, SECRET, NOW).ok).toBe(false);
    expect(verify(undefined, SECRET, NOW).ok).toBe(false);
  });

  test("rejects a token whose body is not valid JSON", () => {
    const body = Buffer.from("not-json").toString("base64url");
    const sig = createHmac("sha256", SECRET).update(`svr1.${body}`).digest("base64url");
    expect(verify(`svr1.${body}.${sig}`, SECRET, NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  test("refuses an unscoped grant (no channels)", () => {
    const token = sign(grant({ chans: [] }), SECRET);
    expect(verify(token, SECRET, NOW)).toEqual({ ok: false, reason: "unscoped" });
  });

  test("refuses everything when no secret is configured", () => {
    expect(verify(sign(grant(), SECRET), "", NOW).ok).toBe(false);
  });
});
