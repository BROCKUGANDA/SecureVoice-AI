/**
 * UNIT — the pure decision logic of `src/lib/abuse/**`.
 *
 * `tests/abuse/abuse.test.ts` drives these modules end-to-end through
 * `assertDialAllowed` against a database. That suite proves the gate composes;
 * it does not prove the primitives under it are correct, because almost every
 * one of them is reached through a path where the other controls happen to be
 * satisfied. This file drives the primitives directly, so a wrong threshold
 * shows up as a wrong threshold rather than as some downstream refusal.
 *
 * ── What is asserted, and why each property matters ─────────────────────────
 *
 * **tiers.ts — the tier lookup is a total function over a closed set.**
 * `PLAN_TIERS` is the whole domain; every member must be recognised by
 * `isPlanTier` and returned unchanged by `coercePlanTier`, and everything else
 * — a differently-cased tier, a padded one, a non-string, `null` — must land on
 * `demo`. The default is the load-bearing choice: it is the only tier that
 * cannot dial a number nobody verified, so an unrecognised tier name is a
 * typo, and a typo must not become a licence. The full tier × destination-class
 * matrix is asserted rather than sampled, because the interesting regression is
 * a tier quietly gaining a capability — `restricted: false` for `demo` on a
 * listed number would be invisible to any single spot check.
 *
 * **velocity.ts — windows are half-open `(now - window, now]`.**
 * Every threshold here is a comparison against a timestamp, so the only way to
 * catch an off-by-one is to sit exactly on the boundary: an attempt recorded
 * `window - 1 ms` ago counts and `window` ms ago does not. The boundary is
 * asserted on both sides for the burst window, the attempt window and the
 * new-prefix window. The "N events in M minutes" rule is asserted at N-1, N and
 * N+1 for each of the three signals, because these three thresholds trip at
 * different rates and a copy-paste error between them (`>=` vs `>`, or a
 * swapped pair) is invisible until it fires.
 *
 * **business hours are wrap-aware and half-open.** 06:00 is in hours, 22:00 is
 * not, and a `start > end` config means the night shift rather than an empty
 * range. All 24 hours are asserted under both a day-shift and a night-shift
 * configuration, because a wrong comparison here silently inverts the
 * out-of-hours signal.
 *
 * **Memory bounds are real, not decorative.** `maxAttemptsPerOrg`,
 * `maxPrefixesPerOrg`, `maxTrackedOrgs` and the 100-entry alert buffer each cap
 * growth. They are asserted at cap+1 with the exact expected retained count, so
 * an off-by-one eviction shows up as the wrong number rather than as "it did not
 * grow without bound".
 *
 * **guards.ts / config.ts — each threshold is enforced on BOTH sides.**
 * "Just under passes, at the threshold blocks" is the only assertion that
 * survives someone changing `>=` to `>`. The cooldown is checked at
 * `cooldown - 1 ms` (blocked) and at exactly `cooldown` (allowed); the org and
 * global caps are checked at `cap - 1` and `cap`.
 *
 * **Dead config is reported, not asserted around.** See KNOWN GAPS below —
 * three knobs are parsed and validated but never read by the code path their
 * documentation implies, which is the failure mode a config module is most
 * likely to have and the one no behavioural test would otherwise catch.
 *
 * ── What geo.ts actually classifies ─────────────────────────────────────────
 *
 * The brief for this file asked for private/loopback/reserved IP range
 * classification (RFC 1918, 127.0.0.0/8, IPv6 ULA). **No such code exists.**
 * `geo.ts` contains no IP handling of any kind: no IPv4, no IPv6, no CIDR, no
 * address parser. It classifies *E.164 telephone destinations* — it canonicalises
 * a number, takes the calling code, maps that to an ISO-3166 country through a
 * static table, and compares the result against a country allowlist/denylist.
 * There is no IP-derived input anywhere on this path. What is asserted in §4 is
 * therefore the classification that exists, and it is asserted thoroughly:
 * the shape boundaries of the canonicaliser, the validation of resolver output,
 * and the internal consistency of the calling-code table itself (every key
 * resolves to its own country, and no three-digit key is shadowed by a shorter
 * one — the property that makes longest-prefix-wins safe).
 *
 * ── KNOWN GAPS (real defects found while writing this; NOT fixed here) ─────
 *
 * 1. `resolveAbuseConfig(env)` ignores its own `env` argument.
 *    config.ts:247 declares `env: Record<string, string | undefined>` and
 *    documents it as "Pure: pass an env stub to test it", but `num()` reads
 *    `process.env[name]` (config.ts:210), `list()` reads `process.env[name]`
 *    (config.ts:218) and `defaultTier` reads `process.env.ABUSE_PLAN_TIER`
 *    (config.ts:263). The parameter is never referenced. A caller who passes a
 *    stub gets whatever the real environment holds, silently. The tests below
 *    drive env resolution through `process.env` and restore it, because that is
 *    the path that actually executes.
 *
 * 2. `geoPolicyFor(orgId, override)` ignores its own `override` argument.
 *    geo.ts:289 declares the parameter and documents precedence including it,
 *    but the body never reads it — it consults only the registry, the per-org
 *    env var and the global config. This makes the documented per-call override
 *    on BOTH `checkDestinationGeo({ policy })` and
 *    `assertDialAllowed({ geoPolicy })` inert. The failure direction is
 *    fail-OPEN: a route that pins one tenant to `["AE"]` while the global
 *    allowlist is `["GB"]` dials GB anyway. No production caller passes
 *    `geoPolicy` today (`src/app/api/v1/interventions/route.ts` is the only
 *    `assertDialAllowed` caller and it omits the field), so nothing is
 *    currently exploitable — but the seam is documented as safe to use and it
 *    is not.
 *
 * 3. `TierConfig.defaultTier` is dead at the gate.
 *    `assertDialAllowed` coerces `input.planTier` directly (guards.ts:325) and
 *    never reads `abuseConfig().tier.defaultTier`. Only `planTierFor` reads it,
 *    and the sole `assertDialAllowed` caller passes `planTierFor(abuseOrg)`
 *    explicitly. So a deployment that sets `ABUSE_PLAN_TIER=enterprise` gets
 *    `demo` at every gate that does not remember to call the resolver — which
 *    is the exact scenario config.ts:83-91 says the knob exists to fix. Safe
 *    direction (demo is stricter), so this is a usability defect rather than a
 *    hole, but the knob does not do what its own documentation promises.
 *
 * 4. `orgAllowlistEnvName` / `orgPlanTierEnvName` name a variable the resolvers
 *    do not read. Both helpers are called with the *raw* org id, but
 *    `geoPolicyFor` and `planTierFor` call them with `safeOrgKey(orgId)` — which
 *    has already stripped everything outside `[\w.:-]`. For an id containing a
 *    character `safeOrgKey` removes (`/`, space), the helper returns
 *    `..._ACME_LTD_X` while the resolver reads `..._ACME_LTDX`. Ids made only of
 *    `_ . : -` and alphanumerics agree; ids that are not are silently ignored.
 *
 * 5. `num()` accepts values it documents as invalid. config.ts:53 claims "a
 *    non-numeric or negative value falls back to the default", but
 *    `Number("0x10")` is `16`, `Number("1e3")` is `1000` and `Number("5.7")` is
 *    `5.7` — all finite, all `>= min`, so all are accepted as thresholds. A
 *    fractional attempt count is meaningless; a hex threshold is almost
 *    certainly a mistake nobody made on purpose. Asserted below as observed
 *    behaviour, not endorsed.
 *
 * 6. `afterHoursWarn: 0` warns on every evaluation. The comparison is
 *    `afterHoursAttempts >= cfg.afterHoursWarn`, with no guard on the
 *    out-of-hours flag, so `0` is satisfied by zero attempts — at any hour,
 *    including business hours. `num()` explicitly permits `0` here (min 0),
 *    which makes it the one velocity setting whose "least restrictive" value
 *    is the most restrictive.
 *
 * 7. `maskE164`'s short-number branch (geo.ts:76) is unreachable.
 *    `E164_RE` requires at least seven digits, so the length after
 *    canonicalisation is never `<= 4`. Harmless, but it is dead code inside the
 *    function whose entire job is not to leak digits.
 *
 * 8. `guard_internal_error` is recorded under the wrong control name.
 *    guards.ts:479 pushes the catch-all entry as `{ control: "velocity" }`
 *    regardless of which control threw. An operator reading `controls[]` is told
 *    the velocity control failed when the actual fault may be in shape
 *    validation. Reachable from any non-string `e164`: `.trim()` throws before
 *    `input_shape` can complete.
 *
 * **Not covered here:** `AbusePauseStore` / `setPauseStore` (the Redis/Postgres
 * seam — needs a second implementation to be meaningful), and anything requiring
 * a database or a network. Both are integration concerns, not unit ones.
 *
 * `bun test tests/unit/abuse.test.ts`
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_ABUSE_CONFIG,
  HARD_DENIED_COUNTRIES,
  HARD_DENIED_PREFIXES,
  orgAllowlistEnvName,
  resetAbuseConfig,
  resolveAbuseConfig,
  setAbuseConfig,
  type AbuseConfig,
} from "@/lib/abuse/config";
import {
  COUNTRY_BY_CALLING_CODE,
  E164_RE,
  PREFIX_DIGITS,
  checkDestinationGeo,
  clearOrgGeoPolicies,
  destinationPrefix,
  geoPolicyFor,
  isE164,
  maskE164,
  normaliseE164,
  prefixCountryResolver,
  resolveCountry,
  safeOrgKey,
  setCountryResolver,
  setOrgGeoPolicy,
  type GeoInput,
  type GeoRejectReason,
} from "@/lib/abuse/geo";
import {
  PLAN_TIERS,
  checkPlanTier,
  clearOrgPlanTiers,
  clearOrgTestNumbers,
  coercePlanTier,
  isPlanTier,
  isTestNumber,
  normaliseTestNumberEntry,
  orgPlanTierEnvName,
  planTierFor,
  setOrgPlanTier,
  setOrgTestNumbers,
  testNumbersFor,
  type PlanTier,
} from "@/lib/abuse/tiers";
import {
  evaluate,
  isAfterHours,
  isOrgPaused,
  pauseOrg,
  recentAlerts,
  recordAttempt,
  resetVelocityState,
  resumeOrg,
  setAlertSink,
  velocitySnapshot,
} from "@/lib/abuse/velocity";
import {
  activeGlobalCalls,
  activeOrgCalls,
  assertDialAllowed,
  dialStateSnapshot,
  releaseDialSlot,
  resetDialState,
} from "@/lib/abuse/guards";

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

/** In-hours (10:00 UTC) and out-of-hours (03:00 UTC) instants. */
const T_IN = Date.UTC(2026, 0, 15, 10, 0, 0); // 14:00 in Dubai — in hours
// Out of hours by the DEFAULT zone (Asia/Dubai), not by the server's UTC clock:
// 21:00 UTC is 01:00 the next Dubai morning. This constant is only an
// out-of-hours instant because of the timezone fix; under the old UTC reading
// it was ordinary business time, which is the bug.
const T_OUT = Date.UTC(2026, 0, 15, 21, 0, 0);

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** AE destinations, each in a distinct 5-digit block so each has its own prefix. */
const AE_A = "+971501234567";
const AE_B = "+971521234567";
const AE_C = "+971551234567";
const GB_A = "+447700900123";

/**
 * Clear every `ABUSE_*` variable this file touched. Done by prefix rather than
 * by name: `resetAbuseConfig()` re-reads the environment, so a leaked value
 * would silently reconfigure every later test in the run — and the per-org
 * `__<ORG>` names are derived from ids chosen per test, so a fixed list would
 * miss them. Every variable these tests set is one this package owns, so the
 * sweep cannot collide with an unrelated suite.
 */
const clearAbuseEnv = (): void => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ABUSE_")) delete process.env[key];
  }
};

/**
 * Velocity configured so no signal fires, leaving each test free to move the
 * one threshold it is about. `burstRateMax`/`newPrefixBurst` are pushed above
 * anything a test can reach; the after-hours pair is set so the warn fires
 * before the pause.
 */
const velocityOff = (over: Partial<AbuseConfig["velocity"]> = {}): AbuseConfig["velocity"] => ({
  ...DEFAULT_ABUSE_CONFIG.velocity,
  burstRateMax: 100_000,
  newPrefixBurst: 100_000,
  afterHoursWarn: 100_000,
  afterHoursPause: 100_001,
  ...over,
});

/** Record `count` attempts for `orgId`, one second apart from `at`. */
const recordBurst = (orgId: string, count: number, at: number, e164: string = AE_A): void => {
  for (let i = 0; i < count; i += 1) recordAttempt({ orgId, e164, at: at + i });
};

