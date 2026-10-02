import "server-only";
/**
 * Abuse & toll-fraud control configuration (WP-14).
 *
 * Every knob the abuse controls read lives here, resolved once from `ABUSE_*`
 * env vars with a programmatic override for tests and for the tenant service
 * (`setAbuseConfig`). Nothing else in `src/lib/abuse/**` touches `process.env`,
 * so "one file to audit before the demo" stays true.
 *
 * (`@/lib/config` is outside this work package's write scope, so the ABUSE_*
 * accessors live here. Folding them into the central config module is a
 * one-liner-per-key follow-up.)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEFAULTS ARE FAIL-CLOSED. With no configuration at all:
 *   · no country is diallable         → geo_allowlist_unconfigured
 *   · the demo tier may dial nothing  → test_number_list_empty
 *   · the hard denylist still applies → country_denied / destination_prefix_denied
 *
 * That is deliberate. A toll-fraud control that is open by default is not a
 * control, and both of those defaults are one env var away from working:
 *   ABUSE_ALLOWED_COUNTRIES=AE,GB,IN,EG     # who may be dialled
 *   ABUSE_TEST_NUMBERS=+971501234567        # the demo tier's verified test numbers
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ENV VARS (all optional — the values below are what you get if unset)
 *
 *   Geography
 *     ABUSE_ALLOWED_COUNTRIES        AE,GB            ISO-2 allowlist (global)
 *     ABUSE_ALLOWED_COUNTRIES__<ORG> AE,GB            per-org override (see geo.ts)
 *     ABUSE_DENIED_COUNTRIES         AF,SY            UNIONed onto the hard denylist
 *     ABUSE_DENIED_PREFIXES          +800             UNIONed onto the hard prefixes
 *
 *   Plan tier
 *     ABUSE_TEST_NUMBERS              +97150...       verified test numbers
 *
 *   Dials
 *     ABUSE_COOLDOWN_SEC              300             per (org, destination)
 *     ABUSE_ORG_CONCURRENCY_CAP      10              simultaneous calls per org
 *     ABUSE_GLOBAL_CONCURRENCY_CAP   25              simultaneous calls, all orgs
 *
 *   Velocity
 *     ABUSE_BURST_WINDOW_SEC          60              burst-rate window
 *     ABUSE_BURST_RATE_MAX           20              attempts/window → auto-pause
 *     ABUSE_NEW_PREFIX_WINDOW_SEC    900             new-prefix window
 *     ABUSE_NEW_PREFIX_BURST         3               distinct new prefixes → auto-pause
 *     ABUSE_AFTER_HOURS_WARN         5               out-of-hours attempts → warn
 *     ABUSE_AFTER_HOURS_PAUSE        12              out-of-hours attempts → auto-pause
 *     ABUSE_BUSINESS_HOURS_START_UTC 6               "in hours" definition
 *     ABUSE_BUSINESS_HOURS_END_UTC   22
 *
 *   Memory bounds / pause lifetime
 *     ABUSE_MAX_TRACKED_ORGS         5000            bounded state (see velocity.ts)
 *     ABUSE_MAX_ATTEMPTS_PER_ORG     500
 *     ABUSE_MAX_PREFIXES_PER_ORG     256
 *     ABUSE_MAX_COOLDOWN_ENTRIES     2000
 *     ABUSE_PAUSE_TTL_SEC            0               0 = paused until a human resumes
 *
 * Every numeric value is validated on read: a non-numeric or negative value
 * falls back to the default rather than disabling the control it configures
 * (`Number("off") || 20` would return 20; `Number("") || 0` would return 0 —
 * the kind of silent fail-open a cap must never do).
 */

export type GeoConfig = {
  /** ISO-3166 alpha-2 countries that may be dialled. Empty = nothing allowed. */
  allowlist: readonly string[];
  /** Always-deny countries. Union'd onto the hard defaults; wins over the allowlist. */
  denylist: readonly string[];
  /** E.164 prefixes that may never be dialled, whatever the country resolves to. */
  deniedPrefixes: readonly string[];
};

