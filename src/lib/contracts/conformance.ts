/**
 * Self-serve conformance checker (WP-17).
 *
 * A bank's receiver is CUSTOMER CODE. Every statement in
 * `docs/INTEGRATION-CONTRACT.md` about what a receiver must do is therefore a
 * claim we cannot verify by shipping a fix — the wrong implementation lives in
 * someone else's repository. This module is the part we CAN do: fire signed
 * probes at the receiver a bank nominates and grade the answers, so a bank can
 * attach a machine-generated score to their change record instead of filing a
 * ticket.
 *
 * ── Three properties this module is built to have ──────────────────────────
 *
 * 1. **It cannot make a network call of its own.** `runConformance` takes a
 *    `transport` parameter and there is no default. There is no module-level
 *    `fetch` reference anywhere in this file. A test that wants to grade a fake
 *    receiver supplies a fake transport, and the type system refuses to let a
 *    caller forget. This is the difference between "tests mock fetch" and "the
 *    checker is not capable of reaching the internet without being handed a way
 *    to", and it is why this is a parameter rather than a dependency-injection
 *    container that could fall back to the global.
 *
 * 2. **A blocked target never dials out.** The SSRF verdict runs BEFORE any
 *    transport is constructed, in `handleConformanceRun`. A refused target
 *    returns the `semantically_invalid` refusal — which the shared failure
 *    envelope renders as a 422 — carrying the verdict's own reason in `detail`,
 *    and issues zero probes. The transport is never called even once, which is
 *    what the gate asserts for twenty different blocked targets.
 *
 * 3. **Signing is the production signing.** The probes are signed by
 *    `signPayload` from `src/lib/outbox.ts` — the same function that signs a
 *    real delivery — and the body is the same `canonicalJson`. A probe that is
 *    "signed the way the docs say" rather than "signed the way we sign" would
 *    grade a bank against a scheme we do not actually use.
 *
 * Deliberately NOT a full test harness: it does not drive TLS, retries, or
 * ordering, and it never claims a receiver is correct — only that five named
 * properties hold.
 */

import { randomUUID } from "node:crypto";

import { canonicalJson, signPayload } from "@/lib/outbox";
import type { FailureCode } from "@/lib/failures/envelope";

import {
  OUTBOUND_SCHEMA_VERSION,
  REPLAY_WINDOW_SECONDS,
  SIGNATURE_HEADER,
} from "./schema";

/* ──────────────────────────────────────────────────────────────────────────
 * The graded checks
 * ────────────────────────────────────────────────────────────────────────── */

export const CONFORMANCE_CHECK_IDS = [
  "signature_verified",
  "idempotency_honoured",
  "fast_2xx",
  "replay_handled",
  "rejects_malformed",
] as const;

export type ConformanceCheckId = (typeof CONFORMANCE_CHECK_IDS)[number];

export const CONFORMANCE_REPORT_VERSION = "1.0";

/**
 * The normative sentence each check grades against.
 *
 * These are printed in the report, so a bank that fails a check reads the
 * requirement and the fix rather than a verdict. Every sentence is written to
 * be satisfiable by an ordinary idempotent HTTPS receiver with no SecureVoice
 * library installed — that is the point of "self-serve".
 */
export const CONFORMANCE_REQUIREMENTS: Readonly<Record<ConformanceCheckId, string>> = {
  signature_verified:
    "Verify SV-Signature over the RAW request bytes before acting. A request with a tampered digest or no signature at all MUST be refused with a 4xx.",
  idempotency_honoured:
    "Key your dedupe store on event_id and acknowledge the event you accepted, by echoing event_id in the response body or in the `x-securevoice-event-id` header.",
  fast_2xx: "Return a 2xx for a well-formed delivery within the stated budget, then do the work asynchronously. A slow 2xx is a lost event, not a delayed one.",
  replay_handled:
    "A redelivery of an event_id you have already applied MUST NOT be applied again. Mark the redelivery with `duplicate: true` in the response body, or the `X-Securevoice-Duplicate: true` header (aliases: `idempotent_replay`, `replayed`, `already_applied`).",
  rejects_malformed:
    "A correctly SIGNED but schema-invalid payload MUST be refused with a 4xx, not acknowledged with a 2xx. Acknowledging what you cannot process loses it silently.",
};