/**
 * The typed reason a geo decision was refused, or null when it passed. Used
 * by the step-ordering table in §5, where the whole point is comparing one
 * refusal reason against the next.
 */
const checkDestinationGeoReason = (input: GeoInput): GeoRejectReason | null => {
  const decision = checkDestinationGeo(input);
  return decision.ok ? null : decision.reason;
};

beforeEach(() => {
  resetAbuseConfig();
  clearOrgGeoPolicies();
  clearOrgTestNumbers();
  clearOrgPlanTiers();
  resetVelocityState();
  resetDialState();
  setCountryResolver(null);
  setAlertSink(() => {});
  setAbuseConfig({
    geo: { allowlist: ["AE", "GB"] },
    concurrency: { ...DEFAULT_ABUSE_CONFIG.concurrency, cooldownSec: 0 },
    velocity: velocityOff(),
  });
});

afterEach(() => {
  clearAbuseEnv();
  setAlertSink(null);
  resetDialState();
  resetVelocityState();
  resetAbuseConfig();
  clearOrgGeoPolicies();
  clearOrgTestNumbers();
  clearOrgPlanTiers();
  setCountryResolver(null);
});

/* ── 1. tiers.ts — the tier lookup ────────────────────────────────────────── */

describe("tiers: the tier set is closed and unrecognised input fails closed", () => {
  test("PLAN_TIERS is the whole domain: every member is recognised and survives coercion", () => {
    // The list is the contract — a tier that is in the list but not
    // recognised by the predicate could never be selected, and one that is
    // recognised but not in the list would be invisible to this test.
    expect(PLAN_TIERS).toEqual(["demo", "standard", "enterprise"]);
    // Typed as `PlanTier[]` by the module, so each member is statically a valid
    // tier; the runtime assertions below are what prove the list and the
    // predicate agree, which types alone cannot.
    const tiers: readonly PlanTier[] = PLAN_TIERS;
    for (const tier of tiers) {
      expect(isPlanTier(tier)).toBe(true);
      // Coercion is the identity on a known tier, so a caller who passes a
      // value straight from `PLAN_TIERS` never loses it to a default.
      expect(coercePlanTier(tier)).toBe(tier);
    }
    // Frozen: a runtime `push` would add a tier no other code knows about.
    expect(Object.isFrozen(PLAN_TIERS)).toBe(true);
    // No duplicates, or the matrix below would silently double-count.
    expect(new Set(tiers).size).toBe(tiers.length);
  });

  test("every non-member lands on demo — the tier that cannot dial an unverified number", () => {
    // Table-driven over the four ways a tier name can be wrong: wrong case,
    // padded, a name from a different system, and a non-string. All of them
    // must fail to the strictest tier. `demo` is the ONLY tier whose
    // `checkPlanTier` can refuse, so defaulting to `standard` here would
    // turn a typo into unrestricted dialling.
    const rejects: readonly unknown[] = [
      "DEMO",
      "Demo",
      "dEmO",
      " demo",
      "demo ",
      "standard ",
      "ENTERPRISE",
      "Enterprise",
      "pro",
      "trial",
      "free",
      "premium",
      "",
      "   ",
      null,
      undefined,
      0,
      1,
      true,
      false,
      {},
      [],
      ["demo"],
      Symbol("demo"),
    ];
    for (const value of rejects) {
      expect(isPlanTier(value)).toBe(false);
      expect(coercePlanTier(value)).toBe("demo");
    }
  });

  test("the full tier × destination-class matrix: only demo is restricted", () => {
    // Complete matrix, not a sample. The regression worth catching is a
    // tier quietly gaining `restricted: false`, or demo losing it — both
    // are invisible to any single spot check.
    //
    // The shape of the answer is itself a property: `standard` and
    // `enterprise` are UNRESTRICTED even for a malformed destination,
    // because this control only narrows demo. A malformed number is caught
    // by the shape control in guards.ts before the tier control runs, so
    // `checkPlanTier` on its own never validates for a non-demo tier.
    // If that ever changed, geography and the caps would be the only thing
    // left between a bad destination and a dialled call.
    const LISTED = [AE_A];
    const classes = [
      { label: "listed number", e164: AE_A, demoOk: true },
      { label: "unlisted number", e164: AE_C, demoOk: false },
      { label: "malformed number", e164: "not-a-number", demoOk: false },
    ] as const;

    for (const tier of PLAN_TIERS) {
      for (const cls of classes) {
        const decision = checkPlanTier({ e164: cls.e164, tier, orgId: "org-m", list: LISTED });
        const isDemo = tier === "demo";
        // `demo` is the only tier that can refuse, and it refuses
        // everything not on the verified list — including a number it
        // cannot canonicalise, which it cannot have verified.
        expect(decision.ok).toBe(isDemo ? cls.demoOk : true);
        // `restricted` is true only for demo on a listed number. It is
        // the signal a route uses to label a call, so widening it would
        // mislabel every non-demo dial.
        expect(decision.ok && decision.restricted).toBe(isDemo && cls.demoOk);
        if (!decision.ok) {
          // A refusal carries one of the two tier reasons, never an
          // empty-list reason: the list here is non-empty.
          expect(decision.reason).toBe("demo_tier_requires_test_number");
        }
      }
    }
  });

  test("an empty verified list refuses demo with a distinct reason, and only demo", () => {
    // The two refusal reasons are distinguishable, and an operator needs to
    // tell them apart: one is "list the numbers", the other is "this is not
    // a listed number".
    const empty = checkPlanTier({ e164: AE_A, tier: "demo", orgId: "org-m", list: [] });
    expect(empty.ok === false && empty.reason).toBe("test_number_list_empty");

    // A list that normalises away to nothing counts as empty — degenerate
    // entries must not be a way to reach the "has a list" branch.
    const degenerate = checkPlanTier({
      e164: AE_A,
      tier: "demo",
      orgId: "org-m",
      list: ["*", "+", "", "   ", "1500555**"],
    });
    expect(degenerate.ok === false && degenerate.reason).toBe("test_number_list_empty");

    // Non-demo tiers are unaffected by an empty list: they are not
    // restricted by this control at all.
    for (const tier of ["standard", "enterprise"] as const) {
      expect(checkPlanTier({ e164: AE_A, tier, orgId: "org-m", list: [] })).toEqual({
        ok: true,
        restricted: false,
      });
    }
  });

  test("normaliseTestNumberEntry canonicalises what operators type and refuses degenerate entries", () => {
    // Canonicalisation: what a human actually types in an env var must
    // reach the same stored form, or the list silently stops matching.
    const canonical: readonly [string, string][] = [
      ["+971501234567", "+971501234567"],
      ["+971 50 123 4567", "+971501234567"],
      ["+971-50-123-4567", "+971501234567"],
      ["(+971) 50 123 4567", "+971501234567"],
      ["  +971501234567  ", "+971501234567"],
      ["00971501234567", "+971501234567"],
      ["971501234567", "+971501234567"],
      ["++971501234567", "+971501234567"],
      // A trailing `*` is a carrier test RANGE, not a number. Preserving
      // the star is what makes `isTestNumber` do prefix matching.
      ["1500555*", "+1500555*"],
      ["+971 50 *", "+97150*"],
      ["971501234567*", "+971501234567*"],
      // 15 digits is the E.164 maximum and is still accepted here.
      ["+123456789012345", "+123456789012345"],
    ];
    for (const [raw, expected] of canonical) {
      expect(normaliseTestNumberEntry(raw)).toBe(expected);
    }

    // Refusal: an entry that would match everything, or that is not a
    // number, must never become a list entry. `*` alone matching every
    // destination would turn the demo tier into no tier at all.
    const refused: readonly string[] = [
      "*",
      "+*",
      "**",
      "1500555**",
      "abc*",
      "+",
      "++",
      "",
      "   ",
      "abc",
      "+abc",
      "+971-abc-1234567",
      // 16 digits is beyond E.164; a number nobody can dial.
      "+1234567890123456",
      "00",
    ];
    for (const raw of refused) {
      expect(normaliseTestNumberEntry(raw)).toBeNull();
    }
  });

  test("isTestNumber matches an entry exactly and a starred entry by prefix, and nothing else", () => {
    // Exact entries must not match a longer number sharing their prefix —
    // listing one verified number is not a licence for the whole block.
    expect(isTestNumber(AE_A, { list: ["+971501234567"] })).toBe(true);
    expect(isTestNumber("+971501234568", { list: ["+971501234567"] })).toBe(false);
    expect(isTestNumber("+9715012345678", { list: ["+971501234567"] })).toBe(false);

    // A starred entry matches its whole prefix and stops at the first
    // digit that leaves it.
    expect(isTestNumber("+971509999999", { list: ["+97150*"] })).toBe(true);
    expect(isTestNumber("+971509999999", { list: ["97150*"] })).toBe(true);
    expect(isTestNumber("+971519999999", { list: ["+97150*"] })).toBe(false);
    expect(isTestNumber("+971509999999", { list: ["+9715*"] })).toBe(true);

    // An unparseable destination is never a verified test number, even
    // when the list would otherwise cover it.
    expect(isTestNumber("not-a-number", { list: ["+97150*"] })).toBe(false);
    expect(isTestNumber("", { list: ["+97150*"] })).toBe(false);
    // No list configured means nothing is verified — the absence of a
    // list is not permission.
    expect(isTestNumber(AE_A, { list: [] })).toBe(false);
  });

  test("testNumbersFor de-duplicates across the spellings of one number", () => {
    // Three spellings of the same number are three config errors, not three
    // verified numbers; counting them separately would make MAX_ENTRIES_PER_ORG
    // reachable with a fraction of the intended list.
    setOrgTestNumbers("org-dup", [
      "+971501234567",
      "+971 50 123 4567",
      "00971501234567",
      "+971521234567",
    ]);
    expect(testNumbersFor("org-dup")).toEqual([AE_A, AE_B]);
  });

  test("the per-org registry is bounded at 500 entries; an uncapped override is not", () => {
    // A list is config, not a store: an operator pasting a 10k-range export
    // must not be able to grow the map without limit. The cap is what makes
    // the per-org memory bound real.
    const many = Array.from({ length: 900 }, (_, i) => `+97150${String(1_000_000 + i)}`);
    setOrgTestNumbers("org-cap", many);
    expect(testNumbersFor("org-cap")).toHaveLength(500);
    // The 500th entry is kept and the 501st is dropped — retention is
    // insertion-ordered, so a cap of one too few would drop the wrong end.
    expect(testNumbersFor("org-cap").includes(many[499] as string)).toBe(true);
    expect(isTestNumber(many[499] as string, { orgId: "org-cap" })).toBe(true);
    expect(isTestNumber(many[500] as string, { orgId: "org-cap" })).toBe(false);

    // The per-call override path is NOT capped. A caller that hands in an
    // unbounded iterable grows its own slice of memory. Not exploitable
    // from a route today (the field is a developer-supplied list), but it
    // means the 500 bound is a property of the registry, not of the control.
    expect(testNumbersFor("org-cap", many)).toHaveLength(900);
  });

  test("planTierFor falls back through registry, env and the deployment default, and unknown input is demo", () => {
    // KNOWN GAP 4: `orgPlanTierEnvName` is called with the SANITISED key by
    // `planTierFor`, so the name an operator derives from the raw org id is
    // not the name that gets read when `safeOrgKey` rewrote the id.
    expect(orgPlanTierEnvName("org_acme")).toBe("ABUSE_PLAN_TIER__ORG_ACME");
    expect(orgPlanTierEnvName("acme-ltd/x")).toBe("ABUSE_PLAN_TIER__ACME_LTD_X");
    // What `planTierFor` actually reads for that same id:
    expect(orgPlanTierEnvName(safeOrgKey("acme-ltd/x"))).toBe("ABUSE_PLAN_TIER__ACME_LTDX");

    // Ids made only of characters `safeOrgKey` preserves agree, and the env
    // var is honoured.
    process.env.ABUSE_PLAN_TIER__ORG_SAFE = "standard";
    expect(planTierFor("org-safe")).toBe("standard");
    delete process.env.ABUSE_PLAN_TIER__ORG_SAFE;

    // A registry entry outranks the env var.
    process.env.ABUSE_PLAN_TIER__ORG_REG = "standard";
    setOrgPlanTier("org-reg", "enterprise");
    expect(planTierFor("org-reg")).toBe("enterprise");
    delete process.env.ABUSE_PLAN_TIER__ORG_REG;

    // An explicit override outranks the registry — a caller that already
    // loaded the tenant wins.
    expect(planTierFor("org-reg", "standard")).toBe("standard");

    // A registration that is not a known tier registers NOTHING, so the org
    // falls through to the deployment default rather than being poisoned
    // with `demo` under a name an operator believes is `standard`.
    setOrgPlanTier("org-typo", "Standard");
    setAbuseConfig({ tier: { ...DEFAULT_ABUSE_CONFIG.tier, defaultTier: "enterprise" } });
    expect(planTierFor("org-typo")).toBe("enterprise");

    // An unrecognised DEPLOYMENT default also lands on demo. A garbage
    // `ABUSE_PLAN_TIER` must not become a permissive tier.
    setAbuseConfig({ tier: { ...DEFAULT_ABUSE_CONFIG.tier, defaultTier: "galactic" } });
    expect(planTierFor("org-nobody")).toBe("demo");

    // No org id at all is still demo — the fail-closed floor.
    expect(planTierFor(null)).toBe("demo");
    expect(planTierFor("")).toBe("demo");
    expect(planTierFor(undefined)).toBe("demo");
  });

  test("setOrgPlanTier refuses a value outside the closed set and accepts null as 'unset'", () => {
    // null clears; an unknown string is a no-op. Storing `coercePlanTier(garbage)`
    // would register `demo` under a name the operator believes is `standard`,
    // and the failure would only surface later as a refused production dial.
    for (const bad of ["Standard", "ENTERPRISE", "trial", "", "  ", "demo "]) {
      setOrgPlanTier("org-x", bad);
      expect(planTierFor("org-x")).toBe("demo");
    }
    // An org id that sanitises to empty is not registrable at all.
    setOrgPlanTier("", "standard");
    expect(planTierFor("")).toBe("demo");

    // Each real tier round-trips, and null removes it again.
    for (const tier of PLAN_TIERS) {
      setOrgPlanTier("org-rt", tier);
      expect(planTierFor("org-rt")).toBe(tier);
    }
    setOrgPlanTier("org-rt", null);
    expect(planTierFor("org-rt")).toBe("demo");
  });

  test("checkPlanTier masks the destination in its refusal detail", () => {
    // The detail string is what reaches an operator's screen and an alert
    // sink. Subscriber digits must not be in it; the country code and last
    // four must be, because that is what reconciles against a carrier bill.
    const denied = checkPlanTier({ e164: "+971509876543", tier: "demo", list: [AE_A] });
    expect(denied.ok).toBe(false);
    const detail = denied.ok === false ? denied.detail : "";
    expect(detail).toContain("+971****6543");
    expect(detail).not.toContain("09876543");
    expect(detail).not.toContain("876543");
  });
});

