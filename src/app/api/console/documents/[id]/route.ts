import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/credits";
import { db } from "@/lib/db";
import { forgetDocument } from "@/lib/knowledge/documents";
import { append as auditAppend } from "@/lib/audit-chain";

export const dynamic = "force-dynamic";

/**
 * Delete one knowledge document.
 *
 *   DELETE /api/console/documents/:id → remove the row AND its vectors
 *
 * Tenant scoping is the whole point of the lookup: the WHERE clause carries
 * `orgId`, so another institution's document id returns the same 404 as a
 * nonexistent one. A 403-with-body for a foreign id would confirm the document
 * exists, which is itself a leak — the operator learns a competitor uploaded a
 * "Fraud Disposition Policy v4" without being able to read it.
 *
 * Vectors are deleted before the row (see `forgetDocument`). The reverse order
 * leaves vectors nothing can ever reach again, which is exactly the state a
 * right-to-erasure request must not end in.
 */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireOperator();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const orgId = guard.profile.orgId;
  if (!orgId) {
    return NextResponse.json(
      { error: "No organization is linked to this account, so there is nothing to delete." },
      { status: 409 },
    );
  }
  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const found = await db.document.findFirst({
    where: { id, orgId },
    select: { id: true, title: true },
  });
  if (!found) return NextResponse.json({ error: "not found" }, { status: 404 });

  const removed = await forgetDocument(id);
  if (!removed.ok) {
    // The row is deliberately NOT deleted: the vectors are still there, and
    // dropping the row would strand them with no operator-visible retry.
    return NextResponse.json(
      { error: `could not remove indexed chunks: ${removed.error ?? "unknown"}` },
      { status: 502 },
    );
  }

  await auditAppend({
    callRef: `DOC-${id.slice(0, 24)}`,
    action: "consent",
    intent: "document_deleted",
    callerId: guard.profile.userId,
    orgId,
    redactedText: `policy document "${found.title}" deleted`,
    meta: {},
  });

  return NextResponse.json({ ok: true, id });
}