export type TierConfig = {
  /**
   * Verified test numbers the `demo` tier may dial. Exact E.164, or a prefix
   * ending in `*` (e.g. `+1500555*`). Empty = the demo tier may dial nothing.
   */
  testNumbers: readonly string[];
  /**
   * The tier an ORG falls back to when nothing names it specifically.
   *
   * WHY THIS EXISTS: `assertDialAllowed` defaults an unset `planTier` to
   * `demo` — the strictest tier, so an unset value fails closed. That default
   * is correct for the guard and wrong for a route that forgets to pass one:
   * a live bank org was being evaluated as a demo tenant and refused with
   * `demo_tier_requires_test_number`. `tiers.planTierFor()` is what resolves
   * the org's real tier; this is the deployment-wide fallback it lands on.
   * Unset ⇒ `demo`, unchanged, so the fail-closed default survives.
   */
  defaultTier: string;
};

export type VelocityConfig = {
  /** Window used by the burst-rate signal. */
  burstWindowSec: number;
  /** Attempts inside the burst window that trip an auto-pause. */
  burstRateMax: number;
  /** Window used by the new-destination-prefix signal. */
  newPrefixWindowSec: number;
  /** Distinct newly-seen destination prefixes in that window that trip an auto-pause. */
  newPrefixBurst: number;
  /** Out-of-hours attempts that produce a `warn`. */
  afterHoursWarn: number;
  /** Out-of-hours attempts that produce an `auto_pause`. */
  afterHoursPause: number;
  /** Start of "in hours", inclusive, in UTC hours. */
  businessHoursStartUtc: number;
  /** End of "in hours", exclusive, in UTC hours. Wrap-around is supported (22 → 6). */
  businessHoursEndUtc: number;
  /** How far back attempt state is retained. Pruned on write. */
  attemptWindowSec: number;
  /** Attempts retained per org before the oldest are dropped. */
  maxAttemptsPerOrg: number;
  /** Distinct destination prefixes retained per org. */
  maxPrefixesPerOrg: number;
  /** Organisations tracked in velocity state before oldest-first eviction. */
  maxTrackedOrgs: number;
  /** Seconds an auto-pause survives with no traffic. 0 = until resumed by a human. */
  pauseTtlSec: number;
};

export type ConcurrencyConfig = {
  /** Minimum seconds between two dials to the same destination, per org. */
  cooldownSec: number;
  /** Simultaneous calls allowed for one org. */
  orgCap: number;
  /** Simultaneous calls allowed across all orgs on this node. */
  globalCap: number;
  /** Live (org, destination) cooldown entries before oldest-first eviction. */
  maxCooldownEntries: number;
};

export type AbuseConfig = {
  geo: GeoConfig;
  tier: TierConfig;
  velocity: VelocityConfig;
  concurrency: ConcurrencyConfig;
};

/**
 * Countries refused by default regardless of any allowlist.
 *
 * Rationale is toll fraud + sanctions screening, not politics: these are the
 * origination/termination markets that dominate international premium-rate and
 * "SIM-box" fraud, and none of them is in the deployed customer footprint.
 * Env vars can only ADD to this list (never remove entries) — an operator who
 * widens the allowlist cannot accidentally re-open these.
 *
 * NOTE: this is not sanctions advice. Before a real launch, run the full
 * destination list past counsel and the acquirer's compliance function; the
 * carrier console's own geo-lock (a manual step, see the runbook) is the
 * backstop this list cannot replace.
 */
export const HARD_DENIED_COUNTRIES: readonly string[] = Object.freeze(["RU", "IR", "KP", "SY"]);

