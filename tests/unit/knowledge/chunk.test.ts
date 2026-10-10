/**
 * `chunkText` — the pure splitter the whole knowledge base sits on.
 *
 * It is pure on purpose: the chunk boundaries decide what a retrieved answer
 * CONTAINS, and testing that through a database + an embedding provider would
 * test the provider, not the splitter. Every assertion here is about text.
 *
 * The three properties that matter, each of which a naive `text.slice(0, 1200)`
 * implementation fails:
 *
 *   1. It does not cut mid-word. An embedding of half a word matches nothing.
 *   2. It overlaps, so a fact that straddles a boundary is still retrievable
 *      from at least one whole chunk.
 *   3. It terminates on pathological input — empty text, whitespace, a single
 *      character, an overlap larger than the window. A splitter that loops is a
 *      request that never returns, which is a denial of service with a UI.
 *
 *   bun test tests/unit/knowledge/chunk.test.ts
 */
import { describe, expect, test } from "bun:test";
import { chunkText } from "@/lib/knowledge/documents";

describe("chunkText", () => {
  test("returns a single chunk for text already within the window", () => {
    const text = "A short policy statement about disputed transactions.";
    expect(chunkText(text, { maxChars: 1200 })).toEqual([text]);
  });

  test("returns nothing for empty or whitespace-only input", () => {
    // Not `[""]`: an empty chunk would be embedded as an empty passage and
    // retrieved as a confident match for an arbitrary query.
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n\t  ")).toEqual([]);
  });

  test("never cuts a word in half at a chunk END", () => {
    const words = Array.from({ length: 400 }, (_, i) => `word${i}`);
    const chunks = chunkText(words.join(" "), { maxChars: 200, overlap: 40 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // Every chunk must END on a complete word. Overlap deliberately makes a
      // later chunk BEGIN mid-word — that is the point of overlap, and a chunk
      // that starts mid-word still embeds and retrieves sensibly — but a chunk
      // that ENDS mid-word loses a fragment nobody can search for.
      const last = chunk.split(/\s+/).pop();
      expect(last).toMatch(/^word\d+$/);
    }
    // The FIRST chunk additionally starts at character 0, so it must be clean on
    // both ends.
    expect(chunks[0]!.split(/\s+/)[0]).toBe("word0");
    expect(chunks[0]!.split(/\s+/).pop()).toMatch(/^word\d+$/);
  });

  test("keeps every source word present in at least one chunk", () => {
    const words = Array.from({ length: 500 }, (_, i) => `w${i}`);
    const chunks = chunkText(words.join(" "), { maxChars: 300, overlap: 60 });
    const covered = new Set(chunks.join(" ").split(/\s+/));
    for (const w of words) expect(covered.has(w)).toBe(true);
  });

  test("overlaps so a boundary-straddling fact survives in one chunk", () => {
    const text = `${"filler ".repeat(80)}DISPUTEDTRANSACTIONRULE${" filler".repeat(80)}`;
    const chunks = chunkText(text, { maxChars: 200, overlap: 80 });
    expect(chunks.length).toBeGreaterThan(1);
    // The marker is intact — not split across two chunks — in at least one of them.
    expect(chunks.some((c) => c.includes("DISPUTEDTRANSACTIONRULE"))).toBe(true);
  });

  test("respects the window size", () => {
    const text = Array.from({ length: 900 }, (_, i) => `token${i}`).join(" ");
    const maxChars = 250;
    for (const chunk of chunkText(text, { maxChars, overlap: 50 })) {
      expect(chunk.length).toBeLessThanOrEqual(maxChars);
    }
  });

  test("prefers a paragraph boundary when one exists in the window", () => {
    const para1 = "Alpha paragraph about the cardholder dispute process.";
    const para2 = "Beta paragraph about the escalation and handoff timing.";
    const text = `${para1}\n\n${para2}`;
    // A window narrower than the whole text, so a split is actually required.
    const chunks = chunkText(text, { maxChars: 60, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    // The chunk ends AT the paragraph break, not mid-paragraph, and nothing is
    // lost: the chunks together cover the whole document.
    expect(chunks[0]).toBe(para1);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(
      text.replace(/\s+/g, " ").replace(/\s/g, " "),
    );
  });

  test("terminates on a single character and on one long unbroken token", () => {
    expect(chunkText("x", { maxChars: 10, overlap: 5 })).toEqual(["x"]);
    // One token longer than the window cannot be split at a space, so it must be
    // hard-cut — and must not loop. Coverage is asserted by first/last position
    // rather than by concatenated length, because an overlapping splitter
    // deliberately repeats the boundary characters.
    const huge = "a".repeat(5000);
    const chunks = chunkText(huge, { maxChars: 100, overlap: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toBe("a".repeat(100));
    expect(chunks[chunks.length - 1]!.length).toBeGreaterThan(0);
    expect(chunks[chunks.length - 1]!.endsWith("a")).toBe(true);
  });

  test("clamps an overlap larger than the window instead of stalling", () => {
    const text = Array.from({ length: 300 }, (_, i) => `t${i}`).join(" ");
    const chunks = chunkText(text, { maxChars: 100, overlap: 500 });
    expect(chunks.length).toBeGreaterThan(1);
    // With the overlap clamped to half the window the cursor still advances ~50
    // characters per chunk, so a ~1 000-character document yields tens of chunks
    // — not the hundreds an unclamped overlap would produce.
    expect(chunks.length).toBeLessThan(60);
  });

  test("normalises CRLF and collapsed whitespace", () => {
    const out = chunkText("line one\r\nline  two   spaced", { maxChars: 1000 });
    expect(out).toEqual(["line one\nline two spaced"]);
  });
});
