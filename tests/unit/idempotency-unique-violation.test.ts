/**
 * UNIT — `isUniqueViolation` recognises the error the runtime actually raises.
 *
 * The idempotency store swallows the failure of its fire-and-forget response save,
 * and when it started logging it needed to tell an expected race apart from a real
 * failure. The predicate already in the file tested `code === "23505"` — the
 * PostgreSQL SQLSTATE. Prisma raises `PrismaClientKnownRequestError` with
 * `code: "P2002"`, so the predicate could never have returned true. Nothing
 * noticed because nothing called it.
 *
 * This is not a hypothetical worry in this repository. `case-state-machine.ts`
 * carries a comment about the same class of bug from the inside: a catch keyed on
 * a shape the runtime does not emit "silently never fire[s] — which is the worst
 * possible failure mode for a guard that exists to convert a 500 into a typed
 * refusal." The guard here converts a broken response store into an error log.
 *
 * So the test is built on the real error object, not an object literal shaped like
 * one. A literal would have passed against the broken version too.
 */
import { expect, test } from "bun:test";
import { Prisma } from "@/generated/prisma/client";

import { isUniqueViolation } from "@/lib/idempotency";
import { PRISMA } from "@/lib/failures/db-failures";

function knownRequest(code: string, meta?: Record<string, unknown>): unknown {
  return new Prisma.PrismaClientKnownRequestError(`Unique constraint failed on ${code}`, {
    code,
    clientVersion: "7.0.0",
    ...(meta ? { meta } : {}),
  });
}

test("the Prisma unique-violation code is a violation", () => {
  // The shape the adapter throws on a real collision, with the documented code
  // constant rather than a string typed into both the source and this test.
  const err = knownRequest(PRISMA.UNIQUE_CONSTRAINT, {
    target: ["scope", "key", "callerId"],
  });
  expect(isUniqueViolation(err)).toBe(true);
  // Pinning the code itself: if the constant ever changes meaning, the predicate
  // test above stops being about the thing it claims to test.
  expect(PRISMA.UNIQUE_CONSTRAINT).toBe("P2002");
});

test("the driver's SQLSTATE is also a violation", () => {
  // Some transports surface the raw Postgres code instead of Prisma's. Accepting
  // both costs nothing here: a missed match is a log line, a false match is a
  // missing log line, and neither is a silent success.
  expect(isUniqueViolation({ code: "23505" })).toBe(true);
});

test("every other failure is NOT a violation", () => {
  // The direction that matters: if this matches too much, a genuinely broken
  // response store is filed under "expected race" and never surfaces.
  const notViolations: unknown[] = [
    knownRequest(PRISMA.FOREIGN_KEY_CONSTRAINT),
    knownRequest(PRISMA.RECORD_NOT_FOUND),
    knownRequest("P2028", { modelName: "IdempotencyKey" }),
    new Error("connection reset"),
    { code: undefined },
    { code: null },
    { code: 23505 }, // a number is not the string, and must not match
    null,
    undefined,
    "P2002",
    0,
  ];
  for (const err of notViolations) {
    expect({ err: String(err), violation: isUniqueViolation(err) }).toEqual({
      err: String(err),
      violation: false,
    });
  }
});
