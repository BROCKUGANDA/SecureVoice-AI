import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperator } from "@/lib/credits";
import { db } from "@/lib/db";
import { generateProducerKey, hashProducerKey } from "@/lib/producer-keys";

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
  const keys = await db.producerKey.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, label: true, orgId: true, revoked: true, lastUsedAt: true, createdAt: true },
    take: 20,
  });
  return NextResponse.json({ keys }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const guard = await requireOperator();
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
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
    data: { label: parsed.data.label, keyHash: hashProducerKey(plaintext), orgId: guard.profile.orgId },
    select: { id: true, label: true, createdAt: true },
  });
  return NextResponse.json({ ok: true, key: plaintext, ...row, note: "Copy it now — it is shown only once." });
}

export async function DELETE(req: NextRequest) {
  const guard = await requireOperator();
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 422 });
  await db.producerKey.update({ where: { id }, data: { revoked: true } }).catch(() => null);
  return NextResponse.json({ ok: true, revoked: id });
}
