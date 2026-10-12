import "server-only";

/**
 * Inbound webhook validation — the three vendors that call us, one file.
 *
 * Paddle (money), ElevenLabs (the conversation plane) and Twilio (telephony)
 * all POST us JSON or form-encoded data that we did not author and do not
 * control. Each of those bodies is untrusted the moment it arrives, and the
 * route handler is the single choke point where it becomes trusted. This module
 * is that choke point, and it is the ONLY place the wire shapes of the three
 * vendors are declared.
 *
 * ── Why this is looser than ./schema.ts, on purpose ──────────────────────────
 *
 * `./schema.ts` rejects unknown keys, because there the payload is OURS: the
 * bank ingest body is a contract we wrote, so a field we did not expect is a
 * caller bug worth failing closed on.
 *
 * A vendor payload is the opposite. Paddle adds fields to a transaction, an
 * ElevenLabs post-call payload gains an analysis key, Twilio starts sending
 * `FromCity`. A schema that refuses the whole delivery because a company we do
 * not control shipped a new column would turn their release into our outage —
 * and a rejected Paddle delivery is a payment Paddle is told to stop retrying.
 *
 * So the rule here is inverted: **validate the fields we consume, tolerate the
 * ones we do not.** Every field this system reads (`event_id`, `occurred_at`,
 * `data.items[].unit_price.amount`, `data.conversation_id`, `NumMedia`, …) is
 * typed and bounded; unknown keys ride along untouched. What that buys is
 * exactly what is needed: a malformed field we depend on is caught and named,
 * while a new field we have never seen cannot break the ingest.
 *
 * The one thing that stays strict is the DISCRIMINATOR. A `transaction.completed`
 * body must satisfy the transaction schema — it cannot fall through to the
 * generic branch just because its `items` are malformed. The generic branch
 * explicitly excludes the handled event types, so a known event with a broken
 * body is a failure, not a silent pass (see `paddleGeneric` / `elevenLabsGeneric`).
 *
 * ── No coercion ──────────────────────────────────────────────────────────────
 *
 * A JSON body that sends `"amount": 9900` where we expect `"9900"` is a caller
 * mistake and is reported as one. The single deliberate exception is Twilio,
 * where the wire format is `application/x-www-form-urlencoded` and EVERY value
 * is a string by construction — decoding `NumMedia=2` to the integer 2 there is
 * reading the format, not coercing a number. That is `formInt()` below, and it
 * is used only for Twilio.
 *
 * ── Timestamps ───────────────────────────────────────────────────────────────
 *
 * Paddle timestamps carry an offset and are normalised to UTC by `isoTimestamp`
 * (from ./schema.ts). ElevenLabs sends unix SECONDS, as a number or a numeric
 * string, and both forms are accepted without a clock assumption.
 */

import { z } from "zod";
import {
  assertShape,
  boundedInt,
  boundedNumber,
  boundedString,
  currency,
  isoTimestamp,
  type Limits,
} from "./schema";

// ── Result shape ────────────────────────────────────────────────────────────

/** One failed field, named by path so a log line points at the column. */
export type WebhookIssue = { path: string; message: string };

/**
 * A validation outcome. Deliberately a value, not a throw: a webhook route has
 * to choose a status code and a log line per failure, and a thrown error is a
 * control-flow fork that a `catch (e) {}` can silently swallow — which for a
 * payment webhook means a delivery acknowledged but never applied.
 */
export type WebhookValidation<T> =
  { ok: true; event: T } | { ok: false; error: string; issues: WebhookIssue[] };

