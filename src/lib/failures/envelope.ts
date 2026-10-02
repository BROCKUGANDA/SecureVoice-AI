import "server-only";
/**
 * ONE error envelope for the API and the database (WP-21).
 *
 * Every failure a caller can observe — a rejected bank signal, a shed request,
 * a deadlocked transaction — is rendered as the same five fields:
 *
 *     { code, message, retryable, requestId, docsUrl }
 *
 * The shape is the contract. What is deliberately NOT in it is the point:
 *
 *   - **no stack trace** — a caller cannot act on one and it names our files;
 *   - **no SQL** — a `23503` message carries the offending *value*; the caller
 *     gets the *field* and nothing else (see `referenceConflict`);
 *   - **no model prompt** — a transcript or a system message is customer data
 *     under PDPL, and an error body is the wrong place to put it;
 *   - **no internal identifier** — no row ids, no connection strings, no
 *     idempotency keys. `requestId` is an opaque correlation token and the only
 *     identifier in the body; it maps to our logs, not to our schema.
 *
 * `sanitizePublicMessage` + `leakScan` enforce this mechanically rather than by
 * convention, and `tests/chaos/chaos.test.ts` runs the scanner against a
 * negative control so a passing scan cannot be vacuous.
 *
 * ── Status-code discipline ────────────────────────────────────────────────────
 * One row per class of failure, and the row is not a matter of taste:
 *
 *   400 malformed              the request is not parseable / not shaped right
 *   401 unauthenticated        no session, bad credential
 *   404 not found              genuinely absent — AND cross-tenant
 *   409 conflict               state or policy precondition not met
 *   413 too large              the body exceeds what we will accept
 *   422 semantically invalid   well-formed, but the values are wrong
 *   429 rate limited           caller-side quota, Retry-After
 *   503 shed / unavailable     our capacity or a dependency, Retry-After
 *   500 internal               a genuine bug and nothing else
 *
 * **403 never appears.** A 403 tells a prober "that exists, you just may not
 * see it", which is a free existence oracle across a tenant boundary. A
 * cross-tenant row answers 404 with a byte-identical body to a row that never
 * existed — `FORBIDDEN_STATUSES` is asserted empty by the gate.
 *
 * **A policy refusal is never a 500.** `policyPrecondition` and
 * `policyRefusal` are the only sanctioned constructors for "the gate said no",
 * both resolve to 409, and `policyRefusal` throws rather than fall back to 500
 * if it is ever handed something it does not recognise.
 *
 * ── Relationship to `src/lib/api-errors.ts` ───────────────────────────────────
 * `api-errors.ts` predates this module and still returns `{ error }` bodies for
 * the routes that call it. It is NOT replaced here: this module supplies the
 * status discipline and the leak discipline, and `responseInitFor()` produces a
 * `{ status, headers }` that drops into `NextResponse.json(body, init)`. The
 * gate cross-checks that this map and the helpers in `api-errors.ts` agree on
 * every shared status, so the two cannot drift apart silently.
 */

import { randomBytes } from "node:crypto";

// ── Codes ─────────────────────────────────────────────────────────────────────

