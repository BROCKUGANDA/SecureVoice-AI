/**
 * UNIT — the published API contract (src/lib/contracts/*).
 *
 * Four pure modules, all of which are PUBLISHED ARTIFACTS rather than internal
 * code: `schema.ts` (the field/error data every document is generated from),
 * `openapi.ts` and `asyncapi.ts` (the two documents a bank reads), and
 * `conformance.ts` (the checker that grades a bank's receiver). `tests/contracts/`
 * already asserts that these agree with the route files; this file asserts the
 * properties that hold INDEPENDENTLY of the routes, because those are the ones
 * that decide whether the published document is usable at all.
 *
 * A contract document has failure modes no ordinary unit test has:
 *
 *   · IT IS DATA, AND DATA HAS NO COMPILER. A wrong bound is not a stack trace,
 *     it is a bank that codes against a spec that lies. So the field
 *     declarations are checked for internal consistency (a declared `example`
 *     that violates its own declared `minLength` is a self-contradiction no
 *     reader can detect) and the request schema is exercised at its boundaries.
 *   · IT IS SERVED AS JSON. `undefined` in a document does not throw; it
 *     silently DELETES a key on serialisation, and `NaN`/`Infinity` become
 *     `null`. A round-trip deep-equal is therefore the assertion that the
 *     document says what it appears to say — and it also proves there is no
 *     circular reference, which would be a 500 on a docs route.
 *   · IT IS BUILT, NOT WRITTEN, so it must be DETERMINISTIC. A `Date.now()` or
 *     `Math.random()` anywhere in a builder makes the document untestable,
 *     unreviewable in a diff, and impossible to cache. Two builds must be
 *     byte-identical.
 *   · A DANGLING `$ref` IS INVISIBLE TO EVERY OTHER CHECK. `JSON.parse`
 *     succeeds, the path exists, the operation has responses — and the docs page
 *     renders a broken link. Resolving every pointer is the only assertion that
 *     catches it.
 *   · A DOC WITH NO 2xx IS A DOC NO CLIENT CAN CALL. Every operation is checked
 *     for a success response, with the one deliberate exception documented
 *     below.
 *   · THE DOCUMENTS ARE PUBLISHED, so any secret-shaped value that reaches an
 *     `example`/`default` is a disclosure. Examples are scanned for the shapes
 *     real credentials take.
 *
 * The risk signal is validated through a Zod schema COMPILED FROM THE FIELD
 * DATA (`fieldSchema` below), not hand-written from the route's literal. That
 * matters: the property under test is "the bounds this document publishes are
 * the bounds that hold", and a hand-written copy would agree with itself no
 * matter how the data drifted. The compiler is deliberately a no-coercion one —
 * `amount: "2500"` must fail, because a bank sending a stringified amount is a
 * producer bug this contract exists to surface rather than interpret.
 *
 * KNOWN GAP, deliberately NOT asserted as correct — `src/lib/contracts/openapi.ts:525`
 * documents the per-probe field as `latency_ms`, but `ConformanceReport` emits
 * `latencyMs` (`conformance.ts:140,453`), and the same probe schema omits the
 * optional `error` field the checker attaches when a transport throws
 * (`conformance.ts:147`). A client generated from this document therefore reads
 * a latency key that never arrives and does not know about `error`. The probes
 * below assert what the report ACTUALLY contains and the header records the
 * drift; the mismatch is reported, not frozen. See the handoff notes.
 *
 * KNOWN GAP — `schema.ts:377` tells the reader the case-reference alphabet
 * excludes `I/L/O/U`, and `conformance.ts:180` really does exclude `I/L/O` —
 * but its `CASE_ALPHABET` DOES contain `U`, and so does the ingest route's
 * `makeCaseRef`. A bank that writes the documented regex
 * (`^SV-F-[2-9A-HJ-NP-Z]{6}$`, which excludes `U`) therefore rejects a
 * `case_ref` the platform itself produces. Asserted below against the alphabet
 * the code actually uses, so the drift is visible rather than frozen.
 *
 * KNOWN GAP — `conformance.ts:472` builds a `missing()` reason for a probe with
 * no observation, but the probe loop pushes an observation for EVERY probe even
 * when the transport throws (`status: 0`), so that branch is unreachable and
 * the reason a dead receiver sees is the status-0 wording instead. Asserted as
 * the wording that is actually produced.
 *
 * KNOWN GAP — `RISK_SIGNAL_FIELDS.callback_url` declares no `pattern`, so the
 * published `RiskSignal` schema accepts `http://…`, while the ingest route
 * refuses anything that is not `https://`. A bank generating a client from this
 * document can therefore build a request the server rejects. Asserted as the
 * current behaviour (the bound the document states is the bound the document
 * enforces), reported rather than fixed.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  ADMISSION_BANDS,
  BANK_EVENT_FIELDS,
  CASE_NOTIFIED_DATA_FIELDS,
  CONFORMANCE_PATH,
  DATA_MINIMISATION,
  DEGRADED_FIELDS,
  DELIVERY_FIELDS,
  DIAL_JOB_STATES,
  ERROR_CODES,
  EVIDENCE_FIELDS,
  INTERVENTION_DEGRADED_FIELDS,
  INTERVENTION_QUEUED_FIELDS,
  MAX_DELIVERY_ATTEMPTS,
  OUTBOUND_SCHEMA_VERSION,
  PUBLIC_INGEST_PATH,
  RETIRED_INGEST_PATH,
  RISK_SIGNAL_FIELDS,
  STATUS_FAILURES,
  bodyErrorCodes,
  errorCodesForLiteral,
  failureEnvelopeCodes,
  type FieldSpec,
} from "@/lib/contracts/schema";
import { buildOpenApiDocument } from "@/lib/contracts/openapi";
import { DELIVERY_ATTEMPT_LADDER_MS, buildAsyncApiDocument } from "@/lib/contracts/asyncapi";
import {
  CONFORMANCE_CHECK_IDS,
  CONFORMANCE_REQUIREMENTS,
  DEFAULT_BUDGET_MS,
  DUPLICATE_BODY_MARKERS,
  EVENT_ID_ECHO_HEADERS,
  MAX_BUDGET_MS,
  MIN_BUDGET_MS,
  handleConformanceRun,
  runConformance,
  type ConformanceReport,
  type ConformanceTransport,
  type TransportRequest,
  type TransportResponse,
} from "@/lib/contracts/conformance";
import { verifySignature } from "@/lib/outbox";

/* ──────────────────────────────────────────────────────────────────────────
 * Reading the documents
 *
 * Both builders return `Record<string, unknown>`. Everything below navigates
 * them through declared shapes — a `const` assertion on a `document.paths` read
 * would be a lie the moment a key is renamed, and a type guard would throw at
 * runtime instead of failing the assertion with a readable message.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * A JSON Schema node. The index signature is not laziness: JSON Schema 2020-12
 * and OpenAPI both permit arbitrary keywords, and this document uses several
 * (`examples`, `const`, `oneOf`, `x-…`). Declaring only the keywords read below
 * would make every one of those reads a type error, and the fix for that is
 * `unknown`, not a cast.
 */
type SchemaNode = {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  additionalProperties?: boolean | SchemaNode;
  enum?: readonly (string | number)[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  [keyword: string]: unknown;
};

type Operation = {
  operationId?: string;
  summary?: string;
  tags?: string[];
  responses: Record<string, { description?: string }>;
};

type DocumentShape = {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, SchemaNode> };
  tags?: Array<{ name: string }>;
  /** `x-…` vendor extensions and any other top-level keyword. */
  [keyword: string]: unknown;
};

const openapi = buildOpenApiDocument() as unknown as DocumentShape;
const asyncapi = buildAsyncApiDocument() as unknown as DocumentShape;

const openapiJson = JSON.stringify(openapi);
const asyncapiJson = JSON.stringify(asyncapi);

/** Every `(path, verb, operation)` triple, flattened. */
function operations(doc: DocumentShape): Array<[string, string, Operation]> {
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    Object.entries(item).map(([verb, op]) => [path, verb, op] as [string, string, Operation]),
  );
}

/**
 * Every value in a document that a reader of published specs treats as a
 * sample: `example` (OpenAPI), `examples` (JSON Schema 2020-12) and `default`.
 * Scoped to those keys on purpose — scanning prose would flag the documentation
 * of a secret's NAME, which is exactly what the signature section must contain.
 */
function sampleValues(node: unknown, path: string, found: Array<[string, string]>): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => sampleValues(child, `${path}[${i}]`, found));
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "example" || key === "examples" || key === "default") {
      found.push([`${path}.${key}`, JSON.stringify(value) ?? ""]);
    } else {
      sampleValues(value, `${path}.${key}`, found);
    }
  }
}

/**
 * Resolve a local JSON pointer. Returns `undefined` for anything that is not a
 * pointer into THIS document, so a `$ref` to an external file or URL — which
 * renders as a broken link in every offline docs viewer — is reported as
 * unresolved rather than silently skipped.
 */