/**
 * Structural caps for a vendor body.
 *
 * Far looser than `LIMITS` in ./schema.ts, and deliberately so: a Paddle
 * transaction nests price, product and tax objects, and an ElevenLabs post-call
 * payload carries a full transcript with one object per turn. The app's own
 * ingest can afford a 64-field cap because the shape is ours; a vendor's cannot.
 * The cap still bounds the walk — which is the whole reason the preflight runs
 * before any schema, so a hostile 40-deep payload cannot be used to blow the
 * stack or allocate an issue list.
 *
 * ── `maxStringLength` is the one that actually bites, and it was wrong ─────────
 * `assertShape` reads `maxStringLength`, `maxDepth`, `maxFields` and
 * `maxArrayItems`. It does NOT read `maxBodyBytes` — that key is only consulted
 * by `readJsonBody`, which measures raw bytes before parsing, and `validate*`
 * here is handed an already-parsed object. So the 1 MiB figure below was inert
 * documentation, and the real bound on a single string was 100_000 characters.
 *
 * That was fine for a transcript and wrong for `post_call_audio`: an inline
 * base64 recording is ~1.37 characters per byte, so a 3 MB call recording is
 * over 4 million characters and was rejected as `string_too_long` in the
 * preflight — before its own schema got a chance to run, and reported as a
 * malformed payload rather than as the size limit it actually hit. The ingest
 * route could not have recovered from that by loosening its own schema.
 *
 * 8 MiB of characters is the cap now: comfortably more than a long recording,
 * and still a bound. The genuine DoS limit remains the route's raw-byte check on
 * the request body, which happens before this function is reached at all.
 */
const WEBHOOK_LIMITS: Limits = {
  maxDepth: 16,
  maxFields: 5_000,
  maxArrayItems: 2_000,
  maxStringLength: 8 * 1024 * 1024,
};

/** Preflight (structural caps) first, then the schema. Never throws. */
function run<T>(schema: z.ZodType<T>, raw: unknown, label: string): WebhookValidation<T> {
  try {
    assertShape(raw, WEBHOOK_LIMITS);
  } catch (err) {
    return {
      ok: false,
      error: `${label}: ${err instanceof Error ? err.message : "malformed payload"}`,
      issues: [],
    };
  }

  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, event: parsed.data };

  return {
    ok: false,
    error: `${label}: ${parsed.error.issues.length} field(s) failed validation`,
    // The first few only: a 400-issue dump is noise in a log and useless to a
    // human reading it at 3am. The count above carries the magnitude.
    issues: parsed.error.issues.slice(0, 20).map((i) => ({
      path: i.path.map(String).join("."),
      message: i.message,
    })),
  };
}

// ── Shared field builders ───────────────────────────────────────────────────

/**
 * An opaque vendor id (`evt_…`, `txn_…`, `ntf_…`, `CA…`). Bounded and
 * charset-limited rather than prefix-matched: the prefix is a vendor convention
 * that has changed before, and the integrity we actually need is "a short,
 * safe identifier", not "a string that starts with the three letters we saw".
 */
function vendorId(max = 64) {
  return boundedString({ min: 2, max, pattern: /^[A-Za-z0-9_:-]+$/ });
}

/** An arbitrary provider sub-object we do not model (metadata, analysis, …). */
const opaqueRecord = z.record(z.string(), z.unknown());

// ── Paddle ──────────────────────────────────────────────────────────────────

/**
 * The event types this system fulfils on. Mirrors `PaddleEventKind` in
 * `src/lib/payments/paddle-events.ts` — kept as data here so the discriminator
 * and the generic fallback cannot drift apart.
 */
export const KNOWN_PADDLE_EVENT_TYPES = [
  "transaction.completed",
  "subscription.created",
  "subscription.updated",
  "subscription.canceled",
  // Mirrored by the fulfilment layer, so they are declared here too: an event
  // type the dispatcher does not know falls to the generic branch and is
  // acknowledged as "seen, not ours", which is exactly how a tenant's billing
  // state stops being current while every log says the delivery was fine.
  "subscription.past_due",
  "subscription.paused",
  "subscription.resumed",
  "customer.created",
  "customer.updated",
] as const;

export type KnownPaddleEventType = (typeof KNOWN_PADDLE_EVENT_TYPES)[number];

