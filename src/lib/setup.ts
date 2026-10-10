import "server-only";

/**
 * The onboarding wizard's state machine and per-step validation.
 *
 * Progress lives on the ORGANIZATION, not on the user: the wizard configures the
 * TENANT, so a second administrator of the same bank resumes where the first left
 * off instead of re-entering the bank's telecom identity and BYOK keys. That is
 * why `setupStep` / `setupCompletedAt` are columns on `Organization`.
 *
 * The contract every step follows:
 *
 *  - **Strict schemas.** An unknown field is a 422, never silently dropped. The
 *    settings route already made this promise; a wizard that quietly ignored a
 *    misspelled field would tell the operator a value was saved when it was not.
 *  - **Write-only secrets.** Every secret this module accepts (ElevenLabs key,
 *    LLM key, Twilio auth token, webhook signing secret) is AES-256-GCM sealed at
 *    rest and is never returned by a read — only a masked form or a boolean. A
 *    wizard that could re-display a stored key would turn an operator session
 *    into a credential-exfiltration target.
 *  - **The org is server-derived.** Never a body field. There is no code path
 *    here that accepts an orgId from the caller.
 */

import { z } from "zod";
import { db } from "@/lib/db";
import { decryptSecret, encryptSecret, maskKey } from "@/lib/byok";
import { INSTITUTION_TYPES } from "@/lib/institution-types";
import { assertVendorUrlSaveable } from "@/lib/vendor-endpoint";

/** The five steps, in the order an institution actually needs them. */
export const SETUP_STEPS = [
  {
    id: 1,
    key: "profile",
    title: "Institution profile",
    blurb: "How your institution is named and spoken about",
  },
  {
    id: 2,
    key: "telecom",
    title: "Telecom identity",
    blurb: "The number customers hear, and the SMS sender they see",
  },
  {
    id: 3,
    key: "ai",
    title: "AI keys (BYOK)",
    blurb: "Route voice and reasoning through your own provider accounts",
  },
  {
    id: 4,
    key: "documents",
    title: "Documents & data",
    blurb: "Your policy documents, and where customer data lives",
  },
  {
    id: 5,
    key: "webhooks",
    title: "Webhooks",
    blurb: "Where your own systems are told what happened",
  },
] as const;

export type SetupStepKey = (typeof SETUP_STEPS)[number]["key"];

/**
 * Data residency, as a closed set. Declared at onboarding because "where does
 * customer data live" is the first question a PDPL reviewer asks, and an
 * unvalidated free-text region is how that question gets answered "somewhere".
 */
export const REGIONS = ["UAE", "GCC", "MENA", "OTHER"] as const;
export type Region = (typeof REGIONS)[number];

/** E.164: a leading +, a non-zero country digit, then up to 14 more digits. */
const E164 = /^\+[1-9]\d{6,14}$/;
/** Alphanumeric sender IDs are short and have no URLs or punctuation. */
const SENDER_ID = /^[A-Za-z0-9 -]{2,16}$/;

/* ── Per-step schemas ──────────────────────────────────────────────────────── */

export const stepSchemas = {
  profile: z
    .object({
      orgName: z.string().trim().min(2).max(60),
      orgLogoUrl: z.string().trim().url().max(300).optional().or(z.literal("")),
      institutionType: z.enum(INSTITUTION_TYPES),
      region: z.enum(REGIONS),
      shariahCompliant: z.boolean(),
    })
    .strict(),

  telecom: z
    .object({
      twilioVoiceNumber: z.string().trim().regex(E164, "must be E.164, e.g. +97145550123"),
      twilioSmsSenderId: z
        .string()
        .trim()
        .regex(SENDER_ID, "2–16 letters, digits, spaces or dashes"),
      twilioMessagingServiceSid: z
        .string()
        .trim()
        .regex(/^MG[0-9a-fA-F]{32}$/, "must be a messaging service SID starting MG")
        .optional()
        .or(z.literal("")),
      // Sealed at rest, never returned. Empty string means "keep what is there".
      twilioAuthToken: z.string().trim().min(20).max(80).optional().or(z.literal("")),
    })
    .strict(),

  ai: z
    .object({
      elevenKey: z.string().trim().min(20).max(80).optional().or(z.literal("")),
      llmKey: z.string().trim().min(20).max(200).optional().or(z.literal("")),
      // OpenAI-compatible base URL. Optional WITH the key: many banks front their
      // own gateway, and forcing one would make BYOK mean "our endpoint".
      llmBaseUrl: z.string().trim().url().max(300).optional().or(z.literal("")),
    })
    .strict(),

  // Step 4's own field. Documents themselves are uploaded through
  // /api/console/documents, not through this route — the wizard acknowledges the
  // residency position, the uploader does the indexing.
  documents: z
    .object({
      pdplAcknowledged: z.literal(true, {
        error: "Confirm the data-residency position to continue",
      }),
    })
    .strict(),

  webhooks: z
    .object({
      vendorWebhookUrl: z.string().trim().max(500),
      vendorWebhookSecret: z.string().trim().min(16).max(200).optional().or(z.literal("")),
    })
    .strict(),
} as const;

