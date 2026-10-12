import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { requireOperator } from "@/lib/credits";
import { db } from "@/lib/db";
import { withTenantScope } from "@/lib/tenancy/db-scope";
import { decryptSecret, encryptSecret, maskKey } from "@/lib/byok";
import { append as auditAppend } from "@/lib/audit-chain";
import { getInstitutionType, setInstitutionType } from "@/lib/institution";
import { INSTITUTION_TYPES } from "@/lib/institution-types";
import { assertVendorUrlSaveable } from "@/lib/vendor-endpoint";
import { orgPlanContext } from "@/lib/billing/plan-context";

export const dynamic = "force-dynamic";

/**
 * Operator settings — white-labeling + BYOK (Bring Your Own Key).
 *
 *   GET    /api/console/settings → { orgName, orgLogoUrl, elevenKey: masked|null, credits }
 *   POST   /api/console/settings → { orgName?, orgLogoUrl?, elevenKey? }  (partial update)
 *   DELETE /api/console/settings?field=elevenKey → removes the BYOK key
 *
 * BYOK security: the ElevenLabs key is AES-256-GCM encrypted at rest with an
 * AUTH_SECRET-derived key, decrypted only in-process for upstream calls, and
 * only ever returned masked (sk_…last4).
 *
 * ── Which half of this route is database-enforced ───────────────────────────
 * The route touches two tables, and they are not in the same position:
 *
 *   · `UserProfile` carries `orgId` and has a row-level policy, so a session
 *     naming a concrete organisation reads and writes it inside
 *     `withTenantScope` (src/lib/tenancy/db-scope.ts). This matters here more
 *     than it looks: every profile statement in this file is keyed on
 *     `userId`, which is the caller's OWN identity, so there is no org predicate
 *     to write — the policy is the only thing standing between a session and a
 *     profile row that belongs to a different tenant.
 *   · `Organization` has no `orgId` column (it IS the tenant) and the coverage
 *     migration gives it RLS with NO policy, which makes `sv_tenant` blind to it
 *     on purpose: an organisation row is what resolves the tenant, so a policy
 *     comparing `organization.id` to `app.org_id` could only be evaluated after
 *     the tenant was already known. Those reads and the org write therefore stay
 *     on the ordinary application client — the id used is the session's own
 *     `orgId`, never a request field. Wrapping them would not tighten anything;
 *     it would make `vendorWebhookUrl`/`shariahCompliant` read as unset and turn
 *     the tenant write into a zero-row update.
 *
 * A session with no organisation keeps today's client too. It cannot go through
 * `withTenantScope` (there is no tenant to pin) and it cannot go through
 * `scopedDb` either: the guard's shared namespace is `orgId IS NULL OR
 * orgId = 'default'`, and `UserProfile.orgId` is a `uuid` column, so the
 * `'default'` arm is rejected by Postgres as `invalid input syntax for type
 * uuid` before any row is read. That is a property of the schema, not of this
 * route, and it is asserted in tests/tenancy/org-models.test.ts; the tenant
 * boundary itself — a profile row belonging to another organisation is not
 * readable or updatable through this session — is asserted in
 * tests/tenancy/console-routes.test.ts against the live handler.
 */

const schema = z.object({
  orgName: z.string().trim().max(60).optional(),
  orgLogoUrl: z.string().trim().url().max(300).optional().or(z.literal("")),
  elevenKey: z.string().trim().min(20).max(80).optional(),
  // A closed set: "bank" | "insurer". Anything else is a 422, never coerced.
  institutionType: z.enum(INSTITUTION_TYPES).optional(),
  // Where this institution's own systems are called back. Empty string clears it
  // and falls back to the deployment default.
  vendorWebhookUrl: z.string().trim().max(500).optional(),
  // Written once, never read back — the response only says whether one is set.
  vendorWebhookSecret: z.string().trim().min(16).max(200).optional(),
  shariahCompliant: z.boolean().optional(),
});

/** The delegate this route touches for the operator's own profile row. */
type ProfileDelegate = Prisma.TransactionClient["userProfile"];

/**
 * Run `fn` against the `UserProfile` delegate on the enforcement path that
 * matches the session: a concrete organisation enters `withTenantScope` and the
 * row-level policy decides; an org-less session keeps the ordinary client, for
 * the reason documented at the top of this file.
 *
 * The statement is the same either way, which is the point — the branch selects
 * WHO ENFORCES IT, not what is queried.
 */
async function withProfileScope<T>(
  orgId: string | null,
  fn: (profiles: ProfileDelegate) => Promise<T>,
): Promise<T> {
  return orgId ? withTenantScope(orgId, (tx) => fn(tx.userProfile)) : fn(db.userProfile);
}

async function readSettings(): Promise<
  { settings: Record<string, unknown> } | { error: { status: number; error: string } }
