import "server-only";

/**
 * Case transcripts, indexed for SEMANTIC SEARCH when the operator has
 * explicitly pointed us at a Pinecone project.
 *
 * Why this lives behind a flag rather than being unconditional:
 *
 *  - Transcripts are the most sensitive rows we have. Writing them into a
 *    third-party vector database is not something a tenant should get as a
 *    surprise; they get it when they set PINECONE_API_KEY, and the absence
 *    of that env var is how an on-prem deployment proves nothing has left
 *    the building.
 *  - The intake path seals transcripts into the audit chain with
 *    crypto-shred (src/lib/privacy/crypto-shred.ts) BEFORE this is called.
 *    This function therefore indexes the same REDACTED text the operator UI
 *    already shows — never the raw intake.
 *  - A failure here is always best-effort: the post-call transcript is the
 *    only thing being indexed, and the bank has already been told the
 *    case's outcome. A vector-store outage must not flip a case or erase
 *    evidence; it logs, emits an audit row, and moves on.
 *
 * Embedding is done server-side via Pinecone's inference endpoint (no
 * vendor key sprawl), and every record carries the caseRef so a retention
 * sweep can delete by prefix.
 */

import { Pinecone } from "@pinecone-database/pinecone";
import { append as auditAppend } from "@/lib/audit-chain";

const API_KEY = process.env.PINECONE_API_KEY ?? "";
/**
 * The index NAME. This one genuinely must be configured: `pc.index(name)`
 * takes it as an argument, so there is no default to fall back on. The HOST,
 * by contrast, is resolved by the SDK from the API key — see `client()`.
 */
const INDEX = process.env.PINECONE_INDEX ?? "";
/**
 * Optional. The SDK derives the region host from the API key, so setting this is
 * only necessary when talking to an index in a project the key cannot address
 * by default (an explicit non-default host). Left empty rather than required,
 * because requiring it meant a correct deployment silently reported
 * `pinecone_not_configured` and indexed nothing.
 */
const HOST = process.env.PINECONE_HOST ?? "";
/** Empty namespace is deliberate: erased cases delete by metadata filter. */
const NAMESPACE = process.env.PINECONE_NAMESPACE ?? "";

const EMBEDDING_MODEL = "llama-text-embed-v2";
const MAX_CHARS = 12_000;

/**
 * Configuration is API key + index name. Host is NOT part of this test — see
 * HOST above.
 */
export function pineconeConfigured(): boolean {
  return API_KEY.length > 8 && INDEX.length > 0;
}

function client(): Pinecone {
  return new Pinecone({ apiKey: API_KEY });
}

/**
 * The index handle. `pc.index(name, host)` takes the host as an OPTIONAL second
 * argument, so passing it only when configured lets the SDK resolve it itself.
 */
function index(pc: Pinecone) {
  return HOST ? pc.index(INDEX, HOST) : pc.index(INDEX);
}

export async function indexTranscript(
  caseRef: string,
  transcript: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!pineconeConfigured()) return { ok: false, error: "pinecone_not_configured" };
  const trimmed = transcript.slice(0, MAX_CHARS);
  if (!trimmed.trim()) return { ok: false, error: "empty_transcript" };

  const pc = client();
  try {
    const embeddings = await pc.inference.embed({
      model: EMBEDDING_MODEL,
      inputs: [trimmed],
      parameters: { inputType: "passage", truncate: "END" },
    });
    // Pinecone models can be dense OR sparse; an index has one vector type, so
    // upserting a sparse vector into a dense index is rejected at the API. Take
    // the dense values when present and refuse clearly rather than sending a
    // shape that would 400 on every call.
    const first = embeddings.data?.[0] as { values?: number[]; vectorType?: string } | undefined;
    const values = first?.values;
    if (!values || !Array.isArray(values) || values.length === 0) {
      return {
        ok: false,
        error: `no_dense_embedding (vectorType=${first?.vectorType ?? "unknown"})`,
      };
    }

    const handle = index(pc);
    const namespace = NAMESPACE ? handle.namespace(NAMESPACE) : handle;
    await namespace.upsert({
      records: [
        {
          id: `case:${caseRef}`,
          values,
          metadata: {
            caseRef,
            indexedAt: new Date().toISOString(),
            source: "securevoice-postcall",
          },
        },
      ],
    });
    // Record the indexing on the case's audit chain: silence here would look
    // like we silently leaked instead of silently scoped. auditAppend (not a
    // raw insert) because the chain is hash-linked — a row written outside it
    // breaks the tamper-evidence the whole audit story rests on.
    await auditAppend(
      {
        callRef: caseRef,
        action: "agent",
        intent: "transcript_indexed_pinecone",
        callerId: "system-pinecone",
        redactedText: "transcript offered to Pinecone for semantic search",
        meta: { model: EMBEDDING_MODEL, chars: trimmed.length },
      },
      { fast: true },
    ).catch(() => {});
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await auditAppend(
      {
        callRef: caseRef,
        action: "agent",
        intent: "transcript_index_failed",
        callerId: "system-pinecone",
        redactedText: "Pinecone indexing failed; case remains sealed-only",
        meta: { error: msg.slice(0, 200) },
      },
      { fast: true },
    ).catch(() => {});
    return { ok: false, error: msg.slice(0, 200) };
  }
}

/**
 * Erasure hook: when a case is erased (right to be forgotten), remove its
 * vector record. Failure is logged and retryable — the operator console can
 * surface the residual.
 */
export async function forgetTranscript(caseRef: string): Promise<{ ok: boolean; error?: string }> {
  if (!pineconeConfigured()) return { ok: true };
  const pc = client();
  try {
    const handle = index(pc);
    const namespace = NAMESPACE ? handle.namespace(NAMESPACE) : handle;
    await namespace.deleteOne({ id: `case:${caseRef}` });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
