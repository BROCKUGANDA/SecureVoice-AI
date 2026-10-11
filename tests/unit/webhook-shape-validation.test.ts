/**
 * THE INBOUND WEBHOOK VALIDATORS — one file, four boundaries, and the two
 * properties each of them exists to hold:
 *
 *   1. A vendor adding a field must not break ingest. These bodies are authored
 *      by Paddle, ElevenLabs and Twilio, not by us, so every schema is a
 *      `looseObject`: the fields we CONSUME are typed and bounded, and anything
 *      we have never seen rides along. A schema that rejected a delivery because
 *      a company we do not control shipped a new column turns their release into
 *      our outage — and for Paddle the rejected delivery is a payment.
 *   2. A field we depend on must be caught when it is malformed, and named.
 *      Which is where the discriminator soundness comes in: a KNOWN event type
 *      with a broken body may NOT be rescued by the permissive generic branch
 *      (it would be acknowledged and applied as nothing), and the reported issue
 *      must point at the field, not at the fall-through.
 *
 *   3. For Twilio specifically, the shape check runs AFTER the signature. Once
 *      the signature is proven, requiring an identifier would make this module
 *      the thing that decides whether a customer's YES/NO answer is allowed to
 *      resolve a fraud case — and it would be wrong to: `handleSmsReply` needs
 *      `From` and `Body`, nothing else. Provenance is the signature's job. The
 *      schema therefore bounds recognised fields and requires no key at all.
 *      These tests pin both halves: a bare `{From, Body}` passes, and a
 *      recognised field that is not what it claims to be does not.
 */
import { describe, expect, test } from "bun:test";
import {
  isKnownPaddleEvent,
  KNOWN_PADDLE_EVENT_TYPES,
  validateBankWebhook,
  validateElevenLabsWebhook,
  validatePaddleWebhook,
  validateTwilioWebhook,
} from "@/lib/validation/webhook-schema";

// ── Twilio ──────────────────────────────────────────────────────────────────