> {
  const guard = await requireOperator();
  if (!guard.ok) return { error: { status: guard.status, error: guard.error } };
  const row = await withProfileScope(guard.profile.orgId, (profiles) =>
    profiles.findUnique({ where: { userId: guard.profile.userId } }),
  );
  if (!row) return { error: { status: 404, error: "Profile not found" } };
  const key = row.elevenKeyEnc ? decryptSecret(row.elevenKeyEnc) : null;
  const plan = await orgPlanContext(guard.profile.orgId);
  return {
    settings: {
      orgName: row.orgName ?? null,
      orgLogoUrl: row.orgLogoUrl ?? null,
      elevenKeyMasked: key ? maskKey(key) : null,
      // The EFFECTIVE balance — the organization's wallet when the session
      // carries an active tenant, otherwise this operator's own. Reading
      // `row.credits` here would show the per-user wallet while the fire route
      // actually spends the org wallet, so the billing tab and the console
      // would disagree by exactly the amount that matters.
      credits: guard.profile.credits,
      walletScope: guard.profile.walletScope,
      // Bank or insurer: changes how the institution is spoken about to ITS
      // customers (call, voicemail, SMS). Defaults to "bank".
      institutionType: await getInstitutionType(guard.profile.orgId),
      // The tenant's real plan, resolved server-side. `PolicyForPlan` renders the
      // refund policy from it, and this view used to pass `planTier={null}` —
      // which is the demo tier — so a paying bank was told it had no refunds
      // while its own wallet was being billed as `creditWallet`. The tier is not
      // accepted from the request for the same reason the wallet is not: it is a
      // fact about what was bought, and the buyer does not get to state it.
      planTier: plan.tier,
      planName: plan.plan,
      paid: plan.paid,
      ...(await readTenantVoiceSettings(guard.profile.orgId)),
    },
  };
}

/**
 * The organisation-scoped settings, read for the console.
 *
 * The signing key is deliberately absent: it is write-only, and returning it in
 * any form — masked or otherwise — turns a console session into a credential
 * exfiltration target. The console learns only whether one exists.
 *
 * `db.organization` and not `withTenantScope`: `organization` is the tenant table,
 * it has no `orgId` column, and the coverage migration gives it row security with
 * NO policy so that the tenant role cannot enumerate organisations at all. Inside
 * a tenant scope this read returns nothing, which would report every tenant's
 * webhook endpoint as unset. The id looked up is `guard.profile.orgId` — the
 * session's own organisation, never a request field — so there is no org
 * predicate to forget here.
 */
async function readTenantVoiceSettings(orgId: string | null | undefined) {
  if (!orgId) {
    return { vendorWebhookUrl: null, vendorWebhookConfigured: false, shariahCompliant: false };
  }
  const org = await db.organization.findUnique({
    where: { id: orgId },
    select: { vendorWebhookUrl: true, vendorWebhookSecretEnc: true, shariahCompliant: true },
  });
  return {
    vendorWebhookUrl: org?.vendorWebhookUrl ?? null,
    vendorWebhookConfigured: Boolean(org?.vendorWebhookSecretEnc),
    shariahCompliant: org?.shariahCompliant === true,
  };
}