const PADDLE_EVENT_TYPE_RE = /^[a-z][a-z0-9_.]{2,63}$/;

const paddleEventId = vendorId(64);
const paddleNotificationId = vendorId(64);

/**
 * Paddle money. `amount` is an INTEGER STRING of minor units on the wire
 * (`"9900"` for $99.00) — it is kept a string, not parsed to a number, so the
 * caller decides when to convert and there is no float in the validation path.
 */
const paddleUnitPrice = z.looseObject({
  amount: boundedString({ min: 1, max: 32, pattern: /^\d{1,18}$/ }),
  currency_code: currency(),
});

/** One line item, as it appears on a transaction OR a subscription. */
const paddleItem = z.looseObject({
  price_id: vendorId(64).optional(),
  quantity: boundedInt({ min: 1, max: 1_000_000 }).optional(),
  unit_price: paddleUnitPrice.optional(),
  price: z
    .looseObject({
      id: vendorId(64),
      product_id: vendorId(64).optional(),
    })
    .optional(),
  product: z.looseObject({ id: vendorId(64) }).optional(),
});

/** Our own tenancy, carried back to us in `custom_data.reference`. */
const paddleCustomData = z.looseObject({
  reference: boundedString({ min: 1, max: 128 }).optional(),
});

const paddleTransactionData = z.looseObject({
  id: vendorId(64),
  status: boundedString({ min: 1, max: 32 }).optional(),
  customer_id: vendorId(64).optional(),
  subscription_id: vendorId(64).nullable().optional(),
  currency_code: currency().optional(),
  items: z.array(paddleItem).max(200).optional(),
  custom_data: paddleCustomData.nullable().optional(),
  billed_at: isoTimestamp().nullable().optional(),
  created_at: isoTimestamp().optional(),
  origin: boundedString({ min: 1, max: 32 }).optional(),
});

const paddleSubscriptionData = z.looseObject({
  id: vendorId(64),
  status: boundedString({ min: 1, max: 32 }),
  customer_id: vendorId(64).optional(),
  items: z.array(paddleItem).max(200).optional(),
  current_billing_period: z
    .looseObject({
      starts_at: isoTimestamp().optional(),
      ends_at: isoTimestamp().optional(),
    })
    .nullable()
    .optional(),
  scheduled_change: z
    .looseObject({
      action: boundedString({ min: 1, max: 32 }),
      effective_at: isoTimestamp().optional(),
    })
    .nullable()
    .optional(),
  custom_data: paddleCustomData.nullable().optional(),
  created_at: isoTimestamp().optional(),
});

const paddleCustomerData = z.looseObject({
  id: vendorId(64),
  status: boundedString({ min: 1, max: 32 }).optional(),
  // A permissive shape check, not RFC 5322. The point is to catch a name that
  // landed in the email column, not to adjudicate deliverability.
  email: boundedString({ max: 320, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ }).optional(),
  name: boundedString({ max: 200 }).nullable().optional(),
});

/** The envelope, with a specific `data` shape pinned to its `event_type`. */
function paddleEnvelope<T extends z.ZodType>(eventType: KnownPaddleEventType, data: T) {
  return z.looseObject({
    event_id: paddleEventId,
    event_type: z.literal(eventType),
    occurred_at: isoTimestamp(),
    notification_id: paddleNotificationId.optional(),
    data,
  });
}

const paddleKnown = z.discriminatedUnion("event_type", [
  paddleEnvelope("transaction.completed", paddleTransactionData),
  paddleEnvelope("subscription.created", paddleSubscriptionData),
  paddleEnvelope("subscription.updated", paddleSubscriptionData),
  paddleEnvelope("subscription.canceled", paddleSubscriptionData),
  // The three lifecycle states the dial gate reads. Declared here as well as in
  // `KNOWN_PADDLE_EVENT_TYPES`: adding them only to that list would make the
  // generic branch refuse them while the discriminated union has no branch to
  // accept them, so a real `subscription.paused` delivery 400s and Paddle retries
  // it forever — the tenant never appears paused, and the dialler keeps calling.
  paddleEnvelope("subscription.past_due", paddleSubscriptionData),
  paddleEnvelope("subscription.paused", paddleSubscriptionData),
  paddleEnvelope("subscription.resumed", paddleSubscriptionData),
  paddleEnvelope("customer.created", paddleCustomerData),
  paddleEnvelope("customer.updated", paddleCustomerData),
]);

