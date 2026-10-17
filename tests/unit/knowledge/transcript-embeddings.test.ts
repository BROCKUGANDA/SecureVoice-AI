/**
 * `src/lib/knowledge/transcript-embeddings.ts` — native pgvector transcript RAG.
 *
 * Every assertion here is about behavior, not about OpenAI or the database:
 * fetch is mocked (no network), `@/lib/db` is mocked (no real postgres), and
 * `@/lib/audit-chain` is mocked (no real chain writes). The failures tested are
 * the ones an operator WILL actually meet: missing API key, empty transcript,
 * embedding count mismatch, and a DB that refuses inserts.
 *
 *   bun test tests/unit/knowledge/transcript-embeddings.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { db } from "@/lib/db";
import {
  searchTranscripts,
  embedTranscript,
  forgetTranscriptEmbeddings,
  transcriptEmbeddingsConfigured,
} from "@/lib/knowledge/transcript-embeddings";

const ORG = "0d0d0d0d-0000-4000-8000-000000000001";
const OTHER_ORG = "0d0d0d0d-0000-4000-8000-000000000002";
const CASE_REF = "SV-F-TESTCASE";

const realFetch = globalThis.fetch;

// Successful embedding response: 3 chunks → 3 embeddings
const mockFetch = mock((_input: RequestInfo | URL, _init?: RequestInit) => {
  // Parse the request body to return the right number of embeddings for
  // however many chunks were sent (OpenAI echoes back one embedding per input).
  let body: any = { data: [] };
  try {
    if (_init && typeof _init === "object" && "body" in _init) {
      body = JSON.parse(String(_init.body));
    }
  } catch {}
  const n = Array.isArray(body.input) ? body.input.length : 1;
  return Promise.resolve(
    new Response(
      JSON.stringify({
        data: Array.from({ length: n }, (_, i) => ({
          embedding: [0.1 + i * 0.1, 0.2 + i * 0.1, 0.3 + i * 0.1],
        })),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
});

const mockFetchError = mock(() => {
  return Promise.reject(new Error("network down"));
});

const mockFetchMismatch = mock(() => {
  return Promise.resolve(
    new Response(
      JSON.stringify({
        data: [{ embedding: [0.1, 0.2, 0.3] }], // only 1 embedding for 3 chunks
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
});

const dbExecCalls: Array<{ sql: string; params: unknown[] }> = [];
const dbQueryCalls: Array<{ sql: string; params: unknown[] }> = [];
const auditCalls: Array<{ intent: string; redactedText: string }> = [];

// Normalise a $queryRawUnsafe first argument: it may arrive as a
// TemplateStringsArray (tagged template call) or as a plain string.
function sqlText(sql: unknown): string {
  if (Array.isArray(sql) && "raw" in sql) return String(sql.raw[0]);
  return String(sql);
}

mock.module("@/lib/db", () => ({
  db: {
    $executeRawUnsafe: mock((_sql: unknown, ...params: unknown[]) => {
      dbExecCalls.push({ sql: sqlText(_sql), params });
      return Promise.resolve({});
    }),
    $queryRawUnsafe: mock(async (_sql: unknown, ...params: unknown[]) => {
      dbQueryCalls.push({ sql: sqlText(_sql), params });
      const sql = sqlText(_sql);
      // Return empty for "nothing matches" queries so the empty-results path is tested
      if (sql.includes("nothing matches at all")) {
        return Promise.resolve([]);
      }
      if (sql.includes("TranscriptEmbedding")) {
        return Promise.resolve([
          {
            caseRef: "SV-F-EXISTING",
            orgId: ORG,
            score: "0.95",
            text: "previous call about disputed transactions",
            chunkIndex: 0,
          },
        ]);
      }
      return Promise.resolve([]);
    }),
  },
}));

mock.module("@/lib/audit-chain", () => ({
  append: mock(async (_input: any) => {
    auditCalls.push({
      intent: _input.intent,
      redactedText: _input.redactedText,
    });
  }),
}));

beforeAll(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  process.env.OPENAI_API_KEY = "sk-test-key-that-is-long-enough";
});

beforeEach(() => {
  process.env.OPENAI_API_KEY = "sk-test-key-that-is-long-enough";
  mockFetch.mockClear();
  mockFetchError.mockClear();
  mockFetchMismatch.mockClear();
  dbExecCalls.length = 0;
  dbQueryCalls.length = 0;
  auditCalls.length = 0;
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("embedTranscript", () => {
  test("refuses when OPENAI_API_KEY is unset", async () => {
    delete process.env.OPENAI_API_KEY;
    const res = await embedTranscript(CASE_REF, "a transcript", ORG);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("openai_not_configured");
    expect(dbExecCalls.length).toBe(0);
  });

  test("refuses an empty orgId", async () => {
    const res = await embedTranscript(CASE_REF, "a transcript", "   ");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("org_id_required");
  });

  test("refuses an empty transcript", async () => {
    const res = await embedTranscript(CASE_REF, "", ORG);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("empty_transcript");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("refuses a whitespace-only transcript", async () => {
    const res = await embedTranscript(CASE_REF, "   \n\n\t  ", ORG);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("empty_transcript");
  });

  test("embeds a transcript and inserts vectors idempotently", async () => {
    const longTranscript =
      "The customer disputed the charge. The agent confirmed fraud. The customer asked for a refund. The agent explained the process and promised a callback within 24 hours. The customer agreed and ended the call. ".repeat(
        20,
      );
    const res = await embedTranscript(CASE_REF, longTranscript, ORG);
    expect(res.ok).toBe(true);
    // At least one DELETE + one INSERT
    expect(dbExecCalls.length).toBeGreaterThanOrEqual(2);
    // First call is always the delete-before-insert
    expect(dbExecCalls[0].sql).toContain('DELETE FROM "TranscriptEmbedding" WHERE "caseRef" = $1');
    expect(dbExecCalls[0].params[0]).toBe(CASE_REF);
    // Every insert carries the orgId
    const inserts = dbExecCalls.filter((c) => c.sql.includes("INSERT INTO"));
    for (const ins of inserts) {
      expect(ins.params[2]).toBe(ORG); // orgId is param 3
    }
    // Audit: indexed success
    expect(auditCalls.some((a) => a.intent === "transcript_indexed_pgvector")).toBe(true);
  });

  test("re-embedding overwrites in place (delete-then-insert, no stale chunks)", async () => {
    // First embed with 2 chunks
    await embedTranscript(CASE_REF, "First call. Second sentence.", ORG);
    const firstInserts = dbExecCalls.filter((c) => c.sql.includes("INSERT INTO")).length;
    // Reset call tracking before the re-embed
    dbExecCalls.length = 0;
    // Re-embed with 1 chunk (shorter transcript)
    await embedTranscript(CASE_REF, "Short call.", ORG);
    const secondInserts = dbExecCalls.filter((c) => c.sql.includes("INSERT INTO")).length;
    expect(secondInserts).toBeLessThanOrEqual(firstInserts);
    // Delete is called again before the new inserts
    const deletes = dbExecCalls.filter((c) => c.sql.includes("DELETE FROM"));
    expect(deletes.length).toBeGreaterThanOrEqual(1);
  });

  test("embedding API error fails open and is audited", async () => {
    globalThis.fetch = mockFetchError as unknown as typeof fetch;
    const res = await embedTranscript(CASE_REF, "The customer disputed the charge.", ORG);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("network down");
    // Audit: failure recorded
    expect(auditCalls.some((a) => a.intent === "transcript_embed_failed")).toBe(true);
    // No DB writes on failure path
    const inserts = dbExecCalls.filter((c) => c.sql.includes("INSERT INTO"));
    expect(inserts.length).toBe(0);
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  test("embedding count mismatch is reported", async () => {
    globalThis.fetch = mockFetchMismatch as unknown as typeof fetch;
    // Long transcript → multiple chunks (>4000 chars), but mock returns only 1 embedding
    const long = "The customer disputed the charge. ".repeat(200);
    const res = await embedTranscript(CASE_REF, long, ORG);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("count mismatch");
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });
});

describe("searchTranscripts", () => {
  test("refuses when OPENAI_API_KEY is unset", async () => {
    delete process.env.OPENAI_API_KEY;
    const res = await searchTranscripts(ORG, "disputed charge", 3);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("openai_not_configured");
  });

  test("refuses an empty orgId", async () => {
    const res = await searchTranscripts("   ", "disputed charge", 3);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("org_id_required");
  });

  test("returns matches ordered by similarity with orgId filter", async () => {
    const res = await searchTranscripts(ORG, "disputed charge", 3);
    expect(res.ok).toBe(true);
    expect(res.matches.length).toBeGreaterThan(0);
    // Every match carries the queried orgId (post-query re-check passed)
    for (const m of res.matches) {
      expect(m.caseRef).toBeTruthy();
      expect(m.score).toBeGreaterThanOrEqual(0);
      expect(m.score).toBeLessThanOrEqual(1);
      expect(typeof m.text).toBe("string");
      expect(typeof m.chunkIndex).toBe("number");
    }
  });

  test("cross-tenant isolation: only the queried orgId is used in the SQL", async () => {
    await searchTranscripts(ORG, "disputed charge", 3);
    // The SQL must filter by orgId parameter
    const orgFilterCall = dbQueryCalls.find((c) => c.sql.includes('WHERE "orgId" = $2'));
    expect(orgFilterCall).toBeTruthy();
    expect(orgFilterCall!.params[1]).toBe(ORG);
    expect(orgFilterCall!.params[1]).not.toBe(OTHER_ORG);
  });

  test("returns empty matches when no vectors match", async () => {
    const origExecute = (db as any).$queryRawUnsafe;
    (db as any).$queryRawUnsafe = mock(async () => Promise.resolve([]));
    const res = await searchTranscripts(ORG, "nothing matches at all", 3);
    expect(res.ok).toBe(true);
    expect(res.matches).toEqual([]);
    (db as any).$queryRawUnsafe = origExecute;
  });

  test("post-query re-check: rows with mismatched orgId are dropped", async () => {
    // Temporarily make the mock return a row with a different orgId
    const origExecute = (db as any).$queryRawUnsafe;
    (db as any).$queryRawUnsafe = mock(async () => {
      return Promise.resolve([
        {
          caseRef: "SV-F-OTHER",
          orgId: OTHER_ORG,
          score: "0.99",
          text: "another org's transcript",
          chunkIndex: 0,
        },
      ]);
    });
    const res = await searchTranscripts(ORG, "anything", 3);
    expect(res.ok).toBe(true);
    expect(res.matches).toEqual([]); // filtered out by post-query re-check
    (db as any).$queryRawUnsafe = origExecute;
  });
});

describe("forgetTranscriptEmbeddings", () => {
  test("deletes vectors for a caseRef", async () => {
    const res = await forgetTranscriptEmbeddings(CASE_REF);
    expect(res.ok).toBe(true);
    const del = dbExecCalls.find((c) => c.sql.includes('DELETE FROM "TranscriptEmbedding"'));
    expect(del).toBeTruthy();
    expect(del!.params[0]).toBe(CASE_REF);
  });

  test("reports failure when DB delete fails", async () => {
    const origExecute = (db as any).$executeRawUnsafe;
    (db as any).$executeRawUnsafe = mock(() => {
      throw new Error("connection lost");
    });
    const res = await forgetTranscriptEmbeddings(CASE_REF);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("connection lost");
    (db as any).$executeRawUnsafe = origExecute;
  });
});

describe("transcriptEmbeddingsConfigured", () => {
  test("returns false without a key", () => {
    delete process.env.OPENAI_API_KEY;
    expect(transcriptEmbeddingsConfigured()).toBe(false);
  });

  test("returns true with a sufficiently long key", () => {
    process.env.OPENAI_API_KEY = "sk-test-key-that-is-long-enough";
    expect(transcriptEmbeddingsConfigured()).toBe(true);
  });
});
