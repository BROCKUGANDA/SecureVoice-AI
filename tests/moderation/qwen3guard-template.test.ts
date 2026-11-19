/**
 * Qwen3Guard template + verdict parser — the classification contract.
 *
 * The parser is a SECURITY property: unreadable output must never become
 * "Safe". These tests pin the whole grammar, including the contradictions and
 * the malformed shapes a gateway can return under load.
 */
import { describe, test, expect } from "bun:test";
import {
  parseVerdict,
  buildModerationMessages,
  MAX_MODERATION_CHARS,
  MODERATION_STAGES,
  QWEN3GUARD_CATEGORIES,
  TEMPLATE_VERSION,
} from "@/lib/qwen3guard/template";

describe("qwen3guard verdict parser", () => {
  test("reads the live-captured Safe shape", () => {
    const v = parseVerdict("Safety: Safe\nCategories: None");
    expect(v.verdict).toBe("safe");
    expect(v.categories).toEqual(["None"]);
    expect(v.refusal).toBe(false);
  });

  test("reads the live-captured Unsafe shape with categories", () => {
    const v = parseVerdict("Safety: Unsafe\nCategories: Violent");
    expect(v.verdict).toBe("unsafe");
    expect(v.categories).toEqual(["Violent"]);
  });

  test("reads multi-category output", () => {
    const v = parseVerdict("Safety: Unsafe\nCategories: PII, Jailbreak");
    expect(v.verdict).toBe("unsafe");
    expect(v.categories).toEqual(["PII", "Jailbreak"]);
  });

  test("reads the response-moderation shape including Refusal", () => {
    const v = parseVerdict("Safety: Safe\nCategories: None\nRefusal: Yes");
    expect(v.verdict).toBe("safe");
    expect(v.refusal).toBe(true);
    const v2 = parseVerdict("Safety: Safe\nCategories: None\nRefusal: No");
    expect(v2.refusal).toBe(false);
  });

  test("reads Controversial — the model's third label", () => {
    const v = parseVerdict("Safety: Controversial\nCategories: Unethical Acts");
    expect(v.verdict).toBe("controversial");
    expect(v.categories).toEqual(["Unethical Acts"]);
  });

  // ── Invalid is never Safe ────────────────────────────────────────────────

  test("empty output is invalid", () => {
    expect(parseVerdict("").verdict).toBe("invalid");
  });

  test("chatty output without the Safety line is invalid", () => {
    expect(parseVerdict("I think this content is fine.").verdict).toBe("invalid");
  });

  test("truncated output (no Categories line) is invalid", () => {
    expect(parseVerdict("Safety: Unsafe").verdict).toBe("invalid");
  });

  test("an unknown category makes the WHOLE verdict invalid", () => {
    // Dropping the unknown category would launders an unknown risk into a
    // known one; the verdict is invalid instead.
    const v = parseVerdict("Safety: Unsafe\nCategories: Something New");
    expect(v.verdict).toBe("invalid");
    expect(v.categories).toEqual([]);
  });

  test("Safe with a non-None category is contradictory → invalid", () => {
    expect(parseVerdict("Safety: Safe\nCategories: Violent").verdict).toBe("invalid");
  });

  test("Unsafe with Categories: None is contradictory → invalid", () => {
    expect(parseVerdict("Safety: Unsafe\nCategories: None").verdict).toBe("invalid");
  });

  test("multilingual harmful content parses (the classifier, not the parser, is language-aware)", () => {
    const v = parseVerdict("Safety: Unsafe\nCategories: Non-violent Illegal Acts");
    expect(v.verdict).toBe("unsafe");
  });

  test("every official category round-trips through the parser", () => {
    for (const cat of QWEN3GUARD_CATEGORIES) {
      if (cat === "None") continue; // "None" is only valid beside a Safe verdict.
      const v = parseVerdict(`Safety: Unsafe\nCategories: ${cat}`);
      expect(v.categories).toContain(cat);
    }
    const safe = parseVerdict("Safety: Safe\nCategories: None");
    expect(safe.verdict).toBe("safe");
  });
});

describe("qwen3guard message construction", () => {
  test("input/tool/speech/ingest stages are single-user prompt moderation", () => {
    for (const stage of ["input", "speech", "tool", "ingest"] as const) {
      const msgs = buildModerationMessages(stage, "hello there");
      expect(msgs).toEqual([{ role: "user", content: "hello there" }]);
    }
  });

  test("output stage is user+assistant response moderation", () => {
    const msgs = buildModerationMessages("output", "the draft", { userText: "the prompt" });
    expect(msgs).toEqual([
      { role: "user", content: "the prompt" },
      { role: "assistant", content: "the draft" },
    ]);
  });

  test("output stage without user text is assistant-only", () => {
    const msgs = buildModerationMessages("output", "the draft");
    expect(msgs).toEqual([{ role: "assistant", content: "the draft" }]);
  });

  test("oversized content is truncated, never rejected silently", () => {
    const big = "x".repeat(MAX_MODERATION_CHARS + 500);
    const msgs = buildModerationMessages("input", big);
    expect(msgs[0]!.content.length).toBe(MAX_MODERATION_CHARS);
  });

  test("stages and template version are stable", () => {
    expect(MODERATION_STAGES).toEqual(["input", "output", "speech", "tool", "ingest"]);
    expect(TEMPLATE_VERSION).toMatch(/^qwen3guard-gen-\d+$/);
  });
});