/* ── 2. velocity.ts — window arithmetic ───────────────────────────────────── */

describe("velocity: windows are half-open (now - window, now]", () => {
  test("the burst window includes an attempt at window-1ms and excludes one at exactly window", () => {
    setAbuseConfig({ velocity: velocityOff({ burstWindowSec: 60 }) });
    resetVelocityState();
    recordAttempt({ orgId: "org-w", e164: AE_A, at: T_IN });

    // Strictly inside: `t > now - window` holds.
    expect(evaluate({ orgId: "org-w", at: T_IN + 60 * SECOND - 1 }).metrics.burstAttempts).toBe(1);
    // Exactly on the boundary: `t > cutoff` is false, so it has aged out.
    // This is the off-by-one. `>=` here would make the window one
    // millisecond wider than every configured threshold assumes.
    expect(evaluate({ orgId: "org-w", at: T_IN + 60 * SECOND }).metrics.burstAttempts).toBe(0);
    expect(evaluate({ orgId: "org-w", at: T_IN + 61 * SECOND }).metrics.burstAttempts).toBe(0);

    // The wider attempt window still counts the same attempt, so the two
    // windows are independent and the burst window is the tighter one.
    expect(evaluate({ orgId: "org-w", at: T_IN + 60 * SECOND }).metrics.windowAttempts).toBe(1);
  });

  test("the attempt window counts at window-1ms and drops to zero at exactly window", () => {
    setAbuseConfig({ velocity: velocityOff({ attemptWindowSec: 60 }) });
    resetVelocityState();
    recordAttempt({ orgId: "org-aw", e164: AE_A, at: T_IN });
    expect(evaluate({ orgId: "org-aw", at: T_IN + 60 * SECOND - 1 }).metrics.windowAttempts).toBe(
      1,
    );
    expect(evaluate({ orgId: "org-aw", at: T_IN + 60 * SECOND }).metrics.windowAttempts).toBe(0);
  });

  test("recording an attempt prunes what has aged out of the window before adding the new one", () => {
    // Pruning happens on WRITE, so state cannot grow just because an org
    // stopped dialling; but the count must not double-count at the boundary.
    setAbuseConfig({ velocity: velocityOff({ attemptWindowSec: 60 }) });
    resetVelocityState();
    recordAttempt({ orgId: "org-pr", e164: AE_A, at: T_IN });
    // Exactly one window later the first attempt is stale (`t <= cutoff`) and
    // is dropped, leaving only the attempt being recorded now.
    recordAttempt({ orgId: "org-pr", e164: AE_B, at: T_IN + 60 * SECOND });
    const metrics = evaluate({ orgId: "org-pr", at: T_IN + 60 * SECOND }).metrics;
    expect(metrics.windowAttempts).toBe(1);
    expect(metrics.distinctPrefixes).toBe(1);
    expect(velocitySnapshot().attemptsTracked).toBe(1);
  });

  test("the new-prefix window includes a prefix first seen at window-1ms and excludes one at exactly window", () => {
    setAbuseConfig({ velocity: velocityOff({ newPrefixWindowSec: 900 }) });
    resetVelocityState();
    recordAttempt({ orgId: "org-np", e164: AE_A, at: T_IN });
    expect(evaluate({ orgId: "org-np", at: T_IN + 900 * SECOND - 1 }).metrics.newPrefixes).toBe(1);
    expect(evaluate({ orgId: "org-np", at: T_IN + 900 * SECOND }).metrics.newPrefixes).toBe(0);
  });

  test("a repeated prefix is not new, however many times it is dialled", () => {
    // The signal is about destination BLOCKS the org has never touched, not
    // about volume. If a repeated prefix counted as new, any busy single-block
    // tenant would auto-pause.
    setAbuseConfig({ velocity: velocityOff({ newPrefixWindowSec: 900 }) });
    resetVelocityState();
    recordBurst("org-rep", 5, T_IN, AE_A);
    const metrics = evaluate({ orgId: "org-rep", at: T_IN + 5 }).metrics;
    expect(metrics.newPrefixes).toBe(1);
    expect(metrics.distinctPrefixes).toBe(1);
    expect(metrics.windowAttempts).toBe(5);
  });

  test("the burst-rate rule fires at exactly N attempts in the window and not at N-1", () => {
    // The literal "N events in M minutes" rule, checked on both sides. With
    // `burstRateMax: 3` the third attempt inside the window is the first
    // that pauses; `>= 4` would let a full-rate attacker through one extra
    // dial, `> 3` would pause one dial late.
    setAbuseConfig({ velocity: velocityOff({ burstWindowSec: 60, burstRateMax: 3 }) });
    resetVelocityState();
    const actions: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      recordAttempt({ orgId: "org-br", e164: AE_A, at: T_IN + i });
      actions.push(evaluate({ orgId: "org-br", at: T_IN + i }).action);
    }
    expect(actions).toEqual(["allow", "allow", "auto_pause", "auto_pause"]);

    // The fourth is not a second signal — it is the breaker that is already
    // open, and re-alerting is how a real alert gets ignored.
    resetVelocityState();
    recordBurst("org-br2", 3, T_IN, AE_A);
    const third = evaluate({ orgId: "org-br2", at: T_IN + 2 });
    expect(third.reason).toBe("velocity_burst_rate");
    expect(third.alreadyPaused).toBe(false);
    const fourth = evaluate({ orgId: "org-br2", at: T_IN + 3 });
    expect(fourth.reason).toBe("org_auto_paused");
    expect(fourth.alreadyPaused).toBe(true);

    // The same TOTAL volume is not a burst once the window has moved past
    // the earliest attempts: three attempts ever is not three attempts in
    // sixty seconds. Recording at 0 s, 30 s and 61 s and evaluating at 61 s
    // leaves only two inside the 60 s window, which is under the threshold.
    resetVelocityState();
    setAbuseConfig({ velocity: velocityOff({ burstWindowSec: 60, burstRateMax: 3 }) });
    for (const offset of [0, 30, 61]) {
      recordAttempt({ orgId: "org-br3", e164: AE_A, at: T_IN + offset * SECOND });
    }
    const spread = evaluate({ orgId: "org-br3", at: T_IN + 61 * SECOND });
    expect(spread.metrics.burstAttempts).toBe(2);
    expect(spread.metrics.windowAttempts).toBe(3);
    expect(spread.action).toBe("allow");
  });

  test("the new-prefix rule fires at exactly N distinct new prefixes and not at N-1", () => {
    setAbuseConfig({ velocity: velocityOff({ newPrefixBurst: 2, burstWindowSec: 3600 }) });
    resetVelocityState();
    const actions: string[] = [];
    for (const e164 of [AE_A, AE_B, AE_C]) {
      recordAttempt({ orgId: "org-npb", e164, at: T_IN });
      actions.push(evaluate({ orgId: "org-npb", at: T_IN }).action);
    }
    expect(actions).toEqual(["allow", "auto_pause", "auto_pause"]);
  });

  test("out-of-hours volume warns from the warn threshold and pauses from the pause threshold", () => {
    // The warn threshold is deliberately lower and must NOT pause: a fraud
    // desk legitimately runs nights, so a warning that stops the dial would
    // be the wrong call at volume 3 and the right one at 5.
    setAbuseConfig({
      velocity: velocityOff({ afterHoursWarn: 2, afterHoursPause: 4, burstWindowSec: 3600 }),
    });
    resetVelocityState();
    const actions: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      recordAttempt({ orgId: "org-ah", e164: AE_A, at: T_OUT + i });
      actions.push(evaluate({ orgId: "org-ah", at: T_OUT + i }).action);
    }
    expect(actions).toEqual(["allow", "warn", "warn", "auto_pause", "auto_pause"]);

    // The signal is a property of the ATTEMPTS' hours, not the evaluation
    // instant's: the metric counts when each ATTEMPT happened, and
    // `afterHours` describes the evaluation instant. They are separate, so
    // a run of in-hours attempts evaluated out of hours reports
    // `afterHours: true` with zero out-of-hours attempts in the window — the
    // attempts were in hours even though the instant is not.
    resetVelocityState();
    recordBurst("org-ah2", 2, T_IN, AE_A);
    // Evaluated hours later, at 03:00, so `afterHours` is true — but the two
    // in-hours attempts it is counting are still zero out-of-hours.
    const outOfHoursRun = evaluate({ orgId: "org-ah2", at: T_OUT });
    expect(outOfHoursRun.metrics.afterHours).toBe(true);
    expect(outOfHoursRun.metrics.afterHoursAttempts).toBe(0);
    // In-hours attempts never contribute to the out-of-hours count.
    resetVelocityState();
    recordBurst("org-ah3", 5, T_IN, AE_A);
    const inHours = evaluate({ orgId: "org-ah3", at: T_IN });
    expect(inHours.metrics.afterHoursAttempts).toBe(0);
    expect(inHours.metrics.afterHours).toBe(false);
    expect(inHours.action).toBe("allow");

    // FIXED (gap 6). `afterHoursWarn: 0` used to be satisfiable by ZERO
    // attempts, because the comparison was
    // `afterHoursAttempts >= afterHoursWarn` with no guard on the out-of-hours
    // flag — so the "least restrictive" value of the knob was the most
    // restrictive outcome, at any hour including 10:00. `thresholdArmed()` now
    // gates both the warn and the pause, so 0 means DISABLED.
    setAbuseConfig({
      velocity: velocityOff({ afterHoursWarn: 0, afterHoursPause: 100_000 }),
    });
    resetVelocityState();
    const zeroWarnInHours = evaluate({ orgId: "org-ah4", at: T_IN });
    expect(zeroWarnInHours.action).toBe("allow");
    expect(zeroWarnInHours.metrics.afterHoursAttempts).toBe(0);
    expect(zeroWarnInHours.metrics.afterHours).toBe(false);

    // And with the PAUSE threshold also 0, it still does not pause — a
    // configured "disabled" must not be silently armed by the other knob.
    setAbuseConfig({ velocity: velocityOff({ afterHoursWarn: 0, afterHoursPause: 0 }) });
    resetVelocityState();
    expect(evaluate({ orgId: "org-ah5", at: T_IN }).action).toBe("allow");

    // A NON-zero out-of-hours threshold still fires on out-of-hours volume, so
    // the fix did not disable the control itself.
    setAbuseConfig({
      velocity: velocityOff({ afterHoursWarn: 2, afterHoursPause: 100_000 }),
    });
    resetVelocityState();
    recordBurst("org-ah6", 2, T_OUT, AE_A);
    expect(evaluate({ orgId: "org-ah6", at: T_OUT }).action).toBe("warn");
  });
});

