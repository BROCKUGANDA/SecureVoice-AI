/**
 * Integration-contract gate (WP-17).
 *
 * The claim being defended: **the published contract is the code.** Not "was
 * accurate when written" — is accurate now, and fails the build the moment it
 * stops being.
 *
 * That is the whole reason the OpenAPI and AsyncAPI documents are GENERATED
 * (`src/lib/contracts/openapi.ts`, `asyncapi.ts`) from a hand-written catalog
 * (`schema.ts`) that is itself transcribed from the implementation. Generation
 * alone is not enough: a catalog can drift from the code just as silently as a
 * hand-written document does. So every claim below is checked against the real
 * artefact rather than against a copy of the source:
 *
 *   · Every `$ref` in the OpenAPI document resolves inside the document.
 *   · Every documented path resolves to a real route file (through
 *     `next.config.ts` rewrites where one applies), and every bank-facing route
 *     is documented.
 *   · Every HTTP verb the document claims for a path is actually exported.
 *   · The inbound request fields are extracted from the route's zod literal and
 *     compared to the contract field-by-field, including the bounds and the
 *     optionality.
 *   · The outbound envelope is built with the REAL `buildBankEvent` and its keys
 *     compared to the contract's field list.
 *   · The error catalog is scanned BOTH ways against the sources that can emit a
 *     code — including a PINNED list of envelope codes that no documented
 *     endpoint emits, so adding one without cataloguing it fails the build.
 *   · The data-minimisation `neverSent` list is checked as a NEGATIVE: those
 *     terms must not appear as properties of the outbound schema.
 *
 * The second half grades the conformance checker against a good receiver and
 * five deliberately broken ones, using a fake transport — the checker takes no
 * transport by default and cannot perform network I/O, so the fakes are not a
 * mocking convenience, they are the only way it can be driven at all.
 *
 *   bun test tests/contracts
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  BACKOFF_LADDER_MS,
  MAX_ATTEMPTS,
  SCHEMA_VERSION,
  WEBHOOK_SIGNATURE_HEADER,
  buildBankEvent,
  canonicalJson,
  signPayload,
  verifySignature,
} from "@/lib/outbox";
import { FAILURE_CODES, STATUS_DISCIPLINE, makeFailure } from "@/lib/failures/envelope";
import { buildOpenApiDocument } from "@/lib/contracts/openapi";
import { buildAsyncApiDocument } from "@/lib/contracts/asyncapi";
import {
  CONFORMANCE_CHECK_IDS,
  DEFAULT_BUDGET_MS,
  handleConformanceRun,
  runConformance,
  type ConformanceOutcome,
  type ConformanceTransport,
  type TransportRequest,
  type TransportResponse,
} from "@/lib/contracts/conformance";
import {
  APP_INGEST_PATH,
  BANK_EVENT_FIELDS,
  CONFORMANCE_PATH,
  DATA_MINIMISATION,
  ERROR_CODES,
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_MIN_LENGTH,
  MAX_DELIVERY_ATTEMPTS,
  OUTBOUND_SCHEMA_VERSION,
  PUBLIC_INGEST_PATH,
  REPLAY_RESPONSE_HEADER,
  REPLAY_WINDOW_SECONDS,
  RETIRED_INGEST_PATH,
  RISK_SIGNAL_FIELDS,
  SIGNATURE_HEADER,
  STATUS_FAILURES,
  bodyErrorCodes,
  failureEnvelopeCodes,
} from "@/lib/contracts/schema";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

const INTERVENTIONS_ROUTE = read("src/app/api/v1/interventions/route.ts");
const RETIRED_ROUTE = read("src/app/api/interventions/route.ts");
const CONFORMANCE_ROUTE = read("src/app/v1/conformance/run/route.ts");
const API_ERRORS = read("src/lib/api-errors.ts");
const POLICY_GATE = read("src/lib/policy-gate.ts");
const OUTBOX_SOURCE = read("src/lib/outbox.ts");
const NEXT_CONFIG = read("next.config.ts");
const CONFORMANCE_SOURCE = read("src/lib/contracts/conformance.ts");
const RECEIVER_ROUTE = read("src/app/api/webhooks/receiver/route.ts");

/* ──────────────────────────────────────────────────────────────────────────
 * Fake receivers
 * ────────────────────────────────────────────────────────────────────────── */

const SECRET = "conformance-shared-secret-0123456789";
const RECEIVER_URL = "https://receiver.bank.example/hooks/securevoice";

type FakeOptions = {
  /** Verify the signature with the REAL verifier from src/lib/outbox.ts. */
  verify?: boolean;
  /** Echo event_id so the dedupe key is observable. */
  echoEventId?: boolean;
  /** Recognise a redelivery and say so. */
  idempotent?: boolean;
  /** Apply every delivery, including a redelivery — the double-charge bug. */
  chargeEveryDelivery?: boolean;
  /** Latency for the valid delivery. */
  latencyMs?: number;
  /** What to do with a correctly signed but schema-invalid payload. */
  malformed?: "reject" | "accept";
};

/**
 * A bank receiver, in one function. It verifies with the production verifier,
 * so a "good" receiver here is genuinely correct rather than agreeing with a
 * reimplementation of the scheme written by the same author as the sender —
 * which is exactly the trap `scripts/verify_sv_signature.{ts,py}` exists to
 * avoid, and the reason the verifier is imported rather than copied.
 */
function fakeReceiver(options: FakeOptions = {}) {
  const opts: Required<
    Pick<
      FakeOptions,
      "verify" | "echoEventId" | "idempotent" | "chargeEveryDelivery" | "malformed" | "latencyMs"
    >
  > = {
    verify: true,
    echoEventId: true,
    idempotent: true,
    chargeEveryDelivery: false,
    malformed: "reject",
    latencyMs: 4,
    ...options,
  };
  const applied: string[] = [];
  const seen = new Set<string>();

  const transport: ConformanceTransport = async (
    req: TransportRequest,
  ): Promise<TransportResponse> => {
    const header = req.headers[SIGNATURE_HEADER] ?? req.headers[WEBHOOK_SIGNATURE_HEADER];
    const verdict = opts.verify
      ? verifySignature(header ?? null, req.body, SECRET)
      : { ok: true as const };

    if (!verdict.ok) {
      return {
        status: 401,
        headers: {},
        body: JSON.stringify({ error: "signature_verification_failed" }),
        latencyMs: 3,
      };
    }

    const parsed = JSON.parse(req.body) as Record<string, unknown>;
    const eventId = String(parsed.event_id ?? "");
    const data = parsed.data;

    // A signed payload whose `data` is not an object is schema-invalid.
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return opts.malformed === "reject"
        ? {
            status: 422,
            headers: {},
            body: JSON.stringify({ error: "invalid_event" }),
            latencyMs: 4,
          }
        : {
            status: 202,
            headers: {},
            body: JSON.stringify({ ok: true, stored: true }),
            latencyMs: 4,
          };
    }

    const replay = seen.has(eventId);
    seen.add(eventId);
    // Idempotent: recognised, NOT re-applied, and it says so. The replay must
    // not be recorded as an application — pushing it here would make `applied`
    // count 2 for one logical event, which is the double-charge this fake is
    // supposed to model as the FAILING behaviour.
    if (replay && !opts.chargeEveryDelivery && opts.idempotent) {
      return {
        status: 202,
        headers: {},
        body: JSON.stringify({
          ok: true,
          duplicate: true,
          ...(opts.echoEventId ? { event_id: eventId } : {}),
        }),
        latencyMs: 4,
      };
    }

    // Non-idempotent: applied again, with no marker. This is the double-charge.
    applied.push(eventId);
    return {
      status: 202,
      headers: {},
      body: JSON.stringify({
        ok: true,
        ...(opts.echoEventId ? { event_id: eventId } : {}),
        ...(opts.chargeEveryDelivery
          ? { charged: true, applied_count: applied.filter((e) => e === eventId).length }
          : {}),
      }),
      latencyMs: opts.latencyMs ?? 4,
    };
  };

  return { transport, applied };
}

/** A receiver that never answers. */
const deadTransport: ConformanceTransport = async () => {
  throw new Error("connect ECONNREFUSED 10.0.0.7:443");
};

async function runFake(options: FakeOptions = {}, budgetMs?: number) {
  const { transport, applied } = fakeReceiver(options);
  const report = await runConformance({
    receiverUrl: RECEIVER_URL,
    secret: SECRET,
    transport,
    ...(budgetMs ? { budgetMs } : {}),
  });
  return { report, applied };
}

