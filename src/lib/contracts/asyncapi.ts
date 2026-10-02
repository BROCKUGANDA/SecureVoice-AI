/**
 * AsyncAPI 3.0 document generator for the outbound webhook surface (WP-17).
 *
 * Why a second document instead of a section in the OpenAPI one: the two
 * describe opposite directions of the same contract. OpenAPI describes what a
 * bank SENDS us (`POST /v1/interventions`); AsyncAPI describes what we POST to
 * a bank. A webhook delivery is not a request in a bank's API — it has no
 * requester, a retry ladder, a dedupe key, and the receiver is the customer's
 * code rather than the customer's client. Putting the envelope inside the
 * OpenAPI document would imply we call an endpoint the bank publishes, which is
 * half true and therefore worse than useless: it invites a bank to build a
 * gateway endpoint and treat our deliveries as ordinary inbound requests,
 * losing the two facts that break integrations — retries are routine, and
 * `event_id` is the dedupe key.
 *
 * Generated from `schema.ts`, never hand-written, for the same reason.
 */

import {
  CASE_NOTIFIED_DATA_FIELDS,
  DATA_MINIMISATION,
  EVIDENCE_FIELDS,
  MAX_DELIVERY_ATTEMPTS,
  OUTBOUND_SCHEMA_VERSION,
  SIGNATURE_SCHEME,
  type FieldSpec,
  type JsonSchema,
} from "./schema";

/** The event types actually emitted by this codebase. */
export const EVENT_TYPES = ["case.notified"] as const;

/** `BACKOFF_LADDER_MS` in src/lib/outbox.ts. */
export const DELIVERY_ATTEMPT_LADDER_MS = [
  60_000, 300_000, 1_800_000, 7_200_000, 10_800_000, 43_200_000,
] as const;

function objectSchema(fields: readonly FieldSpec[]): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const f of fields) {
    const node: JsonSchema = { type: f.type, description: f.description };
    if (f.format) node.format = f.format;
    if (f.nullable) node.type = [f.type, "null"] as unknown as string;
    if (f.enum) node.enum = f.enum;
    if (f.example !== undefined) node.examples = [f.example];
    properties[f.name] = node;
  }
  const schema: JsonSchema = { type: "object", properties };
  const required = fields.filter((f) => f.required).map((f) => f.name);
  if (required.length) schema.required = required;
  return schema;
}

const ENVELOPE_FIELDS: readonly FieldSpec[] = [
  {
    name: "schema_version",
    required: true,
    type: "string",
    description: `Envelope version "${OUTBOUND_SCHEMA_VERSION}". Reject an unknown version rather than guess at its fields.`,
    enforced: "src/lib/outbox.ts SCHEMA_VERSION",
  },
  {
    name: "event_id",
    required: true,
    type: "string",
    description:
      "UUID v4 assigned before the row is written. THE DEDUPE KEY. Retries reuse it byte-identically, so a receiver MUST drop a repeat rather than re-apply it. This is the whole reason a replay does not double-charge.",
    enforced: "src/lib/outbox.ts buildBankEvent (randomUUID)",
  },
  {
    name: "event_type",
    required: true,
    type: "string",
    description: `Dotted event name. Emitted today: ${EVENT_TYPES.join(", ")}. Ignore unknown types; never treat one as fatal.`,
    enforced: "src/lib/elevenlabs/inbound.ts",
  },
  {
    name: "case_ref",
    required: true,
    type: "string",
    description: "Case reference, or null. Join key to the bank's own alert (the transaction_ref they sent).",
    enforced: "src/lib/outbox.ts buildBankEvent",
  },
  {
    name: "org_id",
    required: true,
    type: "string",
    description: "Tenant scope, or null for the shared namespace.",
    enforced: "src/lib/outbox.ts buildBankEvent",
  },
  {
    name: "occurred_at",
    required: true,
    type: "string",
    description:
      "When the event HAPPENED, not when it was sent. A retry 12 hours later carries the original instant.",
    enforced: "src/lib/outbox.ts enqueueOutbox (occurredAt)",
  },
  {
    name: "data",
    required: true,
    type: "object",
    description: "Type-specific payload. Never transcript content.",
    enforced: "src/lib/elevenlabs/inbound.ts",
  },
];

