import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/credits";
import { db } from "@/lib/db";
import { consume as consumeRateLimit } from "@/lib/ratelimit";
import { badRequest, unprocessable } from "@/lib/api-errors";
import { MAX_PDF_BYTES, vectorizeDocument } from "@/lib/knowledge/documents";
import { deferWork, scheduleVectorize } from "@/lib/knowledge/schedule";
import { append as auditAppend } from "@/lib/audit-chain";
import { logWarn } from "@/lib/validation/safe-log";

export const dynamic = "force-dynamic";

/**
 * The institution knowledge base — list and upload policy PDFs.
 *
 *   GET  /api/console/documents → this org's documents, newest first
 *   POST /api/console/documents → multipart upload (file, title?, lang?)
 *
 * Two things are decided here and nowhere else:
 *
 *  - **The org is server-derived.** Never a body field, never a header: the
 *    active organization IS the tenant (hazard AU-3). A session with no tenant
 *    gets a 409 rather than a document filed under a null org that no query
 *    could ever scope.
 *  - **The upload is validated by content, not by filename.** The declared
 *    MIME type is attacker-controlled, so the PDF magic bytes are what decides.
 *    A `.pdf` name on a shell script is refused; a real PDF renamed to `.pdf` is
 *    fine either way.
 *
 * Vectorization is NOT awaited here. It is handed to the queue (or, when QStash
 * is not configured, to `after()`), so the upload returns as soon as the row is
 * durable and the operator watches Pending → Chunking → Embedding → Ready.
 */

const ALLOWED_LANG = /^[a-z]{2}(-[A-Za-z]{2,4})?$/;

export async function GET() {
  const guard = await requireOperator();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  if (!guard.profile.orgId) {
    return NextResponse.json(
      { error: "No organization is linked to this account, so there is no knowledge base." },
      { status: 409 },
    );
  }

  const documents = await db.document.findMany({
    where: { orgId: guard.profile.orgId },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      title: true,
      fileName: true,
      mimeType: true,
      sizeBytes: true,
      lang: true,
      status: true,
      chunkCount: true,
      error: true,
      vectorizedAt: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ ok: true, documents }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const guard = await requireOperator();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const orgId = guard.profile.orgId;
  if (!orgId) {
    return NextResponse.json(
      { error: "No organization is linked to this account, so there is nowhere to file this." },
      { status: 409 },
    );
  }

  const rl = consumeRateLimit("console-documents", guard.profile.userId);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded; retry later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return badRequest("Expected multipart/form-data");
  }

  const file = form.get("file");
  if (!(file instanceof File)) return badRequest("file is required");
  if (file.size === 0) return badRequest("file is empty");
  if (file.size > MAX_PDF_BYTES) {
    return unprocessable(
      `file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 8 MB`,
      "file_too_large",
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  // Content check, not the declared type: "%PDF-" is the header every PDF
  // starts with, and it is the only part of the claim the attacker does not get
  // to choose freely.
  const isPdf = bytes.length > 5 && new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
  if (!isPdf) {
    return unprocessable(
      "Only PDF documents can be indexed. A scanned PDF with no text layer cannot be searched either.",
      "not_a_pdf",
    );
  }

  const rawTitle = String(form.get("title") ?? "").trim();
  const title = rawTitle || file.name.replace(/\.pdf$/i, "").slice(0, 120) || "Policy document";
  const rawLang = String(form.get("lang") ?? "").trim();
  if (rawLang && !ALLOWED_LANG.test(rawLang)) {
    return unprocessable("lang must be a BCP-47 tag such as en or ar", "invalid_lang");
  }
  const lang = rawLang || "en";

  const created = await db.document.create({
    data: {
      orgId,
      title: title.slice(0, 160),
      fileName: file.name.slice(0, 200) || "document.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.byteLength,
      lang,
      status: "PENDING",
      // The raw bytes are retained so Retry can re-extract without asking the
      // operator to find the file again. They are the bank's own policy document,
      // already inside the tenant boundary, capped above.
      pdfBytes: Buffer.from(bytes),
    },
    select: { id: true, title: true, status: true, createdAt: true },
  });

  await auditAppend({
    callRef: `DOC-${created.id.slice(0, 24)}`,
    action: "consent",
    intent: "document_uploaded",
    callerId: guard.profile.userId,
    orgId,
    redactedText: `policy document "${created.title}" uploaded`,
    meta: {},
  });

  // Fire-and-forget: the response must not wait on an embedding round-trip. When
  // QStash is configured this is a queue publish with its own retry ladder and
  // DLQ; otherwise `deferWork` runs it once the response is on the wire.
  deferWork(async () => {
    const queued = await scheduleVectorize(created.id, orgId);
    if (!queued) {
      const res = await vectorizeDocument(created.id);
      if (!res.ok) {
        logWarn("[knowledge] inline vectorize failed", {
          documentId: created.id,
          error: res.error,
        });
      }
    }
  });

  return NextResponse.json({ ok: true, document: created }, { status: 201 });
}
