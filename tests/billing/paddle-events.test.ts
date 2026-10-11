import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { handlePaddleEvent, isHandledEvent } from "../../src/lib/payments/paddle-events.ts";
import {
  paddleDigest,
  parseSignatureHeader,
  digestMatches,
  timestampFresh,
} from "../../src/lib/payments/paddle.ts";

/**
 * Event routing and the signature primitives.
 *
 * The DB-touching handlers (`mirrorCustomer` / `mirrorSubscription`) are covered
 * in tests/billing against a real database; here the routing logic is verified
 * without one, because the interesting failure is "did we send this event to the
 * right handler at all".
 */

const CTX = { orgId: "org_acme" };

describe("event routing", () => {
  test("every supported event type is claimed", () => {
    for (const t of [
      "subscription.created",
      "subscription.updated",
      "subscription.canceled",
      "customer.created",
      "customer.updated",
      "transaction.completed",
    ]) {
      expect(isHandledEvent(t)).toBe(true);
    }
  });

  test.each([
    "subscription.paused",
    "transaction.billed",
    "adjustment.created",
    "customer.deleted",
    "",
    "totally_unknown",
  ])("ignores %s", async (t) => {
    const r = await handlePaddleEvent(t, {}, CTX);
    expect(r).toEqual({ handled: false, reason: "unsupported_event_type" });
  });

  test("a transaction.completed event is claimed but settles in the route", async () => {
    // NOT here: the route owns `settlePayment`, so a unit test cannot
    // accidentally become the only writer of a payment.
    const r = await handlePaddleEvent("transaction.completed", { id: "txn_1" }, CTX);
    expect(r).toEqual({ handled: true, kind: "transaction.completed" });
  });

  test("a subscription event with no ids is not silently mirrored", async () => {
    // It would throw inside `mirrorSubscription`, which turns into a 500 and a
    // Paddle retry — louder than inserting an unusable row.
    const r = await handlePaddleEvent("subscription.created", { id: "sub_1" }, CTX);
    // The handler logs and returns; the route sees `handled: true`. That is
    // correct: Paddle's event type was understood.
    expect(r.handled).toBe(true);
  });
});

describe("signature primitives", () => {
  const SECRET = "ntfs_secret_x";

  test("the digest signs `${ts}:${body}`", () => {
    const body = '{"event_id":"e"}';
    const expected = createHmac("sha256", SECRET)
      .update("123:" + body)
      .digest("hex");
    expect(paddleDigest(body, SECRET, "123")).toBe(expected);
    // Dropping the prefix must not produce the same value, or a caller that
    // omits it would verify.
    const without = createHmac("sha256", SECRET).update(body).digest("hex");
    expect(expected).not.toBe(without);
  });

  test("a re-serialised body has a different digest", () => {
    const original = '{\n  "b": 2,\n  "a": 1\n}';
    const reserialised = JSON.stringify(JSON.parse(original));
    expect(reserialised).not.toBe(original);
    expect(paddleDigest(original, SECRET, "1")).not.toBe(paddleDigest(reserialised, SECRET, "1"));
  });

  test("parses a well-formed header and rejects malformed ones", () => {
    expect(parseSignatureHeader("ts=1800000000;h1=abcdef01")).toEqual({
      ts: "1800000000",
      h1: "abcdef01",
    });
    for (const bad of ["garbage", "h1=abcdef01", "ts=abc;h1=abcdef01", "ts=1;h1=zz", ""]) {
      expect(parseSignatureHeader(bad)).toBeNull();
    }
  });

  test("a wrong-length digest is refused before the compare", () => {
    // timingSafeEqual throws on mismatch; the length check must come first.
    expect(digestMatches("abcd", "ab")).toBe(false);
    expect(digestMatches("", "abcd")).toBe(false);
  });

  test("the replay window refuses both stale and future timestamps", () => {
    const now = 1_800_000_000_000;
    const s = (offset: number) => String(Math.floor(now / 1000) + offset);
    expect(timestampFresh(s(0), now)).toBe(true);
    expect(timestampFresh(s(-30), now)).toBe(true);
    expect(timestampFresh(s(-3600), now)).toBe(false);
    expect(timestampFresh(s(3600), now)).toBe(false);
  });
});
