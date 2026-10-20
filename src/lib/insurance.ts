/**
 * Insurance domain vocabulary.
 *
 * The platform treats an insurer as a first-class tenant. These are the line
 * categories the use-case page advertises and the terms a claims or policy
 * conversation must use consistently. Arabic terms are the reviewed pairings
 * used by the insurer briefs; Takaful uses contribution/disbursement rather
 * than premium/payout.
 */
export const INSURANCE_LINES = [
  { id: "health", en: "Health", ar: "التأمين الصحي" },
  { id: "life", en: "Life", ar: "تأمين الحياة" },
  { id: "motor", en: "Motor", ar: "تأمين المركبات" },
  { id: "property", en: "Property", ar: "تأمين الممتلكات" },
  { id: "travel", en: "Travel", ar: "تأمين السفر" },
  { id: "takaful", en: "Takaful", ar: "التكافل" },
] as const;

export type InsuranceLine = (typeof INSURANCE_LINES)[number]["id"];

export const INSURANCE_TERMS = [
  { id: "policyholder", en: "Policyholder", ar: "حامل الوثيقة" },
  { id: "insured", en: "Insured", ar: "المؤمَّن له" },
  { id: "beneficiary", en: "Beneficiary", ar: "المستفيد" },
  { id: "premium", en: "Premium / contribution", ar: "القسط / المساهمة" },
  { id: "claim", en: "Claim", ar: "المطالبة" },
  { id: "payout", en: "Claim payout", ar: "تعويض المطالبة" },
  { id: "excess", en: "Excess / deductible", ar: "التحمّل / الخصم" },
  { id: "coverage", en: "Coverage", ar: "التغطية" },
  { id: "underwriting", en: "Underwriting", ar: "الاكتتاب" },
  { id: "adjuster", en: "Claims adjuster", ar: "محكّم المطالبات" },
  { id: "preauth", en: "Pre-authorisation", ar: "الترخيص المسبق" },
  { id: "broker", en: "Broker / TPA", ar: "الوسيط / مدير المطالبات" },
  { id: "reinsurance", en: "Reinsurance", ar: "إعادة التأمين" },
  { id: "lapse", en: "Policy lapse / cancellation", ar: "انتهاء الوثيقة / الإلغاء" },
] as const;

/** Institution categories an insurer reader may be buying for. */
export const INSURANCE_INSTITUTIONS = [
  { id: "health", en: "Health insurer", ar: "شركة تأمين صحي" },
  { id: "life", en: "Life insurer", ar: "شركة تأمين على الحياة" },
  { id: "motor", en: "Motor insurer", ar: "شركة تأمين مركبات" },
  { id: "takaful", en: "Takaful operator", ar: "مشغّل تكافل" },
  { id: "broker", en: "Broker / TPA", ar: "الوسيط / مدير المطالبات" },
  { id: "reinsurer", en: "Reinsurer", ar: "شركة إعادة تأمين" },
] as const;
