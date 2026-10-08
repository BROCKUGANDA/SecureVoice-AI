/**
 * UNIT — Pinecone configuration is key + index name, NOT a host.
 *
 * The host was previously a required part of `pineconeConfigured()`. That was
 * wrong twice over:
 *
 *   1. The Pinecone SDK resolves the region host from the API key, and
 *      `pc.index(name, host?)` takes the host as an OPTIONAL second argument.
 *      Requiring it meant a correctly-configured deployment reported
 *      `pinecone_not_configured` and indexed nothing at all — a silent no-op
 *      that reads as "we tried and it was fine".
 *   2. It made the on-prem claim ("absence of PINECONE_API_KEY is how an
 *      on-prem deployment proves nothing left the building") depend on three
 *      variables instead of one, so a partial config looked identical to no
 *      config in the logs.
 *
 * The INDEX name genuinely must be configured: `pc.index('quickstart')` takes
 * the name as an argument, so there is nothing to default it to. This file
 * pins that distinction rather than letting it drift.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(import.meta.dir, "..", "..", "src", "lib", "pinecone", "transcript-index.ts"),
  "utf8",
);

describe("pinecone configuration", () => {
  test("pineconeConfigured does not require a host", () => {
    // Read the function body rather than evaluating it: the module is
    // `server-only` and reads env at import time, so it cannot be imported here.
    const body = /export function pineconeConfigured\(\): boolean \{([^}]*)\}/.exec(SRC);
    expect(body).not.toBeNull();
    expect(body![1]).not.toContain("HOST");
    expect(body![1]).toContain("API_KEY");
    expect(body![1]).toContain("INDEX");
  });

  test("the index name is still required, because the SDK takes it as an argument", () => {
    expect(SRC).toMatch(/const INDEX = process\.env\.PINECONE_INDEX \?\? ""/);
    // A default would silently write to an index nobody chose.
    expect(SRC).not.toMatch(/const INDEX = .*\?\? *"(?!")/);
  });

  test("the host is passed only when configured", () => {
    // pc.index(name, host?) — passing "" as the host would override the SDK's
    // own resolution and break the request, which is the bug in reverse.
    expect(SRC).toContain("HOST ? pc.index(INDEX, HOST) : pc.index(INDEX)");
  });

  test("no call site outside the helper passes a possibly-empty host", () => {
    // Strip comments so the doc references to `pc.index(name, host?)` and
    // `pc.index('quickstart')` are not counted as call sites.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const direct = code.match(/pc\.index\(([^)]*)\)/g) ?? [];
    // Only the helper's own two branches are allowed to call pc.index.
    expect({ direct: direct.sort() }).toEqual({
      direct: ["pc.index(INDEX)", "pc.index(INDEX, HOST)"],
    });
  });
});

/**
 * TENANT ISOLATION — the property that must not regress.
 *
 * `orgId` is stamped on every vector written, and every read filters on it.
 * This suite pins that structurally rather than behaviourally: the module is
 * `server-only` and reads env at import time, so it cannot be imported here
 * without a live Pinecone. Reading the source is what stops someone from later
 * adding an unfiltered `query()` or making `orgId` optional.
 *
 * A cross-tenant transcript leak on a fraud platform is a reportable incident,
 * not a bug ticket.
 */
describe("pinecone tenant isolation", () => {
  test("indexTranscript requires orgId — it is not optional and has no default", () => {
    // A default here (orgId = "" or orgId?: string) would let vectors be
    // written with no tenant, which no filter can then exclude.
    expect(SRC).toMatch(/indexTranscript\(\s*\n\s*caseRef: string,\s*\n\s*transcript: string,[\s\S]*?orgId: string,/);
    expect(SRC).toContain("org_id_required");
  });

  test("every upserted vector carries orgId in its metadata", () => {
    expect(SRC).toMatch(/metadata:\s*\{[\s\S]*?orgId,[\s\S]*?source:/);
  });

  test("searchTranscripts filters by orgId and requires it", () => {
    expect(SRC).toContain("searchTranscripts");
    expect(SRC).toMatch(/searchTranscripts\(\s*\n\s*orgId: string,/);
    // The filter itself: a query without it would return every tenant's rows.
    expect(SRC).toMatch(/filter:\s*\{\s*orgId\s*\}/);
  });

  test("results are re-checked against the tenant after the query", () => {
    // Defence in depth: if a filter were silently dropped server-side, the
    // metadata check below is what stops another org's transcript being returned.
    expect(SRC).toContain("m.metadata?.orgId === orgId");
  });

  test("no unfiltered query exists anywhere in the module", () => {
    const queries = SRC.match(/\.query\(\s*\{[\s\S]*?\}/g) ?? [];
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(q).toContain("filter:");
      expect(q).toContain("orgId");
    }
  });
});
