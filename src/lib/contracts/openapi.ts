/**
 * OpenAPI 3.1 document generator (WP-17).
 *
 * Built from `schema.ts`, never hand-written. A hand-written OpenAPI document is
 * a copy of the code that starts diverging the minute the code changes and is
 * still published afterwards, because nothing notices — which is how integrators
 * end up sending `amount_aed` to an endpoint that wants `amount` and getting a
 * 422 that the spec never mentioned.
 *
 * OpenAPI 3.1 (not 3.0.x) because the schemas here are JSON Schema 2020-12:
 * `const`, `examples` on schemas and full JSON Schema keywords. 3.0's dialect
 * would need them downgraded.
 *
 * Served at `GET /openapi`. The brief named `/openapi.json`; the app-router
 * route path is fixed by the directory name (`src/app/openapi/route.ts`), and
 * the work package's allowed-paths list does not permit adding a sibling
 * `src/app/openapi.json/` route. Serving it from a second path would also create
 * a second copy to keep in sync — the exact drift risk this file exists to
 * remove — so there is ONE canonical URL and it is stated in the document's own
 * description.
 */

import {
  ADMISSION_BANDS,
  APP_INGEST_PATH,
  BANK_EVENT_FIELDS,
  CASE_NOTIFIED_DATA_FIELDS,
  CONFORMANCE_PATH,
  DATA_MINIMISATION,
  DELIVERY_FIELDS,
  DEGRADED_FIELDS,
  ERROR_CODES,
  EVIDENCE_FIELDS,
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_MIN_LENGTH,
  IDEMPOTENCY_TTL_HOURS,
  INBOUND_SIGNATURE_HEADERS,
  INTERVENTION_DEGRADED_FIELDS,
  INTERVENTION_QUEUED_FIELDS,
  MAX_DELIVERY_ATTEMPTS,
  OUTBOUND_SCHEMA_VERSION,
  PUBLIC_INGEST_PATH,
  REPLAY_RESPONSE_HEADER,
  REPLAY_WINDOW_SECONDS,
  RETIRED_INGEST_PATH,
  RISK_SIGNAL_FIELDS,
  SIGNATURE_SCHEME,
  STATUS_FAILURES,
  bodyErrorCodes,
  failureEnvelopeCodes,
  type FieldSpec,
  type JsonSchema,
} from "./schema";
import {
  CONFORMANCE_CHECK_IDS,
  CONFORMANCE_REPORT_VERSION,
  CONFORMANCE_REQUIREMENTS,
} from "./conformance";
import { DELIVERY_ATTEMPT_LADDER_MS, EVENT_TYPES } from "./asyncapi";
// The envelope's full code vocabulary. Imported here — rather than duplicated as
// a constant in `schema.ts` — so the published `code` enum cannot drift from the
// codes `makeFailure` is actually able to produce.
import { FAILURE_CODES, FAILURE_DOCS_BASE } from "@/lib/failures/envelope";

/** Convert a field list into a JSON Schema object. */
/** The documented ingest operation label, matching the catalog's `reachedFrom`. */
const INGEST = `POST ${PUBLIC_INGEST_PATH}`;
const CONFORMANCE_OP = `POST ${CONFORMANCE_PATH}`;

function objectSchema(
  fields: readonly FieldSpec[],
  opts: { strict?: boolean; title?: string; description?: string } = {},
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const field of fields) {
    const node: JsonSchema = { type: field.type, description: field.description };
    if (field.format) node.format = field.format;
    if (field.pattern) node.pattern = field.pattern;
    if (field.minLength !== undefined) node.minLength = field.minLength;
    if (field.maxLength !== undefined) node.maxLength = field.maxLength;
    if (field.minimum !== undefined) node.minimum = field.minimum;
    if (field.maximum !== undefined) node.maximum = field.maximum;
    if (field.enum) node.enum = field.enum;
    if (field.nullable) node.type = [field.type, "null"] as unknown as string;
    if (field.example !== undefined) node.examples = [field.example];
    properties[field.name] = node;
  }
  const schema: JsonSchema = { type: "object", properties };
  const required = fields.filter((f) => f.required).map((f) => f.name);
  if (required.length) schema.required = required;
  if (opts.strict) schema.additionalProperties = false;
  if (opts.title) schema.title = opts.title;
  if (opts.description) schema.description = opts.description;
  return schema;
}

