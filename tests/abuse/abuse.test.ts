/**
 * WP-14: abuse and toll fraud — the dial gate.
 *
 * Proves, control by control:
 *   1. geography — a country outside the org allowlist is refused with a typed
 *      reason, and the denylist (the inverse) beats a widened allowlist;
 *   2. plan tier — the demo tier cannot dial an unverified number and CAN dial
 *      a listed test number;
 *   3. concurrency — the org cap and the global cap hold under a burst of 50
 *      attempts, and the observed maximum never exceeds the cap;
 *   4. the breaker — it trips, auto-pauses the org, and a paused org STAYS
 *      paused;
 *   5. velocity — a new-destination-prefix burst auto-pauses.
 *
 *   bun test tests/abuse/abuse.test.ts
 *
 * No database, no network, no clock: every attempt carries an explicit `at`, so
 * every window in this suite is deterministic and the assertions are about the
 * controls rather than about timing luck.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { DEFAULT_ABUSE_CONFIG, resetAbuseConfig, setAbuseConfig } from "@/lib/abuse/config";
import {
  checkDestinationGeo,
  clearOrgGeoPolicies,
  destinationPrefix,
  maskE164,
  normaliseE164,
  setCountryResolver,
  setOrgGeoPolicy,
  type GeoDecision,
  type GeoRejectReason,
} from "@/lib/abuse/geo";
import {
  checkPlanTier,
  clearOrgTestNumbers,
  isTestNumber,
  setOrgTestNumbers,
} from "@/lib/abuse/tiers";
import {
  evaluate,
  isOrgPaused,
  pausedOrgs,
  recentAlerts,
  recordAttempt,
  resetVelocityState,
  resumeOrg,
  setAlertSink,
  type AbuseAlert,
  type VelocityVerdict,
} from "@/lib/abuse/velocity";
import {
  assertDialAllowed,
  dialStateSnapshot,
  releaseDialSlot,
  resetDialState,
  type ControlName,
  type ControlOutcome,
} from "@/lib/abuse/guards";

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

/** In-hours UTC instant (10:00) and an out-of-hours one (03:00). */
const T_IN_HOURS = Date.UTC(2026, 0, 15, 10, 0, 0);
const T_AFTER_HOURS = Date.UTC(2026, 0, 15, 3, 0, 0);

/** AE mobile numbers, each in a distinct block so they are distinct prefixes. */
const AE_50 = "+971501234567";
const AE_52 = "+971521234567";
const AE_55 = "+971551234567";
const AE_56 = "+971561234567";

const alerts: AbuseAlert[] = [];

beforeEach(() => {
  resetAbuseConfig();
  clearOrgGeoPolicies();
  clearOrgTestNumbers();
  resetVelocityState();
  resetDialState();
  setCountryResolver(null);
  alerts.length = 0;
  setAlertSink((a) => alerts.push(a));
  // Base fixture: AE/GB/US diallable, generous caps, velocity effectively off
  // so that each test can assert on its own control rather than tripping a
  // breaker set up for another test.
  setAbuseConfig({
    geo: { ...DEFAULT_ABUSE_CONFIG.geo, allowlist: ["AE", "GB", "US"] },
    tier: { testNumbers: [] },
    velocity: {
      ...DEFAULT_ABUSE_CONFIG.velocity,
      burstRateMax: 1000,
      newPrefixBurst: 1000,
      afterHoursWarn: 1000,
      afterHoursPause: 1001,
    },
    concurrency: {
      ...DEFAULT_ABUSE_CONFIG.concurrency,
      orgCap: 3,
      globalCap: 50,
      cooldownSec: 300,
    },
  });
});

afterEach(() => {
  setAlertSink(null);
});

/** Look up one control's outcome, so each control can be asserted on its own. */
const controlOf = (
  controls: readonly ControlOutcome[],
  name: ControlName,
): ControlOutcome | undefined => controls.find((c) => c.control === name);

