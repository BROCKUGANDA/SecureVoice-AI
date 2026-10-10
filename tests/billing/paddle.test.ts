import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  createPaddleProvider,
  paddleDigest,
  parseSignatureHeader,
  digestMatches,
  timestampFresh,
  buildReference,
  parseReference,
  priceKey,
  parsePriceMap,
  decodePaddleEvent,
  PADDLE_SIGNATURE_HEADER,
  PADDLE_ALLOW_LIVE_ENV,
} from "../../src/lib/payments/paddle.ts";

/**
 * The Paddle adapter's gate.
 *
 * The signature tests are the point of this file. Everything else is plumbing;
 * `verifyWebhook` is the one place a forged byte would become money, and the
 * negative cases below are the ones that actually defend it:
 *
 *   - the `ts:` prefix dropped from the signed string;
 *   - the body re-serialised after parsing (key order / whitespace);
 *   - a stale timestamp replayed inside an otherwise-valid signature;
 *   - a reference we did not mint.
 *
 * A green run here means those four are refused. It does NOT mean a real
 * Paddle webhook is accepted — that needs the sandbox, and `paddle:verify`
 * plus a live webhook delivery is the only thing that proves it.
 */

const SECRET = "pdl_notif_secret_test";

/**
 * The signature timestamp, taken from the REAL clock rather than a fixture.
 *
 * `verifyWebhook` refuses a `ts` outside a 300s window against `Date.now()`, and
 * it does not take an injected clock — so a test signing with a hard-coded
 * timestamp is testing a replay, not an acceptance. Pinning "now" here keeps the
 * happy paths meaningful and leaves the refusal paths to the explicit stale- and
 * future-timestamp cases below, which are what those are actually for.
 */
const NOW = Date.now();

function sign(body: string, ts: number, secret = SECRET): string {
  const h1 = createHmac("sha256", secret).update(`${ts}:`).update(body).digest("hex");
  return `ts=${ts};h1=${h1}`;
}

/** A well-formed transaction.completed event carrying one of OUR references. */
function event(reference: string, over: Record<string, unknown> = {}) {
  return {
    event_id: "evt_01test",
    event_type: "transaction.completed",
    occurred_at: "2026-10-10T12:00:00.000Z",
    data: {
      id: "txn_01test",
      status: "completed",
      custom_data: { reference },
      items: [{ price_id: "pri_01test", quantity: 1, unit_price: { amount: "1000", currency_code: "USD" } }],
      ...over,
    },
  };
}

const cfg = (over: Partial<Parameters<typeof createPaddleProvider>[0]> = {}) =>
  ({
    apiKey: "pdl_sdbx_apikey_test",
    webhookSecret: SECRET,
    prices: { usd_1000_month: "pri_01test" },
    http: async () => new Response("{}"),
    ...over,
  }) as Parameters<typeof createPaddleProvider>[0];

describe("signature header parsing", () => {
  test("parses a well-formed header", () => {
    const p = parseSignatureHeader("ts=1800000000;h1=abcdef01");
    expect(p).toEqual({ ts: "1800000000", h1: "abcdef01" });
  });

  test("lowercases the digest", () => {
    expect(parseSignatureHeader("ts=1800000000;h1=ABCDEF01")?.h1).toBe("abcdef01");
  });

  test.each([
    ["no ts", "h1=abcdef01"],
    ["no h1", "ts=1800000000"],
    ["non-numeric ts", "ts=abc;h1=abcdef01"],
    ["non-hex h1", "ts=1800000000;h1=zzzz"],
    ["odd-length h1", "ts=1800000000;h1=abc"],
    ["empty", ""],
  ])("rejects %s", (_label, header) => {
    expect(parseSignatureHeader(header)).toBeNull();
  });
});

describe("digest", () => {
  test("signs `${ts}:${body}` — the ts prefix is part of the signed string", () => {
    const body = '{"a":1}';
    const withPrefix = createHmac("sha256", SECRET).update("123:" + body).digest("hex");
    const withoutPrefix = createHmac("sha256", SECRET).update(body).digest("hex");

    expect(paddleDigest(body, SECRET, "123")).toBe(withPrefix);
    // The two must differ, or the prefix is not being applied and a signature
    // that omits it would verify.
    expect(withPrefix).not.toBe(withoutPrefix);
  });

  test("a re-serialised body does NOT produce the same digest", () => {
    // The original bug class: parse then re-stringify changes whitespace (and,
    // with a different serialiser, key order), so the digest must change.
    //
    // The ORIGINAL is pretty-printed on purpose, because that is what actually
    // happens: a webhook body arriving from a pretty-printing framework or a
    // proxy that reformats JSON is valid JSON that `JSON.stringify` will not
    // reproduce byte-for-byte. A compact original round-trips identically and
    // would make this test pass for the wrong reason.
    const original = '{\n  "b": 2,\n  "a": 1\n}';
    const reserialised = JSON.stringify(JSON.parse(original) as unknown);
    expect(reserialised).not.toBe(original);
    expect(paddleDigest(original, SECRET, "1")).not.toBe(paddleDigest(reserialised, SECRET, "1"));
  });

  test("digestMatches refuses a different-length digest before comparing", () => {
    // timingSafeEqual throws on a length mismatch, so the length check must come
    // first. A throw here would be a 500 on the webhook path.
    expect(digestMatches("abcd", "ab")).toBe(false);
    expect(digestMatches("abcd", "")).toBe(false);
    expect(digestMatches("abcd", "abcd")).toBe(true);
  });
});