export type SetupStepKeyName = keyof typeof stepSchemas;

/**
 * The schema for a step, as one uniform type.
 *
 * The five schemas have different fields, so the union of their inferred types
 * would make `.safeParse`'s result type a union of five shapes that no caller can
 * narrow. Validating against a single `ZodType` keeps `saveSetupStep` reading the
 * result through `Record<string, unknown>` and casting ONCE, in the place that
 * already knows which step it is handling.
 */
function stepSchemaFor(step: number): z.ZodType {
  return stepSchemas[stepForNumber(step)] as unknown as z.ZodType;
}

/** 1-based number → step key, clamped into range so a bad input cannot index off the end. */
export function stepForNumber(step: number): SetupStepKeyName {
  const entry = SETUP_STEPS.find((s) => s.id === step);
  return (entry?.key ?? "profile") as SetupStepKeyName;
}

export function isSetupStepKey(value: unknown): value is SetupStepKeyName {
  return typeof value === "string" && value in stepSchemas;
}

/* ── Reads ─────────────────────────────────────────────────────────────────── */

export type SetupState = {
  /** 1-based index of the step the operator should land on. */
  step: number;
  completed: boolean;
  completedAt: string | null;
  totalSteps: number;
  org: {
    name: string;
    logoUrl: string | null;
    institutionType: (typeof INSTITUTION_TYPES)[number];
    region: Region | null;
    shariahCompliant: boolean;
  };
  telecom: {
    twilioVoiceNumber: string | null;
    twilioSmsSenderId: string | null;
    twilioMessagingServiceSid: string | null;
    /** NEVER the token. Only whether one exists. */
    twilioAuthTokenConfigured: boolean;
  };
  ai: {
    elevenKeyMasked: string | null;
    llmKeyMasked: string | null;
    llmBaseUrl: string | null;
  };
  webhooks: {
    vendorWebhookUrl: string | null;
    /** NEVER the secret. Only whether one exists. */
    vendorWebhookSecretConfigured: boolean;
  };
  documents: {
    /** Acknowledgement is per-admin, so it is echoed from the client's own submit. */
    acknowledged: boolean;
  };
};

export async function getSetup(orgId: string, userId: string): Promise<SetupState> {
  const [org, profile] = await Promise.all([
    db.organization.findUnique({ where: { id: orgId } }),
    db.userProfile.findUnique({ where: { userId } }),
  ]);
  const region = (REGIONS as readonly string[]).includes(org?.region ?? "")
    ? (org!.region as Region)
    : null;

  // Secrets are unsealed only to produce a MASKED form. The plaintext goes out of
  // scope on the same line; nothing downstream of this function ever sees it.
  const eleven = profile?.elevenKeyEnc ? decryptSecret(profile.elevenKeyEnc) : null;
  const llm = profile?.llmKeyEnc ? decryptSecret(profile.llmKeyEnc) : null;

  return {
    step: clampStep(org?.setupStep ?? 1),
    completed: Boolean(org?.setupCompletedAt),
    completedAt: org?.setupCompletedAt?.toISOString() ?? null,
    totalSteps: SETUP_STEPS.length,
    org: {
      name: org?.name ?? "",
      logoUrl: org?.logo ?? null,
      institutionType: (INSTITUTION_TYPES as readonly string[]).includes(org?.institutionType ?? "")
        ? (org!.institutionType as (typeof INSTITUTION_TYPES)[number])
        : "bank",
      region,
      shariahCompliant: org?.shariahCompliant === true,
    },
    telecom: {
      twilioVoiceNumber: org?.twilioVoiceNumber ?? null,
      twilioSmsSenderId: org?.twilioSmsSenderId ?? null,
      twilioMessagingServiceSid: org?.twilioMessagingServiceSid ?? null,
      twilioAuthTokenConfigured: Boolean(org?.twilioAuthTokenEnc),
    },
    ai: {
      elevenKeyMasked: eleven ? maskKey(eleven) : null,
      llmKeyMasked: llm ? maskKey(llm) : null,
      llmBaseUrl: profile?.llmBaseUrl ?? null,
    },
    webhooks: {
      vendorWebhookUrl: org?.vendorWebhookUrl ?? null,
      vendorWebhookSecretConfigured: Boolean(org?.vendorWebhookSecretEnc),
    },
    documents: { acknowledged: false },
  };
}

function clampStep(step: number): number {
  if (!Number.isFinite(step)) return 1;
  return Math.min(Math.max(Math.trunc(step), 1), SETUP_STEPS.length);
}

/* ── Writes ────────────────────────────────────────────────────────────────── */

export type SaveResult = { ok: true; step: number } | { ok: false; error: string };

/**
 * Apply one step.
 *
 * `userId` matters because two of the five steps write to the USER profile, not
 * the tenant: BYOK keys are the individual's provider credentials. The org stays
 * the tenant for everything institutional (profile, telecom, webhooks).
 */