/** The rejection reason of a geo decision, or null when it passed. */
const geoReason = (d: GeoDecision): GeoRejectReason | null => (d.ok ? null : d.reason);

/* ── 1. Geography ─────────────────────────────────────────────────────────── */

test("geo: a disallowed country is refused at the gate with a typed reason", () => {
  // Org is allowed AE + GB only.
  setOrgGeoPolicy("org-geo", { allowlist: ["AE", "GB"] });

  const d = assertDialAllowed({
    orgId: "org-geo",
    e164: "+819012345678", // JP
    planTier: "standard",
    at: T_IN_HOURS,
  });

  expect(d.allowed).toBe(false);
  expect(d.verdict).toBe("deny");
  expect(d.reason).toBe("country_not_allowed");
  expect(d.country).toBe("JP");
  expect(controlOf(d.controls, "geo")?.ok).toBe(false);
  expect(controlOf(d.controls, "geo")?.reason).toBe("country_not_allowed");
  // Fail-fast: later controls did not run, and the earlier ones did.
  expect(controlOf(d.controls, "input_shape")?.ok).toBe(true);
  expect(controlOf(d.controls, "geo")).toBeDefined();
  expect(controlOf(d.controls, "plan_tier")).toBeUndefined();
  // No raw destination digits in a human-readable string.
  expect(d.detail).not.toContain("9012345678");
  expect(d.detail).toContain("JP");
});

test("geo: an allowlisted country passes the geo control", () => {
  setOrgGeoPolicy("org-geo", { allowlist: ["AE", "GB"] });
  const d = assertDialAllowed({
    orgId: "org-geo",
    e164: "+447700900123",
    planTier: "standard",
    at: T_IN_HOURS,
  });
  expect(controlOf(d.controls, "geo")?.ok).toBe(true);
  expect(d.country).toBe("GB");
  expect(d.allowed).toBe(true);
  releaseDialSlot(d.slot);
});

test("geo: the denylist beats a widened allowlist (the inverse control)", () => {
  // The exact failure the inverse exists to stop: someone adds RU to the
  // allowlist "for a customer" and the platform can now dial RU.
  setOrgGeoPolicy("org-wide", { allowlist: ["AE", "RU", "IR"] });

  const ru = assertDialAllowed({
    orgId: "org-wide",
    e164: "+79161234567",
    planTier: "standard",
    at: T_IN_HOURS,
  });
  expect(ru.reason).toBe("country_denied");
  expect(ru.country).toBe("RU");

  const ir = assertDialAllowed({
    orgId: "org-wide",
    e164: "+989121234567",
    planTier: "standard",
    at: T_IN_HOURS,
  });
  expect(ir.reason).toBe("country_denied");
});

test("geo: no allowlist configured means nothing is diallable", () => {
  setAbuseConfig({ geo: { allowlist: [] } });
  const d = assertDialAllowed({
    orgId: "org-none",
    e164: AE_50,
    planTier: "standard",
    at: T_IN_HOURS,
  });
  expect(d.reason).toBe("geo_allowlist_unconfigured");
});

test("geo: a wildcard allowlist is refused by design", () => {
  setOrgGeoPolicy("org-star", { allowlist: ["*"] });
  const d = assertDialAllowed({
    orgId: "org-star",
    e164: AE_50,
    planTier: "standard",
    at: T_IN_HOURS,
  });
  expect(d.reason).toBe("geo_allowlist_misconfigured");
});

test("geo: premium / shared-cost service ranges are refused by prefix", () => {
  const d = assertDialAllowed({
    orgId: "org-geo",
    e164: "+800123456789",
    planTier: "standard",
    at: T_IN_HOURS,
  });
  expect(d.reason).toBe("destination_prefix_denied");
});