describe("velocity: business hours are wrap-aware and half-open", () => {
  test("a day shift (06:00-22:00) is in hours on [start, end)", () => {
    setAbuseConfig({
      velocity: velocityOff({ businessHoursStart: 6, businessHoursEnd: 22 }),
    });
    // All 24 hours asserted, because a wrong comparison inverts the signal
    // silently: nothing would ever be out of hours, so the control would
    // never fire and would look like it was working.
    const expected = [
      "AH",
      "AH",
      "AH",
      "AH",
      "AH",
      "AH", // 00-05 out
      "IN",
      "IN",
      "IN",
      "IN",
      "IN",
      "IN", // 06-11 in
      "IN",
      "IN",
      "IN",
      "IN",
      "IN",
      "IN", // 12-17 in
      "IN",
      "IN",
      "IN",
      "IN",
      "AH",
      "AH", // 18-21 in, 22-23 out
    ];
    // Pinned to "UTC" because this block is about the comparison, not the
    // clock: which hour the wall shows is a separate assertion below, and
    // letting both vary at once makes an inverted comparison untraceable.
    for (let hour = 0; hour < 24; hour += 1) {
      const at = Date.UTC(2026, 0, 15, hour, 0, 0);
      expect(`${hour}:${isAfterHours(at, "UTC") ? "AH" : "IN"}`).toBe(`${hour}:${expected[hour]}`);
    }
    // start is inclusive, end is exclusive — asserted directly because it
    // is the pair most easily off by one.
    expect(isAfterHours(Date.UTC(2026, 0, 15, 6, 0, 0), "UTC")).toBe(false);
    expect(isAfterHours(Date.UTC(2026, 0, 15, 21, 59, 59), "UTC")).toBe(false);
    expect(isAfterHours(Date.UTC(2026, 0, 15, 22, 0, 0), "UTC")).toBe(true);
    expect(isAfterHours(Date.UTC(2026, 0, 15, 5, 59, 59), "UTC")).toBe(true);
  });

  test("the same instant is judged by the customer's clock, not the server's", () => {
    // This is the bug the UTC reading caused. 17:00 UTC on 15 Jan is 21:00 in
    // Dubai — in hours — while 21:00 UTC is 01:00 the next Dubai morning, which
    // is exactly the hour a fraud desk must not dial into. Evaluated against
    // UTC both answers are wrong, and both are wrong in the permissive
    // direction: the gate lets a night call through and refuses an evening one.
    setAbuseConfig({
      velocity: velocityOff({
        businessHoursStart: 6,
        businessHoursEnd: 22,
        businessHoursTimezone: "Asia/Dubai",
      }),
    });

    const eveningDubai = Date.UTC(2026, 0, 15, 17, 0, 0); // 21:00 GST
    const nightDubai = Date.UTC(2026, 0, 15, 21, 0, 0); // 01:00 GST next day

    expect(isAfterHours(eveningDubai)).toBe(false);
    expect(isAfterHours(nightDubai)).toBe(true);

    // Same two instants, same configured numbers, read on UTC instead. Only the
    // zone can have changed the answer — and the night instant is the bug this
    // fix closes: on UTC it is ordinary business time, so the old gate would
    // have dialled a Dubai customer at 01:00 and called it 21:00.
    setAbuseConfig({
      velocity: velocityOff({ businessHoursStart: 6, businessHoursEnd: 22 }),
    });
    expect(isAfterHours(nightDubai, "UTC")).toBe(false);
  });

  test("a half-day offset zone still lands on the right hour", () => {
    // Asia/Kolkata is +05:30, which a `Math.floor(offset/3600)` shortcut would
    // round to +05:00 and get wrong for the whole thirty-minute band. India is
    // on the language list, so this is a real deployment, not a curiosity.
    setAbuseConfig({
      velocity: velocityOff({
        businessHoursStart: 6,
        businessHoursEnd: 22,
        businessHoursTimezone: "Asia/Kolkata",
      }),
    });
    expect(isAfterHours(Date.UTC(2026, 0, 15, 0, 0, 0))).toBe(true); // 05:30 IST
    expect(isAfterHours(Date.UTC(2026, 0, 15, 0, 30, 0))).toBe(false); // 06:00 IST
  });

  test("an unusable zone is refused at config time rather than guessed", () => {
    expect(() => resolveAbuseConfig({ ABUSE_BUSINESS_HOURS_TZ: "Mars/Dubai" })).toThrow(
      /IANA timezone/,
    );
    // A typo must not silently revert to a clock that dials at midnight.
    expect(() => resolveAbuseConfig({ ABUSE_BUSINESS_HOURS_TZ: "Europe/Nowhere" })).toThrow();
  });

  test("a night shift (22:00-06:00) wraps the day instead of inverting it", () => {
    // start > end means the window crosses midnight. Getting this wrong does
    // not throw — it just marks every hour out of hours, which would make
    // the weakest signal fire on all legitimate traffic. Pinned to "UTC":
    // this block is about the comparison, not about which clock is read.
    setAbuseConfig({
      velocity: velocityOff({ businessHoursStart: 22, businessHoursEnd: 6 }),
    });
    const expected = [
      "IN",
      "IN",
      "IN",
      "IN",
      "IN",
      "IN", // 00-05 in
      "AH",
      "AH",
      "AH",
      "AH",
      "AH",
      "AH", // 06-11 out
      "AH",
      "AH",
      "AH",
      "AH",
      "AH",
      "AH", // 12-17 out
      "AH",
      "AH",
      "AH",
      "AH",
      "IN",
      "IN", // 18-21 out, 22-23 in
    ];
    for (let hour = 0; hour < 24; hour += 1) {
      const at = Date.UTC(2026, 0, 15, hour, 0, 0);
      expect(`${hour}:${isAfterHours(at, "UTC") ? "AH" : "IN"}`).toBe(`${hour}:${expected[hour]}`);
    }
  });

  test("start === end means 24-hour operation, never out of hours", () => {
    // A degenerate config must disable the signal rather than making every
    // hour out of hours. Same pinning: the zone is a separate assertion.
    setAbuseConfig({
      velocity: velocityOff({ businessHoursStart: 8, businessHoursEnd: 8 }),
    });
    for (let hour = 0; hour < 24; hour += 1) {
      expect(isAfterHours(Date.UTC(2026, 0, 15, hour, 0, 0), "UTC")).toBe(false);
    }
  });
});

describe("velocity: memory bounds are real and reset clears them", () => {
  test("attempts per org are capped, keeping the most recent", () => {
    setAbuseConfig({ velocity: velocityOff({ maxAttemptsPerOrg: 3 }) });
    resetVelocityState();
    recordBurst("org-cap", 6, T_IN, AE_A);
    // Six attempts recorded, three retained. An uncapped slice would let an
    // org that dials continuously grow its own memory.
    expect(evaluate({ orgId: "org-cap", at: T_IN + 6 }).metrics.windowAttempts).toBe(3);
    expect(velocitySnapshot().attemptsTracked).toBe(3);
  });

  test("prefixes per org are capped, evicting the oldest first", () => {
    setAbuseConfig({ velocity: velocityOff({ maxPrefixesPerOrg: 2 }) });
    resetVelocityState();
    for (const e164 of [AE_A, AE_B, AE_C]) recordAttempt({ orgId: "org-pfx", e164, at: T_IN });
    const metrics = evaluate({ orgId: "org-pfx", at: T_IN }).metrics;
    expect(metrics.distinctPrefixes).toBe(2);
    // The two NEWEST prefixes survive; the first-seen one is the stale one.
    expect(metrics.newPrefixes).toBe(2);
  });

  test("tracked orgs are capped and the evictions are counted, not silent", () => {
    setAbuseConfig({ velocity: velocityOff({ maxTrackedOrgs: 2 }) });
    resetVelocityState();
    recordBurst("org-1", 1, T_IN, AE_A);
    recordBurst("org-2", 1, T_IN, AE_A);
    expect(velocitySnapshot().trackedOrgs).toBe(2);
    expect(velocitySnapshot().orgStateEvicted).toBe(0);

    // The third org exceeds the cap, so the least-recently-seen org is
    // evicted and the drop is visible on the status surface.
    recordBurst("org-3", 1, T_IN + SECOND, AE_A);
    expect(velocitySnapshot().trackedOrgs).toBe(2);
    expect(velocitySnapshot().orgStateEvicted).toBe(1);
    // The evicted org's counters are gone, not merely hidden.
    expect(evaluate({ orgId: "org-1", at: T_IN + 2 }).metrics.windowAttempts).toBe(0);
  });

  test("the alert buffer is capped at 100 and keeps the newest", () => {
    setAbuseConfig({
      velocity: velocityOff({ afterHoursWarn: 1, afterHoursPause: 100_000, burstWindowSec: 3600 }),
    });
    resetVelocityState();
    for (let i = 0; i < 130; i += 1) {
      const orgId = `org-alert-${i}`;
      recordAttempt({ orgId, e164: AE_A, at: T_OUT + i });
      evaluate({ orgId, at: T_OUT + i });
    }
    // An unbounded buffer would be a slow memory leak with a security
    // incident attached to it. 100 exactly, not "at least 100".
    expect(recentAlerts()).toHaveLength(100);
    expect(recentAlerts()[0]?.orgId).toBe("org-alert-30");
    expect(recentAlerts()[99]?.orgId).toBe("org-alert-129");
  });

  test("resetVelocityState clears attempts, breakers, evictions and alerts together", () => {
    // "The reset actually clears" — asserted across all four pieces of
    // state at once, because clearing the attempts while leaving the breaker
    // would leave an org permanently shut out with no visible cause.
    setAbuseConfig({ velocity: velocityOff({ burstRateMax: 1, burstWindowSec: 3600 }) });
    resetVelocityState();
    recordAttempt({ orgId: "org-rst", e164: AE_A, at: T_IN });
    expect(evaluate({ orgId: "org-rst", at: T_IN }).action).toBe("auto_pause");
    expect(isOrgPaused("org-rst", T_IN)).toBe(true);
    expect(recentAlerts().length).toBeGreaterThan(0);
    expect(velocitySnapshot().trackedOrgs).toBe(1);

    resetVelocityState();
    const snapshot = velocitySnapshot();
    expect(snapshot.trackedOrgs).toBe(0);
    expect(snapshot.attemptsTracked).toBe(0);
    expect(snapshot.orgStateEvicted).toBe(0);
    expect(snapshot.pausedOrgs).toBe(0);
    expect(snapshot.pausesEvicted).toBe(0);
    expect(snapshot.alertsBuffered).toBe(0);
    expect(isOrgPaused("org-rst", T_IN)).toBe(false);
    // And the org can actually dial again — the counters are gone, not just
    // the display of them.
    expect(evaluate({ orgId: "org-rst", at: T_IN }).action).toBe("allow");
    expect(evaluate({ orgId: "org-rst", at: T_IN }).metrics.windowAttempts).toBe(0);
  });

  test("a pause TTL of 0 is sticky until a human resumes; a positive TTL expires on its boundary", () => {
    setAbuseConfig({ velocity: velocityOff({ pauseTtlSec: 60 }) });
    resetVelocityState();
    pauseOrg("org-ttl", { at: T_IN });
    // A paused org is on the board while the pause is live. Read this
    // BEFORE the expiry checks below: `isOrgPaused` deletes the record as it
    // finds it expired, so checking expiry first would empty the board.
    expect(velocitySnapshot(T_IN).pausedOrgs).toBe(1);
    // Held for one second less than the TTL.
    expect(isOrgPaused("org-ttl", T_IN + 60 * SECOND - 1)).toBe(true);
    // Released at exactly the TTL: the comparison is `expiresAt <= now`.
    expect(isOrgPaused("org-ttl", T_IN + 60 * SECOND)).toBe(false);
    // An expired pause is not on the board either.
    expect(velocitySnapshot(T_IN + 60 * SECOND).pausedOrgs).toBe(0);

    // TTL 0 means "paused until a human resumes it" — an attacker who can
    // wait out a cooldown learns the cooldown, so there is no cooldown here.
    setAbuseConfig({ velocity: velocityOff({ pauseTtlSec: 0 }) });
    pauseOrg("org-sticky", { at: T_IN });
    expect(isOrgPaused("org-sticky", T_IN + 365 * 24 * HOUR)).toBe(true);
    expect(resumeOrg("org-sticky")).toBe(true);
    expect(isOrgPaused("org-sticky", T_IN)).toBe(false);
    // Resuming an org that is not paused reports that nothing happened, so
    // an operator UI cannot claim a success it did not achieve.
    expect(resumeOrg("org-sticky")).toBe(false);
  });

  test("the pause store is capped by maxTrackedOrgs and counts its evictions", () => {
    setAbuseConfig({ velocity: velocityOff({ maxTrackedOrgs: 2 }) });
    resetVelocityState();
    pauseOrg("org-p1", { at: T_IN });
    pauseOrg("org-p2", { at: T_IN + 1 });
    pauseOrg("org-p3", { at: T_IN + 2 });
    // A silently dropped breaker is worse than no breaker: the org looks
    // healthy and is still shut out. The count makes the gap observable.
    expect(velocitySnapshot(T_IN + 2).pausedOrgs).toBe(2);
    expect(velocitySnapshot(T_IN + 2).pausesEvicted).toBe(1);
  });

  test("velocitySnapshot reports the thresholds actually in force", () => {
    // If the snapshot and the enforced comparisons could disagree, an
    // operator tuning a threshold from the status surface would be tuning
    // something other than what the gate reads.
    setAbuseConfig({
      velocity: velocityOff({
        burstWindowSec: 11,
        burstRateMax: 12,
        newPrefixWindowSec: 13,
        newPrefixBurst: 14,
        afterHoursWarn: 15,
        afterHoursPause: 16,
        pauseTtlSec: 17,
      }),
    });
    expect(velocitySnapshot().thresholds).toEqual({
      burstWindowSec: 11,
      burstRateMax: 12,
      newPrefixWindowSec: 13,
      newPrefixBurst: 14,
      afterHoursWarn: 15,
      afterHoursPause: 16,
      pauseTtlSec: 17,
    });
  });

  test("an unusable org id or destination is never recorded", () => {
    // Both are attacker-influenced, and neither may create unbounded or
    // colliding state: a blank key would merge every malformed org into one
    // bucket and let any of them trip another's breaker.
    resetVelocityState();
    for (const orgId of ["", "!!!", "///", "   "]) {
      recordAttempt({ orgId, e164: AE_A, at: T_IN });
    }
    for (const e164 of ["", "not-a-number", "+971", "+971 50"]) {
      recordAttempt({ orgId: "org-ok", e164, at: T_IN });
    }
    expect(velocitySnapshot().attemptsTracked).toBe(0);
    expect(velocitySnapshot().trackedOrgs).toBe(0);
  });

  test("a Date instant and a NaN instant are both accepted without corrupting the window", () => {
    setAbuseConfig({ velocity: velocityOff({ burstWindowSec: 3600 }) });
    resetVelocityState();
    recordAttempt({ orgId: "org-date", e164: AE_A, at: new Date(T_IN) });
    expect(evaluate({ orgId: "org-date", at: new Date(T_IN) }).metrics.burstAttempts).toBe(1);

    // A NaN instant must not poison the window with NaN. `toMs` falls back
    // to the wall clock, so the attempt lands at "now" and is counted as a
    // single live attempt rather than making every later comparison false.
    recordAttempt({ orgId: "org-nan", e164: AE_A, at: Number.NaN });
    expect(evaluate({ orgId: "org-nan" }).metrics.burstAttempts).toBe(1);
  });
});

