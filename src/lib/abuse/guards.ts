import "server-only";
/**
 * The abuse dial gate (WP-14) — one call, one typed decision.
 *
 *   assertDialAllowed({ orgId, e164, at, planTier })
 *     → { allowed, verdict, reason, detail, controls[], slot, active }
 *
 * WHY THIS EXISTS NEXT TO policy-gate.ts
 *   policy-gate.ts (WP-2) is the authorization layer: consent → country →
 *   cooldown → concurrency → spend → credits. It answers "may this org place
 *   this call?". This module is the abuse-specific half of the same question,
 *   hardened:
 *
 *     · country  → per-org scoping + a DENYLIST a widened allowlist cannot
 *                  switch off (policy-gate has an allowlist only)
 *     · tier     → NEW: the demo tier may dial verified test numbers only
 *     · cooldown → org-scoped rather than global, so one tenant's guard never
 *                  denies another tenant
 *     · caps     → org cap AND a global cap across every org on this node
 *     · velocity → NEW: new-prefix / burst-rate / out-of-hours, with a sticky
 *                  auto-pause breaker
 *
 *   The two compose rather than conflict: run this before or after policy-gate
 *   — the controls are independent and the ordering only decides which typed
 *   reason an operator sees first. Migrating the routes to this gate and
 *   dropping the duplicated steps from policy-gate.ts is the intended end
 *   state, but policy-gate.ts is outside this work package's write scope, so
 *   for now both layers run and neither has been removed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NEVER THROWS. This runs inside request handlers on the hot path; a guard that
 * can throw is an outage. Every internal failure degrades to a typed deny
 * (guard_internal_error) instead of propagating, and no destination appears
 * unmasked in `detail`.
 *
 * ATOMICITY IS LOAD-BEARING: the whole function is synchronous, so
 * check-and-reserve is one unbroken tick of the event loop. Without that, 50
 * simultaneous requests all read "9 active" and all reserve. Do not introduce
 * an `await` in this file's gate path.
 */

import { abuseConfig } from "./config";
import {
  checkDestinationGeo,
  maskE164,
  normaliseE164,
  safeOrgKey,
  type CountryResolver,
  type GeoPolicy,
  type GeoRejectReason,
} from "./geo";
import {
  checkPlanTier,
  isPlanTier,
  planTierFor,
  type PlanTier,
  type TierRejectReason,
} from "./tiers";
import {
  evaluate,
  isOrgPaused,
  recordAttempt,
  velocitySnapshot,
  type VelocityRejectReason,
} from "./velocity";

/* ── Decision types ───────────────────────────────────────────────────────── */

export type AbuseReason =
  | GeoRejectReason
  | TierRejectReason
  | VelocityRejectReason
  /** Minimum seconds between two dials to the same destination, per org. */
  | "destination_cooldown"
  /** Simultaneous calls for this org are at the cap. */
  | "org_concurrency_cap"
  /** Simultaneous calls across all orgs are at the cap. */
  | "global_concurrency_cap"
  /** A control raised an unexpected error. Fails closed — and it is a bug. */
  | "guard_internal_error";

export type ControlName =
  | "input_shape"
  | "breaker"
  | "geo"
  | "plan_tier"
  | "cooldown"
  | "org_concurrency"
  | "global_concurrency"
  | "velocity";

/** One control's outcome. Present for every control that ran, in order. */
export type ControlOutcome = {
  control: ControlName;
  ok: boolean;
  /** Machine-readable; "ok" when this control passed. */
  reason: AbuseReason | "ok";
  detail: string;
};

export type DialGuardVerdict = "allow" | "warn" | "auto_pause" | "deny";

export type DialGuardDecision = {
  /** The only field a route needs to branch on. */
  allowed: boolean;
  verdict: DialGuardVerdict;
  /** "ok" when allowed or warned; machine-readable in every case. */
  reason: AbuseReason | "ok";
  /** Human-readable, destination masked. Safe to log and to surface. */
  detail: string;
  /** Resolved destination country, when resolution got that far. */
  country: string | null;
  /** Every control that ran, in evaluation order. */
  controls: ControlOutcome[];
  /** Concurrency reservation — hand back via releaseDialSlot() when call ends. */
  slot: number | null;
  /** Observed load at decision time: the numbers a cap assertion needs. */
  active: { org: number; global: number };
  /** Velocity signals that fired (empty when none did). */
  velocitySignals: string[];
};