const ENVELOPE_DESCRIPTION = `Canonical bank event. Built by buildBankEvent (src/lib/outbox.ts) and serialised with canonicalJson (sorted keys at every depth) — the bytes that are hashed are the bytes that are sent, so a receiver verifies against the body it already read and never re-serialises anything.
Retries: up to ${MAX_DELIVERY_ATTEMPTS} attempts on a ladder (${DELIVERY_ATTEMPT_LADDER_MS.map((m) => `${Math.round(m / 60000)}m`).join(", ")}) across roughly 21 hours, then DEAD plus a DeadLetter row replayable by an operator. Every retry carries the SAME event_id and byte-identical body, so duplicates are expected traffic. Retryable on network error, 408, 429 and 5xx; a 4xx from the receiver is treated as delivered-not-accepted and is not retried.`;

/**
 * The `failure_envelope_v1` body: every field always present.
 *
 * Generated from the real type (`FailureEnvelope` in src/lib/failures/envelope.ts)
 * rather than invented, because this is the shape a bank branches on.
 *
 * The `code` enum is the envelope's WHOLE vocabulary (`FAILURE_CODES`), not just
 * the subset the documented bank endpoints happen to reach today. A narrower
 * enum is a live defect for any consumer that validates a response against this
 * document: `not_found`, `state_conflict` and the rest are codes the envelope
 * can send, and a spec that omits them tells the consumer the body is malformed
 * when it is perfectly legal. Which of those are reachable is a different
 * question, answered by the `x-error-catalog` and pinned by the gate.
 */
function failureSchema(description: string): JsonSchema {
  const codeValues = [...new Set([...FAILURE_CODES, ...failureEnvelopeCodes()])].sort();
  return {
    type: "object",
    description,
    required: ["code", "message", "retryable", "requestId", "docsUrl"],
    properties: {
      code: {
        type: "string",
        description: `Machine-readable code. Stable across messages; see \`x-error-catalog\` for every code with its meaning, retryability and remediation. Known values: ${codeValues.join(", ")}.`,
        enum: codeValues,
      },
      message: {
        type: "string",
        maxLength: 400,
        description:
          "Human-readable reason, sanitised and length-capped. MAY embed a cause (a policy-gate code, an outbound-URL verdict reason) — do NOT branch on the message text; branch on `code`.",
      },
      retryable: {
        type: "boolean",
        description:
          "Whether an IMMEDIATE identical retry is worth making. Fixed per code, so `policy_precondition` is always false even for the transient causes (cooldown, caps, spend ceiling) where a DELAYED retry is correct — the cause is named in `message`.",
      },
      requestId: {
        type: "string",
        description:
          "Correlation id, also sent as the `x-request-id` header. Quote it in a ticket; it is how support finds the audit record.",
      },
      docsUrl: {
        type: "string",
        format: "uri",
        description:
          "Per-code documentation URL. Base is FAILURE_DOCS_BASE_URL, default https://securevoiceai.me/docs/errors.",
      },
    },
  };
}

/** The legacy `{ error }` body the retired endpoint and operator routes still return. */
function legacyErrorSchema(description: string): JsonSchema {
  return {
    type: "object",
    description,
    required: ["error"],
    properties: {
      error: {
        type: "string",
        description:
          "Human-readable reason. There may be NO `code` field at all — on this envelope, error handling must not assume one.",
      },
      code: {
        type: "string",
        description: `Present only on some legacy refusals. Known legacy values: ${bodyErrorCodes().join(", ")}.`,
        enum: bodyErrorCodes(),
      },
    },
  };
}

function jsonResponse(
  description: string,
  schema: JsonSchema,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { description, content: { "application/json": { schema } }, ...extra };
}

/** The headers every `failure_envelope_v1` response carries. */
const FAILURE_HEADERS = {
  "x-request-id": {
    description: "Correlation id; equals the body's `requestId`.",
    schema: { type: "string" },
  },
  "Retry-After": {
    description: "Seconds to wait. Present on rate_limited (429) and dependency_unavailable (503).",
    schema: { type: "integer" },
  },
};

