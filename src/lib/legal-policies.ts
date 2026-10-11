/**
 * The two refund/credit policies, in ONE place.
 *
 * They were previously in two: `src/views/Pricing.tsx` carried `DemoPolicy` and
 * `CreditWalletPolicy` inline, and `src/views/Legal.tsx` carried a `/refund`
 * policy written independently. The two DISAGREED on the single most important
 * fact in either document:
 *
 *   /pricing: "Purchased credits are non-refundable and unused credits expire
 *              12 months from the date of purchase."
 *   /refund:  "Credits purchased as a prepaid balance are refundable while they
 *              are unspent … Unspent credits are refundable in full."
 *
 * Two public pages giving opposite answers about whether a customer can have
 * their money back is the failure mode this file exists to make unrepresentable.
 * `tests/unit/refund-policy-consistency.test.ts` asserts the two surfaces cannot
 * drift again.
 *
 * ## Which clauses are NOT implemented in code — read before editing
 *
 * Publishing a policy is a commercial decision. Shipping an automation that
 * enforces it is an engineering one. Four clauses below are the former without
 * the latter, and each is tagged `unimplemented` so nobody mistakes the policy
 * for a working system:
 *
 *   CREDIT_EXPIRY      `UsageLedger` carries no expiry column, and nothing in
 *                      `src/lib/billing/ledger.ts` or `src/lib/credits.ts` ages
 *                      credits out. The 12-month expiry is a promise about
 *                      future behaviour, not a current enforcement.
 *   AUTO_REFUND        `ledger.ts` has `release` — a hold dissolved — which is
 *                      the nearest existing mechanism. Nothing returns a credit
 *                      to a wallet "automatically within 48 hours".
 *   SLA_CREDITS        Nothing computes (downtime ÷ total minutes) × the
 *                      monthly fee, from `/api/health` or anywhere else.
 *   CHARGEBACK_SUSPENSION
 *                      Nothing suspends API access or webhook routing on a
 *                      chargeback.
 *
 * Each is a clause a customer could hold you to. Decide deliberately whether to
 * implement them or soften the wording — the tags exist so that decision is
 * visible rather than buried.
 */

export type PolicyClause = {
  id: string;
  /** Present when this clause promises behaviour the code does not implement. */
  unimplemented?: boolean;
  en: string;
  ar: string;
};

/**
 * The DEMO environment's policy — shown where a judge or evaluator reads it.
 *
 * Deliberately says there is nothing to refund, and says why: no payment is
 * processed, so there is no transaction to reverse. A demo page that hedges
 * ("refunds subject to policy") implies a charge that does not exist.
 */
export const DEMO_POLICY: PolicyClause[] = [
  {
    id: "demo_free",
    en: "The SecureVoice demo environment is provided free of charge strictly for the purpose of evaluation, testing and product demonstration. No financial transaction, card charge or billing cycle occurs within it.",
    ar: "تُقدَّم بيئة العرض التجريبية مجاناً، وذلك لأغراض التقييم والاختبار وعرض المنتج حصراً. ولا تتم داخلها أي معاملة مالية أو خصم من البطاقة أو دورة فوترة.",
  },
  {
    id: "demo_synthetic",
    en: "All intervention data, transcripts and audio in the demo are synthetic or simulated. Nothing in it refers to a real customer, a real card or a real account.",
    ar: "جميع بيانات التدخلات والنصوص المحوَّلة والتسجيلات الصوتية في العرض التركيبية أو المحاكاة. ولا شيء فيها يشير إلى عميل حقيقي أو بطاقة حقيقية أو حساب حقيقي.",
  },
  {
    id: "demo_no_refund",
    en: "Because no payment is processed, no refunds or chargebacks are applicable. Use of the demo environment is governed by our Acceptable Use Policy.",
    ar: "ولأن أي عملية دفع لا تتم، فإن أي استرداد أو استرداد بنكي لا ينطبق. ويخضع استخدام بيئة العرض لسياسة الاستخدام المقبول.",
  },
];