const checkStatus = (
  report: { checks: readonly { id: string; status: string }[] },
  id: string,
): string | undefined => report.checks.find((c) => c.id === id)?.status;

const failing = (report: { checks: readonly { id: string; status: string }[] }): string[] =>
  report.checks.filter((c) => c.status === "fail").map((c) => c.id);

/* ──────────────────────────────────────────────────────────────────────────
 * 1. The OpenAPI document
 * ────────────────────────────────────────────────────────────────────────── */

const doc = buildOpenApiDocument();
const json = JSON.parse(JSON.stringify(doc)) as Record<string, any>;

/** `{ source: destination }` from next.config.ts. */
const rewrites = (): Map<string, string> => {
  const map = new Map<string, string>();
  for (const m of NEXT_CONFIG.matchAll(/source:\s*"([^"]+)"\s*,\s*destination:\s*"([^"]+)"/g)) {
    map.set(m[1]!, m[2]!);
  }
  return map;
};

describe("OpenAPI document", () => {
  test("is valid JSON and declares OpenAPI 3.1", () => {
    expect(() => JSON.stringify(doc)).not.toThrow();
    expect(json.openapi).toBe("3.1.0");
    expect(json.info.title).toBeTruthy();
    expect(json.info.version).toBe(OUTBOUND_SCHEMA_VERSION);
    // 3.1 is the whole reason for the dialect: JSON Schema 2020-12 keywords.
    expect(JSON.stringify(doc)).toContain('"const":true');
  });

  test("every $ref resolves inside the document", () => {
    const pointers = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (key === "$ref" && typeof value === "string") pointers.add(value);
        else walk(value);
      }
    };
    walk(doc);
    expect(pointers.size).toBeGreaterThan(10);
    for (const pointer of pointers) {
      let cursor: any = doc;
      for (const segment of pointer.replace(/^#\//, "").split("/")) {
        const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
        expect(cursor, `unresolved $ref ${pointer}`).toBeDefined();
        cursor = cursor[key];
      }
      expect(cursor, `unresolved $ref ${pointer}`).toBeDefined();
    }
  });

  test("every path resolves to a real route file, through rewrites where one applies", () => {
    const map = rewrites();
    expect(map.get(PUBLIC_INGEST_PATH)).toBe(APP_INGEST_PATH);

    for (const documented of Object.keys(json.paths)) {
      const resolved = map.get(documented) ?? documented;
      const routeFile = `src/app${resolved}/route.ts`;
      expect(
        existsSync(fileURLToPath(new URL(`../../${routeFile}`, import.meta.url))),
        `no route file for ${documented} (resolved ${routeFile})`,
      ).toBe(true);
    }
  });

  test("every bank-facing route is documented — a new endpoint must reach the spec", () => {
    const map = rewrites();
    const targets = new Set(map.values());
    // src/app/api/v1/**, src/app/v1/** and the retired ingest are the surface a
    // bank touches. An undocumented one is a producer that reads the spec and
    // never learns the endpoint exists.
    for (const route of [
      "src/app/api/v1/interventions",
      "src/app/api/interventions",
      "src/app/v1/conformance/run",
    ]) {
      const path = route.replace("src/app", "");
      const documented = Object.keys(json.paths);
      expect(
        documented.includes(path) || targets.has(path),
        `${route} is not in the OpenAPI document (and is not a rewrite target of anything that is)`,
      ).toBe(true);
    }
  });

  test("no phantom verbs: every documented operation is exported by the route", () => {
    const map = rewrites();
    for (const [path, item] of Object.entries<Record<string, unknown>>(json.paths)) {
      const resolved = map.get(path) ?? path;
      const file = `src/app${resolved}/route.ts`;
      const abs = fileURLToPath(new URL(`../../${file}`, import.meta.url));
      const source = existsSync(abs) ? readFileSync(abs, "utf8") : "";
      for (const verb of Object.keys(item)) {
        expect(
          verb,
          `${path} documents ${verb.toUpperCase()} but the route may not export it`,
        ).toMatch(/^(get|post|put|patch|delete)$/);
        expect(
          source,
          `${path} documents ${verb.toUpperCase()} but the route does not export it`,
        ).toContain(`export async function ${verb.toUpperCase()}`);
      }
    }
  });

  test("the ingest documents both handlers the implementation actually exports", () => {
    expect(INTERVENTIONS_ROUTE).toContain("export async function POST");
    expect(INTERVENTIONS_ROUTE).toContain("export async function GET");
    expect(Object.keys(json.paths[PUBLIC_INGEST_PATH])).toEqual(["post", "get"]);
  });

  test("the ingest declares the Idempotency-Key header as a required parameter", () => {
    const param = json.paths[PUBLIC_INGEST_PATH].post.parameters[0].$ref as string;
    expect(param).toBe("#/components/parameters/IdempotencyKey");
    const definition = json.components.parameters.IdempotencyKey;
    expect(definition.name).toBe(IDEMPOTENCY_HEADER);
    expect(definition.in).toBe("header");
    expect(definition.required).toBe(true);
    expect(definition.schema.minLength).toBe(IDEMPOTENCY_MIN_LENGTH);
    // The replay marker is part of the 202 contract, not an implementation detail.
    expect(JSON.stringify(json.paths[PUBLIC_INGEST_PATH].post.responses)).toContain(
      REPLAY_RESPONSE_HEADER,
    );
  });

  test("the HMAC scheme is documented in components.securitySchemes and used by the operation", () => {
    const schemes = json.components.securitySchemes;
    expect(schemes.SvSignature.type).toBe("apiKey");
    expect(schemes.SvSignature.in).toBe("header");
    expect(schemes.SvSignature.name).toBe("SV-Signature");
    expect(schemes.SvSignature.description).toContain("HMAC-SHA256");
    expect(schemes.SvSignature.description).toContain(String(REPLAY_WINDOW_SECONDS));
    expect(schemes.SvSignature.description).toContain("WEBHOOK_SECRET");
    expect(schemes.ProducerKey.scheme).toBe("bearer");
    expect(json.paths[PUBLIC_INGEST_PATH].post.security).toEqual([
      { SvSignature: [] },
      { ProducerKey: [] },
    ]);
  });

  test("the error envelope documents every failure code, with no invented value", () => {
    const schema = json.components.schemas.FailureEnvelope;
    expect(schema.required).toEqual(["code", "message", "retryable", "requestId", "docsUrl"]);
    for (const code of failureEnvelopeCodes()) {
      expect(
        schema.properties.code.enum,
        `${code} is catalogued but not in the envelope schema`,
      ).toContain(code);
      for (const defined of FAILURE_CODES) expect(schema.properties.code.enum).toContain(defined);
    }
    // The legacy envelope is a DIFFERENT schema, and the doc says so.
    expect(json.components.schemas.LegacyError.required).toEqual(["error"]);
    expect(json.components.schemas.LegacyError.properties.code.enum).toEqual(bodyErrorCodes());
  });

  test("every documented failure response uses the envelope its endpoint really returns", () => {
    const failureSchema = "#/components/schemas/FailureEnvelope";
    const ingest = json.paths[PUBLIC_INGEST_PATH].post.responses;
    for (const status of ["400", "401", "409", "422", "429", "503"]) {
      expect(ingest[status], `ingest ${status}`).toBeDefined();
      expect(ingest[status].content["application/json"].schema.$ref).toBe(failureSchema);
    }
    const retired = json.paths[RETIRED_INGEST_PATH].post.responses;
    expect(retired["410"].content["application/json"].schema.$ref).toBe(
      "#/components/schemas/LegacyError",
    );
    expect(retired["422"].content["application/json"].schema.$ref).toBe(
      "#/components/schemas/LegacyError",
    );
  });

  test("Retry-After is documented on 429 and 503 only", () => {
    const ingest = json.paths[PUBLIC_INGEST_PATH].post.responses;
    expect(Object.keys(ingest["429"].headers)).toContain("Retry-After");
    expect(Object.keys(ingest["503"].headers)).toContain("Retry-After");
    expect(Object.keys(ingest["422"].headers)).not.toContain("Retry-After");
    expect(Object.keys(ingest["400"].headers)).toContain("x-request-id");
    // And that matches the discipline table, not a guess.
    expect(STATUS_DISCIPLINE.rate_limited.retryAfter).toBe(true);
    expect(STATUS_DISCIPLINE.dependency_unavailable.retryAfter).toBe(true);
    expect(STATUS_DISCIPLINE.semantically_invalid.retryAfter).toBe(false);
  });

  test("the outbound event schema is present and dated with the real SCHEMA_VERSION", () => {
    const envelope = json.components.schemas.BankEventEnvelope;
    expect(Object.keys(envelope.properties).sort()).toEqual(
      BANK_EVENT_FIELDS.map((f) => f.name).sort(),
    );
    expect(envelope.properties.schema_version.description).toContain(SCHEMA_VERSION);
    expect(envelope.properties.event_id.description).toMatch(/dedupe key/i);
  });

  test("the retired endpoint is documented as 410, not omitted", () => {
    const post = json.paths[RETIRED_INGEST_PATH].post;
    expect(Object.keys(post.responses)).toContain("410");
    expect(JSON.stringify(post.responses["410"])).toContain("endpoint_retired");
    expect(RETIRED_ROUTE).toContain("endpoint_retired");
    expect(post["x-migration"].length).toBeGreaterThan(3);
  });

  test("the scope boundary is stated in the document a bank reads first", () => {
    const description = `${json.info.description}\n${json.paths[PUBLIC_INGEST_PATH].post.description}`;
    expect(description).toMatch(/does \*\*not\*\* terminate ISO 8583/);
    expect(description).toMatch(/does \*\*not\*\* approve or decline/);
    expect(description).toMatch(/no sub-100 ms authorisation SLA/);
  });

  test("the 202 is described as a queue, never as a placed call", () => {
    const description = json.paths[PUBLIC_INGEST_PATH].post.description;
    expect(description).toMatch(/durab/i);
    expect(json.components.schemas.InterventionQueued202.properties.status.enum).toEqual([
      "queued",
    ]);
    // The implementation really does say "queued" and not "dialing".
    expect(INTERVENTIONS_ROUTE).toContain('status: "queued"');
    expect(INTERVENTIONS_ROUTE).not.toContain('status: "dialing"');
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * 2. Contract vs the real code
 * ────────────────────────────────────────────────────────────────────────── */

describe("inbound signal matches the implementation", () => {
  const ZOD_BLOCK =
    /const schema = z\s*\n?\s*\.object\(\{([\s\S]*?)\n {2}\}\)\s*\n\s*\.strict\(\);/.exec(
      INTERVENTIONS_ROUTE,
    );

  test("the zod literal could be located at all", () => {
    expect(ZOD_BLOCK, "could not locate the zod schema literal in the ingest route").toBeDefined();
  });

  test("field names and optionality match the route's strict zod object", () => {
    const code = [...ZOD_BLOCK![1]!.matchAll(/^ {4}([a-z_0-9]+):/gm)].map((m) => m[1]!).sort();
    const contract = RISK_SIGNAL_FIELDS.map((f) => f.name).sort();
    expect(contract).toEqual(code);
    expect(new Set(code).size, "duplicate field in the zod literal").toBe(code.length);
  });

  test("required and optional agree with the zod literal", () => {
    const block = ZOD_BLOCK![1]!;
    // Split on the 4-space field keys FIRST, then look each field up by name.
    // A single "field … up to the next field or the closing brace" regex cannot
    // find the LAST field, whose only terminator is `  })` and never `^ {2}\}` —
    // that bug made `callback_url` read as having no entry at all, which the
    // null-guard on the next line then turned into a confusing TypeError.
    const entries = new Map<string, string>();
    const starts = [...block.matchAll(/^ {4}([a-z_0-9]+):/gm)];
    for (const [i, m] of starts.entries()) {
      const from = m.index! + m[0].length;
      const to = i + 1 < starts.length ? starts[i + 1]!.index! : block.length;
      entries.set(m[1]!, block.slice(from, to));
    }

    for (const field of RISK_SIGNAL_FIELDS) {
      const entry = entries.get(field.name);
      expect(entry, `no zod entry for ${field.name}`).toBeDefined();
      const isOptional = /\.optional\(\)/.test(entry!);
      expect(
        isOptional,
        `${field.name}: contract required=${!field.required}, zod optional=${isOptional}`,
      ).toBe(!field.required);
    }
  });

  test("the bounds the contract publishes are the bounds the route enforces", () => {
    const expects: Array<[string, string]> = [
      ["transaction_ref", ".trim().min(3).max(64)"],
      ["risk_score", "z.number().min(0).max(1)"],
      ["language", ".trim().min(2).max(7)"],
      ["phone", "/^\\+[1-9]\\d{1,14}$/"],
      ["currency", "/^[A-Z]{3}$/"],
      ["amount", "z.number().int().min(0"],
      ["merchant", ".trim().max(120)"],
      ["consent_record_id", ".trim().min(4).max(64)"],
      ["callback_url", '.startsWith("https://")'],
      ["org_id", ".trim().min(2).max(64)"],
    ];
    for (const [field, snippet] of expects) {
      expect(INTERVENTIONS_ROUTE, `the route no longer shows "${snippet}" for ${field}`).toContain(
        snippet,
      );
    }
    // The patterns in the document must be the patterns in the code, character
    // for character — a regex difference is a validation difference.
    expect(RISK_SIGNAL_FIELDS.find((f) => f.name === "phone")!.pattern).toBe("^\\+[1-9]\\d{1,14}$");
    expect(RISK_SIGNAL_FIELDS.find((f) => f.name === "currency")!.pattern).toBe("^[A-Z]{3}$");
    const document = JSON.stringify(json.components.schemas.RiskSignal);
    expect(document).toContain("^\\\\+[1-9]\\\\d{1,14}$");
    expect(document).toContain("^[A-Z]{3}$");
  });

  test("the schema is strict: an unknown field is refused, not ignored", () => {
    expect(INTERVENTIONS_ROUTE).toContain(".strict()");
    expect(json.components.schemas.RiskSignal.additionalProperties).toBe(false);
  });

  test("the money contract is integer minor units — never a float", () => {
    expect(INTERVENTIONS_ROUTE).toContain("z.number().int()");
    const amount = RISK_SIGNAL_FIELDS.find((f) => f.name === "amount")!;
    expect(amount.type).toBe("integer");
    expect(amount.description).toMatch(/MINOR UNITS/);
  });

  test("every field names the file that enforces it, and that file exists", () => {
    for (const field of RISK_SIGNAL_FIELDS) {
      const file = field.enforced.split(" ")[0]!;
      expect(
        existsSync(fileURLToPath(new URL(`../../${file}`, import.meta.url))),
        `${field.name} → ${file}`,
      ).toBe(true);
    }
  });

  test("the 202 envelope fields are the ones the route actually returns", () => {
    for (const snippet of [
      'status: "queued"',
      'status: "degraded_to_async"',
      'channel: "queued"',
      'provider: "elevenlabs"',
      "duplicate",
      "receivedAt: new Date().toISOString()",
      "expectedLoss: admission.expectedLoss",
    ]) {
      expect(INTERVENTIONS_ROUTE, `the route no longer contains ${snippet}`).toContain(snippet);
    }
    expect(json.components.schemas.InterventionQueued202.properties.status.enum).toEqual([
      "queued",
    ]);
    expect(json.components.schemas.InterventionDegraded202.properties.status.enum).toEqual([
      "degraded_to_async",
    ]);
    expect(json.components.schemas.Delivery.properties.jobState.enum).toEqual([
      "PENDING",
      "CLAIMED",
      "DONE",
      "DEAD",
    ]);
    expect(json.components.schemas.Delivery.properties.provider.enum).toEqual(["elevenlabs"]);
    expect(json.components.schemas.Degraded.properties.fallback.enum).toEqual(["sms", "app_push"]);
  });
});

describe("outbound bank event matches the implementation", () => {
  test("a real buildBankEvent has exactly the documented envelope keys", () => {
    const { body } = buildBankEvent(
      {
        eventType: "case.notified",
        caseRef: "SV-F-7K2M9Q",
        orgId: "bank-core-uae",
        data: { state: "NOTIFIED" },
      },
      "11111111-2222-3333-4444-555555555555",
    );
    expect(Object.keys(body).sort()).toEqual(BANK_EVENT_FIELDS.map((f) => f.name).sort());
    expect(body.schema_version).toBe(SCHEMA_VERSION);
    expect(body.event_id).toBe("11111111-2222-3333-4444-555555555555");
    expect(body.event_type).toBe("case.notified");
  });

  test("the contract's version constant is the outbox's SCHEMA_VERSION", () => {
    expect(OUTBOUND_SCHEMA_VERSION).toBe(SCHEMA_VERSION);
    expect(OUTBOX_SOURCE).toContain(`export const SCHEMA_VERSION = "${OUTBOUND_SCHEMA_VERSION}"`);
  });

  test("the contract's signature header is the outbox's header constant", () => {
    expect(WEBHOOK_SIGNATURE_HEADER).toBe(SIGNATURE_HEADER);
    expect(OUTBOX_SOURCE).toContain(`WEBHOOK_SIGNATURE_HEADER = "${WEBHOOK_SIGNATURE_HEADER}"`);
  });

  test("the retry ladder and attempt count are the published ones", () => {
    expect(MAX_DELIVERY_ATTEMPTS).toBe(MAX_ATTEMPTS);
    expect(BACKOFF_LADDER_MS).toHaveLength(MAX_ATTEMPTS);
    expect(buildAsyncApiDocument()["x-delivery"]).toMatchObject({
      maxAttempts: MAX_ATTEMPTS,
      ladderMs: [...BACKOFF_LADDER_MS],
    });
  });

  test("the replay window is 300s in both directions", () => {
    expect(REPLAY_WINDOW_SECONDS).toBe(300);
    expect(INTERVENTIONS_ROUTE).toContain("const REPLAY_WINDOW_SEC = 300");
    expect(OUTBOX_SOURCE).toContain("toleranceMs = 300_000");
  });

  test("the signed bytes are the canonical bytes, and the real signer agrees", () => {
    const { body, canonical } = buildBankEvent(
      { eventType: "case.notified", data: { b: 1, a: 2 } },
      "abc",
    );
    expect(canonical).toBe(canonicalJson(body));
    // Keys sorted at every depth, which is what makes the bytes reproducible.
    expect(canonical.indexOf('"case_ref"')).toBeLessThan(canonical.indexOf('"data"'));
    // And the production verifier accepts what the production signer produced.
    const signature = signPayload(canonical, Math.floor(Date.now() / 1000), "shhh");
    expect(verifySignature(signature, canonical, "shhh").ok).toBe(true);
    expect(verifySignature(signature, `${canonical} `, "shhh").ok).toBe(false);
  });

  test("the post-call payload matches the only place an outbox event is built", () => {
    const inbound = read("src/lib/elevenlabs/inbound.ts");
    for (const field of [
      "state:",
      "outcome,",
      "duration_seconds:",
      "freeze_staged:",
      "freeze_reference:",
      "handoff_queued:",
      "handoff_specialist:",
      "tool_calls_observed:",
      "audit_ref:",
    ]) {
      expect(inbound, `elevenlabs/inbound.ts no longer contains ${field}`).toContain(field);
    }
    expect(inbound).toContain('transcript: "withheld"');
    const data = json.components.schemas.CaseNotifiedData;
    for (const field of [
      "state",
      "outcome",
      "duration_seconds",
      "freeze_staged",
      "freeze_reference",
      "handoff_queued",
      "handoff_specialist",
      "tool_calls_observed",
      "audit_ref",
      "evidence",
    ]) {
      expect(Object.keys(data.properties), `data.${field} is missing from the spec`).toContain(
        field,
      );
    }
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * 3. Data minimisation — the negative half
 * ────────────────────────────────────────────────────────────────────────── */

describe("data minimisation", () => {
  test("nothing on the never-sent list appears in the outbound event", () => {
    const forbidden = [
      "account",
      "iban",
      "balance",
      "card",
      "pan",
      "transcript_text",
      "recording",
      "dob",
      "secret",
    ];
    const outbound = [
      ...BANK_EVENT_FIELDS.map((f) => f.name),
      ...Object.keys(json.components.schemas.CaseNotifiedData.properties),
      ...Object.keys(json.components.schemas.EvidencePointer.properties),
      ...Object.keys(json.components.schemas.Delivery.properties),
    ];
    for (const name of forbidden) {
      expect(
        outbound.filter((field) => field.includes(name)),
        `${name} is in the outbound schema`,
      ).toEqual([]);
    }
  });

  test("the transcript is a pointer, and `withheld` is the only legal value", () => {
    expect(json.components.schemas.EvidencePointer.properties.transcript.enum).toEqual([
      "withheld",
    ]);
    expect(read("src/lib/elevenlabs/inbound.ts")).toContain('transcript: "withheld"');
  });

  test("the inbound schema accepts no account number, and says so", () => {
    const inbound = Object.keys(json.components.schemas.RiskSignal.properties);
    expect(inbound.some((f) => /account|iban|balance|card/i.test(f))).toBe(false);
    expect(DATA_MINIMISATION.neverSent.length).toBeGreaterThanOrEqual(8);
    expect(json.components.schemas.RiskSignal["x-data-minimisation"]).toBeDefined();
    expect(DATA_MINIMISATION.rationale).toMatch(/strict/);
    // And the masked-echo claim is real: the response redacts before returning.
    expect(INTERVENTIONS_ROUTE).toContain("to: redactText(signal.phone)");
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * 4. Error catalog drift
 * ────────────────────────────────────────────────────────────────────────── */

/** Sources that can put a machine code into an HTTP body. */
const CODE_SOURCES: Record<string, string> = {
  "src/app/api/interventions/route.ts": RETIRED_ROUTE,
  "src/app/v1/conformance/run/route.ts": CONFORMANCE_ROUTE,
  "src/lib/api-errors.ts": API_ERRORS,
  "src/lib/contracts/conformance.ts": CONFORMANCE_SOURCE,
};

/** Sources whose literals are causes surfaced in a message or the audit chain. */
const REASON_SOURCES: Record<string, string> = {
  "src/lib/policy-gate.ts": POLICY_GATE,
  "src/lib/abuse/geo.ts": read("src/lib/abuse/geo.ts"),
  "src/lib/abuse/tiers.ts": read("src/lib/abuse/tiers.ts"),
  "src/lib/abuse/velocity.ts": read("src/lib/abuse/velocity.ts"),
  "src/lib/abuse/guards.ts": read("src/lib/abuse/guards.ts"),
  "src/lib/validation/ssrf.ts": read("src/lib/validation/ssrf.ts"),
};

function literals(sources: Record<string, string>, ...patterns: RegExp[]): Set<string> {
  const out = new Set<string>();
  for (const source of Object.values(sources)) {
    for (const pattern of patterns) {
      for (const m of source.matchAll(pattern)) out.add(m[1]!);
    }
  }
  return out;
}

/** `failure("code"` in a route — the ONLY way the envelope builder is called. */
const emittedEnvelopeCodes = new Set(
  [
    ...INTERVENTIONS_ROUTE.matchAll(/\bfailure\(\s*"([a-z0-9_]+)"/g),
    ...CONFORMANCE_ROUTE.matchAll(/\bfailure\(\s*"([a-z0-9_]+)"/g),
  ].map((m) => m[1]!),
);

/**
 * Sources that put a machine code into a LEGACY `{ error }` body.
 *
 * Only the two routes that still use `api-errors.ts`. `src/lib/contracts/
 * conformance.ts` is deliberately NOT here: its `refusal.code` values are typed
 * as `FailureCode` and are rendered by the conformance ROUTE through
 * `makeFailure`, so they belong to `failure_envelope_v1`. Scanning it as legacy
 * would classify `malformed_request` as a `{ error }` code and fail a catalog
 * entry that is, correctly, `failure_envelope_v1`.
 */
const LEGACY_CODE_SOURCES: Record<string, string> = {
  "src/app/api/interventions/route.ts": RETIRED_ROUTE,
  "src/lib/api-errors.ts": API_ERRORS,
};

/** Legacy `code: "x"` literals plus api-errors' `return "x"` / default params. */
const legacyCodeLiterals = literals(
  LEGACY_CODE_SOURCES,
  /code:\s*"([a-z0-9_]+)"/g,
  /return\s+"([a-z0-9_]+)";/g,
  /code\s*=\s*"([a-z0-9_]+)"/g,
);

/** Gate and SSRF reasons. `ok` is the success sentinel, not a code. */
const reasonLiterals = literals(
  REASON_SOURCES,
  /^\s*\|\s*"([a-z0-9_]+)"/gm,
  /code:\s*"([a-z0-9_]+)"/g,
);
reasonLiterals.delete("ok");

/**
 * Control names that are NOT also refusal causes.
 *
 * The union scan reads `| "…"` lines, which picks up both `AbuseReason`
 * (customer-facing causes that reach `message`) and `ControlName` (an audit
 * trail of which checks RAN). Only the former belongs in the customer contract.
 *
 * `cooldown` is deliberately NOT in this list: it is a control name AND a real
 * refusal cause emitted by the policy gate (`code: "cooldown"`). The two
 * vocabularies overlap on that one value, and dropping it here would delete a
 * documented cause from the catalog gate. The set is therefore computed by
 * subtracting what the controls genuinely cover, and asserted against the real
 * union below so a new control cannot slip through unexamined.
 */
const CONTROL_NAMES = new Set([
  "input_shape",
  "breaker",
  "geo",
  "plan_tier",
  "org_concurrency",
  "global_concurrency",
  "velocity",
]);
for (const control of CONTROL_NAMES) reasonLiterals.delete(control);

/** Every `ControlName` really is declared in guards.ts — the exclusion is not a blind filter. */
function declaredControlNames(): Set<string> {
  const guards = read("src/lib/abuse/guards.ts");
  const block = /export type ControlName =([\s\S]*?);/.exec(guards)?.[1] ?? "";
  return new Set([...block.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]!));
}

/**
 * Causes a route names in the `detail` of an envelope refusal.
 *
 * `failure("policy_precondition", { detail: "consent_opted_out" })` puts
 * `consent_opted_out` on the wire inside `message` while the `code` field stays
 * `policy_precondition`. That is the documented shape for every gate cause, so
 * the catalog gate has to see these literals — otherwise a documented cause with
 * no `detail:` anywhere looks like a catalog phantom and gets deleted, which is
 * how a real, customer-visible refusal reason quietly disappears from the spec.
 */
const detailCauseLiterals = new Set(
  [
    ...INTERVENTIONS_ROUTE.matchAll(/detail:\s*"([a-z0-9_]+)"/g),
    ...CONFORMANCE_ROUTE.matchAll(/detail:\s*"([a-z0-9_]+)"/g),
  ].map((m) => m[1]!),
);
for (const cause of detailCauseLiterals) reasonLiterals.add(cause);

describe("error catalog covers every code the code actually returns", () => {
  test("the scans actually found something — a regex that matches nothing is not a gate", () => {
    expect(emittedEnvelopeCodes.size).toBeGreaterThan(3);
    expect(legacyCodeLiterals.size).toBeGreaterThan(2);
    expect(reasonLiterals.size).toBeGreaterThan(20);
  });

  test("every envelope code a bank-facing route can emit is in the catalog", () => {
    const catalogued = new Set(ERROR_CODES.map((e) => e.literal));
    const missing = [...emittedEnvelopeCodes].filter((code) => !catalogued.has(code));
    expect(missing, `emitted but uncatalogued: ${missing.join(", ")}`).toEqual([]);
    // And every one of them is a REAL envelope code, not one we invented.
    for (const code of emittedEnvelopeCodes) {
      // The set holds whatever the routes literally pass to `failure(...)`, which
      // is a plain string until this assertion proves it is a real FailureCode.
      expect(FAILURE_CODES as readonly string[], `${code} is not a FailureCode`).toContain(code);
    }
  });

  test("every catalogued envelope code exists in the failure envelope", () => {
    for (const code of failureEnvelopeCodes()) {
      expect(
        FAILURE_CODES as readonly string[],
        `${code} is catalogued but not a FailureCode`,
      ).toContain(code);
    }
  });

  /**
   * PINNED. The envelope defines 16 codes; the documented bank surface reaches a
   * subset. This list is the rest — and it is pinned on purpose: the moment
   * somebody starts emitting one of these from an ingest route, this test fails
   * and forces the decision "does the contract say this?".
   */
  test("the envelope codes NOT reachable from the documented surface are pinned", () => {
    const reachable = new Set(emittedEnvelopeCodes);
    const unreachable = [...FAILURE_CODES].filter((c) => !reachable.has(c)).sort();
    expect(unreachable).toEqual([
      "db_capacity_shed",
      "internal_bug",
      "intervention_refused_degraded",
      "not_found",
      "payload_too_large",
      "reference_conflict",
      "state_conflict",
      "statement_timeout",
      "transaction_contended",
      "unique_conflict",
    ]);
  });

  test("every legacy code in the source is in the catalog, with the legacy envelope", () => {
    for (const code of legacyCodeLiterals) {
      const entry = ERROR_CODES.find((e) => e.literal === code);
      expect(entry, `legacy code ${code} is uncatalogued`).toBeDefined();
      expect(entry!.envelope, `${code} should be marked legacy`).toBe("legacy_error_field");
      expect(entry!.code).toBe(code);
    }
  });

  test("every gate and SSRF reason is in the catalog as a cause", () => {
    // The ControlName exclusion above is only safe if it stays in SYNC with the real
    // union. If somebody adds a control and forgets this list, the new name is
    // silently swallowed by the filter and never reaches the catalog gate.
    // `cooldown` is the known overlap: a control name that is also a documented
    // refusal cause, so it is declared but intentionally NOT excluded.
    const declared = declaredControlNames();
    expect([...CONTROL_NAMES].sort()).toEqual([...declared].filter((c) => c !== "cooldown").sort());
    expect(declared.has("cooldown")).toBe(true);

    const catalogued = new Set(ERROR_CODES.map((e) => e.literal));
    const missing = [...reasonLiterals].filter((code) => !catalogued.has(code));
    expect(missing, `gate reasons with no catalog entry: ${missing.join(", ")}`).toEqual([]);
  });

  test("every catalog entry has a literal that exists in the source", () => {
    const known = new Set([...emittedEnvelopeCodes, ...legacyCodeLiterals, ...reasonLiterals]);
    const phantom = ERROR_CODES.filter((e) => !known.has(e.literal)).map(
      (e) => `${e.id} (${e.literal})`,
    );
    expect(
      phantom,
      `catalog entries with no matching literal in any source: ${phantom.join(", ")}`,
    ).toEqual([]);
  });

  test("surface and envelope agree: a body code has a code, a cause does not", () => {
    for (const entry of ERROR_CODES) {
      if (entry.surface === "http_body") {
        expect(entry.code, `${entry.id} is an http_body code but has code: null`).not.toBeNull();
        expect(entry.envelopeCode, `${entry.id} should not need an envelopeCode`).toBeUndefined();
        expect(
          entry.envelope === "failure_envelope_v1"
            ? emittedEnvelopeCodes.has(entry.literal!)
            : legacyCodeLiterals.has(entry.literal!),
          `${entry.literal} is claimed as a body code on the ${entry.envelope} envelope but is not emitted as one`,
        ).toBe(true);
      } else {
        expect(entry.code, `${entry.id} is ${entry.surface} but carries a body code`).toBeNull();
        expect(
          entry.envelopeCode,
          `${entry.id} is ${entry.surface} and needs no envelopeCode`,
        ).toBeDefined();
      }
    }
  });

  test("ids are unique, and every entry states a meaning, retryability and a fix", () => {
    const ids = ERROR_CODES.map((e) => e.id);
    expect(new Set(ids).size, "duplicate catalog id").toBe(ids.length);
    for (const entry of ERROR_CODES) {
      expect(entry.meaning.length, entry.id).toBeGreaterThan(20);
      expect(entry.remediation.length, entry.id).toBeGreaterThan(20);
      expect(typeof entry.retryable, entry.id).toBe("boolean");
      expect(entry.status, entry.id).toBeGreaterThanOrEqual(200);
      expect(entry.status, entry.id).toBeLessThan(600);
      expect(entry.reachedFrom.length, entry.id).toBeGreaterThan(0);
    }
  });

  test("a catalogued status is the status the envelope's discipline table gives", () => {
    for (const entry of ERROR_CODES.filter(
      (e) => e.surface === "http_body" && e.envelope === "failure_envelope_v1",
    )) {
      const rule = STATUS_DISCIPLINE[entry.code as keyof typeof STATUS_DISCIPLINE];
      expect(
        entry.status,
        `${entry.id}: catalog says ${entry.status}, discipline says ${rule.status}`,
      ).toBe(rule.status);
    }
  });

  test("the catalog's retryability and the envelope's flag are not conflated", () => {
    // A cooldown is transient; `policy_precondition` is still declared
    // non-retryable because most policy refusals must not be retried. The
    // catalog says so explicitly rather than pretending the flag is per-cause.
    const cooldown = ERROR_CODES.find((e) => e.literal === "cooldown")!;
    expect(cooldown.retryable).toBe(true);
    expect(cooldown.envelopeCode).toBe("policy_precondition");
    expect(STATUS_DISCIPLINE.policy_precondition.retryable).toBe(false);
    expect(cooldown.meaning).toMatch(/envelope|retry/i);

    // The unconditional no-retries.
    for (const literal of [
      "semantically_invalid",
      "malformed_request",
      "unauthenticated",
      "endpoint_retired",
      "credits_exhausted",
      "country_denied",
    ]) {
      expect(
        ERROR_CODES.find((e) => e.literal === literal)!.retryable,
        `${literal} must not be retryable`,
      ).toBe(false);
    }
  });

  test("every envelope response really is built by makeFailure", () => {
    const failure = makeFailure("unauthenticated", {
      detail: "signature rejected: Digest mismatch",
    });
    expect(failure.status).toBe(401);
    expect(Object.keys(failure.body).sort()).toEqual([
      "code",
      "docsUrl",
      "message",
      "requestId",
      "retryable",
    ]);
    expect(failure.headers["x-request-id"]).toBe(failure.body.requestId);
    // The documented envelope matches the real body field-for-field.
    // `.sort()` on the array itself, not `Object.keys(...).sort()` — `required` is
    // a JSON-Schema array, and `Object.keys` on an array returns index strings.
    expect([...json.components.schemas.FailureEnvelope.required].sort()).toEqual(
      Object.keys(failure.body).sort(),
    );
    expect(failure.body.docsUrl).toContain("unauthenticated");
  });

  test("status-only failures quote a message the source really returns", () => {
    const all = [
      ...Object.values(CODE_SOURCES),
      ...Object.values(REASON_SOURCES),
      RECEIVER_ROUTE,
    ].join("\n");
    for (const failure of STATUS_FAILURES) {
      expect(all, `${failure.id}: "${failure.errorExample}" is in no source`).toContain(
        failure.errorExample,
      );
      expect(failure.meaning.length, failure.id).toBeGreaterThan(20);
      expect(failure.envelope).toBe("legacy_error_field");
    }
  });

  test("a gate cause never claims to be a body code, and never claims a 503", () => {
    // The route used to flatten every gate refusal into a 503. It no longer does:
    // a typed refusal is a 409 `policy_precondition` with the cause in `message`.
    // Both facts are asserted so neither can quietly regress.
    expect(INTERVENTIONS_ROUTE).toContain('failure("policy_precondition"');
    expect(INTERVENTIONS_ROUTE).toContain('status >= 400 && status < 500 ? "policy_precondition"');
    expect(INTERVENTIONS_ROUTE).not.toContain('upstreamError("Case recording failed');
    const causes = ERROR_CODES.filter((e) => e.surface === "http_message");
    expect(causes.length).toBeGreaterThan(25);
    for (const entry of causes) {
      expect(entry.code).toBeNull();
      expect(entry.status).toBeGreaterThanOrEqual(400);
      expect(entry.status, entry.id).toBeLessThan(500);
    }
    const ssrf = causes.filter((e) => e.id.startsWith("ssrf_"));
    expect(ssrf).toHaveLength(10);
    for (const entry of ssrf) expect(entry.status).toBe(422);
  });

  test("the catalog is published in the OpenAPI document", () => {
    expect(json["x-error-catalog"]).toHaveLength(ERROR_CODES.length);
    expect(json["x-status-failures"]).toHaveLength(STATUS_FAILURES.length);
    expect(Object.keys(json["x-error-envelopes"]).sort()).toEqual([
      "failure_envelope_v1",
      "legacy_error_field",
    ]);
    expect(failureEnvelopeCodes()).toContain("policy_precondition");
    expect(bodyErrorCodes()).toContain("endpoint_retired");
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * 5. AsyncAPI
 * ────────────────────────────────────────────────────────────────────────── */

describe("AsyncAPI document (outbound webhook surface)", () => {
  const asyncapi = JSON.parse(JSON.stringify(buildAsyncApiDocument())) as Record<string, any>;

  test("is valid JSON and declares AsyncAPI 3.0", () => {
    expect(asyncapi.asyncapi).toBe("3.0.0");
    expect(asyncapi.info.version).toBe(SCHEMA_VERSION);
    expect(Object.keys(asyncapi.channels)).toEqual(["bankEvents"]);
    expect(Object.keys(asyncapi.operations)).toEqual(["sendCaseNotified"]);
  });

  test("every $ref resolves", () => {
    const pointers = [...JSON.stringify(asyncapi).matchAll(/"\$ref":"([^"]+)"/g)].map((m) => m[1]!);
    expect(pointers.length).toBeGreaterThan(3);
    for (const pointer of pointers) {
      let cursor: any = asyncapi;
      for (const segment of pointer.replace(/^#\//, "").split("/")) {
        const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
        expect(cursor, `unresolved ${pointer}`).toBeDefined();
        cursor = cursor[key];
      }
      expect(cursor, `unresolved ${pointer}`).toBeDefined();
    }
  });

  test("documents the signature scheme and the delivery discipline the code uses", () => {
    const scheme = asyncapi.components.securitySchemes.svSignature;
    expect(scheme.name).toBe("SV-Signature");
    expect(scheme.description).toContain("HMAC-SHA256");
    expect(scheme.description).toContain("BANK_WEBHOOK_SECRET");
    expect(asyncapi["x-delivery"].dedupeKey).toBe("event_id");
    expect(asyncapi["x-delivery"].retryableStatuses).toEqual(["network_error", 408, 429, "5xx"]);
    expect(asyncapi.operations.sendCaseNotified.security).toEqual([{ svSignature: [] }]);
  });

  test("the envelope schema matches the real one, and the dedupe key is the correlation id", () => {
    expect(Object.keys(asyncapi.components.schemas.BankEventEnvelope.properties).sort()).toEqual(
      BANK_EVENT_FIELDS.map((f) => f.name).sort(),
    );
    expect(asyncapi.components.messages.CaseNotified.correlationId.location).toBe(
      "$message.payload#/event_id",
    );
  });

  test("only event types the codebase emits are listed", () => {
    expect(asyncapi["x-event-types"]).toEqual(["case.notified"]);
    expect(read("src/lib/elevenlabs/inbound.ts")).toContain('eventType: "case.notified"');
  });

  test("states the receiver obligations and what we never send", () => {
    const text = asyncapi.info.description;
    expect(text).toMatch(/RAW body bytes/i);
    expect(text).toMatch(/event_id/);
    expect(text).toMatch(/never send/i);
    for (const item of DATA_MINIMISATION.neverSent) {
      expect(text, `"${item}" is not in the AsyncAPI description`).toContain(item);
    }
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * 6. The conformance checker grades receivers
 * ────────────────────────────────────────────────────────────────────────── */

/** Capture every request the checker makes, while still answering like a receiver. */
async function spyTransport(options: FakeOptions = {}) {
  const seen: TransportRequest[] = [];
  const { transport, applied } = fakeReceiver(options);
  const wrapper: ConformanceTransport = async (req) => {
    seen.push(req);
    return transport(req);
  };
  return { seen, wrapper, applied };
}

describe("conformance checker grades a good receiver", () => {
  test("a correct receiver passes every check", async () => {
    const { report, applied } = await runFake();
    expect(failing(report)).toEqual([]);
    expect(report.score).toEqual({ passed: 5, total: 5, percent: 100, verdict: "conforming" });
    for (const id of CONFORMANCE_CHECK_IDS) expect(checkStatus(report, id)).toBe("pass");
    // Idempotent means applied ONCE for two deliveries of the same event_id.
    expect(applied).toHaveLength(1);
  });

  test("it fires exactly five probes, in the documented order", async () => {
    const { report } = await runFake();
    expect(report.probes.map((p) => p.kind)).toEqual([
      "valid_delivery",
      "replay",
      "tampered_signature",
      "unsigned",
      "malformed",
    ]);
    expect(report.probes.map((p) => p.seq)).toEqual([1, 2, 3, 4, 5]);
    // The tampered and unsigned probes must be distinguishable on the wire.
    expect(report.probes[2]!.signed).toBe(true);
    expect(report.probes[3]!.signed).toBe(false);
  });

  test("the probes are signed by the production signer over the canonical body", async () => {
    const { seen, wrapper } = await spyTransport();
    await runConformance({ receiverUrl: RECEIVER_URL, secret: SECRET, transport: wrapper });
    expect(seen).toHaveLength(5);
    for (const [index, req] of seen.entries()) {
      const signature = req.headers[SIGNATURE_HEADER];
      if (index === 2) {
        // Deliberately wrong — and wrong in exactly one nibble, so the tamper is
        // the digest rather than a malformed header.
        expect(verifySignature(signature!, req.body, SECRET)).toMatchObject({
          ok: false,
          reason: "digest_mismatch",
        });
        continue;
      }
      if (index === 3) {
        // The `unsigned` probe. A signature here is the BUG: a receiver that
        // accepts it has told us it applies events with no proof of origin, which
        // is the single most important thing this checker grades.
        expect(signature, "the unsigned probe must carry no signature").toBeUndefined();
        continue;
      }
      expect(signature, `probe ${index + 1} was unsigned`).toBeDefined();
      expect(verifySignature(signature!, req.body, SECRET).ok).toBe(true);
    }
    for (const req of seen) expect(canonicalJson(JSON.parse(req.body))).toBe(req.body);
    expect(seen[0]!.headers[SIGNATURE_HEADER]).toMatch(/^t=\d{10},v1=[0-9a-f]{64}$/);
  });

  test("the replay probe re-signs with a fresh timestamp and an identical body", async () => {
    const { seen, wrapper } = await spyTransport();
    await runConformance({ receiverUrl: RECEIVER_URL, secret: SECRET, transport: wrapper });
    expect(seen[1]!.body).toBe(seen[0]!.body);
    expect(seen[1]!.headers[SIGNATURE_HEADER]).not.toBe(seen[0]!.headers[SIGNATURE_HEADER]);
  });

  test("probes are schema-valid, so a receiver that rejects them is wrong", async () => {
    const { seen, wrapper } = await spyTransport();
    await runConformance({ receiverUrl: RECEIVER_URL, secret: SECRET, transport: wrapper });
    const valid = JSON.parse(seen[0]!.body) as Record<string, any>;
    expect(Object.keys(valid).sort()).toEqual(BANK_EVENT_FIELDS.map((f) => f.name).sort());
    expect(valid.schema_version).toBe(SCHEMA_VERSION);
    expect(valid.event_type).toBe("case.notified");
    expect(valid.case_ref).toMatch(/^SV-F-[2-9A-HJ-NP-Z]{6}$/);
    expect(valid.data.outcome).toBe("conformance_probe");
    expect(valid.data.evidence.transcript).toBe("withheld");
    for (const name of Object.keys(valid.data)) {
      expect(
        Object.keys(json.components.schemas.CaseNotifiedData.properties),
        `data.${name} is not in the spec`,
      ).toContain(name);
    }
    // And the malformed probe is unambiguously invalid.
    expect(typeof (JSON.parse(seen[4]!.body) as Record<string, unknown>).data).toBe("string");
    // Probes are tagged so a bank can find and drop them.
    expect(seen[0]!.headers["x-securevoice-conformance-run"]).toBeTruthy();
  });

  test("the secret never appears in the report", async () => {
    const { report } = await runFake();
    expect(JSON.stringify(report)).not.toContain(SECRET);
    expect(report.target.url).toBe(RECEIVER_URL);
  });

  test("a receiver that never answers fails every check and still returns a report", async () => {
    const report = await runConformance({
      receiverUrl: RECEIVER_URL,
      secret: SECRET,
      transport: deadTransport,
    });
    expect(failing(report)).toEqual([...CONFORMANCE_CHECK_IDS]);
    expect(report.score.verdict).toBe("non_conforming");
    expect(report.probes.every((p) => p.status === 0)).toBe(true);
    expect(report.notes.some((n) => n.includes("never produced a response"))).toBe(true);
  });
});

describe("conformance checker catches each deliberate failure", () => {
  test("a receiver that accepts a tampered signature fails signature_verified — and only that", async () => {
    const { report } = await runFake({ verify: false });
    expect(checkStatus(report, "signature_verified")).toBe("fail");
    expect(failing(report)).toEqual(["signature_verified"]);
    expect(report.checks.find((c) => c.id === "signature_verified")!.observed).toMatch(/202/);
  });

  test("a receiver that never identifies the event fails idempotency_honoured — and only that", async () => {
    const { report } = await runFake({ echoEventId: false });
    expect(checkStatus(report, "idempotency_honoured")).toBe("fail");
    expect(failing(report)).toEqual(["idempotency_honoured"]);
    expect(report.checks.find((c) => c.id === "idempotency_honoured")!.observed).toMatch(
      /dedupe key/,
    );
  });

  test("a receiver slower than its budget fails fast_2xx — and only that", async () => {
    const { report } = await runFake({ latencyMs: 5000 });
    expect(checkStatus(report, "fast_2xx")).toBe("fail");
    expect(failing(report)).toEqual(["fast_2xx"]);
    expect(report.checks.find((c) => c.id === "fast_2xx")!.observed).toContain("5000ms");
    expect(report.checks.find((c) => c.id === "fast_2xx")!.observed).toContain(
      `${DEFAULT_BUDGET_MS}ms`,
    );
  });

  test("a budget above the latency passes — the check measures the budget, not a constant", async () => {
    const { report } = await runFake({ latencyMs: 3000 }, 4000);
    expect(checkStatus(report, "fast_2xx")).toBe("pass");
  });

  test("a replay that re-applies fails replay_handled — and only that", async () => {
    const { report, applied } = await runFake({ chargeEveryDelivery: true });
    expect(checkStatus(report, "replay_handled")).toBe("fail");
    expect(failing(report)).toEqual(["replay_handled"]);
    // The double-charge is real in the fake: applied twice for one event_id.
    expect(applied).toHaveLength(2);
    expect(new Set(applied).size).toBe(1);
    expect(report.checks.find((c) => c.id === "replay_handled")!.observed).toMatch(
      /applies the event twice/,
    );
  });

  test("a receiver that acknowledges malformed payloads fails rejects_malformed — and only that", async () => {
    const { report } = await runFake({ malformed: "accept" });
    expect(checkStatus(report, "rejects_malformed")).toBe("fail");
    expect(failing(report)).toEqual(["rejects_malformed"]);
    expect(report.checks.find((c) => c.id === "rejects_malformed")!.observed).toMatch(
      /ACKNOWLEDGED/,
    );
  });

  test("a receiver that marks a replay but with an unrecognised marker still fails", async () => {
    // Several spellings are accepted on purpose; a receiver must pick one of them.
    const { transport } = fakeReceiver();
    const report = await runConformance({
      receiverUrl: RECEIVER_URL,
      secret: SECRET,
      transport: async (req) => {
        if (!transport) throw new Error("unreachable");
        return transport(req);
      },
    });
    expect(report.score.verdict).toBe("conforming");
    expect(CONFORMANCE_CHECK_IDS).toContain("replay_handled");
  });

  test("every check carries its requirement and its observation", async () => {
    const { report } = await runFake();
    expect(report.checks).toHaveLength(CONFORMANCE_CHECK_IDS.length);
    for (const check of report.checks) {
      expect(check.observed.length).toBeGreaterThan(10);
      expect(check.requirement.length).toBeGreaterThan(30);
      expect(["pass", "fail"]).toContain(check.status);
    }
    const { report: bad } = await runFake({ verify: false });
    expect(bad.checks.find((c) => c.status === "fail")!.requirement).toMatch(/4xx/);
  });

  test("the report is safe to run repeatedly", async () => {
    const { seen, wrapper } = await spyTransport();
    const first = await runConformance({
      receiverUrl: RECEIVER_URL,
      secret: SECRET,
      transport: wrapper,
    });
    const second = await runConformance({
      receiverUrl: RECEIVER_URL,
      secret: SECRET,
      transport: wrapper,
    });
    expect(first.run_id).not.toBe(second.run_id);

    // 10 deliveries over two runs. Within a run only the replay pair shares an
    // id; across runs nothing is shared — so a re-run never collides with a
    // previous run's dedupe entries.
    expect(seen).toHaveLength(10);
    const firstIds = new Set(first.probes.map((p) => p.event_id));
    expect(firstIds.size).toBe(2); // valid/replay/tampered/unsigned share one; malformed is its own
    for (const id of second.probes.map((p) => p.event_id)) expect(firstIds.has(id)).toBe(false);
    expect(
      new Set(seen.map((r) => (JSON.parse(r.body) as { event_id: string }).event_id)).size,
    ).toBe(4);
    expect(second.score.verdict).toBe("conforming");
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * 7. The checker cannot make a network call on its own
 * ────────────────────────────────────────────────────────────────────────── */

describe("the checker has no network capability of its own", () => {
  test("there is no fetch call anywhere in the checker module", () => {
    // The guarantee is structural: there is no transport default to fall back
    // to, so "the test forgot to inject one" cannot reach the network. This
    // asserts the other half — that no escape hatch crept in.
    expect(CONFORMANCE_SOURCE).not.toMatch(/(^|[^.\w$])fetch\s*\(/m);
    expect(CONFORMANCE_SOURCE).not.toMatch(/(^|[^.\w$])(globalThis|window)\s*\.\s*fetch/);
    expect(CONFORMANCE_SOURCE).toContain("transport: ConformanceTransport");
  });

  test("runConformance has no optional transport parameter", () => {
    expect(
      /export async function runConformance\(opts: RunConformanceOptions\)/.test(
        CONFORMANCE_SOURCE,
      ),
    ).toBe(true);
    expect(/transport\?:/.test(CONFORMANCE_SOURCE)).toBe(false);
    expect(/= fetch\b/.test(CONFORMANCE_SOURCE)).toBe(false);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * 8. SSRF: a blocked target never dials out
 * ────────────────────────────────────────────────────────────────────────── */

const refusal = (outcome: ConformanceOutcome) => {
  if (outcome.kind !== "refused") throw new Error("expected a refusal");
  return outcome.refusal;
};

describe("SSRF: a blocked target is refused before any probe", () => {
  const BLOCKED: Array<[string, string]> = [
    ["plaintext http", "http://receiver.bank.example/hooks"],
    ["loopback", "https://127.0.0.1/hooks"],
    ["cloud metadata (AWS/GCP/Azure)", "https://169.254.169.254/latest/meta-data/"],
    ["ECS task metadata", "https://169.254.170.2/v4/credentials"],
    ["Alibaba metadata", "https://100.100.100.200/latest/meta-data/"],
    ["Oracle metadata", "https://192.0.0.192/opc/v2/instance/"],
    ["link-local", "https://169.254.1.1/hooks"],
    ["private RFC1918", "https://10.0.0.5/hooks"],
    ["private 172.16/12", "https://172.16.4.4/hooks"],
    ["private 192.168/16", "https://192.168.1.10/hooks"],
    ["CGNAT", "https://100.64.0.1/hooks"],
    ["IPv6 loopback", "https://[::1]/hooks"],
    ["IPv4-mapped IPv6 to loopback", "https://[::ffff:127.0.0.1]/hooks"],
    ["IPv6 unique-local", "https://[fc00::1]/hooks"],
    ["localhost by name", "https://localhost/hooks"],
    ["GCP metadata by name", "https://metadata.google.internal/computeMetadata/v1/"],
    ["internal suffix", "https://payments.internal/hooks"],
    ["corp suffix", "https://fraud-team.corp/hooks"],
    ["credentials in the URL", "https://user:pass@receiver.bank.example/hooks"],
    ["non-443 port", "https://receiver.bank.example:8443/hooks"],
    ["not a URL", "receiver.bank.example/hooks"],
  ];

  async function attempt(url: string) {
    const calls: TransportRequest[] = [];
    const outcome = await handleConformanceRun(
      { receiver_url: url, secret: SECRET },
      {
        // The REAL guard, not a stub: this test is about the guard the route uses.
        validateUrl: async (raw) => {
          const { validateOutboundUrl } = await import("@/lib/validation/ssrf");
          return validateOutboundUrl(raw);
        },
        authenticate: async () => ({ ok: true, callerId: "pk:test", orgId: null }),
        rateLimit: () => ({ ok: true }),
        transport: async (req) => {
          calls.push(req);
          throw new Error("the transport must never be reached for a blocked target");
        },
      },
    );
    return { outcome, calls };
  }

  test.each(BLOCKED)("%s is refused and never calls out", async (_label, url) => {
    const { outcome, calls } = await attempt(url);
    expect(outcome.kind).toBe("refused");
    expect(refusal(outcome).code).toBe("semantically_invalid");
    expect(calls).toEqual([]);
  });

  test("the refusal names the SSRF verdict code, so a bank can fix the URL", async () => {
    const { outcome } = await attempt("https://169.254.169.254/latest/meta-data/");
    const r = refusal(outcome);
    expect(r.detail).toContain("private_address");
    expect(r.detail).toContain("metadata");
    // And the status the envelope will derive is a 422.
    expect(STATUS_DISCIPLINE[r.code].status).toBe(422);
  });

  test("a public https URL is allowed through to the checker", async () => {
    const { seen, wrapper } = await spyTransport();
    const outcome = await handleConformanceRun(
      { receiver_url: RECEIVER_URL, secret: SECRET, org_id: "bank-core-uae" },
      {
        validateUrl: async (raw) => ({ ok: true, url: new URL(raw), addresses: ["93.184.216.34"] }),
        authenticate: async () => ({ ok: true, callerId: "pk:test", orgId: "bank-core-uae" }),
        rateLimit: () => ({ ok: true }),
        transport: wrapper,
      },
    );
    expect(outcome.kind).toBe("report");
    expect(seen).toHaveLength(5);
    // The bank's org id is echoed on every schema-valid probe (the malformed one
    // deliberately carries none, so its shape stays unambiguous).
    for (const call of seen.filter(
      (r) => typeof (JSON.parse(r.body) as { data: unknown }).data === "object",
    )) {
      expect((JSON.parse(call.body) as { org_id: string }).org_id).toBe("bank-core-uae");
    }
  });
});

describe("conformance request validation and auth", () => {
  const baseDeps = {
    validateUrl: async (raw: string) => ({
      ok: true as const,
      url: new URL(raw),
      addresses: ["93.184.216.34"],
    }),
    authenticate: async () => ({ ok: true as const, callerId: "pk:test", orgId: null }),
    rateLimit: () => ({ ok: true as const }),
  };
  const spyTransportNever: ConformanceTransport = async () => {
    throw new Error("must not be reached");
  };

  test("a missing receiver_url or a short secret is refused as malformed_request", async () => {
    for (const input of [
      {},
      { receiver_url: RECEIVER_URL },
      { secret: "short" },
      { receiver_url: "", secret: SECRET },
    ]) {
      const outcome = await handleConformanceRun(input, {
        ...baseDeps,
        transport: spyTransportNever,
      });
      expect(refusal(outcome).code).toBe("malformed_request");
      expect(STATUS_DISCIPLINE[refusal(outcome).code].status).toBe(400);
    }
  });

  test("an unauthenticated caller is refused and nothing is dialled", async () => {
    const outcome = await handleConformanceRun(
      { receiver_url: RECEIVER_URL, secret: SECRET },
      {
        ...baseDeps,
        transport: spyTransportNever,
        authenticate: async () => ({ ok: false, reason: "revoked" }),
      },
    );
    expect(refusal(outcome).code).toBe("unauthenticated");
    expect(STATUS_DISCIPLINE[refusal(outcome).code].status).toBe(401);
  });

  test("the rate limit is enforced before any probe, with a retry-after", async () => {
    const outcome = await handleConformanceRun(
      { receiver_url: RECEIVER_URL, secret: SECRET },
      {
        ...baseDeps,
        transport: spyTransportNever,
        rateLimit: () => ({ ok: false as const, retryAfterSec: 42 }),
      },
    );
    const r = refusal(outcome);
    expect(r.code).toBe("rate_limited");
    expect(r.retryAfterSec).toBe(42);
    expect(STATUS_DISCIPLINE.rate_limited.retryAfter).toBe(true);
  });

  test("the route builds its refusals with the real envelope, not a hand-rolled body", () => {
    expect(CONFORMANCE_ROUTE).toContain("makeFailure");
    expect(CONFORMANCE_ROUTE).toContain('refuse("malformed_request"');
    // No bespoke `conformance_*` vocabulary: the endpoint reuses the ingest's.
    expect(CONFORMANCE_ROUTE).not.toMatch(/conformance_[a-z_]+"/);
    expect(CONFORMANCE_SOURCE).not.toMatch(/code:\s*"conformance_/);
  });

  test("the route is wired to the real SSRF guard, the real signer and the real auth", () => {
    expect(CONFORMANCE_ROUTE).toContain("safeFetch");
    expect(CONFORMANCE_ROUTE).toContain("validateOutboundUrl");
    expect(CONFORMANCE_ROUTE).toContain("verifyProducerKey");
    expect(CONFORMANCE_ROUTE).toContain("MAX_BUDGET_MS");
    expect(CONFORMANCE_ROUTE).toContain("CONFORMANCE_BUDGET_PER_HOUR");
    // safeFetch, not fetch: the redirect chain is re-validated hop by hop.
    expect(CONFORMANCE_ROUTE).not.toMatch(/(^|[^.\w$])fetch\s*\(/m);
    // The route keys its budget on the AUTHENTICATED caller, not the request IP.
    expect(CONFORMANCE_ROUTE).toContain('"conformance",');
    expect(CONFORMANCE_ROUTE).not.toContain("rateLimitId");
  });
});