describe("replay window", () => {
  test("accepts a timestamp inside the tolerance", () => {
    const ts = String(Math.floor(NOW / 1000) - 30);
    expect(timestampFresh(ts, NOW)).toBe(true);
  });

  test("refuses a timestamp outside it", () => {
    const ts = String(Math.floor(NOW / 1000) - 3600);
    expect(timestampFresh(ts, NOW)).toBe(false);
  });

  test("refuses a future timestamp just as it refuses a stale one", () => {
    const ts = String(Math.floor(NOW / 1000) + 3600);
    expect(timestampFresh(ts, NOW)).toBe(false);
  });
});

describe("verifyWebhook — accepts what it should", () => {
  test("a correctly signed transaction.completed settles to a ProviderEvent", async () => {
    const reference = buildReference("org_123", "subscription");
    const body = JSON.stringify(event(reference));
    const ts = Math.floor(NOW / 1000);

    const res = await createPaddleProvider(cfg()).verifyWebhook({
      rawBody: body,
      headers: { [PADDLE_SIGNATURE_HEADER]: sign(body, ts) },
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.event.kind).toBe("charge.succeeded");
    expect(res.event.reference).toBe(reference);
    expect(res.event.money).toEqual({ amountMinor: 1000, currency: "USD" });
    expect(res.event.metadata?.["paddleTransactionId"]).toBe("txn_01test");
  });

  test("a Buffer body verifies identically to the same text", async () => {
    const reference = buildReference("org_123", "subscription");
    const body = JSON.stringify(event(reference));
    const ts = Math.floor(NOW / 1000);

    const res = await createPaddleProvider(cfg()).verifyWebhook({
      rawBody: Buffer.from(body, "utf8"),
      headers: { [PADDLE_SIGNATURE_HEADER]: sign(body, ts) },
    });
    expect(res.ok).toBe(true);
  });
});

describe("verifyWebhook — refuses what it must", () => {
  const reference = buildReference("org_123", "subscription");
  const ts = Math.floor(NOW / 1000);

  test("no signature header at all", async () => {
    const res = await createPaddleProvider(cfg()).verifyWebhook({
      rawBody: JSON.stringify(event(reference)),
      headers: {},
    });
    expect(res).toMatchObject({ ok: false, reason: "missing_signature" });
  });

  test("a malformed header", async () => {
    const res = await createPaddleProvider(cfg()).verifyWebhook({
      rawBody: JSON.stringify(event(reference)),
      headers: { [PADDLE_SIGNATURE_HEADER]: "garbage" },
    });
    expect(res).toMatchObject({ ok: false, reason: "malformed_signature" });
  });

  test("a signature made with the wrong secret", async () => {
    const body = JSON.stringify(event(reference));
    const res = await createPaddleProvider(cfg()).verifyWebhook({
      rawBody: body,
      headers: { [PADDLE_SIGNATURE_HEADER]: sign(body, ts, "attacker_secret") },
    });
    expect(res).toMatchObject({ ok: false, reason: "digest_mismatch" });
  });

  test("a valid signature over DIFFERENT bytes", async () => {
    // The body was swapped after signing. This is the tampering case.
    const signed = JSON.stringify(event(reference));
    const swapped = JSON.stringify(event(reference, { status: "refunded" }));
    const res = await createPaddleProvider(cfg()).verifyWebhook({
      rawBody: swapped,
      headers: { [PADDLE_SIGNATURE_HEADER]: sign(signed, ts) },
    });
    expect(res).toMatchObject({ ok: false, reason: "digest_mismatch" });
  });

  test("a signature that omits the ts: prefix", async () => {
    const body = JSON.stringify(event(reference));
    const naive = createHmac("sha256", SECRET).update(body).digest("hex");
    const res = await createPaddleProvider(cfg()).verifyWebhook({
      rawBody: body,
      headers: { [PADDLE_SIGNATURE_HEADER]: `ts=${ts};h1=${naive}` },
    });
    expect(res).toMatchObject({ ok: false, reason: "digest_mismatch" });
  });

  test("a replayed event outside the tolerance window", async () => {
    const body = JSON.stringify(event(reference));
    const staleTs = Math.floor(NOW / 1000) - 7200;
    // Correctly signed, and correctly formed — but hours old.
    const res = await createPaddleProvider(cfg()).verifyWebhook({
      rawBody: body,
      headers: { [PADDLE_SIGNATURE_HEADER]: sign(body, staleTs) },
    });
    expect(res).toMatchObject({ ok: false, reason: "digest_mismatch" });
  });

  test("a correctly signed but non-JSON body", async () => {
    const body = "not json at all";
    const res = await createPaddleProvider(cfg()).verifyWebhook({
      rawBody: body,
      headers: { [PADDLE_SIGNATURE_HEADER]: sign(body, ts) },
    });
    expect(res).toMatchObject({ ok: false, reason: "malformed_body" });
  });

  test("a correctly signed event type the port does not model", async () => {
    // subscription.* is deliberately unmapped: a plan change is not a charge,
    // and crediting a wallet on one would mint money.
    const body = JSON.stringify({ ...event(reference), event_type: "subscription.updated" });
    const res = await createPaddleProvider(cfg()).verifyWebhook({
      rawBody: body,
      headers: { [PADDLE_SIGNATURE_HEADER]: sign(body, ts) },
    });
    expect(res).toMatchObject({ ok: false, reason: "unsupported_event" });
  });

  test("a correctly signed event carrying a reference we did not mint", async () => {
    // An attacker who can replay a REAL captured webhook from another tenant must
    // not be able to credit their own org with somebody else's payment.
    const body = JSON.stringify(event("org_someone_else_subscription_01HQ0000000000000000"));
    const res = await createPaddleProvider(cfg()).verifyWebhook({
      rawBody: body,
      headers: { [PADDLE_SIGNATURE_HEADER]: sign(body, ts) },
    });
    expect(res).toMatchObject({ ok: false, reason: "unsupported_event" });
  });
});

describe("event decoding", () => {
  test("maps transaction.refunded to refund.succeeded", () => {
    const e = decodePaddleEvent({ ...event(buildReference("o", "p")), event_type: "transaction.refunded" });
    expect(e?.kind).toBe("refund.succeeded");
  });

  test("refuses a payload with no items", () => {
    const r = buildReference("o", "p");
    expect(decodePaddleEvent({ event_id: "e", event_type: "transaction.completed", data: { custom_data: { reference: r } } })).toBeNull();
  });

  test("refuses a zero or non-integer amount", () => {
    const r = buildReference("o", "p");
    const base = event(r);
    const withAmount = (amount: unknown) =>
      decodePaddleEvent({
        ...base,
        data: {
          ...base.data,
          items: [{ unit_price: { amount, currency_code: "USD" } }],
        },
      });
    expect(withAmount("0")).toBeNull();
    expect(withAmount("10.5")).toBeNull();
    expect(withAmount("not a number")).toBeNull();
    // A NUMERIC amount is accepted, deliberately: `Number("1000")` and
    // `Number(1000)` are the same integer minor value and both mean $10.00, so
    // refusing the number form would reject a correct amount on a type technicality.
    // What must never pass is a non-integer — a float cannot become minor units.
    expect(withAmount(1000)).not.toBeNull();
    expect(withAmount(1000.5)).toBeNull();
  });

  test("uppercases the currency", () => {
    const e = decodePaddleEvent({
      ...event(buildReference("o", "p")),
      data: {
        ...event(buildReference("o", "p")).data,
        items: [{ unit_price: { amount: "1000", currency_code: "usd" } }],
      },
    });
    expect(e?.money.currency).toBe("USD");
  });
});

describe("references", () => {
  test("round-trips", () => {
    const r = buildReference("org_abc", "subscription");
    expect(parseReference(r)).toEqual({ orgId: "org_abc", purpose: "subscription" });
  });

  test("a reference from a client is not trusted into being ours", () => {
    expect(parseReference("../../etc/passwd")).toBeNull();
    expect(parseReference("org_a_b")).toBeNull();
    expect(parseReference("")).toBeNull();
  });

  test("an org id that sanitises to nothing is refused, not mangled", () => {
    // `buildReference("///")` must throw rather than produce `org__topup_...`,
    // which would parse as orgId="" and credit nobody.
    expect(() => buildReference("///", "subscription")).toThrow(TypeError);
  });
});

describe("price map", () => {
  test("key is lower-case currency, integer minor, interval", () => {
    expect(priceKey({ amountMinor: 1000, currency: "USD" }, "month")).toBe("usd_1000_month");
    expect(priceKey({ amountMinor: 1000, currency: "usd" }, "year")).toBe("usd_1000_year");
  });

  test("parses a well-formed map", () => {
    const m = parsePriceMap('{"usd_1000_month":"pri_01abc"}');
    expect(m).toEqual({ usd_1000_month: "pri_01abc" });
  });

  test("an absent map is empty, not an error", () => {
    expect(parsePriceMap(undefined)).toEqual({});
    expect(parsePriceMap("")).toEqual({});
  });

  test.each([
    ["not JSON", "{oops"],
    ["an array", "[]"],
    ["a non-paddle id", '{"usd_1000_month":"nope"}'],
  ])("refuses %s", (_label, raw) => {
    expect(() => parsePriceMap(raw)).toThrow();
  });
});

describe("configuration guards", () => {
  test("refuses a live key unless explicitly allowed", () => {
    const saved = process.env[PADDLE_ALLOW_LIVE_ENV];
    delete process.env[PADDLE_ALLOW_LIVE_ENV];
    try {
      expect(() => createPaddleProvider(cfg({ apiKey: "pdl_live_key" }))).toThrow(/LIVE/);
    } finally {
      if (saved === undefined) delete process.env[PADDLE_ALLOW_LIVE_ENV];
      else process.env[PADDLE_ALLOW_LIVE_ENV] = saved;
    }
  });

  test("allows a live key when the operator opts in", () => {
    const saved = process.env[PADDLE_ALLOW_LIVE_ENV];
    process.env[PADDLE_ALLOW_LIVE_ENV] = "1";
    try {
      expect(() => createPaddleProvider(cfg({ apiKey: "pdl_live_key" }))).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env[PADDLE_ALLOW_LIVE_ENV];
      else process.env[PADDLE_ALLOW_LIVE_ENV] = saved;
    }
  });

  test("refuses a key that is neither sandbox nor live", () => {
    expect(() => createPaddleProvider(cfg({ apiKey: "sk_test_whatever" }))).toThrow();
  });

  test("refuses a missing webhook secret — a provider that cannot verify is not a provider", () => {
    expect(() => createPaddleProvider(cfg({ webhookSecret: "" }))).toThrow(/PADDLE_WEBHOOK_SECRET/);
  });
});

describe("createCheckout", () => {
  const auth = () => ({
    orgId: "org_123",
    purpose: "subscription",
    money: { amountMinor: 1000, currency: "USD" },
    email: "buyer@example.com",
    requestKey: "k1",
  });

  test("throws when no configured price matches the amount", async () => {
    // The dangerous default here would be "use the first price that fits".
    const p = createPaddleProvider(cfg({ prices: {} }));
    await expect(p.createCheckout(auth())).rejects.toThrow(/no configured price matches/);
  });

  test("names the key it looked for, so the operator can fix the config", async () => {
    const p = createPaddleProvider(cfg({ prices: {} }));
    await expect(p.createCheckout(auth())).rejects.toThrow(/usd_1000_month/);
  });

  test("calls the gateway with automatic collection and our reference in custom_data", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const p = createPaddleProvider(
      cfg({
        http: async (url, init) => {
          seen = { url, init };
          return new Response(JSON.stringify({ data: { id: "txn_1", checkout: { url: "https://pay.example/x" } } }), {
            headers: { "content-type": "application/json" },
          });
        },
      }),
    );

    const session = await p.createCheckout(auth());
    expect(session.url).toBe("https://pay.example/x");
    expect(session.reference).toMatch(/^org_org_123_subscription_/);

    const body = JSON.parse(String(seen!.init.body)) as Record<string, unknown>;
    expect(body["collection_mode"]).toBe("automatic");
    expect(body["custom_data"]).toEqual({ reference: session.reference });
    expect(body["items"]).toEqual([{ price_id: "pri_01test", quantity: 1 }]);
  });

  test("refuses float money before it reaches the gateway", async () => {
    const p = createPaddleProvider(cfg());
    await expect(
      p.createCheckout({ ...auth(), money: { amountMinor: 10.5, currency: "USD" } }),
    ).rejects.toThrow(TypeError);
  });

  test("throws when the gateway returns no checkout url", async () => {
    const p = createPaddleProvider(
      cfg({ http: async () => new Response(JSON.stringify({ data: { id: "txn_1" } })) }),
    );
    await expect(p.createCheckout(auth())).rejects.toThrow(/no checkout url/);
  });
});

describe("chargeStoredAuthorization", () => {
  test("refuses rather than pretending — Paddle has no stored authorization", async () => {
    // Paddle is a Merchant of Record: no stored card auth, no vault, no way to
    // charge later. A silent success here would credit overage nobody paid for.
    const p = createPaddleProvider(cfg());
    const res = await p.chargeStoredAuthorization({
      orgId: "org_123",
      authorization: { authorizationCode: "x", email: "a@b.c" },
      money: { amountMinor: 100, currency: "USD" },
      purpose: "overage",
      requestKey: "k",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("stored_authorization_unsupported_by_paddle");
  });
});