/**
 * Response markers that mean "this redelivery was recognised and deliberately
 * NOT re-applied". Several spellings are accepted on purpose: a bank should not
 * have to guess our exact vocabulary to be graded as correct.
 */
export const DUPLICATE_BODY_MARKERS = [
  "duplicate",
  "idempotent_replay",
  "replayed",
  "already_applied",
] as const;

/** Response headers that may carry the acknowledged event id. */
export const EVENT_ID_ECHO_HEADERS = ["x-securevoice-event-id", "x-event-id"] as const;

/** Header we add to conformance deliveries so a bank can find and drop them. */
export const CONFORMANCE_RUN_HEADER = "x-securevoice-conformance-run";

/* ──────────────────────────────────────────────────────────────────────────
 * Transport
 * ────────────────────────────────────────────────────────────────────────── */

export type ProbeKind = "valid_delivery" | "replay" | "tampered_signature" | "unsigned" | "malformed";

export type TransportRequest = {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  /** The exact bytes transmitted. The signature covers these and only these. */
  readonly body: string;
};

export type TransportResponse = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
  /**
   * Measured by the transport, not by the checker. A fake returns the value it
   * wants to assert against, so "slow 2xx" is testable without a 2 s sleep.
   */
  readonly latencyMs: number;
};

export type ConformanceTransport = (request: TransportRequest) => Promise<TransportResponse>;

/* ──────────────────────────────────────────────────────────────────────────
 * Report shape
 * ────────────────────────────────────────────────────────────────────────── */

export type ProbeObservation = {
  readonly seq: number;
  readonly kind: ProbeKind;
  /** 0 when the transport threw — no response was received. */
  readonly status: number;
  readonly latencyMs: number;
  readonly signed: boolean;
  readonly event_id: string;
  /** Whether the response carried a recognised idempotency marker. Null = unparseable body. */
  readonly duplicate_marker: boolean | null;
  readonly event_id_echoed: boolean;
  /** Truncated transport error, for a report a human will read. */
  readonly error?: string;
};

export type ConformanceCheckResult = {
  readonly id: ConformanceCheckId;
  readonly title: string;
  readonly status: "pass" | "fail";
  readonly observed: string;
  readonly requirement: string;
};

export type ConformanceReport = {
  readonly report_version: string;
  readonly run_id: string;
  readonly generated_at: string;
  readonly target: { readonly url: string; readonly host: string };
  readonly budget_ms: number;
  readonly checks: readonly ConformanceCheckResult[];
  readonly score: {
    readonly passed: number;
    readonly total: number;
    readonly percent: number;
    readonly verdict: "conforming" | "non_conforming";
  };
  readonly probes: readonly ProbeObservation[];
  readonly notes: readonly string[];
};

/* ──────────────────────────────────────────────────────────────────────────
 * Probe construction
 * ────────────────────────────────────────────────────────────────────────── */

/** The Crockford-ish alphabet makeCaseRef() uses, so a probe caseRef is well-formed. */
const CASE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function probeCaseRef(runId: string): string {
  const hex = runId.replace(/[^0-9a-fA-F]/g, "");
  let out = "";
  for (let i = 0; i < 6; i++) {
    const pair = hex.slice(i * 2, i * 2 + 2);
    const value = pair.length === 2 ? Number.parseInt(pair, 16) : 0;
    out += CASE_ALPHABET[(Number.isFinite(value) ? value : 0) % CASE_ALPHABET.length];
  }
  return `SV-F-${out}`;
}

/**
 * The probe payload: a VALID `case.notified` event.
 *
 * Schema-valid on purpose. A conforming receiver must accept it, so if it does
 * not, the receiver is wrong — and a probe that violated the schema would test
 * the wrong thing. `outcome: "conformance_probe"` makes it unmistakable in the
 * bank's own logs without inventing a field.
 */
