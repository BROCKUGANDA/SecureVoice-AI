/**
 * UNIT — the route helpers (src/lib/route-helpers.ts).
 *
 * These helpers are the thin layer every API route puts between a thrown value
 * and a caller. `handlePrismaError` describes itself as "the single place that
 * maps database error codes to our failure envelope", which makes the mapping a
 * contract rather than an implementation detail: a route must not have to guess
 * whether a lost race is a 409 or a 503.
 *
 * The properties pinned here:
 *
 *   · **Status discipline is the mapping, not an accident.** P2002 → 409
 *     `unique_conflict` (the row the caller sent already exists), P2003 → 409
 *     `reference_conflict`, P2025 → 404 `not_found`, the two 503s keep their
 *     `Retry-After`, and anything unrecognised becomes a 500. Getting one wrong
 *     is not cosmetic: 503-where-409-below tells a caller the platform is
 *     unwell, and 500-where-409-below tells it to abandon a merely-late
 *     request.
 *   · **A failure built here is publishable.** `scanFailure()` comes back empty
 *     for every input, including a driver message carrying a constraint name
 *     and a row id. That is the assertion that proves no driver string escapes,
 *     and it is why the driver messages below are the realistic ones rather
 *     than placeholders.
 *   · **`fail()` is the last gate.** A hand-built failure that DOES leak is
 *     replaced by a safe 500 rather than serialised, because `fail()` is all
 *     that stands between a bad message and a caller.
 *   · **Non-`Error` throwables are not a crash path.** JS allows throwing a
 *     string, `null` or a number; the classifier must classify, not explode.
 *
 * `handleZodError` is exercised against REAL Zod 4 errors as well as the Zod 3
 *   `errors` shape it still accepts. It used to key only on `.errors`, which
 *   Zod 4 removed, so every real validation failure returned `null` and fell
 *   through to a 500 — that is fixed, and both paths are now pinned.
 *
 * `requireOrg` / `requireOrgWithCapability` are not covered: they open a real
 * database connection, which is a live-integration concern, not a unit one.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { Prisma } from "@/generated/prisma/client";
import { z, ZodError } from "zod";
import {
  crossTenantNotFound,
  dependencyUnavailable,
  fail,
  handlePrismaError,
  handleZodError,
  internalBug,
  malformedRequest,
  newRequestId,
  notFound,
  ok,
  policyPrecondition,
  rateLimited,
  semanticallyInvalid,
  shedLoad,
  stateConflict,
  unauthenticated,
} from "@/lib/route-helpers";
import {
  STATUS_DISCIPLINE,
  makeFailure,
  requestIdIsOpaque,
  scanFailure,
  type Failure,
  type FailureCode,
} from "@/lib/failures/envelope";

/**
 * A REAL `Prisma.PrismaClientKnownRequestError`, so the classifier runs against
 * the class the runtime actually throws rather than a look-alike whose
 * `instanceof` happens to agree.
 */
function prismaError(code: string, message: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: "6.19.2",
  });
}

/** The exact driver message Prisma emits for a unique-index violation. */
const UNIQUE_VIOLATION_MSG = "Unique constraint failed on the fields: (`email`)";

