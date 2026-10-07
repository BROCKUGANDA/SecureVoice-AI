import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOperator } from "@/lib/credits";
import { append as auditAppend } from "@/lib/audit-chain";
import { deleteConnection, listConnections, saveConnection, setEnabled } from "@/lib/crm/store";
import { CRM_PROVIDERS, testConnection } from "@/lib/crm";

export const dynamic = "force-dynamic";

/**
 * CRM connections for the operator's organization:
 *   GET                → masked summaries only (never the decrypted config)
 *   POST   { provider, config }           → save (validated, encrypted at rest)
 *   POST   { provider, config, test:true }→ validate + save, then send a labelled
 *                                           TEST ticket and report the outcome
 *   PATCH  { provider, enabled }          → pause/resume
 *   DELETE ?provider=                     → disconnect
 *
 * Creating or changing a connection changes where fraud-case tickets go, so every
 * write is an audit row, like BYOK and producer keys.
 */

const schema = z.object({
  provider: z.enum(CRM_PROVIDERS),
  config: z.record(z.string(), z.string().max(2000)),
  test: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

export async function GET() {
  const guard = await requireOperator();
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  if (!guard.profile.orgId) return NextResponse.json({ connections: [] });
  const connections = await listConnections(guard.profile.orgId);
  return NextResponse.json({ connections }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const guard = await requireOperator();
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  if (!guard.profile.orgId) {
    return NextResponse.json(
      { error: "No organization linked to this account, so there is nothing to connect." },
      { status: 409 },
    );
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "provider (zendesk|salesforce|webhook) and config are required" },
      { status: 422 },
    );
  }
  const saved = await saveConnection(guard.profile.orgId, parsed.data.provider, parsed.data.config);
  if (!saved.ok) {
    return NextResponse.json({ error: saved.error }, { status: 422 });
  }
  await auditAppend({
    callRef: `CRM-${guard.profile.orgId.slice(0, 24)}`,
    action: "consent",
    intent: "crm_connection_saved",
    callerId: guard.profile.userId,
    redactedText: `${parsed.data.provider} connection saved`,
    meta: { provider: parsed.data.provider, orgId: guard.profile.orgId },
    orgId: guard.profile.orgId,
  });
  if (parsed.data.test === true) {
    const result = await testConnection(guard.profile.orgId, parsed.data.provider);
    return NextResponse.json({ ok: true, tested: result });
  }
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest) {
  const guard = await requireOperator();
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  if (!guard.profile.orgId) return NextResponse.json({ error: "No organization" }, { status: 409 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = z
    .object({ provider: z.enum(CRM_PROVIDERS), enabled: z.boolean() })
    .safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "provider and enabled (boolean) are required" },
      { status: 422 },
    );
  }
  await setEnabled(guard.profile.orgId, parsed.data.provider, parsed.data.enabled);
  await auditAppend({
    callRef: `CRM-${guard.profile.orgId.slice(0, 24)}`,
    action: "consent",
    intent: parsed.data.enabled ? "crm_connection_enabled" : "crm_connection_disabled",
    callerId: guard.profile.userId,
    redactedText: `${parsed.data.provider} ${parsed.data.enabled ? "enabled" : "disabled"}`,
    meta: { provider: parsed.data.provider, orgId: guard.profile.orgId },
    orgId: guard.profile.orgId,
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const guard = await requireOperator();
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  if (!guard.profile.orgId) return NextResponse.json({ error: "No organization" }, { status: 409 });
  const provider = req.nextUrl.searchParams.get("provider");
  if (!provider || !(CRM_PROVIDERS as readonly string[]).includes(provider)) {
    return NextResponse.json(
      { error: "provider=zendesk|salesforce|webhook is required" },
      { status: 422 },
    );
  }
  await deleteConnection(guard.profile.orgId, provider as (typeof CRM_PROVIDERS)[number]);
  await auditAppend({
    callRef: `CRM-${guard.profile.orgId.slice(0, 24)}`,
    action: "consent",
    intent: "crm_connection_deleted",
    callerId: guard.profile.userId,
    redactedText: `${provider} disconnected`,
    meta: { provider, orgId: guard.profile.orgId },
    orgId: guard.profile.orgId,
  });
  return NextResponse.json({ ok: true, removed: provider });
}