export type DialGuardInput = {
  orgId: string;
  e164: string;
  /** Defaults to now. Injected in tests so windows are deterministic. */
  at?: number | Date;
  /**
   * OMITTED ⇒ resolved for this org by `planTierFor()`: runtime registry →
   * `ABUSE_PLAN_TIER__<ORG>` → the deployment default `ABUSE_PLAN_TIER` →
   * `demo`. That last step is the fail-closed floor and it survives: with
   * nothing configured, an unset tier is still `demo`.
   *
   * SUPPLIED ⇒ used verbatim when it is a real tier, and otherwise ignored
   * (falls through to the resolver). A bad value is a typo, not a licence.
   */
  planTier?: PlanTier | string | null;
  /** Per-call geography override (a route that already loaded the tenant). */
  geoPolicy?: Partial<GeoPolicy>;
  /** Per-call country-resolver override. */
  resolver?: CountryResolver | null;
  /** Per-call verified test-number list override. */
  testNumbers?: Iterable<string> | null;
};

/* ── Bounded in-process state (single node — see the caveat below) ─────────── */

/**
 * Concurrency + cooldown state is per process. With N instances behind a load
 * balancer, the effective caps are N× these numbers and cooldown is per node.
 * Correct for the single-node reference deployment; production wants these in a
 * shared store. Every map here is bounded so the state cannot grow without
 * limit — and the two that can be evicted under pressure (cooldown entries,
 * paused orgs in velocity.ts) COUNT their evictions so the gap is observable.
 */
const ORG_ACTIVE = new Map<string, number>();
let globalActive = 0;

/** slot token → orgKey. Bounded by construction: at most one entry per
 *  outstanding reservation, and reservations stop at the global cap. */
const SLOTS = new Map<number, string>();
/** slot token -> lease, so a lost release cannot wedge an organisation. */
const SLOT_LEASES = new Map<number, { orgKey: string; expiresAt: number }>();
let nextSlot = 1;

/** `${org}|${e164}` → last dial instant (epoch ms). Insertion-ordered. */
const COOLDOWNS = new Map<string, number>();
let cooldownEvicted = 0;

export function activeOrgCalls(orgId: string): number {
  return ORG_ACTIVE.get(orgId) ?? 0;
}

export function activeGlobalCalls(): number {
  return globalActive;
}

/**
 * Slot lease.
 *
 * A concurrency reservation is normally handed back when the call ends. That
 * release is best-effort by nature — it crosses a request handler and a
 * post-call webhook, which may be a different process or may simply never
 * arrive. Without a lease, one lost release would wedge an organisation's
 * dialling permanently, which is a far worse failure than briefly over-counting
 * concurrency. So every reservation carries an expiry and expired slots are
 * reclaimed on the next decision.
 */
const SLOT_LEASE_MS = 15 * 60_000;

/** Reclaim reservations whose holder never gave the slot back. */
function pruneExpiredSlots(now: number): void {
  if (SLOTS.size === 0) return;
  for (const [slot, lease] of SLOT_LEASES) {
    if (now < lease.expiresAt) continue;
    const orgKey = lease.orgKey;
    SLOTS.delete(slot);
    SLOT_LEASES.delete(slot);
    const next = (ORG_ACTIVE.get(orgKey) ?? 1) - 1;
    if (next <= 0) ORG_ACTIVE.delete(orgKey);
    else ORG_ACTIVE.set(orgKey, next);
    globalActive = Math.max(0, globalActive - 1);
  }
}

/**
 * Give a slot back. No-op for an unknown token, because double-release and
 * release-after-restart must both be safe: over-releasing would hand out the
 * same slot twice and break the cap.
 */
export function releaseDialSlot(slot: number | null | undefined): void {
  if (typeof slot !== "number" || !Number.isFinite(slot)) return;
  const orgKey = SLOTS.get(slot);
  if (orgKey === undefined) return;
  SLOTS.delete(slot);
  SLOT_LEASES.delete(slot);
  const next = (ORG_ACTIVE.get(orgKey) ?? 1) - 1;
  if (next <= 0) ORG_ACTIVE.delete(orgKey);
  else ORG_ACTIVE.set(orgKey, next);
  globalActive = Math.max(0, globalActive - 1);
}

function cooldownKey(orgKey: string, e164: string): string {
  // Both halves are already shape-validated by the time this is called, so the
  // key cannot be an unbounded attacker-chosen string.
  return `${orgKey}|${e164}`;
}