describe("handlePrismaError — code to status mapping", () => {
  test("P2002 (unique violation) is a 409 unique_conflict, not a 500", () => {
    // The row the caller sent already exists. That is a conflict they can
    // resolve; a 500 would tell them to page someone about our platform.
    const f = handlePrismaError(prismaError("P2002", UNIQUE_VIOLATION_MSG));
    expect(f.body.code).toBe("unique_conflict");
    expect(f.status).toBe(409);
    expect(f.body.retryable).toBe(false);
    expect(f.headers["Retry-After"]).toBeUndefined();
  });

  test("P2003 (foreign key violation) is a 409 reference_conflict", () => {
    const f = handlePrismaError(
      prismaError("P2003", "Foreign key constraint violated on the field: `caseId`"),
    );
    expect(f.body.code).toBe("reference_conflict");
    expect(f.status).toBe(409);
    expect(f.body.retryable).toBe(false);
  });

  test("P2025 (record not found) is a 404 byte-identical to cross-tenant", () => {
    // P2025 cannot distinguish "gone" from "someone else's". Both answer 404
    // with the same body, so a prober learns nothing from the difference.
    const f = handlePrismaError(
      prismaError(
        "P2025",
        "An operation failed because it depends on one or more records that were required but not found.",
      ),
    );
    expect(f.body.code).toBe("not_found");
    expect(f.status).toBe(404);

    const crossTenant = crossTenantNotFound();
    expect({ code: f.body.code, message: f.body.message }).toEqual({
      code: crossTenant.body.code,
      message: crossTenant.body.message,
    });
  });

  test("P2034 (lost transaction race) is a retryable 503 with a Retry-After", () => {
    const f = handlePrismaError(
      prismaError("P2034", "Transaction failed due to a write conflict."),
    );
    expect(f.body.code).toBe("dependency_unavailable");
    expect(f.status).toBe(503);
    expect(f.body.retryable).toBe(true);
    expect(f.headers["Retry-After"]).toBe("5");
  });

  test("P2038 (pool timeout) is a 503 statement_timeout with a Retry-After", () => {
    const f = handlePrismaError(
      prismaError("P2038", "Timed out fetching a new connection from the connection pool."),
    );
    expect(f.body.code).toBe("statement_timeout");
    expect(f.status).toBe(503);
    expect(f.body.retryable).toBe(true);
    expect(f.headers["Retry-After"]).toBe("5");
  });

  test("an unrecognised Prisma code becomes a 500, never a 4xx", () => {
    // A code we have not mapped means we do not know what happened. Guessing
    // a 4xx would blame the caller for our gap.
    const f = handlePrismaError(prismaError("P2712", "something new"));
    expect(f.body.code).toBe("internal_bug");
    expect(f.status).toBe(500);
  });

  test("an unmapped code is kept on the server-side detail, not as the message", () => {
    // The driver code is useful to us in logs; the public message has to
    // stand on its own for a caller who has never heard of Prisma.
    const f = handlePrismaError(prismaError("P2712", "something new"));
    expect(f.detail).toBe("Prisma error: P2712");
    expect(f.body.message).toContain("Internal error.");
  });
});

describe("handlePrismaError — non-Prisma throwables", () => {
  test("anything that is not a known request error is a 500", () => {
    // A validation error, a driver error and a TypeError all land here. None
    // is a client mistake, so none may be reported as a 4xx.
    const cases: unknown[] = [
      new TypeError("x is not a function"),
      new Prisma.PrismaClientValidationError("bad query", {
        clientVersion: "6.19.2",
      }),
      { code: "P2002", meta: { target: ["email"] } },
    ];
    for (const err of cases) {
      const f = handlePrismaError(err);
      expect({ code: f.body.code, status: f.status }).toEqual({
        code: "internal_bug",
        status: 500,
      });
    }
  });

  test("a structurally Prisma-shaped object is NOT trusted as a known error", () => {
    // Same shape as a driver error, different class. Trusting the shape
    // would let any thrown value carrying `code: "P2025"` masquerade as a
    // real database miss and turn a bug into a 404.
    const impostor = Object.assign(new Error("nope"), { code: "P2025" });
    expect(handlePrismaError(impostor).body.code).toBe("internal_bug");
  });

  test("primitives and nullish throws classify instead of crashing", () => {
    // `throw "boom"` is legal JavaScript. The handler must not read `.code`
    // off a string, and must not throw while reporting a throw.
    const cases: unknown[] = ["boom", null, undefined, 42, Symbol("s"), { code: 2002 }];
    for (const err of cases) {
      const f = handlePrismaError(err);
      expect({ code: f.body.code, status: f.status, leaks: scanFailure(f) }).toEqual({
        code: "internal_bug",
        status: 500,
        leaks: [],
      });
    }
  });
});