/** A response built from a catalogued body code. */
function codeResponse(code: string, status: number): Record<string, unknown> | null {
  const first = ERROR_CODES.find((e) => e.code === code && e.surface === "http_body");
  if (!first) return null;
  const headers =
    status === 429 || status === 503
      ? FAILURE_HEADERS
      : { "x-request-id": FAILURE_HEADERS["x-request-id"] };
  return {
    description: `${first.meaning}\n\nRetryable: ${first.retryable}. Remediation: ${first.remediation}`,
    headers,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/FailureEnvelope" },
        example: {
          code,
          message: first.meaning,
          retryable: first.retryable,
          requestId: "req_01HQ8Z7V3M9K2R4T6Y8W0X2B4D",
          docsUrl: `${FAILURE_DOCS_BASE}/${code}`,
        },
      },
    },
  };
}

/** A legacy status-only failure: prose only, no machine code. */
function legacyFailureResponse(entry: (typeof STATUS_FAILURES)[number]): Record<string, unknown> {
  return {
    description: `${entry.meaning}\n\nRetryable: ${entry.retryable}. Remediation: ${entry.remediation}`,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/LegacyError" },
        example: { error: entry.errorExample.trim() },
      },
    },
  };
}

/** A legacy failure that DOES carry a code. */
function legacyCodeResponse(id: string): Record<string, unknown> | null {
  const entry = ERROR_CODES.find((e) => e.id === id);
  if (!entry || entry.code === null) return null;
  return {
    description: `${entry.meaning}\n\nRetryable: ${entry.retryable}. Remediation: ${entry.remediation}`,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/LegacyError" },
        example: { error: entry.meaning, code: entry.code, successor: PUBLIC_INGEST_PATH },
      },
    },
  };
}