/* ── 3. guards.ts — every threshold enforced on both sides ───────────────── */

describe("guards: the cooldown holds for one instant less than its configured length", () => {
  test("cooldownSec blocks at cooldown-1ms and releases at exactly cooldown", () => {
    setAbuseConfig({
      concurrency: { ...DEFAULT_ABUSE_CONFIG.concurrency, cooldownSec: 300 },
    });
    const first = assertDialAllowed({
      orgId: "org-cd",
      e164: AE_A,
      planTier: "standard",
      at: T_IN,
    });
    expect(first.allowed).toBe(true);
    releaseDialSlot(first.slot);

    // One millisecond inside the window the destination is refused.
    expect(
      assertDialAllowed({
        orgId: "org-cd",
        e164: AE_A,
        planTier: "standard",
        at: T_IN + 300 * SECOND - 1,
      }).reason,
    ).toBe("destination_cooldown");

    // At exactly `cooldownSec` the comparison `now - last < cooldown` is
    // false and the dial proceeds. This is the boundary that matters: an
    // operator reading "300 second cooldown" means the second dial is
    // refused for 299.x seconds, not 300.
    expect(
      assertDialAllowed({
        orgId: "org-cd",
        e164: AE_A,
        planTier: "standard",
        at: T_IN + 300 * SECOND,
      }).allowed,
    ).toBe(true);
  });

  test("a cooldown of 0 refuses nothing, and the retry countdown is derived from the same clock", () => {
    setAbuseConfig({
      concurrency: { ...DEFAULT_ABUSE_CONFIG.concurrency, cooldownSec: 0 },
    });
    const first = assertDialAllowed({
      orgId: "org-cd0",
      e164: AE_A,
      planTier: "standard",
      at: T_IN,
    });
    releaseDialSlot(first.slot);
    expect(
      assertDialAllowed({ orgId: "org-cd0", e164: AE_A, planTier: "standard", at: T_IN }).allowed,
    ).toBe(true);

    // With a real cooldown the retry hint must be the number of seconds
    // actually remaining, and must stay positive at every refused instant.
    setAbuseConfig({
      concurrency: { ...DEFAULT_ABUSE_CONFIG.concurrency, cooldownSec: 300 },
    });
    resetDialState();
    const d = assertDialAllowed({ orgId: "org-cd1", e164: AE_A, planTier: "standard", at: T_IN });
    releaseDialSlot(d.slot);
    const refused = assertDialAllowed({
      orgId: "org-cd1",
      e164: AE_A,
      planTier: "standard",
      at: T_IN + 100 * SECOND,
    });
    expect(refused.reason).toBe("destination_cooldown");
    // 200 s remain, and the subscriber digits stay out of the detail line.
    expect(refused.detail).toContain("200s");
    expect(refused.detail).not.toContain("501234567");
  });
});

describe("guards: concurrency caps are enforced on both sides and never leak capacity", () => {
  test("the org cap admits exactly orgCap calls and refuses the next", () => {
    setAbuseConfig({
      concurrency: {
        ...DEFAULT_ABUSE_CONFIG.concurrency,
        orgCap: 2,
        globalCap: 100,
        cooldownSec: 0,
      },
    });
    const slots: (number | null)[] = [];
    for (let i = 0; i < 3; i += 1) {
      const d = assertDialAllowed({
        orgId: "org-cap",
        e164: AE_A,
        planTier: "standard",
        at: T_IN + i,
      });
      slots.push(d.allowed ? d.slot : null);
      if (i < 2) expect(d.allowed).toBe(true);
      else expect(d.reason).toBe("org_concurrency_cap");
    }
    expect(slots.filter((s) => s !== null)).toHaveLength(2);
    expect(activeOrgCalls("org-cap")).toBe(2);

    // Releasing one slot returns exactly one unit of capacity — the cap is
    // not a one-way ratchet, and releasing does not free two.
    releaseDialSlot(slots[0]);
    expect(activeOrgCalls("org-cap")).toBe(1);
    expect(
      assertDialAllowed({ orgId: "org-cap", e164: AE_A, planTier: "standard", at: T_IN + 9 })
        .allowed,
    ).toBe(true);
    expect(activeOrgCalls("org-cap")).toBe(2);
    expect(
      assertDialAllowed({ orgId: "org-cap", e164: AE_A, planTier: "standard", at: T_IN + 10 })
        .reason,
    ).toBe("org_concurrency_cap");
  });

  test("the global cap is shared across orgs and a refusal hands its org slot straight back", () => {
    setAbuseConfig({
      concurrency: {
        ...DEFAULT_ABUSE_CONFIG.concurrency,
        orgCap: 10,
        globalCap: 1,
        cooldownSec: 0,
      },
    });
    const first = assertDialAllowed({
      orgId: "org-g1",
      e164: AE_A,
      planTier: "standard",
      at: T_IN,
    });
    expect(first.allowed).toBe(true);

    const second = assertDialAllowed({
      orgId: "org-g2",
      e164: AE_A,
      planTier: "standard",
      at: T_IN,
    });
    expect(second.reason).toBe("global_concurrency_cap");
    // The refused org must hold NO capacity: without the hand-back, an org
    // that keeps hitting a full platform would accumulate reservations it
    // can never use, and its own cap would be exhausted by refusals.
    expect(dialStateSnapshot().activeByOrg["org-g2"]).toBeUndefined();
    expect(dialStateSnapshot().outstandingSlots).toBe(1);
    expect(activeGlobalCalls()).toBe(1);

    releaseDialSlot(first.slot);
    expect(activeGlobalCalls()).toBe(0);
    expect(dialStateSnapshot().outstandingSlots).toBe(0);
  });

  test("releaseDialSlot ignores unknown and non-numeric tokens without corrupting the count", () => {
    // Double-release and release-after-restart must both be safe:
    // over-releasing would hand the same slot out twice and break the cap.
    setAbuseConfig({
      concurrency: { ...DEFAULT_ABUSE_CONFIG.concurrency, orgCap: 5, globalCap: 5, cooldownSec: 0 },
    });
    const d = assertDialAllowed({ orgId: "org-rel", e164: AE_A, planTier: "standard", at: T_IN });
    expect(activeGlobalCalls()).toBe(1);

    for (const token of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 999_999]) {
      releaseDialSlot(token);
    }
    releaseDialSlot("3" as unknown as number);
    releaseDialSlot({} as unknown as number);
    // Not one of those may have released the real reservation.
    expect(activeGlobalCalls()).toBe(1);
    expect(activeOrgCalls("org-rel")).toBe(1);

    releaseDialSlot(d.slot);
    expect(activeGlobalCalls()).toBe(0);
    // Releasing the same token twice must not decrement past zero or hand
    // the same slot out again.
    releaseDialSlot(d.slot);
    expect(activeGlobalCalls()).toBe(0);
    expect(dialStateSnapshot().outstandingSlots).toBe(0);
  });

  test("an abandoned slot is reclaimed by its lease rather than wedging the org forever", () => {
    // A reservation is normally handed back when the call ends, which
    // crosses a request handler and a webhook and may never arrive. Without
    // a lease one lost release would shut an org out permanently.
    setAbuseConfig({
      concurrency: {
        ...DEFAULT_ABUSE_CONFIG.concurrency,
        orgCap: 1,
        globalCap: 10,
        cooldownSec: 0,
      },
    });
    // Deliberately NOT released.
    const leaked = assertDialAllowed({
      orgId: "org-lease",
      e164: AE_A,
      planTier: "standard",
      at: T_IN,
    });
    expect(leaked.allowed).toBe(true);
    expect(activeOrgCalls("org-lease")).toBe(1);

    // Still held one second before the 15-minute lease expires.
    expect(
      assertDialAllowed({
        orgId: "org-lease",
        e164: AE_B,
        planTier: "standard",
        at: T_IN + 15 * MINUTE - SECOND,
      }).reason,
    ).toBe("org_concurrency_cap");
    // Reclaimed at the lease boundary, and the global count comes back with
    // it — reclaiming the org slot without the global one would leak the
    // platform-wide counter until restart.
    const reclaimed = assertDialAllowed({
      orgId: "org-lease",
      e164: AE_B,
      planTier: "standard",
      at: T_IN + 15 * MINUTE,
    });
    expect(reclaimed.allowed).toBe(true);
    expect(activeGlobalCalls()).toBe(1);
  });

  test("the cooldown table is bounded and counts its evictions instead of dropping them silently", () => {
    setAbuseConfig({
      concurrency: { ...DEFAULT_ABUSE_CONFIG.concurrency, maxCooldownEntries: 3, cooldownSec: 300 },
    });
    for (let i = 0; i < 6; i += 1) {
      assertDialAllowed({
        orgId: `org-cd-${i}`,
        e164: AE_A,
        planTier: "standard",
        at: T_IN,
      });
    }
    const snapshot = dialStateSnapshot();
    expect(snapshot.cooldownEntries).toBe(3);
    expect(snapshot.cooldownEvicted).toBe(3);
  });

  test("a cooldown entry expires with its TTL, so a long-idle org is not remembered forever", () => {
    setAbuseConfig({
      concurrency: { ...DEFAULT_ABUSE_CONFIG.concurrency, cooldownSec: 300 },
    });
    assertDialAllowed({ orgId: "org-exp", e164: AE_A, planTier: "standard", at: T_IN });
    expect(dialStateSnapshot().cooldownEntries).toBe(1);
    // Pruned on the next write once it has aged out, so the table cannot be
    // used as unbounded storage by churning destinations.
    assertDialAllowed({
      orgId: "org-exp2",
      e164: AE_B,
      planTier: "standard",
      at: T_IN + 300 * SECOND,
    });
    expect(dialStateSnapshot().cooldownEntries).toBe(1);
  });
});

