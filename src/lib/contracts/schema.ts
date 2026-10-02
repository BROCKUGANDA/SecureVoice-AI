/**
 * Canonical integration contract (WP-17).
 *
 * ONE definition of every field a customer's system sends us and every event we
 * send back, plus the typed error catalog. The OpenAPI document
 * (`src/app/openapi/route.ts`) and the AsyncAPI document
 * (`src/app/asyncapi/route.ts`) are GENERATED from the data below — the builders
 * are `openapi.ts` and `asyncapi.ts` — so a spec that disagrees with the code is
 * not a maintenance mistake: it cannot be written without editing this file, and
 * `tests/contracts/contracts.test.ts` fails if the code moves and this file does
 * not.
 *
 * ── How the shapes here were derived ────────────────────────────────────────
 *
 * Every field is transcribed from the real code path, not from the prose docs:
 *
 *   inbound   src/app/api/v1/interventions/route.ts
 *             · request  — the `.strict()` zod object, field by field, with the
 *               same bounds (`.trim().min(3).max(64)` and friends)
 *             · 202      — the two envelope literals `armAndDial` returns
 *               (`status: "queued"` and `status: "degraded_to_async"`)
 *             · replay   — the stored envelope re-sent with `duplicate: true`
 *               plus `X-Idempotent-Replay: true`
 *   outbound  src/lib/outbox.ts
 *             · envelope — `buildBankEvent` (schema_version, event_id,
 *               event_type, case_ref, org_id, occurred_at, data) and
 *               `canonicalJson` (the bytes that are signed AND sent)
 *             · payload  — src/lib/elevenlabs/inbound.ts, the only producer of
 *               an outbox event today (`eventType: "case.notified"`)
 *
 * Where the docs and the code disagree, THIS FILE FOLLOWS THE CODE. `docs/
 * INTEGRATION.md` still documents the retired `POST /api/interventions`
 * (a nested `signal.{...}` body, `amountAed`, and an event list this codebase
 * never emits). That document was written before the ingest moved to
 * `/v1/interventions`; see `docs/INTEGRATION-CONTRACT.md` for the contract that
 * actually runs.
 *
 * This module imports NOTHING — no db, no env, no `server-only` — so it is
 * loadable from a route handler, from a test, and from a build step without
 * dragging a database connection along.
 */

/* ──────────────────────────────────────────────────────────────────────────
 * Paths
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The path a bank calls, and the app path the rewrite resolves it to.
 *
 * `next.config.ts` declares `rewrites()` mapping `/v1/interventions` ->
 * `/api/v1/interventions`, so BOTH are live. Kept as data because
 * `tests/contracts` asserts the rewrite still exists rather than trusting this
 * comment.
 */
export const PUBLIC_INGEST_PATH = "/v1/interventions";
export const APP_INGEST_PATH = "/api/v1/interventions";
export const RETIRED_INGEST_PATH = "/api/interventions";
export const CONFORMANCE_PATH = "/v1/conformance/run";
export const RECEIVER_REFERENCE_PATH = "/api/webhooks/receiver";

/* ──────────────────────────────────────────────────────────────────────────
 * Constants mirrored from the code
 * ────────────────────────────────────────────────────────────────────────── */

/** `SCHEMA_VERSION` in src/lib/outbox.ts. Bump together, never alone. */
export const OUTBOUND_SCHEMA_VERSION = "2026-10-01";

/** `REPLAY_WINDOW_SEC` in the ingest route. */
export const REPLAY_WINDOW_SECONDS = 300;

/** `toleranceMs` in src/lib/outbox.ts `verifySignature`. */
export const OUTBOUND_REPLAY_WINDOW_SECONDS = 300;

/** `MAX_ATTEMPTS` in src/lib/outbox.ts — then the event goes DEAD. */
export const MAX_DELIVERY_ATTEMPTS = 6;

/** `IDEMPOTENCY_TTL_MS` in the ingest route: 24 h. */
export const IDEMPOTENCY_TTL_HOURS = 24;

/** `WEBHOOK_SIGNATURE_HEADER` in src/lib/outbox.ts. */
export const SIGNATURE_HEADER = "sv-signature";

/** Header names the ingest accepts for the inbound signature. */
export const INBOUND_SIGNATURE_HEADERS = [
  "sv-signature",
  "SV-Signature",
  "x-securevoice-signature",
] as const;

export const IDEMPOTENCY_HEADER = "idempotency-key";
export const IDEMPOTENCY_MIN_LENGTH = 8;
export const REPLAY_RESPONSE_HEADER = "X-Idempotent-Replay";

/* ──────────────────────────────────────────────────────────────────────────
 * The signature scheme
 * ────────────────────────────────────────────────────────────────────────── */

export const SIGNATURE_SCHEME = {
  /** Header carrying the signature on both directions. */
  header: "SV-Signature",
  /** Algorithm. Fixed: no negotiation, no downgrade to MD5 or a bare hash. */
  algorithm: "HMAC-SHA256",
  /** Header grammar. The digest is 64 lowercase hex characters. */
  grammar: "SV-Signature: t={unix_seconds},v1={hex64}",
  /** Signed message. The timestamp is a dot-prefixed string, not JSON. */
  signedMessage: "{t}.{raw_request_body}",
  /**
   * The canonical body is sorted-key JSON (src/lib/outbox.ts canonicalJson).
   * The bytes that are hashed are the bytes that are sent, so a receiver never
   * has to re-serialise anything to verify.
   */
  canonicalBody: "sorted-key JSON at every depth; sign the exact transmitted bytes",
  /** Inbound: the raw request body as received. Outbound: our canonical JSON. */
  bodyRule:
    "INBOUND sign the exact bytes you send (capture the raw body; re-serialising JSON changes the bytes and breaks the digest). OUTBOUND our body is already canonical.",
  /** Header format the ingest accepts, from verifySignature's own regex. */
  inboundGrammar: "t={10 digits},v1={64 lowercase hex}",
  replayWindowSeconds: REPLAY_WINDOW_SECONDS,
  comparison: "constant-time (timingSafeEqual / hmac.compare_digest)",
  secretEnv: {
    inbound: "WEBHOOK_SECRET",
    outbound: "BANK_WEBHOOK_SECRET",
  },
  /** Producer keys are an alternative to the shared secret, not an addition. */
  alternative: {
    header: "Authorization",
    scheme: "Bearer svb_…",
    source: "src/lib/producer-keys.ts verifyProducerKey",
    effect:
      "a producer key is org-scoped, so its orgId wins for tenancy over an org_id in the payload; it is revocable per team without rotating the global secret",
  },
  referenceImplementations: [
    "scripts/verify_sv_signature.ts (TypeScript / Bun)",
    "scripts/verify_sv_signature.py (Python 3)",
    "scripts/verify-signatures/SignatureVerifier.java (Java 8+)",
    "src/app/api/webhooks/receiver/route.ts (the hosted reference receiver)",
  ],
  rejectReasons: [
    { reason: "missing_signature", meaning: "no SV-Signature header (and no producer key)" },
    { reason: "malformed_signature", meaning: "header present but t/v1 missing or unparseable" },
    { reason: "malformed_timestamp", meaning: "t is not a number" },
    { reason: "stale_timestamp", meaning: `|now - t| > ${REPLAY_WINDOW_SECONDS}s` },
    { reason: "digest_mismatch", meaning: "HMAC did not match the body bytes" },
  ],
} as const;