function buildComponents(): Record<string, unknown> {
  return {
    securitySchemes: {
      SvSignature: {
        type: "apiKey",
        in: "header",
        name: "SV-Signature",
        description: [
          `**${SIGNATURE_SCHEME.algorithm}** over \`${SIGNATURE_SCHEME.signedMessage}\`.`,
          ``,
          `Grammar: \`${SIGNATURE_SCHEME.grammar}\` (inbound: \`${SIGNATURE_SCHEME.inboundGrammar}\`).`,
          `Secret: \`${SIGNATURE_SCHEME.secretEnv.inbound}\`, shared out of band.`,
          `Replay window: ${SIGNATURE_SCHEME.replayWindowSeconds}s in both directions — a timestamp from the future is refused too.`,
          `Accepted header names: ${INBOUND_SIGNATURE_HEADERS.join(", ")}.`,
          `Comparison: ${SIGNATURE_SCHEME.comparison}.`,
          ``,
          `${SIGNATURE_SCHEME.bodyRule}`,
          ``,
          "Reference implementations: " +
            SIGNATURE_SCHEME.referenceImplementations.join("; ") +
            ".",
        ].join("\n"),
      },
      ProducerKey: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "svb_producer_key",
        description: [
          `**Alternative** to SvSignature, not an addition: if the \`Authorization\` header starts with \`Bearer svb_\` the signature check is skipped entirely.`,
          ``,
          `Source: ${SIGNATURE_SCHEME.alternative.source}.`,
          `${SIGNATURE_SCHEME.alternative.effect}.`,
          ``,
          "Prefer a producer key over the shared secret for anything beyond a first integration: revocation is per team.",
        ].join("\n"),
      },
    },
    parameters: {
      IdempotencyKey: {
        name: IDEMPOTENCY_HEADER,
        in: "header",
        required: true,
        description: [
          `**Required.** At least ${IDEMPOTENCY_MIN_LENGTH} characters; longer is better.`,
          ``,
          `Retries of the same logical transaction MUST reuse the key. The platform hashes it with the caller id and stores the response for ${IDEMPOTENCY_TTL_HOURS}h: a replay returns the stored 202 with \`duplicate: true\` and the \`${REPLAY_RESPONSE_HEADER}: true\` header, and creates nothing — no second case, no second call, no second charge.`,
          ``,
          "A producer that mints a fresh key on every retry gets a fresh case each time. That is the most common integration bug on this endpoint.",
        ].join("\n"),
        schema: { type: "string", minLength: IDEMPOTENCY_MIN_LENGTH, maxLength: 255 },
        example: "idem-2026-10-02-FRAUD-08612",
      },
    },
    schemas: {
      RiskSignal: {
        ...objectSchema(RISK_SIGNAL_FIELDS, {
          strict: true,
          title: "RiskSignal",
          description:
            "The inbound signal. STRICT: an undeclared field is rejected with 422, not ignored. Money is an integer in minor units; phone is E.164; currency is ISO-4217; language is BCP-47.",
        }),
        "x-data-minimisation": DATA_MINIMISATION,
      },
      InterventionQueued202: objectSchema(INTERVENTION_QUEUED_FIELDS, {
        title: "InterventionQueued202",
        description:
          "Accepted and durably QUEUED. The call is placed by a worker, not by this request — see the latency notes in docs/INTEGRATION-CONTRACT.md.",
      }),
      Delivery: objectSchema(DELIVERY_FIELDS, { title: "Delivery" }),
      Degraded: objectSchema(DEGRADED_FIELDS, { title: "Degraded" }),
      InterventionDegraded202: objectSchema(INTERVENTION_DEGRADED_FIELDS, {
        title: "InterventionDegraded202",
        description:
          "Accepted, but the voice channel was shed under load and the case degrades to an asynchronous channel. Still a success: the case exists, is auditable, and did not need re-sending.",
      }),
      InterventionAccepted202: {
        title: "InterventionAccepted202",
        description:
          "The two accepted envelopes. `status` distinguishes them and is the only field a producer must branch on.",
        oneOf: [
          { $ref: "#/components/schemas/InterventionQueued202" },
          { $ref: "#/components/schemas/InterventionDegraded202" },
        ],
        "x-admission-bands": ADMISSION_BANDS,
      },
      InterventionReplay202: {
        title: "InterventionReplay202",
        description: [
          `A replay of an already-stored ${IDEMPOTENCY_HEADER} response. Same status (202) and same envelope as the original, plus \`duplicate: true\` and the \`${REPLAY_RESPONSE_HEADER}: true\` header.`,
          ``,
          "This is the idempotency contract working. Do not treat it as an error and do not send a different key to force a new case.",
        ].join("\n"),
        allOf: [
          { $ref: "#/components/schemas/InterventionAccepted202" },
          {
            type: "object",
            required: ["duplicate"],
            properties: {
              duplicate: { type: "boolean", const: true, description: "Always true on a replay." },
            },
          },
        ],
      },
      Error: {
        title: "ErrorCatalogEntry",
        type: "object",
        description: "One row of the typed error catalog, emitted verbatim at `x-error-catalog`.",
        required: [
          "id",
          "status",
          "code",
          "literal",
          "surface",
          "envelope",
          "reachedFrom",
          "retryable",
          "meaning",
          "remediation",
        ],
        properties: {
          id: { type: "string" },
          status: { type: "integer" },
          code: {
            type: ["string", "null"],
            description:
              "The machine code as it appears in the `code` field, or null when the code field carries something else.",
          },
          literal: {
            type: "string",
            description: "The verbatim string in the source that produces this code.",
          },
          surface: {
            type: "string",
            enum: ["http_body", "http_message", "audit_chain"],
            description:
              "Where the code is observable. `http_message` means it appears inside `message` and is sanitised, so branch on `code` and read `envelopeCode` to see what that will be.",
          },
          envelope: {
            type: "string",
            enum: ["failure_envelope_v1", "legacy_error_field"],
            description:
              "Which body shape produces it. A producer's error handling must know whether `code` exists.",
          },
          reachedFrom: {
            type: "array",
            items: { type: "string" },
            description: "The documented endpoints that can return it.",
          },
          envelopeCode: {
            type: "string",
            description: "For http_message rows: what the `code` FIELD actually says.",
          },
          retryable: {
            type: "boolean",
            description:
              "Whether the SAME request can succeed later for THIS cause. Not the same as the envelope's `retryable` field, which is fixed per code.",
          },
          meaning: { type: "string" },
          remediation: { type: "string" },
        },
      },
      FailureEnvelope: failureSchema(
        "The `failure_envelope_v1` error body — every field always present, plus `x-request-id` and (where applicable) `Retry-After` headers.",
      ),
      LegacyError: legacyErrorSchema(
        "The legacy `{ error }` body. Returned by the RETIRED /api/interventions and the operator/agent-tool routes. `code` may be absent entirely.",
      ),
      BankEventEnvelope: {
        ...objectSchema(BANK_EVENT_FIELDS, {
          title: "BankEventEnvelope",
          description: ENVELOPE_DESCRIPTION,
        }),
        properties: {
          ...((objectSchema(BANK_EVENT_FIELDS).properties ?? {}) as Record<string, JsonSchema>),
          data: { $ref: "#/components/schemas/CaseNotifiedData" },
        },
        required: [
          "schema_version",
          "event_id",
          "event_type",
          "case_ref",
          "org_id",
          "occurred_at",
          "data",
        ],
      },
      CaseNotifiedData: objectSchema(CASE_NOTIFIED_DATA_FIELDS, {
        title: "CaseNotifiedData",
        description:
          "`data` for event_type `case.notified` — the post-call verdict. This is EVIDENCE for the bank's fraud team, never an authorisation: `freeze_staged: true` means a reversible freeze was STAGED, and a human specialist finalises it.",
      }),
      EvidencePointer: objectSchema(EVIDENCE_FIELDS, {
        title: "EvidencePointer",
        description:
          "A pointer to evidence, not the evidence. `transcript` is invariantly `withheld`.",
      }),
      ConformanceRunRequest: {
        type: "object",
        required: ["receiver_url", "secret"],
        additionalProperties: false,
        description:
          "Self-serve conformance request. `secret` is the signing secret YOUR receiver verifies with — we sign the probes with it and never store it.",
        properties: {
          receiver_url: {
            type: "string",
            format: "uri",
            maxLength: 300,
            description:
              "Your public HTTPS receiver. Validated by SSRF verdict before anything is dialled: https only, port 443, no credentials in the URL, and every address it resolves to must be public. Redirect hops are re-validated.",
          },
          secret: {
            type: "string",
            minLength: 8,
            description:
              "The shared signing secret for that receiver. Transmitted over TLS, never persisted, never echoed in the report.",
          },
          budget_ms: {
            type: "integer",
            minimum: 100,
            maximum: 10000,
            default: 2000,
            description:
              "Latency budget for the `fast_2xx` check. Not a contractual SLA — it is YOUR receiver's budget, which we grade.",
          },
        },
      },
      ConformanceReport: {
        type: "object",
        description:
          "A scored, attachable report. Safe to re-run: every probe carries a fresh event_id except the deliberate replay pair.",
        required: [
          "report_version",
          "run_id",
          "generated_at",
          "target",
          "budget_ms",
          "checks",
          "score",
        ],
        properties: {
          report_version: { type: "string", const: CONFORMANCE_REPORT_VERSION },
          run_id: { type: "string", description: "Unique per run; prefixes every probe event_id." },
          generated_at: { type: "string", format: "date-time" },
          target: {
            type: "object",
            required: ["url"],
            properties: { url: { type: "string", format: "uri" } },
            description: "The receiver the probes were sent to. Never includes the secret.",
          },
          budget_ms: { type: "integer" },
          checks: {
            type: "array",
            description: `One row per graded check: ${CONFORMANCE_CHECK_IDS.join(", ")}.`,
            items: { $ref: "#/components/schemas/ConformanceCheck" },
          },
          score: {
            type: "object",
            required: ["passed", "total", "percent", "verdict"],
            properties: {
              passed: { type: "integer" },
              total: { type: "integer" },
              percent: { type: "number" },
              verdict: { type: "string", enum: ["conforming", "non_conforming"] },
            },
          },
          probes: {
            type: "array",
            description:
              "Raw observation per probe. Carries status and latency, never the signature or the secret.",
            items: {
              type: "object",
              properties: {
                seq: { type: "integer" },
                kind: {
                  type: "string",
                  enum: ["valid_delivery", "replay", "tampered_signature", "unsigned", "malformed"],
                },
                status: { type: "integer" },
                latency_ms: { type: "integer" },
                signed: { type: "boolean" },
                event_id: { type: "string" },
                duplicate_marker: { type: ["boolean", "null"] },
                event_id_echoed: { type: "boolean" },
              },
            },
          },
        },
      },
      ConformanceCheck: {
        type: "object",
        required: ["id", "title", "status", "observed", "requirement"],
        properties: {
          id: { type: "string", enum: [...CONFORMANCE_CHECK_IDS] },
          title: { type: "string" },
          status: { type: "string", enum: ["pass", "fail"] },
          observed: {
            type: "string",
            description: "What we actually saw. No verdict without an observation.",
          },
          requirement: {
            type: "string",
            enum: Object.values(CONFORMANCE_REQUIREMENTS),
            description:
              "The normative sentence from CONFORMANCE_REQUIREMENTS this check grades against.",
          },
        },
      },
    },
  };
}