describe("twilio: a signature-proven reply is never refused for lacking a key", () => {
  test("the minimum the reply handler consumes: From and Body, no sid, no AccountSid", () => {
    const res = validateTwilioWebhook({ From: "+971501234567", Body: "NO" });
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (res.ok) expect(res.event.Body).toBe("NO");
  });

  test("a full inbound-SMS bag validates, including keys this schema has never seen", () => {
    const res = validateTwilioWebhook({
      AccountSid: "ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ApiVersion: "2010-04-01",
      Body: "yes it was me",
      From: "+971501234567",
      MessageSid: "SMbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      MessagingServiceSid: "MGcccccccccccccccccccccccccccccccc",
      NumMedia: "0",
      NumSegments: "1",
      To: "+971800123456",
      // Twilio adding a column is the case this file exists to survive.
      FromCity: "Dubai",
      Direction: "inbound-not-a-declared-type",
    });
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
  });

  test("an alphanumeric sender id is a legitimate From, not a malformed phone", () => {
    expect(validateTwilioWebhook({ From: "SecureVoice", Body: "STOP" }).ok).toBe(true);
  });

  test("NumMedia is read from the wire format as an integer", () => {
    // form-urlencoded has no number type, so `NumMedia=2` IS two. This is the
    // one coercion in the file, and it belongs to the format, not to a caller
    // who sent a string where a number belonged.
    const res = validateTwilioWebhook({ MessageSid: "SM1x", NumMedia: "2", NumSegments: "3" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.event.NumMedia).toBe(2);
      expect(res.event.NumSegments).toBe(3);
    }
  });

  test("all three ways a route can hand over form parameters are accepted", () => {
    const params = { From: "+971501234567", Body: "no", MessageSid: "SM1x" };
    expect(validateTwilioWebhook(params).ok).toBe(true);

    const usp = new URLSearchParams(params);
    expect(validateTwilioWebhook(usp).ok).toBe(true);

    const fd = new FormData();
    for (const [k, v] of Object.entries(params)) fd.append(k, v);
    expect(validateTwilioWebhook(fd).ok).toBe(true);
  });

  test("a FormData carrying a file is not a parameter bag", () => {
    // Inbound MMS arrives as form fields plus a media part. The route that
    // wanted strings did not get them, and guessing here would be a second
    // normalisation of the same payload.
    const fd = new FormData();
    fd.append("Body", "photo");
    fd.append("MediaUrl0", "https://api.twilio.com/x");
    fd.append("Media0", new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }));
    const res = validateTwilioWebhook(fd);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("form parameters");
  });

  test("anything that is not a flat string bag is refused rather than coerced", () => {
    for (const bad of [null, undefined, "From=%2B9715", 42, [], [{ Body: "no" }]]) {
      expect(validateTwilioWebhook(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    // A JSON body with a number where the wire format says string was built in
    // code, not sent by Twilio.
    expect(validateTwilioWebhook({ Body: "no", NumMedia: 2 }).ok).toBe(false);
  });

  test("a recognised field that lies about its type is caught and NAMED", () => {
    const cases: [string, Record<string, string>][] = [
      ["NumMedia is not a decimal integer", { MessageSid: "SM1x", NumMedia: "two" }],
      ["NumMedia out of range", { MessageSid: "SM1x", NumMedia: "999999" }],
      ["ErrorCode out of range", { MessageSid: "SM1x", ErrorCode: "99999999" }],
      ["Body past the bound", { MessageSid: "SM1x", Body: "x".repeat(4_097) }],
      ["MediaUrl0 past the bound", { MessageSid: "SM1x", MediaUrl0: "h".repeat(5_000) }],
      ["an id carrying a space", { AccountSid: "AC one" }],
      ["a one-character vendor id", { AccountSid: "A" }],
      ["Status past the bound", { MessageSid: "SM1x", Status: "s".repeat(40) }],
    ];
    for (const [label, params] of cases) {
      const res = validateTwilioWebhook(params);
      expect(res.ok, label).toBe(false);
      if (!res.ok) {
        expect(res.error, label).toContain("twilio");
        // The whole point of `issues` is a log line that names the column.
        expect(res.issues.length, label).toBeGreaterThan(0);
        expect(res.issues[0]!.path.length, label).toBeGreaterThan(0);
      }
    }
  });

  test("an oversized Body fails on the field, not on the structural preflight", () => {
    // WEBHOOK_LIMITS allows 8 MiB of characters, so a 5 kB Body must reach the
    // schema. If the preflight ever ate it, the issue path would be empty.
    const res = validateTwilioWebhook({ MessageSid: "SM1x", Body: "a".repeat(5_000) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.map((i) => i.path)).toContain("Body");
  });

  test("an unknown key with a hostile name cannot smuggle a second Body", () => {
    const res = validateTwilioWebhook({ MessageSid: "SM1x", Body: "no", "Body ": "YES" });
    expect(res.ok).toBe(true);
    // `looseObject` keeps the unknown key out of the typed surface; the handler
    // reads `Body`, so the trailing-space variant is inert data.
    if (res.ok) expect(res.event.Body).toBe("no");
  });
});

// ── Paddle ──────────────────────────────────────────────────────────────────

describe("paddle: permissive about new fields, strict about the ones that move money", () => {
  const completed = {
    event_id: "evt_01aaaaaaaaaaaaaaaaaaaaaaaaa",
    event_type: "transaction.completed",
    occurred_at: "2026-10-11T09:00:00+00:00",
    notification_id: "ntf_01aaaaaaaaaaaaaaaaaaaaaaaa",
    data: {
      id: "txn_01aaaaaaaaaaaaaaaaaaaaaaaa",
      status: "completed",
      customer_id: "ct_01aaaaaaaaaaaaaaaaaaaaaaaa",
      subscription_id: null,
      currency_code: "USD",
      billed_at: "2026-10-11T09:00:00+00:00",
      custom_data: { reference: "org_abc123_REF1_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567" },
      items: [{ price_id: "pri_1", quantity: 1, unit_price: { amount: "9900", currency_code: "USD" } }],
    },
  };

  test("a real transaction.completed validates and is recognised", () => {
    const res = validatePaddleWebhook(completed);
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (res.ok) expect(isKnownPaddleEvent(res.event)).toBe(true);
  });

  test("a field Paddle added yesterday does not break ingest", () => {
    const res = validatePaddleWebhook({
      ...completed,
      data: { ...completed.data, checkout: { url: "https://checkout.paddle.com/x" } },
      new_envelope_field: { deep: [1, 2, 3] },
    });
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
  });

  test("a KNOWN event type with a broken body cannot fall through to the generic branch", () => {
    // This is the soundness claim of the whole file: the generic branch refines
    // its event_type to EXCLUDE the known set. If it did not, a
    // `transaction.completed` whose `items` are malformed would be acknowledged
    // as an unhandled event and the payment would never settle.
    const broken = structuredClone(completed);
    broken.data.items = [{ unit_price: { amount: "not-a-number", currency_code: "USD" } }];

    const res = validatePaddleWebhook(broken);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("the generic branch rescued a money event");
    expect(res.error).toContain("paddle");
    expect(res.issues.map((i) => i.path)).toContain("data.items.0.unit_price.amount");
  });

  test("the money field is an integer STRING of minor units and is not float-parsed", () => {
    const res = validatePaddleWebhook(completed);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const item = (res.event as { data: { items?: { unit_price?: { amount?: unknown } }[] } }).data
        .items?.[0];
      expect(item?.unit_price?.amount).toBe("9900");
      expect(typeof item?.unit_price?.amount).toBe("string");
    }
  });

  test("an event type we do not handle is accepted generically, with its data intact", () => {
    const res = validatePaddleWebhook({
      event_id: "evt_02bbbbbbbbbbbbbbbbbbbbbbbbb",
      event_type: "payment_failed",
      occurred_at: "2026-10-11T09:00:00+00:00",
      data: { something: { we: "have not modelled" } },
    });
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (res.ok) expect(isKnownPaddleEvent(res.event)).toBe(false);
  });

  test("a money event missing its id is refused, and the generic branch cannot rescue it", () => {
    // Two guards in one case. `data.id` is required by the transaction branch;
    // `{}` is a perfectly valid `opaqueRecord` for the generic branch. If the
    // dispatcher ever fell back on failure — or the generic's event_type refine
    // were dropped — this body would be acknowledged as an unhandled event and
    // the payment would never settle.
    const res = validatePaddleWebhook({
      event_id: "evt_03ccccccccccccccccccccccccc",
      event_type: "transaction.completed",
      occurred_at: "2026-10-11T09:00:00+00:00",
      data: {},
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("a transaction with no id was accepted");
    expect(res.issues.map((i) => i.path)).toContain("data.id");
  });

  test("the known set is the same list the fulfilment layer switches on", () => {
    // Drift here is how a new money event gets silently generic-accepted.
    expect(KNOWN_PADDLE_EVENT_TYPES).toContain("transaction.completed");
    expect(KNOWN_PADDLE_EVENT_TYPES).toContain("subscription.canceled");
    expect(KNOWN_PADDLE_EVENT_TYPES.length).toBeGreaterThanOrEqual(6);
  });

  test("a missing tenancy reference still validates — the route owns that decision", () => {
    // The webhook route must answer 200 for a delivery that is not ours, so this
    // is deliberately not a schema failure: absence is a routing fact, not a
    // malformed field.
    const noRef = structuredClone(completed);
    delete noRef.data.custom_data;
    expect(validatePaddleWebhook(noRef).ok).toBe(true);
  });
});

// ── ElevenLabs ──────────────────────────────────────────────────────────────

describe("elevenlabs: the discriminator reports the field that failed", () => {
  const transcription = {
    type: "post_call_transcription",
    event_timestamp: 1_760_000_000,
    data: {
      agent_id: "agent_1",
      conversation_id: "conv_01aaaaaaaaaaaaaaaaaaaaaaaa",
      status: "completed",
      transcript: [
        { role: "user", message: "who is this", time_in_call_secs: 0.8 },
        { role: "agent", message: "This is an automated voice assistant.", time_in_call_secs: 11.4 },
      ],
    },
  };

  test("fractional turn offsets are valid — they are what the wire carries", () => {
    // Declaring time_in_call_secs as an integer rejects essentially every real
    // payload, and the case never closes.
    const res = validateElevenLabsWebhook(transcription);
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
  });

  test("a known type with one bad field names that field, not the fall-through", () => {
    const broken = structuredClone(transcription);
    broken.data.transcript[1] = { role: "agent", time_in_call_secs: 999_999_999 } as never;

    const res = validateElevenLabsWebhook(broken);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("accepted an out-of-range turn offset");
    expect(res.issues.map((i) => i.path)).toContain("data.transcript.1.time_in_call_secs");
    expect(res.issues.some((i) => i.message.includes("its own schema")), JSON.stringify(res.issues)).toBe(
      false,
    );
  });

  test("an unrecognised event family is accepted generically", () => {
    const res = validateElevenLabsWebhook({
      type: "recording_ready",
      data: { url: "https://api.elevenlabs.io/v1/recordings/conv_1" },
    });
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
  });

  test("a missing event_timestamp is tolerated, not coerced", () => {
    // The ingest stores null there; making it required would 422 a delivery the
    // pipeline has always accepted.
    const { event_timestamp: _dropped, ...rest } = transcription;
    expect(validateElevenLabsWebhook(rest).ok).toBe(true);
  });

  test("post_call_audio accepts both spellings of the recording", () => {
    for (const key of ["full_audio", "audio_base64"] as const) {
      const res = validateElevenLabsWebhook({
        type: "post_call_audio",
        data: { agent_id: "agent_1", conversation_id: "conv_1x", [key]: "AAAA" },
      });
      expect(res.ok, key).toBe(true);
    }
  });
});

// ── The event WE sign and a bank consumes ───────────────────────────────────

describe("bank: the only body whose shape is entirely ours is the strictest", () => {
  const event = {
    schema_version: "2026-10-01",
    event_id: "evt_01aaaaaaaaaaaaaaaaaaaaaaaaa",
    event_type: "case.confirmed",
    case_ref: "SV-A-123",
    org_id: "org_1",
    occurred_at: "2026-10-11T09:00:00.000Z",
    data: { state: "CONFIRMED_FRAUD" },
  };

  test("a well-formed event validates", () => {
    const res = validateBankWebhook(event);
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
  });

  test("a missing event_id is refused — it is the receiver's unique column", () => {
    // `String(parsed.event_id ?? "")` used to collapse two id-less deliveries
    // onto "", the first occupying the slot and the second surfacing as a 500.
    const noId = { ...event };
    delete (noId as Partial<typeof noId>).event_id;
    const res = validateBankWebhook(noId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.map((i) => i.path)).toContain("event_id");
  });

  test("an empty event_id is refused too", () => {
    const res = validateBankWebhook({ ...event, event_id: "" });
    expect(res.ok).toBe(false);
  });

  test("the version is a DATE, so an integer is a contract break", () => {
    // `SCHEMA_VERSION` in src/lib/outbox.ts is "2026-10-01". A bank reading an
    // integer as a counter would expect increments it never gets.
    expect(validateBankWebhook({ ...event, schema_version: 20261001 }).ok).toBe(false);
    expect(validateBankWebhook({ ...event, schema_version: "v1" }).ok).toBe(false);
  });

  test("event_type is lower-case dotted data, not a free-form label", () => {
    expect(validateBankWebhook({ ...event, event_type: "Case Confirmed" }).ok).toBe(false);
  });

  test("null case_ref is allowed: an org-level event has no case", () => {
    expect(validateBankWebhook({ ...event, case_ref: null }).ok).toBe(true);
  });
});
