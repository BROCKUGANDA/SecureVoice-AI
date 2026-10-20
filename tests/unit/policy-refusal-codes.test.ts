/**
 * Every gate refusal code is declared, mapped, and documented — and mapped to the
 * RIGHT class of "no".
 *
 * Three lists have to agree about one set of strings, and nothing in TypeScript
 * makes them:
 *
 *   · the emitting gates — `src/lib/policy-gate.ts`, `src/lib/compliance/gate.ts`
 *     and the abuse gate (`src/lib/abuse/guards.ts` plus the geo/tier/velocity
 *     vocabularies it composes) — the authority on what can actually arrive.
 *   · `POLICY_REFUSAL_CODES` / `BILLING_REFUSAL_CODES` in
 *     `src/lib/failures/envelope.ts` — the sets the two sanctioned constructors
 *     will accept. Anything outside them throws a `RangeError`.
 *   · `ERROR_CODES` in `src/lib/contracts/schema.ts` — what the bank is told the
 *     code means, looked up by the same literal, at the same status.
 *
 * The drift this caught was found while adding a twelfth code, not by this test
 * existing first: three codes the policy gate emitted (`transaction_repeat`,
 * `do_not_call`, `outside_calling_hours`) were missing from the declared list, so
 * `policyRefusal` — documented as the only sanctioned constructor for "the gate
 * said no" — would have thrown on a routine duplicate refusal. The envelope's own
 * negative control is that a policy decision can never surface as a 500, and the
 * guard built to guarantee that was itself the path to a 500.
 *
 * Widening it from one gate to three found the same two failures in mirror image.
 *
 * UNDECLARED, and reaching a bank today: the abuse gate's 17 `AbuseReason` values
 * and three of the compliance gate's four causes had no entry in any declared set.
 * Ingest classifies a thrown refusal against the declared sets, so every
 * geography, tier, velocity, cooldown and cap refusal logged "refusal code is in
 * neither declared set" on its way out as a perfectly correct 409 — a warning that
 * fires on every routine refusal is one nobody reads, which is precisely when a
 * genuinely unclassified code would slip past it. `invalid_call_category`,
 * `redaction_mismatch` and `prayer_time` also had no catalog row at all: three
 * customer-visible causes the contract never explained, one of them a data-
 * protection refusal.
 *
 * DECLARED BUT UNREACHABLE: `cooldown` and `concurrency_cap`. The policy gate's
 * steps 3 and 4 read two in-memory maps whose only writer, `recordCallPlacement()`,
 * was called by no route — so the maps were always empty, neither check could ever
 * fire, and the two codes documented a refusal the server physically could not
 * return. That is the failure mode the orphan-row test below exists for, arriving
 * from the other direction: not a code emitted and undocumented, but a code
 * documented and unemittable, which is a bank integration test written against a
 * cause that can never show up. Both were deleted; the live cause of the same
 * name is the abuse gate's `destination_cooldown`, documented at its own literal.
 *
 * The scan of the two procedural gates is a text scan of their `code: "<literal>"`
 * returns, which is why the shape is pinned: `PolicyGateResult` and
 * `ComplianceGateResult` type `code` as a bare `string`, so the compiler will not
 * notice a new refusal whose literal nobody declared. A dynamic `code: someVariable`
 * would be invisible here; a test below asserts none exists. The abuse gate is
 * typed — `AbuseReason` is a real union — so its half reads the union members out of
 * the four source files instead, and a test asserts each of those four reads found
 * something, because a renamed type would otherwise scan as an empty set and make
 * every assertion below vacuously true.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ABUSE_REFUSAL_CODES,
  BILLING_REFUSAL_CODES,
  COMPLIANCE_REFUSAL_CODES,
  PILOT_REFUSAL_CODES,
  POLICY_REFUSAL_CODES,
  billingRefusal,
  policyRefusal,
} from "@/lib/failures/envelope";
import { ERROR_CODES, errorCodesForLiteral } from "@/lib/contracts/schema";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

const GATE = read("src/lib/policy-gate.ts");
const COMPLIANCE = read("src/lib/compliance/gate.ts");
/**
 * The pilot charter gate (`src/lib/pilot/gate.ts`).
 *
 * It is a FOURTH emitter for the same reason the other three are emitters:
 * its refusals reach a bank as 409s with a cause, and a cause that is not in
 * the declared vocabulary makes `policyRefusal` throw a `RangeError` on a
 * routine pilot signal — which is a 500 telling the bank to retry a decision
 * that will be refused identically.
 */