test("geo: country resolution is offline, deterministic and injectable", () => {
  setOrgGeoPolicy("org-geo", { allowlist: ["AE", "FR", "GB"] });
  // Default prefix resolver: deterministic, no network.
  expect(checkDestinationGeo({ e164: AE_50, orgId: "org-geo" })).toMatchObject({
    ok: true,
    country: "AE",
  });
  // An unassigned calling code resolves to nothing rather than guessing.
  expect(geoReason(checkDestinationGeo({ e164: "+99912345678", orgId: "org-geo" }))).toBe(
    "country_unresolvable",
  );

  // Injected resolver replaces the table entirely (a carrier/lookup feed).
  setCountryResolver((e164) => (e164.startsWith("+999") ? "FR" : null));
  const injected = checkDestinationGeo({ e164: "+99912345678", orgId: "org-geo" });
  expect(injected).toMatchObject({ ok: true, country: "FR" });

  // Per-call resolver wins over the installed one.
  expect(
    checkDestinationGeo({ e164: "+99912345678", orgId: "org-geo", resolver: () => "GB" }).ok,
  ).toBe(true);
});

test("geo: a throwing resolver denies the dial instead of the request", () => {
  setCountryResolver(() => {
    throw new Error("resolver backend down");
  });
  const d = assertDialAllowed({
    orgId: "org-geo",
    e164: AE_50,
    planTier: "standard",
    at: T_IN_HOURS,
  });
  expect(d.allowed).toBe(false);
  expect(d.reason).toBe("country_unresolvable");
});

test("geo: E.164 canonicalisation and masking", () => {
  expect(normaliseE164("+971 50 123 4567")).toBe("+971501234567");
  expect(normaliseE164("00971501234567")).toBe("+971501234567");
  expect(normaliseE164("+971-50-123-4567")).toBe("+971501234567");
  expect(normaliseE164("12345")).toBeNull();
  expect(normaliseE164("+0123456")).toBeNull(); // leading zero is not a calling code
  expect(maskE164(AE_50)).toBe("+971****4567");
  expect(maskE164("not-a-number")).toBe("[invalid-number]");
  expect(destinationPrefix(AE_50)).toBe("+97150");
});

/* ── 2. Plan tier ─────────────────────────────────────────────────────────── */

test("tier: the demo tier cannot dial an unverified number", () => {
  setOrgTestNumbers("org-demo", [AE_50]);

  const unverified = assertDialAllowed({
    orgId: "org-demo",
    e164: AE_52,
    planTier: "demo",
    at: T_IN_HOURS,
  });
  expect(unverified.allowed).toBe(false);
  expect(unverified.verdict).toBe("deny");
  expect(unverified.reason).toBe("demo_tier_requires_test_number");
  expect(controlOf(unverified.controls, "plan_tier")?.reason).toBe(
    "demo_tier_requires_test_number",
  );
  // Geo passed first, so the failure is attributed to the tier, not geography.
  expect(controlOf(unverified.controls, "geo")?.ok).toBe(true);
  expect(unverified.detail).not.toContain("521234567");
});

test("tier: the demo tier CAN dial a listed test number", () => {
  setOrgTestNumbers("org-demo", [AE_50]);
  const d = assertDialAllowed({ orgId: "org-demo", e164: AE_50, planTier: "demo", at: T_IN_HOURS });
  expect(d.allowed).toBe(true);
  expect(d.verdict).toBe("allow");
  expect(d.reason).toBe("ok");
  expect(controlOf(d.controls, "plan_tier")?.detail).toContain("verified test number");
  releaseDialSlot(d.slot);
});

test("tier: the demo tier dials nothing when no list is configured (fail closed)", () => {
  setAbuseConfig({ tier: { testNumbers: [] } });
  const d = assertDialAllowed({
    orgId: "org-nolist",
    e164: AE_50,
    planTier: "demo",
    at: T_IN_HOURS,
  });
  expect(d.reason).toBe("test_number_list_empty");
});