function pruneCooldowns(now: number, ttlMs: number): void {
  if (!Number.isFinite(ttlMs)) return;
  for (const [k, at] of COOLDOWNS) if (now - at >= ttlMs) COOLDOWNS.delete(k);
}

type Reservation =
  | { ok: true; slot: number; orgActive: number; globalActive: number }
  | { ok: false; control: ControlName; reason: AbuseReason; detail: string };

/**
 * Per-destination cooldown + both concurrency caps, checked and reserved in one
 * synchronous step. Org slot first, then global; if global is full the org slot
 * is handed straight back, so a refusal never leaks capacity.
 */
function reserveDial(orgKey: string, e164: string, now: number): Reservation {
  const cfg = abuseConfig().concurrency;

  // Reclaim lapsed reservations BEFORE counting, using the caller's clock so
  // the decision is deterministic under an injected `at`.
  pruneExpiredSlots(now);

  const last = COOLDOWNS.get(cooldownKey(orgKey, e164));
  if (last !== undefined && now - last < cfg.cooldownSec * 1000) {
    const retryIn = Math.ceil((cfg.cooldownSec * 1000 - (now - last)) / 1000);
    return {
      ok: false,
      control: "cooldown",
      reason: "destination_cooldown",
      detail: `destination ${maskE164(e164)} was dialled by this organisation ${retryIn}s ago (cooldown ${cfg.cooldownSec}s)`,
    };
  }

  const orgActive = ORG_ACTIVE.get(orgKey) ?? 0;
  if (orgActive >= cfg.orgCap) {
    return {
      ok: false,
      control: "org_concurrency",
      reason: "org_concurrency_cap",
      detail: `organisation concurrency cap reached (${orgActive}/${cfg.orgCap})`,
    };
  }

  if (globalActive >= cfg.globalCap) {
    return {
      ok: false,
      control: "global_concurrency",
      reason: "global_concurrency_cap",
      detail: `platform concurrency cap reached (${globalActive}/${cfg.globalCap})`,
    };
  }

  const slot = nextSlot++;
  ORG_ACTIVE.set(orgKey, orgActive + 1);
  globalActive += 1;
  SLOTS.set(slot, orgKey);
  SLOT_LEASES.set(slot, { orgKey, expiresAt: now + SLOT_LEASE_MS });

  const ttl = cfg.cooldownSec * 1000;
  pruneCooldowns(now, ttl);
  COOLDOWNS.set(cooldownKey(orgKey, e164), now);
  while (COOLDOWNS.size > cfg.maxCooldownEntries) {
    const oldest = COOLDOWNS.keys().next();
    if (oldest.done) break;
    COOLDOWNS.delete(oldest.value);
    cooldownEvicted += 1;
  }

  return { ok: true, slot, orgActive: orgActive + 1, globalActive: globalActive };
}

/* ── The gate ─────────────────────────────────────────────────────────────── */
/**
 * The tier THIS call is evaluated at.
 *
 * FAILURE DIRECTION — READ THIS BEFORE CHANGING IT:
 *
 * An ABSENT `planTier` used to coerce straight to `demo`; it now resolves
 * through `planTierFor`, so a deployment that sets `ABUSE_PLAN_TIER` (or a
 * per-org registry entry) grants that tier to callers that omit the argument.
 * That is STRICTLY MORE PERMISSIVE than before, and it is the documented
 * purpose of `TierConfig.defaultTier` — but it is opt-in and operator-scoped:
 * the default is `demo`, so an unconfigured deployment denies exactly what it
 * denied before. It is NOT a way for one org's tier to reach another, and the
 * other controls (geo, velocity, both caps) are untouched by a tier.
 *
 * A SUPPLIED-but-unrecognised value ("Standard", 42, "") is different: it stays
 * pinned to `demo` and must never be replaced by the deployment default.
 * Falling through would mean a typo silently evaluated as whatever the
 * deployment default happens to be — the exact failure this guards against.
 */
function gatePlanTier(orgKey: string, supplied: PlanTier | string | null | undefined): PlanTier {
  if (supplied !== null && supplied !== undefined) {
    return isPlanTier(supplied) ? supplied : "demo";
  }
  return planTierFor(orgKey);
}

/**
 * May this organisation dial this destination right now?
 *
 * Returns a decision; never throws, never rejects, never touches a network.
 * Fail-fast, but every control that ran is recorded in `controls[]` with its
 * own typed reason, so a test can assert on each control individually rather
 * than only on the first one that fired.
 *
 * On `allowed: true` the caller OWNS a concurrency slot and must call
 * `releaseDialSlot(decision.slot)` when the call reaches a terminal state — the
 * caps are only real if the slots are given back.
 */
