/**
 * UNIT — the failure envelope (src/lib/failures/envelope.ts).
 *
 * This module is the ONE way an error reaches a caller, so its contract is a
 * security boundary rather than a formatting concern. The properties asserted
 * here are the ones a later refactor would silently break:
 *
 *   · Exactly five fields in the body, always. Anything more is either an
 *     internal detail or a leak.
 *   · NEVER 403. A 403 tells a caller the row exists and they lack access,
 *     which is precisely the existence oracle the cross-tenant 404 denies. So
 *     cross-tenant is reported with the SAME code and body as a row that does
 *     not exist — asserted as byte-equality, not merely the same status.
 *   · A message that trips the leak scanner is never published; the code's own
 *     default is sent instead. A caller cannot talk its way past the discipline
 *     with a creative `detail`.
 *   · Every code marked `retryAfter` actually emits the header, and a
 *     `Retry-After` outside [1, 3600] is clamped rather than echoed — an
 *     unbounded value is a client-side DoS.
 *   · A request id that looks like customer data is REPLACED, not echoed.
 *   · 4xx is retryable only where retrying can actually succeed.
 */
import { describe, expect, test } from "bun:test";
import {
  CROSS_TENANT_CODE,
  FAILURE_CODES,
  FORBIDDEN_STATUSES,
  LEAK_RULES,
  MAX_MESSAGE_CHARS,
  STATUS_DISCIPLINE,
  assertFieldName,
  crossTenantNotFound,
  internalBug,
  leakSafeText,
  leakScan,
  makeFailure,
  malformedRequest,
  newRequestId,
  notFound,
  normaliseRequestId,
  policyPrecondition,
  rateLimited,
  requestIdIsOpaque,
  responseInitFor,
  sanitizePublicMessage,
  scanFailure,
  shedLoad,
  unauthenticated,
  type Failure,
  type FailureCode,
} from "@/lib/failures/envelope";

const ALL_CODES = FAILURE_CODES as readonly FailureCode[];

describe("status discipline table", () => {
  test("every declared code has a discipline entry", () => {
    for (const code of ALL_CODES) {
      expect(STATUS_DISCIPLINE[code]).toBeDefined();
    }
  });

  test("no code maps to a forbidden status", () => {
    for (const code of ALL_CODES) {
      expect(FORBIDDEN_STATUSES).not.toContain(STATUS_DISCIPLINE[code].status);
    }
  });

  test("the forbidden list is exactly [403]", () => {
    expect(FORBIDDEN_STATUSES).toEqual([403]);
  });

  test("every status is a sanctioned 4xx/5xx value", () => {
    for (const code of ALL_CODES) {
      const s = STATUS_DISCIPLINE[code].status;
      expect([400, 401, 404, 409, 413, 422, 429, 500, 503]).toContain(s);
    }
  });

  test("a client error is never retryable, except the two time-based cases", () => {
    // A 4xx means the request itself is the problem, so retrying unchanged
    // changes nothing — with two sanctioned exceptions, both of which are
    // time-based rather than request-based: rate_limited (429 exists to tell a
    // client exactly when to come back) and transaction_contended (the database
    // is healthy; the same request succeeds on a second attempt).
    const RETRYABLE_4XX = new Set<FailureCode>(["rate_limited", "transaction_contended"]);
    for (const code of ALL_CODES) {
      const rule = STATUS_DISCIPLINE[code];
      if (rule.status >= 400 && rule.status < 500 && !RETRYABLE_4XX.has(code)) {
        expect({ code, retryable: rule.retryable }).toEqual({ code, retryable: false });
      }
    }
    expect(STATUS_DISCIPLINE.transaction_contended.retryable).toBe(true);
    expect(STATUS_DISCIPLINE.rate_limited.retryable).toBe(true);
  });

  test("every 503 is retryable and carries Retry-After", () => {
    for (const code of ALL_CODES) {
      const rule = STATUS_DISCIPLINE[code];
      if (rule.status === 503) {
        expect({ code, retryable: rule.retryable, retryAfter: rule.retryAfter }).toEqual({
          code,
          retryable: true,
          retryAfter: true,
        });
      }
    }
  });

  test("rate_limited is the only 429 and it carries Retry-After", () => {
    expect(STATUS_DISCIPLINE.rate_limited.status).toBe(429);
    expect(STATUS_DISCIPLINE.rate_limited.retryAfter).toBe(true);
  });

  test("internal_bug is the only 500 and is never retryable", () => {
    const fives = ALL_CODES.filter((c) => STATUS_DISCIPLINE[c].status === 500);
    expect(fives).toEqual(["internal_bug"]);
    expect(STATUS_DISCIPLINE.internal_bug.retryable).toBe(false);
  });

  test("a code requiring Retry-After always emits the header", () => {
    for (const code of ALL_CODES) {
      if (!STATUS_DISCIPLINE[code].retryAfter) continue;
      expect({ code, header: makeFailure(code).headers["Retry-After"] }).toEqual({
        code,
        header: expect.any(String),
      });
    }
  });
});