/** Build the whole document. Deterministic. */
export function buildAsyncApiDocument(): Record<string, unknown> {
  const envelope = objectSchema(ENVELOPE_FIELDS);

  return {
    asyncapi: "3.0.0",
    info: {
      title: "SecureVoice — outbound bank webhooks",
      version: OUTBOUND_SCHEMA_VERSION,
      description: [
        "Everything SecureVoice POSTs to a bank's receiver.",
        "",
        "## Receiver obligations, in order of how often they are got wrong",
        "",
        "1. **Read the RAW body bytes.** Verify the signature over what arrived, never over a re-serialised object. Re-encoding JSON changes the bytes and breaks the digest.",
        "2. **Verify the signature** before parsing, or at least before acting. `${SIGNATURE_SCHEME.algorithm}` over `${SIGNATURE_SCHEME.signedMessage}`, ${SIGNATURE_SCHEME.replayWindowSeconds}s replay window, constant-time comparison.",
        "3. **Dedupe on `event_id`.** Retries are routine: up to ${MAX_DELIVERY_ATTEMPTS} attempts, byte-identical body. Apply-once is the receiver's job; we cannot make it safe for you.",
        "4. **Return 2xx quickly and do the work asynchronously.** We treat 408, 429, 5xx and network errors as retryable; anything else in the 4xx range stops the ladder. A slow 2xx is a lost event, not a delayed one.",
        "5. **Reject malformed payloads with a 4xx** and an unknown `schema_version` with a 4xx. Acknowledge what you cannot process only if you have durably recorded it.",
        "",
        "## What we never send",
        "",
        ...DATA_MINIMISATION.neverSent.map((item) => `- ${item}`),
        "",
        "## Grading",
        "",
        "`POST /v1/conformance/run` fires signed probes at your receiver and scores them against these obligations, so this contract can be verified without a human on both sides.",
      ].join("\n"),
      contact: { name: "SecureVoice integration support", url: "https://securevoice.ai" },
    },
    defaultContentType: "application/json",
    servers: {
      production: {
        host: "https://{bankReceiverHost}",
        protocol: "https",
        description:
          "The bank's receiver. `BANK_WEBHOOK_URL` in our deployment points at it; the default is our own hosted reference receiver so the demo needs no external service.",
        variables: {
          bankReceiverHost: {
            default: "bank.example.com",
            description: "Host of the bank's HTTPS receiver endpoint.",
          },
        },
      },
    },
    channels: {
      bankEvents: {
        address: "https://{bankReceiverHost}/securevoice/events",
        title: "Bank event delivery",
        description:
          "One POST per event, retried on the published ladder. There is no long-poll, no batch and no ordering guarantee: events for the same case can arrive out of order across retries, so a receiver must key state on `event_id` and tolerate `occurred_at` regressing relative to arrival order.",
        parameters: {
          bankReceiverHost: { description: "Host of the bank's HTTPS receiver endpoint." },
        },
        messages: {
          caseNotified: { $ref: "#/components/messages/CaseNotified" },
        },
      },
    },
    operations: {
      sendCaseNotified: {
        action: "send",
        summary: "Post a post-call verdict to the bank",
        description:
          "Sent when a case reaches NOTIFIED, in the SAME database transaction as the state change — so a verdict cannot exist without a delivery, and a delivery cannot claim a state that did not happen.",
        channel: { $ref: "#/channels/bankEvents" },
        messages: [{ $ref: "#/channels/bankEvents/messages/caseNotified" }],
        reply: {
          address: {
            description:
              "The receiver's acknowledgement. Any 2xx is DELIVERED; 408, 429 and 5xx are retried; other 4xx stop the ladder and the event is dead-lettered for operator replay.",
          },
          channel: {
            messages: {
              acknowledgement: {
                $ref: "#/components/messages/Acknowledgement",
              },
            },
          },
        },
        security: [{ svSignature: [] }],
      },
    },
    components: {
      securitySchemes: {
        svSignature: {
          type: "apiKey",
          in: "header",
          name: "SV-Signature",
          description: [
            `${SIGNATURE_SCHEME.grammar}`,
            `${SIGNATURE_SCHEME.algorithm} over \`${SIGNATURE_SCHEME.signedMessage}\`.`,
            `Body rule: ${SIGNATURE_SCHEME.bodyRule}`,
            `Secret: \`${SIGNATURE_SCHEME.secretEnv.outbound}\` (distinct from the inbound \`${SIGNATURE_SCHEME.secretEnv.inbound}\`).`,
            `Comparison: ${SIGNATURE_SCHEME.comparison}.`,
          ].join(" "),
        },
      },
      messages: {
        CaseNotified: {
          name: "case.notified",
          title: "Post-call verdict",
          summary:
            "A case reached NOTIFIED and carries a verdict, a staged-freeze flag, a handoff flag and an audit reference. Evidence is pulled through the signed case export, never pushed.",
          contentType: "application/json",
          headers: {
            type: "object",
            required: ["sv-signature"],
            properties: {
              "sv-signature": { type: "string", pattern: "^t=[0-9]{10},v1=[0-9a-f]{64}$" },
              "content-type": { type: "string", const: "application/json" },
            },
            description: "Header properties are lower-cased by HTTP; `SV-Signature` arrives as `sv-signature`.",
          },
          payload: { $ref: "#/components/schemas/BankEventEnvelope" },
          correlationId: {
            location: "$message.payload#/event_id",
            description:
              "Dedupe and trace key. Quote it in a ticket: it is the cheapest way for us to find the exact delivery, including its attempt count.",
          },
        },
        Acknowledgement: {
          name: "acknowledgement",
          title: "Receiver acknowledgement",
          summary:
            "Any 2xx marks the event DELIVERED. 408/429/5xx retry on the ladder. Other 4xx stop the ladder.",
          contentType: "application/json",
          payload: {
            type: "object",
            description:
              "The body is NOT parsed by us — the STATUS decides the ladder. It is described here only because a receiver needs to know its content is ignored.",
            properties: {
              ok: { type: "boolean" },
              event_id: { type: ["string", "null"] },
              duplicate: {
                type: "boolean",
                description:
                  "Set this (or the `X-Securevoice-Duplicate: true` header) when a redelivery was recognised and deliberately NOT re-applied. It is what the conformance `replay_handled` check looks for.",
              },
              error: { type: ["string", "null"] },
            },
          },
        },
      },
      schemas: {
        BankEventEnvelope: {
          ...envelope,
          title: "BankEventEnvelope",
          description:
            "Canonical envelope. `canonicalJson` (sorted keys at every depth) is both the signed body and the transmitted body.",
          "x-data-minimisation": DATA_MINIMISATION,
        },
        CaseNotifiedData: objectSchema(CASE_NOTIFIED_DATA_FIELDS),
        EvidencePointer: objectSchema(EVIDENCE_FIELDS),
      },
    },
    "x-delivery": {
      maxAttempts: MAX_DELIVERY_ATTEMPTS,
      ladderMs: DELIVERY_ATTEMPT_LADDER_MS,
      ladderHuman: ["+1m", "+5m", "+30m", "+2h", "+3h", "+12h"],
      totalSpan: "roughly 21 hours, then DEAD plus a DeadLetter row replayable by an operator",
      retryableStatuses: ["network_error", 408, 429, "5xx"],
      terminalStatuses: ["other 4xx"],
      backoffJitter: "±20% around each ladder step",
      ordering: "none — see the channel description",
      dedupeKey: "event_id",
    },
    "x-event-types": EVENT_TYPES,
  };
}
