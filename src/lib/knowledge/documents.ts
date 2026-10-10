import "server-only";

/**
 * The institution knowledge base: a tenant's own policy PDFs, made retrievable.
 *
 * This mirrors `src/lib/pinecone/transcript-index.ts` deliberately rather than
 * inventing a second convention. Transcripts already proved the shape that works
 * here — embed server-side through Pinecone's inference endpoint (no vendor key
 * sprawl), carry `metadata.orgId` on EVERY vector, filter by it on every query,
 * and re-check it after the query. The one thing that is deliberately different
 * is failure handling, because the two paths have different consequences:
 *
 *  - `indexTranscript` is best-effort. A vector-store outage must never flip a
 *    fraud case or erase evidence, so it logs and moves on.
 *  - `vectorizeDocument` is NOT. A document the operator uploaded and is waiting
 *    on has no other source of truth: if it silently "succeeds" with nothing
 *    embedded, the console claims a knowledge base that answers nothing. So this
 *    path writes an explicit status (FAILED + a machine-readable reason) for every
 *    outcome, and the reason is shown with a Retry button rather than swallowed.
 *
 * Three rules hold the rest of it together:
 *
 *  1. **Tenant scope is a parameter, never an option.** `searchDocuments` takes
 *     `orgId` and applies `filter: { orgId }`; the unscoped call is unrepresentable.
 *  2. **The raw upload is retained** (`Document.pdfBytes`) so Retry can re-extract
 *     without asking the operator to find the file again. It is capped at 8 MB on
 *     write. The bytes are the bank's own policy document, already inside the
 *     tenant boundary; nothing is added to them.
 *  3. **Idempotent.** A READY document is a no-op, because the queue retries.
 *     Without that, every QStash retry would re-embed an entire policy PDF.
 */

import { extractText } from "unpdf";
import { Pinecone } from "@pinecone-database/pinecone";
import { db } from "@/lib/db";
import { env } from "@/lib/config";
import { append as auditAppend } from "@/lib/audit-chain";
import { pineconeConfigured } from "@/lib/pinecone/transcript-index";

/** Upload ceiling. Enforced at the route; repeated here so the cap is not route-only. */
export const MAX_PDF_BYTES = 8 * 1024 * 1024;

/**
 * The status ladder, as a closed set.
 *
 * A closed set rather than a free string because the console renders a pill per
 * status and a typo'd status would render as a blank cell with no explanation —
 * the same failure as a document stuck in a state nobody knows about.
 */
export const DOC_STATUSES = ["PENDING", "CHUNKING", "EMBEDDING", "READY", "FAILED"] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

const API_KEY = process.env.PINECONE_API_KEY ?? "";
const INDEX = process.env.PINECONE_INDEX ?? "";
const HOST = process.env.PINECONE_HOST ?? "";
const NAMESPACE = process.env.PINECONE_NAMESPACE ?? "";

const EMBEDDING_MODEL = env.pineconeEmbeddingModel;

/** Vector id for one chunk. Deterministic, so a re-run overwrites in place. */
function vectorId(documentId: string, index: number): string {
  return `doc:${documentId}:${index}`;
}

function client(): Pinecone {
  return new Pinecone({ apiKey: API_KEY });
}

function index(pc: Pinecone) {
  return HOST ? pc.index(INDEX, HOST) : pc.index(INDEX);
}

export type DocumentSearchHit = {
  documentId: string;
  title: string;
  lang: string;
  chunkIndex: number;
  text: string;
  score: number;
};

/**
 * PDF → plain text.
 *
 * `mergePages: true` because policy documents are prose, not tables: without the
 * join, a sentence that straddles a page break is embedded as two fragments and
 * retrieves as neither.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const { text } = await extractText(new Uint8Array(bytes), { mergePages: true });
  return text;
}

/**
 * Split text into overlapping chunks.
 *
 * Pure and exported so the boundary behaviour can be unit-tested without a
 * database or an embedding call. The two properties that matter:
 *
 *  - `overlap` exists so a fact straddling a boundary is retrievable. Policy
 *    documents state obligations in sentences that routinely cross a naive split.
 *  - Splitting prefers a paragraph, then a sentence, then whitespace, then a hard
 *    cut. A hard cut mid-word produces an embedding that matches nothing, and it
 *    is the reason a naive `slice()` chunker looks fine on short input.
 */