describe("envelope shape", () => {
  test("the body carries exactly five fields", () => {
    for (const code of ALL_CODES) {
      const keys = Object.keys(makeFailure(code).body).sort();
      expect({ code, keys }).toEqual({
        code,
        keys: ["code", "docsUrl", "message", "requestId", "retryable"],
      });
    }
  });

  test("Retry-After lives in the header, never in the body", () => {
    const f = rateLimited(30);
    expect(f.headers["Retry-After"]).toBe("30");
    expect(JSON.stringify(f.body)).not.toContain("Retry-After");
  });

  test("the body code equals the requested code", () => {
    for (const code of ALL_CODES) {
      expect(makeFailure(code).body.code).toBe(code);
    }
  });

  test("every built failure is publishable — the scanner finds nothing", () => {
    for (const code of ALL_CODES) {
      expect({ code, leaks: scanFailure(makeFailure(code)) }).toEqual({ code, leaks: [] });
    }
  });

  test("every message fits the publishable budget", () => {
    for (const code of ALL_CODES) {
      expect(makeFailure(code).body.message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    }
  });

  test("responseInitFor projects status and headers only", () => {
    const f = rateLimited(5);
    const init = responseInitFor(f);
    expect(init.status).toBe(f.status);
    expect(Object.keys(init)).toEqual(["status", "headers"]);
  });

  test("docsUrl is an absolute docs link for the code", () => {
    expect(makeFailure("not_found").body.docsUrl).toContain("not_found");
    expect(makeFailure("not_found").body.docsUrl.startsWith("http")).toBe(true);
  });
});

describe("cross-tenant never becomes an existence oracle", () => {
  test("cross-tenant uses the not_found code", () => {
    expect(CROSS_TENANT_CODE).toBe("not_found");
    expect(crossTenantNotFound().body.code).toBe("not_found");
  });

  test("a cross-tenant refusal is byte-identical to a plain not-found", () => {
    // Not merely the same status: the same code, message AND docsUrl. A distinct
    // code or message would itself be the oracle the 404 denies. Both are built
    // with the SAME request id so the comparison is exact — requestId is freshly
    // random per call by design and carries no information about the row.
    const id = "svreq_fixed";
    expect(crossTenantNotFound({ requestId: id }).body).toEqual(notFound({ requestId: id }).body);
  });

  test("every body field except the random request id matches", () => {
    const a = crossTenantNotFound().body;
    const b = notFound().body;
    const strip = (x: Record<string, unknown>) => {
      const { requestId: _ignored, ...rest } = x;
      return rest;
    };
    expect(strip(a)).toEqual(strip(b));
  });

  test("a request id does not make a cross-tenant refusal distinguishable", () => {
    const withId = crossTenantNotFound({ requestId: "svreq_abc" });
    expect(withId.body.code).toBe(notFound({ requestId: "svreq_abc" }).body.code);
    expect(withId.body.message).toBe(notFound({ requestId: "svreq_abc" }).body.message);
  });

  test("the status is 404, never 403", () => {
    expect(crossTenantNotFound().status).toBe(404);
    expect(notFound().status).toBe(404);
  });
});

describe("leak scanner", () => {
  test("clean text scans empty", () => {
    expect(leakScan("The requested record does not exist.")).toEqual([]);
    expect(leakScan("")).toEqual([]);
  });

  // The provider-key rule required an underscore separator and a dash-free
  // body, so it matched `whsec_…` but let every REAL Stripe key through —
  // Stripe ships `sk-live-…` / `sk-proj-…`. Found by asserting on a
  // vendor-shaped body rather than a synthetic one.
  test("real provider key formats are classified as internal identifiers", () => {
    for (const key of [
      "sk-live-abc123",
      "sk-proj-AAAABBBBCCCCDDDD",
      "rk_live_1234567890",
      "pk_live_1234567890",
      "whsec_abcdefgh12345678",
      "sb_secret_abcdefghijkl",
    ]) {
      expect({ key, kinds: leakScan(key) }).toEqual({
        key,
        kinds: ["internal_identifier"],
      });
    }
  });

  test("leakSafeText removes a vendor key from a real upstream error body", () => {
    // The shape `/api/elevenlabs/signed-url` used to echo verbatim.
    const raw =
      "connect ECONNREFUSED db.internal:5432\n    at pool (src/lib/db.ts:12:3) api_key=sk-live-abc123";
    const safe = leakSafeText(raw, 160);
    expect(safe).not.toContain("sk-live-abc123");
    expect(safe).not.toContain("\n");
    expect(leakScan(safe)).toEqual([]);
  });

  test("every declared leak RULE fires on a real offender", () => {
    // Otherwise an empty scan means nothing: a rule that can never match is
    // indistinguishable from a leak nobody thought of. The pool below is
    // matched against every rule rather than paired one-to-one, so this stays
    // valid if the rules are reordered or a rule is added.
    const offenders = [
      "\n    at handler",
      "at handler (",
      "inside node_modules/react/index.js",
      "src/lib/x.ts:12:3",
      "TypeError: boom",
      "prisma://query",
      "SELECT a FROM b",
      "INSERT INTO b",
      "unique constraint violated",
      "violates foreign key constraint",
      "ON CONFLICT DO NOTHING",
      'WHERE "orgId" = $1',
      "::text",
      "FOR UPDATE",
      "Key (orgId)=(org_9f2c)",
      "is not present in table",
      'table "User"',
      "already exists",
      "system: you are a helper",
      "you are a helpful assistant",
      "<|im_start|>",
      "prompt: do the thing",
      "tool_calls",
      "temperature: 0.7",
      "9f2c4a17e0b34d55abcdef",
      "3f2b1a4c-5d6e-7f80-9a1b-2c3d4e5f6a7b",
      "org_9f2c4a17e0b34d55",
      "cuid2()",
      "whsec_abcdefgh12345678",
      "eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxIn0.sig",
      "postgres://user:pw@host:5432/db",
      "2026-10-03T04:05:06",
    ];
    const dead = LEAK_RULES.filter((rule) => !offenders.some((o) => rule.re.test(o)));
    expect({ deadRules: dead.map((r) => r.re.source) }).toEqual({ deadRules: [] });
  });

  test("all six leak classes are detected", () => {
    const all: string[] = [
      "Error: boom\n    at handler (src/lib/x.ts:12:3)",
      'SELECT id FROM "User" WHERE orgId = $1',
      "system: you are a helpful assistant",
      "row org_9f2c4a17e0b34d55 missing",
      "2026-10-03T04:05:06 recorded",
      "x".repeat(MAX_MESSAGE_CHARS + 1),
    ];
    const found = new Set(all.flatMap((t) => leakScan(t)));
    for (const kind of [
      "stack_trace",
      "sql",
      "model_prompt",
      "internal_identifier",
      "internal_timestamp",
      "oversized",
    ]) {
      expect({ kind, found: found.has(kind as never) }).toEqual({ kind, found: true });
    }
  });

  test("a JWT is an internal identifier leak", () => {
    expect(leakScan("eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxIn0.sig")).toContain("internal_identifier");
  });

  test("a non-string or empty input scans empty rather than throwing", () => {
    expect(leakScan(undefined as never)).toEqual([]);
    expect(leakScan(null as never)).toEqual([]);
    expect(leakScan(42 as never)).toEqual([]);
  });
});

describe("sanitizePublicMessage", () => {
  test("clean text passes through, trimmed and whitespace-collapsed", () => {
    expect(sanitizePublicMessage("  a   b  ", "not_found")).toBe("a b");
  });

  test("empty or blank text falls back to the code's own message", () => {
    const fallback = makeFailure("not_found").body.message;
    expect(sanitizePublicMessage("", "not_found")).toBe(fallback);
    expect(sanitizePublicMessage("    ", "not_found")).toBe(fallback);
  });

  test("a leaking detail is redacted, not published", () => {
    const out = sanitizePublicMessage("failed org_9f2c4a17e0b34d55", "not_found");
    expect(out).not.toContain("org_9f2c4a17e0b34d55");
    expect(out).toContain("[redacted]");
  });

  test("a detail that reduces to redaction plus an inert prefix keeps the prefix", () => {
    // `org_9f2c…` leaves the literal "org_" behind, so the result is NOT purely
    // redaction markers and the fallback does not fire. The identifier itself is
    // still gone, which is the property that matters.
    const out = sanitizePublicMessage("org_9f2c4a17e0b34d55", "not_found");
    expect(out).not.toContain("9f2c4a17e0b34d55");
    expect(out).toBe("org_[redacted]");
  });

  test("a detail that is ONLY a leak falls back to the code's own message", () => {
    // Nothing survives redaction, so the caller gets the default rather than a
    // stub that says nothing.
    const out = sanitizePublicMessage("postgres://user:pw@host:5432/db", "not_found");
    expect(out).not.toContain("postgres://");
    expect(out).toBe(makeFailure("not_found").body.message);
  });

  test("a non-string input falls back", () => {
    expect(sanitizePublicMessage(undefined as never, "not_found")).toBe(
      makeFailure("not_found").body.message,
    );
  });

  test("newlines are collapsed so a message cannot forge log lines", () => {
    const out = sanitizePublicMessage("line one\nline two", "not_found");
    expect(out).not.toContain("\n");
  });

  test("output never exceeds the publishable budget", () => {
    const out = sanitizePublicMessage("word ".repeat(200), "not_found");
    expect(out.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
  });
});

describe("makeFailure — detail handling", () => {
  test("a clean detail is appended to the base message", () => {
    const f = makeFailure("not_found", { detail: "case 42" });
    expect(f.body.message).toContain("case 42");
  });

  test("a leaking detail never reaches the caller", () => {
    const f = makeFailure("not_found", { detail: "org_9f2c4a17e0b34d55 not found" });
    expect(f.body.message).not.toContain("9f2c4a17e0b34d55");
    expect(scanFailure(f)).toEqual([]);
  });

  test("a detail cannot push the message past the budget", () => {
    const f = makeFailure("not_found", { detail: "x".repeat(5000) });
    expect(f.body.message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
  });

  test("a blank detail leaves the base message unchanged", () => {
    const base = makeFailure("not_found").body.message;
    expect(makeFailure("not_found", { detail: "" }).body.message).toBe(base);
    expect(makeFailure("not_found", { detail: "   " }).body.message).toBe(base);
  });

  test("every built failure stays publishable whatever the detail", () => {
    const nasty = [
      "org_9f2c4a17e0b34d55",
      'SELECT * FROM "User"',
      "at handler (src/lib/x.ts:1:1)",
      "postgres://u:p@h/db",
      "2026-10-03T04:05:06",
      "system: you are a helpful assistant",
      "x".repeat(1000),
    ];
    for (const code of ALL_CODES) {
      for (const detail of nasty) {
        const f = makeFailure(code, { detail });
        expect({ code, leaks: scanFailure(f) }).toEqual({ code, leaks: [] });
      }
    }
  });

  test("the raw detail is kept for server-side use, not the body", () => {
    // `detail` is on the Failure for logs; the body is what ships.
    const f = makeFailure("internal_bug", { detail: "boom" });
    expect(f.detail).toBe("boom");
    expect(f.body.message).not.toBe("boom");
  });

  test("an unknown code throws rather than producing a malformed envelope", () => {
    expect(() => makeFailure("nope" as FailureCode)).toThrow(RangeError);
  });
});

describe("Retry-After clamping", () => {
  test("a declared value is honoured", () => {
    expect(rateLimited(30).headers["Retry-After"]).toBe("30");
  });

  test("a code requiring Retry-After defaults to 1 rather than omitting it", () => {
    const f = shedLoad(0);
    expect(f.headers["Retry-After"]).toBe("1");
  });

  test("a value below 1 is clamped up", () => {
    expect(rateLimited(0).headers["Retry-After"]).toBe("1");
    expect(rateLimited(-99).headers["Retry-After"]).toBe("1");
  });

  test("a value above an hour is clamped down", () => {
    // An unbounded Retry-After is a client-side DoS: every client parks for the
    // duration the server named.
    expect(rateLimited(999_999).headers["Retry-After"]).toBe("3600");
  });

  test("a fractional value is rounded", () => {
    expect(rateLimited(10.4).headers["Retry-After"]).toBe("10");
    expect(rateLimited(10.6).headers["Retry-After"]).toBe("11");
  });

  test("NaN and Infinity fall back to the 1s default", () => {
    expect(rateLimited(Number.NaN).headers["Retry-After"]).toBe("1");
    expect(rateLimited(Number.POSITIVE_INFINITY).headers["Retry-After"]).toBe("1");
  });

  test("a code that does not require Retry-After omits the header by default", () => {
    expect(notFound().headers["Retry-After"]).toBeUndefined();
    expect(unauthenticated().headers["Retry-After"]).toBeUndefined();
  });
});

describe("request ids", () => {
  test("a fresh id is opaque and prefixed", () => {
    const id = newRequestId();
    expect(id.startsWith("svreq_")).toBe(true);
    expect(requestIdIsOpaque(id)).toBe(true);
  });

  test("fresh ids are unique", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newRequestId()));
    expect(ids.size).toBe(200);
  });

  test("a fresh id carries no customer data", () => {
    expect(leakScan(newRequestId())).toEqual([]);
  });

  test("an opaque candidate is preserved", () => {
    expect(normaliseRequestId("svreq_abc123")).toBe("svreq_abc123");
  });

  test("a missing candidate yields a fresh id", () => {
    expect(normaliseRequestId(undefined).startsWith("svreq_")).toBe(true);
    expect(normaliseRequestId(null).startsWith("svreq_")).toBe(true);
    expect(normaliseRequestId("").startsWith("svreq_")).toBe(true);
  });

  // The reason normaliseRequestId exists: a caller-supplied id is echoed back in
  // a response header, so echoing customer data would republish it.
  test("a candidate that looks like customer data is replaced, not echoed", () => {
    for (const bad of [
      "+971501234567",
      "user@example.com",
      "org_9f2c4a17e0b34d55",
      "postgres://u:p@h/db",
      "2026-10-03T04:05:06",
    ]) {
      const out = normaliseRequestId(bad);
      expect(out).not.toBe(bad);
      expect(out.startsWith("svreq_")).toBe(true);
    }
  });

  test("an over-long or illegal-character candidate is replaced", () => {
    expect(normaliseRequestId("a".repeat(200)).startsWith("svreq_")).toBe(true);
    expect(normaliseRequestId("has spaces and $ymbols").startsWith("svreq_")).toBe(true);
  });

  test("the request id in a built failure is always opaque", () => {
    for (const code of ALL_CODES) {
      expect(
        requestIdIsOpaque(makeFailure(code, { requestId: "+971501234567" }).body.requestId),
      ).toBe(true);
    }
  });

  test("a customer-data request id does not reach the response header", () => {
    const f = makeFailure("not_found", { requestId: "+971501234567" });
    expect(f.headers["x-request-id"]).not.toContain("971501234567");
  });

  test("every failure echoes its request id in the header", () => {
    const f = makeFailure("not_found", { requestId: "svreq_trace" });
    expect(f.headers["x-request-id"]).toBe("svreq_trace");
    expect(f.body.requestId).toBe("svreq_trace");
  });
});

