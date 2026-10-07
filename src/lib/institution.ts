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

/**
 * The institution's type AND display name in one lookup — what the call-category
 * prompt router needs to speak as ("Stanbic Bank", "Acme Insurance"). A missing
 * org or a lookup fault degrades to the type default and a noun-only identity,
 * so a prompt can always be built; nothing about WHETHER the customer is
 * reached depends on this.
 */
export async function getInstitutionContext(
  orgId: string | null | undefined,
): Promise<{ type: InstitutionType; name: string | null }> {
  if (!orgId) return { type: "bank", name: null };
  try {
    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: { institutionType: true, name: true },
    });
    return { type: asInstitutionType(org?.institutionType), name: org?.name ?? null };
  } catch {
    return { type: "bank", name: null };
  }
}

/** The E.164 shape every transfer destination must satisfy. */
const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * The live-transfer destination for a tenant: `transferPhone` in the org's
 * `metadata` JSON (operator-set in the console's data model), falling back to
 * the deployment-wide HUMAN_AGENT_PHONE. Null means "no live transfer is
 * configured" — the warm_transfer tool then degrades to the queue semantics
 * instead of bridging the customer to nobody.
 */
export async function getTransferNumber(orgId: string | null | undefined): Promise<string | null> {
  let fromOrg: string | null = null;
  if (orgId) {
    try {
      const org = await db.organization.findUnique({
        where: { id: orgId },
        select: { metadata: true },
      });
      const meta = org?.metadata ? (JSON.parse(org.metadata) as Record<string, unknown>) : null;
      const phone = meta?.transferPhone;
      if (typeof phone === "string" && E164.test(phone)) fromOrg = phone;
    } catch {
      // Malformed metadata or a lookup fault: fall through to the env default.
    }
  }
  if (fromOrg) return fromOrg;
  const envPhone = process.env.HUMAN_AGENT_PHONE;
  return envPhone && E164.test(envPhone) ? envPhone : null;
}

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