/**
 * The fallback for an event type we do not handle.
 *
 * `event_type` is refined to EXCLUDE the known set, which is what makes the
 * union sound: a `transaction.completed` whose `items` are malformed fails its
 * own branch and cannot be rescued here, because this branch refuses to accept
 * that type at all.
 */
const paddleGeneric = z.looseObject({
  event_id: paddleEventId,
  event_type: boundedString({ min: 3, max: 64, pattern: PADDLE_EVENT_TYPE_RE }).refine(
    (t) => !(KNOWN_PADDLE_EVENT_TYPES as readonly string[]).includes(t),
    "a handled event type must satisfy its own schema",
  ),
  occurred_at: isoTimestamp(),
  notification_id: paddleNotificationId.optional(),
  data: opaqueRecord,
});

/**
 * Dispatch on `event_type` rather than `z.union`, for the reason the ElevenLabs
 * schema below documents: a union reports every branch's failure, and a
 * `transaction.completed` with a malformed `unit_price.amount` then surfaces the
 * generic branch's refine ("a handled event type must satisfy its own schema")
 * or an empty root path instead of the field that actually failed. For the one
 * boundary where a rejected delivery is a payment, a log line that cannot name
 * the column is the difference between a fix and a guess.
 *
 * The soundness rule is unchanged — a known type still cannot be accepted
 * generically — and `paddleKnown` is a discriminated union, so the branch that
 * matches the discriminator is the branch whose issues are reported.
 */
export type PaddleWebhookEvent = z.infer<typeof paddleKnown> | z.infer<typeof paddleGeneric>;