describe("assertFieldName", () => {
  test("accepts a plain identifier", () => {
    expect(assertFieldName("orgId")).toBe("orgId");
    expect(assertFieldName("created_at")).toBe("created_at");
  });

  test("rejects anything that could smuggle a driver error through", () => {
    for (const bad of [
      'orgId; DROP TABLE "User"',
      "org id",
      "a".repeat(200),
      "",
      '"orgId"',
      "1 OR 1=1",
    ]) {
      expect(() => assertFieldName(bad)).toThrow();
    }
  });

  test("rejects a non-string", () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      expect(() => assertFieldName(bad)).toThrow();
    }
  });
});

describe("typed constructors", () => {
  test("each constructor produces its own code and the right status", () => {
    const cases: Array<[Failure, FailureCode]> = [
      [malformedRequest(), "malformed_request"],
      [unauthenticated(), "unauthenticated"],
      [notFound(), "not_found"],
      [crossTenantNotFound(), "not_found"],
      [policyPrecondition(), "policy_precondition"],
      [internalBug(), "internal_bug"],
      [rateLimited(5), "rate_limited"],
      [shedLoad(5), "db_capacity_shed"],
    ];
    for (const [f, code] of cases) {
      expect({ code: f.body.code, status: f.status }).toEqual({
        code,
        status: STATUS_DISCIPLINE[code].status,
      });
    }
  });

  test("every constructor yields a publishable failure", () => {
    for (const f of [
      malformedRequest({ detail: "bad json" }),
      unauthenticated(),
      notFound(),
      policyPrecondition(),
      internalBug({ detail: "unexpected" }),
    ]) {
      expect(scanFailure(f)).toEqual([]);
    }
  });
});