export function chunkText(
  text: string,
  { maxChars = 1200, overlap = 150 }: { maxChars?: number; overlap?: number } = {},
): string[] {
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  // The overlap is capped at HALF the window, not merely at `maxChars - 1`.
  // That cap is what guarantees forward progress: the next window starts
  // `overlap` characters back, so an overlap larger than the step size would make
  // the cursor retreat and the loop would never terminate — a request that hangs
  // is worse than a document that chunks badly. Half the window still gives every
  // boundary fact a whole chunk to live in.
  const effOverlap = Math.max(0, Math.min(overlap, Math.floor(maxChars / 2)));

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + maxChars, normalized.length);
    if (end < normalized.length) {
      // Prefer the last paragraph break in the final third of the window, so a
      // chunk is not mostly trailing half-sentences. Then a sentence, then a
      // space; a hard cut mid-word produces an embedding that matches nothing.
      const floor = start + Math.floor(maxChars * 0.6);
      const window = normalized.slice(floor, end);
      const para = window.lastIndexOf("\n\n");
      if (para !== -1) {
        end = floor + para;
      } else {
        const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"));
        if (sentence !== -1) end = floor + sentence + 1;
        else {
          const space = window.lastIndexOf(" ");
          if (space !== -1) end = floor + space + 1;
        }
      }
      // A boundary can only ever land at or after `floor`, which is already past
      // `start`; this is belt-and-braces so the loop can never make zero progress.
      if (end <= start) end = Math.min(start + maxChars, normalized.length);
    }
    const piece = normalized.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= normalized.length) break;
    start = Math.max(end - effOverlap, start + 1);
  }
  return chunks;
}

export type VectorizeResult = { ok: true; chunkCount: number } | { ok: false; error: string };

/**
 * Extract → chunk → embed → upsert, moving the document through its status
 * ladder and recording the reason on every failure.
 *
 * Throws nothing: the caller (the queue handler, or the inline fallback) decides
 * what a failure means. The document row is the durable answer either way.
 */