/**
 * ITU shared-cost / non-geographic service ranges, refused as prefixes.
 *
 * These are service codes, not assigned country calling codes, so the country
 * resolver refuses them too — this list is defence in depth for the case where
 * a destination is expressed in a form our resolver cannot check (a carrier
 * accepting an unassigned code, a local-format number dialled via a trunk).
 *
 * KNOWN GAP, stated rather than hidden: NANP premium ranges (+1 900, +1 976)
 * are not covered, because +1 is a single calling code and separating them
 * needs area-code metadata this module deliberately does not embed. Cover it
 * with the carrier-level control, or swap in a full libphonenumber table.
 */
export const HARD_DENIED_PREFIXES: readonly string[] = Object.freeze([
  "+800", // international toll-free
  "+808", // shared cost
  "+870", // shared cost / INternational
  "+878", // universal personal telecom
  "+881", // shared cost
  "+882", // international networks
  "+883", // international networks
  "+888", // shared cost / disaster relief
  "+979", // international premium rate
]);

export const DEFAULT_ABUSE_CONFIG: AbuseConfig = {
  geo: { allowlist: [], denylist: HARD_DENIED_COUNTRIES, deniedPrefixes: HARD_DENIED_PREFIXES },
  // No built-in test numbers: a number we guessed was a test number is a real
  // person's phone. The list is explicitly configured (env) or injected.
  tier: { testNumbers: [], defaultTier: "demo" },
  velocity: {
    burstWindowSec: 60,
    burstRateMax: 20,
    newPrefixWindowSec: 900,
    newPrefixBurst: 3,
    afterHoursWarn: 5,
    afterHoursPause: 12,
    businessHoursStartUtc: 6,
    businessHoursEndUtc: 22,
    attemptWindowSec: 3600,
    maxAttemptsPerOrg: 500,
    maxPrefixesPerOrg: 256,
    maxTrackedOrgs: 5000,
    pauseTtlSec: 0,
  },
  concurrency: {
    cooldownSec: 300,
    orgCap: 10,
    globalCap: 25,
    maxCooldownEntries: 2000,
  },
};

function num(name: string, dflt: number, min: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return dflt;
  return n;
}