export const paddleWebhookSchema = z.unknown().superRefine((raw, ctx) => {
  const eventType =
    raw && typeof raw === "object" ? (raw as { event_type?: unknown }).event_type : undefined;

  const report = (result: {
    success: boolean;
    error?: { issues: readonly { path: PropertyKey[]; message: string }[] };
  }) => {
    for (const issue of (result.error?.issues ?? []).slice(0, 20)) {
      ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
  };

  if (
    typeof eventType === "string" &&
    (KNOWN_PADDLE_EVENT_TYPES as readonly string[]).includes(eventType)
  ) {
    report(paddleKnown.safeParse(raw));
    return;
  }
  report(paddleGeneric.safeParse(raw));
});

/** Narrow a validated event to one whose body we actually model. */
export function isKnownPaddleEvent(
  event: PaddleWebhookEvent,
): event is Extract<PaddleWebhookEvent, { event_type: KnownPaddleEventType }> {
  return (KNOWN_PADDLE_EVENT_TYPES as readonly string[]).includes(event.event_type);
}

// ── ElevenLabs ──────────────────────────────────────────────────────────────

/**
 * The post-call webhook event types the conversation plane emits. Everything
 * else (a future event family) is accepted generically.
 */
export const KNOWN_ELEVENLABS_EVENT_TYPES = [
  "post_call_transcription",
  "call_initiation_failure",
  "post_call_audio",
] as const;

export type KnownElevenLabsEventType = (typeof KNOWN_ELEVENLABS_EVENT_TYPES)[number];

/**
 * Unix SECONDS. ElevenLabs sends this as a number in the signed body and as a
 * numeric string in some SDK-reconstructed forms, so both are accepted. No
 * multiplication, no timezone: the value is what the vendor says it is.
 */
const unixSeconds = z.union([
  boundedInt({ min: 0, max: 4_102_444_800 }), // through the year 2100
  boundedString({ min: 1, max: 13, pattern: /^\d+$/ }),
]);

const elevenLabsTranscriptTurn = z.looseObject({
  role: boundedString({ min: 1, max: 32 }),
  message: boundedString({ max: 100_000 }).nullable().optional(),
  /**
   * A FRACTION, not an integer.
   *
   * ElevenLabs offsets a turn from the start of the call, and the first turn of
   * a real conversation lands well under one second in — the
   * `transcript-artifact.test.ts` fixture carries `0.8`, `11.4` and `19.7`.
   * Declaring this as an integer (which it was, unwired) rejects essentially
   * every genuine `post_call_transcription` payload: the moment one turn carries
   * a fractional offset the whole event fails validation, and the case never
   * closes. The bounds still apply — a timestamp inside a phone call is
   * sub-month, and NaN/Infinity are excluded by the preflight walk.
   */
  time_in_call_secs: boundedNumber({ min: 0, max: 86_400 * 30 }).optional(),
  agent_metadata: opaqueRecord.nullable().optional(),
  tool_calls: z.array(opaqueRecord).max(200).nullable().optional(),
});

const elevenLabsConversationData = z.looseObject({
  agent_id: vendorId(64),
  conversation_id: vendorId(64),
  status: boundedString({ min: 1, max: 32 }).optional(),
  transcript: z.array(elevenLabsTranscriptTurn).max(2_000).optional(),
  metadata: opaqueRecord.nullable().optional(),
  analysis: opaqueRecord.nullable().optional(),
  has_audio: z.boolean().optional(),
  user_id: boundedString({ max: 128 }).nullable().optional(),
  conversation_initiation_client_data: opaqueRecord.nullable().optional(),
});

const elevenLabsFailureData = z.looseObject({
  agent_id: vendorId(64),
  conversation_id: vendorId(64).optional(),
  failure_reason: boundedString({ max: 512 }).optional(),
  metadata: opaqueRecord.nullable().optional(),
});

/**
 * `post_call_audio` carries the recording in one of two spellings, and both are
 * declared because the codebase is inconsistent about which one arrives:
 *
 *   · `full_audio` is what the consumer reads. `handleAudio` in
 *     src/lib/elevenlabs/inbound.ts computes `approxAudioBytes` from
 *     `typeof data?.full_audio === "string"` (inbound.ts:511) and is the only
 *     place the recording's size is ever recorded.
 *   · `audio_base64` was what this schema originally declared, and nothing read
 *     it.
 *
 * Because the envelope is a `looseObject` an undeclared field is silently
 * accepted either way, so the disagreement was invisible: a payload carrying
 * only `audio_base64` validated cleanly and then produced a null size at the
 * consumer, and one carrying only `full_audio` validated cleanly for the same
 * reason. Declaring both makes the accepted surface explicit rather than
 * accidental. `full_audio` is the one that works.
 */
const elevenLabsAudioData = z.looseObject({
  agent_id: vendorId(64),
  conversation_id: vendorId(64),
  /** Read by handleAudio. Bounded so a hostile payload cannot size the heap. */
  full_audio: boundedString({ max: 8 * 1024 * 1024 }).optional(),
  /** The other spelling ElevenLabs has used. Accepted; see above. */
  audio_base64: boundedString({ max: 8 * 1024 * 1024 }).optional(),
  media_type: boundedString({ max: 64 }).optional(),
});

function elevenLabsEnvelope<T extends z.ZodType>(type: KnownElevenLabsEventType, data: T) {
  return z.looseObject({
    type: z.literal(type),
    // OPTIONAL, deliberately. `WebhookEvent.eventTimestamp` is nullable and the
    // ingest route stores a missing timestamp as null rather than coercing it —
    // pinned by "a missing event_timestamp is stored as null rather than NaN" in
    // tests/webhooks/elevenlabs-inbound.test.ts. Making this required would turn
    // a tolerated absence into a 422 and reject a delivery the pipeline has
    // always accepted. The dedupe key tolerates a null here for the same reason:
    // Postgres treats NULLs as distinct in a unique index, so the row is stored
    // and the conversation id still carries the correlation.
    event_timestamp: unixSeconds.optional(),
    data,
  });
}

const elevenLabsKnown = z.discriminatedUnion("type", [
  elevenLabsEnvelope("post_call_transcription", elevenLabsConversationData),
  elevenLabsEnvelope("call_initiation_failure", elevenLabsFailureData),
  elevenLabsEnvelope("post_call_audio", elevenLabsAudioData),
]);

/** Same soundness rule as Paddle: a known type cannot fall through here. */
const elevenLabsGeneric = z.looseObject({
  type: boundedString({ min: 3, max: 64, pattern: /^[a-z][a-z0-9_.]{2,63}$/ }).refine(
    (t) => !(KNOWN_ELEVENLABS_EVENT_TYPES as readonly string[]).includes(t),
    "a handled event type must satisfy its own schema",
  ),
  event_timestamp: unixSeconds.optional(),
  data: opaqueRecord,
});

/**
 * `z.union` reports EVERY branch's failure, and the generic branch is the last
 * one, so a KNOWN event type that fails its own schema surfaces the generic's
 * refine — "a handled event type must satisfy its own schema" — which describes
 * the fall-through rather than the cause. That is how the `time_in_call_secs`
 * float below spent its first hour unreproducible: the report said the payload
 * was the wrong KIND when it was in fact the right kind with one field out of
 * range.
 *
 * Dispatching on `type` instead fixes it: when the type is one of ours, the
 * issues reported are that branch's own. Everything else falls through to the
 * permissive generic, which is the posture this file takes for a vendor body.
 * The soundness rule is unchanged — a known type still cannot be accepted
 * generically — but the error now names the field that actually failed.
 *
 * The exported type is declared rather than inferred: a `superRefine` pipeline
 * infers as `unknown`, which would silently erase the shape every caller is
 * supposed to be reading.
 */
export type ElevenLabsWebhookEvent =
  z.infer<typeof elevenLabsKnown> | z.infer<typeof elevenLabsGeneric>;

// A `superRefine` pipeline is a validator, so its inferred OUTPUT stays `unknown`
// however it is annotated — Zod v4 will not narrow it. The declared type above
// is therefore applied at the entry point instead, which is the one place a
// caller can observe it. Safe because the dispatcher returns without transforming:
// on success `raw` IS one of the two branch types, which is what it validated as.
export const elevenLabsWebhookSchema = z.unknown().superRefine((raw, ctx) => {
  const report = (result: {
    success: boolean;
    error?: { issues: readonly { path: PropertyKey[]; message: string }[] };
  }) => {
    for (const issue of (result.error?.issues ?? []).slice(0, 20)) {
      ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
  };

  const type = raw && typeof raw === "object" ? (raw as { type?: unknown }).type : undefined;

  if (
    typeof type === "string" &&
    (KNOWN_ELEVENLABS_EVENT_TYPES as readonly string[]).includes(type)
  ) {
    report(elevenLabsKnown.safeParse(raw));
    return;
  }
  report(elevenLabsGeneric.safeParse(raw));
});

// ── Twilio ──────────────────────────────────────────────────────────────────

/**
 * Decode a form field that the wire format guarantees is a string but the
 * domain says is an integer. This is the ONE place a coercion is correct: in
 * `application/x-www-form-urlencoded` there is no number type, so `NumMedia=2`
 * is a two, not a caller who sent a string where a number belonged.
 *
 * Bounds are applied BEFORE the transform, so an out-of-range value is reported
 * against the string that actually arrived.
 */
function formInt(opts: { min?: number; max?: number } = {}) {
  return z
    .string()
    .regex(/^\d+$/, "must be a decimal integer")
    .refine(
      (s) => {
        const n = Number(s);
        return (
          Number.isSafeInteger(n) &&
          (opts.min === undefined || n >= opts.min) &&
          (opts.max === undefined || n <= opts.max)
        );
      },
      { message: "out of range" },
    )
    .transform((s) => Number(s));
}

/**
 * A Twilio webhook, form-encoded.
 *
 * One schema for all three shapes Twilio posts us — inbound SMS, a delivery
 * status callback, and an inbound voice turn — because Twilio sends one flat
 * parameter bag and selects the meaning by which keys are present.
 *
 * NOTHING IS REQUIRED, and that is the doctrine of this file applied honestly
 * rather than an oversight: "validate the fields we consume, tolerate the ones
 * we do not". The reply handlers consume `From` and `Body`; the status callback
 * consumes `Status`/`ErrorCode`. An identifier is present in every real Twilio
 * delivery, but requiring one here would put this schema in the business of
 * deciding whether a signature-proven customer answer is allowed to resolve a
 * case — and a refusal on a form post Twilio signed is a reply that gets
 * dropped and retried forever. Provenance is `verifyTwilioSignature`'s job;
 * this schema only bounds what it recognises.
 *
 * `From` and `To` are bounded but NOT forced to E.164: a Messaging Service may
 * send from an alphanumeric sender id (`"SecureVoice"`), which is a legitimate
 * Twilio sender and not a phone number. The consumer normalises when it needs a
 * number, exactly as `src/app/api/sms/inbound/route.ts` already does.
 */
export const twilioWebhookSchema = z.looseObject({
  AccountSid: vendorId(64).optional(),
  MessageSid: vendorId(64).optional(),
  SmsSid: vendorId(64).optional(),
  CallSid: vendorId(64).optional(),
  From: boundedString({ min: 1, max: 64 }).optional(),
  To: boundedString({ min: 1, max: 64 }).optional(),
  Body: boundedString({ max: 4_096 }).optional(),
  NumMedia: formInt({ min: 0, max: 100 }).optional(),
  NumSegments: formInt({ min: 0, max: 100 }).optional(),
  MediaContentType0: boundedString({ max: 128 }).optional(),
  MediaUrl0: boundedString({ max: 2_048 }).optional(),
  Status: boundedString({ max: 32 }).optional(),
  CallStatus: boundedString({ max: 32 }).optional(),
  MessageStatus: boundedString({ max: 32 }).optional(),
  SmsStatus: boundedString({ max: 32 }).optional(),
  ErrorCode: formInt({ min: 0, max: 999_999 }).optional(),
  ErrorMessage: boundedString({ max: 512 }).optional(),
});

export type TwilioWebhookParams = z.infer<typeof twilioWebhookSchema>;

/** Normalise the three ways a route might hand us form parameters. */
function normaliseTwilioParams(input: unknown): Record<string, string> | null {
  if (typeof URLSearchParams !== "undefined" && input instanceof URLSearchParams) {
    const out: Record<string, string> = {};
    input.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (typeof FormData !== "undefined" && input instanceof FormData) {
    const out: Record<string, string> = {};
    let allStrings = true;
    input.forEach((value, key) => {
      if (typeof value === "string") out[key] = value;
      else allStrings = false;
    });
    return allStrings ? out : null;
  }
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      // A Twilio form field is always a string; anything else was built in code.
      if (typeof value !== "string") return null;
      out[key] = value;
    }
    return out;
  }
  return null;
}

// ── The signed bank event ───────────────────────────────────────────────────
//
// The one body on this boundary that WE produce and a bank CONSUMES, so it is the
// only one whose shape is entirely ours — `buildBankEvent` in src/lib/outbox.ts is
// the producer and this is its contract read back.
//
// It is deliberately the STRICTEST schema in the file, which is the opposite of
// the vendor schemas above and worth stating. Those describe bodies we do not
// control, so `looseObject` plus a known-type discriminator is the right posture:
// a new Paddle field must not break ingest. Here every field is one we emit, and
// the receiver was writing it into a column with a UNIQUE index. `event_id` in
// particular was previously produced with `String(parsed.event_id ?? "")`, so two
// deliveries that both omitted it collapsed onto the empty string — the second
// raised a unique violation and surfaced as a 500, and the first silently
// occupied the slot every later malformed delivery contended for. An event with
// no id is not a bank event; refusing it is the whole point.

const bankWebhookSchema = z.looseObject({
  // A DATE STRING, not an integer. `SCHEMA_VERSION` in src/lib/outbox.ts is
  // "2026-10-01" (mirrored by `OUTBOUND_SCHEMA_VERSION` in
  // src/lib/contracts/schema.ts) — the version is the date the envelope shape
  // settled, so it changes when the shape changes and an integer would invite a
  // bank to read it as a counter and expect increments.
  schema_version: boundedString({ min: 8, max: 32, pattern: /^\d{4}-\d{2}-\d{2}$/ }),
  /** The dedupe key, and the unique column the receiver upserts on. REQUIRED. */
  event_id: vendorId(128),
  event_type: boundedString({ min: 3, max: 64, pattern: /^[a-z][a-z0-9_.]{2,63}$/ }),
  case_ref: boundedString({ min: 1, max: 64 }).nullable().optional(),
  org_id: boundedString({ min: 1, max: 128 }).nullable().optional(),
  /** ISO-8601 from `new Date().toISOString()`. */
  occurred_at: boundedString({ min: 20, max: 40 }),
  data: opaqueRecord,
});

export type BankWebhookEvent = z.infer<typeof bankWebhookSchema>;

// ── Entry points ────────────────────────────────────────────────────────────

/** Validate an already-parsed Paddle webhook body. */
export function validatePaddleWebhook(raw: unknown): WebhookValidation<PaddleWebhookEvent> {
  // The cast is the same one `validateElevenLabsWebhook` needs: a `superRefine`
  // pipeline infers as `unknown`, and the declared type above is the shape the
  // dispatcher validated.
  return run(paddleWebhookSchema as unknown as z.ZodType<PaddleWebhookEvent>, raw, "paddle");
}

/** Validate an already-parsed ElevenLabs post-call webhook body. */
export function validateElevenLabsWebhook(raw: unknown): WebhookValidation<ElevenLabsWebhookEvent> {
  return run(
    elevenLabsWebhookSchema as unknown as z.ZodType<ElevenLabsWebhookEvent>,
    raw,
    "elevenlabs",
  );
}

/**
 * Validate Twilio form parameters. Accepts the `Record<string, string>` the
 * routes already build from `req.formData()`, a `URLSearchParams`, or a
 * `FormData` — so a caller does not have to convert first and cannot forget to.
 *
 * Signature verification is NOT done here. Twilio's signature is over the exact
 * public URL and the raw parameter string, which this module never sees; the
 * routes verify with `verifyTwilioSignature` from `src/lib/twilio.ts` and only
 * then validate the shape.
 */
export function validateTwilioWebhook(input: unknown): WebhookValidation<TwilioWebhookParams> {
  const params = normaliseTwilioParams(input);
  if (!params) {
    return {
      ok: false,
      error:
        "twilio: expected form parameters (Record<string,string>, URLSearchParams or FormData)",
      issues: [],
    };
  }
  return run(twilioWebhookSchema, params, "twilio");
}

/**
 * Validate a signed bank event — the body `buildBankEvent` produces and
 * `/api/webhooks/receiver` consumes.
 *
 * Strict on `event_id`, which is the column the receiver upserts on behind a
 * unique index. See the schema above for why a missing id used to be a 500.
 */
export function validateBankWebhook(raw: unknown): WebhookValidation<BankWebhookEvent> {
  return run(bankWebhookSchema, raw, "bank");
}