describe("guards: input shape and the never-throw contract", () => {
  test("a destination that is not a string denies rather than throwing", () => {
    // The gate runs inside request handlers on the hot path. A guard that
    // throws is an outage; a guard that denies is a decision. The throw is also
    // logged, so capture stderr to keep the stack out of the test log while
    // still asserting an operator would have been told.
    const logged: unknown[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]): void => {
      logged.push(args[0]);
    };
    try {
      const d = assertDialAllowed({
        orgId: "org-shape",
        e164: 12_345 as unknown as string,
        planTier: "standard",
        at: T_IN,
      });
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe("guard_internal_error");
      expect(d.slot).toBeNull();
      // A control that fails closed silently is not a control, so the decision
      // is announced on the error channel.
      expect(String(logged[0])).toContain("abuse guard failed closed");

      // FIXED (gap 8). The catch-all used to be recorded as
      // `control: "velocity"` regardless of where the throw happened, so an
      // operator reading `controls[]` was told the velocity control failed when
      // the actual fault was `input_shape`'s `.trim()`. The gate now tracks the
      // control in flight and attributes the failure to it.
      expect(d.controls.map((c) => c.control)).toEqual(["input_shape"]);
      expect(d.controls[0]?.reason).toBe("guard_internal_error");
    } finally {
      console.error = realError;
    }
  });

  test("an org id that sanitises to empty is refused before any other control", () => {
    // `safeOrgKey` strips every character outside `[\w.:-]`, so an id made
    // only of punctuation becomes the empty string and would collide with
    // every other such org in every map the gate owns.
    for (const orgId of ["", "   ", "!!!", "///", "***"]) {
      const d = assertDialAllowed({
        orgId,
        e164: AE_A,
        planTier: "standard",
        at: T_IN,
      });
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe("invalid_e164");
      expect(d.controls.map((c) => c.control)).toEqual(["input_shape"]);
    }
  });

  test("the gate resolves the deployment default tier when no tier is supplied", () => {
    // FIXED (gap 3). `TierConfig.defaultTier` is documented as the
    // deployment-wide fallback for a route that forgets to pass a tier, but
    // `assertDialAllowed` used to coerce `input.planTier` directly and never
    // read it — so a deployment setting `ABUSE_PLAN_TIER=enterprise` still got
    // `demo` here. `gatePlanTier` now resolves an omitted tier through the same
    // resolver `planTierFor` uses.
    setAbuseConfig({
      tier: { ...DEFAULT_ABUSE_CONFIG.tier, defaultTier: "enterprise" },
    });
    // No tier passed, and `enterprise` is not restricted to the test-number
    // list, so this now succeeds where it previously refused.
    const resolved = assertDialAllowed({ orgId: "org-dt", e164: AE_A, at: T_IN });
    expect(resolved.allowed).toBe(true);
    expect(resolved.reason).toBe("ok");
    releaseDialSlot(resolved.slot);

    // An explicitly supplied tier still wins verbatim.
    resetDialState();
    const standard = assertDialAllowed({
      orgId: "org-dt",
      e164: AE_A,
      planTier: "standard",
      at: T_IN + SECOND,
    });
    expect(standard.allowed).toBe(true);
    expect(standard.reason).toBe("ok");
    releaseDialSlot(standard.slot);
  });

  test("a SUPPLIED but unrecognised tier stays pinned to demo", () => {
    // Hardened beyond gap 3: naively resolving an omitted tier would also let a
    // garbage SUPPLIED value fall through to the deployment default, turning a
    // typo into whatever ABUSE_PLAN_TIER says — strictly MORE permissive than
    // before. An unrecognised supplied tier stays `demo`, exactly as
    // `coercePlanTier` always behaved.
    setAbuseConfig({
      tier: { ...DEFAULT_ABUSE_CONFIG.tier, defaultTier: "enterprise" },
    });
    for (const bad of ["Standard", 42, "", "galactic"]) {
      resetDialState();
      const d = assertDialAllowed({
        orgId: "org-badtier",
        e164: AE_A,
        planTier: bad as never,
        at: T_IN,
      });
      expect({ bad, reason: d.reason }).toEqual({ bad, reason: "test_number_list_empty" });
    }
  });

  test("resetDialState frees capacity but deliberately does not reopen a breaker", () => {
    // A call that exists to free a slot must never be able to clear a pause
    // an operator set. This asymmetry is load-bearing and easy to break by
    // "tidying up" the two reset helpers into one.
    setAbuseConfig({ velocity: velocityOff({ burstRateMax: 1, burstWindowSec: 3600 }) });
    recordAttempt({ orgId: "org-brk", e164: AE_A, at: T_IN });
    expect(evaluate({ orgId: "org-brk", at: T_IN }).action).toBe("auto_pause");

    // Put the burst threshold back out of the way so the slot-holding dial
    // below is not itself auto-paused; this test is about the two reset
    // helpers, not about the breaker tripping a second time.
    setAbuseConfig({ velocity: velocityOff({ burstWindowSec: 3600 }) });
    const held = assertDialAllowed({
      orgId: "org-hold",
      e164: AE_A,
      planTier: "standard",
      at: T_IN,
    });
    expect(held.allowed).toBe(true);
    expect(activeGlobalCalls()).toBe(1);

    resetDialState();
    expect(activeGlobalCalls()).toBe(0);
    expect(dialStateSnapshot().outstandingSlots).toBe(0);
    // Releasing a slot token after the state was cleared must not
    // resurrect or corrupt anything.
    releaseDialSlot(held.slot);
    expect(activeGlobalCalls()).toBe(0);
    // The breaker is untouched: only a human closes it.
    expect(isOrgPaused("org-brk", T_IN)).toBe(true);
    expect(
      assertDialAllowed({ orgId: "org-brk", e164: AE_A, planTier: "standard", at: T_IN }).reason,
    ).toBe("org_auto_paused");
  });
});

/* ── 4. config.ts — thresholds, validation and dead knobs ─────────────────── */