test("tier: a per-org list overrides the global list", () => {
  setAbuseConfig({ tier: { testNumbers: [AE_52] } });
  setOrgTestNumbers("org-demo", [AE_50]);
  expect(isTestNumber(AE_50, { orgId: "org-demo" })).toBe(true);
  expect(isTestNumber(AE_52, { orgId: "org-demo" })).toBe(false);
  expect(isTestNumber(AE_52, { orgId: "org-other" })).toBe(true);
  expect(isTestNumber("+971509999999", { orgId: "org-demo" })).toBe(false);
});

test("tier: prefix entries match carrier test ranges; non-demo tiers are unrestricted", () => {
  const list = ["+971 50 123 4567", "1500555*"];
  expect(isTestNumber(AE_50, { list })).toBe(true);
  expect(isTestNumber("+15005550006", { list })).toBe(true); // prefix match
  expect(isTestNumber("+15005560006", { list })).toBe(false);
  expect(isTestNumber("nonsense", { list })).toBe(false);
  // Degenerate entries cannot match everything.
  expect(isTestNumber(AE_50, { list: ["*", "+", ""] })).toBe(false);

  // standard tier is not restricted by THIS control (geo/caps still apply).
  expect(checkPlanTier({ e164: AE_52, tier: "standard", orgId: "org-demo", list: [] })).toEqual({
    ok: true,
    restricted: false,
  });
  // An unset tier is treated as the strictest one.
  expect(checkPlanTier({ e164: AE_52, tier: null, orgId: "org-demo", list: [] }).ok).toBe(false);
});

/* ── 3. Concurrency caps ──────────────────────────────────────────────────── */

test("concurrency: the org cap holds under a burst of 50 attempts", () => {
  const CAP = 3;
  setAbuseConfig({
    concurrency: {
      ...DEFAULT_ABUSE_CONFIG.concurrency,
      orgCap: CAP,
      globalCap: 1000,
      cooldownSec: 300,
    },
  });

  // The gate is synchronous, so "concurrent" here is the strongest possible
  // form of the test: 50 attempts inside ONE tick of the event loop, with no
  // interleaving. If anyone ever adds an await to the gate path, this loop
  // starts interleaving and the cap assertion below is what catches it.
  const decisions = Array.from({ length: 50 }, (_, i) =>
    assertDialAllowed({
      orgId: "org-burst",
      e164: `+9715${String(1000000 + i).slice(0, 7)}`, // 50 distinct AE destinations
      planTier: "standard",
      at: T_IN_HOURS + i,
    }),
  );

  const allowed = decisions.filter((d) => d.allowed);
  const denied = decisions.filter((d) => !d.allowed);
  expect(allowed).toHaveLength(CAP);
  expect(denied).toHaveLength(50 - CAP);
  expect(new Set(denied.map((d) => d.reason))).toEqual(new Set(["org_concurrency_cap"]));

  // The observed maximum never exceeded the cap at any point in the burst.
  let maxObserved = 0;
  for (const d of decisions) maxObserved = Math.max(maxObserved, d.active.org);
  expect(maxObserved).toBeLessThanOrEqual(CAP);
  expect(dialStateSnapshot().activeByOrg["org-burst"]).toBe(CAP);
  expect(dialStateSnapshot().outstandingSlots).toBe(CAP);

  // Slots are handed back → capacity returns. Without this, the cap would be a
  // one-way ratchet and the platform would wedge itself after CAP dials.
  for (const d of allowed) releaseDialSlot(d.slot);
  expect(dialStateSnapshot().activeByOrg["org-burst"]).toBeUndefined();
  expect(dialStateSnapshot().outstandingSlots).toBe(0);

  const afterRelease = assertDialAllowed({
    orgId: "org-burst",
    e164: AE_50,
    planTier: "standard",
    at: T_IN_HOURS,
  });
  expect(afterRelease.allowed).toBe(true);
  releaseDialSlot(afterRelease.slot);
});

