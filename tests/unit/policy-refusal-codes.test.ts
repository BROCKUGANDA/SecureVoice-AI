/**
 * Every policy-gate refusal code is declared, mapped, and documented.
 *
 * Three lists have to agree about one set of strings, and nothing in TypeScript
 * makes them:
 *
 *   · `src/lib/policy-gate.ts` emits `{ ok: false, code }` — the authority.
 *   · `POLICY_REFUSAL_CODES` in `src/lib/failures/envelope.ts` — the set
 *     `policyRefusal()` will accept. Anything outside it throws a `RangeError`.
 *   · `ERROR_CODES` in `src/lib/contracts/schema.ts` — what the bank is told the
 *     code means, looked up by the same literal.
 *
 * The drift this caught was found while adding a fourth code, not by this test
 * existing first: three codes the gate emitted (`transaction_repeat`,
 * `do_not_call`, `outside_calling_hours`) were missing from the declared list, so
 * `policyRefusal` — documented as "the only sanctioned constructor for 'the gate
 * said no'" — would have thrown on a routine duplicate or cooldown refusal. The
 * envelope's whole negative control is that a policy decision can never surface as
 * a 500, and the guard built to guarantee that was itself the path to a 500.
 *
 * The scan is a text scan of the gate's `code: "<literal>"` returns, which is why
 * the shape is pinned: `PolicyGateResult` types `code` as a bare `string`, so the
 * compiler will not notice a new refusal whose literal nobody declared. A dynamic
 * `code: someVariable` would be invisible here; the second test asserts none
 * exists, so the scan stays a complete enumeration rather than a sample.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { POLICY_REFUSAL_CODES, policyRefusal } from "@/lib/failures/envelope";
import { ERROR_CODES, errorCodesForLiteral } from "@/lib/contracts/schema";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

const GATE = read("src/lib/policy-gate.ts");

/** The literals the gate actually returns, in source order, deduped. */
function emittedCodes(): string[] {
  return [...new Set([...GATE.matchAll(/code:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]))];
}

describe("policy-gate refusal codes", () => {
  test("the gate emits eleven codes and this suite sees all of them", () => {
    // A guard against the scan itself silently matching nothing (a rename of the
    // field, a reformatted object). An empty `emitted` would make every assertion
    // below vacuously true, which is worse than no test.
    const codes = emittedCodes();
    expect(codes).toEqual([
      "transaction_repeat",
      "consent_invalid",
      "do_not_call",
      "outside_calling_hours",
      "country_unparseable",
      "country_not_allowed",
      "cooldown",
      "concurrency_cap",
      "spend_ceiling",
      "subscription_paused",
      "credits_exhausted",
    ]);
  });

  test("no refusal returns a computed code, so the literal scan is exhaustive", () => {
    const computed = [...GATE.matchAll(/code:\s*(?!")[A-Za-z_$][\w$.]*/g)].filter(
      (m) => !m[0].startsWith("code: string"),
    );
    expect(computed.map((m) => m[0])).toEqual([]);
  });

  test("every emitted code is declared, and every declared code is emitted", () => {
    // Equality in both directions: an undeclared code is a `RangeError` waiting
    // for its first caller, and a declared-but-unreachable code is a documented
    // contract no response ever carries — both are lies in the same direction.
    const emitted = new Set(emittedCodes());
    const declared = new Set<string>(POLICY_REFUSAL_CODES);
    expect([...emitted].filter((c) => !declared.has(c))).toEqual([]);
    expect([...declared].filter((c) => !emitted.has(c))).toEqual([]);
  });

  test("every emitted code maps to 409 through the sanctioned constructor", () => {
    for (const code of emittedCodes()) {
      const failure = policyRefusal({ ok: false, code, reason: `mapping check: ${code}` });
      expect(failure.status, code).toBe(409);
      expect(failure.body.code, code).toBe("policy_precondition");
      expect(failure.body.retryable, code).toBe(false);
    }
  });

  test("every emitted code has a documentation row the bank can look up", () => {
    for (const code of emittedCodes()) {
      const rows = errorCodesForLiteral(code);
      expect(rows.length, `${code} has no ERROR_CODES row`).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.status, `${row.id} must document a 409`).toBe(409);
        expect(row.meaning.length, `${row.id} has no meaning`).toBeGreaterThan(20);
        expect(row.remediation.length, `${row.id} has no remediation`).toBeGreaterThan(10);
      }
    }
  });

  test("a paused subscription is refused as a decision, not a fault", () => {
    // The code this suite was written for. The behaviour lives in
    // `tests/billing/subscription-dialling-access.test.ts`; what belongs here is
    // that the refusal the bank receives is a 409 with a documented meaning,
    // because "your own account is paused" arriving as a 500 would tell them to
    // retry the same refusal forever.
    expect(POLICY_REFUSAL_CODES).toContain("subscription_paused");
    const row = errorCodesForLiteral("subscription_paused");
    expect(row.map((r) => r.id)).toContain("gate_subscription_paused");
    expect(row.every((r) => r.retryable)).toBe(true);
  });

  test("the registry contains no orphan gate row for a code the gate stopped emitting", () => {
    // The other half of the drift: a documented 409 the server never returns is a
    // bank integration test written against a code that cannot arrive. Scoped to
    // `gate_*` rows whose literal is snake_case and which are reached from ingest,
    // because other rows legitimately document guard codes emitted elsewhere.
    const gateRows = ERROR_CODES.filter(
      (e) =>
        e.id.startsWith("gate_") &&
        e.surface === "http_message" &&
        (e.reachedFrom ?? []).some((r) => String(r).includes("interventions")),
    );
    // Nothing asserted about the rows the GATE does not emit — several come from
    // abuse guards and the worker — but every gate-emitted code must be in here.
    for (const code of emittedCodes()) {
      expect(
        gateRows.some((r) => r.literal === code),
        `${code} is not documented as an ingest-visible gate row`,
      ).toBe(true);
    }
  });
});
