import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/credits";
import { db } from "@/lib/db";
import { vectorizeDocument } from "@/lib/knowledge/documents";
import { deferWork, scheduleVectorize } from "@/lib/knowledge/schedule";
import { append as auditAppend } from "@/lib/audit-chain";

export const dynamic = "force-dynamic";

/**
 * Re-run vectorization for a document that FAILED.
 *
 *   POST /api/console/documents/:id/retry → reset to PENDING and re-enqueue
 *
 * The most common failure is `pinecone_not_configured`, and the operator who
 * fixes it needs the document to actually become searchable — not a second FAILED
 * row with the same reason. So this clears `error` and re-enters the same
 * pipeline, rather than asking them to delete and re-upload the file.
 *
 * `pdfBytes` is retained precisely so this works. Without it, Retry could only
 * have told the operator to find the PDF again.
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireOperator();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const orgId = guard.profile.orgId;
  if (!orgId) {
    return NextResponse.json(
      { error: "No organization is linked to this account, so there is nothing to retry." },
      { status: 409 },
    );
  }
  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const found = await db.document.findFirst({
    where: { id, orgId },
    select: { id: true, title: true, status: true, pdfBytes: true },
  });
  if (!found) return NextResponse.json({ error: "not found" }, { status: 404 });

  // A document still moving through the ladder is not failed; re-running it would
  // race the run already in flight.
  if (found.status !== "FAILED" && found.status !== "READY") {
    return NextResponse.json(
      { error: `document is ${found.status}; retry is only for a failed or ready document` },
      { status: 409 },
    );
  }
  if (!found.pdfBytes) {
    return NextResponse.json(
      { error: "the uploaded PDF was not retained, so this document must be re-uploaded" },
      { status: 409 },
    );
  }

  await db.document.update({
    where: { id },
    data: { status: "PENDING", error: null, chunkCount: 0, vectorizedAt: null },
  });

  await auditAppend({
    callRef: `DOC-${id.slice(0, 24)}`,
    action: "consent",
    intent: "document_retry_requested",
    callerId: guard.profile.userId,
    orgId,
    redactedText: `vectorization retried for "${found.title}"`,
    meta: {},
  });

  deferWork(async () => {
    const queued = await scheduleVectorize(id, orgId);
    if (!queued) await vectorizeDocument(id);
  });

  return NextResponse.json({ ok: true, id, status: "PENDING" });
}