test("concurrency: the global cap holds across organisations", () => {
  const GLOBAL_CAP = 4;
  setAbuseConfig({
    concurrency: {
      ...DEFAULT_ABUSE_CONFIG.concurrency,
      orgCap: 100,
      globalCap: GLOBAL_CAP,
      cooldownSec: 300,
    },
  });

  const decisions = Array.from({ length: 50 }, (_, i) =>
    assertDialAllowed({
      orgId: `org-${i % 10}`, // ten orgs, so the ORG cap cannot be what fires
      e164: `+9715${String(1000000 + i).slice(0, 7)}`,
      planTier: "standard",
      at: T_IN_HOURS + i,
    }),
  );

  expect(decisions.filter((d) => d.allowed)).toHaveLength(GLOBAL_CAP);
  expect(new Set(decisions.filter((d) => !d.allowed).map((d) => d.reason))).toEqual(
    new Set(["global_concurrency_cap"]),
  );

  let maxGlobal = 0;
  let maxOrg = 0;
  for (const d of decisions) {
    maxGlobal = Math.max(maxGlobal, d.active.global);
    maxOrg = Math.max(maxOrg, d.active.org);
  }
  expect(maxGlobal).toBeLessThanOrEqual(GLOBAL_CAP);
  expect(maxOrg).toBeLessThanOrEqual(GLOBAL_CAP); // no org exceeded the platform cap
  expect(dialStateSnapshot().activeGlobalCalls).toBe(GLOBAL_CAP);
});

test("cooldown: per destination and per organisation, and it expires", () => {
  const d1 = assertDialAllowed({
    orgId: "org-a",
    e164: AE_50,
    planTier: "standard",
    at: T_IN_HOURS,
  });
  expect(d1.allowed).toBe(true);

  const d2 = assertDialAllowed({
    orgId: "org-a",
    e164: AE_50,
    planTier: "standard",
    at: T_IN_HOURS + 1000,
  });
  expect(d2.reason).toBe("destination_cooldown");
  expect(controlOf(d2.controls, "cooldown")?.reason).toBe("destination_cooldown");
  expect(d2.detail).not.toContain("501234567");

  // Org-scoped: org-b's guard must not deny org-a's dial (policy-gate keys
  // cooldown globally, which lets one tenant deny another).
  const other = assertDialAllowed({
    orgId: "org-b",
    e164: AE_50,
    planTier: "standard",
    at: T_IN_HOURS + 1000,
  });
  expect(other.allowed).toBe(true);
  releaseDialSlot(other.slot);

  // Expires.
  const later = assertDialAllowed({
    orgId: "org-a",
    e164: AE_50,
    planTier: "standard",
    at: T_IN_HOURS + 301_000,
  });
  expect(later.allowed).toBe(true);
  releaseDialSlot(later.slot);
});

/* ── 4 & 5. Velocity, the breaker, and auto-pause ─────────────────────────── */

test("velocity: a new-destination-prefix burst auto-pauses the organisation", () => {
  const base = {
    ...DEFAULT_ABUSE_CONFIG.velocity,
    burstRateMax: 1000,
    newPrefixWindowSec: 900,
    newPrefixBurst: 3,
  };
  setAbuseConfig({ velocity: base });

  const first = assertDialAllowed({
    orgId: "org-spray",
    e164: AE_50,
    planTier: "standard",
    at: T_IN_HOURS,
  });
  expect(first.allowed).toBe(true);
  releaseDialSlot(first.slot);

  const second = assertDialAllowed({
    orgId: "org-spray",
    e164: AE_52,
    planTier: "standard",
    at: T_IN_HOURS + 1000,
  });
  expect(second.allowed).toBe(true);
  releaseDialSlot(second.slot);

  // Third previously-unseen prefix inside the window → the breaker trips.
  const third = assertDialAllowed({
    orgId: "org-spray",
    e164: AE_55,
    planTier: "standard",
    at: T_IN_HOURS + 2000,
  });
  expect(third.allowed).toBe(false);
  expect(third.verdict).toBe("auto_pause");
  expect(third.reason).toBe("velocity_new_prefix_burst");
  expect(third.velocitySignals).toContain("new_destination_prefix");
  expect(controlOf(third.controls, "velocity")?.reason).toBe("velocity_new_prefix_burst");
  // The slot taken earlier in this same call is handed back — a paused org
  // holds no capacity.
  expect(dialStateSnapshot().outstandingSlots).toBe(0);
});

