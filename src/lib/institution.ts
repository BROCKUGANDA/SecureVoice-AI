import "server-only";
/**
 * Read / write a tenant's institution type through the Prisma client.
 *
 * `institutionType` is a real typed column on `Organization` (migration
 * 9zz_unreachable_resolution), not a field tucked into the free-form `metadata`
 * JSON: it is read on the dial path for every call, and a column is something
 * the compiler and the database both enforce.
 */

import { db } from "@/lib/db";
import {
  asInstitutionType,
  isInstitutionType,
  type InstitutionType,
} from "@/lib/institution-types";

/**
 * The institution type for a tenant. A missing org, a null org (the default
 * namespace) or an unrecognised stored value all resolve to "bank" - the type
 * every tenant had before this column existed - so this can never block a call.
 */
export async function getInstitutionType(
  orgId: string | null | undefined,
): Promise<InstitutionType> {
  if (!orgId) return "bank";
  try {
    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: { institutionType: true },
    });
    return asInstitutionType(org?.institutionType);
  } catch {
    // A lookup fault must not stop a fraud call. The wording falls back to the
    // default; nothing about WHETHER the customer is reached depends on it.
    return "bank";
  }
}

export type SetInstitutionResult =
  { ok: true; institutionType: InstitutionType } | { ok: false; error: string };

/** Set a tenant's institution type. Rejects anything outside the closed set. */
export async function setInstitutionType(
  orgId: string,
  value: unknown,
): Promise<SetInstitutionResult> {
  if (!isInstitutionType(value)) {
    return { ok: false, error: "institutionType must be 'bank' or 'insurer'" };
  }
  await db.organization.update({ where: { id: orgId }, data: { institutionType: value } });
  return { ok: true, institutionType: value };
}