const PILOT = read("src/lib/pilot/gate.ts");

/**
 * The gates that refuse with a `code: "<literal>"` the classifier then looks up in
 * `POLICY_REFUSAL_CODES`. Named so the two procedural gates are one list: a
 * refusal that reaches `src/app/api/v1/interventions/route.ts` as a typed code and
 * is missing from the declared set mis-classifies in exactly the way `prayer_time`
 * did before this scan was widened.
 */
const REFUSAL_EMITTERS: readonly (readonly [string, string])[] = [
  ["policy-gate", GATE],
  ["compliance-gate", COMPLIANCE],
  ["pilot-gate", PILOT],
];

/** Literals a gate returns as `code: "…"`, in source order, deduped. */
function proceduralCodes(source: string): string[] {
  return [
    ...new Set(
      [...source.matchAll(/code:\s*"([a-z0-9_]+)"/g)]
        .map((m) => m[1])
        .filter((code): code is string => code !== undefined),
    ),
  ];
}

/**
 * The members of one exported string-literal union type.
 *
 * Matched by type NAME and cut at the union's own terminating semicolon, so a
 * later `Exclude<…>` in the same file cannot widen the read.
 */
function unionMembers(source: string, typeName: string): string[] {
  const block = new RegExp(`export type ${typeName} =[\\s\\S]*?;`).exec(source)?.[0] ?? "";
  return [...new Set([...block.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]!))].filter(
    (x): x is string => x !== undefined,
  );
}

const GUARDS = read("src/lib/abuse/guards.ts");
const GEO = read("src/lib/abuse/geo.ts");
const TIERS = read("src/lib/abuse/tiers.ts");
const VELOCITY = read("src/lib/abuse/velocity.ts");

/**
 * The abuse gate's live vocabulary: `AbuseReason` is
 * `GeoRejectReason | TierRejectReason | VelocityRejectReason` plus its own four
 * controls, so the union has to be resolved across the four files that declare it.
 */
function abuseGateCodes(): string[] {
  return [
    ...new Set([
      ...unionMembers(GEO, "GeoRejectReason"),
      ...unionMembers(TIERS, "TierRejectReason"),
      ...unionMembers(VELOCITY, "VelocityRejectReason"),
      // `AbuseReason` itself carries only its own literals; the three referenced
      // type names are unquoted and so are not picked up here.
      ...unionMembers(GUARDS, "AbuseReason"),
    ]),
  ];
}

/** Every refusal the four gates can actually emit. */
function emittedCodes(): string[] {
  return [
    ...new Set([
      ...proceduralCodes(GATE),
      ...proceduralCodes(COMPLIANCE),
      ...proceduralCodes(PILOT),
      ...abuseGateCodes(),
    ]),
  ];
}

/**
 * Causes a route names in the `detail` of an envelope refusal, rather than as a
 * gate's `code`.
 *
 * `failure("policy_precondition", { detail: "consent_opted_out" })` puts
 * `consent_opted_out` on the wire inside `message` while the body's `code` stays
 * `policy_precondition`. It is a second, legitimate channel into the same catalog
 * surface, so the orphan check below has to know about it — otherwise a documented
 * cause with no gate `code:` behind it reads as a phantom and the honest answer is
 * to widen the scan, not to delete the row.
 */