describe("handlePrismaError — requestId and leak discipline", () => {
  test("a supplied requestId reaches both the body and the header", () => {
    const f = handlePrismaError(prismaError("P2002", UNIQUE_VIOLATION_MSG), "svreq_abc123");
    expect(f.body.requestId).toBe("svreq_abc123");
    expect(f.headers["x-request-id"]).toBe("svreq_abc123");
  });

  test("a requestId that looks like customer data is replaced, not echoed", () => {
    // A phone number in this field would put customer data into every
    // response body and into every log line it is joined to. The
    // replacement is a fresh random token, so the property to assert is
    // opacity — not equality with a second `normaliseRequestId` call,
    // which would mint a different token and prove nothing.
    const f = handlePrismaError(prismaError("P2002", UNIQUE_VIOLATION_MSG), "+919876543210");
    expect(f.body.requestId).not.toBe("+919876543210");
    expect(f.body.requestId).not.toContain("9876543210");
    expect(requestIdIsOpaque(f.body.requestId)).toBe(true);
    expect(scanFailure(f)).toEqual([]);
  });

  test("a replacement requestId differs per failure, so reports stay separable", () => {
    // Two requests that both supplied a phone number must not collapse onto
    // one shared id, or the operator cannot tell their reports apart.
    const a = handlePrismaError(prismaError("P2002", UNIQUE_VIOLATION_MSG), "+919876543210");
    const b = handlePrismaError(prismaError("P2002", UNIQUE_VIOLATION_MSG), "+919876543210");
    expect(a.body.requestId).not.toBe(b.body.requestId);
  });

  test("no requestId means a fresh opaque one, never an empty or fixed value", () => {
    // An empty or predictable id cannot correlate a caller's report with a
    // log line, which defeats the only purpose of the field.
    const f = handlePrismaError(prismaError("P2002", UNIQUE_VIOLATION_MSG));
    expect(f.body.requestId).toMatch(/^svreq_[A-Za-z0-9_-]{20,}$/);
    expect(f.body.requestId).not.toBe(newRequestId());
  });

  test("every mapped code publishes clean of leaks, whatever the driver said", () => {
    // The driver message is the most likely carrier of a constraint name, a
    // table name or another tenant's row id. None may reach the body — and
    // the cross-product matters, because a code could be mapped safely while
    // the shared detail-building path is not.
    const driverMessages = [
      UNIQUE_VIOLATION_MSG,
      "Foreign key constraint violated on the field: `caseId`",
      "Unique constraint failed on the constraint: `User_orgId_email_key`",
      "Key (orgId)=(org_9f2c4a17e0b34d55) already exists.",
      "An operation failed because it depends on one or more records that were required but not found.",
    ];
    const codes = ["P2025", "P2002", "P2003", "P2034", "P2038", "P2712"];
    for (const code of codes) {
      for (const message of driverMessages) {
        const f = handlePrismaError(prismaError(code, message), "svreq_abc123");
        expect({ code, leaks: scanFailure(f) }).toEqual({ code, leaks: [] });
      }
    }
  });
});