function resolvePointer(doc: unknown, pointer: string): unknown {
  if (!pointer.startsWith("#/")) return undefined;
  let cursor: unknown = doc;
  for (const raw of pointer.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function allRefs(doc: unknown): string[] {
  const refs: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") refs.push(value);
      else walk(value);
    }
  };
  walk(doc);
  return refs;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Compiling a `FieldSpec` into a validator
 *
 * Every constraint the document declares becomes a Zod constraint, and NOTHING
 * else does. In particular there is no `z.coerce`: a declared `integer` field
 * must reject the string "2500", because the ingest's money contract is integer
 * minor units and a producer sending a string is a producer whose other fields
 * deserve suspicion too.
 * ────────────────────────────────────────────────────────────────────────── */

function fieldSchema(field: FieldSpec): z.ZodType {
  let node: z.ZodTypeAny;
  switch (field.type) {
    case "integer":
      node = z.number().int();
      break;
    case "number":
      node = z.number();
      break;
    case "boolean":
      node = z.boolean();
      break;
    case "object":
      node = z.record(z.string(), z.unknown());
      break;
    case "array":
      node = z.array(z.unknown());
      break;
    default:
      node = z.string();
  }

  if (field.type === "string") {
    if (field.enum) node = z.enum(field.enum as [string, ...string[]]);
    if (field.minLength !== undefined) node = (node as z.ZodString).min(field.minLength);
    if (field.maxLength !== undefined) node = (node as z.ZodString).max(field.maxLength);
    if (field.pattern) node = (node as z.ZodString).regex(new RegExp(field.pattern));
  }
  if (field.type === "integer" || field.type === "number") {
    if (field.minimum !== undefined) node = (node as z.ZodNumber).min(field.minimum);
    if (field.maximum !== undefined) node = (node as z.ZodNumber).max(field.maximum);
  }
  if (field.nullable) node = node.nullable();
  return field.required ? node : node.optional();
}

function objectSchema(fields: readonly FieldSpec[]): z.ZodType {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) shape[field.name] = fieldSchema(field);
  return z.object(shape).strict();
}

const RISK_SIGNAL = objectSchema(RISK_SIGNAL_FIELDS);
const CASE_NOTIFIED_DATA = objectSchema(CASE_NOTIFIED_DATA_FIELDS);
const BANK_EVENT = objectSchema(BANK_EVENT_FIELDS);
const EVIDENCE = objectSchema(EVIDENCE_FIELDS);

/** A signal that satisfies every declared bound. */
const VALID_SIGNAL = {
  transaction_ref: "FRAUD-2026-08612",
  risk_score: 0.94,
  language: "ar",
  phone: "+971501234567",
  currency: "AED",
  amount: 2500,
  consent_record_id: "CN-2026-04-1183",
} as const;

/** Which field a rejection names, so a table row can assert the reason. */
function offendingFields(result: z.ZodSafeParseResult<unknown>): string[] {
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
}

/* ──────────────────────────────────────────────────────────────────────────
 * 1. Field data is internally consistent
 * ────────────────────────────────────────────────────────────────────────── */

const FIELD_LISTS: Record<string, readonly FieldSpec[]> = {
  RISK_SIGNAL_FIELDS,
  INTERVENTION_QUEUED_FIELDS,
  INTERVENTION_DEGRADED_FIELDS,
  DELIVERY_FIELDS,
  DEGRADED_FIELDS,
  BANK_EVENT_FIELDS,
  CASE_NOTIFIED_DATA_FIELDS,
  EVIDENCE_FIELDS,
};

describe("field declarations are internally consistent", () => {
  test.each(Object.entries(FIELD_LISTS))("%s has no duplicate field name", (name, fields) => {
    // A duplicate name is invisible in the rendered document: the second
    // declaration overwrites the first in `properties`, so one field silently
    // loses its bounds while the field count still looks right.
    const names = fields.map((f) => f.name);
    expect([...new Set(names)], `duplicate name in ${name}`).toEqual(names);
  });

  test.each(Object.entries(FIELD_LISTS))(
    "%s declares a coherent range for every field",
    (name, fields) => {
      for (const field of fields) {
        // An inverted bound describes a field nothing can satisfy.
        if (field.minLength !== undefined && field.maxLength !== undefined) {
          expect(
            field.minLength,
            `${name}.${field.name} minLength > maxLength`,
          ).toBeLessThanOrEqual(field.maxLength);
        }
        if (field.minimum !== undefined && field.maximum !== undefined) {
          expect(field.minimum, `${name}.${field.name} minimum > maximum`).toBeLessThanOrEqual(
            field.maximum,
          );
        }
        // `minLength` on a number, or `minimum` on a string, is a copy-paste
        // mistake: JSON Schema ignores it, so the bound silently does not exist.
        if (field.type === "string") {
          expect(
            field.minimum,
            `${name}.${field.name} declares minimum on a string`,
          ).toBeUndefined();
        }
        if (field.type === "integer" || field.type === "number") {
          expect(
            field.minLength,
            `${name}.${field.name} declares minLength on a number`,
          ).toBeUndefined();
          expect(
            field.maxLength,
            `${name}.${field.name} declares maxLength on a number`,
          ).toBeUndefined();
        }
      }
    },
  );

  test.each(Object.entries(FIELD_LISTS))(
    "%s: every declared example satisfies its own bounds",
    (name, fields) => {
      // The example is what a bank copies. An example its own field would reject
      // is the single most damaging kind of contract error, because it is
      // followed literally and produces a 422 with no obvious cause.
      for (const field of fields) {
        if (field.example === undefined) continue;
        const result = fieldSchema(field).safeParse(field.example);
        expect(
          offendingFields(result),
          `${name}.${field.name} example ${JSON.stringify(field.example)} violates its own declaration`,
        ).toEqual([]);
        if (field.enum) {
          expect(
            field.enum.map(String),
            `${name}.${field.name} example is outside its enum`,
          ).toContain(String(field.example));
        }
      }
    },
  );

  test.each(Object.entries(FIELD_LISTS))(
    "%s: every field carries prose and a provenance marker",
    (name, fields) => {
      for (const field of fields) {
        // `description` is the only place a bound's MEANING lives, so an empty
        // one leaves a bank to infer the rule from the number alone.
        // `enforced` is what lets a reviewer check the bound against the
        // implementation without trusting this file.
        expect(
          field.description.trim().length,
          `${name}.${field.name} has no description`,
        ).toBeGreaterThan(0);
        expect(
          field.enforced.trim().length,
          `${name}.${field.name} names no enforcing file`,
        ).toBeGreaterThan(0);
      }
    },
  );

  test("an inbound request field is never required-and-nullable", () => {
    // "Always present, value may be null" is a real contract shape — but only
    // outbound. On an inbound request it is a hole: a producer can send null for
    // a field the platform must have, and the difference between "not supplied"
    // and "supplied as nothing" decides whether the gate runs at all. The
    // outbound envelope does use it, for `case_ref` and `org_id`.
    for (const field of RISK_SIGNAL_FIELDS) {
      expect(
        field.nullable ?? false,
        `${field.name} is required and nullable on an inbound request`,
      ).toBe(false);
    }
    const outboundNullable = BANK_EVENT_FIELDS.filter((f) => f.nullable).map((f) => f.name);
    expect(
      outboundNullable.length,
      "the outbound envelope should use nullable somewhere",
    ).toBeGreaterThan(0);
    for (const name of outboundNullable) {
      const field = BANK_EVENT_FIELDS.find((f) => f.name === name)!;
      expect(
        field.required,
        `${name} is nullable but not required, so its key may simply be absent`,
      ).toBe(true);
    }
  });

  test("every declared pattern compiles and is anchored", () => {
    // An unanchored `pattern` matches a substring: `^[A-Z]{3}$` is a currency
    // code, `A-Z` is a substring test that would accept "AED-USD".
    for (const list of Object.values(FIELD_LISTS)) {
      for (const field of list) {
        if (!field.pattern) continue;
        expect(
          () => new RegExp(field.pattern!),
          `${field.name} pattern does not compile`,
        ).not.toThrow();
        expect(
          field.pattern!.startsWith("^"),
          `${field.name} pattern is not anchored at the start`,
        ).toBe(true);
        expect(
          field.pattern!.endsWith("$"),
          `${field.name} pattern is not anchored at the end`,
        ).toBe(true);
      }
    }
  });

  test("the state vocabularies the document quotes as enums are declared in full", () => {
    // These strings are published inside schemas; a state machine that grows a
    // state without updating the contract makes the document reject a real
    // value, which is worse than omitting it.
    const enumsInDocument: string[] = [];
    for (const schema of Object.values(openapi.components.schemas))
      collectEnums(schema, enumsInDocument);
    for (const vocabulary of [DIAL_JOB_STATES, ADMISSION_BANDS]) {
      for (const value of vocabulary) {
        expect(enumsInDocument, `${value} is a real state but is in no published enum`).toContain(
          value,
        );
      }
    }
  });
});

function collectEnums(node: unknown, found: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => collectEnums(child, found));
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "enum" && Array.isArray(value)) found.push(...(value as string[]));
    else collectEnums(value, found);
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * 2. The ingest request schema — the validation contract
 * ────────────────────────────────────────────────────────────────────────── */