function routeDetailCauses(): string[] {
  return [
    ...new Set(
      [
        ...read("src/app/api/v1/interventions/route.ts").matchAll(/detail:\s*"([a-z0-9_]+)"/g),
        ...read("src/app/api/interventions/route.ts").matchAll(/detail:\s*"([a-z0-9_]+)"/g),
      ].map((m) => m[1]!),
    ),
  ];
}

describe("gate refusal codes", () => {
  test("each scan found its own vocabulary — an empty read is not a green", () => {
    // Without this, a renamed type or a reformatted `code:` object would make the
    // equality assertions below vacuously true, which is worse than no test.
    // 9, not 8: `credits_exhausted` is the ninth and it is declared in the BILLING
    // set rather than the policy one — the only refusal a caller clears by paying.
    expect(proceduralCodes(GATE).length).toBe(9);
    expect(proceduralCodes(COMPLIANCE)).toEqual([
      "invalid_call_category",
      "outside_calling_hours",
      "redaction_mismatch",
      "prayer_time",
    ]);
    expect(unionMembers(GEO, "GeoRejectReason")).toHaveLength(7);
    expect(unionMembers(TIERS, "TierRejectReason")).toHaveLength(2);
    expect(unionMembers(VELOCITY, "VelocityRejectReason")).toHaveLength(4);
    expect(unionMembers(GUARDS, "AbuseReason")).toHaveLength(4);
    expect(abuseGateCodes()).toHaveLength(17);
    expect(ABUSE_REFUSAL_CODES).toHaveLength(16);
    // The pilot gate's own vocabulary, read out of the file rather than
    // assumed: an empty read would make every pilot assertion below vacuous.
    expect(proceduralCodes(PILOT)).toEqual([
      "pilot_signal_kind_out_of_scope",
      "pilot_cap_misconfigured",
      "pilot_daily_cap_reached",
    ]);
  });

  test("the four gates emit thirty-one codes and this suite sees all of them", () => {
    // 9 + 4 + 17 + 3 members, less the two values two gates share:
    // `outside_calling_hours` (policy + compliance) and `country_not_allowed`
    // (policy + abuse geo).
    expect(emittedCodes()).toHaveLength(31);
    expect(emittedCodes()).toContain("destination_cooldown");
    expect(emittedCodes()).toContain("prayer_time");
    expect(emittedCodes()).toContain("consent_invalid");
    expect(emittedCodes()).toContain("pilot_daily_cap_reached");
    expect(emittedCodes()).toContain("pilot_signal_kind_out_of_scope");
    expect(emittedCodes()).toContain("pilot_cap_misconfigured");
    // The two codes deleted with the unreachable steps must not come back.
    expect(emittedCodes()).not.toContain("cooldown");
    expect(emittedCodes()).not.toContain("concurrency_cap");
  });

  test("the full emitted set is pinned literally, in sorted order", () => {
    expect(emittedCodes().sort()).toEqual([
      "consent_invalid",
      "country_denied",
      "country_not_allowed",
      "country_unparseable",
      "country_unresolvable",
      "credits_exhausted",
      "demo_tier_requires_test_number",
      "destination_cooldown",
      "destination_prefix_denied",
      "do_not_call",
      "geo_allowlist_misconfigured",
      "geo_allowlist_unconfigured",
      "global_concurrency_cap",
      "guard_internal_error",
      "invalid_call_category",
      "invalid_e164",
      "org_auto_paused",
      "org_concurrency_cap",
      "outside_calling_hours",
      "pilot_cap_misconfigured",
      "pilot_daily_cap_reached",
      "pilot_signal_kind_out_of_scope",
      "prayer_time",
      "redaction_mismatch",
      "spend_ceiling",
      "subscription_paused",
      "test_number_list_empty",
      "transaction_repeat",
      "velocity_after_hours",
      "velocity_burst_rate",
      "velocity_new_prefix_burst",
    ]);
  });

  test("no refusal returns a computed code, so the literal scan is exhaustive", () => {
    for (const [name, source] of REFUSAL_EMITTERS) {
      const computed = [...source.matchAll(/code:\s*(?!")[A-Za-z_$][\w$.]*/g)].filter(
        (m) => !m[0].startsWith("code: string"),
      );
      expect(
        computed.map((m) => m[0]),
        `${name} returns a non-literal code`,
      ).toEqual([]);
    }
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

  test("each gate's declared list matches that gate, not just the union", () => {
    // The union check above cannot tell which gate a declared code came from, so a
    // code moved between lists would still pass. These three pin the provenance.
    // The declared tuples are literal-union typed and the scans return `string[]`,
    // so the declared side is widened: the assertion is set equality either way, and
    // narrowing the scanned side would mean trusting the scan to know the vocabulary
    // — which is the thing under test.
    expect([...(ABUSE_REFUSAL_CODES as readonly string[])].sort()).toEqual(
      [...new Set(abuseGateCodes().filter((c) => c !== "country_not_allowed"))].sort(),
    );
    expect([...(COMPLIANCE_REFUSAL_CODES as readonly string[])].sort()).toEqual(
      [...new Set(proceduralCodes(COMPLIANCE).filter((c) => c !== "outside_calling_hours"))].sort(),
    );
    // The pilot gate's two causes are declared in their OWN list, so a code
    // moved between the pilot list and the union is caught here rather than
    // only showing up as a set difference.
    expect([...(PILOT_REFUSAL_CODES as readonly string[])].sort()).toEqual(
      [...proceduralCodes(PILOT)].sort(),
    );
    expect(PILOT_REFUSAL_CODES).not.toContain("outside_calling_hours");
    // `country_not_allowed` is emitted by the policy gate AND the abuse gate's geo
    // control, and `outside_calling_hours` by the policy gate AND the compliance
    // gate. Both are declared once, in the policy-gate half of the accepted set.
    expect(POLICY_REFUSAL_CODES).toContain("country_not_allowed");
    expect(POLICY_REFUSAL_CODES).toContain("outside_calling_hours");
    expect(new Set(POLICY_REFUSAL_CODES).size).toBe(POLICY_REFUSAL_CODES.length);
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
    expect(() => policyRefusal({ ok: false, code: "cooldown", reason: "x" })).toThrow(RangeError);
  });

  test("an abuse refusal is accepted by the sanctioned constructor, at 409", () => {
    // The whole point of declaring the abuse vocabulary: a route mapping a
    // geography, cooldown, cap or breaker refusal through `policyRefusal` must get
    // a 409, not a `RangeError` that surfaces as a 500 telling the bank to retry a
    // decision that will be refused again.
    for (const code of ABUSE_REFUSAL_CODES) {
      const failure = policyRefusal({ ok: false, code, reason: `abuse mapping: ${code}` });
      expect(failure.status, code).toBe(409);
      expect(failure.body.code, code).toBe("policy_precondition");
      expect(failure.body.retryable, code).toBe(false);
    }
    for (const code of COMPLIANCE_REFUSAL_CODES) {
      expect(policyRefusal({ ok: false, code, reason: `x` }).status, code).toBe(409);
    }
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

  test("the registry contains no orphan gate row for a code the gates stopped emitting", () => {
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
    // And the reverse, against the specific regression this file was written for:
    // no `gate_*` ingest row may outlive the cause that emits it. A row is alive if
    // a gate returns the literal as `code` OR a route names it in a `detail`.
    const reachable = new Set([...emittedCodes(), ...routeDetailCauses()]);
    expect(routeDetailCauses().length, "the route detail scan found nothing").toBeGreaterThan(0);
    for (const row of gateRows) {
      expect(
        reachable.has(row.literal!),
        `${row.id} documents ${row.literal}, which no gate emits and no route names`,
      ).toBe(true);
    }
  });
});
