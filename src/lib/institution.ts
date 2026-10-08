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
): Promise<{ type: InstitutionType; name: string | null; shariahCompliant: boolean }> {
  if (!orgId) return { type: "bank", name: null, shariahCompliant: false };
  try {
    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: { institutionType: true, name: true, shariahCompliant: true },
    });
    return {
      type: asInstitutionType(org?.institutionType),
      name: org?.name ?? null,
      // Absent org row reads as conventional: renaming a conventional tenant's
      // own product is a factual error to the customer, so the gate stays off
      // unless the tenant has positively declared otherwise.
      shariahCompliant: org?.shariahCompliant === true,
    };
  } catch {
    return { type: "bank", name: null, shariahCompliant: false };
  }
}

export type TelecomIdentity = {
  /** The number customers call BACK, and the caller ID on the Twilio voice leg. */
  voiceNumber: string | null;
  smsSenderId: string | null;
  messagingServiceSid: string | null;
  /** The institution's own SIP-trunk DID imported to ElevenLabs — the caller ID
   *  the customer sees on the primary (platform-agent) conversation plane. */
  elevenPhoneNumberId: string | null;
};

/**
 * The tenant's OWN telecom surface, in one strict lookup.
 *
 * Unlike the wording lookups above, a fault here THROWS. That is the point: an
 * org that has configured its own number must never be sent out on the platform
 * identity because a read blipped, and "the alert carried the wrong institution's
 * number" is the failure a bank ends a contract over. The caller decides how to
 * degrade; this function does not get to answer "which number is this tenant's?"
 * with a guess.
 *
 * An org that has configured nothing returns nulls — that is a real answer, not
 * a fault, and riding the platform default is how every tenant predating these
 * columns behaves.
 */
export async function getTelecomIdentity(
  orgId: string | null | undefined,
): Promise<TelecomIdentity> {
  const none: TelecomIdentity = {
    voiceNumber: null,
    smsSenderId: null,
    messagingServiceSid: null,
    elevenPhoneNumberId: null,
  };
  if (!orgId) return none;
  const org = await db.organization.findUnique({
    where: { id: orgId },
    select: {
      twilioVoiceNumber: true,
      twilioSmsSenderId: true,
      twilioMessagingServiceSid: true,
      elevenPhoneNumberId: true,
    },
  });
  if (!org) return none;
  return {
    voiceNumber: org.twilioVoiceNumber,
    smsSenderId: org.twilioSmsSenderId,
    messagingServiceSid: org.twilioMessagingServiceSid,
    elevenPhoneNumberId: org.elevenPhoneNumberId,
  };
}

/** The E.164 shape every transfer destination must satisfy. */
const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * The tenant that OWNS an inbound number — the reverse of `getTelecomIdentity`.
 *
 * This is the lookup that makes a call-back land in the right institution's
 * queue. A number is unique per tenant by construction (each is provisioned to
 * one org); `findFirst` is used rather than `findUnique` because the column has
 * no unique index, and two tenants claiming one number would be a configuration
 * bug that must show up as "the first match was answered" in the audit row
 * rather than as a 500 on a customer's call.
 *
 * A lookup fault THROWS. Answering "no tenant owns this number" when the real
 * answer is unknown would hand a Bank A customer the platform's generic
 * no-tenant response while their alert sat unattended.
 */
export async function findOrgByVoiceNumber(
  number: string,
): Promise<{ id: string; name: string; institutionType: InstitutionType } | null> {
  const org = await db.organization.findFirst({
    where: { twilioVoiceNumber: number },
    select: { id: true, name: true, institutionType: true },
  });
  if (!org) return null;
  return { id: org.id, name: org.name, institutionType: asInstitutionType(org.institutionType) };
}

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
