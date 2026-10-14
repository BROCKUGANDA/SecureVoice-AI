import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOperator } from "@/lib/credits";
import { requirePrivileged } from "@/lib/auth/guards";
import { NO_ORG } from "@/lib/auth/identity";
import { db } from "@/lib/db";
import { generateProducerKey, hashProducerKey } from "@/lib/producer-keys";
import { append as auditAppend } from "@/lib/audit-chain";

export const dynamic = "force-dynamic";

/**
 * Bank-integration API keys (headless producers).
 *   GET    /api/console/producer-keys         → list (masked)
 *   POST   { label }                          → create; plaintext returned ONCE
 *   DELETE ?id=                               → revoke
 */

const createSchema = z.object({ label: z.string().trim().min(2).max(60) });

export async function GET() {
  const guard = await requireOperator();
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  // Tenant scope — an operator must never see another org's keys.
  const orgScope = guard.profile.orgId
    ? { orgId: guard.profile.orgId }
    : { OR: [{ orgId: null }, { orgId: "default" }] };
  const keys = await db.producerKey.findMany({
    where: orgScope,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      label: true,
      orgId: true,
      revoked: true,
      lastUsedAt: true,
      createdAt: true,
    },
    take: 20,
  });
  return NextResponse.json({ keys }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  // Capability AND step-up. Issuing a headless credential that authenticates
  // ingest for this organisation is exactly what the privileged-action registry
  // names `rotate_producer_key` for — and docs/SECURITY-QUESTIONNAIRE.md already
  // tells auditors the gate exists. A stolen console session previously needed
  // nothing more than a valid cookie to mint one.
  const authed = await requirePrivileged(req.headers.get("cookie"), "rotate_producer_key");
  if (!authed.ok) {
    return NextResponse.json(
      { error: authed.error, code: authed.code },
      { status: authed.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  // The route's own bucketing is preserved: an identity without a workspace has
  // always produced a NULL-org key that reads back through the "default"
  // fallback. A security change is not the place to silently re-bucket keys.
  const keyOrgId = authed.orgId === NO_ORG ? null : authed.orgId;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "label must be 2-60 characters" }, { status: 422 });
  }
  const plaintext = generateProducerKey();
  const row = await db.producerKey.create({
    data: {
      label: parsed.data.label,
      keyHash: hashProducerKey(plaintext),
      orgId: keyOrgId,
    },
    select: { id: true, label: true, createdAt: true },
  });
  // Issuing a credential is a security event. The key itself is never in the
  // record — only its id and label, because the plaintext is shown once and
  // hashing it into an audit row would help nobody and risk a lot.
  await auditAppend({
    callRef: `PRODKEY-${row.id.slice(0, 24)}`,
    action: "consent",
    intent: "producer_key_issued",
    callerId: authed.identity.accountId,
    redactedText: `issued "${parsed.data.label}"`,
    meta: { keyId: row.id, label: parsed.data.label, orgId: keyOrgId ?? undefined },
    orgId: keyOrgId ?? undefined,
  });
  return NextResponse.json({
    ok: true,
    key: plaintext,
    ...row,
    note: "Copy it now — it is shown only once.",
  });
}

export async function DELETE(req: NextRequest) {
  // Revoking is gated too, and not for symmetry: killing a bank's producer key
  // stops its fraud engine authenticating to ingest, which is an outage an
  // attacker can cause with one stolen cookie today.
  const authed = await requirePrivileged(req.headers.get("cookie"), "rotate_producer_key");
  if (!authed.ok) {
    return NextResponse.json(
      { error: authed.error, code: authed.code },
      { status: authed.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  const keyOrgId = authed.orgId === NO_ORG ? null : authed.orgId;
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 422 });
  // Tenant scope on the revocation itself — an operator must not revoke
  // another org's key by id, and a miss must not report success.
  const orgScope = keyOrgId ? { orgId: keyOrgId } : { OR: [{ orgId: null }, { orgId: "default" }] };
  const r = await db.producerKey.updateMany({
    where: { id, ...orgScope },
    data: { revoked: true },
  });
  if (r.count === 0) {
    return NextResponse.json({ error: "Key not found in this workspace" }, { status: 404 });
  }
  await auditAppend({
    callRef: `PRODKEY-${id.slice(0, 24)}`,
    action: "consent",
    intent: "producer_key_revoked",
    callerId: authed.identity.accountId,
    redactedText: "revoked",
    meta: { keyId: id, orgId: keyOrgId ?? undefined },
    orgId: keyOrgId ?? undefined,
  });
  return NextResponse.json({ ok: true, revoked: id });
}