function list(name: string): string[] {
  return (process.env[name] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function dedupe(xs: readonly string[]): string[] {
  return [...new Set(xs.map((s) => s.trim()).filter(Boolean))];
}

/** Union that keeps the hard defaults first — env can add, never subtract. */
function unionHardDefaults(hard: readonly string[], extra: readonly string[]): string[] {
  return dedupe([...hard, ...extra]);
}

/**
 * Per-org allowlist env convention: `ABUSE_ALLOWED_COUNTRIES__<ORG>` where
 * `<ORG>` is the org id upper-cased with every non-alphanumeric character
 * replaced by `_` (org_acme → ABUSE_ALLOWED_COUNTRIES__ORG_ACME).
 *
 * This exists so a deployment can be configured without code changes; the
 * in-process registry in geo.ts is the better path once orgs are dynamic.
 */
export function orgAllowlistEnvName(orgId: string): string {
  return `ABUSE_ALLOWED_COUNTRIES__${orgId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** Build a config from env + defaults. Pure: pass an env stub to test it. */
export function resolveAbuseConfig(
  env: Record<string, string | undefined> = process.env,
): AbuseConfig {
  const d = DEFAULT_ABUSE_CONFIG;
  return {
    geo: {
      // No allowlist default: empty means "dial nowhere", which is the safe
      // reading of an unset key. Explicit `AE,GB` to open up.
      allowlist: dedupe(list("ABUSE_ALLOWED_COUNTRIES")),
      denylist: unionHardDefaults(d.geo.denylist, list("ABUSE_DENIED_COUNTRIES")),
      deniedPrefixes: unionHardDefaults(d.geo.deniedPrefixes, list("ABUSE_DENIED_PREFIXES")),
    },
    tier: {
      testNumbers: dedupe(list("ABUSE_TEST_NUMBERS")),
      // Fail closed: an unrecognised value is not a licence to dial, it is a
      // typo, so anything that is not a known tier becomes `demo`.
      defaultTier: (process.env.ABUSE_PLAN_TIER ?? "demo").trim() || "demo",
    },
    velocity: {
      burstWindowSec: num("ABUSE_BURST_WINDOW_SEC", d.velocity.burstWindowSec, 1),
      burstRateMax: num("ABUSE_BURST_RATE_MAX", d.velocity.burstRateMax, 1),
      newPrefixWindowSec: num("ABUSE_NEW_PREFIX_WINDOW_SEC", d.velocity.newPrefixWindowSec, 1),
      newPrefixBurst: num("ABUSE_NEW_PREFIX_BURST", d.velocity.newPrefixBurst, 1),
      afterHoursWarn: num("ABUSE_AFTER_HOURS_WARN", d.velocity.afterHoursWarn, 0),
      afterHoursPause: num("ABUSE_AFTER_HOURS_PAUSE", d.velocity.afterHoursPause, 0),
      businessHoursStartUtc: num("ABUSE_BUSINESS_HOURS_START_UTC", d.velocity.businessHoursStartUtc, 0),
      businessHoursEndUtc: num("ABUSE_BUSINESS_HOURS_END_UTC", d.velocity.businessHoursEndUtc, 0),
      attemptWindowSec: num("ABUSE_ATTEMPT_WINDOW_SEC", d.velocity.attemptWindowSec, 60),
      maxAttemptsPerOrg: num("ABUSE_MAX_ATTEMPTS_PER_ORG", d.velocity.maxAttemptsPerOrg, 16),
      maxPrefixesPerOrg: num("ABUSE_MAX_PREFIXES_PER_ORG", d.velocity.maxPrefixesPerOrg, 4),
      maxTrackedOrgs: num("ABUSE_MAX_TRACKED_ORGS", d.velocity.maxTrackedOrgs, 1),
      pauseTtlSec: num("ABUSE_PAUSE_TTL_SEC", d.velocity.pauseTtlSec, 0),
    },
    concurrency: {
      cooldownSec: num("ABUSE_COOLDOWN_SEC", d.concurrency.cooldownSec, 0),
      orgCap: num("ABUSE_ORG_CONCURRENCY_CAP", d.concurrency.orgCap, 1),
      globalCap: num("ABUSE_GLOBAL_CONCURRENCY_CAP", d.concurrency.globalCap, 1),
      maxCooldownEntries: num("ABUSE_MAX_COOLDOWN_ENTRIES", d.concurrency.maxCooldownEntries, 1),
    },
  };
}

let active: AbuseConfig = resolveAbuseConfig();

/** The config in force right now. Cheap; returns the same object until changed. */
export function abuseConfig(): AbuseConfig {
  return active;
}

type AbuseConfigPatch = {
  geo?: Partial<GeoConfig>;
  tier?: Partial<TierConfig>;
  velocity?: Partial<VelocityConfig>;
  concurrency?: Partial<ConcurrencyConfig>;
};

/**
 * Override the active config (tests, and per-deployment wiring at boot).
 *
 * Call `resetAbuseConfig()` to go back to env-derived values. A merge is one
 * level deep, which is exactly the shape of `AbuseConfig` — nothing here needs
 * to be clever enough to be surprising.
 */
export function setAbuseConfig(patch: AbuseConfigPatch): AbuseConfig {
  active = {
    geo: { ...active.geo, ...patch.geo },
    tier: { ...active.tier, ...patch.tier },
    velocity: { ...active.velocity, ...patch.velocity },
    concurrency: { ...active.concurrency, ...patch.concurrency },
  };
  return active;
}

/** Back to env-derived values. Test helper; also safe to call at boot. */
export function resetAbuseConfig(): void {
  active = resolveAbuseConfig();
}