describe("config: numeric env values are validated, and the survivors are the ones you meant", () => {
  /**
   * KNOWN GAP 5: config.ts:53 claims a non-numeric value falls back to the
   * default. `Number()` is more permissive than that claim — hex, exponent
   * and fractional forms all parse to finite numbers at or above `min`, so
   * they are accepted as thresholds. Asserted as observed so that tightening
   * the validator is a visible test change rather than a silent one.
   */
  test("garbage, negatives and blanks fall back to the default; hex, exponent and fractions do not", () => {
    const read = (): number => resolveAbuseConfig().velocity.burstRateMax;
    expect(read()).toBe(DEFAULT_ABUSE_CONFIG.velocity.burstRateMax);

    // The documented fallbacks: unparseable, negative, or below `min`.
    for (const bad of [
      "off",
      "true",
      "",
      "   ",
      "-5",
      "-0.5",
      "0",
      "1_0",
      "Infinity",
      "-Infinity",
      "NaN",
      "1,000",
    ]) {
      process.env.ABUSE_BURST_RATE_MAX = bad;
      expect(read()).toBe(DEFAULT_ABUSE_CONFIG.velocity.burstRateMax);
    }

    // Surrounding whitespace is tolerated — operators paste from files.
    process.env.ABUSE_BURST_RATE_MAX = "  7  ";
    expect(read()).toBe(7);

    // Not tolerated, and documented as if they were: these are finite, at
    // or above `min`, so they become thresholds nobody intended. `5.7` as
    // an attempt count is meaningless, and `0x10` is a hex literal where a
    // decimal was meant.
    process.env.ABUSE_BURST_RATE_MAX = "0x10";
    expect(read()).toBe(16);
    process.env.ABUSE_BURST_RATE_MAX = "1e3";
    expect(read()).toBe(1000);
    process.env.ABUSE_BURST_RATE_MAX = "5.7";
    expect(read()).toBe(5.7);
  });

  test("each knob's own minimum is honoured, so a cap cannot be configured to nothing", () => {
    // `min` differs per knob and is the thing that stops `ABUSE_COOLDOWN_SEC=0`
    // and `ABUSE_BURST_RATE_MAX=0` from meaning different things by accident.
    // Asserted per knob because a shared default would hide a wrong `min`.
    process.env.ABUSE_COOLDOWN_SEC = "0";
    expect(resolveAbuseConfig().concurrency.cooldownSec).toBe(0);

    process.env.ABUSE_AFTER_HOURS_WARN = "0";
    process.env.ABUSE_AFTER_HOURS_PAUSE = "0";
    expect(resolveAbuseConfig().velocity.afterHoursWarn).toBe(0);
    expect(resolveAbuseConfig().velocity.afterHoursPause).toBe(0);

    // `min: 1` knobs reject 0 and keep the default: a zero cap would deny
    // every dial, which is not the same thing as "no cap".
    process.env.ABUSE_BURST_RATE_MAX = "0";
    process.env.ABUSE_GLOBAL_CONCURRENCY_CAP = "0";
    expect(resolveAbuseConfig().velocity.burstRateMax).toBe(
      DEFAULT_ABUSE_CONFIG.velocity.burstRateMax,
    );
    expect(resolveAbuseConfig().concurrency.globalCap).toBe(
      DEFAULT_ABUSE_CONFIG.concurrency.globalCap,
    );

    // `min: 60` and `min: 16` knobs have their own, higher floors.
    process.env.ABUSE_MAX_ATTEMPTS_PER_ORG = "1";
    expect(resolveAbuseConfig().velocity.maxAttemptsPerOrg).toBe(
      DEFAULT_ABUSE_CONFIG.velocity.maxAttemptsPerOrg,
    );
  });

  test("list-valued env vars are trimmed, de-blanked and de-duplicated", () => {
    process.env.ABUSE_ALLOWED_COUNTRIES = " AE , ,GB, ae ";
    process.env.ABUSE_TEST_NUMBERS = " +971501234567 , +971501234567 ,971521234567 ";
    const config = resolveAbuseConfig();
    // Case is preserved, so `ae` and `AE` survive as two entries — the geo
    // control upper-cases at comparison time, so this is cosmetic rather
    // than a hole, but a duplicate that outlives de-duplication is worth
    // pinning because it looks like a bug in the list.
    expect(config.geo.allowlist).toEqual(["AE", "GB", "ae"]);
    // The exact duplicate is removed at parse time; the two different
    // spellings of one number both survive and are reconciled later.
    expect(config.tier.testNumbers).toEqual(["+971501234567", "971521234567"]);

    // `testNumbersFor` reads the ACTIVE config, so reset for the env to take
    // effect. Both spellings of one number normalise to the same entry, so
    // the effective list is not doubled.
    resetAbuseConfig();
    expect(testNumbersFor(null)).toEqual([AE_A, AE_B]);
  });

  test("the deployment tier default is stored verbatim and only becomes a tier when it is coerced", () => {
    // KNOWN GAP (config side): config.ts:263 comments that an unrecognised
    // value "becomes demo", but it stores whatever was typed. The coercion
    // happens later, in `coercePlanTier`, so the invariant holds at the point
    // of use and not at the point of storage.
    process.env.ABUSE_PLAN_TIER = "galactic";
    expect(resolveAbuseConfig().tier.defaultTier).toBe("galactic");
    // `planTierFor` reads the ACTIVE config, so reset for the env to land.
    // The coercion is what makes an unrecognised value safe — not the
    // storage, which kept it verbatim.
    resetAbuseConfig();
    expect(planTierFor("org-unknown")).toBe("demo");

    // A blank value does become demo at parse time, via the `|| "demo"`
    // fallback rather than through coercion.
    process.env.ABUSE_PLAN_TIER = "   ";
    expect(resolveAbuseConfig().tier.defaultTier).toBe("demo");

    process.env.ABUSE_PLAN_TIER = "  enterprise  ";
    expect(resolveAbuseConfig().tier.defaultTier).toBe("enterprise");
    resetAbuseConfig();
    expect(planTierFor("org-ent")).toBe("enterprise");
  });

  test("the hard denylist and hard denied prefixes survive any env, and env can only add", () => {
    // This is the invariant that stops a widened allowlist from becoming
    // "dial anywhere": the safety net cannot be narrowed by configuration.
    expect(HARD_DENIED_COUNTRIES).toEqual(["RU", "IR", "KP", "SY"]);
    for (const country of HARD_DENIED_COUNTRIES) {
      expect(resolveAbuseConfig().geo.denylist).toContain(country);
    }
    // An env denylist is UNIONed onto the hard defaults, never substituted.
    process.env.ABUSE_DENIED_COUNTRIES = "AE,RU";
    const denylist = resolveAbuseConfig().geo.denylist;
    expect(denylist).toEqual(["RU", "IR", "KP", "SY", "AE"]);
    // `RU` was already there, so listing it again does not double it.
    expect(denylist.filter((c) => c === "RU")).toHaveLength(1);

    process.env.ABUSE_DENIED_PREFIXES = "+44,+800";
    const prefixes = resolveAbuseConfig().geo.deniedPrefixes;
    for (const prefix of HARD_DENIED_PREFIXES) expect(prefixes).toContain(prefix);
    expect(prefixes).toContain("+44");
    expect(prefixes.filter((p) => p === "+800")).toHaveLength(1);

    // Both lists are frozen, so a consumer cannot mutate the shared defaults
    // out from under every other module in the process.
    expect(Object.isFrozen(HARD_DENIED_COUNTRIES)).toBe(true);
    expect(Object.isFrozen(HARD_DENIED_PREFIXES)).toBe(true);
  });

  test("with no configuration at all every control fails closed", () => {
    // The deployment with zero ABUSE_* variables set: no country is
    // diallable, the demo tier dials nothing, and the hard denylist still
    // applies. Asserted together because each is individually obvious and
    // collectively is the property that matters.
    const pristine = resolveAbuseConfig();
    expect(pristine.geo.allowlist).toEqual([]);
    expect(pristine.tier.testNumbers).toEqual([]);
    expect(pristine.tier.defaultTier).toBe("demo");
    expect(pristine.geo.denylist).toEqual(HARD_DENIED_COUNTRIES);
    expect(pristine.geo.deniedPrefixes).toEqual(HARD_DENIED_PREFIXES);

    setAbuseConfig({ geo: { allowlist: [] }, tier: { testNumbers: [] } });

    // Geography runs before the tier control, so with both shut the geo
    // reason is the one an operator sees. That ordering is itself worth
    // pinning: it means a misconfigured allowlist masks a missing test
    // number list, and only one fix is actionable at a time.
    const demo = assertDialAllowed({ orgId: "org-pristine", e164: AE_A, at: T_IN });
    expect(demo.reason).toBe("geo_allowlist_unconfigured");

    // Open geography and the demo tier is still shut on its own account.
    setAbuseConfig({ geo: { allowlist: ["AE"] } });
    const tierOnly = assertDialAllowed({ orgId: "org-pristine", e164: AE_A, at: T_IN });
    expect(tierOnly.reason).toBe("test_number_list_empty");
    expect(tierOnly.controls.find((c) => c.control === "geo")?.ok).toBe(true);

    // A standard tier clears the tier control, and only then is anything
    // diallable at all.
    const standard = assertDialAllowed({
      orgId: "org-pristine",
      e164: AE_A,
      planTier: "standard",
      at: T_IN,
    });
    expect(standard.allowed).toBe(true);
    expect(standard.country).toBe("AE");
    releaseDialSlot(standard.slot);

    // The hard denylist is still in force with no other configuration:
    // widening the allowlist to include a denied country does not open it.
    setAbuseConfig({ geo: { allowlist: ["AE", "RU"] } });
    expect(checkDestinationGeoReason({ e164: "+79161234567", orgId: "org-pristine" })).toBe(
      "country_denied",
    );
    // And a shared-cost range is refused by prefix with the country
    // unresolvable, so the two defences agree rather than one masking the
    // other.
    expect(checkDestinationGeoReason({ e164: "+800123456789", orgId: "org-pristine" })).toBe(
      "destination_prefix_denied",
    );
  });

  test("setAbuseConfig merges one level deep, so a partial patch keeps its siblings", () => {
    // A patch naming one key must not reset the rest of its group: a caller
    // lowering `burstRateMax` should not also reset `burstWindowSec` and
    // widen the window underneath them. The merge is one level deep, which
    // is exactly the shape of AbuseConfig.
    setAbuseConfig({ velocity: velocityOff({ burstWindowSec: 45 }) });
    setAbuseConfig({ velocity: { burstRateMax: 3 } });
    const after = velocitySnapshot().thresholds;
    expect(after.burstRateMax).toBe(3);
    // The sibling survived the partial patch.
    expect(after.burstWindowSec).toBe(45);

    // A patch naming one group leaves the other three groups untouched.
    setAbuseConfig({ concurrency: { ...DEFAULT_ABUSE_CONFIG.concurrency, orgCap: 4 } });
    expect(velocitySnapshot().thresholds.burstRateMax).toBe(3);

    // Reset returns to the env-derived values, not to the last patch.
    resetAbuseConfig();
    expect(velocitySnapshot().thresholds.burstRateMax).toBe(
      DEFAULT_ABUSE_CONFIG.velocity.burstRateMax,
    );
  });

  test("the per-org env name convention upper-cases and replaces every non-alphanumeric character", () => {
    expect(orgAllowlistEnvName("org_acme")).toBe("ABUSE_ALLOWED_COUNTRIES__ORG_ACME");
    expect(orgAllowlistEnvName("acme-ltd/x")).toBe("ABUSE_ALLOWED_COUNTRIES__ACME_LTD_X");
    expect(orgPlanTierEnvName("org_acme")).toBe("ABUSE_PLAN_TIER__ORG_ACME");

    // FIXED (gap 4). The resolvers used to call these helpers with the
    // SANITISED key (`safeOrgKey(orgId)`), so for an id containing a character
    // `safeOrgKey` strips, the name the helper ADVERTISED was not the name that
    // was READ. The resolvers now pass the raw org id and the helpers do their
    // own folding, so the published convention is the one that is honoured.
    process.env.ABUSE_PLAN_TIER__ACME_LTD_X = "standard";
    expect(planTierFor("acme-ltd/x")).toBe("standard");
    delete process.env.ABUSE_PLAN_TIER__ACME_LTD_X;

    // The previously-honoured name is no longer read — that is the point: the
    // two spellings no longer disagree.
    process.env.ABUSE_PLAN_TIER__ACME_LTDX = "standard";
    expect(planTierFor("acme-ltd/x")).toBe("demo");
    delete process.env.ABUSE_PLAN_TIER__ACME_LTDX;

    // The same holds for the geo allowlist.
    process.env.ABUSE_ALLOWED_COUNTRIES__ORG_ACME = "JP";
    expect(geoPolicyFor("org_acme").allowlist).toEqual(["JP"]);
  });
});

/* ── 5. geo.ts — E.164 destination classification ────────────────────────── */

describe("geo: the E.164 canonicaliser defines what counts as a number at all", () => {
  test("separators and the 00 international prefix are stripped; everything else is refused", () => {
    // Every downstream control keys off this function, so anything it
    // refuses is undiallable and anything it accepts is treated as a real
    // number. The boundary cases are the ones that differ between operators.
    const accepted: readonly [string, string][] = [
      ["+971501234567", "+971501234567"],
      ["+971 50 123 4567", "+971501234567"],
      ["+971-50-123-4567", "+971501234567"],
      ["+971.50.123.4567", "+971501234567"],
      ["(+971) 50 123 4567", "+971501234567"],
      ["\t+971501234567\n", "+971501234567"],
      ["00971501234567", "+971501234567"],
      ["+971501234567", "+971501234567"],
    ];
    for (const [input, expected] of accepted) {
      expect(normaliseE164(input)).toBe(expected);
      expect(isE164(input)).toBe(true);
    }

    const refused: readonly string[] = [
      "",
      "   ",
      "971501234567", // no leading +
      "+971 50", // too short
      "++971501234567",
      "+0971501234", // leading zero is not a calling code
      "+97150123456789012", // 17 digits
      "not-a-number",
      "+",
      "+abc",
    ];
    for (const input of refused) {
      expect(normaliseE164(input)).toBeNull();
      expect(isE164(input)).toBe(false);
    }
  });

  test("E164_RE accepts 7 to 15 digits and no leading zero, on both sides of each boundary", () => {
    // The exact shape bounds. Seven digits is the shortest real E.164 number
    // and fifteen the longest; six and sixteen must both be refused, or the
    // mask and prefix functions below operate on lengths they never expect.
    expect(E164_RE.test("+1234567")).toBe(true); // 7 — shortest
    expect(E164_RE.test("+123456")).toBe(false); // 6 — one too few
    expect(E164_RE.test("+123456789012345")).toBe(true); // 15 — longest
    expect(E164_RE.test("+1234567890123456")).toBe(false); // 16 — one too many
    // The first digit is the country code and cannot be 0.
    expect(E164_RE.test("+0234567")).toBe(false);
    expect(E164_RE.test("+12345678")).toBe(true);
  });

  test("maskE164 keeps the country code and the last four and drops the rest", () => {
    // The mask is what reaches logs, alerts and audit metadata. The last
    // four survive because that is what an operator reconciles against a
    // carrier bill; everything between must not.
    expect(maskE164(AE_A)).toBe("+971****4567");
    expect(maskE164(GB_A)).toBe("+447****0123");
    expect(maskE164("+971 50 123 4567")).toBe("+971****4567");
    // A number too short to hold seven digits cannot reach this function —
    // E164_RE already refused it — so the `digits.length <= 4` branch is
    // dead. Asserted so that KNOWN GAP 7 stays visible until it is removed.
    expect(maskE164("not-a-number")).toBe("[invalid-number]");
    expect(maskE164("")).toBe("[invalid-number]");
    // At the shortest accepted length the mask is still well-formed.
    expect(maskE164("+1234567")).toBe("+123****4567");

    // The masked form never contains the subscriber digits of a real
    // number, at any accepted length.
    for (let len = 7; len <= 15; len += 1) {
      const digits = "987654321012345".slice(0, len);
      const masked = maskE164(`+${digits}`);
      expect(masked).toMatch(/^\+\d{3}\*{4}\d{4}$/);
      // Only the leading three and trailing four survive.
      expect(masked.replace(/\*/g, "")).toBe(`+${digits.slice(0, 3)}${digits.slice(-4)}`);
    }
  });

  test("destinationPrefix is the first five significant digits, and a bad number yields '+'", () => {
    // The velocity "new block" key. Five digits is country code plus the
    // mobile/area block, so two numbers in the same block share a prefix.
    expect(PREFIX_DIGITS).toBe(5);
    expect(destinationPrefix(AE_A)).toBe("+97150");
    expect(destinationPrefix(AE_B)).toBe("+97152");
    expect(destinationPrefix(GB_A)).toBe("+44770");
    expect(destinationPrefix("+971 50 123 4567")).toBe("+97150");
    // Formatting does not change the block, or an attacker would get a free
    // new prefix per dial by adding a space.
    expect(destinationPrefix("+971-50-123-4567")).toBe("+97150");
    // A number that cannot be canonicalised yields "+" rather than an
    // empty string. Harmless here because `recordAttempt` rejects the
    // unparseable number first, but it means the function is not total and a
    // caller that skipped validation would put every bad number in one
    // bucket.
    expect(destinationPrefix("not-a-number")).toBe("+");
    expect(destinationPrefix("")).toBe("+");
  });

  test("safeOrgKey strips unusable characters and truncates to 64", () => {
    // The key is sanitised before it becomes a Map key in every abuse store.
    // Unbounded keys are unbounded memory; an over-long one silently merges
    // two orgs into one bucket, which would share their breaker.
    expect(safeOrgKey("org.acme:eu-1_test")).toBe("org.acme:eu-1_test");
    expect(safeOrgKey("a b/c!d")).toBe("abcd");
    expect(safeOrgKey("")).toBe("");
    expect(safeOrgKey(null)).toBe("");
    expect(safeOrgKey(undefined)).toBe("");
    expect(safeOrgKey("x".repeat(200))).toHaveLength(64);
    // Two ids that differ only past the truncation point DO collide. That is
    // the documented tradeoff (truncate rather than reject), asserted so the
    // collision surface is a known quantity rather than a surprise.
    expect(safeOrgKey(`${"a".repeat(64)}-one`)).toBe(safeOrgKey(`${"a".repeat(64)}-two`));
  });
});