/* ──────────────────────────────────────────────────────────────────────────
 * Field specifications
 * ────────────────────────────────────────────────────────────────────────── */

/** The subset of JSON Schema 2020-12 this contract emits. */
export type JsonSchema = {
  type?: string;
  format?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: readonly (string | number)[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  nullable?: boolean;
  examples?: unknown[];
  oneOf?: readonly JsonSchema[];
  [key: string]: unknown;
};

/**
 * One field, as the CODE declares it.
 *
 * `enforced` names the file that enforces the constraint, so a reviewer can
 * check a boundary against the implementation without trusting this file. The
 * contracts gate asserts those files still exist.
 */
export type FieldSpec = {
  readonly name: string;
  readonly required: boolean;
  readonly type: "string" | "integer" | "number" | "boolean" | "object" | "array";
  /**
   * The field may be JSON `null`. Rare and deliberate — a nullable field in a
   * contract is a branch the receiver must write, so each one says why in its
   * description.
   */
  readonly nullable?: boolean;
  readonly format?: string;
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly enum?: readonly string[];
  readonly description: string;
  readonly example?: unknown;
  readonly enforced: string;
};

/**
 * The `enforced` marker for the inbound request fields: a REAL FILE PATH, with a
 * parenthesised locator. `tests/contracts/contracts.test.ts` splits on the first
 * space and asserts the file exists on disk, so this must stay a path.
 *
 * Distinct from the `INGEST` operation label declared near the error catalog
 * (`POST /v1/interventions`), which names an operation, not a file. Sharing one
 * identifier for both is a redeclaration in the same module scope, and picking
 * the operation label here would resolve `src/app/...` to nothing and fail the
 * gate on a lie.
 */
const INGEST_SCHEMA = "src/app/api/v1/interventions/route.ts (zod schema, .strict())";

/**
 * POST /v1/interventions request body.
 *
 * Transcribed field by field from the `.strict()` zod object. Unknown fields
 * are REJECTED, not ignored: a bank sending `account_number` gets a 422, which
 * is the intended behaviour — the payload is a closed contract, and silently
 * dropping a field a bank believed was being processed is how a customer ends
 * up with no call and no error.
 */
export const RISK_SIGNAL_FIELDS: readonly FieldSpec[] = [
  {
    name: "transaction_ref",
    required: true,
    type: "string",
    minLength: 3,
    maxLength: 64,
    description:
      "The bank's own transaction reference. Stored on the Case and echoed in every outbound event; it is the join key between the bank's alert and the case. It is an opaque reference, NOT an account number.",
    example: "FRAUD-2026-08612",
    enforced: INGEST_SCHEMA,
  },
  {
    name: "risk_score",
    required: true,
    type: "number",
    minimum: 0,
    maximum: 1,
    description:
      "The fraud engine's score, normalised to 0“1. Used for queue priority (triage) and for the admission control decision. It is NOT a decision: SecureVoice never approves or declines on it.",
    example: 0.94,
    enforced: INGEST_SCHEMA,
  },
  {
    name: "language",
    required: true,
    type: "string",
    minLength: 2,
    maxLength: 7,
    description:
      "BCP-47 language tag for the outbound call. The route comment names en, ar, hi; the value is passed to the voice provider, which is what bounds it in practice.",
    example: "ar",
    enforced: INGEST_SCHEMA,
  },
  {
    name: "phone",
    required: true,
    type: "string",
    pattern: "^\\+[1-9]\\d{1,14}$",
    description:
      "Destination in E.164 (+971501234567). Also the input to the geography control, so an invalid or non-routable number is refused before any carrier is contacted.",
    example: "+971501234567",
    enforced: INGEST_SCHEMA,
  },
  {
    name: "currency",
    required: true,
    type: "string",
    pattern: "^[A-Z]{3}$",
    description: "ISO-4217 alphabetic code for the minor units in `amount`.",
    example: "AED",
    enforced: INGEST_SCHEMA,
  },
  {
    name: "amount",
    required: true,
    type: "integer",
    minimum: 0,
    description:
      "Transaction amount in MINOR UNITS (fils, cents) as an integer — 2500 means 25.00 AED. An integer is mandatory: a float here is a rounding bug waiting to happen, and money is not reconstructed from it downstream.",
    example: 2500,
    enforced: INGEST_SCHEMA,
  },
  {
    name: "consent_record_id",
    required: true,
    type: "string",
    minLength: 4,
    maxLength: 64,
    description:
      "The bank's consent record permitting outbound contact for this customer. Mandatory: without it the policy gate refuses the signal (consent_invalid). A customer who has opted out is refused with 409 consent_opted_out and is never dialled.",
    example: "CN-2026-04-1183",
    enforced: INGEST_SCHEMA,
  },
  {
    name: "merchant",
    required: false,
    type: "string",
    maxLength: 120,
    description:
      "Merchant descriptor, spoken to the customer in the call. Sanitised (sanitizeUntrusted) before it becomes a dynamic variable, and never an authorisation input.",
    example: "Electronics World",
    enforced: INGEST_SCHEMA,
  },
  {
    name: "callback_url",
    required: false,
    type: "string",
    format: "uri",
    maxLength: 300,
    description:
      "Optional per-signal HTTPS destination for post-call outcome delivery. Validated by SSRF verdict, not by string pattern: the name must RESOLVE to a public address, port 443 only, no credentials, and every redirect hop is re-validated. Private, loopback, link-local and cloud-metadata targets are refused with 422.",
    example: "https://bank.example.com/hooks/securevoice",
    enforced: `${INGEST_SCHEMA}; SSRF: src/lib/validation/ssrf.ts validateOutboundUrl`,
  },
  {
    name: "org_id",
    required: false,
    type: "string",
    minLength: 2,
    maxLength: 64,
    description:
      "Tenant scope for HMAC-authenticated producers. Ignored when a producer key is used — the key's orgId wins.",
    example: "bank-core-uae",
    enforced: INGEST_SCHEMA,
  },
] as const;

/** Case states the platform can report back. CASE_STATES, src/lib/case-state-machine.ts. */
export const CASE_STATES = [
  "RECEIVED",
  "SCREENED",
  "DIALING",
  "RINGING",
  "ANSWERED",
  "DISCLOSED",
  "VERIFYING",
  "CONFIRMED_LEGITIMATE",
  "CONFIRMED_FRAUD",
  "UNCERTAIN",
  "FREEZE_STAGED",
  "ESCALATED",
  "NOTIFIED",
  "CLOSED",
  "REJECTED",
  "NO_ANSWER",
  "BUSY",
  "FAILED",
  "VOICEMAIL",
  "RETRY_SCHEDULED",
  "EXHAUSTED",
] as const;

/** Dial queue states. DIAL_JOB_STATES, src/lib/scale/queue.ts. */
export const DIAL_JOB_STATES = ["PENDING", "CLAIMED", "DONE", "DEAD"] as const;

/** Admission bands. src/lib/capacity.ts. */
export const ADMISSION_BANDS = ["NORMAL", "CONSTRAINED", "SHED"] as const;

/** 202 body when the case was admitted to the voice channel and enqueued. */
export const INTERVENTION_QUEUED_FIELDS: readonly FieldSpec[] = [
  { name: "ok", required: true, type: "boolean", description: "Always true on 202.", example: true, enforced: "route.ts armAndDial" },
  {
    name: "caseRef",
    required: true,
    type: "string",
    description:
      "Case reference, SV-F-XXXXXX (Crockford-ish alphabet without I/L/O/U). The join key for every downstream stage and the handle to quote in a ticket.",
    example: "SV-F-7K2M9Q",
    enforced: "route.ts makeCaseRef",
  },
  {
    name: "transactionRef",
    required: true,
    type: "string",
    description: "Echo of the submitted transaction_ref, so a producer can correlate without state.",
    example: "FRAUD-2026-08612",
    enforced: "route.ts armAndDial",
  },
  {
    name: "status",
    required: true,
    type: "string",
    enum: ["queued"],
    description:
      "`queued`, NOT `dialing`: the request handler enqueues a durable job and returns. A bank that sees `dialing` here would be told a carrier call exists before it does.",
    example: "queued",
    enforced: "route.ts armAndDial",
  },
  {
    name: "jobId",
    required: true,
    type: "string",
    description: "Durable dial-job id. The worker claims this; a queue drain is visible by id.",
    enforced: "route.ts armAndDial",
  },
  { name: "language", required: true, type: "string", description: "Echo of the submitted language.", example: "ar", enforced: "route.ts armAndDial" },
  { name: "riskScore", required: true, type: "number", description: "Echo of the submitted risk_score.", example: 0.94, enforced: "route.ts armAndDial" },
  {
    name: "delivery",
    required: true,
    type: "object",
    description: "How the call was dispatched. Never a carrier call made inside the request.",
    enforced: "route.ts armAndDial",
  },
  {
    name: "receivedAt",
    required: true,
    type: "string",
    format: "date-time",
    description: "ISO-8601 instant the case was armed.",
    enforced: "route.ts armAndDial",
  },
] as const;

/** The `delivery` sub-object of the queued 202. */
export const DELIVERY_FIELDS: readonly FieldSpec[] = [
  { name: "channel", required: true, type: "string", enum: ["queued"], description: "Dispatch mechanism.", enforced: "route.ts" },
  { name: "provider", required: true, type: "string", enum: ["elevenlabs"], description: "Voice provider.", enforced: "route.ts" },
  {
    name: "to",
    required: true,
    type: "string",
    description:
      "Destination as REDACTED for the response and the log (digits except the last four replaced). The unmasked number never leaves the platform in a response body.",
    example: "+9715*******67",
    enforced: "src/lib/redact.ts",
  },
  { name: "jobId", required: true, type: "string", description: "Durable dial-job id.", enforced: "route.ts" },
  {
    name: "jobState",
    required: true,
    type: "string",
    enum: DIAL_JOB_STATES,
    description: "Queue state at enqueue time (PENDING normally).",
    enforced: "src/lib/scale/queue.ts DIAL_JOB_STATES",
  },
  {
    name: "duplicate",
    required: true,
    type: "boolean",
    description:
      "True when the enqueue was rejected by the unique (case_id, attempt_no) index, i.e. this case was already queued. Same mechanism as the response-level replay marker, one layer down.",
    enforced: "route.ts armAndDial",
  },
] as const;

/** 202 body when admission control shed the voice channel. */
export const INTERVENTION_DEGRADED_FIELDS: readonly FieldSpec[] = [
  { name: "ok", required: true, type: "boolean", description: "Always true — the signal was accepted.", example: true, enforced: "route.ts armAndDial" },
  { name: "caseRef", required: true, type: "string", description: "Case reference. The case exists and is auditable.", enforced: "route.ts makeCaseRef" },
  { name: "transactionRef", required: true, type: "string", description: "Echo of transaction_ref.", enforced: "route.ts armAndDial" },
  {
    name: "status",
    required: true,
    type: "string",
    enum: ["degraded_to_async"],
    description:
      "The voice channel was shed under load; the case degrades to an asynchronous channel instead of being dropped. A bank must treat this as ACCEPTED-but-not-voice, and must have its own asynchronous step for the cases it cannot afford to lose.",
    example: "degraded_to_async",
    enforced: "route.ts armAndDial",
  },
  {
    name: "degraded",
    required: true,
    type: "object",
    description: "The admission decision: band, reason, fallback channel, expected-loss score.",
    enforced: "route.ts armAndDial",
  },
  { name: "receivedAt", required: true, type: "string", format: "date-time", description: "ISO-8601 instant.", enforced: "route.ts armAndDial" },
] as const;

export const DEGRADED_FIELDS: readonly FieldSpec[] = [
  {
    name: "band",
    required: true,
    type: "string",
    enum: ADMISSION_BANDS,
    description: "Admission band at decision time.",
    enforced: "src/lib/capacity.ts",
  },
  { name: "reason", required: true, type: "string", description: "Why the voice channel was shed, in prose. Human-facing.", enforced: "src/lib/admission.ts" },
  {
    name: "fallback",
    required: true,
    type: "string",
    enum: ["sms", "app_push"],
    description: "The asynchronous channel the case degrades to.",
    enforced: "src/lib/admission.ts",
  },
  {
    name: "expectedLoss",
    required: true,
    type: "integer",
    description: "Risk x amount, rounded. Drives triage priority. Not a currency amount and not a balance.",
    enforced: "src/lib/capacity.ts expectedLossScore",
  },
] as const;

/* ──────────────────────────────────────────────────────────────────────────
 * Outbound bank event
 * ────────────────────────────────────────────────────────────────────────── */

/** The envelope. buildBankEvent, src/lib/outbox.ts. */
export const BANK_EVENT_FIELDS: readonly FieldSpec[] = [
  {
    name: "schema_version",
    required: true,
    type: "string",
    description: `Envelope version, currently "${OUTBOUND_SCHEMA_VERSION}". A receiver must REJECT an unknown version rather than guess.`,
    example: OUTBOUND_SCHEMA_VERSION,
    enforced: "src/lib/outbox.ts SCHEMA_VERSION",
  },
  {
    name: "event_id",
    required: true,
    type: "string",
    description:
      "UUID v4, assigned before the row is written. THE DEDUPE KEY: a receiver must store it and drop a repeat. The same event_id is retried up to 6 times with byte-identical bodies, so duplicates are normal traffic, not an error.",
    enforced: "src/lib/outbox.ts buildBankEvent",
  },
  {
    name: "event_type",
    required: true,
    type: "string",
    description:
      "Dotted event name. The only type emitted today is `case.notified` (post-call verdict). Unknown types must be ignored, not treated as fatal.",
    example: "case.notified",
    enforced: "src/lib/elevenlabs/inbound.ts",
  },
  {
    name: "case_ref",
    required: true,
    type: "string",
    nullable: true,
    description: "Case reference, or null for an event with no case. The join key to the bank's own alert.",
    example: "SV-F-7K2M9Q",
    enforced: "src/lib/outbox.ts buildBankEvent",
  },
  {
    name: "org_id",
    required: true,
    type: "string",
    nullable: true,
    description: "Tenant scope, or null for the shared namespace.",
    example: "bank-core-uae",
    enforced: "src/lib/outbox.ts buildBankEvent",
  },
  {
    name: "occurred_at",
    required: true,
    type: "string",
    format: "date-time",
    description:
      "When the event happened, not when it was sent. For `case.notified` this is the post-call ingest instant, so a retry hours later does not look like a new event.",
    enforced: "src/lib/outbox.ts enqueueOutbox (occurredAt)",
  },
  {
    name: "data",
    required: true,
    type: "object",
    description: "Type-specific payload. Never transcript content (hazard H28).",
    enforced: "src/lib/elevenlabs/inbound.ts",
  },
] as const;

/** `data` for the only emitted type, `case.notified`. */
export const CASE_NOTIFIED_DATA_FIELDS: readonly FieldSpec[] = [
  { name: "state", required: true, type: "string", enum: ["NOTIFIED"], description: "Case state at publication.", enforced: "inbound.ts" },
  {
    name: "outcome",
    required: true,
    type: "string",
    nullable: true,
    description:
      "Post-call verdict as classified by the pipeline. A value here is EVIDENCE for the bank's fraud team, not an authorisation: the bank decides what to do with the case.",
    enforced: "inbound.ts",
  },
  {
    name: "duration_seconds",
    required: true,
    type: "number",
    nullable: true,
    description: "Call duration in seconds, or null if the provider reported none.",
    enforced: "inbound.ts",
  },
  { name: "freeze_staged", required: true, type: "boolean", description: "Whether a card freeze was STAGED. Staged is not blocked: a human specialist finalises it.", enforced: "inbound.ts" },
  { name: "freeze_reference", required: true, type: "string", nullable: true, description: "Reference for the staged freeze, when one exists.", enforced: "inbound.ts" },
  { name: "handoff_queued", required: true, type: "boolean", description: "Whether a fraud specialist was queued.", enforced: "inbound.ts" },
  { name: "handoff_specialist", required: true, type: "string", nullable: true, description: "Specialist queue or name, when queued.", enforced: "inbound.ts" },
  { name: "tool_calls_observed", required: true, type: "integer", description: "Count of agent tool invocations during the call.", enforced: "inbound.ts" },
  {
    name: "audit_ref",
    required: true,
    type: "string",
    description:
      "Reference the bank can quote in a ticket to pull the full, redacted audit chain through the signed case export. This is the pull-based evidence model: we push the verdict, the bank pulls evidence.",
    example: "SV-F-7K2M9Q",
    enforced: "inbound.ts",
  },
  {
    name: "evidence",
    required: true,
    type: "object",
    description:
      "A pointer, not the evidence. `transcript` is the literal string `withheld` and this is invariant, not a configuration.",
    enforced: "inbound.ts",
  },
] as const;

export const EVIDENCE_FIELDS: readonly FieldSpec[] = [
  {
    name: "transcript",
    required: true,
    type: "string",
    enum: ["withheld"],
    description: "Always the literal `withheld`. No transcript content ever appears in an outbound event.",
    example: "withheld",
    enforced: "inbound.ts",
  },
  { name: "note", required: true, type: "string", description: "Prose explanation of where the evidence lives.", enforced: "inbound.ts" },
] as const;

/**
 * Data minimisation, as a contract rather than a promise.
 *
 * `neverSent` is the load-bearing half: it is what a bank's privacy review
 * actually asks for, and it is asserted in tests (a field name from this list
 * appearing in the outbound schema is a test failure).
 */
export const DATA_MINIMISATION = {
  sent: [
    "transaction_ref — the bank's own opaque reference (never an account number)",
    "case_ref — platform case reference, the join key",
    "risk_score — 0“1, used for triage",
    "language, currency, amount (minor units), merchant descriptor",
    "phone — E.164, required to place the call; returned to the caller only redacted",
    "consent_record_id — required for outbound contact",
    "post-call verdict, duration, staged-freeze and handoff flags, audit reference",
  ],
  neverSent: [
    "account numbers, IBANs, card PANs or track data",
    "balances, available credit, or any account state",
    "the transaction's counterparty bank account or settlement details",
    "transcript content, verbatim or redacted",
    "recording URLs or audio",
    "date of birth, address, email, document numbers, or any other customer PII",
    "the webhook secret or any signing material",
    "the unmasked destination phone number (only a redacted form is echoed)",
  ],
  rationale:
    "SecureVoice is a verification-by-conversation surface, not a ledger. It never needs an account number to call someone, so it never accepts one: the ingest schema is .strict() and an unknown field is refused, which turns 'do not send PII' from a policy into a rejection.",
} as const;

/* ──────────────────────────────────────────────────────────────────────────
 * Error catalog — typed, hand-written, source-traceable
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * TWO error envelope families exist in this codebase, and a bank will meet both.
 *
 *   · **failure_envelope_v1** — `{ code, message, retryable, requestId, docsUrl }`
 *     from `src/lib/failures/envelope.ts`. This is what the canonical ingest
 *     (`POST /v1/interventions`) and the conformance endpoint return. Every field
 *     is always present, `Retry-After` lives in a header rather than the body,
 *     and `docsUrl` resolves to a per-code page.
 *   · **legacy_error_field** — `{ error: string }`, optionally with a `code`
 *     field, from `src/lib/api-errors.ts`. The RETIRED `POST /api/interventions`
 *     and the operator/agent-tool routes still answer this way. It exists in the
 *     catalog because a bank that has not finished migrating will meet it, and
 *     because the 410 tells them exactly where to move.
 *
 * `envelope` on every row says which family produces it, because a producer's
 * error handling has to know whether `code` exists at all.
 */
export type ErrorEnvelopeFamily = "failure_envelope_v1" | "legacy_error_field";

/**
 * Where a code is observable within the body. This distinction is the reason
 * the catalog exists.
 *
 *   `http_body`     — the `code` field.
 *   `http_message`  — inside the prose `message`, and only when it survives the
 *                     envelope's sanitisation and length budget. NEVER branch on
 *                     it; `envelopeCode` tells you what the `code` field says.
 *   `audit_chain`   — nowhere in the response; only in the signed audit record.
 */
export type ErrorSurface = "http_body" | "http_message" | "audit_chain";

export type ErrorCodeEntry = {
  readonly id: string;
  /** The HTTP status a caller actually observes for this condition. */
  readonly status: number;
  /** The machine code, when it is in the body. Null when it is not. */
  readonly code: string | null;
  /** The verbatim string in the source that produces this code. */
  readonly literal: string;
  readonly surface: ErrorSurface;
  readonly envelope: ErrorEnvelopeFamily;
  /** Which documented endpoints can return it. */
  readonly reachedFrom: readonly string[];
  /**
   * For `http_message` entries: what the `code` FIELD will say. Null for
   * `http_body` entries (the field is `code` itself) and for `audit_chain`.
   */
  readonly envelopeCode?: string;
  /**
   * Whether the SAME request can succeed later, for THIS cause.
   *
   * This is deliberately not the same as the envelope's `retryable` flag, which
   * is fixed per code. `policy_precondition` is always `retryable: false`
   * because most policy refusals (consent, geography) must never be retried;
   * for the transient subset below, a DELAYED retry is correct and this column
   * says so. Trust this one for scheduling; trust the envelope's flag for "is it
   * safe to retry immediately".
   */
  readonly retryable: boolean;
  readonly meaning: string;
  readonly remediation: string;
};

const INGEST_ROUTE = "src/app/api/v1/interventions/route.ts";
const INGEST = `POST ${PUBLIC_INGEST_PATH}`;
const CONFORMANCE_OP = `POST ${CONFORMANCE_PATH}`;

/**
 * Every machine-readable error code in the customer-facing contract.
 *
 * Hand-written, NOT reflected: reflection over `failures/envelope.ts` would
 * produce a table of helper names, not of the conditions a bank branches on.
 * The contracts gate reads the sources and asserts the two sets agree in BOTH
 * directions — a code the code can emit with no catalog row fails, and so does a
 * row with no matching literal anywhere.
 */
export const ERROR_CODES: readonly ErrorCodeEntry[] = [
  /* ── failure_envelope_v1: the canonical ingest ── */
  {
    id: "malformed_request",
    status: 400,
    code: "malformed_request",
    literal: "malformed_request",
    surface: "http_body",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST, CONFORMANCE_OP],
    retryable: false,
    meaning:
      "The request could not be used as sent. Two causes: the body is not parseable JSON, or the mandatory `Idempotency-Key` header is absent or shorter than 8 characters. The `message` names which.",
    remediation:
      "Send a JSON object and a stable `Idempotency-Key` of at least 8 characters. Retries MUST reuse the same key — a fresh key per retry creates a second case and a second call.",
  },
  {
    id: "unauthenticated",
    status: 401,
    code: "unauthenticated",
    literal: "unauthenticated",
    surface: "http_body",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST, CONFORMANCE_OP],
    retryable: false,
    meaning:
      "No acceptable credential. Either a `Bearer svb_…` producer key that is unknown, revoked or expired, or an `SV-Signature` that is missing, malformed, outside the 300 s window, or a digest mismatch. Deliberately one code for all of them: distinguishing them turns the endpoint into an oracle for which secret you hold.",
    remediation:
      "Sign the EXACT bytes you transmit — capture the raw body, never a re-serialised object — and sync your clock to NTP. A digest mismatch with an apparently correct signature is almost always re-serialisation. Quote `requestId` from the body if you need to raise a ticket.",
  },
  {
    id: "semantically_invalid",
    status: 422,
    code: "semantically_invalid",
    literal: "semantically_invalid",
    surface: "http_body",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST, CONFORMANCE_OP],
    retryable: false,
    meaning:
      "Well-formed JSON that failed validation: a field bound was violated, an undeclared field was present (the schema is `.strict()`), or `callback_url` was refused by the outbound-URL policy. The `message` names the first offending field.",
    remediation:
      "Read `message`, fix the named field, re-send. Do not retry unchanged. NOTE: this ingest does not distinguish an unknown field from any other validation failure — `unknown_field` is emitted only by the legacy tool endpoints below. See `docs/INTEGRATION-CONTRACT.md` for the full field table.",
  },
  {
    id: "policy_precondition",
    status: 409,
    code: "policy_precondition",
    literal: "policy_precondition",
    surface: "http_body",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    retryable: false,
    meaning:
      "The signal was refused by a policy or a guardrail: the customer has opted out, the destination country is not allowed, the org is at its concurrency cap or spend ceiling, credits are exhausted, the destination is in cooldown, or the velocity breaker has paused the org. The specific cause is the `gate_*` / `abuse_*` row whose literal appears in `message`.",
    remediation:
      "Do NOT blind-retry: most policy refusals (consent, geography) must never be retried. The cause is named in `message` and is the value to branch on after reading it. For the transient causes — cooldown, concurrency caps, spend ceiling — a delayed retry is correct.",
  },
  {
    id: "rate_limited",
    status: 429,
    code: "rate_limited",
    literal: "rate_limited",
    surface: "http_body",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST, CONFORMANCE_OP],
    retryable: true,
    meaning:
      "The per-caller budget is spent. Carries `Retry-After` (the ingest computes it from the token bucket; the conformance endpoint clamps it into 1–3600 s).",
    remediation: "Honour `Retry-After` and retry with jitter. Never in a tight loop — it is your fraud engine's traffic pattern we are bounding.",
  },
  {
    id: "dependency_unavailable",
    status: 503,
    code: "dependency_unavailable",
    literal: "dependency_unavailable",
    surface: "http_body",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    retryable: true,
    meaning:
      "A required dependency failed while the case was being armed: the database, the durable dial queue, or a voice-provider call. Also the class used when a typed gate refusal carried a 5xx status. Carries `Retry-After`.",
    remediation:
      "Retry with backoff. Because the idempotency key is stored only after a successful arm, a retried signal either creates one case or replays the stored one — never two. Quote `requestId` if it persists.",
  },
  /* ── legacy_error_field: the retired ingest ── */
  {
    id: "endpoint_retired",
    status: 410,
    code: "endpoint_retired",
    literal: "endpoint_retired",
    surface: "http_body",
    envelope: "legacy_error_field",
    reachedFrom: [`POST ${RETIRED_INGEST_PATH}`],
    retryable: false,
    meaning:
      "`POST /api/interventions` is retired and arms nothing: no policy gate, no abuse gate, no Case row, no billing, and the carrier call used to happen inside the request. It answers with the successor path and the list of behavioural changes so a producer can migrate deliberately rather than guess.",
    remediation: `Move to ${PUBLIC_INGEST_PATH}: integer minor units, E.164 phone, required consent_record_id, required Idempotency-Key, and a ${PUBLIC_INGEST_PATH} error envelope ({ code, message, retryable, requestId, docsUrl }) instead of { error }.`,
  },
  {
    id: "invalid_payload",
    status: 422,
    code: "invalid_payload",
    literal: "invalid_payload",
    surface: "http_body",
    envelope: "legacy_error_field",
    reachedFrom: ["POST /api/console/fire (operator)", "POST /api/console/freeze/commit (operator)"],
    retryable: false,
    meaning:
      "Legacy `{ error, code }` validation refusal. Emitted by the OPERATOR console routes, not by the canonical ingest — the ingest uses `semantically_invalid`.",
    remediation: "This row is here so an operator-integration is not surprised. Bank integrations never see it.",
  },
  {
    id: "unknown_field",
    status: 422,
    code: "unknown_field",
    literal: "unknown_field",
    surface: "http_body",
    envelope: "legacy_error_field",
    reachedFrom: ["POST /api/elevenlabs/tools/* (agent)"],
    retryable: false,
    meaning:
      "The payload carried a field that is not in the schema at all (schemaErrorCode maps Zod's `unrecognized_keys`). Emitted by the agent tool endpoints only; the canonical ingest reports an undeclared field as `semantically_invalid`.",
    remediation:
      "Remove the field. Do not send account numbers or anything you expect us to store but do not declare — the ingest schema is strict, and a field you invent will not be stored.",
  },
  /* ── Policy-gate causes: inside message, with code = policy_precondition ── */
  {
    id: "gate_consent_opted_out",
    status: 409,
    code: null,
    literal: "consent_opted_out",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "policy_precondition",
    retryable: false,
    meaning:
      "The customer has withdrawn consent for outbound contact. The ingest answers 409 with `code: policy_precondition` and `consent_opted_out` as the reason. This is a legally meaningful refusal: the destination is never dialled, and no retry can turn it into an allowed call.",
    remediation:
      "Do not retry. Honour the opt-out and suppress further interventions for this customer; a retry here is a compliance violation, not a transient failure.",
  },
  {
    id: "gate_consent_invalid",
    status: 409,
    code: null,
    literal: "consent_invalid",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "policy_precondition",
    retryable: false,
    meaning:
      "consent_record_id missing or malformed for the policy gate. The literal appears in `message` as `consent_invalid: …` when it survives sanitisation; the `code` field is always `policy_precondition`.",
    remediation: "Send a 4–64 character consent_record_id that exists for the customer.",
  },
  {
    id: "gate_country_unparseable",
    status: 409,
    code: null,
    literal: "country_unparseable",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "policy_precondition",
    retryable: false,
    meaning: "No country could be derived from the E.164 number.",
    remediation: "Send a canonical E.164 number for a diallable country.",
  },
  {
    id: "gate_country_not_allowed",
    status: 409,
    code: null,
    literal: "country_not_allowed",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "policy_precondition",
    retryable: false,
    meaning:
      "The destination country is not on this org's allowlist. Raised by BOTH the policy gate and the abuse gate's geography control.",
    remediation: "Ask your SecureVoice contact to add the country to your org allowlist. It is a configuration change, not a payload change.",
  },
  {
    id: "gate_cooldown",
    status: 409,
    code: null,
    literal: "cooldown",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "policy_precondition",
    retryable: true,
    meaning:
      "That destination was dialled too recently for this org. `code` is `policy_precondition`, whose envelope-level `retryable` is false — because an IMMEDIATE retry is wrong — while this row is `retryable: true`, because a DELAYED retry past the cooldown window is exactly right. The two flags answer different questions and this is the canonical example of why they must not be conflated.",
    remediation:
      "Retry after the cooldown window. Do not switch `transaction_ref` to evade it — the cooldown is per destination, by design, and that is the toll-fraud control.",
  },
  {
    id: "gate_concurrency_cap",
    status: 409,
    code: null,
    literal: "concurrency_cap",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "policy_precondition",
    retryable: true,
    meaning: "This org is already at its simultaneous-call cap.",
    remediation: "Retry with jitter. This is capacity, not a rejection of the case.",
  },
  {
    id: "gate_spend_ceiling",
    status: 409,
    code: null,
    literal: "spend_ceiling",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "policy_precondition",
    retryable: true,
    meaning: "The org's spend ceiling for the window has been reached.",
    remediation: "Retry after the window resets, or have the ceiling raised.",
  },
  {
    id: "gate_credits_exhausted",
    status: 409,
    code: null,
    literal: "credits_exhausted",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "policy_precondition",
    retryable: false,
    meaning: "No credits remain for this organisation, or the credit reservation was refused.",
    remediation: "Top up the credits wallet. Retrying without credits fails identically.",
  },
  {
    id: "gate_invalid_e164",
    status: 409,
    code: null,
    literal: "invalid_e164",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "policy_precondition",
    retryable: false,
    meaning: "The destination is not canonical E.164 (abuse gate, input-shape control).",
    remediation: "Normalise to +<country><subscriber>, 2–16 digits.",
  },
  {
    id: "gate_country_unresolvable",
    status: 409,
    code: null,
    literal: "country_unresolvable",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "policy_precondition",
    retryable: false,
    meaning: "Canonical number, but no country could be determined (abuse gate).",
    remediation: "Send a number whose country code is allocated.",
  },
  {
    id: "gate_geo_allowlist_unconfigured",
    status: 409,
    code: null,
    literal: "geo_allowlist_unconfigured",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "policy_precondition",
    retryable: false,
    meaning: "No geography allowlist is configured for this org, so nothing is diallable. Fails closed.",
    remediation: "Operator action: configure the org's allowlist.",
  },
  {
    id: "gate_geo_allowlist_misconfigured",
    status: 409,
    code: null,
    literal: "geo_allowlist_misconfigured",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "policy_precondition",
    retryable: false,
    meaning: "The allowlist contains a wildcard, which is refused by design.",
    remediation: "Operator action: enumerate countries explicitly.",
  },
  {
    id: "gate_country_denied",
    status: 409,
    code: null,
    literal: "country_denied",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "policy_precondition",
    retryable: false,
    meaning: "The resolved country is on the denylist (abuse gate).",
    remediation: "Do not retry. Contact your SecureVoice owner if the denylist is wrong.",
  },
  {
    id: "gate_destination_prefix_denied",
    status: 409,
    code: null,
    literal: "destination_prefix_denied",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "policy_precondition",
    retryable: false,
    meaning: "The E.164 prefix is a shared-cost, premium or non-geographic service range (abuse gate).",
    remediation: "Send a geographic number.",
  },
  {
    id: "gate_demo_tier_requires_test_number",
    status: 409,
    code: null,
    literal: "demo_tier_requires_test_number",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "policy_precondition",
    retryable: false,
    meaning:
      "The org resolved to the demo plan tier and the destination is not on the verified test-number list (abuse gate).",
    remediation: "On a demo tier, dial only numbers from your verified list. A production tier has no such restriction.",
  },
  {
    id: "gate_test_number_list_empty",
    status: 409,
    code: null,
    literal: "test_number_list_empty",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "policy_precondition",
    retryable: false,
    meaning: "Demo tier with no verified test-number list configured. Fails closed (abuse gate).",
    remediation: "Operator action: configure the list.",
  },
  {
    id: "gate_org_auto_paused",
    status: 409,
    code: null,
    literal: "org_auto_paused",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "policy_precondition",
    retryable: true,
    meaning: "The velocity breaker tripped for this org and no human has resumed it (abuse gate).",
    remediation: "A human must resume the org in the console. Retrying without that is pointless.",
  },
  {
    id: "gate_velocity_new_prefix_burst",
    status: 409,
    code: null,
    literal: "velocity_new_prefix_burst",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "policy_precondition",
    retryable: true,
    meaning: "Too many previously-unseen destination prefixes inside the new-prefix window (abuse gate).",
    remediation: "Retry after the window. This is the toll-fraud control; do not work around it.",
  },
  {
    id: "gate_velocity_burst_rate",
    status: 409,
    code: null,
    literal: "velocity_burst_rate",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "policy_precondition",
    retryable: true,
    meaning:
      "The attempt rate inside the burst window exceeded the threshold (abuse gate). The envelope's own `retryable` stays false because a cooldown is required; this row's `retryable: true` records that a DELAYED retry is the correct response.",
    remediation: "Retry with backoff once the burst window clears; this is the attempt-rate control.",
  },
  {
    id: "gate_velocity_after_hours",
    status: 409,
    code: null,
    literal: "velocity_after_hours",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "policy_precondition",
    retryable: true,
    meaning:
      "Out-of-hours volume anomaly. A warn threshold — the abuse gate records the decision either way.",
    remediation: "Retry with backoff; if it persists, review your send schedule.",
  },
  {
    id: "gate_destination_cooldown",
    status: 409,
    code: null,
    literal: "destination_cooldown",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "policy_precondition",
    retryable: true,
    meaning: "The minimum interval between two dials to the same destination has not elapsed (abuse gate).",
    remediation: "Retry after the cooldown.",
  },
  {
    id: "gate_org_concurrency_cap",
    status: 409,
    code: null,
    literal: "org_concurrency_cap",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "policy_precondition",
    retryable: true,
    meaning: "Simultaneous calls for this org are at the cap (abuse gate).",
    remediation:
      "Retry with jitter once a call in flight completes. This is a capacity ceiling, not a rejection of this case — the signal was otherwise admissible.",
  },
  {
    id: "gate_global_concurrency_cap",
    status: 409,
    code: null,
    literal: "global_concurrency_cap",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "policy_precondition",
    retryable: true,
    meaning: "Simultaneous calls across all orgs are at the platform cap (abuse gate).",
    remediation: "Retry with jitter. A full platform is a capacity signal, not a case rejection.",
  },
  {
    id: "gate_internal_error",
    status: 409,
    code: null,
    literal: "guard_internal_error",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "policy_precondition",
    retryable: true,
    meaning: "An abuse control raised an unexpected error. Fails closed — and it is a bug in us.",
    remediation: "Retry; if it persists, quote `requestId` and the case reference to support.",
  },
  /* ── SSRF verdict codes: inside message, with code = semantically_invalid ── */
  {
    id: "ssrf_malformed_url",
    status: 422,
    code: null,
    literal: "malformed_url",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "semantically_invalid",
    retryable: false,
    meaning: "callback_url is not a valid absolute URL.",
    remediation: "Send an absolute https URL.",
  },
  {
    id: "ssrf_not_https",
    status: 422,
    code: null,
    literal: "not_https",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "semantically_invalid",
    retryable: false,
    meaning: "Plaintext http is refused: a network attacker could rewrite a signed body.",
    remediation:
      "Use an https URL. There is no plaintext exception on this surface, because the body carries an HMAC that an on-path attacker could otherwise rewrite.",
  },
  {
    id: "ssrf_credentials_in_url",
    status: 422,
    code: null,
    literal: "credentials_in_url",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "semantically_invalid",
    retryable: false,
    meaning: "https://user:pass@host leaks a credential into logs and referrers.",
    remediation: "Put the credential in a header, not the URL.",
  },
  {
    id: "ssrf_blocked_port",
    status: 422,
    code: null,
    literal: "blocked_port",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "semantically_invalid",
    retryable: false,
    meaning: "Only port 443 is permitted for a customer-supplied URL.",
    remediation: "Terminate TLS on 443 and route internally.",
  },
  {
    id: "ssrf_blocked_hostname",
    status: 422,
    code: null,
    literal: "blocked_hostname",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "semantically_invalid",
    retryable: false,
    meaning:
      "An internal-only name (localhost, *.internal, *.corp, *.local, published metadata names) or a name that is not fully qualified.",
    remediation:
      "Use a publicly resolvable FQDN on the public internet. An internal name is refused even when it would resolve, because this endpoint would dial it from inside our network.",
  },
  {
    id: "ssrf_dns_failed",
    status: 422,
    code: null,
    literal: "dns_failed",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "semantically_invalid",
    retryable: true,
    meaning: "The hostname did not resolve at validation time.",
    remediation: "Retry; check the name.",
  },
  {
    id: "ssrf_no_addresses",
    status: 422,
    code: null,
    literal: "no_addresses",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "semantically_invalid",
    retryable: false,
    meaning: "The hostname resolved to zero addresses.",
    remediation: "Check the DNS record.",
  },
  {
    id: "ssrf_private_address",
    status: 422,
    code: null,
    literal: "private_address",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "semantically_invalid",
    retryable: false,
    meaning:
      "A resolved address is private, loopback, link-local, CGNAT, multicast or reserved — including every published cloud-metadata address. A host with ONE private answer is rejected even if the others are public, because the connection race is the attack.",
    remediation: "Point the callback at a genuinely public address.",
  },
  {
    id: "ssrf_redirect_blocked",
    status: 422,
    code: null,
    literal: "redirect_blocked",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "semantically_invalid",
    retryable: false,
    meaning: "A redirect hop left the validated target. Each hop is re-validated before it is dialled.",
    remediation: "Return 200 directly; do not redirect to another host.",
  },
  {
    id: "ssrf_too_many_redirects",
    status: 422,
    code: null,
    literal: "too_many_redirects",
    surface: "http_message",
    envelope: "failure_envelope_v1",
    reachedFrom: [INGEST],
    envelopeCode: "semantically_invalid",
    retryable: false,
    meaning: "The redirect chain exceeded 5 hops, so the whole delivery was abandoned rather than followed further.",
    remediation: "Return the payload directly instead of redirecting; more than 5 hops is refused outright.",
  },
] as const;

