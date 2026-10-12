import { describe, expect, test } from "bun:test";
import {
  anthropicCompletionSchema,
  extractAnthropicCompletion,
  extractOpenAiCompletion,
  openAiCompletionSchema,
  spokenCompletionSchema,
  validateAndExtract,
} from "@/lib/validation/llm-response";

describe("openAiCompletionSchema", () => {
  test("accepts a well-formed response", () => {
    const raw = {
      choices: [{ message: { content: "Hello" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const result = openAiCompletionSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  test("rejects an empty choices array", () => {
    const result = openAiCompletionSchema.safeParse({ choices: [] });
    expect(result.success).toBe(false);
  });

  test("rejects a missing message object", () => {
    const result = openAiCompletionSchema.safeParse({ choices: [{}] });
    expect(result.success).toBe(false);
  });

  test("accepts null content (a refusal)", () => {
    const result = openAiCompletionSchema.safeParse({
      choices: [{ message: { content: null } }],
    });
    expect(result.success).toBe(true);
  });

  test("accepts an array of content parts", () => {
    const result = openAiCompletionSchema.safeParse({
      choices: [{ message: { content: [{ text: "Hello" }, { text: " world" }] } }],
    });
    expect(result.success).toBe(true);
  });
});

describe("anthropicCompletionSchema", () => {
  test("accepts a well-formed response", () => {
    const raw = {
      content: [{ type: "text", text: "Hello" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const result = anthropicCompletionSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  test("rejects an empty content array", () => {
    const result = anthropicCompletionSchema.safeParse({ content: [] });
    expect(result.success).toBe(false);
  });

  test("accepts a tool_use block without text", () => {
    const result = anthropicCompletionSchema.safeParse({
      content: [{ type: "tool_use", id: "toolu_1", name: "card_freeze" }],
    });
    expect(result.success).toBe(true);
  });
});

describe("extractOpenAiCompletion", () => {
  test("extracts a string content", () => {
    const response = openAiCompletionSchema.parse({
      choices: [{ message: { content: "  Hello world  " } }],
    });
    expect(extractOpenAiCompletion(response)).toBe("Hello world");
  });

  test("extracts and joins an array of content parts", () => {
    const response = openAiCompletionSchema.parse({
      choices: [{ message: { content: [{ text: "Hello" }, { text: " world" }] } }],
    });
    expect(extractOpenAiCompletion(response)).toBe("Hello world");
  });

  test("returns null for null content", () => {
    const response = openAiCompletionSchema.parse({
      choices: [{ message: { content: null } }],
    });
    expect(extractOpenAiCompletion(response)).toBeNull();
  });

  test("returns null for whitespace-only content", () => {
    const response = openAiCompletionSchema.parse({
      choices: [{ message: { content: "   " } }],
    });
    expect(extractOpenAiCompletion(response)).toBeNull();
  });
});

describe("extractAnthropicCompletion", () => {
  test("extracts text from a text block", () => {
    const response = anthropicCompletionSchema.parse({
      content: [{ type: "text", text: "  Hello  " }],
    });
    expect(extractAnthropicCompletion(response)).toBe("Hello");
  });

  test("concatenates multiple text blocks", () => {
    const response = anthropicCompletionSchema.parse({
      content: [
        { type: "text", text: "Hello" },
        { type: "text", text: " world" },
      ],
    });
    expect(extractAnthropicCompletion(response)).toBe("Hello world");
  });

  test("returns null when there are no text blocks", () => {
    const response = anthropicCompletionSchema.parse({
      content: [{ type: "tool_use", id: "toolu_1", name: "card_freeze" }],
    });
    expect(extractAnthropicCompletion(response)).toBeNull();
  });
});

describe("spokenCompletionSchema", () => {
  test("accepts a non-empty string", () => {
    expect(spokenCompletionSchema.safeParse("Hello").success).toBe(true);
  });

  test("rejects an empty string", () => {
    expect(spokenCompletionSchema.safeParse("").success).toBe(false);
  });

  test("rejects a whitespace-only string", () => {
    expect(spokenCompletionSchema.safeParse("   ").success).toBe(false);
  });

  test("trims before validating", () => {
    expect(spokenCompletionSchema.safeParse("  Hello  ").success).toBe(true);
  });
});

describe("validateAndExtract", () => {
  test("returns the completion for a valid response", () => {
    const raw = { choices: [{ message: { content: "Hello" } }] };
    const result = validateAndExtract(openAiCompletionSchema, raw, extractOpenAiCompletion);
    expect(result).toBe("Hello");
  });

  test("returns null for a malformed response", () => {
    const result = validateAndExtract(openAiCompletionSchema, {}, extractOpenAiCompletion);
    expect(result).toBeNull();
  });

  test("returns null when extraction fails", () => {
    const raw = { choices: [{ message: { content: null } }] };
    const result = validateAndExtract(openAiCompletionSchema, raw, extractOpenAiCompletion);
    expect(result).toBeNull();
  });

  test("returns null when the completion is not speakable", () => {
    const raw = { choices: [{ message: { content: "   " } }] };
    const result = validateAndExtract(openAiCompletionSchema, raw, extractOpenAiCompletion);
    expect(result).toBeNull();
  });
});
