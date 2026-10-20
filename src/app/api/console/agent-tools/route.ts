import { NextResponse } from "next/server";
import { randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import { requireOperator } from "@/lib/credits";
import { append as auditAppend } from "@/lib/audit-chain";
import { AGENT_TOOL_NAMES } from "@/lib/agent-tool-auth";
import { db } from "@/lib/db";
import { parseJson } from "@/lib/validation/safe-log";

export const dynamic = "force-dynamic";

/**
 * Tenant-scoped lifecycle for agent-tool credentials.
 *
 * The secret is generated here, shown exactly once, and stored only as a
 * SHA-256 hash. `toolScope` narrows the credential to the named tools; a
 * credential without a scope is refused by the resolver, so there is no
 * "create one and inherit every tool" path.
 */
const createSchema = z.object({
  label: z.string().trim().min(2).max(80),
  tools: z.array(z.enum(AGENT_TOOL_NAMES)).min(1).max(AGENT_TOOL_NAMES.length),
});

const revokeSchema = z.object({ id: z.string().min(1).max(64) });

function orgRequired(): NextResponse {
  return NextResponse.json(
    { error: "Select an organization before managing agent-tool credentials." },
    { status: 400 },
  );
}

export async function GET() {
  const guard = await requireOperator();
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const orgId = guard.profile.orgId;
  if (!orgId) return orgRequired();

  const rows = await db.agentToolSecret.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      label: true,
      toolScope: true,
      revoked: true,
      lastUsedAt: true,
      createdAt: true,
    },
  });
  return NextResponse.json(
    {
      credentials: rows.map((r) => ({
        ...r,
        lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const guard = await requireOperator();
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const orgId = guard.profile.orgId;
  if (!orgId) return orgRequired();

  const body = await parseJson(req);
  if (body === null) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "label and at least one valid tool are required" },
      { status: 422 },
    );
  }

  const tools = [...new Set(parsed.data.tools)];
  const secret = `svt_${randomBytes(32).toString("base64url")}`;
  const keyHash = createHash("sha256").update(secret).digest("hex");
  const row = await db.agentToolSecret.create({
    data: {
      label: parsed.data.label,
      keyHash,
      orgId,
      toolScope: tools.join(","),
    },
    select: { id: true, label: true, toolScope: true, createdAt: true },
  });

  await auditAppend({
    callRef: `TOOLKEY-${row.id}`,
    action: "agent",
    intent: "agent_tool_secret_created",
    callerId: guard.profile.userId,
    meta: { toolScope: row.toolScope, label: row.label },
    orgId,
  }).catch(() => {});

  return NextResponse.json(
    {
      credential: {
        id: row.id,
        label: row.label,
        toolScope: row.toolScope,
        createdAt: row.createdAt.toISOString(),
      },
      // The only time the plaintext exists outside the caller's process.
      secret,
    },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE(req: Request) {
  const guard = await requireOperator();
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const orgId = guard.profile.orgId;
  if (!orgId) return orgRequired();

  const body = await parseJson(req);
  const parsed = revokeSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "id is required" }, { status: 422 });

  const result = await db.agentToolSecret.updateMany({
    where: { id: parsed.data.id, orgId, revoked: false },
    data: { revoked: true },
  });
  if (result.count === 0) {
    return NextResponse.json({ error: "Credential not found" }, { status: 404 });
  }

  await auditAppend({
    callRef: `TOOLKEY-${parsed.data.id}`,
    action: "agent",
    intent: "agent_tool_secret_revoked",
    callerId: guard.profile.userId,
    orgId,
  }).catch(() => {});

  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
