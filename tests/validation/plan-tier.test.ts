/**
 * AUDIT FIX — `planTier` was never passed to the dial gate.
 *
 * `assertDialAllowed` defaults an unset `planTier` to `demo`, the STRICTEST
 * tier, so the default fails closed. That is right for the guard and wrong for
 * a route that simply forgets the argument: `POST /v1/interventions` passed only
 * `orgId` and `e164`, so every live bank signal was evaluated as a DEMO tenant
 * and refused with `demo_tier_requires_test_number` unless the destination
 * happened to be on a verified test-number list. A demo tier with an empty list
 * refuses everything, so this refuses legitimate production dials outright.
 *
 * `planTierFor()` is the resolver that gives the org its real tier, following
 * the same env/programmatic persistence the rest of WP-14 already uses (there is
 * no per-org policy table in this schema).
 *
 * No database, no network:
 *   bun test tests/validation/plan-tier.test.ts
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { setOrgGeoPolicy } from "@/lib/abuse/geo";
import { clearOrgPlanTiers, clearOrgTestNumbers, planTierFor, setOrgPlanTier, setOrgTestNumbers } from "@/lib/abuse/tiers";
import { resetAbuseConfig, setAbuseConfig } from "@/lib/abuse/config";
import { assertDialAllowed, releaseDialSlot } from "@/lib/abuse/guards";

/** A well-formed UAE destination that is deliberately NOT a test number. */
const REAL_AE_NUMBER = "+971509876543";
const T = Date.parse("2026-06-01T10:00:00Z");

beforeEach(() => {
  // Geography and the demo list are registered explicitly, exactly as an
  // operator does before a rehearsal: the gate is fail-closed with neither.
  setOrgGeoPolicy("org-acme", { allowlist: ["AE"] });
  setAbuseConfig({ velocity: { burstRateMax: 1000, newPrefixBurst: 1000 } });
});

afterEach(() => {
  clearOrgPlanTiers();
  clearOrgTestNumbers();
  resetAbuseConfig();
});

// ── The resolver ─────────────────────────────────────────────────────────────

test("planTierFor: an unconfigured org is still demo — the fail-closed default is unchanged", () => {
  expect(planTierFor("org-nobody")).toBe("demo");
  expect(planTierFor(null)).toBe("demo");
  expect(planTierFor("")).toBe("demo");
});

test("planTierFor: a registered non-demo tier reaches the gate instead of demo", () => {
  setOrgPlanTier("org-acme", "standard");
  expect(planTierFor("org-acme")).toBe("standard");
  // Org isolation: one org's tier must not leak to another.
  expect(planTierFor("org-other")).toBe("demo");
});

test("planTierFor: per-org env ABUSE_PLAN_TIER__<ORG> is honoured, and beats nothing higher", () => {
  process.env.ABUSE_PLAN_TIER__ORG_ENVED = "enterprise";
  try {
    expect(planTierFor("org-enved")).toBe("enterprise");
  } finally {
    delete process.env.ABUSE_PLAN_TIER__ORG_ENVED;
  }
});

test("planTierFor: a garbage tier is rejected, not silently coerced to demo", () => {
  // The failure this prevents: an operator writes "Standard" into a config and
  // believes the org is unrestricted, while the registry quietly stored `demo`.
  setOrgPlanTier("org-typo", "Standard");
  expect(planTierFor("org-typo")).toBe("demo");
});

test("planTierFor: an explicit override wins over the registry", () => {
  setOrgPlanTier("org-acme", "standard");
  expect(planTierFor("org-acme", "enterprise")).toBe("enterprise");
});

// ── The behaviour that actually mattered ─────────────────────────────────────

test("a non-demo org is NOT evaluated as demo: its real destination is diallable", () => {
  const org = "org-acme";
  const destination = REAL_AE_NUMBER;

  // A non-empty verified list that does NOT contain the destination: the demo
  // tier must refuse precisely because THIS number is unverified. An empty list
  // refuses too, but for the different reason `test_number_list_empty`, which
  // would not isolate the tier decision being tested.
  setOrgTestNumbers(org, ["+971500000001"]);

  // The bug: the route passed no tier, so the org was evaluated as `demo`.
  const asDemo = assertDialAllowed({ orgId: org, e164: destination, at: T });
  expect(asDemo.allowed).toBe(false);
  expect(asDemo.reason).toBe("demo_tier_requires_test_number");

  // The fix: the org's real tier reaches the gate.
  setOrgPlanTier(org, "standard");
  const asStandard = assertDialAllowed({
    orgId: org,
    e164: destination,
    at: T,
    planTier: planTierFor(org),
  });
  expect(asStandard.allowed).toBe(true);
  expect(asStandard.verdict).toBe("allow");
  if (asStandard.slot !== null) releaseDialSlot(asStandard.slot);
});

test("a demo org is still refused, and the fix does not widen the demo tier", () => {
  const org = "org-demo-shop";
  setOrgGeoPolicy(org, { allowlist: ["AE"] });
  setOrgTestNumbers(org, ["+971500000001"]);

  // No tier declared anywhere → still demo → still refuses the real number.
  const d = assertDialAllowed({
    orgId: org,
    e164: REAL_AE_NUMBER,
    planTier: planTierFor(org),
  });
  expect(d.allowed).toBe(false);
  expect(d.reason).toBe("demo_tier_requires_test_number");
});

test("widening the tier does not disable the OTHER controls", () => {
  // A non-demo tier relaxes exactly one control: the verified-test-number
  // restriction. Geography and the caps must still bind, or this fix would
  // have turned the tier into a licence to dial anywhere.
  const org = "org-standard-geoblocked";
  setOrgGeoPolicy(org, { allowlist: ["GB"] });
  setOrgPlanTier(org, "standard");

  const denied = assertDialAllowed({
    orgId: org,
    e164: REAL_AE_NUMBER, // AE, but the allowlist is GB
    at: T,
    planTier: planTierFor(org),
  });
  expect(denied.allowed).toBe(false);
  expect(denied.reason).toBe("country_not_allowed");

  // And the hard denylist still overrides a non-demo tier.
  setOrgGeoPolicy("org-standard-denied", { allowlist: ["*"] });
  setOrgPlanTier("org-standard-denied", "enterprise");
  const hardDenied = assertDialAllowed({
    orgId: "org-standard-denied",
    e164: "+79161234567", // RU
    at: T,
    planTier: planTierFor("org-standard-denied"),
  });
  expect(hardDenied.allowed).toBe(false);
  expect(hardDenied.reason).toBe("country_denied");
});