describe("geo: country resolution is offline, longest-prefix and validated", () => {
  test("representative calling codes resolve to their countries", () => {
    // One-digit NANP/Russia, two-digit Europe, three-digit Middle East and
    // Africa. Asserted individually because the failure mode is a table
    // typo that maps a real country to the wrong ISO code.
    const cases: readonly [string, string][] = [
      [AE_A, "AE"],
      [GB_A, "GB"],
      ["+12345678901", "US"],
      ["+819012345678", "JP"],
      ["+491701234567", "DE"],
      ["+919812345678", "IN"],
      ["+966512345678", "SA"],
      ["+8801712345678", "BD"],
      ["+27101234567", "ZA"],
      ["+2348012345678", "NG"],
    ];
    for (const [e164, country] of cases) {
      expect(resolveCountry(e164)).toBe(country);
    }
  });

  test("an unassigned calling code resolves to null rather than guessing", () => {
    // null means "unknown", and unknown fails closed. A resolver that
    // guessed would be a dial-anywhere default wearing a safety net.
    for (const e164 of [
      "+99912345678", // 999 is not assigned
      "+0112345678", // leading zero is not a calling code
      "+123456", // too short to be a number at all
      "not-a-number",
      "",
    ]) {
      expect(resolveCountry(e164)).toBeNull();
    }

    // Every entry of the hard denied prefix list resolves to no country at
    // all, so the prefix denylist in the geo control is genuinely a second
    // line of defence rather than the only one: the table cannot vouch for
    // these ranges either.
    for (const prefix of HARD_DENIED_PREFIXES) {
      expect(resolveCountry(`${prefix}123456789`)).toBeNull();
    }
  });

  test("the longest calling-code prefix wins, so a 3-digit code is never shadowed", () => {
    // The resolver tries 3 digits, then 2, then 1. If it tried shortest-first
    // then `+9715…` would match `+9` (absent) or `+97` (absent) — harmless
    // today — but `+44…` would match `+4` if `+4` ever existed, and `+1…`
    // must not swallow a NANP area code that later becomes a real entry.
    expect(prefixCountryResolver()(AE_A)).toBe("AE");
    expect(prefixCountryResolver()("+966512345678")).toBe("SA");
    expect(prefixCountryResolver()(GB_A)).toBe("GB");
    expect(prefixCountryResolver()("+12345678901")).toBe("US");
    expect(prefixCountryResolver()("+79161234567")).toBe("RU");
    // A number whose 3-digit prefix is unassigned falls through to the
    // shorter codes rather than failing outright.
    expect(prefixCountryResolver()("+70012345678")).toBe("RU");
  });

  test("every calling-code entry resolves to its own country, and none is shadowed", () => {
    // Table self-consistency. A duplicated or mistyped value would otherwise
    // ship unnoticed, and the shadowing check is what makes
    // longest-prefix-wins a safe rule rather than a hopeful one.
    const entries = Object.entries(COUNTRY_BY_CALLING_CODE);
    expect(entries.length).toBeGreaterThan(0);
    for (const [code, country] of entries) {
      // Every key is a 1-3 digit calling code with no leading zero, and
      // every value is an ISO-3166 alpha-2 code.
      expect(code).toMatch(/^[1-9]\d{0,2}$/);
      expect(country).toMatch(/^[A-Z]{2}$/);
      // Each entry is reachable: resolving a number built from that code
      // returns that code's own country. If this fails, a shorter key is
      // shadowing this one.
      expect(resolveCountry(`+${code}1234567`)).toBe(country);
    }
    // No 3-digit key shares a prefix with a 1- or 2-digit key that maps to a
    // DIFFERENT country — otherwise which country `+971…` resolves to would
    // depend on iteration order rather than on specificity.
    for (const [code, country] of entries) {
      if (code.length !== 3) continue;
      for (const len of [1, 2]) {
        const shorter = COUNTRY_BY_CALLING_CODE[code.slice(0, len)];
        expect(shorter ?? country).toBe(country);
      }
    }
    // Hard-denied countries that the table can resolve at all must resolve,
    // so the denylist is reachable rather than decorative.
    expect(resolveCountry("+79161234567")).toBe("RU");
    expect(resolveCountry("+9891212345")).toBe("IR");
    expect(resolveCountry("+9631123456")).toBe("SY");
  });

  test("resolver output is validated: only a two-letter code in, a country out", () => {
    // An injected resolver is trusted for the LOOKUP and not for the SHAPE.
    // A feed returning "GBR", "" or a number must not become a country that
    // an allowlist comparison then silently fails to match.
    const accepted: readonly [string, string][] = [
      ["DE", "DE"],
      ["de", "DE"], // case is normalised
      ["Gb", "GB"],
    ];
    for (const [raw, expected] of accepted) {
      expect(resolveCountry("+491701234567", () => raw)).toBe(expected);
    }
    const refused: readonly unknown[] = [
      "",
      "   ",
      "F",
      "FRA",
      "DE ",
      " DE",
      "D3",
      "12",
      "-1",
      null,
      undefined,
      0,
      1,
      {},
      [],
      ["DE"],
      true,
    ];
    for (const raw of refused) {
      expect(resolveCountry("+491701234567", () => raw as string)).toBeNull();
    }
    // An unresolvable destination short-circuits before the resolver runs.
    expect(resolveCountry("not-a-number", () => "DE")).toBeNull();
  });

  test("geoPolicyFor reads the registry, then the per-org env var, then the global config", () => {
    setAbuseConfig({ geo: { allowlist: ["GB"] } });
    expect(geoPolicyFor("org-x").allowlist).toEqual(["GB"]);

    process.env.ABUSE_ALLOWED_COUNTRIES__ORG_X = "jp, gb";
    // The per-org env var wins over the global list, and is upper-cased and
    // trimmed so the comparison downstream is case-insensitive.
    expect(geoPolicyFor("org-x").allowlist).toEqual(["JP", "GB"]);
    // Another org is unaffected by org-x's env var.
    expect(geoPolicyFor("org-y").allowlist).toEqual(["GB"]);

    setOrgGeoPolicy("org-x", { allowlist: ["AE"] });
    // The registry wins over the env var.
    expect(geoPolicyFor("org-x").allowlist).toEqual(["AE"]);
  });

  test("a per-org denylist adds to the hard one and can never subtract from it", () => {
    // Same invariant as the env union: an org may deny more, never less.
    setOrgGeoPolicy("org-tight", { allowlist: ["AE"], denylist: ["AE", "gb"] });
    const policy = geoPolicyFor("org-tight");
    expect(policy.allowlist).toEqual(["AE"]);
    for (const country of HARD_DENIED_COUNTRIES) {
      expect(policy.denylist).toContain(country);
    }
    // Registered entries are upper-cased on the way in, so a lowercase
    // entry still matches an upper-cased resolved country.
    expect(policy.denylist).toContain("GB");
    expect(policy.denylist).toContain("AE");
    // Duplicates collapse.
    expect(policy.denylist.filter((c) => c === "RU")).toHaveLength(1);
  });

  test("the per-call policy override is honoured and can only NARROW", () => {
    // FIXED (gap 2). `geoPolicyFor` declared `override` and documented it in
    // the precedence list, but the body never read it — so both
    // `checkDestinationGeo({ policy })` and `assertDialAllowed({ geoPolicy })`
    // passed a value that was discarded. The failure direction was FAIL-OPEN:
    // an org a route had narrowed to AE still reached GB.
    setAbuseConfig({ geo: { allowlist: ["GB"] } });
    expect(geoPolicyFor("org-x", { allowlist: ["AE"] }).allowlist).toEqual(["AE"]);

    // The narrowing now actually reaches the gate: a GB destination is refused
    // for an org whose per-call policy allows only AE.
    const viaGeo = assertDialAllowed({
      orgId: "org-narrow",
      e164: GB_A,
      planTier: "standard",
      geoPolicy: { allowlist: ["AE"] },
      at: T_IN,
    });
    expect(viaGeo.allowed).toBe(false);
    expect(viaGeo.reason).toBe("country_not_allowed");
    expect(viaGeo.slot).toBeNull();

    // Without the override the global allowlist still applies — the seam is
    // additive, not a replacement of the default path.
    const withoutOverride = assertDialAllowed({
      orgId: "org-narrow",
      e164: GB_A,
      planTier: "standard",
      at: T_IN,
    });
    expect(withoutOverride.allowed).toBe(true);
    expect(withoutOverride.country).toBe("GB");
    releaseDialSlot(withoutOverride.slot);

    // An override can ADD a denylist entry but never SUBTRACT the hard one: an
    // override naming a denied country still cannot re-open it.
    const hardDenied = "+79051234567";
    setAbuseConfig({ geo: { allowlist: ["RU", "GB"] } });
    const stillDenied = assertDialAllowed({
      orgId: "org-narrow",
      e164: hardDenied,
      planTier: "standard",
      geoPolicy: { allowlist: ["RU", "GB", "RU"], deniedPrefixes: [] },
      at: T_IN,
    });
    expect(stillDenied.allowed).toBe(false);
  });

  test("every step of the decision order refuses with its own reason", () => {
    // The order is deliberate — shape, then denied prefix, then country,
    // then denylist, then allowlist shape, then membership — and each step's
    // reason must stay distinct. An operator has to be able to tell "we
    // cannot tell where this goes" from "we know and the answer is no" from
    // "your allowlist is not configured". Table-driven so the expected
    // reason and the setup that produces it sit side by side.
    setAbuseConfig({ geo: { allowlist: ["AE"] } });
    // An empty per-org allowlist overrides the global one, which is how an
    // org reaches the "unconfigured" reason without touching the config.
    setOrgGeoPolicy("org-empty", { allowlist: [] });
    setOrgGeoPolicy("org-star", { allowlist: ["AE", "*"] });
    setOrgGeoPolicy("org-deny", { allowlist: ["AE", "RU"] });

    const steps: readonly [string, GeoInput, GeoRejectReason][] = [
      ["1. shape", { e164: "nope", orgId: "org-o" }, "invalid_e164"],
      [
        "2. denied prefix, ahead of any country lookup",
        { e164: "+800123456789", orgId: "org-o" },
        "destination_prefix_denied",
      ],
      ["3. country unknown", { e164: "+99912345678", orgId: "org-o" }, "country_unresolvable"],
      [
        "4. denylist beats a widened allowlist",
        { e164: "+79161234567", orgId: "org-deny" },
        "country_denied",
      ],
      ["5. empty allowlist", { e164: AE_A, orgId: "org-empty" }, "geo_allowlist_unconfigured"],
      ["5. wildcard allowlist", { e164: AE_A, orgId: "org-star" }, "geo_allowlist_misconfigured"],
      ["6. membership", { e164: "+819012345678", orgId: "org-o" }, "country_not_allowed"],
    ];
    for (const [label, input, reason] of steps) {
      expect(`${label}: ${checkDestinationGeoReason(input)}`).toBe(`${label}: ${reason}`);
    }

    // And the one allow, on the same fixture, so the table above is known to
    // be refusing for the stated reason rather than refusing everything.
    expect(checkDestinationGeo({ e164: AE_A, orgId: "org-o" })).toMatchObject({
      ok: true,
      country: "AE",
    });
  });

  test("a wildcard is refused in every spelling the token set recognises", () => {
    // "dial anywhere" is not a state this control can be in. Case and
    // surrounding whitespace must not smuggle a wildcard past the check.
    for (const token of ["*", "all", "ANY", "Any", " any ", "0", "ALL"]) {
      setOrgGeoPolicy("org-wild", { allowlist: ["AE", token] });
      expect(checkDestinationGeoReason({ e164: AE_A, orgId: "org-wild" })).toBe(
        "geo_allowlist_misconfigured",
      );
    }
    // A real country is not mistaken for a token.
    setOrgGeoPolicy("org-real", { allowlist: ["AE", "AL"] });
    expect(checkDestinationGeo({ e164: AE_A, orgId: "org-real" })).toMatchObject({ ok: true });
  });

  test("a denied prefix is checked against the canonical number and beats the country lookup", () => {
    // Defence in depth for destinations expressed in a form the resolver
    // cannot check. Asserted with a prefix that is NOT a country code, so
    // the prefix check is demonstrably what refuses it.
    setOrgGeoPolicy("org-pfx", { allowlist: ["AE"], deniedPrefixes: ["+971"] });
    // `+971` denies every AE destination, including ones on the allowlist.
    expect(checkDestinationGeoReason({ e164: AE_A, orgId: "org-pfx" })).toBe(
      "destination_prefix_denied",
    );
    // A denied prefix never widens: an unlisted country is still unlisted.
    setOrgGeoPolicy("org-pfx2", { allowlist: ["AE"], deniedPrefixes: ["+999"] });
    expect(checkDestinationGeoReason({ e164: "+99912345678", orgId: "org-pfx2" })).toBe(
      "destination_prefix_denied",
    );
  });
});