export const FAILURE_CODES = [
  // 400
  "malformed_request",
  // 401
  "unauthenticated",
  // 404
  // A row belonging to another tenant is reported with the SAME code and the
  // SAME body as a row that does not exist. There is deliberately no separate
  // "cross-tenant" code: a distinct code would itself be the existence oracle
  // that the 404 is meant to deny.
  "not_found",
  // 409
  "state_conflict",
  "policy_precondition",
  "unique_conflict",
  "reference_conflict",
  "transaction_contended",
  "intervention_refused_degraded",
  // 413
  "payload_too_large",
  // 422
  "semantically_invalid",
  // 429
  "rate_limited",
  // 503
  "db_capacity_shed",
  "statement_timeout",
  "dependency_unavailable",
  // 500
  "internal_bug",
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

export type StatusRule = {
  status: number;
  retryable: boolean;
  /** This class of failure must carry a Retry-After header. */
  retryAfter: boolean;
  /** The class of failure, quoted from the discipline table. */
  disposition: string;
};

/**
 * The status map. Every entry is asserted by the gate: status is one of the
 * sanctioned values, no entry is 403, and every `retryAfter: true` entry
 * actually emits the header.
 */
export const STATUS_DISCIPLINE: Record<FailureCode, StatusRule> = {
  malformed_request: { status: 400, retryable: false, retryAfter: false, disposition: "malformed" },
  unauthenticated: { status: 401, retryable: false, retryAfter: false, disposition: "unauthenticated" },

  not_found: { status: 404, retryable: false, retryAfter: false, disposition: "not_found_or_cross_tenant" },

  state_conflict: { status: 409, retryable: false, retryAfter: false, disposition: "state_precondition" },
  policy_precondition: { status: 409, retryable: false, retryAfter: false, disposition: "policy_precondition" },
  unique_conflict: { status: 409, retryable: false, retryAfter: false, disposition: "state_precondition" },
  reference_conflict: { status: 409, retryable: false, retryAfter: false, disposition: "state_precondition" },
  // The database is healthy; this transaction simply lost its race. 503 would
  // tell the caller the platform is unwell, and a 409 says exactly what
  // happened. `retryable: true` is what makes the retry safe.
  transaction_contended: { status: 409, retryable: true, retryAfter: false, disposition: "state_precondition" },
  // Refusing an intervention we cannot durably record is a state precondition,
  // not an outage. A 503 with Retry-After would invite the caller to come back
  // and be refused again while the fraud continues.
  intervention_refused_degraded: {
    status: 409,
    retryable: false,
    retryAfter: false,
    disposition: "state_precondition",
  },

  payload_too_large: { status: 413, retryable: false, retryAfter: false, disposition: "too_large" },
  semantically_invalid: { status: 422, retryable: false, retryAfter: false, disposition: "semantically_invalid" },

  rate_limited: { status: 429, retryable: true, retryAfter: true, disposition: "caller_quota" },

  db_capacity_shed: { status: 503, retryable: true, retryAfter: true, disposition: "shed_load" },
  // The budget is gone, so the request is shed rather than left hanging. Same
  // status class, same Retry-After, different reason code.
  statement_timeout: { status: 503, retryable: true, retryAfter: true, disposition: "shed_load" },
  dependency_unavailable: {
    status: 503,
    retryable: true,
    retryAfter: true,
    disposition: "dependency_unavailable",
  },

  // Reachable ONLY from `internalBug`, i.e. a bug we did not anticipate.
  internal_bug: { status: 500, retryable: false, retryAfter: false, disposition: "bug" },
};

/** Statuses this module will never emit. Asserted empty by the gate. */
export const FORBIDDEN_STATUSES: readonly number[] = [403];

// ── Public messages ───────────────────────────────────────────────────────────
//
// Hand-written, one per code, and the ONLY text that reaches a caller unless a
// caller passes a short `detail` that survives `sanitizePublicMessage`. Note
// that `not_found` and `cross_tenant_not_found` are byte-identical on purpose.

const PUBLIC_MESSAGE: Record<FailureCode, string> = {
  malformed_request: "The request could not be parsed.",
  unauthenticated: "Sign in required.",
  not_found: "Not found.",
  state_conflict: "The record is not in a state that permits this request.",
  policy_precondition: "The request was refused by policy.",
  unique_conflict: "This request has already been recorded.",
  reference_conflict: "A referenced record is missing or not visible to this organisation.",
  transaction_contended: "The write lost a concurrency race. Retry the request.",
  intervention_refused_degraded:
    "Interventions are paused: the platform cannot durably record them at this moment.",
  payload_too_large: "The request body is too large.",
  semantically_invalid: "The request was well-formed but semantically invalid.",
  rate_limited: "Rate limit exceeded. Retry after the interval given.",
  db_capacity_shed: "The platform is shedding load. Retry shortly.",
  statement_timeout: "The request exceeded its time budget and was abandoned.",
  dependency_unavailable: "A required dependency is unavailable; a fallback is in use.",
  internal_bug: "Internal error.",
};

// ── Leak discipline ───────────────────────────────────────────────────────────

export type LeakKind =
  | "stack_trace"
  | "sql"
  | "model_prompt"
  | "internal_identifier"
  | "internal_timestamp"
  | "oversized";

/**
 * What a public message may never contain. Each rule is a leak class, not a
 * banned word: the gate feeds every rule a real-world offender and asserts each
 * one is reported, so an empty scan means something.
 */
export const LEAK_RULES: ReadonlyArray<{ kind: LeakKind; re: RegExp }> = [
  // ── stack traces ──
  { kind: "stack_trace", re: /\n\s*at\s+\S/ },
  { kind: "stack_trace", re: /\bat\s+[A-Za-z_$][\w.$<>]*\s+\(/ },
  { kind: "stack_trace", re: /\bnode_modules\b/ },
  { kind: "stack_trace", re: /[\w./\\-]+\.(?:ts|tsx|js|mjs|cjs):\d+(?::\d+)?/ },
  { kind: "stack_trace", re: /^\s*(?:[A-Za-z]*Error|DOMException)\b\s*[:\n]/ },
  { kind: "stack_trace", re: /prisma:\/\//i },

  // ── SQL ──
  { kind: "sql", re: /\bselect\b[\s\S]*\bfrom\b/i },
  { kind: "sql", re: /\binsert\s+into\b/i },
  { kind: "sql", re: /\bunique\s+constraint\s+(failed|violated)\b/i },
  { kind: "sql", re: /\bviolates\s+(?:foreign\s+key|unique|not-null|check)\b/i },
  { kind: "sql", re: /\bon\s+conflict\b/i },
  { kind: "sql", re: /\bwhere\s+"?[A-Za-z_][\w]*"?\s*(?:=|::|\bin\b)/i },
  { kind: "sql", re: /::(?:text|int|int4|int8|jsonb|uuid)\b/ },
  { kind: "sql", re: /\bfor\s+update\b/i },
  // The 23503 / 23502 message shapes. `Key (orgId)=(org_9f2c…)` is the single
  // most dangerous driver string to echo: the value is another organisation's
  // identifier, and the table on the other end is our schema.
  { kind: "sql", re: /\bkey\s*\([^)]*\)\s*=/i },
  { kind: "sql", re: /\bis\s+not\s+present\s+in\s+(?:table|row)\b/i },
  { kind: "sql", re: /\btable\s+"[A-Za-z_][\w]*"/ },
  { kind: "sql", re: /\b(?:already\s+exists|still\s+referenced\s+from|violates\s+(?:\w+\s+){1,3}constraint)\b/i },

  // ── model prompts ──
  { kind: "model_prompt", re: /^\s*(?:system|assistant|user)\s*:/im },
  { kind: "model_prompt", re: /\byou\s+are\s+(?:a|an|the)\b/i },
  { kind: "model_prompt", re: /<\|[^|]*\|>/ },
  { kind: "model_prompt", re: /\b(?:instructions?|prompt)\s*:/i },
  { kind: "model_prompt", re: /\b(?:tool_calls?|function_call)\b/ },
  { kind: "model_prompt", re: /\btemperature\s*[:=]\s*[\d.]/i },

  // ── internal identifiers and secrets ──
  // Lookarounds, not `\b`: in `org_9f2c4a17e0b34d55` the hex run is preceded by
  // an underscore, which IS a word character, so a `\b` would let the single
  // most likely leak in this codebase straight through.
  { kind: "internal_identifier", re: /(?<![0-9A-Za-z])[0-9a-f]{16,}(?![0-9A-Za-z])/i },
  {
    kind: "internal_identifier",
    re: /(?<![0-9A-Za-z])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9A-Za-z])/i,
  },
  // Our own identifier shapes: prefixed row ids from the schema and the API.
  { kind: "internal_identifier", re: /\b(?:org|case|call|conv|pilot|user|svb|pay|dead)_[A-Za-z0-9]{6,}\b/ },
  { kind: "internal_identifier", re: /\bcuid2?\s*\(|\bcm[a-z0-9]{20,}\b/i },
  { kind: "internal_identifier", re: /\b(?:pk|sk|whsec|svb|sb)_[A-Za-z0-9_]{8,}/ },
  { kind: "internal_identifier", re: /\beyJ[A-Za-z0-9_-]{10,}\./ },
  { kind: "internal_identifier", re: /\bpostgres(?:ql)?:\/\/\S+/i },

  // ── internal telemetry ──
  { kind: "internal_timestamp", re: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/ },
];

/** Longest public message. A caller-readable sentence, not a log line. */
export const MAX_MESSAGE_CHARS = 200;

/**
 * Report every leak class present in a string. Returns an empty array for a
 * clean string — and the gate proves the non-empty branch works too.
 */
export function leakScan(text: string): LeakKind[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const found = new Set<LeakKind>();
  if (text.length > MAX_MESSAGE_CHARS) found.add("oversized");
  for (const rule of LEAK_RULES) {
    // `re` carries no /g flag, so lastIndex never persists across calls.
    if (rule.re.test(text)) found.add(rule.kind);
  }
  return [...found].sort();
}

/**
 * Reduce arbitrary text to something publishable.
 *
 * Newlines collapse to spaces, every leak rule is replaced with `[redacted]`,
 * the result is truncated, and — the important part — if anything still leaks
 * after redaction the caller's code default is returned instead. A caller can
 * therefore never talk its way past the discipline by being creative.
 */
export function sanitizePublicMessage(text: string, code: FailureCode): string {
  const fallback = PUBLIC_MESSAGE[code];
  if (typeof text !== "string") return fallback;
  let out = text.replace(/\s+/g, " ").trim();
  if (out.length === 0) return fallback;
  for (const rule of LEAK_RULES) {
    if (rule.re.test(out)) out = out.replace(new RegExp(rule.re.source, "gi"), "[redacted]");
  }
  out = out.slice(0, MAX_MESSAGE_CHARS).trim();
  if (leakScan(out).length > 0) return fallback;
  // A message that is nothing but redaction markers carries no information.
  if (out.replace(/\[redacted\]/g, "").trim().length === 0) return fallback;
  return out;
}

// ── requestId ─────────────────────────────────────────────────────────────────

const REQUEST_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * A fresh opaque correlation token. Never derived from customer data.
 *
 * Prefixed and base64url-encoded rather than a bare UUID, because a UUID is on
 * the leak rules as an internal identifier — a generated token that its own
 * validator rejects is worse than no validator.
 */
export function newRequestId(): string {
  return `svreq_${randomBytes(16).toString("base64url")}`;
}

/**
 * Accept a caller-supplied correlation token only if it is already opaque.
 * Anything that looks like a phone number, an email or an internal key is
 * replaced rather than echoed.
 */
export function normaliseRequestId(candidate?: string | null): string {
  if (typeof candidate !== "string") return newRequestId();
  const trimmed = candidate.trim();
  if (!REQUEST_ID_RE.test(trimmed)) return newRequestId();
  // A token that trips any leak rule is an internal identifier wearing a hat.
  if (leakScan(trimmed).length > 0) return newRequestId();
  return trimmed;
}

/** True when the token is opaque enough to put in a response body. */
export function requestIdIsOpaque(requestId: string): boolean {
  return REQUEST_ID_RE.test(requestId) && leakScan(requestId).length === 0;
}

// ── The envelope and its HTTP projection ──────────────────────────────────────

/** Exactly five fields. Nothing else ever reaches a caller. */
export type FailureEnvelope = {
  code: FailureCode;
  message: string;
  retryable: boolean;
  requestId: string;
  docsUrl: string;
};

/**
 * `Retry-After` lives in a header, not in the body, so the envelope stays at
 * five fields. The body says whether a retry is worthwhile; the header says
 * when.
 */
export type Failure = {
  status: number;
  headers: Record<string, string>;
  body: FailureEnvelope;
  retryAfterSec: number | null;
  /** Caller-safe summary for logs — the full internal error never goes here. */
  detail: string;
};

export type FailureInit = {
  requestId?: string | null;
  retryAfterSec?: number;
  /**
   * A short, caller-safe clarification appended to the public message. It is
   * redacted and length-capped; if it cannot be made safe it is dropped.
   */
  detail?: string;
};

const DOCS_BASE = (() => {
  const raw = process.env.FAILURE_DOCS_BASE_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : "https://docs.securevoice.ai/errors";
})();

export function docsUrlFor(code: FailureCode): string {
  return `${DOCS_BASE}/${code}`;
}

export function statusForCode(code: FailureCode): number {
  return STATUS_DISCIPLINE[code].status;
}

export function isRetryable(code: FailureCode): boolean {
  return STATUS_DISCIPLINE[code].retryable;
}

/** Clamp a Retry-After into a range a client will actually honour. */
function normaliseRetryAfter(seconds?: number): number | null {
  if (seconds === undefined || !Number.isFinite(seconds)) return null;
  return Math.min(3600, Math.max(1, Math.round(seconds)));
}

/**
 * Build a failure. `init.retryAfterSec` is mandatory in effect for any code
 * whose rule says `retryAfter: true`; omitting it yields the 1 s default rather
 * than a 503 with no guidance, which clients read as "not now, maybe later".
 */
export function makeFailure(code: FailureCode, init: FailureInit = {}): Failure {
  const rule = STATUS_DISCIPLINE[code];
  if (rule === undefined) throw new RangeError(`unknown failure code: ${String(code)}`);

  const requestId = normaliseRequestId(init.requestId);
  const base = PUBLIC_MESSAGE[code];
  let message = base;
  if (typeof init.detail === "string" && init.detail.trim().length > 0) {
    // The composed message must still fit the publishable budget, so the
    // detail gets whatever room the fixed base leaves and no more.
    const budget = MAX_MESSAGE_CHARS - base.length - 1;
    if (budget > 0) {
      const clean = sanitizePublicMessage(init.detail.slice(0, budget), code);
      if (clean.length > 0 && clean.length <= budget) message = `${base} ${clean}`;
    }
  }
  // Final guard: a composed message that still trips the scanner is not sent.
  if (leakScan(message).length > 0) message = base;

  const declared = normaliseRetryAfter(init.retryAfterSec);
  const retryAfterSec = rule.retryAfter ? (declared ?? 1) : declared;

  const headers: Record<string, string> = { "x-request-id": requestId };
  if (retryAfterSec !== null) headers["Retry-After"] = String(retryAfterSec);

  return {
    status: rule.status,
    headers,
    body: {
      code,
      message,
      retryable: rule.retryable,
      requestId,
      docsUrl: docsUrlFor(code),
    },
    retryAfterSec,
    detail: init.detail ?? "",
  };
}

/**
 * `{ status, headers }` for `NextResponse.json(failure.body, init)` — and for
 * the helpers in `api-errors.ts`, which take the same shape of arguments.
 */
export function responseInitFor(failure: Failure): { status: number; headers: Record<string, string> } {
  return { status: failure.status, headers: failure.headers };
}

/** Every leak class present in a built failure. Empty means publishable. */
export function scanFailure(failure: Failure): LeakKind[] {
  const kinds = new Set<LeakKind>([
    ...leakScan(failure.body.message),
    ...leakScan(failure.body.code),
    ...leakScan(failure.body.docsUrl),
  ]);
  return [...kinds].sort();
}

// ── Typed constructors ────────────────────────────────────────────────────────
//
// One per row of the discipline table. Each owns its public message; a caller
// supplies at most a short `detail`.

export const malformedRequest = (init?: FailureInit): Failure => makeFailure("malformed_request", init);
export const unauthenticated = (init?: FailureInit): Failure => makeFailure("unauthenticated", init);
export const notFound = (init?: FailureInit): Failure => makeFailure("not_found", init);

/**
 * A row belonging to another tenant.
 *
 * Returns the `not_found` body VERBATIM — same code, same message, same
 * docsUrl, same status — and DROPS any caller-supplied `detail`.
 *
 * Both halves matter. There is deliberately no `cross_tenant` code and no 403:
 * both would tell a prober the foreign identifier exists, which is the one
 * thing a cross-tenant 404 exists to deny. And a detail is dropped for the same
 * reason — a detail is what makes two otherwise-identical 404 bodies differ, so
 * this constructor is the one place a caller may not add one. The distinction
 * belongs in the caller's log line, never in the response.
 *
 * The constructor exists so the intent is legible at the call site.
 */
export const crossTenantNotFound = (init?: FailureInit): Failure =>
  makeFailure("not_found", { requestId: init?.requestId, retryAfterSec: init?.retryAfterSec });

/** The code a cross-tenant row is reported under. Asserted by the gate. */
export const CROSS_TENANT_CODE: FailureCode = "not_found";

export const stateConflict = (init?: FailureInit): Failure => makeFailure("state_conflict", init);
export const uniqueConflict = (init?: FailureInit): Failure => makeFailure("unique_conflict", init);
export const payloadTooLarge = (init?: FailureInit): Failure => makeFailure("payload_too_large", init);
export const semanticallyInvalid = (init?: FailureInit): Failure => makeFailure("semantically_invalid", init);
export const internalBug = (init?: FailureInit): Failure => makeFailure("internal_bug", init);

/** 409, never 500. The single constructor for "the policy gate said no". */
export const policyPrecondition = (init?: FailureInit): Failure => makeFailure("policy_precondition", init);

/**
 * 409 naming the FIELD, never the value. A `23503` from Postgres reads
 * `Key (orgId)=(org_9f2…) is not present in table "Case"`; the value is another
 * tenant's business and the table name is ours. `field` is the only part that
 * crosses the boundary.
 */
export const referenceConflict = (field: string, init?: FailureInit): Failure =>
  makeFailure("reference_conflict", { ...init, detail: `Unusable field: ${assertFieldName(field)}.` });

/** 409, `retryable: true` — the transaction lost a race, the data is intact. */
export const transactionContended = (init?: FailureInit): Failure => makeFailure("transaction_contended", init);

/**
 * 409, not 503. Refusing an intervention we cannot durably record is a state
 * precondition; a Retry-After would invite the caller back into the same
 * refusal while the fraud continues. The detail names the channel a human
 * should use instead.
 */
export const interventionRefused = (detail: string, init?: FailureInit): Failure =>
  makeFailure("intervention_refused_degraded", { ...init, detail });

export const rateLimited = (retryAfterSec: number, init?: FailureInit): Failure =>
  makeFailure("rate_limited", { ...init, retryAfterSec });

/** 503 + Retry-After. Load we are shedding, not an outage to report. */
export const shedLoad = (retryAfterSec: number, init?: FailureInit): Failure =>
  makeFailure("db_capacity_shed", { ...init, retryAfterSec });

export const statementTimeout = (retryAfterSec: number, init?: FailureInit): Failure =>
  makeFailure("statement_timeout", { ...init, retryAfterSec });

export const dependencyUnavailable = (retryAfterSec: number, init?: FailureInit): Failure =>
  makeFailure("dependency_unavailable", { ...init, retryAfterSec });

/**
 * Fail fast on anything that is not a schema field name. The FK handler feeds
 * this a token extracted from a driver error, and a driver that surprises us
 * must produce a loud refusal rather than a silently published identifier.
 */
export function assertFieldName(field: unknown): string {
  const raw = typeof field === "string" ? field.trim() : "";
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(raw)) throw new RangeError("unsafe field name");
  return raw;
}