export function assertDialAllowed(input: DialGuardInput): DialGuardDecision {
  const controls: ControlOutcome[] = [];
  const orgKeyForState = safeOrgKey(input.orgId);

  // Which control is executing right now, so the catch-all below can name the
  // one that actually threw instead of asserting a fixed suspect. Updated
  // BEFORE the control runs, because a control can fault while reading its own
  // inputs (a non-string `e164` throws inside `normaliseE164`, before the shape
  // verdict is even formed).
  let currentControl: ControlName = "input_shape";

  const decide = (
    extra: Partial<DialGuardDecision> & {
      allowed: boolean;
      verdict: DialGuardVerdict;
      reason: AbuseReason | "ok";
      detail: string;
    },
  ): DialGuardDecision => ({
    country: null,
    controls,
    slot: null,
    active: { org: activeOrgCalls(orgKeyForState), global: activeGlobalCalls() },
    velocitySignals: [],
    ...extra,
  });

  try {
    currentControl = "input_shape";
    const atMs = input.at instanceof Date ? input.at.getTime() : (input.at ?? Date.now());
    const now = Number.isFinite(atMs) ? (atMs as number) : Date.now();
    const orgKey = orgKeyForState;
    const norm = normaliseE164(input.e164);
    const tier = gatePlanTier(orgKey, input.planTier);
    const masked = norm ? maskE164(norm) : maskE164(input.e164);

    // 1. Shape — a destination we cannot canonicalise is never dialled, and
    //    running five more controls to discover that would be noise, not safety.
    if (!orgKey || !norm) {
      const reason: AbuseReason = "invalid_e164";
      const detail = orgKey
        ? `destination ${masked} is not a valid E.164 number`
        : "organisation id is missing or malformed";
      controls.push({ control: "input_shape", ok: false, reason, detail });
      return decide({ allowed: false, verdict: "deny", reason, detail });
    }
    controls.push({
      control: "input_shape",
      ok: true,
      reason: "ok",
      detail: `${masked} · tier ${tier}`,
    });

    // 2. Breaker first — if the org is paused, nothing else is worth computing.
    currentControl = "breaker";
    if (isOrgPaused(orgKey, now)) {
      const detail = "organisation is auto-paused by the velocity breaker; a human must resume it";
      controls.push({ control: "breaker", ok: false, reason: "org_auto_paused", detail });
      return decide({ allowed: false, verdict: "auto_pause", reason: "org_auto_paused", detail });
    }
    controls.push({ control: "breaker", ok: true, reason: "ok", detail: "not paused" });

    // 3. Geography (allowlist + denylist + prefix denylist).
    currentControl = "geo";
    const geo = checkDestinationGeo({
      e164: norm,
      orgId: orgKey,
      policy: input.geoPolicy,
      resolver: input.resolver ?? null,
    });
    if (!geo.ok) {
      controls.push({ control: "geo", ok: false, reason: geo.reason, detail: geo.detail });
      return decide({
        allowed: false,
        verdict: "deny",
        reason: geo.reason,
        detail: geo.detail,
        country: geo.country,
      });
    }
    controls.push({ control: "geo", ok: true, reason: "ok", detail: `country ${geo.country}` });

    // 4. Plan tier — demo may dial verified test numbers only.
    currentControl = "plan_tier";
    const tierDecision = checkPlanTier({
      e164: norm,
      tier,
      orgId: orgKey,
      list: input.testNumbers ?? null,
    });
    if (!tierDecision.ok) {
      controls.push({
        control: "plan_tier",
        ok: false,
        reason: tierDecision.reason,
        detail: tierDecision.detail,
      });
      return decide({
        allowed: false,
        verdict: "deny",
        reason: tierDecision.reason,
        detail: tierDecision.detail,
        country: geo.country,
      });
    }
    controls.push({
      control: "plan_tier",
      ok: true,
      reason: "ok",
      detail: tierDecision.restricted
        ? `tier ${tier}: verified test number`
        : `tier ${tier}: not restricted by tier`,
    });

    // 5-7. Cooldown + org cap + global cap, atomically.
    //
    // `reserveDial` checks cooldown, then the org cap, then the global cap in
    // one synchronous step, so a fault inside it cannot be attributed to a
    // single one of the three; the first is the honest label.
    currentControl = "cooldown";
    const reservation = reserveDial(orgKey, norm, now);
    if (!reservation.ok) {
      controls.push({
        control: reservation.control,
        ok: false,
        reason: reservation.reason,
        detail: reservation.detail,
      });
      return decide({
        allowed: false,
        verdict: "deny",
        reason: reservation.reason,
        detail: reservation.detail,
        country: geo.country,
      });
    }
    const cfg = abuseConfig().concurrency;
    controls.push({
      control: "cooldown",
      ok: true,
      reason: "ok",
      detail: `no active cooldown on ${masked}`,
    });
    controls.push({
      control: "org_concurrency",
      ok: true,
      reason: "ok",
      detail: `org ${reservation.orgActive}/${cfg.orgCap}`,
    });
    controls.push({
      control: "global_concurrency",
      ok: true,
      reason: "ok",
      detail: `global ${reservation.globalActive}/${cfg.globalCap}`,
    });

    currentControl = "velocity";
    // 8. Velocity — recorded AFTER the cheap controls, so only attempts that
    //    would really have dialled feed the anomaly counters. A scan of
    //    geo-blocked numbers must not be able to auto-pause a legitimate org:
    //    that is a self-inflicted DoS and the fastest way to get this control
    //    switched off.
    recordAttempt({ orgId: orgKey, e164: norm, at: now });
    const velocity = evaluate({ orgId: orgKey, at: now });

    if (velocity.action === "auto_pause") {
      // Hand the slot straight back: the org is paused, nothing is dialling.
      releaseDialSlot(reservation.slot);
      const detail = velocity.alreadyPaused
        ? "organisation is auto-paused by the velocity breaker"
        : `velocity anomaly auto-paused the organisation (${velocity.signals.join(", ") || velocity.reason})`;
      controls.push({ control: "velocity", ok: false, reason: velocity.reason, detail });
      return decide({
        allowed: false,
        verdict: "auto_pause",
        reason: velocity.reason,
        detail,
        country: geo.country,
        velocitySignals: velocity.signals,
      });
    }

    if (velocity.action === "warn") {
      controls.push({
        control: "velocity",
        ok: true,
        reason: "ok",
        detail: `warning: ${velocity.reason}`,
      });
      return decide({
        allowed: true,
        verdict: "warn",
        reason: velocity.reason,
        detail: `allowed with warning: ${velocity.reason}`,
        country: geo.country,
        slot: reservation.slot,
        velocitySignals: velocity.signals,
      });
    }

    controls.push({ control: "velocity", ok: true, reason: "ok", detail: "no velocity anomaly" });
    return decide({
      allowed: true,
      verdict: "allow",
      reason: "ok",
      detail: `dialling ${masked} (${geo.country}) allowed`,
      country: geo.country,
      slot: reservation.slot,
    });
  } catch (err) {
    // A guard that throws is an outage; a guard that denies is a decision.
    const detail = `abuse guard failed closed: ${err instanceof Error ? err.message : "unknown error"}`;
    console.error(`[abuse] ${detail}`);
    // Attributed to the control that was RUNNING, so the status surface sends
    // an operator to the right place. Recorded as a failure of that control:
    // it did not pass, whatever it would have said had it returned.
    controls.push({ control: currentControl, ok: false, reason: "guard_internal_error", detail });
    return decide({ allowed: false, verdict: "deny", reason: "guard_internal_error", detail });
  }
}

/* ── Observability / test surface ─────────────────────────────────────────── */

/** Observed state for the status surface and for cap assertions in tests. */
export function dialStateSnapshot() {
  return {
    activeByOrg: Object.fromEntries(ORG_ACTIVE),
    activeGlobalCalls: globalActive,
    outstandingSlots: SLOTS.size,
    cooldownEntries: COOLDOWNS.size,
    /** Cooldown entries dropped by the cap — non-zero means the cap is too low. */
    cooldownEvicted,
    velocity: velocitySnapshot(),
  };
}

/**
 * Clear concurrency + cooldown state. Test helper.
 *
 * Deliberately does NOT clear the velocity breaker: a call that exists to free
 * a slot must never be able to reopen a breaker an operator paused.
 */
export function resetDialState(): void {
  ORG_ACTIVE.clear();
  globalActive = 0;
  SLOTS.clear();
  nextSlot = 1;
  COOLDOWNS.clear();
  cooldownEvicted = 0;
}
