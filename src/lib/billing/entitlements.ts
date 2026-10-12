import "server-only";
/**
 * Which features a plan actually unlocks — and the refusal when it does not.
 *
 * ── The gap this closes ──────────────────────────────────────────────────────
 * The pricing page has always advertised a differentiated product: BYOK is a
 * Growth bullet, "Guardrail policy configurable per institution" and "Signed
 * webhooks with replay protection" are Growth bullets, and seats and monthly
 * volume are tiered. Until this module NONE of that was enforced. `planTier`
 * reached the console display and the overage rater (see
 * `src/lib/billing/plan-context.ts`), and every capability surface — BYOK,
 * institution policy, the knowledge base, bulk export — guarded with a ROLE check
 * alone (`requireOperator()`). A Starter tenant's administrator could therefore do
 * everything an Enterprise tenant's administrator could, and the only difference
 * between the two was the number on the invoice.
 *
 * That is not a billing bug; it is a truthfulness bug. A card that lists
 * "Bring your own ElevenLabs key" under Growth and not under Starter is a statement
 * about what Starter does not include. Leaving it unenforced makes the card false
 * whichever way a customer reads it.
 *
 * ── What is deliberately NOT gated here ──────────────────────────────────────
 * Only what the published tiers distinguish. Everything else stays open to every
 * paying tenant, because inventing a restriction the card never mentioned is the
 * same defect as promising a feature that was never delivered:
 *
 *   · Compliance is NEVER an entitlement. Redaction, vishing refusal, the
 *     verification-token anchoring, prayer-window suppression and the Shariah
 *     terminology engine run for every tenant on every tier. A Starter bank's
 *     customers are not less entitled to those, and a guardrail that switches off
 *     under a pricing plan is not a guardrail.
 *   · Reading your own data is never an entitlement: GET surfaces, case reads,
 *     audit reads, bulk export of your own rows. The cards do not tier them.
 *   · Seats and monthly volume are already enforced where they live
 *     (`src/lib/billing/seats.ts`, `src/lib/credits.ts`). This module does not
 *     re-implement them — a second counter of the same limit is a second number
 *     that can disagree.
 *
 * ── Two checks, not one ──────────────────────────────────────────────────────
 * A request must satisfy BOTH the role's capability (`roleHas` in
 * `src/lib/auth/roles.ts`) and the plan's entitlement (here). They answer different
 * questions and neither substitutes for the other: an `Analyst` cannot change BYOK
 * on any plan because the role does not hold `byok:change`, and an `Owner` on
 * Starter cannot because the plan does not include it.
 */
import { NextResponse } from "next/server";
import { type OrgPlanContext, orgPlanContext } from "@/lib/billing/plan-context";
import { type Capability } from "@/lib/auth/roles";

/** A feature the pricing tiers distinguish. Adding one here is the whole ceremony. */
export type Entitlement = "byok" | "signedWebhooks";

/** The catalog plan ids, in selling order. Not `PlanTier` — see `planEntitles`. */
export type PlanName = "starter" | "growth" | "enterprise";

/**
 * The plan at which each entitlement unlocks. An entitlement not listed for a plan
 * is refused there, which makes "everyone gets everything" impossible to write by
 * accident.
 *
 * ── Entitlements gate ADDING, never removing ─────────────────────────────────
 * Each of these is refused only when a request would START using the feature.
 * Clearing a value is never gated, and that is a safety decision rather than
 * convenience: a tenant that downgrades, or one that never bought the feature and
 * had it set for it by a trial, must always be able to delete its callback URL and
 * its own provider key. Refusing an UNSET is how a billing control becomes the
 * reason a stale endpoint keeps receiving the bank's customer data, and how
 * `DELETE` ends up needing a subscription. The route checks that call this module
 * skip empty values, and the comment at each call site says so.
 */
const MINIMUM_PLAN: Record<Entitlement, PlanName> = {
  // "Bring your own ElevenLabs key (BYOK)" — the Growth card, `src/lib/commercial.ts`.
  byok: "growth",
  // "Signed webhooks with replay protection" + "Guardrail policy configurable per
  // institution" — both Growth cards. This is the institution's own callback
  // endpoint and its signing secret.
  //
  // `institutionType` is NOT here on purpose. Saying "we are an insurer, not a
  // bank" changes how the agent addresses a customer in a fraud call; gating it
  // would make a Starter insurer be spoken to with banking language, which is a
  // compliance posture the platform needs to get right for every tenant that pays
  // anything at all.
  signedWebhooks: "growth",
};

/**
 * Ranked, because a Growth entitlement is held by Enterprise too.
 *
 * The rank is over the CATALOG PLAN ids (`starter|growth|enterprise`), not over
 * `OrgPlanContext.tier`, which speaks the console's `demo|standard|enterprise`
 * vocabulary. Mixing the two is how a gate reads as satisfied for a tenant that
 * bought nothing: every real tenant's `tier` is `standard`, so a rank over `tier`
 * would have granted BYOK to a Starter bank on the first day.
 */
const RANK: Record<PlanName, number> = { starter: 0, growth: 1, enterprise: 2 };