export async function vectorizeDocument(documentId: string): Promise<VectorizeResult> {
  const doc = await db.document.findUnique({ where: { id: documentId } });
  if (!doc) return { ok: false, error: "document_not_found" };
  // The queue retries. A READY document is therefore already embedded, and
  // re-running it would re-embed the whole policy PDF for nothing.
  if (doc.status === "READY") return { ok: true, chunkCount: doc.chunkCount };
  // Retry is an explicit operator action that resets the row to PENDING; without
  // that reset a stuck FAILED document would refuse the retry forever.
  if (!doc.pdfBytes) return { ok: false, error: "pdf_bytes_missing" };

  const fail = async (error: string): Promise<VectorizeResult> => {
    await db.document.update({
      where: { id: documentId },
      data: { status: "FAILED", error: error.slice(0, 500) },
    });
    await auditAppend({
      callRef: `DOC-${documentId.slice(0, 24)}`,
      action: "agent",
      intent: "document_vectorize_failed",
      callerId: "system-knowledge",
      orgId: doc.orgId,
      redactedText: `document "${doc.title}" failed to vectorize: ${error.slice(0, 120)}`,
      meta: { error: error.slice(0, 200), chunks: 0 },
    }).catch(() => {});
    return { ok: false, error };
  };

  await db.document
    .update({ where: { id: documentId }, data: { status: "CHUNKING", error: null } })
    .catch(() => {});

  let chunks: string[];
  try {
    const text = await extractPdfText(new Uint8Array(doc.pdfBytes));
    chunks = chunkText(text);
  } catch (err) {
    return fail(`pdf_extract_failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (chunks.length === 0) return fail("no_extractable_text (scanned or empty PDF)");

  await db.document
    .update({ where: { id: documentId }, data: { status: "EMBEDDING" } })
    .catch(() => {});

  if (!pineconeConfigured()) return fail("pinecone_not_configured");
  if (!doc.orgId.trim()) return fail("org_id_required");

  const pc = client();
  try {
    const embeddings = await pc.inference.embed({
      model: EMBEDDING_MODEL,
      inputs: chunks,
      parameters: { inputType: "passage", truncate: "END" },
    });
    const values = (embeddings.data ?? []).map((d) => (d as { values?: number[] }).values ?? []);
    if (values.length !== chunks.length || values.some((v) => v.length === 0)) {
      return fail("no_dense_embedding");
    }

    const handle = index(pc);
    const namespace = NAMESPACE ? handle.namespace(NAMESPACE) : handle;
    await namespace.upsert({
      records: chunks.map((text, i) => ({
        id: vectorId(documentId, i),
        values: values[i]!,
        metadata: {
          orgId: doc.orgId,
          documentId,
          title: doc.title,
          lang: doc.lang,
          chunkIndex: i,
          text: text.slice(0, 4000),
        },
      })),
    });

    await db.document.update({
      where: { id: documentId },
      data: { status: "READY", chunkCount: chunks.length, error: null, vectorizedAt: new Date() },
    });
    await auditAppend({
      callRef: `DOC-${documentId.slice(0, 24)}`,
      action: "agent",
      intent: "document_vectorized",
      callerId: "system-knowledge",
      orgId: doc.orgId,
      redactedText: `document "${doc.title}" embedded into the knowledge base`,
      meta: { model: EMBEDDING_MODEL, chunks: chunks.length, chars: chunks.join("").length },
    }).catch(() => {});
    return { ok: true, chunkCount: chunks.length };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Tenant-scoped semantic search over uploaded documents.
 *
 * `orgId` is required and the filter is mandatory, for the same reason as
 * `searchTranscripts`: the cheapest guarantee that a cross-tenant policy leak is
 * never written is to make the unscoped call unrepresentable.
 */
export async function searchDocuments(
  orgId: string,
  question: string,
  topK = 5,
): Promise<{ ok: boolean; matches: DocumentSearchHit[]; error?: string }> {
  if (!orgId.trim()) return { ok: false, matches: [], error: "org_id_required" };
  if (!pineconeConfigured()) return { ok: false, matches: [], error: "pinecone_not_configured" };
  const trimmed = question.trim().slice(0, env.pineconeIndexMaxChars);
  if (!trimmed) return { ok: true, matches: [] };

  const pc = client();
  try {
    const embeddings = await pc.inference.embed({
      model: EMBEDDING_MODEL,
      inputs: [trimmed],
      parameters: { inputType: "query", truncate: "END" },
    });
    const first = embeddings.data?.[0] as { values?: number[] } | undefined;
    if (!first?.values || first.values.length === 0) {
      return { ok: false, matches: [], error: "no_dense_embedding" };
    }
    const handle = index(pc);
    const namespace = NAMESPACE ? handle.namespace(NAMESPACE) : handle;
    const res = await namespace.query({
      vector: first.values,
      topK,
      filter: { orgId },
      includeMetadata: true,
    });
    const matches = (res.matches ?? [])
      // Belt and braces, mirroring transcript search: a filter dropped server-side
      // would otherwise return another institution's policy text unnoticed.
      .filter((m) => m.metadata?.orgId === orgId)
      .map((m) => ({
        documentId: String(m.metadata?.documentId ?? ""),
        title: String(m.metadata?.title ?? ""),
        lang: String(m.metadata?.lang ?? ""),
        chunkIndex: Number(m.metadata?.chunkIndex ?? 0),
        text: String(m.metadata?.text ?? ""),
        score: m.score ?? 0,
      }));
    return { ok: true, matches };
  } catch (err) {
    return {
      ok: false,
      matches: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Erasure hook: remove a document's vectors, then the row.
 *
 * Vectors first. If the delete fails, the row survives and the operator can
 * retry; the reverse order would leave vectors with no row to ever be cleaned up,
 * which is the state a right-to-erasure request must never end in.
 */
export async function forgetDocument(documentId: string): Promise<{ ok: boolean; error?: string }> {
  if (pineconeConfigured()) {
    try {
      const pc = client();
      const handle = index(pc);
      const namespace = NAMESPACE ? handle.namespace(NAMESPACE) : handle;
      await namespace.deleteMany({ filter: { documentId } });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  await db.document.delete({ where: { id: documentId } });
  return { ok: true };
}
