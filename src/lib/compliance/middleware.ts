import { z } from "zod";

export const CallCategorySchema = z.enum([
  "time_critical_fraud",
  "routine",
  "sensitive_case",
]);

export const InterventionPolicySchema = z.object({
  org_id: z.string().uuid(),
  customer_phone_token: z.string().uuid(),
  call_category: CallCategorySchema,
  language: z.string().min(2).max(8),
  transaction_ref: z.string().optional(),
});

export type InterventionPolicy = z.infer<typeof InterventionPolicySchema>;

export function validateInterventionPolicy(payload: unknown) {
  return InterventionPolicySchema.safeParse(payload);
}
