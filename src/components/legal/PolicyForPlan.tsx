"use client";

import { useApp, t } from "@/lib/store";
import { REFUND_POLICIES, type RefundPolicyKind } from "@/lib/legal-policies";

/**
 * The tier is SERVER-RESOLVED and is not available client-side.
 *
 * `planTierFor(orgId)` (`src/lib/abuse/tiers.ts`) resolves it from a runtime
 * registry → `ABUSE_PLAN_TIER__<ORG>` → the deployment default, and returns a
 * `PlanTier`. It is deliberately server-only: an org's commercial tier is not
 * something the browser should be able to read or influence.
 *
 * So a caller must PASS the tier in. There is deliberately no
 * `useOrgPlanTier()` hook here — one was tried and removed, because a hook that
 * returns a constant `null` to satisfy the type is a trap: every caller would
 * wire it in correctly and silently always receive the DEMO policy, which tells a
 * paying bank it has no refunds. Fetching the tier for a component means an API
 * route that resolves it server-side first.
 */
export function PolicyForPlan({
  planTier,
  className,
}: {
  /**
   * The organization's `planTier`. `null` and `undefined` both mean "the demo
   * tier", which is also how `planTierFor` resolves an unset org — an org that
   * has never been provisioned a tier is running the reference deployment.
   */
  planTier: string | null | undefined;
  className?: string;
}) {
  const { lang } = useApp();
  // Null and `demo` are the SAME answer, deliberately: an org that has never
  // been provisioned a tier is running the reference deployment, which takes no
  // money. Treating "unknown" as "paying" would show a wallet policy to a demo
  // user and imply they owe us something.
  const kind: RefundPolicyKind =
    planTier === "standard" || planTier === "enterprise" ? "creditWallet" : "demo";
  const policy = REFUND_POLICIES[kind];

  return (
    <section className={className ?? "rounded-2xl border border-line bg-white p-6"}>
      <h3 className="font-display text-[15px] font-semibold tracking-tight">
        {t(policy.titleEn, policy.titleAr, lang)}
      </h3>
      <div className="mt-3 space-y-3 text-[13px] leading-relaxed text-ink-2">
        {policy.clauses.map((c) => (
          <p key={c.en}>{c[lang]}</p>
        ))}
      </div>
    </section>
  );
}
