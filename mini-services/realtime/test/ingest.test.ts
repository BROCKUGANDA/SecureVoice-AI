import { describe, expect, test } from "bun:test";
import { channelBelongsToOrg, parseIngest, signIngest, verifySignature } from "../src/ingest.ts";

const SECRET = "ingest-secret";
const NOW = 1_800_000_000;

describe("ingest signature", () => {
  test("accepts a freshly signed body", () => {
    const { body, header } = signIngest({ kind: "activity", orgId: "o" }, SECRET, NOW);
    expect(verifySignature(header, body, SECRET, NOW)).toEqual({ ok: true });
  });

  test("rejects a single-byte body mutation", () => {
    const { body, header } = signIngest(
      { kind: "activity", orgId: "o", callRef: "SV-1" },
      SECRET,
      NOW,
    );
    const tampered = body.replace("SV-1", "SV-2");
    expect(verifySignature(header, tampered, SECRET, NOW).ok).toBe(false);
  });

  test("rejects a replayed timestamp outside the window", () => {
    const { body, header } = signIngest({ kind: "activity", orgId: "o" }, SECRET, NOW);
    expect(verifySignature(header, body, SECRET, NOW + 301).ok).toBe(false);
    expect(verifySignature(header, body, SECRET, NOW - 301).ok).toBe(false);
  });

  test("rejects when no secret is configured on this service", () => {
    const { body, header } = signIngest({ kind: "activity", orgId: "o" }, SECRET, NOW);
    expect(verifySignature(header, body, undefined, NOW).ok).toBe(false);
  });

  test("rejects missing and malformed headers", () => {
    const { body } = signIngest({ kind: "activity" }, SECRET, NOW);
    expect(verifySignature(null, body, SECRET, NOW).ok).toBe(false);
    expect(verifySignature("garbage", body, SECRET, NOW).ok).toBe(false);
    expect(verifySignature("t=abc,v1=deadbeef", body, SECRET, NOW).ok).toBe(false);
  });
});

describe("ingest payload", () => {
  test("builds the case channel from org + callRef", () => {
    const r = parseIngest({ kind: "activity", orgId: "org_a", callRef: "SV-9", payload: { x: 1 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.channel).toBe("case:org_a:SV-9");
  });

  test("falls back to the org channel when no callRef is given", () => {
    const r = parseIngest({ kind: "presence", orgId: "org_a", watchers: ["op"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.channel).toBe("org:org_a");
  });

  test("strips colons smuggled into orgId so it cannot forge another org's channel", () => {
    // Without sanitising, orgId "a:case:org_b" would build case:a:case:org_b:SV-1.
    const r = parseIngest({ kind: "activity", orgId: "a:case:org_b", callRef: "SV-1" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.channel.startsWith("case:org_b:")).toBe(false);
      expect(channelBelongsToOrg(r.channel, "org_b")).toBe(false);
    }
  });

  test("refuses a channel that does not belong to the org", () => {
    expect(channelBelongsToOrg("case:org_a:SV-1", "org_b")).toBe(false);
    expect(channelBelongsToOrg("org:org_a", "org_a")).toBe(true);
  });

  test("rejects a missing or non-string orgId", () => {
    expect(parseIngest({ kind: "activity" }).ok).toBe(false);
    expect(parseIngest({ kind: "activity", orgId: 42 }).ok).toBe(false);
    expect(parseIngest({ kind: "activity", orgId: "!!!" }).ok).toBe(false);
  });

  test("rejects an unknown event kind", () => {
    expect(parseIngest({ kind: "drop_table", orgId: "o" }).ok).toBe(false);
    expect(parseIngest("activity").ok).toBe(false);
    expect(parseIngest(null).ok).toBe(false);
  });

  test("rejects an oversized payload with 413", () => {
    const r = parseIngest({ kind: "activity", orgId: "o", payload: { blob: "x".repeat(70_000) } });
    expect(r).toEqual({ ok: false, status: 413, error: "payload_too_large" });
  });

  test("caps the watcher roster", () => {
    const watchers = Array.from({ length: 200 }, (_, i) => `op-${i}`);
    const r = parseIngest({ kind: "presence", orgId: "o", watchers });
    expect(r.ok).toBe(true);
    if (r.ok && r.event.kind === "presence")
      expect(r.event.watchers.length).toBeLessThanOrEqual(64);
  });
});