export async function saveSetupStep(
  orgId: string,
  userId: string,
  step: number,
  data: Record<string, unknown>,
): Promise<SaveResult> {
  const key = stepForNumber(step);
  const parsed = stepSchemaFor(step).safeParse(data);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: `${first?.path.join(".") || "field"} ${first?.message ?? "invalid"}`.trim(),
    };
  }
  const d = parsed.data as Record<string, unknown>;

  if (key === "profile") {
    const { orgName, orgLogoUrl, institutionType, region, shariahCompliant } = d as {
      orgName: string;
      orgLogoUrl?: string;
      institutionType: string;
      region: string;
      shariahCompliant: boolean;
    };
    await db.organization.update({
      where: { id: orgId },
      data: {
        name: orgName,
        logo: orgLogoUrl ? orgLogoUrl : null,
        institutionType,
        region,
        shariahCompliant,
      },
    });
    // Mirrored onto the profile because the Console header reads `orgName` from
    // THERE (the pre-tenant white-label path). Writing only the Organization
    // would leave the header showing the old name — the wizard would report
    // success on a field the operator can see did not change.
    await db.userProfile.update({
      where: { userId },
      data: { orgName, orgLogoUrl: orgLogoUrl ? orgLogoUrl : null },
    });
  }

  if (key === "telecom") {
    const { twilioVoiceNumber, twilioSmsSenderId, twilioMessagingServiceSid, twilioAuthToken } =
      d as {
        twilioVoiceNumber: string;
        twilioSmsSenderId: string;
        twilioMessagingServiceSid?: string;
        twilioAuthToken?: string;
      };
    const data_: Record<string, unknown> = {
      twilioVoiceNumber,
      twilioSmsSenderId,
      twilioMessagingServiceSid: twilioMessagingServiceSid ? twilioMessagingServiceSid : null,
    };
    // Empty means "leave the stored one alone" — the wizard never re-displays it,
    // so an operator who does not retype it must not silently lose it.
    if (twilioAuthToken) data_.twilioAuthTokenEnc = encryptSecret(twilioAuthToken);
    await db.organization.update({ where: { id: orgId }, data: data_ });
  }

  if (key === "ai") {
    const { elevenKey, llmKey, llmBaseUrl } = d as {
      elevenKey?: string;
      llmKey?: string;
      llmBaseUrl?: string;
    };
    const data_: Record<string, unknown> = {};
    if (elevenKey) data_.elevenKeyEnc = encryptSecret(elevenKey);
    if (llmKey) data_.llmKeyEnc = encryptSecret(llmKey);
    // The base URL is not a secret, so it is stored in the clear and is returned
    // by GET — an operator needs to SEE which gateway their key will be sent to.
    if (llmBaseUrl !== undefined) data_.llmBaseUrl = llmBaseUrl || null;
    if (Object.keys(data_).length > 0) {
      await db.userProfile.update({ where: { userId }, data: data_ });
    }
  }

  if (key === "webhooks") {
    const { vendorWebhookUrl, vendorWebhookSecret } = d as {
      vendorWebhookUrl: string;
      vendorWebhookSecret?: string;
    };
    const data_: Record<string, unknown> = {};
    if (vendorWebhookUrl === "") {
      data_.vendorWebhookUrl = null;
    } else {
      // SSRF-validated at the write, exactly like the settings route: a link-local
      // or metadata address must never become a row the delivery worker will POST
      // to later.
      const check = await assertVendorUrlSaveable(vendorWebhookUrl);
      if (!check.ok) return { ok: false, error: check.reason };
      data_.vendorWebhookUrl = check.url;
    }
    if (vendorWebhookSecret) data_.vendorWebhookSecretEnc = encryptSecret(vendorWebhookSecret);
    await db.organization.update({ where: { id: orgId }, data: data_ });
  }

  // `documents` has nothing to persist: the upload has its own route. It advances
  // the same way, so the acknowledgement still gates progress.
  const next = clampStep(step + 1);
  await db.organization.update({ where: { id: orgId }, data: { setupStep: next } });
  return { ok: true, step: next };
}

/**
 * Finish the wizard. Idempotent in its effect on the timestamp: a second Finish
 * keeps the ORIGINAL completion date, so re-running setup does not erase the
 * fact that this tenant was onboarded on a particular date.
 */
export async function completeSetup(orgId: string): Promise<{ ok: true; completedAt: Date }> {
  const row = await db.organization.findUnique({
    where: { id: orgId },
    select: { setupCompletedAt: true },
  });
  if (row?.setupCompletedAt) return { ok: true, completedAt: row.setupCompletedAt };
  const updated = await db.organization.update({
    where: { id: orgId },
    data: { setupStep: SETUP_STEPS.length, setupCompletedAt: new Date() },
    select: { setupCompletedAt: true },
  });
  return { ok: true, completedAt: updated.setupCompletedAt ?? new Date() };
}

/**
 * Skip the wizard for now. Progress is recorded (so the banner reappears) but
 * `setupCompletedAt` is NOT set — skipped is not onboarded, and conflating them
 * would make the Command Center claim an institution is configured when it is not.
 */
export async function skipSetup(orgId: string): Promise<{ ok: true; step: number }> {
  await db.organization.update({ where: { id: orgId }, data: { setupStep: 1 } });
  return { ok: true, step: 1 };
}