test("breaker: a paused organisation stays paused, and re-alerts nothing", () => {
  setAbuseConfig({
    velocity: {
      ...DEFAULT_ABUSE_CONFIG.velocity,
      burstRateMax: 1000,
      newPrefixWindowSec: 900,
      newPrefixBurst: 2,
    },
  });

  recordAttempt({ orgId: "org-brk", e164: AE_50, at: T_IN_HOURS });
  recordAttempt({ orgId: "org-brk", e164: AE_52, at: T_IN_HOURS + 1000 });
  const tripped = evaluate({ orgId: "org-brk", at: T_IN_HOURS + 2000 });
  expect(tripped.action).toBe("auto_pause");
  expect(tripped.reason).toBe("velocity_new_prefix_burst");
  expect(tripped.alreadyPaused).toBe(false);
  expect(isOrgPaused("org-brk", T_IN_HOURS + 2000)).toBe(true);
  expect(pausedOrgs(T_IN_HOURS + 2000).map((p) => p.orgId)).toEqual(["org-brk"]);

  // One typed alert, with a masked detail line and the org still attached.
  const pauseAlerts = alerts.filter((a) => a.action === "auto_pause");
  expect(pauseAlerts.map((a) => a.orgId)).toEqual(["org-brk"]);
  expect(pauseAlerts.map((a) => a.reason)).toEqual(["velocity_new_prefix_burst"]);
  expect(pauseAlerts.some((a) => a.signals.includes("new_destination_prefix"))).toBe(true);
  expect(pauseAlerts.map((a) => a.detail).join(" ")).not.toContain("501234567");
  expect(recentAlerts().length).toBe(1);

  // Still paused on the next attempt — including one to a number we have
  // dialled before, i.e. no new-prefix signal at all.
  for (const offset of [3000, 4000, 5000]) {
    const again = evaluate({ orgId: "org-brk", at: T_IN_HOURS + offset });
    expect(again.action).toBe("auto_pause");
    expect(again.reason).toBe("org_auto_paused");
    expect(again.alreadyPaused).toBe(true);
  }
  // A paused org is refused at the gate before any other control runs.
  const gated = assertDialAllowed({
    orgId: "org-brk",
    e164: AE_50,
    planTier: "standard",
    at: T_IN_HOURS + 6000,
  });
  expect(gated.allowed).toBe(false);
  expect(gated.verdict).toBe("auto_pause");
  expect(gated.reason).toBe("org_auto_paused");
  expect(controlOf(gated.controls, "breaker")?.ok).toBe(false);
  expect(controlOf(gated.controls, "geo")).toBeUndefined();
  // One alert, still — a flood of alerts is how a real one gets ignored.
  expect(alerts.filter((a) => a.action === "auto_pause")).toHaveLength(1);

  // Only a human closes the breaker — and the org stays paused until one does,
  // not until some cooldown quietly expires it.
  expect(resumeOrg("org-brk")).toBe(true);
  // Resumed just past the 900 s new-prefix window: the spray is now history
  // rather than a live anomaly, so this is a clean dial again. (Resumed while
  // the window is still open it re-trips, which is the intended behaviour —
  // resuming does not launder an ongoing anomaly.)
  const resumed = assertDialAllowed({
    orgId: "org-brk",
    e164: AE_50,
    planTier: "standard",
    at: T_IN_HOURS + 901_000,
  });
  expect(resumed.allowed).toBe(true);
  releaseDialSlot(resumed.slot);
});