describe("the risk signal validates against its own published bounds", () => {
  test("a complete, in-bounds signal is accepted", () => {
    const result = RISK_SIGNAL.safeParse(VALID_SIGNAL);
    expect(offendingFields(result)).toEqual([]);
  });

  test("every required field is required, and every optional field may be omitted", () => {
    const required = RISK_SIGNAL_FIELDS.filter((f) => f.required).map((f) => f.name);
    // Declared as required, rejected when absent. One missing field per row, so
    // a failure names exactly one cause.
    for (const field of required) {
      const payload: Record<string, unknown> = { ...VALID_SIGNAL };
      delete payload[field];
      expect(
        offendingFields(RISK_SIGNAL.safeParse(payload)),
        `${field} is declared required`,
      ).toEqual([field]);
    }
    // Declared optional, absent by default: the minimal valid signal above
    // carries no optional field and still parses.
    const optional = RISK_SIGNAL_FIELDS.filter((f) => !f.required).map((f) => f.name);
    expect(optional.length).toBeGreaterThan(0);
    for (const name of optional) expect(Object.hasOwn(VALID_SIGNAL, name)).toBe(false);
  });

  test("an undeclared field is rejected, not stripped", () => {
    // The ingest is `.strict()`. A silently dropped `account_number` is how a
    // bank ends up with no call and no error.
    const result = RISK_SIGNAL.safeParse({ ...VALID_SIGNAL, account_number: "1234567890" });
    expect(result.success).toBe(false);
    expect(offendingFields(result)).toEqual([""]);
  });

  test("string boundaries: at the limit is accepted, one over is not", () => {
    const cases: Array<[string, string, number, number]> = [
      ["transaction_ref", "transaction_ref", 3, 64],
      ["language", "language", 2, 7],
      ["consent_record_id", "consent_record_id", 4, 64],
      ["merchant", "merchant", 0, 120],
      ["org_id", "org_id", 2, 64],
    ];
    for (const [label, key, min, max] of cases) {
      expect(
        RISK_SIGNAL.safeParse({ ...VALID_SIGNAL, [key]: "x".repeat(min) }).success,
        `${label} at min`,
      ).toBe(true);
      expect(
        RISK_SIGNAL.safeParse({ ...VALID_SIGNAL, [key]: "x".repeat(max) }).success,
        `${label} at max`,
      ).toBe(true);
      if (min > 0) {
        expect(RISK_SIGNAL.safeParse({ ...VALID_SIGNAL, [key]: "x".repeat(min - 1) }).success).toBe(
          false,
        );
      }
      expect(RISK_SIGNAL.safeParse({ ...VALID_SIGNAL, [key]: "x".repeat(max + 1) }).success).toBe(
        false,
      );
    }
  });

  test("numeric boundaries are inclusive and typed", () => {
    // `risk_score` is 0…1 and both ends are real scores.
    for (const score of [0, 0.5, 1]) {
      expect(
        RISK_SIGNAL.safeParse({ ...VALID_SIGNAL, risk_score: score }).success,
        `risk ${score}`,
      ).toBe(true);
    }
    for (const score of [-0.0001, 1.0001]) {
      expect(
        RISK_SIGNAL.safeParse({ ...VALID_SIGNAL, risk_score: score }).success,
        `risk ${score}`,
      ).toBe(false);
    }
    // `amount` is minor units: zero is legitimate, negative is not, and a float
    // is a rounding bug waiting to happen.
    expect(RISK_SIGNAL.safeParse({ ...VALID_SIGNAL, amount: 0 }).success).toBe(true);
    expect(RISK_SIGNAL.safeParse({ ...VALID_SIGNAL, amount: -1 }).success).toBe(false);
    expect(RISK_SIGNAL.safeParse({ ...VALID_SIGNAL, amount: 2500.5 }).success).toBe(false);
  });

  test("no coercion: a wrongly typed value is refused rather than interpreted", () => {
    // The single most valuable property of this layer. A schema that reached for
    // `z.coerce` would silently accept a producer's type mistake and store an
    // interpretation of what they meant.
    const cases: Array<[string, unknown, string]> = [
      ["stringified amount", { amount: "2500" }, "amount"],
      ["boolean amount", { amount: true }, "amount"],
      ["stringified score", { risk_score: "0.94" }, "risk_score"],
      ["null score", { risk_score: null }, "risk_score"],
      ["numeric reference", { transaction_ref: 8612 }, "transaction_ref"],
      ["array phone", { phone: ["+971501234567"] }, "phone"],
      ["object language", { language: { code: "ar" } }, "language"],
    ];
    for (const [label, patch, field] of cases) {
      const result = RISK_SIGNAL.safeParse({ ...VALID_SIGNAL, ...patch });
      expect(result.success, `${label} must be refused, not coerced`).toBe(false);
      expect(offendingFields(result), `${label} names the wrong field`).toContain(field);
    }
  });

  test("the E.164 and ISO-4217 shapes are enforced, not merely suggested", () => {
    const rejected: Array<[string, string]> = [
      ["national format", "0501234567"],
      ["missing plus", "971501234567"],
      ["leading zero after the code", "+0971501234567"],
      ["letter in the digits", "+9715012345a7"],
      ["empty", ""],
    ];
    for (const [label, phone] of rejected) {
      expect(RISK_SIGNAL.safeParse({ ...VALID_SIGNAL, phone }).success, `phone ${label}`).toBe(
        false,
      );
    }
    // Shortest and longest legal E.164 are both accepted; one digit more is not.
    expect(RISK_SIGNAL.safeParse({ ...VALID_SIGNAL, phone: "+12" }).success).toBe(true);
    expect(RISK_SIGNAL.safeParse({ ...VALID_SIGNAL, phone: "+123456789012345" }).success).toBe(
      true,
    );
    expect(RISK_SIGNAL.safeParse({ ...VALID_SIGNAL, phone: "+1234567890123456" }).success).toBe(
      false,
    );

    for (const currency of ["ae", "AEDX", "AE", "A1D", " AED"]) {
      expect(
        RISK_SIGNAL.safeParse({ ...VALID_SIGNAL, currency }).success,
        `currency ${currency}`,
      ).toBe(false);
    }
    for (const currency of ["AED", "USD", "SAR"]) {
      expect(
        RISK_SIGNAL.safeParse({ ...VALID_SIGNAL, currency }).success,
        `currency ${currency}`,
      ).toBe(true);
    }
  });

  test("callback_url is bounded at 300 characters, as published", () => {
    // KNOWN GAP, see the header: the document constrains length but not scheme,
    // so `http://` validates here while the route refuses it. Asserting the
    // length bound only — that is the bound the document actually states.
    const url = "https://bank.example.com/h";
    expect(RISK_SIGNAL.safeParse({ ...VALID_SIGNAL, callback_url: url }).success).toBe(true);
    expect(
      RISK_SIGNAL.safeParse({ ...VALID_SIGNAL, callback_url: url + "x".repeat(300 - url.length) })
        .success,
    ).toBe(true);
    expect(
      RISK_SIGNAL.safeParse({ ...VALID_SIGNAL, callback_url: url + "x".repeat(301 - url.length) })
        .success,
    ).toBe(false);
  });
});