export async function GET() {
  const result = await readSettings();
  if ("error" in result) {
    return NextResponse.json({ error: result.error.error }, { status: result.error.status });
  }
  return NextResponse.json(result.settings, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const guard = await requireOperator();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: `${first?.path.join(".")} ${first?.message ?? "invalid"}` },
      { status: 422 },
    );
  }
  const d = parsed.data;

  const data: Record<string, unknown> = {};
  if (d.orgName !== undefined) data.orgName = d.orgName || null;
  if (d.orgLogoUrl !== undefined) data.orgLogoUrl = d.orgLogoUrl || null;
  if (d.elevenKey !== undefined) {
    // sanity: platform key format is sk_… — accept the operator's own too
    data.elevenKeyEnc = encryptSecret(d.elevenKey);
  }

  // The institution type lives on the ORGANIZATION (the tenant), not the user
  // profile, so it is written separately. A user with no organization has no
  // tenant to configure - refuse rather than silently drop the change.
  let institutionChanged = false;
  if (d.institutionType !== undefined) {
    if (!guard.profile.orgId) {
      return NextResponse.json(
        {
          error:
            "No organization is linked to this account, so there is no institution type to set.",
        },
        { status: 409 },
      );
    }
    const res = await setInstitutionType(guard.profile.orgId, d.institutionType);
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: 422 });
    institutionChanged = true;
  }

  // Organisation-scoped voice settings, written on the same rule as the
  // institution type: no organization means nothing to configure, refused
  // rather than dropped onto the user row where the next reader would not find
  // it. Accepting these fields in the schema without writing them here would
  // tell the operator their endpoint was saved while every event kept going to
  // the deployment default.
  const wantsTenantWrite =
    d.vendorWebhookUrl !== undefined ||
    d.vendorWebhookSecret !== undefined ||
    d.shariahCompliant !== undefined;
  if (wantsTenantWrite) {
    if (!guard.profile.orgId) {
      return NextResponse.json(
        { error: "No organization is linked to this account, so there is nothing to configure." },
        { status: 409 },
      );
    }
    const tenantData: Record<string, unknown> = {};

    if (d.vendorWebhookUrl !== undefined) {
      if (d.vendorWebhookUrl === "") {
        tenantData.vendorWebhookUrl = null;
      } else {
        // Validated at the write, so a link-local or metadata address never
        // becomes a row the delivery worker will POST to later.
        const check = await assertVendorUrlSaveable(d.vendorWebhookUrl);
        if (!check.ok) return NextResponse.json({ error: check.reason }, { status: 422 });
        tenantData.vendorWebhookUrl = check.url;
      }
    }
    if (d.vendorWebhookSecret !== undefined) {
      tenantData.vendorWebhookSecretEnc = encryptSecret(d.vendorWebhookSecret);
    }
    if (d.shariahCompliant !== undefined) {
      tenantData.shariahCompliant = d.shariahCompliant;
    }

    // The same rule as the read above: `organization` is the tenant row and is
    // outside the tenant role's reach by design, so this write stays on the
    // application client with the session's own org id as the key.
    await db.organization.update({ where: { id: guard.profile.orgId }, data: tenantData });
    void auditAppend({
      action: "handoff",
      intent: "vendor_endpoint_changed",
      callRef: guard.profile.orgId,
      orgId: guard.profile.orgId,
      // Which fields changed, never their values: the signing key must not
      // reach the audit chain in any form.
      meta: { fields: Object.keys(tenantData) },
    }).catch(() => {});
  }

  if (Object.keys(data).length > 0) {
    // The BYOK / white-label write. Keyed on the caller's own `userId`, so the
    // policy is what makes it a tenant write: inside `withTenantScope` a profile
    // row belonging to another organisation is not updatable — the WITH CHECK arm
    // of the policy rejects the new row version and the transaction rolls back.
    await withProfileScope(guard.profile.orgId, (profiles) =>
      profiles.update({ where: { userId: guard.profile.userId }, data }),
    );
  }

  // Storing or rotating a vendor credential is a security event, so it is
  // recorded like one. The KEY ITSELF IS NEVER LOGGED — only that it changed
  // and a masked fingerprint, which is the difference between an audit trail
  // that proves rotation happened and one that becomes a secret exfiltration
  // path of its own.
  const touched = [...Object.keys(data), ...(institutionChanged ? ["institutionType"] : [])];
  if (touched.length > 0) {
    await auditAppend({
      callRef: `SETTINGS-${guard.profile.userId.slice(0, 24)}`,
      action: "consent",
      intent: d.elevenKey !== undefined ? "by_key_set" : "settings_update",
      callerId: guard.profile.userId,
      redactedText: touched
        .map((f) => (f === "elevenKeyEnc" ? `elevenKey=***${maskKey(d.elevenKey ?? "")}` : f))
        .join(", "),
      meta: {
        fields: touched,
        byokChanged: d.elevenKey !== undefined,
        byokFingerprint: d.elevenKey !== undefined ? maskKey(d.elevenKey!) : undefined,
        orgId: guard.profile.orgId ?? undefined,
      },
      orgId: guard.profile.orgId ?? undefined,
    });
  }

  const result = await readSettings();
  if ("error" in result) {
    return NextResponse.json({ error: result.error.error }, { status: result.error.status });
  }
  return NextResponse.json({ ok: true, ...result.settings });
}

export async function DELETE(req: NextRequest) {
  const guard = await requireOperator();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const field = req.nextUrl.searchParams.get("field");
  if (field !== "elevenKey") {
    return NextResponse.json({ error: "field must be elevenKey" }, { status: 422 });
  }
  // Same two paths as the read: the BYOK key is a column on the operator's
  // tenant-namespaced profile row, so under a concrete organisation the policy
  // decides which row this DELETE is allowed to clear.
  await withProfileScope(guard.profile.orgId, (profiles) =>
    profiles.update({ where: { userId: guard.profile.userId }, data: { elevenKeyEnc: null } }),
  );
  // Removal of a stored vendor credential is audited for the same reason as
  // setting it: both are the events a security reviewer asks to see.
  await auditAppend({
    callRef: `SETTINGS-${guard.profile.userId.slice(0, 24)}`,
    action: "consent",
    intent: "by_key_removed",
    callerId: guard.profile.userId,
    redactedText: "elevenKey removed",
    meta: { fields: ["elevenKeyEnc"], byokChanged: true, orgId: guard.profile.orgId ?? undefined },
    orgId: guard.profile.orgId ?? undefined,
  });
  return NextResponse.json({ ok: true, removed: "elevenKey" });
}