/** The capability a role must ALSO hold to exercise each entitlement. */
const ROLE_GATE: Record<Entitlement, Capability> = {
  byok: "byok:change",
  signedWebhooks: "settings:write",
};

export function planEntitles(plan: PlanName | null, entitlement: Entitlement): boolean {
  // `null` means no money names a plan: the demo workspace, an unprovisioned
  // tenant. Refused — defaulting it to the cheapest SELLING tier would hand a free
  // workspace a paid feature.
  if (plan === null) return false;
  const rank = RANK[plan];
  // An unrecognised plan id (a catalog rename, a hand-set column value) is not a
  // low rank; it is an unknown, and unknowns do not unlock purchases.
  if (rank === undefined) return false;
  return rank >= RANK[MINIMUM_PLAN[entitlement]];
}

/**
 * The plan a tenant is entitled to be judged against, from the resolver's context.
 *
 * Two signals reach `orgPlanContext` and only one of them is a catalog plan:
 *
 *   · a PAID mirrored subscription carries a price id, which names `starter`,
 *     `growth` or `enterprise` exactly. That is the strongest evidence and wins.
 *   · otherwise `Organization.planTier` holds the CONSOLE's vocabulary —
 *     `demo | standard | enterprise` — and 147 of this deployment's tenants are
 *     decided by that column alone, because no Paddle subscription has ever been
 *     mirrored for them.
 *
 * Reading only the first would refuse every existing tenant; reading only the
 * second would let a subscription never override a stale column. `standard` maps
 * to the Growth line because that is what the console means by it: a paid tenant
 * that is not on the enterprise terms. `demo` maps to nothing.
 */
export function entitlementPlan(context: OrgPlanContext): PlanName | null {
  if (context.plan === "starter" || context.plan === "growth" || context.plan === "enterprise") {
    return context.plan;
  }
  if (context.tier === "enterprise") return "enterprise";
  if (context.tier === "standard") return "growth";
  return null;
}

/** All of them, for a `GET` that lets the console render honestly instead of 403-ing. */
export function entitlementFacts(context: OrgPlanContext): Record<Entitlement, boolean> {
  const plan = entitlementPlan(context);
  return {
    byok: planEntitles(plan, "byok"),
    signedWebhooks: planEntitles(plan, "signedWebhooks"),
  };
}

export type EntitlementRefusal = {
  ok: false;
  entitlement: Entitlement;
  /**
   * 402, not 403. A role failure means "you personally may not"; this means "the
   * plan does not include it", which a payment changes — the same reasoning that
   * made out-of-credits a 402 rather than a 409. The status carries the fact; there
   * is no `success` flag in this envelope.
   */
  status: 402;
  error: string;
};

export type EntitlementCheck = { ok: true } | EntitlementRefusal;

/**
 * Check an entitlement against the session's OWN organisation.
 *
 * `orgId` is never inferred from the request: an entitlement is a property of the
 * tenant being modified, and a caller-supplied org id would let a Starter request be
 * validated against an Enterprise neighbour.
 */
export async function checkEntitlement(
  orgId: string | null,
  entitlement: Entitlement,
): Promise<EntitlementCheck> {
  if (!orgId) {
    // No tenant, therefore no purchase. `orgPlanContext("")` would resolve the
    // demo tier and answer "not included" for the wrong reason, so refuse here
    // where the message can say what is actually missing.
    return refuse(entitlement, null);
  }
  const context = await orgPlanContext(orgId);
  const plan = entitlementPlan(context);
  if (planEntitles(plan, entitlement)) return { ok: true };
  return refuse(entitlement, plan);
}

const LABELS: Record<Entitlement, string> = {
  byok: "Bringing your own ElevenLabs key",
  signedWebhooks: "Signed webhooks to your own endpoint",
};

function named(tier: PlanName): string {
  if (tier === "growth") return "Growth-and-above";
  if (tier === "enterprise") return "Enterprise";
  return "every tier";
}

function refuse(entitlement: Entitlement, plan: string | null): EntitlementRefusal {
  const needed = MINIMUM_PLAN[entitlement];
  return {
    ok: false,
    entitlement,
    status: 402,
    error:
      `${LABELS[entitlement]} is a ${named(needed)} feature and this organisation is on ` +
      `${plan ?? "no plan"}. Nothing was changed. Upgrade, or ask the bank's ` +
      `administrator to do that from Settings.`,
  };
}

/**
 * The route-facing form: `const denied = await requireEntitlement(...); if (denied) return denied;`
 *
 * The body is the documented envelope shape (`{ error }` plus the machine-readable
 * fields a console and a bank's integration need to say WHY on screen).
 */
export function entitlementResponse(refusal: EntitlementRefusal): NextResponse {
  return NextResponse.json(
    {
      error: refusal.error,
      code: "plan_entitlement_required",
      entitlement: refusal.entitlement,
      upgradeTo: MINIMUM_PLAN[refusal.entitlement],
    },
    { status: refusal.status },
  );
}

/** The capability a role must hold too, so a route can assert both in one place. */
export function roleCapabilityFor(entitlement: Entitlement): Capability {
  return ROLE_GATE[entitlement];
}