test("velocity: burst rate auto-pauses on attempt volume alone", () => {
  setAbuseConfig({
    velocity: {
      ...DEFAULT_ABUSE_CONFIG.velocity,
      burstWindowSec: 60,
      burstRateMax: 5,
      newPrefixBurst: 1000,
    },
  });
  const org = "org-burst-rate";
  const verdicts: VelocityVerdict[] = [];
  for (let i = 0; i < 5; i++) {
    recordAttempt({ orgId: org, e164: `+44770090010${i}`, at: T_IN_HOURS + i }); // same prefix
    verdicts.push(evaluate({ orgId: org, at: T_IN_HOURS + i }));
  }
  // The fifth attempt inside the 60 s window trips it; the first four do not.
  expect(verdicts.map((v) => v.action)).toEqual(["allow", "allow", "allow", "allow", "auto_pause"]);
  expect(verdicts.map((v) => v.reason)).toEqual([null, null, null, null, "velocity_burst_rate"]);
  expect(verdicts.map((v) => v.metrics.burstAttempts)).toEqual([1, 2, 3, 4, 5]);

  // The same volume outside the burst window is unremarkable: the window moves,
  // the history does not.
  const calm = "org-burst-rate-calm";
  for (let i = 0; i < 4; i++)
    recordAttempt({ orgId: calm, e164: `+44770090020${i}`, at: T_IN_HOURS + i });
  expect(evaluate({ orgId: calm, at: T_IN_HOURS + 3 }).action).toBe("allow");
  // A minute and a second later the same four attempts are outside the 60s
  // window: still in history, no longer a burst.
  expect(evaluate({ orgId: calm, at: T_IN_HOURS + 60_064 }).metrics.burstAttempts).toBe(0);
  expect(evaluate({ orgId: calm, at: T_IN_HOURS + 60_064 }).metrics.windowAttempts).toBe(4);
  expect(evaluate({ orgId: calm, at: T_IN_HOURS + 60_064 }).action).toBe("allow");
});

test("velocity: out-of-hours volume warns first, then auto-pauses", () => {
  setAbuseConfig({
    velocity: {
      ...DEFAULT_ABUSE_CONFIG.velocity,
      burstRateMax: 1000,
      newPrefixBurst: 1000,
      afterHoursWarn: 3,
      afterHoursPause: 5,
    },
  });
  const org = "org-night";
  const actions: string[] = [];
  for (let i = 0; i < 5; i++) {
    recordAttempt({ orgId: org, e164: `+9715${5000000 + i}`, at: T_AFTER_HOURS + i });
    actions.push(evaluate({ orgId: org, at: T_AFTER_HOURS + i }).action);
  }
  // Two quiet attempts, then warns, then a pause once the hard threshold is hit.
  expect(actions).toEqual(["allow", "allow", "warn", "warn", "auto_pause"]);
  const warnAlerts = alerts.filter((a) => a.action === "warn");
  expect(warnAlerts.length).toBeGreaterThanOrEqual(1);
  expect(warnAlerts.map((a) => a.reason)).toContain("velocity_after_hours");
  expect(isOrgPaused(org, T_AFTER_HOURS + 5)).toBe(true);
});

test("velocity: a warned attempt is still allowed through the gate", () => {
  setAbuseConfig({
    velocity: {
      ...DEFAULT_ABUSE_CONFIG.velocity,
      burstRateMax: 1000,
      newPrefixBurst: 1000,
      afterHoursWarn: 1,
      afterHoursPause: 50,
    },
  });
  const d = assertDialAllowed({
    orgId: "org-night-2",
    e164: AE_50,
    planTier: "standard",
    at: T_AFTER_HOURS,
  });
  expect(d.allowed).toBe(true);
  expect(d.verdict).toBe("warn");
  expect(d.reason).toBe("velocity_after_hours");
  expect(d.velocitySignals).toContain("out_of_hours_volume");
  expect(d.slot).not.toBeNull();
  releaseDialSlot(d.slot);
});