function buildProbeEnvelope(input: {
  eventId: string;
  caseRef: string;
  orgId: string | null;
  nowIso: string;
}): Record<string, unknown> {
  return {
    schema_version: OUTBOUND_SCHEMA_VERSION,
    event_id: input.eventId,
    event_type: "case.notified",
    case_ref: input.caseRef,
    org_id: input.orgId,
    occurred_at: input.nowIso,
    data: {
      state: "NOTIFIED",
      outcome: "conformance_probe",
      duration_seconds: 0,
      freeze_staged: false,
      freeze_reference: null,
      handoff_queued: false,
      handoff_specialist: null,
      tool_calls_observed: 0,
      audit_ref: input.caseRef,
      evidence: {
        transcript: "withheld",
        note: "SecureVoice conformance probe — a synthetic event, no case and no customer exist behind it.",
      },
    },
  };
}

/** A correctly SIGNED envelope whose `data` is a string: unambiguously invalid. */
function buildMalformedEnvelope(input: { eventId: string; caseRef: string; nowIso: string }): Record<string, unknown> {
  return {
    schema_version: OUTBOUND_SCHEMA_VERSION,
    event_id: input.eventId,
    event_type: "case.notified",
    case_ref: input.caseRef,
    org_id: null,
    occurred_at: input.nowIso,
    data: "this must be an object",
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Response inspection
 * ────────────────────────────────────────────────────────────────────────── */

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isTruthyMarker(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1" || value === "yes";
}

function hasDuplicateMarker(res: TransportResponse): boolean | null {
  const header = res.headers["x-securevoice-duplicate"];
  if (header !== undefined && isTruthyMarker(header)) return true;
  const body = parseJson(res.body);
  if (!body) return null;
  for (const marker of DUPLICATE_BODY_MARKERS) {
    if (isTruthyMarker(body[marker])) return true;
  }
  return false;
}

function echoedEventId(res: TransportResponse, sent: string): boolean {
  const body = parseJson(res.body);
  if (body && body.event_id === sent) return true;
  for (const header of EVENT_ID_ECHO_HEADERS) {
    if (res.headers[header] === sent) return true;
  }
  return false;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function isClientError(status: number): boolean {
  return status >= 400 && status < 500;
}

function truncate(value: string, max = 160): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/* ──────────────────────────────────────────────────────────────────────────
 * The checker
 * ────────────────────────────────────────────────────────────────────────── */

export type RunConformanceOptions = {
  readonly receiverUrl: string;
  /** The secret the BANK'S RECEIVER verifies with. Never logged, never reported. */
  readonly secret: string;
  readonly transport: ConformanceTransport;
  readonly budgetMs?: number;
  /** Echoed as `org_id` on every probe. The checker is not tenant-scoped. */
  readonly orgId?: string | null;
  readonly now?: () => number;
  readonly newRunId?: () => string;
};

export const DEFAULT_BUDGET_MS = 2000;
export const MIN_BUDGET_MS = 100;
export const MAX_BUDGET_MS = 10_000;

/**
 * Fire the probes and grade the answers.
 *
 * @throws never for a bad receiver: a connection refusal, a 500, a malformed
 * response body and a hanging receiver all produce a report with failing
 * checks. The only way this throws is a programming error in the probe
 * construction, which should surface in a test rather than as a bank-facing
 * 500 with no report.
 */
export async function runConformance(opts: RunConformanceOptions): Promise<ConformanceReport> {
  const now = opts.now ?? Date.now;
  const newRunId = opts.newRunId ?? randomUUID;
  const budgetMs = Math.min(MAX_BUDGET_MS, Math.max(MIN_BUDGET_MS, opts.budgetMs ?? DEFAULT_BUDGET_MS));
  const runId = newRunId();
  const nowIso = new Date(now()).toISOString();
  const notes: string[] = [];
  let url: URL;
  try {
    url = new URL(opts.receiverUrl);
  } catch {
    throw new Error("receiverUrl must be an absolute URL (the SSRF verdict runs before this function)");
  }

  const caseRef = probeCaseRef(runId);
  const primaryEventId = randomUUID();
  const nowSec = Math.floor(now() / 1000);

  // ── Probe bodies, signed with the production signer ──
  const validEnvelope = buildProbeEnvelope({
    eventId: primaryEventId,
    caseRef,
    orgId: opts.orgId ?? null,
    nowIso,
  });
  const validBody = canonicalJson(validEnvelope);

  const malformedBody = canonicalJson(
    buildMalformedEnvelope({ eventId: randomUUID(), caseRef, nowIso }),
  );

  /**
   * The replay probe is RE-SIGNED with a fresh timestamp and an identical body,
   * which is exactly what the retry ladder does. A receiver that dedupes on the
   * signature string rather than on `event_id` fails this, and should: the
   * signature changes on every real retry.
   */
  const replayTimestamp = nowSec + 1;

  const tamperedSignature = (() => {
    const signed = signPayload(validBody, nowSec, opts.secret);
    const v1 = signed.slice(signed.indexOf("v1=") + 3);
    const flipped = v1[0] === "0" ? "1" : "0";
    return `t=${nowSec},v1=${flipped}${v1.slice(1)}`;
  })();

  const probes: Array<{ kind: ProbeKind; body: string; signature: string | null; eventId: string }> = [
    {
      kind: "valid_delivery",
      body: validBody,
      signature: signPayload(validBody, nowSec, opts.secret),
      eventId: primaryEventId,
    },
    { kind: "replay", body: validBody, signature: signPayload(validBody, replayTimestamp, opts.secret), eventId: primaryEventId },
    { kind: "tampered_signature", body: validBody, signature: tamperedSignature, eventId: primaryEventId },
    { kind: "unsigned", body: validBody, signature: null, eventId: primaryEventId },
    { kind: "malformed", body: malformedBody, signature: signPayload(malformedBody, nowSec, opts.secret), eventId: randomUUID() },
  ];

  const observations: ProbeObservation[] = [];

  for (const [index, probe] of probes.entries()) {
    const seq = index + 1;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      [CONFORMANCE_RUN_HEADER]: runId,
    };
    if (probe.signature) headers[SIGNATURE_HEADER] = probe.signature;

    const startedAt = now();
    let response: TransportResponse;
    try {
      response = await opts.transport({
        url: url.toString(),
        method: "POST",
        headers,
        body: probe.body,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      observations.push({
        seq,
        kind: probe.kind,
        status: 0,
        latencyMs: now() - startedAt,
        signed: probe.signature !== null,
        event_id: probe.eventId,
        duplicate_marker: null,
        event_id_echoed: false,
        error: truncate(message),
      });
      notes.push(`probe ${seq} (${probe.kind}) never produced a response: ${truncate(message)}`);
      continue;
    }

    observations.push({
      seq,
      kind: probe.kind,
      status: response.status,
      latencyMs: response.latencyMs,
      signed: probe.signature !== null,
      event_id: probe.eventId,
      duplicate_marker: probe.kind === "replay" ? hasDuplicateMarker(response) : null,
      event_id_echoed:
        probe.kind === "valid_delivery" || probe.kind === "replay"
          ? echoedEventId(response, probe.eventId)
          : false,
    });
  }

  const byKind = (kind: ProbeKind): ProbeObservation | undefined => observations.find((p) => p.kind === kind);
  const valid = byKind("valid_delivery");
  const replay = byKind("replay");
  const tampered = byKind("tampered_signature");
  const unsigned = byKind("unsigned");
  const malformed = byKind("malformed");

  const missing = (kind: ProbeKind, obs: ProbeObservation | undefined): string =>
    `no response was received for the ${kind} probe`;
  const describe = (obs: ProbeObservation | undefined): string =>
    obs ? `HTTP ${obs.status} in ${obs.latencyMs}ms` : "no response";

  const checks: ConformanceCheckResult[] = [
    {
      id: "signature_verified",
      title: "Signature verified",
      status: tampered && unsigned && isClientError(tampered.status) && isClientError(unsigned.status) ? "pass" : "fail",
      observed: `tampered digest → ${describe(tampered)}; unsigned → ${describe(unsigned)}`,
      requirement: CONFORMANCE_REQUIREMENTS.signature_verified,
    },
    {
      id: "idempotency_honoured",
      title: "Idempotency honoured",
      status: valid && valid.status > 0 && valid.event_id_echoed ? "pass" : "fail",
      observed: valid
        ? valid.event_id_echoed
          ? `accepted and acknowledged event_id ${primaryEventId} (${describe(valid)})`
          : `${describe(valid)} but the response never identified the event_id it applied, so its dedupe key is unverifiable`
        : missing("valid_delivery", valid),
      requirement: CONFORMANCE_REQUIREMENTS.idempotency_honoured,
    },
    {
      id: "fast_2xx",
      title: "2xx within budget",
      status:
        valid && isSuccess(valid.status) && valid.latencyMs <= budgetMs
          ? "pass"
          : "fail",
      observed: valid
        ? isSuccess(valid.status)
          ? `${valid.status} in ${valid.latencyMs}ms against a ${budgetMs}ms budget`
          : `expected a 2xx for a well-formed delivery, got ${valid.status}`
        : missing("valid_delivery", valid),
      requirement: CONFORMANCE_REQUIREMENTS.fast_2xx,
    },
    {
      id: "replay_handled",
      title: "Replay handled",
      status: replay && isSuccess(replay.status) && replay.duplicate_marker === true ? "pass" : "fail",
      observed: replay
        ? replay.status === 0
          ? `the redelivery of event_id ${primaryEventId} produced no response`
          : isSuccess(replay.status) && replay.duplicate_marker !== true
            ? `${describe(replay)} with no idempotency marker — the redelivery was acknowledged as if it were new, so a receiver like this applies the event twice`
            : replay.duplicate_marker === true
              ? `${describe(replay)}, redelivery recognised and not re-applied`
              : `${describe(replay)} — a redelivery answered with ${replay.status}, which stops our retry ladder`
        : missing("replay", replay),
      requirement: CONFORMANCE_REQUIREMENTS.replay_handled,
    },
    {
      id: "rejects_malformed",
      title: "Malformed payload rejected",
      status: malformed && isClientError(malformed.status) ? "pass" : "fail",
      observed: malformed
        ? isClientError(malformed.status)
          ? `${describe(malformed)} — a signed but schema-invalid payload was refused`
          : `${describe(malformed)} — a signed but schema-invalid payload was ACKNOWLEDGED, so anything you cannot parse enters your systems silently`
        : missing("malformed", malformed),
      requirement: CONFORMANCE_REQUIREMENTS.rejects_malformed,
    },
  ];

  const passed = checks.filter((c) => c.status === "pass").length;
  const total = checks.length;
  const observedAttempts = new Set(observations.map((o) => `${o.kind}:${o.event_id}`)).size;
  notes.push(
    `Every probe except the replay pair carries a fresh event_id, so re-running this checker does not collide with a previous run's dedupe entries (${observedAttempts} distinct event ids across ${probes.length} probes).`,
  );
  notes.push(
    `Probes are tagged with the ${CONFORMANCE_RUN_HEADER} header and the outcome "conformance_probe" so they can be identified and dropped in a non-production environment.`,
  );
  notes.push(
    `Signatures use a ${REPLAY_WINDOW_SECONDS}s replay window, so a receiver clock more than ${REPLAY_WINDOW_SECONDS / 60} minutes out will fail signature_verified for reasons unrelated to its implementation.`,
  );
  if (observations.some((o) => o.status === 0)) {
    notes.push("At least one probe never got a response — check reachability and TLS before reading the individual checks.");
  }

  return {
    report_version: CONFORMANCE_REPORT_VERSION,
    run_id: runId,
    generated_at: nowIso,
    target: { url: url.toString(), host: url.host },
    budget_ms: budgetMs,
    checks,
    score: {
      passed,
      total,
      percent: Math.round((passed / total) * 100),
      verdict: passed === total ? "conforming" : "non_conforming",
    },
    probes: observations,
    notes,
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Request-shaped entry point
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Structural mirror of `UrlVerdict` in src/lib/validation/ssrf.ts. Declared
 * structurally rather than imported so this module stays free of DNS — the
 * conformance route injects the real guard, tests inject a verdict directly.
 */
export type UrlVerdictLike =
  | { ok: true; url: URL; addresses: readonly string[] }
  | { ok: false; code: string; reason: string; host?: string };

export type AuthOutcome = { ok: true; callerId: string; orgId: string | null } | { ok: false; reason: string };

export type ConformanceDeps = {
  /** Required. There is no default and no fallback to the global fetch. */
  readonly transport: ConformanceTransport;
  /** The real `validateOutboundUrl` in production. */
  readonly validateUrl: (raw: string) => Promise<UrlVerdictLike>;
  /** The real `verifyProducerKey` in production. */
  readonly authenticate: () => Promise<AuthOutcome>;
  /** Returns a retry-after in seconds, or null when the caller may proceed. */
  readonly rateLimit: (callerId: string) => { ok: true } | { ok: false; retryAfterSec: number };
  readonly now?: () => number;
  readonly newRunId?: () => string;
};

/**
 * A refusal.
 *
 * It carries a `FailureCode` from `src/lib/failures/envelope.ts` — the SAME
 * codes the ingest returns — rather than a bespoke `conformance_*` vocabulary.
 * Inventing a parallel error namespace for one endpoint would mean a producer's
 * retry logic branches on the shape of the URL they happen to be calling, and
 * the codes for "you sent me nonsense" and "you sent me nonsense at a different
 * endpoint" would be identical strings with different semantics. The status is
 * derived by the route from `STATUS_DISCIPLINE`, so a code can never be paired
 * with the wrong status.
 */
export type ConformanceRefusal = {
  readonly code: FailureCode;
  readonly detail: string;
  readonly retryAfterSec?: number;
};

export type ConformanceOutcome =
  | { readonly kind: "report"; readonly report: ConformanceReport }
  | { readonly kind: "refused"; readonly refusal: ConformanceRefusal };

export type ConformanceRunInput = {
  readonly receiver_url?: unknown;
  readonly secret?: unknown;
  readonly budget_ms?: unknown;
  readonly org_id?: unknown;
};

/**
 * Validate, authorise, rate-limit, SSRF-check, then grade. In that order.
 *
 * The order is the security property: the cheapest rejections happen first, and
 * the SSRF verdict — the only thing standing between an authenticated caller and
 * our deployment POSTing to an arbitrary URL — runs before the transport is
 * ever touched.
 */
export async function handleConformanceRun(
  input: ConformanceRunInput,
  deps: ConformanceDeps,
): Promise<ConformanceOutcome> {
  const receiverUrl = typeof input.receiver_url === "string" ? input.receiver_url.trim() : "";
  const secret = typeof input.secret === "string" ? input.secret : "";
  if (!receiverUrl || secret.length < 8) {
    return {
      kind: "refused",
      refusal: {
        code: "malformed_request",
        detail: "receiver_url and a secret of at least 8 characters are required",
      },
    };
  }

  const auth = await deps.authenticate();
  if (!auth.ok) {
    return {
      kind: "refused",
      refusal: { code: "unauthenticated", detail: `conformance runs require a producer key: ${auth.reason}` },
    };
  }

  const limit = deps.rateLimit(auth.callerId);
  if (!limit.ok) {
    return {
      kind: "refused",
      refusal: { code: "rate_limited", detail: "too many conformance runs", retryAfterSec: limit.retryAfterSec },
    };
  }

  const verdict = await deps.validateUrl(receiverUrl);
  if (!verdict.ok) {
    return {
      kind: "refused",
      refusal: {
        code: "semantically_invalid",
        detail: `receiver_url refused by the outbound URL policy: ${verdict.code} — ${verdict.reason}`,
      },
    };
  }

  const budgetMs =
    typeof input.budget_ms === "number" && Number.isFinite(input.budget_ms)
      ? input.budget_ms
      : DEFAULT_BUDGET_MS;

  const report = await runConformance({
    receiverUrl: verdict.url.toString(),
    secret,
    transport: deps.transport,
    budgetMs,
    orgId: typeof input.org_id === "string" && input.org_id.trim() ? input.org_id.trim() : null,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.newRunId ? { newRunId: deps.newRunId } : {}),
  });

  return { kind: "report", report };
}
