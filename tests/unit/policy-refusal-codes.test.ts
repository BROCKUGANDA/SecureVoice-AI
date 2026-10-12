/**
 * Every policy-gate refusal code is declared, mapped, and documented — and
 * mapped to the RIGHT class of "no".
 *
 * Three lists have to agree about one set of strings, and nothing in TypeScript
 * makes them:
 *
 *   · `src/lib/policy-gate.ts` emits `{ ok: false, code }` — the authority.
 *   · `POLICY_REFUSAL_CODES` / `BILLING_REFUSAL_CODES` in
 *     `src/lib/failures/envelope.ts` — the sets the two sanctioned constructors
 *     will accept. Anything outside them throws a `RangeError`.
 *   · `ERROR_CODES` in `src/lib/contracts/schema.ts` — what the bank is told the
 *     code means, looked up by the same literal, at the same status.
 *
 * The drift this caught was found while adding a twelfth code, not by this test
 * existing first: three codes the gate emitted (`transaction_repeat`,
 * `do_not_call`, `outside_calling_hours`) were missing from the declared list, so
 * `policyRefusal` — documented as the only sanctioned constructor for "the gate
 * said no" — would have thrown on a routine duplicate or cooldown refusal. The
 * envelope's own negative control is that a policy decision can never surface as
 * a 500, and the guard built to guarantee that was itself the path to a 500.
 *
 * The split into two sets is the second thing this file exists for. "Out of
 * credits" arrived as a 409 like every other refusal, which told a bank's
 * integration that a solvable condition was final. It is now 402, and the two
 * constructors refuse each other's codes — so a future edit cannot quietly move a
 * refusal between the classes without a test failing here.
 *
 * The scan is a text scan of the gate's `code: "<literal>"` returns, which is why
 * the shape is pinned: `PolicyGateResult` types `code` as a bare `string`, so the
 * compiler will not notice a new refusal whose literal nobody declared. A dynamic
 * `code: someVariable` would be invisible here; a test below asserts none exists.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BILLING_REFUSAL_CODES,
  POLICY_REFUSAL_CODES,
  billingRefusal,
  policyRefusal,
} from "@/lib/failures/envelope";
import { ERROR_CODES, errorCodesForLiteral } from "@/lib/contracts/schema";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

const GATE = read("src/lib/policy-gate.ts");

/** The literals the gate actually returns, in source order, deduped. */
function emittedCodes(): string[] {
  return [
    ...new Set(
      [...GATE.matchAll(/code:\s*"([a-z0-9_]+)"/g)]
        .map((m) => m[1])
        .filter((code): code is string => code !== undefined),
    ),
  ];
}

describe("policy-gate refusal codes", () => {
  test("the gate emits eleven codes and this suite sees all of them", () => {
    // A guard against the scan itself silently matching nothing (a rename of the
    // field, a reformatted object). An empty `emitted` would make every assertion
    // below vacuously true, which is worse than no test.
    expect(emittedCodes()).toEqual([
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
    // Equality in both directions across BOTH sets: an undeclared code is a
    // `RangeError` waiting for its first caller, and a declared-but-unreachable
    // code is a documented contract no response ever carries.
    const emitted = new Set(emittedCodes());
    const declared = new Set<string>([...POLICY_REFUSAL_CODES, ...BILLING_REFUSAL_CODES]);
    expect([...emitted].filter((c) => !declared.has(c))).toEqual([]);
    expect([...declared].filter((c) => !emitted.has(c))).toEqual([]);
  });

  test("the two classes are disjoint, and the wallet is not a policy", () => {
    // The ruling this pins: `credits_exhausted` is the ONLY refusal a caller
    // clears by paying, so it may never share a constructor, a status, or a set
    // with the decisions about a customer that retrying cannot change.
    const overlap = POLICY_REFUSAL_CODES.filter((c) =>
      (BILLING_REFUSAL_CODES as readonly string[]).includes(c),
    );
    expect(overlap).toEqual([]);
    expect(BILLING_REFUSAL_CODES).toEqual(["credits_exhausted"]);
    expect(POLICY_REFUSAL_CODES).not.toContain("credits_exhausted");
    expect(() => policyRefusal({ ok: false, code: "credits_exhausted", reason: "x" })).toThrow(
      RangeError,
    );
    expect(() => billingRefusal({ ok: false, code: "cooldown", reason: "x" })).toThrow(RangeError);
  });

  test("a policy refusal maps to 409 and a billing refusal to 402", () => {
    for (const code of POLICY_REFUSAL_CODES) {
      const failure = policyRefusal({ ok: false, code, reason: `mapping check: ${code}` });
      expect(failure.status, code).toBe(409);
      expect(failure.body.code, code).toBe("policy_precondition");
      expect(failure.body.retryable, code).toBe(false);
    }
    for (const code of BILLING_REFUSAL_CODES) {
      const failure = billingRefusal({ ok: false, code, reason: `mapping check: ${code}` });
      expect(failure.status, code).toBe(402);
      expect(failure.body.code, code).toBe("payment_required");
    }
  });

  test("every emitted code has a documentation row at the status it actually gets", () => {
    const billing = new Set<string>(BILLING_REFUSAL_CODES);
    for (const code of emittedCodes()) {
      const rows = errorCodesForLiteral(code);
      expect(rows.length, `${code} has no ERROR_CODES row`).toBeGreaterThan(0);
      const wanted = billing.has(code) ? 402 : 409;
      for (const row of rows) {
        expect(row.status, `${row.id} must document a ${wanted}`).toBe(wanted);
        expect(row.meaning.length, `${row.id} has no meaning`).toBeGreaterThan(20);
        expect(row.remediation.length, `${row.id} has no remediation`).toBeGreaterThan(10);
      }
    }
  });

  test("the credits refusal documents the way out", () => {
    // Not just the status: a 402 that does not tell the caller what to DO is a
    // 402 they will handle by retrying, which is what 402 must never invite.
    const rows = errorCodesForLiteral("credits_exhausted");
    expect(rows.map((r) => r.id)).toContain("gate_credits_exhausted");
    const row = rows.find((r) => r.id === "gate_credits_exhausted")!;
    expect(row.envelopeCode).toBe("payment_required");
    expect(row.retryable).toBe(false);
    expect(row.meaning.toLowerCase()).toContain("top up");
    expect(row.remediation.toLowerCase()).toContain("top up");
  });

  test("a paused subscription is refused as a decision, not a fault", () => {
    // The code the previous slice was written for. The behaviour lives in
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
    // The other half of the drift: a documented refusal the server never returns
    // is a bank integration test written against a code that cannot arrive. Scoped
    // to `gate_*` rows reached from ingest, because other rows legitimately
    // document guard codes emitted elsewhere.
    const gateRows = ERROR_CODES.filter(
      (e) =>
        e.id.startsWith("gate_") &&
        e.surface === "http_message" &&
        (e.reachedFrom ?? []).some((r) => String(r).includes("interventions")),
    );
    for (const code of emittedCodes()) {
      expect(
        gateRows.some((r) => r.literal === code),
        `${code} is not documented as an ingest-visible gate row`,
      ).toBe(true);
    }
  });
});