test("velocity: refused attempts never feed the anomaly counters", () => {
  // JP is geo-blocked. A scan of geo-blocked numbers must not be able to
  // auto-pause a healthy org — that is a self-inflicted DoS, and the fastest
  // way to get this control switched off.
  setAbuseConfig({
    velocity: { ...DEFAULT_ABUSE_CONFIG.velocity, burstRateMax: 3, newPrefixBurst: 3 },
  });
  for (let i = 0; i < 20; i++) {
    const d = assertDialAllowed({
      orgId: "org-scan",
      e164: `+81901234567${i % 10}`,
      planTier: "standard",
      at: T_IN_HOURS + i,
    });
    expect(d.reason).toBe("country_not_allowed");
  }
  expect(isOrgPaused("org-scan", T_IN_HOURS + 20)).toBe(false);
  expect(dialStateSnapshot().velocity.attemptsTracked).toBe(0);
  expect(dialStateSnapshot().velocity.pausedOrgs).toBe(0);
});

/* ── Gate contract ────────────────────────────────────────────────────────── */

test("gate: the decision object is complete and machine-readable", () => {
  setOrgTestNumbers("org-shape", [AE_50]);
  const d = assertDialAllowed({
    orgId: "org-shape",
    e164: AE_50,
    planTier: "demo",
    at: T_IN_HOURS,
  });

  expect(d.allowed).toBe(true);
  expect(d.verdict).toBe("allow");
  expect(d.reason).toBe("ok");
  expect(d.country).toBe("AE");
  expect(typeof d.detail).toBe("string");
  expect(d.detail).not.toContain("501234567");
  expect(d.slot).toBeTypeOf("number");
  expect(d.controls.map((c) => c.control)).toEqual([
    "input_shape",
    "breaker",
    "geo",
    "plan_tier",
    "cooldown",
    "org_concurrency",
    "global_concurrency",
    "velocity",
  ]);
  for (const c of d.controls) {
    expect(c.ok).toBe(true);
    expect(c.reason).toBe("ok");
  }
  releaseDialSlot(d.slot);
});

test("gate: malformed input is refused with a typed reason, never a throw", () => {
  const bad = assertDialAllowed({
    orgId: "org-shape",
    e164: "+971 50",
    planTier: "demo",
    at: T_IN_HOURS,
  });
  expect(bad.allowed).toBe(false);
  expect(bad.reason).toBe("invalid_e164");
  expect(bad.slot).toBeNull();

  const noOrg = assertDialAllowed({ orgId: "", e164: AE_50, planTier: "demo", at: T_IN_HOURS });
  expect(noOrg.allowed).toBe(false);
  expect(noOrg.reason).toBe("invalid_e164");

  // Garbage in the tier field is coerced to the strictest tier, not trusted.
  setOrgTestNumbers("org-shape", [AE_50]);
  const oddTier = assertDialAllowed({
    orgId: "org-shape",
    e164: AE_52,
    planTier: { hijack: true } as unknown as string,
    at: T_IN_HOURS,
  });
  expect(oddTier.reason).toBe("demo_tier_requires_test_number");
});

test("gate: state helpers bound themselves and stay inspectable", () => {
  setAbuseConfig({
    concurrency: { ...DEFAULT_ABUSE_CONFIG.concurrency, orgCap: 2, globalCap: 2, cooldownSec: 0 },
  });
  for (let i = 0; i < 20; i++) {
    assertDialAllowed({ orgId: `org-x${i}`, e164: AE_50, planTier: "standard", at: T_IN_HOURS });
  }
  const snap = dialStateSnapshot();
  expect(snap.activeGlobalCalls).toBe(2); // never exceeded the global cap
  expect(snap.outstandingSlots).toBe(2);
  expect(snap.velocity.thresholds).toMatchObject({ burstRateMax: expect.any(Number) });
  expect(snap.velocity.scope).toContain("single node");
  resetDialState();
  expect(dialStateSnapshot().activeGlobalCalls).toBe(0);
});