// ── Policy refusals ───────────────────────────────────────────────────────────

/**
 * The refusal codes `policy-gate.ts` emits today. Listed exhaustively on
 * purpose: an unmapped code is a bug, and the correct response to a bug in the
 * refusal path is a loud `RangeError` at the boundary — never a 500 dressed up
 * as a policy answer, and never a silent 200.
 */
export const POLICY_REFUSAL_CODES = [
  "consent_invalid",
  "country_unparseable",
  "country_not_allowed",
  "cooldown",
  "concurrency_cap",
  "spend_ceiling",
  "credits_exhausted",
] as const;
export type PolicyRefusalCode = (typeof POLICY_REFUSAL_CODES)[number];

export type PolicyRefusal = { ok: false; code: string; reason: string };

/**
 * Map a policy-gate refusal onto the envelope. ALWAYS 409.
 *
 * The negative control for WP-21 is this line: a policy refusal is a decision,
 * not a fault, so it can never surface as a 500 — a 500 would tell the bank
 * "retry", and a retry would be refused again for the same reason.
 */
export function policyRefusal(refusal: PolicyRefusal, init?: FailureInit): Failure {
  const known = (POLICY_REFUSAL_CODES as readonly string[]).includes(refusal?.code ?? "");
  if (!known) {
    throw new RangeError(`unmapped policy refusal code: ${String(refusal?.code)}`);
  }
  const failure = makeFailure("policy_precondition", { ...init, detail: refusal.reason });
  // Belt and braces: the map says 409 and the constructor says 409. If either
  // is ever edited, this throws rather than shipping the wrong status.
  if (failure.status !== 409) throw new Error("policy refusal must be 409");
  return failure;
}