/**
 * The B2B CREDIT WALLET policy — shown where a paying customer reads it.
 *
 * The model is a monthly platform fee plus prepaid intervention credits, which
 * is what `src/lib/commercial.ts` publishes. Deliberately NOT a
 * subscription-cancellation policy: there is no annual plan and no unused
 * period to pro-rate, so a "cancel before renewal and we refund the unused
 * portion" clause — which an earlier revision of this page carried — would
 * describe a product nobody can buy.
 */
export const CREDIT_WALLET_POLICY: PolicyClause[] = [
  {
    id: "credit_purchases",
    en: "The platform runs on a prepaid Credit Wallet. One credit funds one intervention signal. Purchased credits are non-refundable and unused credits expire 12 months from the date of purchase.",
    ar: "تعمل المنصة على محفظة ائتمان مدفوعة مسبقاً. ويرصد الرصيد الواحد إشارة تدخل واحدة. والأرصدة المشتراة غير قابلة للاسترداد، وتنتهي صلاحية الرصيد غير المستخدم بعد 12 شهراً من تاريخ الشراء.",
    unimplemented: true, // CREDIT_EXPIRY — see the file header
  },
  {
    id: "failed_interventions",
    en: "If an intervention fails to connect, or terminates because of a SecureVoice infrastructure fault — not a carrier block, a network failure at the customer's end, or the customer being unreachable — the credit consumed by that intervention is returned to the wallet automatically within 48 hours.",
    ar: "إذا فشل تدخل في الاتصال، أو انقطع بسبب خلل في بنية SecureVoice — لا بسبب حجب من مشغّل الاتصالات، ولا انقطاع في شبكة العميل، ولا تعذّر الوصول إلى العميل — يُعاد الرصيد المستهلك في هذا التدخل إلى المحفظة تلقائياً خلال 48 ساعة.",
    unimplemented: true, // AUTO_REFUND
  },
  {
    id: "sla_credits",
    en: "Where an Enterprise agreement carries an availability commitment and that commitment is missed in a calendar month, service credits are issued as a wallet top-up rather than a cash refund, sized as (downtime minutes ÷ total minutes in the month) × the monthly platform fee. The measured figure is taken from the platform's own health endpoint, not from a customer report.",
    ar: "في الاتفاقيات المؤسساتية التي تتضمن التزام توافر ولم يُحقَّق في شهر ميلادي، تُصدر أرصدة خدمة كإضافة إلى المحفظة بدلاً من استرداد نقدي، وحجمها يساوي (دقائق التوقف ÷ إجمالي دقائق الشهر) × الرسم الشهري للمنصة. ويُؤخذ القياس من نقطة صحة المنصة نفسها، لا من تقرير العميل.",
    unimplemented: true, // SLA_CREDITS
  },
  {
    id: "chargebacks",
    en: "Opening a card chargeback against a valid credit purchase suspends API access and webhook routing until the chargeback is resolved, because the underlying intervention may still be consuming metered capacity.",
    ar: "يفتح فتح استرداد بنكي على عملية شراء رصيد سارية الوصول إلى API وتوجيه الويب هوكس حتى تسوية الاسترداد، لأن التدخل المرتبط قد يستهلك سعة مقيسة في تلك الأثناء.",
    unimplemented: true, // CHARGEBACK_SUSPENSION
  },
];

/** Clauses promising behaviour the code does not implement, for a startup warning. */
export const UNIMPLEMENTED_POLICY_CLAUSES: readonly string[] = Object.freeze(
  [...DEMO_POLICY, ...CREDIT_WALLET_POLICY].filter((c) => c.unimplemented).map((c) => c.id),
);

/** Both policies, for a public page that must be readable without a session. */
export const REFUND_POLICIES = {
  demo: {
    titleEn: "Demo evaluation policy",
    titleAr: "سياسة التقييم التجريبي",
    clauses: DEMO_POLICY,
  },
  creditWallet: {
    titleEn: "Credit wallet & service credit policy",
    titleAr: "سياسة محفظة الرصيد وأرصدة الخدمة",
    clauses: CREDIT_WALLET_POLICY,
  },
} as const;

export type RefundPolicyKind = keyof typeof REFUND_POLICIES;
