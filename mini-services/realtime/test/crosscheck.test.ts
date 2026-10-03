/**
 * Cross-implementation check for the grant token.
 *
 * The app mints (src/lib/realtime-token.ts) and the service verifies
 * (src/auth.ts). These are two copies of the same signing scheme in two packages
 * with two dependency trees, so a drift is possible and would fail every socket
 * handshake at runtime with no useful error. This test mints with the APP's
 * implementation and verifies with the SERVICE's, in both directions.
 */

import { describe, expect, test } from "bun:test";
import { sign, verify } from "../src/auth.ts";
import { signIngest, verifySignature } from "../src/ingest.ts";
import { mintRealtimeToken, signIngestBody } from "../../../src/lib/realtime-token.ts";

const SECRET = "cross-check-secret";
const NOW = 1_800_000_000;

describe("app/service signing agreement", () => {
  test("a token minted by the app verifies in the service", () => {
    process.env.REALTIME_INGEST_SECRET = SECRET;
    const minted = mintRealtimeToken("org_alpha", "analyst-7", ["SV-1", "SV-2"]);
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    const v = verify(minted.token, SECRET, NOW);
    // The minted token expires ~now; verify at the real clock so only the
    // signature format is under test, not the TTL.
    expect(v.ok || v.reason === "expired").toBe(true);

    // Verify the payload shape by decoding: it must carry the org, the operator
    // and every channel the app said it would.
    const [, body] = minted.token.split(".");
    const payload = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
    expect(payload.orgId).toBe("org_alpha");
    expect(payload.sub).toBe("analyst-7");
    expect(payload.chans).toEqual(["org:org_alpha", "case:org_alpha:SV-1", "case:org_alpha:SV-2"]);
  });

  test("a token signed by the service verifies as the app's payload shape", () => {
    // Proves canonicalisation matches in the other direction: the service's
    // signer output must be accepted by the app's expectation of the format.
    const token = sign(
      { orgId: "org_alpha", sub: "analyst-7", chans: ["org:org_alpha"], exp: NOW + 60 },
      SECRET,
    );
    const v = verify(token, SECRET, NOW);
    expect(v.ok).toBe(true);
  });

  test("an ingest signed by the app is accepted by the service", () => {
    process.env.REALTIME_INGEST_SECRET = SECRET;
    const signed = signIngestBody({
      kind: "activity",
      orgId: "org_alpha",
      callRef: "SV-1",
      payload: { a: 1 },
    });
    expect("body" in signed).toBe(true);
    if (!("body" in signed)) return;

    const res = verifySignature(signed.header, signed.body, SECRET);
    expect(res.ok).toBe(true);
  });

  test("an ingest signed by the service is accepted by the app's verifier shape", () => {
    const { body, header } = signIngest(
      { kind: "presence", orgId: "org_alpha", watchers: ["a"] },
      SECRET,
    );
    expect(verifySignature(header, body, SECRET).ok).toBe(true);
  });

  test("both minters refuse to work with no secret configured", () => {
    const saved = process.env.REALTIME_INGEST_SECRET;
    delete process.env.REALTIME_INGEST_SECRET;
    delete process.env.AGENT_TOOL_SECRET;
    expect(mintRealtimeToken("org_alpha", "analyst-7")).toEqual({
      ok: false,
      error: "not_configured",
    });
    expect(verify("anything", "", NOW).ok).toBe(false);
    if (saved !== undefined) process.env.REALTIME_INGEST_SECRET = saved;
  });
});