describe("the outbound event validates against its own published bounds", () => {
  const VALID_EVENT = {
    schema_version: OUTBOUND_SCHEMA_VERSION,
    event_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    event_type: "case.notified",
    case_ref: "SV-F-7K2M9Q",
    org_id: "bank-core-uae",
    occurred_at: "2026-10-01T09:30:00.000Z",
    data: {},
  } as const;

  test("a complete envelope is accepted, and nullable fields take null", () => {
    expect(BANK_EVENT.safeParse(VALID_EVENT).success).toBe(true);
    // `case_ref` and `org_id` are REQUIRED but NULLABLE: required means the key
    // is always present, nullable means the value may be null. A receiver that
    // omits the key must still be told, so this is asserted both ways.
    for (const field of ["case_ref", "org_id"]) {
      const withNull = { ...VALID_EVENT, [field]: null };
      expect(BANK_EVENT.safeParse(withNull).success, `${field} may be null`).toBe(true);
      const { [field]: _omitted, ...without } = VALID_EVENT as Record<string, unknown>;
      expect(
        BANK_EVENT.safeParse(without).success,
        `${field} is required and may not be omitted`,
      ).toBe(false);
    }
  });

  test("the evidence pointer carries no evidence, and `data.evidence` is where it must sit", () => {
    // The one value the contract permits in `transcript` is a refusal to carry
    // evidence. Anything else in that slot is a policy failure, not a schema
    // relaxation — so the check is on the VALUE, and case-sensitive: a receiver
    // that lowercases would silently start accepting real text.
    expect(
      EVIDENCE.safeParse({ transcript: "withheld", note: "pull via the case export" }).success,
    ).toBe(true);
    for (const transcript of ["my name is Ahmed and I...", "", "WITHHELD", "withheld "]) {
      expect(
        EVIDENCE.safeParse({ transcript, note: "n" }).success,
        `transcript ${JSON.stringify(transcript)}`,
      ).toBe(false);
    }
    // And a top-level `transcript` on `data` is not a legal field: it belongs
    // under `evidence`, and `.strict()` is what stops a producer from putting
    // it in the wrong place and assuming it was carried.
    expect(
      CASE_NOTIFIED_DATA.safeParse({ ...VALID_EVENT.data, transcript: "withheld" }).success,
    ).toBe(false);
  });

  test("an unknown event_type is rejected, and an unknown envelope field is too", () => {
    // The contract says receivers must IGNORE unknown event types rather than
    // treat them as fatal, but the envelope itself is closed: a field nobody
    // declared is a producer guessing at our schema.
    expect(BANK_EVENT.safeParse({ ...VALID_EVENT, event_type: "case.escalated" }).success).toBe(
      true,
    );
    expect(BANK_EVENT.safeParse({ ...VALID_EVENT, transcript: "withheld" }).success).toBe(false);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * 3. The documents survive serialisation, and building them twice is the
 *    same document
 * ────────────────────────────────────────────────────────────────────────── */

describe("both documents are JSON-clean and deterministic", () => {
  test("a serialise/parse round-trip is lossless for the OpenAPI document", () => {
    // Lossless is the whole assertion. `undefined` deletes a key silently;
    // `NaN` and `Infinity` become `null`; a `Date` becomes a string; a cycle
    // throws. A deep-equal after the round trip catches all four, and a JSON
    // parse is what a bank actually receives.
    expect(JSON.parse(openapiJson)).toEqual(openapi);
  });

  test("a serialise/parse round-trip is lossless for the AsyncAPI document", () => {
    expect(JSON.parse(asyncapiJson)).toEqual(asyncapi);
  });

  test("building either document twice yields byte-identical JSON", () => {
    // A `Date.now()` or a `Math.random()` in a builder makes the document
    // unreviewable in a diff, impossible to cache, and untestable — which is
    // why the property is asserted on the serialised bytes, not on deep equality.
    expect(JSON.stringify(buildOpenApiDocument())).toBe(openapiJson);
    expect(JSON.stringify(buildAsyncApiDocument())).toBe(asyncapiJson);
  });

  test("no value in either document is a non-JSON value", () => {
    // Belt and braces on the round trip: this names the offending path, so a
    // regression says WHERE rather than only that the document changed.
    const offenders: string[] = [];
    const scan = (node: unknown, path: string): void => {
      if (typeof node === "number" && !Number.isFinite(node))
        offenders.push(`${path} = ${String(node)}`);
      if (typeof node === "bigint" || typeof node === "function" || typeof node === "symbol") {
        offenders.push(`${path} is a ${typeof node}`);
      }
      if (Array.isArray(node)) {
        node.forEach((child, i) => scan(child, `${path}[${i}]`));
        return;
      }
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (value === undefined) offenders.push(`${path}.${key} is undefined and would be deleted`);
        scan(value, `${path}.${key}`);
      }
    };
    scan(openapi, "openapi");
    scan(asyncapi, "asyncapi");
    expect(offenders).toEqual([]);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * 4. Paths and operations
 * ────────────────────────────────────────────────────────────────────────── */

describe("the documented surface is addressable", () => {
  test("the path list is exactly the endpoints, and each starts with a slash", () => {
    // Asserted as an explicit list rather than a count. A path that loses a
    // leading slash, or two entries collapsed into one key, leaves the right
    // NUMBER of keys and the wrong document — which is why the list is spelled
    // out here and the paths come from the constants the routes import.
    expect(Object.keys(openapi.paths)).toEqual([
      PUBLIC_INGEST_PATH,
      RETIRED_INGEST_PATH,
      CONFORMANCE_PATH,
      "/openapi",
      "/asyncapi",
    ]);
    for (const path of Object.keys(openapi.paths)) {
      expect(path.startsWith("/"), `"${path}" is not a rooted path`).toBe(true);
      expect(path).not.toContain("//");
      expect(path).not.toContain("?");
      expect(path).not.toContain(" ");
    }
  });

  test("the two ingest paths are distinct, so neither overwrites the other", () => {
    // The public path is rewritten onto the application path, and both are live.
    // If those constants ever collided, one documented endpoint would silently
    // vanish from the document while both names still resolved at runtime.
    expect(PUBLIC_INGEST_PATH).not.toBe(RETIRED_INGEST_PATH);
    expect(PUBLIC_INGEST_PATH.startsWith(RETIRED_INGEST_PATH)).toBe(false);
  });

  test("every operation has a responses object, and no status is a wildcard", () => {
    for (const [path, verb, op] of operations(openapi)) {
      const where = `${verb.toUpperCase()} ${path}`;
      expect(op.responses, `${where} has no responses`).toBeDefined();
      expect(typeof op.responses).toBe("object");
      const statuses = Object.keys(op.responses);
      expect(statuses.length, `${where} declares no response at all`).toBeGreaterThan(0);
      for (const status of statuses) {
        expect(status, `${where} response key "${status}" is not a status code`).toMatch(
          /^[1-5]\d\d$/,
        );
        expect(
          op.responses[status]?.description?.trim().length ?? 0,
          `${where} ${status} has no description`,
        ).toBeGreaterThan(0);
      }
    }
  });

  test("every operation declares a 2xx, except the deliberately retired one", () => {
    // A client generated from a document with no success status cannot call the
    // endpoint at all. The single exception is the retired ingest, whose ONLY
    // documented outcome is 410: it arms nothing and can never succeed, so a 2xx
    // there would be a lie. That exception is pinned rather than tolerated.
    const retired = openapi.paths[RETIRED_INGEST_PATH]?.post;
    expect(
      retired,
      "the retired ingest must stay documented for the migration notice",
    ).toBeDefined();

    for (const [path, verb, op] of operations(openapi)) {
      const statuses = Object.keys(op.responses);
      const success = statuses.filter((s) => s.startsWith("2"));
      if (path === RETIRED_INGEST_PATH) {
        expect(
          success,
          "the retired endpoint must not document a success it can never return",
        ).toEqual([]);
        expect(statuses).toContain("410");
        continue;
      }
      expect(
        success,
        `${verb.toUpperCase()} ${path} declares no 2xx: ${statuses.join(", ")}`,
      ).toHaveLength(1);
    }
  });

  test("operation ids are unique, and every tag is declared in the tag list", () => {
    // A duplicate `operationId` collides in every generated client; an
    // undeclared tag leaves a section header with nothing under it.
    const declared = new Set((openapi.tags ?? []).map((t) => t.name));
    const ids: string[] = [];
    for (const [path, verb, op] of operations(openapi)) {
      const where = `${verb.toUpperCase()} ${path}`;
      expect(op.operationId, `${where} has no operationId`).toBeTruthy();
      ids.push(op.operationId!);
      expect(op.summary?.trim().length ?? 0, `${where} has no summary`).toBeGreaterThan(0);
      expect(op.tags?.length ?? 0, `${where} has no tags`).toBeGreaterThan(0);
      for (const tag of op.tags ?? []) {
        expect(declared, `${where} uses undeclared tag "${tag}"`).toContain(tag);
      }
    }
    expect([...new Set(ids)]).toEqual(ids);
  });

  test("every $ref resolves inside its own document, to something non-empty", () => {
    // The classic invisible defect: the document parses, the operation exists,
    // and the docs page renders a broken link. Resolving every pointer is the
    // only check that catches it — and an EMPTY target is caught too, because
    // a stub component renders exactly as badly as a missing one.
    for (const [name, doc, refs] of [
      ["openapi", openapi, allRefs(openapi)],
      ["asyncapi", asyncapi, allRefs(asyncapi)],
    ] as const) {
      expect(refs.length, `${name} has no $ref to check`).toBeGreaterThan(0);
      for (const pointer of new Set(refs)) {
        const target = resolvePointer(doc, pointer);
        expect(target, `${name}: $ref ${pointer} does not resolve`).toBeDefined();
        expect(
          Object.keys(target as object).length,
          `${name}: $ref ${pointer} resolves to an empty stub`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * 5. The published RiskSignal schema agrees with the field data
 *
 * The validator above tests the DATA. These assert the DOCUMENT carries the
 * same bounds — the two are separate code paths (`objectSchema` in each
 * builder), so a constraint dropped in translation is invisible to the data
 * test and fatal to a generated client.
 * ────────────────────────────────────────────────────────────────────────── */

describe("the published RiskSignal schema states every bound the data declares", () => {
  const published = openapi.components.schemas.RiskSignal;

  test("the property set and the required list are the data's", () => {
    expect(Object.keys(published.properties ?? {}).sort()).toEqual(
      RISK_SIGNAL_FIELDS.map((f) => f.name).sort(),
    );
    expect(published.required).toEqual(
      RISK_SIGNAL_FIELDS.filter((f) => f.required).map((f) => f.name),
    );
    // Strict: an undeclared field is refused. Without this the document would
    // invite a bank to send `account_number` and never say it is illegal.
    expect(published.additionalProperties).toBe(false);
  });

  test.each(RISK_SIGNAL_FIELDS.map((f) => [f.name, f] as const))(
    "%s publishes the bounds it declares",
    (name, field) => {
      const node = published.properties?.[name];
      expect(node, `${name} is not in the published schema`).toBeDefined();
      // A nullable field widens the TYPE, it does not erase it: `["string",
      // "null"]` still admits a string, while `"null"` alone would not.
      const types = Array.isArray(node!.type) ? node!.type : [node!.type];
      expect(types, `${name} type`).toContain(field.nullable ? field.type : field.type);
      if (field.nullable) expect(types, `${name} must admit null`).toContain("null");
      if (field.pattern) expect(node!.pattern, `${name} pattern`).toBe(field.pattern);
      if (field.minLength !== undefined)
        expect(node!.minLength, `${name} minLength`).toBe(field.minLength);
      if (field.maxLength !== undefined)
        expect(node!.maxLength, `${name} maxLength`).toBe(field.maxLength);
      if (field.minimum !== undefined) expect(node!.minimum, `${name} minimum`).toBe(field.minimum);
      if (field.maximum !== undefined) expect(node!.maximum, `${name} maximum`).toBe(field.maximum);
      if (field.enum) expect(node!.enum, `${name} enum`).toEqual(field.enum);
      if (field.example !== undefined) {
        expect(node!["examples"], `${name} must publish its example for codegen`).toEqual([
          field.example,
        ]);
      }
    },
  );
});

/* ──────────────────────────────────────────────────────────────────────────
 * 6. Nothing secret-shaped is published
 * ────────────────────────────────────────────────────────────────────────── */

describe("no example or default in either document looks like a credential", () => {
  const SECRET_SHAPES: Array<[string, RegExp]> = [
    ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
    ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
    ["Stripe key", /\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{8,}/],
    ["JSON web token", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
    ["database connection string", /\b(?:postgres|postgresql|mysql|mongodb\+srv|redis|amqp):\/\//i],
    ["PEM private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ["long hex blob", /\b[0-9a-f]{32,}\b/i],
    ["Slack token", /\bxox[baprs]-[0-9A-Za-z-]{10,}/],
    ["GitHub token", /\bgh[pousr]_[0-9A-Za-z]{20,}\b/],
    ["bearer credential", /\bBearer\s+[A-Za-z0-9._-]{16,}/],
  ];

  test.each(SECRET_SHAPES)("no %s", (label, pattern) => {
    const samples: Array<[string, string]> = [];
    sampleValues(openapi, "openapi", samples);
    sampleValues(asyncapi, "asyncapi", samples);
    expect(samples.length, "no sample values found to scan").toBeGreaterThan(0);
    const hits = samples
      .filter(([, text]) => pattern.test(text))
      .map(([path, text]) => `${path} = ${text}`);
    expect(hits, `a ${label} is published in a contract document`).toEqual([]);
  });

  test("the request-id example is opaque, not derived from anything real", () => {
    // The one identifier-shaped value in the document. It must not encode a
    // timestamp, a counter or a host: an example that looks like a real id is
    // an example someone will paste into a support ticket.
    const requestIds = [...openapiJson.matchAll(/"requestId":\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(requestIds.length).toBeGreaterThan(0);
    for (const id of requestIds) {
      expect(id.startsWith("req_"), `${id} does not carry the documented prefix`).toBe(true);
      expect(id).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
    }
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * 7. The AsyncAPI document describes a webhook, not a request
 * ────────────────────────────────────────────────────────────────────────── */

describe("the AsyncAPI document describes the delivery surface completely", () => {
  const delivery = asyncapi["x-delivery"] as unknown as {
    maxAttempts: number;
    ladderMs: number[];
    ladderHuman: string[];
    retryableStatuses: unknown[];
    terminalStatuses: string[];
    dedupeKey: string;
  };

  test("every template variable in the channel address is declared", () => {
    // An undeclared `{var}` in an address renders as a literal brace in every
    // docs UI and produces an un-routable channel for a code generator.
    const raw = JSON.parse(asyncapiJson) as {
      channels: Record<string, { address: string; parameters: Record<string, unknown> }>;
      servers: Record<string, { host: string; variables: Record<string, unknown> }>;
    };
    for (const [name, ch] of Object.entries(raw.channels)) {
      const used = [...ch.address.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
      expect(used.length, `channel ${name} declares no server variable`).toBeGreaterThan(0);
      for (const variable of used) {
        expect(
          Object.hasOwn(ch.parameters, variable),
          `channel ${name} does not describe ${variable}`,
        ).toBe(true);
      }
    }
    for (const server of Object.values(raw.servers)) {
      for (const used of [...server.host.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)) {
        expect(
          Object.hasOwn(server.variables, used),
          `server host ${server.host} does not declare ${used}`,
        ).toBe(true);
      }
    }
  });

  test("the retry ladder is strictly increasing and as long as the attempt count", () => {
    // A ladder shorter than the attempt count means the last attempt happens
    // immediately; a non-increasing step means a retry fires before the one
    // before it, which is a hot loop against a bank that is already failing.
    expect(delivery.ladderMs).toEqual([...DELIVERY_ATTEMPT_LADDER_MS]);
    expect(delivery.maxAttempts).toBe(MAX_DELIVERY_ATTEMPTS);
    expect(delivery.ladderMs).toHaveLength(MAX_DELIVERY_ATTEMPTS);
    expect(delivery.ladderHuman).toHaveLength(delivery.ladderMs.length);
    for (const [index, step] of delivery.ladderMs.entries()) {
      if (index === 0) continue;
      expect(step, `step ${index + 1} is not later than step ${index}`).toBeGreaterThan(
        delivery.ladderMs[index - 1]!,
      );
    }
  });

  test("retryable and terminal statuses are disjoint and together cover every status", () => {
    // "Which statuses retry" and "which statuses stop the ladder" must not
    // overlap: an event that is both is retried and dead-lettered, and no
    // receiver knows whether it has to durably record it.
    const retryable = delivery.retryableStatuses.map(String);
    const terminal = delivery.terminalStatuses.map(String);
    expect(retryable).toContain("network_error");
    expect(retryable).toContain("429");
    expect(terminal.length).toBeGreaterThan(0);
    for (const status of retryable) {
      for (const other of terminal) {
        expect(status === other, `${status} is both retryable and terminal`).toBe(false);
      }
    }
  });

  test("the dedupe key is a field of the envelope it dedupes", () => {
    // A dedupe key that is not in the message cannot be read by a receiver, so
    // the redelivery is applied twice — the exact failure the ladder creates.
    expect(delivery.dedupeKey).toBe("event_id");
    expect(BANK_EVENT_FIELDS.map((f) => f.name)).toContain(delivery.dedupeKey);
  });

  test("the only event types listed are ones the schema can carry", () => {
    const types = asyncapi["x-event-types"] as unknown as string[];
    expect(types.length).toBeGreaterThan(0);
    for (const type of types) {
      // Dotted, lowercase, and specific enough to be a name rather than a
      // category: `case.*` is what a receiver can switch on.
      expect(type).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$/);
      expect(Object.hasOwn(asyncapi.components.schemas, "CaseNotifiedData")).toBe(true);
    }
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * 8. The error catalog is usable by a machine
 * ────────────────────────────────────────────────────────────────────────── */

describe("the error catalog a bank switches on is well formed", () => {
  test("ids are unique, and a code is present exactly where the surface promises one", () => {
    // `surface` is the reason the catalog exists: `http_body` means a caller can
    // branch on the `code` field, `http_message` means the code is prose the
    // bank must not parse, and `audit_chain` means it is nowhere in the
    // response. A row that contradicts its own surface teaches a bank to branch
    // on a field that will not be there.
    const ids = ERROR_CODES.map((e) => e.id);
    expect([...new Set(ids)]).toEqual(ids);
    for (const entry of ERROR_CODES) {
      if (entry.surface === "http_body") {
        expect(entry.code, `${entry.id} is an http_body row with no code`).not.toBeNull();
      } else {
        expect(
          entry.code,
          `${entry.id} is a ${entry.surface} row that claims a body code`,
        ).toBeNull();
      }
      if (entry.surface === "http_message") {
        expect(
          entry.envelopeCode,
          `${entry.id} does not say what the code field will be`,
        ).toBeTruthy();
      } else {
        expect(
          entry.envelopeCode,
          `${entry.id} has an envelopeCode but is not an http_message row`,
        ).toBeUndefined();
      }
    }
  });

  test("every code the envelope can report is documented, and every documented code is real", () => {
    // Two directions, because a spec that is too narrow rejects a legal body
    // and one that is too wide invites a bank to handle a code that never comes.
    const body = new Set(bodyErrorCodes());
    for (const code of failureEnvelopeCodes()) {
      expect([...body], `${code} is reachable but is in no body's code list`).toContain(code);
    }
    for (const entry of ERROR_CODES) {
      if (!entry.envelopeCode) continue;
      expect(
        [...body],
        `${entry.id} promises code "${entry.envelopeCode}" which nothing produces`,
      ).toContain(entry.envelopeCode);
    }
  });

  test("the derived code lists are sorted and duplicate-free", () => {
    // These lists are the `enum` in the published envelope schema. A duplicate
    // is invisible in JSON and a non-sorted list makes every regenerated
    // document diff for no reason.
    for (const list of [bodyErrorCodes(), failureEnvelopeCodes()]) {
      expect([...new Set(list)]).toEqual([...list]);
      expect([...list].sort()).toEqual([...list]);
    }
  });

  test("looking a code up by its source literal is exact and total", () => {
    // The catalog is hand-written; this is the lookup a drift check performs.
    // A literal that matches nothing returns empty rather than throwing, so the
    // only failure mode is a row whose own literal cannot find itself.
    expect(errorCodesForLiteral("a_literal_no_row_emits")).toEqual([]);
    for (const entry of ERROR_CODES) {
      const found = errorCodesForLiteral(entry.literal);
      expect(
        found.map((e) => e.id),
        `${entry.id} cannot find its own literal`,
      ).toContain(entry.id);
    }
  });

  test("every catalog row names at least one documented endpoint, and one that exists", () => {
    const surfaces = new Set([
      `POST ${PUBLIC_INGEST_PATH}`,
      `POST ${RETIRED_INGEST_PATH}`,
      `POST ${CONFORMANCE_PATH}`,
    ]);
    for (const entry of ERROR_CODES) {
      expect(entry.reachedFrom.length, `${entry.id} is reachable from nothing`).toBeGreaterThan(0);
      for (const from of entry.reachedFrom) {
        // `POST /path` for a documented endpoint; internal surfaces are labelled
        // with their operator/agent role and are allowed to be undocumented.
        const [verb, path] = from.split(" ");
        expect(verb, `${entry.id} names "${from}", which is not an operation label`).toMatch(
          /^[A-Z]+$/,
        );
        if (path && path.startsWith("/") && !from.includes("(")) {
          expect(surfaces.has(from), `${entry.id} names undocumented endpoint ${from}`).toBe(true);
        }
      }
    }
  });

  test("status-only failures are legacy-envelope rows with a distinct status", () => {
    // This list is what a bank still on `/api/interventions` sees: prose, no
    // `code`, nothing to branch on. If a row ever claimed the modern envelope a
    // migrating bank's error handler would look for a `code` that is not there.
    const ids = STATUS_FAILURES.map((f) => f.id);
    expect([...new Set(ids)]).toEqual(ids);
    for (const failure of STATUS_FAILURES) {
      expect(failure.envelope, `${failure.id} is not a legacy row`).toBe("legacy_error_field");
      expect(failure.status, `${failure.id} has no status`).toBeGreaterThanOrEqual(400);
      expect(
        failure.errorExample.trim().length,
        `${failure.id} has no example prose`,
      ).toBeGreaterThan(0);
    }
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * 9. The conformance checker's verdicts
 *
 * A receiver is modelled here by a TRANSPORT, never by the production
 * verifier's opinion of itself: the checker grades what comes back, so a fake
 * that decides its own status exercises the real grading path. Signature
 * validity is decided by the production verifier so the tampered and unsigned
 * probes are distinguishable on the wire, exactly as a real receiver sees them.
 * ────────────────────────────────────────────────────────────────────────── */

const RECEIVER_URL = "https://receiver.bank.example/hooks/securevoice";
const RECEIVER_SECRET = "unit-checker-shared-secret-0123456789";

type ReceiverBehaviour = {
  /** Refuse a tampered or absent signature with a 4xx. */
  verifySignature?: boolean;
  /** Echo the applied event_id so the dedupe key is verifiable. */
  echoEventId?: boolean;
  /** Recognise a redelivery and say so. */
  markReplay?: boolean;
  /** Which spelling to use when marking a replay. */
  replayMarker?: string;
  /** Acknowledge a correctly signed but schema-invalid payload. */
  acceptMalformed?: boolean;
  /** Latency the transport reports for a well-formed delivery. */
  latencyMs?: number;
};

/** A receiver that answers like one a bank would write. */
function receiver(behaviour: ReceiverBehaviour = {}): ConformanceTransport {
  const opts: Required<ReceiverBehaviour> = {
    verifySignature: true,
    echoEventId: true,
    markReplay: true,
    replayMarker: "duplicate",
    acceptMalformed: false,
    latencyMs: 4,
    ...behaviour,
  };
  const applied = new Set<string>();

  return async (request: TransportRequest): Promise<TransportResponse> => {
    const signature = request.headers["sv-signature"];
    const verdict = signature
      ? verifySignature(signature, request.body, RECEIVER_SECRET)
      : { ok: false as const };
    if (opts.verifySignature && !verdict.ok) {
      return { status: 401, headers: {}, body: "{}", latencyMs: 2 };
    }
    const event = JSON.parse(request.body) as { event_id: string; data: unknown };
    // A signed payload whose `data` is not an object is schema-invalid.
    if (typeof event.data !== "object" || event.data === null) {
      return opts.acceptMalformed
        ? { status: 202, headers: {}, body: JSON.stringify({ ok: true }), latencyMs: 2 }
        : {
            status: 422,
            headers: {},
            body: JSON.stringify({ error: "invalid_event" }),
            latencyMs: 2,
          };
    }
    const redelivery = applied.has(event.event_id);
    applied.add(event.event_id);
    const body: Record<string, unknown> = { ok: true };
    if (opts.echoEventId) body.event_id = event.event_id;
    if (redelivery && opts.markReplay) body[opts.replayMarker] = true;
    return { status: 202, headers: {}, body: JSON.stringify(body), latencyMs: opts.latencyMs };
  };
}

function grade(transport: ConformanceTransport, budgetMs?: number): Promise<ConformanceReport> {
  return runConformance({
    receiverUrl: RECEIVER_URL,
    secret: RECEIVER_SECRET,
    transport,
    ...(budgetMs === undefined ? {} : { budgetMs }),
  });
}

const statusOf = (report: ConformanceReport, id: string): string | undefined =>
  report.checks.find((c) => c.id === id)?.status;

const observedFor = (report: ConformanceReport, id: string): string =>
  report.checks.find((c) => c.id === id)?.observed ?? "";

const failingIds = (report: ConformanceReport): string[] =>
  report.checks.filter((c) => c.status === "fail").map((c) => c.id);

describe("the checker grades a receiver that satisfies every requirement", () => {
  test("a correct receiver conforms, at a full score", async () => {
    const report = await grade(receiver());
    expect(failingIds(report)).toEqual([]);
    expect(report.score).toEqual({ passed: 5, total: 5, percent: 100, verdict: "conforming" });
    // Every graded id is reported, in the catalog's order, with the requirement
    // it grades against — a check that is not listed cannot be acted on.
    expect(report.checks.map((c) => c.id)).toEqual([...CONFORMANCE_CHECK_IDS]);
    for (const check of report.checks) {
      expect(check.requirement, `${check.id} quotes the wrong requirement`).toBe(
        CONFORMANCE_REQUIREMENTS[check.id],
      );
    }
  });

  test("the report is JSON-clean and carries neither the secret nor a signature", async () => {
    const report = await grade(receiver());
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(JSON.stringify(report), "the report leaked the shared secret").not.toContain(
      RECEIVER_SECRET,
    );
    // The signature must not be in the report either: a report is attachable to
    // a change record, and a signature is replayable material.
    expect(JSON.stringify(report)).not.toContain("v1=");
  });
});

describe("the checker's verdict logic", () => {
  test("each requirement, broken alone, fails its own check and nothing else", async () => {
    // "Fails and ONLY that" is the property: a receiver that fails one
    // requirement must be told about that one, or a bank fixes the wrong thing.
    const cases: Array<[string, ReceiverBehaviour, string]> = [
      [
        "a receiver that accepts a tampered digest",
        { verifySignature: false },
        "signature_verified",
      ],
      [
        "a receiver that never identifies the applied event",
        { echoEventId: false },
        "idempotency_honoured",
      ],
      ["a receiver slower than the budget", { latencyMs: 5000 }, "fast_2xx"],
      ["a receiver that applies every redelivery", { markReplay: false }, "replay_handled"],
      [
        "a receiver that acknowledges what it cannot parse",
        { acceptMalformed: true },
        "rejects_malformed",
      ],
    ];
    for (const [label, behaviour, expected] of cases) {
      const report = await grade(receiver(behaviour));
      expect(failingIds(report), `${label} should fail exactly ${expected}`).toEqual([expected]);
      expect(statusOf(report, expected)).toBe("fail");
      expect(report.score.verdict).toBe("non_conforming");
    }
  });

  test("a receiver that refuses a tampered digest but ACCEPTS an unsigned one still fails", async () => {
    // The two halves of `signature_verified` are graded TOGETHER, and the
    // unsigned half is the more dangerous one: accepting a request with no proof
    // of origin applies forged events. A receiver can pass the tampered half
    // and still be unsafe, so a verdict that ignored it would be wrong.
    const transport: ConformanceTransport = async (request) => {
      if (!request.headers["sv-signature"]) {
        return { status: 202, headers: {}, body: JSON.stringify({ ok: true }), latencyMs: 1 };
      }
      const verdict = verifySignature(
        request.headers["sv-signature"]!,
        request.body,
        RECEIVER_SECRET,
      );
      return verdict.ok
        ? { status: 202, headers: {}, body: "{}", latencyMs: 1 }
        : { status: 401, headers: {}, body: "{}", latencyMs: 1 };
    };
    const report = await grade(transport);
    expect(statusOf(report, "signature_verified")).toBe("fail");
    // The reason names BOTH probes and the statuses seen, because the failure is
    // a pair and a bank must be able to tell which half it is getting wrong.
    expect(observedFor(report, "signature_verified")).toContain("tampered digest");
    expect(observedFor(report, "signature_verified")).toContain("unsigned");
    expect(observedFor(report, "signature_verified")).toContain("202");
  });

  test("the 2xx boundary is 200–299 inclusive: a redirect is not a success", async () => {
    // A 3xx is a receiver that has been moved and is not processing the event.
    // The checker must not read it as acceptance, or a bank is told it is
    // conforming while its deliveries die at the redirect.
    const withStatus =
      (status: number): ConformanceTransport =>
      async (request) => {
        if (!request.headers["sv-signature"])
          return { status: 401, headers: {}, body: "{}", latencyMs: 1 };
        const event = JSON.parse(request.body) as { event_id: string };
        return {
          status,
          headers: {},
          body: JSON.stringify({ event_id: event.event_id, duplicate: true }),
          latencyMs: 1,
        };
      };
    for (const status of [200, 202, 204, 299]) {
      expect(statusOf(await grade(withStatus(status)), "fast_2xx"), `status ${status}`).toBe(
        "pass",
      );
    }
    for (const status of [199, 300, 301, 400, 500]) {
      expect(statusOf(await grade(withStatus(status)), "fast_2xx"), `status ${status}`).toBe(
        "fail",
      );
    }
  });

  test("the malformed-payload check grades a deliberate 4xx, not any non-2xx", async () => {
    // A 5xx for a malformed payload is the receiver being broken, not the
    // payload being rejected: passing that would grade a broken receiver as
    // correct on the one check that proves it does not acknowledge blindly.
    const withStatus =
      (status: number): ConformanceTransport =>
      async (request) => {
        const event = JSON.parse(request.body) as { event_id: string; data: unknown };
        if (typeof event.data !== "object" || event.data === null) {
          return { status, headers: {}, body: "{}", latencyMs: 1 };
        }
        if (!request.headers["sv-signature"])
          return { status: 401, headers: {}, body: "{}", latencyMs: 1 };
        return {
          status: 202,
          headers: {},
          body: JSON.stringify({ event_id: event.event_id, duplicate: true }),
          latencyMs: 1,
        };
      };
    for (const status of [400, 401, 403, 422, 499]) {
      expect(
        statusOf(await grade(withStatus(status)), "rejects_malformed"),
        `status ${status}`,
      ).toBe("pass");
    }
    for (const status of [200, 202, 301, 500, 503]) {
      expect(
        statusOf(await grade(withStatus(status)), "rejects_malformed"),
        `status ${status}`,
      ).toBe("fail");
    }
    // And the failure says what accepting it costs, because "non-conforming"
    // alone is not actionable.
    expect(observedFor(await grade(withStatus(500)), "rejects_malformed")).toMatch(/ACKNOWLEDGED/);
  });

  test("the fast_2xx check measures the budget it was given, and quotes it", async () => {
    const slow = receiver({ latencyMs: 3000 });
    const atDefault = await grade(slow);
    expect(statusOf(atDefault, "fast_2xx")).toBe("fail");
    expect(observedFor(atDefault, "fast_2xx")).toContain("3000ms");
    expect(observedFor(atDefault, "fast_2xx")).toContain(`${DEFAULT_BUDGET_MS}ms`);
    // The same receiver inside a budget it declared passes: the check grades
    // the receiver against ITS budget, not against a constant we invented.
    expect(statusOf(await grade(slow, 4000), "fast_2xx")).toBe("pass");
  });

  test("the budget is clamped into the published range, and an absent one defaults", async () => {
    // The published `ConformanceRunRequest` states 100–10000ms; a budget outside
    // that range must not reach the report, or the report grades against a
    // budget the document says is impossible.
    expect((await grade(receiver(), 1)).budget_ms).toBe(MIN_BUDGET_MS);
    expect((await grade(receiver(), 999_999)).budget_ms).toBe(MAX_BUDGET_MS);
    expect((await grade(receiver())).budget_ms).toBe(DEFAULT_BUDGET_MS);
    expect((await grade(receiver(), MIN_BUDGET_MS)).budget_ms).toBe(MIN_BUDGET_MS);
    expect((await grade(receiver(), MAX_BUDGET_MS)).budget_ms).toBe(MAX_BUDGET_MS);
  });

  test("every documented spelling of the replay marker is accepted", async () => {
    // Deliberate vocabulary tolerance: a bank must not lose a conformance run
    // because it guessed `replayed` where we wrote `duplicate`.
    expect(DUPLICATE_BODY_MARKERS.length).toBeGreaterThan(1);
    for (const marker of DUPLICATE_BODY_MARKERS) {
      const report = await grade(receiver({ replayMarker: marker }));
      expect(statusOf(report, "replay_handled"), `marker ${marker}`).toBe("pass");
    }
  });

  test("an unrecognised marker is not a marker: the redelivery is applied twice", async () => {
    // The tolerance above has a boundary, and this is it. Reading an
    // unrecognised key as a duplicate would certify a receiver that re-applies.
    const report = await grade(receiver({ replayMarker: "already_seen" }));
    expect(statusOf(report, "replay_handled")).toBe("fail");
    expect(observedFor(report, "replay_handled")).toMatch(/applies the event twice/);
  });

  test("the applied event may be acknowledged in the body or in either echo header", async () => {
    // Same reasoning as the replay marker: the dedupe key has to be provable,
    // but the bank should not have to guess which header we read.
    expect(EVENT_ID_ECHO_HEADERS.length).toBeGreaterThan(1);
    for (const header of EVENT_ID_ECHO_HEADERS) {
      const transport: ConformanceTransport = async (request) => {
        const verdict = request.headers["sv-signature"]
          ? verifySignature(request.headers["sv-signature"], request.body, RECEIVER_SECRET)
          : { ok: false as const };
        if (!verdict.ok) return { status: 401, headers: {}, body: "{}", latencyMs: 1 };
        const event = JSON.parse(request.body) as { event_id: string; data: unknown };
        if (typeof event.data !== "object" || event.data === null) {
          return { status: 422, headers: {}, body: "{}", latencyMs: 1 };
        }
        const headers: Record<string, string> = { [header]: event.event_id };
        return { status: 202, headers, body: JSON.stringify({ duplicate: true }), latencyMs: 1 };
      };
      expect(statusOf(await grade(transport), "idempotency_honoured"), `header ${header}`).toBe(
        "pass",
      );
    }
  });

  test("an unparseable acknowledgement is not read as an acknowledgement", async () => {
    // A receiver answering with an HTML error page has told us nothing. Reading
    // it as "no duplicate marker" would fail, which is right; the distinction
    // that matters is that it must not be read as success.
    const transport: ConformanceTransport = async (request) => {
      if (!request.headers["sv-signature"])
        return { status: 401, headers: {}, body: "{}", latencyMs: 1 };
      return { status: 202, headers: {}, body: "<html>ok</html>", latencyMs: 1 };
    };
    const report = await grade(transport);
    expect(report.probes[1]?.duplicate_marker).toBeNull();
    expect(statusOf(report, "replay_handled")).toBe("fail");
    expect(statusOf(report, "idempotency_honoured")).toBe("fail");
  });

  test("a receiver that never answers fails every check and still returns a report", async () => {
    // The report must exist for an unreachable receiver: it is the artefact a
    // bank attaches to a ticket saying "we ran it and here is what happened".
    const report = await grade(deadTransport);
    expect(failingIds(report)).toEqual([...CONFORMANCE_CHECK_IDS]);
    expect(report.score.verdict).toBe("non_conforming");
    // Every probe is still OBSERVED, at status 0, with the transport error
    // attached. That is deliberate: a probe that vanished from the report would
    // leave a bank unable to tell "no response" from "never sent".
    expect(report.probes).toHaveLength(5);
    for (const probe of report.probes) {
      expect(probe.status).toBe(0);
      expect(probe.error, `probe ${probe.seq} lost its transport error`).toBeTruthy();
    }
    // And every check explains itself in terms a receiver can act on: the
    // statuses it saw, not a bare "failed".
    expect(observedFor(report, "signature_verified")).toContain("HTTP 0");
    expect(observedFor(report, "fast_2xx")).toContain("got 0");
    expect(observedFor(report, "idempotency_honoured")).toContain("dedupe key");
    expect(observedFor(report, "replay_handled")).toContain("produced no response");
    expect(observedFor(report, "rejects_malformed")).toContain("ACKNOWLEDGED");
    // The report also says reachability first, so a bank does not read five
    // check results as five defects in its own code.
    expect(report.notes.some((note) => /never got a response/.test(note))).toBe(true);
  });

  test("a very long transport error is truncated rather than pasted into the report", async () => {
    // The report is a document a human reads. An unbounded third-party error
    // string is both unreadable and a log-injection surface, so the length is
    // capped and the cut is visible.
    const noisy: ConformanceTransport = async () => {
      throw new Error("E".repeat(5000));
    };
    const report = await grade(noisy);
    const error = report.probes[0]!.error!;
    expect(error.length).toBeLessThan(200);
    expect(error.endsWith("…"), "a truncated message must show that it was truncated").toBe(true);
  });

  test("the score is the fraction of checks passed, and the verdict is all-or-nothing", async () => {
    // A receiver failing one of five is at 80%, and is NOT conforming: the
    // verdict gates an integration decision, so it cannot be a threshold.
    const one = await grade(receiver({ latencyMs: 5000 }));
    expect(one.score).toMatchObject({
      passed: 4,
      total: 5,
      percent: 80,
      verdict: "non_conforming",
    });
    const all = await grade(receiver());
    expect(all.score.percent).toBe(100);
    expect(all.score.verdict).toBe("conforming");
    // `percent` is derived from the counts, never asserted independently.
    for (const report of [one, all, await grade(deadTransport)]) {
      expect(report.score.percent).toBe(
        Math.round((report.score.passed / report.score.total) * 100),
      );
      expect(report.score.verdict).toBe(
        report.score.passed === report.score.total ? "conforming" : "non_conforming",
      );
    }
  });

  test("every probe case_ref uses the alphabet the checker actually generates from", async () => {
    // `case_ref` is the join key between the bank's alert and the case. A probe
    // carrying a character outside the alphabet would be one a receiver
    // validating the field rejects — so the checker would be grading the
    // receiver's schema handling instead of its delivery discipline.
    //
    // KNOWN GAP, see the header: `schema.ts:377` documents the alphabet as
    // excluding U, and `CASE_ALPHABET` does contain U. Asserted against the
    // alphabet the code uses (I, L and O excluded), so the drift stays visible.
    const seen: string[] = [];
    const transport: ConformanceTransport = async (request) => {
      seen.push((JSON.parse(request.body) as { case_ref: string }).case_ref);
      return { status: 200, headers: {}, body: "{}", latencyMs: 1 };
    };
    for (let i = 0; i < 64; i++) {
      await runConformance({
        receiverUrl: RECEIVER_URL,
        secret: RECEIVER_SECRET,
        transport,
        newRunId: () => `${i.toString(16).padStart(8, "0")}-ffff-4aaa-8bbb`,
      });
    }
    expect(seen.length).toBeGreaterThan(0);
    // Six characters from a 31-symbol alphabet, and never the three symbols a
    // human reading the reference aloud would mishear.
    for (const ref of new Set(seen)) {
      expect(ref, `${ref} is not a well-formed case reference`).toMatch(/^SV-F-[2-9A-HJ-NP-Z]{6}$/);
      expect(ref, `${ref} contains a symbol the alphabet excludes`).not.toMatch(/[ILO]/);
    }
  });

  test("a non-absolute receiver URL is a programming error, not a report", async () => {
    // The SSRF verdict runs before the checker is called, so a relative URL can
    // only mean a caller bypassed it. Throwing is correct: a bank must never
    // receive a report that grades a target we never validated.
    await expect(
      runConformance({
        receiverUrl: "receiver.bank.example/hooks",
        secret: RECEIVER_SECRET,
        transport: receiver(),
      }),
    ).rejects.toThrow(/absolute URL/);
  });
});

const deadTransport: ConformanceTransport = async () => {
  throw new Error("connect ECONNREFUSED 10.0.0.7:443");
};

describe("the request entry point validates before it authorises, and grades", () => {
  const deps = {
    validateUrl: async (raw: string) => ({
      ok: true as const,
      url: new URL(raw),
      addresses: ["93.184.216.34"],
    }),
    authenticate: async () => ({ ok: true as const, callerId: "pk:unit", orgId: null }),
    rateLimit: () => ({ ok: true as const }),
    transport: receiver(),
  };

  test("a well-formed, authorised request is graded", async () => {
    const outcome = await handleConformanceRun(
      { receiver_url: RECEIVER_URL, secret: RECEIVER_SECRET },
      deps,
    );
    expect(outcome.kind).toBe("report");
    if (outcome.kind !== "report") return;
    expect(outcome.report.score.verdict).toBe("conforming");
    expect(outcome.report.target.url).toBe(RECEIVER_URL);
    expect(outcome.report.target.host).toBe("receiver.bank.example");
  });

  test("a malformed request is refused before authentication is attempted", async () => {
    // Validation first: an unauthenticated caller must not be able to use the
    // checker's error messages as an oracle for what a valid request looks like.
    let authenticated = 0;
    const watched = {
      ...deps,
      authenticate: async () => {
        authenticated++;
        return { ok: true as const, callerId: "pk:unit", orgId: null };
      },
    };
    const malformed: Array<[string, unknown]> = [
      ["nothing", {}],
      ["no secret", { receiver_url: RECEIVER_URL }],
      ["no url", { secret: RECEIVER_SECRET }],
      ["blank url", { receiver_url: "   ", secret: RECEIVER_SECRET }],
      ["a url that is not a string", { receiver_url: 42, secret: RECEIVER_SECRET }],
      ["a secret that is not a string", { receiver_url: RECEIVER_URL, secret: { value: "x" } }],
      ["a secret one character short", { receiver_url: RECEIVER_URL, secret: "x".repeat(7) }],
    ];
    for (const [label, input] of malformed) {
      const outcome = await handleConformanceRun(input as { receiver_url?: unknown }, watched);
      expect(outcome.kind, `${label} must be refused`).toBe("refused");
      if (outcome.kind !== "refused") continue;
      expect(outcome.refusal.code, `${label} was refused with the wrong code`).toBe(
        "malformed_request",
      );
      // The detail names the field to fix, and the length that was demanded.
      expect(outcome.refusal.detail).toContain("receiver_url");
      expect(outcome.refusal.detail).toContain("8 characters");
    }
    expect(authenticated, "a malformed request must not reach authentication").toBe(0);
  });

  test("the secret length boundary is exactly the published minimum", async () => {
    // Seven characters is refused and eight is accepted. The published
    // `ConformanceRunRequest` states `minLength: 8`; if the checker demanded a
    // different length, a bank coding from the document would be refused for a
    // secret the document said was legal.
    const published =
      openapi.components.schemas.ConformanceRunRequest.properties?.secret?.minLength;
    expect(published).toBe(8);
    const short = await handleConformanceRun(
      { receiver_url: RECEIVER_URL, secret: "x".repeat((published ?? 8) - 1) },
      deps,
    );
    expect(short.kind).toBe("refused");
    const exact = await handleConformanceRun(
      { receiver_url: RECEIVER_URL, secret: "x".repeat(published ?? 8) },
      deps,
    );
    expect(exact.kind).toBe("report");
  });

  test("an unauthenticated caller is refused, and the reason is carried in the detail", async () => {
    const outcome = await handleConformanceRun(
      { receiver_url: RECEIVER_URL, secret: RECEIVER_SECRET },
      {
        ...deps,
        authenticate: async () => ({ ok: false as const, reason: "revoked producer key" }),
      },
    );
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("unauthenticated");
    // The detail must reach the producer: "you need a producer key" with no
    // reason is not something an integrator can act on.
    expect(outcome.refusal.detail).toContain("producer key");
    expect(outcome.refusal.detail).toContain("revoked producer key");
  });

  test("a rate-limited caller is refused with the retry delay attached", async () => {
    const outcome = await handleConformanceRun(
      { receiver_url: RECEIVER_URL, secret: RECEIVER_SECRET },
      { ...deps, rateLimit: () => ({ ok: false as const, retryAfterSec: 42 }) },
    );
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("rate_limited");
    expect(outcome.refusal.retryAfterSec).toBe(42);
  });

  test("a blocked target is refused with the verdict code named, and nothing is dialled", async () => {
    // The SSRF verdict is the only thing between an authenticated caller and
    // our deployment POSTing to a URL the caller chose, so the refusal must
    // name the verdict code — `receiver_url refused …: <code>` — or a bank
    // cannot tell a typo from a policy refusal.
    let dialled = 0;
    const outcome = await handleConformanceRun(
      { receiver_url: "https://169.254.169.254/latest/meta-data/", secret: RECEIVER_SECRET },
      {
        ...deps,
        validateUrl: async () => ({
          ok: false as const,
          code: "metadata_address",
          reason: "cloud metadata endpoint",
        }),
        transport: async () => {
          dialled++;
          return { status: 200, headers: {}, body: "{}", latencyMs: 1 };
        },
      },
    );
    expect(outcome.kind).toBe("refused");
    expect(dialled, "a blocked target must never be dialled").toBe(0);
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.code).toBe("semantically_invalid");
    expect(outcome.refusal.detail).toContain("metadata_address");
    expect(outcome.refusal.detail).toContain("cloud metadata endpoint");
  });

  test("the budget is honoured only when it is a finite number", async () => {
    // A budget sent as a string is not a budget. Falling back to the default
    // rather than parsing it is deliberate: `Number("5000")` would make a
    // caller who sent `"5000"` believe they graded against 5 s.
    const withBudget = async (budget_ms: unknown): Promise<number | undefined> => {
      const outcome = await handleConformanceRun(
        { receiver_url: RECEIVER_URL, secret: RECEIVER_SECRET, budget_ms },
        deps,
      );
      return outcome.kind === "report" ? outcome.report.budget_ms : undefined;
    };
    expect(await withBudget(4000)).toBe(4000);
    expect(await withBudget("4000")).toBe(DEFAULT_BUDGET_MS);
    expect(await withBudget(Number.NaN)).toBe(DEFAULT_BUDGET_MS);
    expect(await withBudget(Number.POSITIVE_INFINITY)).toBe(DEFAULT_BUDGET_MS);
    // A negative budget is a number, so it reaches the checker and is clamped
    // there rather than silently replaced.
    expect(await withBudget(-50)).toBe(MIN_BUDGET_MS);
  });

  test("org_id is trimmed, and a blank one is the shared namespace", async () => {
    // `org_id` is echoed on every probe, so an untrimmed value would tag a
    // bank with an org that does not exist, and a blank one would be tagged
    // with whitespace.
    const orgsPerRun = async (org_id: unknown): Promise<unknown[]> => {
      const orgs: unknown[] = [];
      await handleConformanceRun(
        { receiver_url: RECEIVER_URL, secret: RECEIVER_SECRET, org_id },
        {
          ...deps,
          transport: async (request) => {
            const event = JSON.parse(request.body) as { org_id: unknown };
            orgs.push(event.org_id);
            return { status: 200, headers: {}, body: "{}", latencyMs: 1 };
          },
        },
      );
      return orgs;
    };
    expect(await orgsPerRun("  tenant-x  ")).toEqual([
      "tenant-x",
      "tenant-x",
      "tenant-x",
      "tenant-x",
      null,
    ]);
    expect(await orgsPerRun("   ")).toEqual([null, null, null, null, null]);
    expect(await orgsPerRun(42)).toEqual([null, null, null, null, null]);
  });
});