/** Build the whole document. Deterministic: same input, byte-identical output. */
export function buildOpenApiDocument(): Record<string, unknown> {
  const components = buildComponents();
  /** A catalogued body code, or a hard failure — a missing row is a build error. */
  const coded = (code: string, status: number): Record<string, unknown> => {
    const res = codeResponse(code, status);
    if (!res) throw new Error(`error code "${code}" is missing from ERROR_CODES`);
    return res;
  };
  const legacyStatus = (id: string): Record<string, unknown> => {
    const entry = STATUS_FAILURES.find((f) => f.id === id);
    if (!entry) throw new Error(`status-only failure "${id}" is missing from STATUS_FAILURES`);
    return legacyFailureResponse(entry);
  };
  const legacyCoded = (id: string): Record<string, unknown> => {
    const res = legacyCodeResponse(id);
    if (!res) throw new Error(`legacy error "${id}" is missing from ERROR_CODES`);
    return res;
  };

  const ingestPost = {
    operationId: "createIntervention",
    summary: "Submit a risk signal for verification-by-conversation",
    description: [
      "The canonical bank-facing ingest. The bank's fraud engine POSTs a signed risk signal; SecureVoice runs a deterministic policy gate, an abuse gate and admission control, then places a verification call through the durable dial queue.",
      "",
      "**Scope boundary.** SecureVoice is DOWNSTREAM of the fraud engine. It does not terminate ISO 8583 or ISO 20022, it does not approve or decline anything, and it carries no sub-100 ms authorisation SLA. The 202 below means ACCEPTED FOR A VERIFICATION ATTEMPT, nothing else.",
      "",
      `**Latency.** The critical path is one database round-trip plus a queue enqueue; the carrier call is placed later by a worker. The response is not a "customer contacted" signal. Do not treat 202 as contact made, and do not build a sub-100ms authorisation path on this endpoint. See docs/INTEGRATION-CONTRACT.md.`,
    ].join("\n"),
    tags: ["ingest"],
    security: [{ SvSignature: [] }, { ProducerKey: [] }],
    parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }],
    requestBody: {
      required: true,
      description: "The signed risk signal. Sign the EXACT bytes you transmit.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/RiskSignal" } } },
    },
    responses: {
      "202": jsonResponse(
        `Accepted. Also returned for a replay of an already-stored ${IDEMPOTENCY_HEADER} (see InterventionReplay202).`,
        { $ref: "#/components/schemas/InterventionReplay202" },
        {
          headers: {
            [REPLAY_RESPONSE_HEADER]: {
              description: `Present and "true" only on a replay.`,
              schema: { type: "string" },
            },
          },
        },
      ),
      "400": coded("malformed_request", 400),
      "401": coded("unauthenticated", 401),
      "409": coded("policy_precondition", 409),
      "422": coded("semantically_invalid", 422),
      "429": coded("rate_limited", 429),
      "503": coded("dependency_unavailable", 503),
    },
    "x-error-codes": [
      "malformed_request",
      "unauthenticated",
      "policy_precondition",
      "semantically_invalid",
      "rate_limited",
      "dependency_unavailable",
    ],
    "x-error-causes": ERROR_CODES.filter(
      (e) => e.surface === "http_message" && e.reachedFrom.includes(INGEST),
    ).map((e) => e.literal),
  };

  const doc: Record<string, unknown> = {
    openapi: "3.1.0",
    info: {
      title: "SecureVoice — customer integration contract",
      version: OUTBOUND_SCHEMA_VERSION,
      summary: "Inbound risk signals, outbound bank events, and a self-serve conformance checker.",
      description: [
        "## What this API is",
        "",
        "SecureVoice sits DOWNSTREAM of a bank's fraud engine. It dials the customer to verify a suspicious transaction and reports what happened.",
        "",
        "## What it is not — read this before integrating",
        "",
        "- It does **not** terminate ISO 8583 or ISO 20022. If your core banking speaks only those, this is not a replacement for your authorisation switch; it is fed by it.",
        "- It does **not** approve or decline transactions. A 202 is an accepted verification attempt, not a decision. A staged freeze is not a blocked card.",
        "- It carries **no sub-100 ms authorisation SLA**, and cannot. The call is placed by a worker from a durable queue after a policy gate, an abuse gate and admission control. Do not put a card authorisation on this path.",
        "- It carries **no account numbers or balances**, in or out. The ingest schema is strict, so sending them is a 422.",
        "",
        "## Discovery",
        "",
        `- This document: \`GET /openapi\` (canonical; there is no second copy)`,
        `- Webhook surface: \`GET /asyncapi\` (AsyncAPI ${OUTBOUND_SCHEMA_VERSION})`,
        `- Contract, tiers and runbook: \`docs/INTEGRATION-CONTRACT.md\``,
        `- Self-serve conformance check: \`POST ${CONFORMANCE_PATH}\``,
        ``,
        `## Versioning`,
        "",
        `Envelope version is \`${OUTBOUND_SCHEMA_VERSION}\`. Within a version, no field is removed, renamed or retyped; new optional fields may appear, so a receiver MUST ignore unknown fields in an EVENT (unlike the ingest, which rejects them). A breaking change requires a new \`schema_version\`, published in this document alongside a migration note.`,
      ].join("\n"),
      contact: {
        name: "SecureVoice integration support",
        url: "https://securevoiceai.me",
      },
      license: { name: "Proprietary" },
    },
    servers: [
      {
        url: "https://voice.example.com",
        description: `Public deployment. The documented ingest path is ${PUBLIC_INGEST_PATH}; the application path ${APP_INGEST_PATH} is live and equivalent (next.config.ts rewrites the former onto the latter). Do not hardcode either — resolve it from this document.`,
      },
    ],
    tags: [
      {
        name: "ingest",
        description: "Bank → SecureVoice. Risk signals that arm a verification call.",
      },
      {
        name: "conformance",
        description: "Self-serve grading of YOUR receiver against this contract.",
      },
      { name: "meta", description: "Machine-readable descriptions of this contract." },
    ],
    paths: {
      [PUBLIC_INGEST_PATH]: {
        post: ingestPost,
        get: {
          operationId: "describeInterventions",
          summary: "Producer discovery document",
          description:
            "The same discovery document the implementation serves at this path: endpoint, the two accepted auth schemes, the idempotency rule and the field list. Served for humans; this OpenAPI document is the machine-readable form.",
          tags: ["ingest"],
          security: [],
          responses: {
            "200": jsonResponse("Discovery document.", {
              type: "object",
              additionalProperties: true,
            }),
          },
        },
      },
      [RETIRED_INGEST_PATH]: {
        post: {
          operationId: "createInterventionRetired",
          summary: "RETIRED — returns 410 and arms nothing",
          description: [
            "This endpoint used to be a second, ungated ingest. It is retired: it arms no call, creates no case, runs no policy or abuse gate and records no billing. It answers 410 with `endpoint_retired`, the successor path and the list of behavioural changes so a producer can migrate deliberately.",
            "",
            "The authentication, rate-limit and callback-SSRF checks are retained so an unauthenticated caller still gets 401 rather than a map of the platform, and so the migration notice is the first thing a correctly authenticated producer sees.",
          ].join("\n"),
          tags: ["ingest"],
          security: [{ SvSignature: [] }, { ProducerKey: [] }],
          responses: {
            "410": legacyCoded("endpoint_retired"),
            "401": legacyStatus("retired_producer_key_rejected"),
            "400": legacyStatus("retired_malformed_json"),
            "422": legacyStatus("retired_invalid_signal"),
            "429": legacyStatus("retired_rate_limited"),
          },
          "x-migration": [
            "integer minor units for `amount`; `amountAed` is not accepted",
            "E.164 `phone`; `customer.ref`/`customer.lang` nested objects are not accepted",
            "`consent_record_id` is required (it was optional on the nested shape)",
            "`Idempotency-Key` is required",
            "`amount` must be an integer; the retired endpoint accepted a float `amountAed`",
            "errors move from `{ error }` to `{ code, message, retryable, requestId, docsUrl }`",
          ],
        },
      },
      [CONFORMANCE_PATH]: {
        post: {
          operationId: "runConformance",
          summary: "Grade a bank receiver against this contract",
          description: [
            "Fires five signed probes at a receiver you nominate and grades the answers. Attach the returned report to your change record.",
            "",
            `Graded checks: ${CONFORMANCE_CHECK_IDS.join(", ")}.`,
            "",
            "**200 means the RUN succeeded, not that you passed** — read `score.verdict`. A failing grade is a successful run and a `non_conforming` verdict.",
            "",
            "Requires a producer key (`Authorization: Bearer svb_…`): an unauthenticated caller must not be able to make our deployment POST to an arbitrary URL.",
            "",
            "The target is validated by SSRF verdict before anything is dialled; a blocked target returns 422 and issues zero probes.",
          ].join("\n"),
          tags: ["conformance"],
          security: [{ ProducerKey: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ConformanceRunRequest" },
              },
            },
          },
          responses: {
            "200": jsonResponse(
              "The run completed. Grade it in `score.verdict` — 200 means the RUN succeeded, not that the receiver passed.",
              { $ref: "#/components/schemas/ConformanceReport" },
            ),
            "400": coded("malformed_request", 400),
            "401": coded("unauthenticated", 401),
            "422": coded("semantically_invalid", 422),
            "429": coded("rate_limited", 429),
          },
        },
      },
      "/openapi": {
        get: {
          operationId: "getOpenApi",
          summary: "This document",
          description:
            "Generated from src/lib/contracts/schema.ts, which is transcribed from the real code paths. tests/contracts fails if the code and the contract diverge, so this document cannot quietly go stale.",
          tags: ["meta"],
          security: [],
          responses: {
            "200": jsonResponse("OpenAPI 3.1 document.", {
              type: "object",
              additionalProperties: true,
            }),
          },
        },
      },
      "/asyncapi": {
        get: {
          operationId: "getAsyncApi",
          summary: "The outbound webhook surface, as AsyncAPI",
          description:
            "Everything SecureVoice POSTs to a bank: the envelope, the only emitted event type, the signature scheme and the retry ladder.",
          tags: ["meta"],
          security: [],
          responses: {
            "200": jsonResponse("AsyncAPI 3.0 document.", {
              type: "object",
              additionalProperties: true,
            }),
          },
        },
      },
    },
    components,
    "x-error-catalog": ERROR_CODES.map((e) => ({
      id: e.id,
      status: e.status,
      code: e.code,
      literal: e.literal,
      surface: e.surface,
      envelope: e.envelope,
      reachedFrom: e.reachedFrom,
      ...(e.envelopeCode ? { envelopeCode: e.envelopeCode } : {}),
      retryable: e.retryable,
      meaning: e.meaning,
      remediation: e.remediation,
    })),
    "x-status-failures": STATUS_FAILURES.map((f) => ({
      id: f.id,
      status: f.status,
      errorExample: f.errorExample,
      envelope: f.envelope,
      meaning: f.meaning,
      retryable: f.retryable,
      remediation: f.remediation,
    })),
    "x-error-envelopes": {
      failure_envelope_v1: {
        required: ["code", "message", "retryable", "requestId", "docsUrl"],
        headers: ["x-request-id", "Retry-After (429 and 503 only)"],
        source: "src/lib/failures/envelope.ts FailureEnvelope + makeFailure",
        usedBy: [INGEST, CONFORMANCE_OP],
      },
      legacy_error_field: {
        required: ["error"],
        code_may_be_absent: true,
        source: "src/lib/api-errors.ts",
        usedBy: [`POST ${RETIRED_INGEST_PATH}`, "operator console routes", "agent tool endpoints"],
        note: "Retained only on the retired ingest and the internal surfaces. A migrating bank meets it for as long as it keeps calling /api/interventions.",
      },
    },
    "x-aliases": {
      [`${PUBLIC_INGEST_PATH} -> ${APP_INGEST_PATH}`]: "next.config.ts rewrites()",
      [`${RETIRED_INGEST_PATH}`]: "410 Gone; retained for a clean migration notice",
    },
    "x-event-types": EVENT_TYPES,
    "x-data-minimisation": DATA_MINIMISATION,
  };
  return doc;
}