describe("fail — the last gate before a caller", () => {
  test("the body has exactly the five envelope fields", async () => {
    // A sixth field is either an internal detail or a leak, so the count is
    // asserted rather than the contents.
    const res = fail(makeFailure("unique_conflict", { requestId: "svreq_abc123" }));
    expect(res.status).toBe(409);
    const body: unknown = await res.json();
    expect(Object.keys(body as object).sort()).toEqual([
      "code",
      "docsUrl",
      "message",
      "requestId",
      "retryable",
    ]);
  });

  test("the status is the failure's status and the id travels in the header", () => {
    const res = fail(makeFailure("unauthenticated", { requestId: "svreq_abc123" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("x-request-id")).toBe("svreq_abc123");
  });

  test("a required Retry-After is emitted as a header, not as a body field", async () => {
    // The header is the only channel a client honours; keeping it out of the
    // body is exactly what lets the body stay at five fields.
    const res = fail(rateLimited(30, { requestId: "svreq_abc123" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    const body: unknown = await res.json();
    expect(Object.keys(body as object)).not.toContain("retryAfterSec");
  });

  test("a leaking failure is replaced by a safe 500, never serialised", async () => {
    // `fail()` is the last mechanical gate. If it ever forwards a message
    // that trips the scanner, the whole envelope contract is decorative.
    const leaky = makeFailure("internal_bug", { requestId: "svreq_abc123" });
    leaky.body.message = "Key (orgId)=(org_9f2c4a17e0b34d55)";

    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = fail(leaky);
      expect(res.status).toBe(500);
      const body: unknown = await res.json();
      expect(Object.keys(body as object).sort()).toEqual([
        "code",
        "docsUrl",
        "message",
        "requestId",
        "retryable",
      ]);
      const typed = body as Failure["body"];
      expect(typed.code).toBe("internal_bug");
      expect(typed.message).toBe("Internal error.");
      expect(JSON.stringify(body)).not.toContain("9f2c4a17e0b34d55");
      // Silent corruption would be worse than a 500, so the substitution
      // has to leave a trace for the operator reading the logs.
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  test("the replacement keeps the caller's requestId so the report still correlates", () => {
    // Swapping the body must not orphan the correlation token — that is the
    // one thing in the body the caller is entitled to see.
    const leaky = makeFailure("internal_bug", { requestId: "svreq_keepme" });
    leaky.body.message = "at handler (src/lib/route-helpers.ts:99:5)";
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = fail(leaky);
      expect(res.status).toBe(500);
      expect(res.headers.get("x-request-id")).toBe("svreq_keepme");
    } finally {
      logged.mockRestore();
    }
  });

  test("a clean failure passes through untouched, code and status intact", async () => {
    const res = fail(makeFailure("reference_conflict", { requestId: "svreq_abc123" }));
    expect(res.status).toBe(409);
    const body: unknown = await res.json();
    expect((body as Failure["body"]).code).toBe("reference_conflict");
  });
});

describe("ok — the success response", () => {
  test("defaults to 200 and serialises the payload", async () => {
    const res = ok({ cases: [{ id: "case_1" }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cases: [{ id: "case_1" }] });
  });

  test("a ResponseInit is honoured, so 201 is reachable without a wrapper", () => {
    const res = ok({ id: "case_1" }, { status: 201, headers: { Location: "/api/cases/case_1" } });
    expect(res.status).toBe(201);
    expect(res.headers.get("Location")).toBe("/api/cases/case_1");
  });

  test("null and empty payloads survive without being coerced to {}", async () => {
    // `ok(null)` reaching the client as `{}` would collapse "nothing to
    // report" into "an empty result set" — two different facts.
    expect(await ok(null).json()).toBeNull();
    expect(await ok([]).json()).toEqual([]);
  });
});

describe("handleZodError — Zod 4 (the shape a real parse throws)", () => {
  // A REAL ZodError is the case that matters. `z.object({...}).parse(...)`
  // throws one of these, and the bug this covers was that `handleZodError`
  // returned `null` for it, so every malformed request became a 500.
  const schema = z.object({
    email: z.string().email(),
    amount: z.number().int().positive(),
  });

  test("a real ZodError becomes a 422, not a null that falls through to 500", () => {
    let thrown: unknown;
    try {
      schema.parse({ email: "not-an-email", amount: -1 });
    } catch (err) {
      thrown = err;
    }
    const f = handleZodError(thrown);
    expect(f).not.toBeNull();
    expect(f?.status).toBe(422);
    expect(f?.body.code).toBe("semantically_invalid");
  });

  test("the 422 names the offending field from the real issue path", () => {
    let thrown: unknown;
    try {
      schema.parse({ email: "nope", amount: 5 });
    } catch (err) {
      thrown = err;
    }
    expect(handleZodError(thrown)?.body.message).toContain("email");
  });

  test("a ZodError is recognised by instanceof AND by its shape", () => {
    // The shape path is what survives two copies of zod in one process, where
    // instanceof is false but the issue array is still a real Zod issue list.
    let thrown: unknown;
    try {
      schema.parse({ email: "nope", amount: 5 });
    } catch (err) {
      thrown = err;
    }
    const disguised = Object.assign(new Error("validation failed"), {
      issues: (thrown as ZodError).issues,
    });
    expect(handleZodError(disguised)?.status).toBe(422);
  });
});

describe("handleZodError — the Zod 3 shape it still accepts", () => {
  /**
   * Zod 3's `ZodError.errors`, kept supported so reverting the major does not
   * silently re-break the helper.
   */
  function zodLikeError(issues: ReadonlyArray<{ path?: unknown[]; message?: string }>): Error {
    return Object.assign(new Error("validation failed"), { errors: issues });
  }

  test("a validation error becomes a 422 semantically_invalid", () => {
    // 422, not 400: the request parsed and was shaped correctly, the VALUES
    // were wrong. Collapsing the two tells a well-behaved client it has a
    // syntax bug it does not have.
    const f = handleZodError(zodLikeError([{ path: ["email"], message: "Invalid email address" }]));
    expect(f?.body.code).toBe("semantically_invalid");
    expect(f?.status).toBe(422);
    expect(f?.body.retryable).toBe(false);
  });

  test("an issue is reported as `path: message` so the caller knows which field", () => {
    const f = handleZodError(
      zodLikeError([
        { path: ["email"], message: "Invalid email address" },
        { path: ["profile", "age"], message: "Too small" },
      ]),
      "svreq_abc123",
    );
    expect(f?.body.message).toContain("email: Invalid email address");
    expect(f?.body.message).toContain("profile.age: Too small");
    expect(f?.body.requestId).toBe("svreq_abc123");
  });

  test("an issue with no path is attributed to the root, not dropped", () => {
    const f = handleZodError(zodLikeError([{ message: "bad payload" }]));
    expect(f?.body.message).toContain("root: bad payload");
  });

  test("a nested array index survives as part of the path", () => {
    // `items.0.email` — collapsing the index would point the caller at the
    // wrong element of the wrong array.
    const f = handleZodError(
      zodLikeError([{ path: ["items", 0, "email"], message: "Invalid email address" }]),
    );
    expect(f?.body.message).toContain("items.0.email: Invalid email address");
  });

  test("at most three issues are quoted, so the body stays a sentence", () => {
    const f = handleZodError(
      zodLikeError([
        { path: ["a"], message: "first" },
        { path: ["b"], message: "second" },
        { path: ["c"], message: "third" },
        { path: ["d"], message: "fourth" },
      ]),
    );
    expect(f?.body.message).toContain("first");
    expect(f?.body.message).toContain("third");
    expect(f?.body.message).not.toContain("fourth");
  });

  test("a non-Zod error is not claimed: the caller keeps its own handler", () => {
    // `null` is the signal to fall through to `handlePrismaError`. Swallowing
    // a bug into a 422 would tell the user their input was at fault.
    const notZod: unknown[] = [
      new TypeError("undefined is not a function"),
      prismaError("P2002", UNIQUE_VIOLATION_MSG),
      "string error",
      null,
      undefined,
      {},
    ];
    for (const err of notZod) {
      expect(handleZodError(err)).toBeNull();
    }
  });

  test("an `errors` value that is not an array is not a Zod error", () => {
    // Duck-typing on the key alone would map any object carrying `errors`
    // onto the 422 path, including our own API error bodies.
    expect(handleZodError(Object.assign(new Error("x"), { errors: "boom" }))).toBeNull();
  });

  test("a validation message carrying a row id publishes clean", () => {
    // Zod refinements are the classic place an email uniqueness check
    // interpolates the conflicting row into the message.
    const f = handleZodError(
      zodLikeError([{ path: ["email"], message: "org_9f2c4a17e0b34d55 is taken" }]),
    );
    expect(f).not.toBeNull();
    if (f !== null) {
      expect(scanFailure(f)).toEqual([]);
      expect(f.body.message).not.toContain("9f2c4a17e0b34d55");
    }
  });

  test("an empty issue list still yields a 422 rather than a 500", () => {
    // An empty ZodError should never be constructed, but if one is the
    // correct answer is still "your input was wrong", not "we are broken".
    const f = handleZodError(zodLikeError([]));
    expect(f?.body.code).toBe("semantically_invalid");
    expect(f?.status).toBe(422);
  });
});

describe("re-exported failure constructors", () => {
  test("every re-exported constructor agrees with the status discipline table", () => {
    // Driven through the same constructors a route would import from here.
    // A re-export that drifted from the envelope module would show up as a
    // status that no longer matches its own code's row.
    const built: readonly Failure[] = [
      malformedRequest(),
      unauthenticated(),
      notFound(),
      crossTenantNotFound(),
      stateConflict(),
      semanticallyInvalid(),
      internalBug(),
      policyPrecondition(),
      dependencyUnavailable(5),
      shedLoad(30),
      rateLimited(60),
    ];
    for (const failure of built) {
      const expected: (typeof STATUS_DISCIPLINE)[FailureCode] =
        STATUS_DISCIPLINE[failure.body.code];
      expect(failure.status).toBe(expected.status);
      expect(failure.body.retryable).toBe(expected.retryable);
      // A rule marked retryAfter: true must actually emit the header, or a
      // client has no idea when it is worth coming back.
      if (expected.retryAfter) {
        expect(failure.headers["Retry-After"]).toBeDefined();
      }
      expect(scanFailure(failure)).toEqual([]);
    }
  });

  test("the codes the two handlers name are distinct and all defined", () => {
    // `handlePrismaError` selects codes by string; a typo would be a
    // RangeError at runtime. Distinctness matters too: collapsing two
    // conditions onto one code would tell a client to retry the wrong way.
    const mapped = new Set<FailureCode>([
      handlePrismaError(prismaError("P2002", UNIQUE_VIOLATION_MSG)).body.code,
      handlePrismaError(prismaError("P2003", "fk")).body.code,
      handlePrismaError(prismaError("P2025", "missing")).body.code,
      handlePrismaError(prismaError("P2034", "contended")).body.code,
      handlePrismaError(prismaError("P2038", "timeout")).body.code,
      handlePrismaError(prismaError("P2712", "unknown")).body.code,
      handlePrismaError(new Error("not prisma")).body.code,
      handleZodError(Object.assign(new Error("v"), { errors: [] }))?.body.code ??
        "semantically_invalid",
    ]);
    for (const code of mapped) {
      expect(STATUS_DISCIPLINE[code]).toBeDefined();
    }
    expect([...mapped].sort()).toEqual([
      "dependency_unavailable",
      "internal_bug",
      "not_found",
      "reference_conflict",
      "semantically_invalid",
      "statement_timeout",
      "unique_conflict",
    ]);
  });

  test("newRequestId is re-exported and produces distinct opaque tokens", () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^svreq_/);
  });
});
