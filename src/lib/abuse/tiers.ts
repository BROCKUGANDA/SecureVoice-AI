import "server-only";
/**
 * Plan-tier gating (WP-14, control 2 of the dial gate).
 *
 * A `demo` tenant may dial ONLY numbers on a verified test-number list. That is
 * the whole attack class removed at zero marginal cost: whatever else a
 * compromised or curious demo session can do, it cannot reach a subscriber
 * number that is not on a list a human put there deliberately. It is the
 * cheapest control in this package and the strongest one — it needs no model,
 * no score and no false-positive budget.
 *
 * Why it is a LIST and not a heuristic ("looks like a test number"):
 *   · a heuristic guesses, and a wrong guess is a real person's phone;
 *   · a list is auditable — "these 14 numbers were verified with the client
 *     before the demo" is a sentence an acquirer can check;
 *   · a list is testable. `isTestNumber` is the seam the test suite drives.
 *
 * The list is EXPLICITLY configured (ABUSE_TEST_NUMBERS) or injected per org.
 * There is no built-in default: a built-in list would mean this module had
 * guessed which numbers are safe, which is precisely the failure the control
 * exists to prevent. Unset ⇒ the demo tier dials nothing
 * (test_number_list_empty) rather than everything.
 *
 * Geography, velocity and the caps apply to every tier. This module only
 * narrows the DEMO tier.
 */

import { abuseConfig } from "./config";
import { maskE164, normaliseE164, safeOrgKey } from "./geo";

export type PlanTier = "demo" | "standard" | "enterprise";

export const PLAN_TIERS: readonly PlanTier[] = Object.freeze(["demo", "standard", "enterprise"]);

export function isPlanTier(value: unknown): value is PlanTier {
  return typeof value === "string" && (PLAN_TIERS as readonly string[]).includes(value);
}

/** Coerce anything a request handed us into a known tier (default: demo). */
export function coercePlanTier(value: unknown): PlanTier {
  return isPlanTier(value) ? value : "demo";
}

/* ── The verified test-number list ────────────────────────────────────────── */

/** Cap on entries per org / orgs tracked — a list is config, not a store. */
const MAX_ENTRIES_PER_ORG = 500;

/**
 * Normalise one configured entry to `+<digits>` (exact) or `+<digits>*`
 * (prefix). Accepts what operators actually type — `+971 50 123 4567`,
 * `00971501234567`, `971501234567` — and refuses degenerate entries (`*`,
 * `+`, empty), which would otherwise match everything.
 */
export function normaliseTestNumberEntry(raw: string): string | null {
  const cleaned = (raw ?? "").trim().replace(/[\s().-]/g, "").replace(/^00/, "+");
  if (!cleaned) return null;
  const withPlus = cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
  const isPrefix = withPlus.endsWith("*");
  const digits = (isPrefix ? withPlus.slice(1, -1) : withPlus.slice(1)).replace(/^\++/, "");
  if (!/^\d{1,15}$/.test(digits)) return null;
  return `+${digits}${isPrefix ? "*" : ""}`;
}

/** Per-org test-number registry, injected by the tenant service at runtime. */
const ORG_TEST_NUMBERS = new Map<string, string[]>();

function orgKey(orgId: string | null | undefined): string {
  return safeOrgKey(orgId);
}

/** Register (or clear, with null) an org's verified test numbers. */
export function setOrgTestNumbers(orgId: string, numbers: Iterable<string> | null): void {
  const key = orgKey(orgId);
  if (!key) return;
  if (numbers === null) {
    ORG_TEST_NUMBERS.delete(key);
    return;
  }
  const entries: string[] = [];
  for (const n of numbers) {
    const e = normaliseTestNumberEntry(n);
    if (e && !entries.includes(e)) entries.push(e);
    if (entries.length >= MAX_ENTRIES_PER_ORG) break;
  }
  ORG_TEST_NUMBERS.set(key, entries);
}

export function clearOrgTestNumbers(): void {
  ORG_TEST_NUMBERS.clear();
}

/**
 * Effective list for an org: registered list first, else ABUSE_TEST_NUMBERS.
 * An empty result is meaningful — it means "nothing is verified", which fails
 * closed downstream.
 */
export function testNumbersFor(
  orgId: string | null | undefined,
  override?: Iterable<string> | null,
): readonly string[] {
  if (override) {
    const out: string[] = [];
    for (const n of override) {
      const e = normaliseTestNumberEntry(n);
      if (e && !out.includes(e)) out.push(e);
    }
    return out;
  }
  const registered = ORG_TEST_NUMBERS.get(orgKey(orgId));
  if (registered) return registered;
  const configured = abuseConfig().tier.testNumbers;
  const out: string[] = [];
  for (const raw of configured) {
    const e = normaliseTestNumberEntry(raw);
    if (e && !out.includes(e)) out.push(e);
  }
  return out;
}

export type TestNumberOptions = {
  /** Per-call list override (a route that already resolved the tenant). */
  list?: Iterable<string> | null;
  orgId?: string | null;
};

/**
 * Is this destination on the verified test-number list?
 *
 * Exact match, or prefix match for an entry written with a trailing `*`
 * (carrier test ranges are contiguous, so a range beats 200 entries). Returns
 * false for an unparseable number — the question "is this a number we are
 * willing to dial?" is answered no whenever the input is not a number.
 */
export function isTestNumber(e164: string, options: TestNumberOptions = {}): boolean {
  const norm = normaliseE164(e164);
  if (!norm) return false;
  for (const entry of testNumbersFor(options.orgId ?? null, options.list ?? null)) {
    const e = normaliseTestNumberEntry(entry);
    if (!e) continue;
    if (e.endsWith("*")) {
      if (norm.startsWith(e.slice(0, -1))) return true;
    } else if (norm === e) {
      return true;
    }
  }
  return false;
}

/* ── The control ──────────────────────────────────────────────────────────── */

export type TierRejectReason =
  /** demo tier, number is well-formed, but not on the verified list. */
  | "demo_tier_requires_test_number"
  /** demo tier, and no verified list is configured at all. Fail closed. */
  | "test_number_list_empty";

export type TierDecision =
  | { ok: true; restricted: boolean }
  | { ok: false; reason: TierRejectReason; detail: string };

export type TierInput = TestNumberOptions & {
  e164: string;
  tier: PlanTier | string | null | undefined;
};

/**
 * May this tier dial this number?
 *
 * `demo` → verified test number only. `standard` / `enterprise` → unrestricted
 * by THIS control (geography, velocity and the caps still apply; an
 * enterprise tenant is not a licence to dial anywhere).
 */
export function checkPlanTier(input: TierInput): TierDecision {
  const tier = coercePlanTier(input.tier);
  if (tier !== "demo") return { ok: true, restricted: false };

  const norm = normaliseE164(input.e164);
  if (!norm) {
    return {
      ok: false,
      reason: "demo_tier_requires_test_number",
      detail: "destination is not a valid E.164 number",
    };
  }

  const list = testNumbersFor(input.orgId ?? null, input.list ?? null);
  if (list.length === 0) {
    return {
      ok: false,
      reason: "test_number_list_empty",
      detail:
        "the demo tier has no verified test-number list configured (set ABUSE_TEST_NUMBERS or register one for this organisation); the demo tier dials nothing until a human lists the numbers",
    };
  }

  if (!isTestNumber(norm, { orgId: input.orgId, list })) {
    return {
      ok: false,
      reason: "demo_tier_requires_test_number",
      detail: `destination ${maskE164(norm)} is not on the verified test-number list; the demo tier may dial verified test numbers only`,
    };
  }
  return { ok: true, restricted: true };
}