/**
 * Failures whose body carries ONLY a prose field — no machine `code`.
 *
 * All of these are the LEGACY envelope. The canonical ingest does not use it,
 * which is exactly why the list is short and the 410 below is the most important
 * row in it: a bank still on `/api/interventions` gets `{ error }` with nothing
 * to branch on. Each `errorExample` is a verbatim substring of the source that
 * returns it, and the contracts gate asserts that, so a rewritten message cannot
 * silently detach from the document.
 */
export type StatusFailureEntry = {
  readonly id: string;
  readonly status: number;
  readonly errorExample: string;
  readonly envelope: ErrorEnvelopeFamily;
  readonly meaning: string;
  readonly retryable: boolean;
  readonly remediation: string;
};

export const STATUS_FAILURES: readonly StatusFailureEntry[] = [
  {
    id: "retired_signature_rejected",
    status: 401,
    errorExample: "Signature verification failed: ",
    envelope: "legacy_error_field",
    meaning:
      "The retired endpoint's 401. The reason is appended in prose: missing header, malformed header, timestamp outside the 300 s window in either direction, or digest mismatch.",
    retryable: false,
    remediation: "Sign the exact bytes you send, and sync your clock. Then migrate to /v1/interventions, which returns a machine code.",
  },
  {
    id: "retired_producer_key_rejected",
    status: 401,
    errorExample: "Invalid or revoked producer key",
    envelope: "legacy_error_field",
    meaning: "The `Authorization: Bearer svb_…` key is unknown, revoked or expired.",
    retryable: false,
    remediation: "Mint a new key in the console. Revocation is immediate and deliberate.",
  },
  {
    id: "retired_rate_limited",
    status: 429,
    errorExample: "Rate limit exceeded; retry later.",
    envelope: "legacy_error_field",
    meaning: "The retired endpoint's 429, with a `Retry-After` header and no code in the body.",
    retryable: true,
    remediation: "Honour Retry-After, then migrate: the canonical ingest returns `code: rate_limited`.",
  },
  {
    id: "retired_malformed_json",
    status: 400,
    errorExample: "Invalid JSON body",
    envelope: "legacy_error_field",
    meaning: "The retired endpoint's 400: the body did not parse as JSON.",
    retryable: false,
    remediation: "Send a JSON object, and sign the same bytes you transmit.",
  },
  {
    id: "retired_invalid_signal",
    status: 422,
    errorExample: "Invalid signal: ",
    envelope: "legacy_error_field",
    meaning:
      "The retired endpoint's 422. NOTE it returns `{ error }` with NO `code` field even for a validation failure — the one place where a bank gets no machine-readable reason at all.",
    retryable: false,
    remediation: "Read the prose, then migrate to /v1/interventions for `code: semantically_invalid`.",
  },
  {
    id: "receiver_unconfigured",
    status: 503,
    errorExample: "receiver_unconfigured",
    envelope: "legacy_error_field",
    meaning:
      "Our own hosted reference receiver has no BANK_WEBHOOK_SECRET, so it cannot verify anything. It is not your receiver.",
    retryable: false,
    remediation: "Operator action: set BANK_WEBHOOK_SECRET. Nothing for a bank to do.",
  },
] as const;

/** Look up an entry by its literal. One literal can appear in several sources. */
export function errorCodesForLiteral(literal: string): readonly ErrorCodeEntry[] {
  return ERROR_CODES.filter((e) => e.literal === literal);
}

/** Every distinct machine code that can appear in a `code` field. */
export function bodyErrorCodes(): readonly string[] {
  return [...new Set(ERROR_CODES.filter((e) => e.code !== null).map((e) => e.code as string))].sort();
}

/**
 * Every distinct machine code the failure envelope publishes on the documented
 * bank surface.
 *
 * NOTE: this is the REACHABLE subset, not the envelope's whole vocabulary. The
 * OpenAPI builder deliberately widens this list with `FAILURE_CODES` — see
 * `openapi.ts` `failureSchema()`. Publishing only the reachable subset would
 * hand a consumer that validates responses against the spec an enum missing
 * legal codes, and it would reject a body the envelope is entitled to send.
 */
export function failureEnvelopeCodes(): readonly string[] {
  return [
    ...new Set(
      ERROR_CODES.filter((e) => e.envelope === "failure_envelope_v1" && e.surface === "http_body").map(
        (e) => e.code as string,
      ),
    ),
  ].sort();
}


