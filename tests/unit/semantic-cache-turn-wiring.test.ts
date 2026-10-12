/**
 * THE CACHE ON THE LIVE TURN — proof that the semantic cache is what answers the
 * second caller, and that what it answers with was never allowed to skip a guard.
 *
 * `src/lib/voice/semantic-cache.ts` shipped with 62 unit tests for the class and
 * no caller: the safety rules were verified in isolation and unreachable in
 * production. These tests drive the real `draftAgentReply` with the LLM adapter
 * replaced by a counter, so the property under test is the one that costs money
 * and time — a repeated turn must not make a provider call — without weakening
 * any of the refusals.
 *
 * The asymmetry that matters: a cache miss is a slower reply, and a cache HIT on
 * the wrong entry is a bank telling a fraud victim something untrue, permanently,
 * to everyone. So every "it served" assertion below has a matching "it refused to
 * serve" neighbour.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { defaultSemanticCache, resetDefaultSemanticCache } from "@/lib/voice/semantic-cache";

let completions: { prompt: string; system?: string }[] = [];
let nextReply = "Hello, I am your bank's automated security assistant.";

mock.module("@/lib/adapters/llm-adapter", () => ({
  createLlmAdapter: () => ({
    adapterId: "llm.groq",
    provider: "groq",
    mode: "real",
    defaultModel: "test-model",
    complete: async (prompt: string, opts?: { systemPrompt?: string }) => {
      completions.push({ prompt, system: opts?.systemPrompt });
      return { text: nextReply };
    },
  }),
  LlmAdapterError: class LlmAdapterError extends Error {},
  LLM_PROVIDERS: ["groq"],
  LLM_ADAPTERS: {},
  isLlmProvider: () => true,
  registerLlmAdapter: () => {},
}));

const PROVIDER = {
  name: "groq" as const,
  url: "https://api.groq.test/chat/completions",
  key: "gts-test-key",
  model: "test-model",
  timeoutMs: 2000,
  temperature: 0.2,
  maxTokens: 128,
};

async function draft(args: {
  text: string;
  intent?: string;
  lang?: "en" | "ar" | "hi" | "ur" | "fr" | "sw";
  callCategory?: string | null;
}) {
  const { draftAgentReply } = await import("@/lib/llm");
  return draftAgentReply({
    text: args.text,
    lang: args.lang ?? "en",
    intent: args.intent ?? "greeting",
    scriptedReply: "the scripted line",
    callRef: "SV-CACHE-TEST",
    callerId: "test",
    callCategory: args.callCategory ?? "time_critical_fraud",
    providerOverride: PROVIDER,
  });
}

beforeEach(() => {
  completions = [];
  nextReply = "Hello, I am your bank's automated security assistant.";
  resetDefaultSemanticCache();
});

describe("a repeated turn does not cost a provider call", () => {
  test("the second near-identical question is answered from the cache", async () => {
    const first = await draft({ text: "who is this" });
    expect(first).toBe(nextReply);
    expect(completions).toHaveLength(1);

    // Same question, different wording and punctuation: the fold plus the
    // embedding similarity is what makes this a hit rather than a miss.
    const second = await draft({ text: "Who is this?" });
    expect(second).toBe(first);
    expect(completions, "a cached turn still called the provider").toHaveLength(1);
  });

  test("a genuinely different question is a miss and does reach the provider", async () => {
    await draft({ text: "who is this" });
    const other = await draft({ text: "please freeze my card right now" });
    expect(other).toBe(nextReply);
    expect(completions).toHaveLength(2);
  });

  test("the namespace is part of the answer: another language never borrows a reply", async () => {
    await draft({ text: "who is this", lang: "en" });
    await draft({ text: "who is this", lang: "ar" });

    expect(completions).toHaveLength(2);
  });

  test("another call category never borrows a fraud reply", async () => {
    // `routine` rather than a name the vocabulary does not contain: an unknown
    // category folds to the default, and folding both sides to the same value
    // would make this test assert that two identical namespaces differ.
    await draft({ text: "who is this", callCategory: "time_critical_fraud" });
    await draft({ text: "who is this", callCategory: "routine" });

    expect(completions).toHaveLength(2);
  });
});

describe("what the cache refuses to serve", () => {
  test("a commitment intent is never drafted, cached, or served", async () => {
    // `deny_fraud` is the scripted line verbatim; the cache must not become a
    // second path by which a model's words reach the customer for it.
    expect(await draft({ text: "that was not me", intent: "deny_fraud" })).toBeNull();
    expect(await draft({ text: "that was not me", intent: "confirm_authorized" })).toBeNull();
    expect(completions).toHaveLength(0);
    expect(defaultSemanticCache().size).toBe(0);
  });

  test("a reply that asserts an account action is never admitted", async () => {
    // The provider said something no automated turn may promise. `llm.ts` returns
    // it once — its own guards do not cover every account claim — so the cache's
    // job is to stop it being REPEATED to the next ten thousand callers.
    nextReply = "Your card has been permanently blocked and your account closed.";
    const first = await draft({ text: "is my card frozen" });
    expect(first).toContain("permanently blocked");
    expect(completions).toHaveLength(1);
    expect(defaultSemanticCache().size, "an account-action claim was written to the cache").toBe(0);

    const again = await draft({ text: "is my card frozen?" });
    // The provider was asked again: that is what "never admitted" means here.
    // (The stub always returns the same sentence, so equality of the text proves
    // nothing — the call count is the signal.)
    expect(completions, "the second turn was served from cache").toHaveLength(2);
    expect(again).toContain("permanently blocked");
  });

  test("a reply carrying a card number is never admitted", async () => {
    // A cached reply outlives the call, the process, and every retention path
    // that governs the database. A sentence holding a PAN is a record nobody can
    // erase, so it is refused at the door rather than redacted on the way in.
    nextReply = "The card ending 4242 4242 4242 4242 was flagged.";
    await draft({ text: "which card are you about" });
    expect(defaultSemanticCache().size).toBe(0);

    await draft({ text: "which card are you about?" });
    expect(completions.length, "a PAN-bearing reply was served from cache").toBeGreaterThan(1);
  });

  test("an empty or degenerate reply is not cached", async () => {
    nextReply = "   ";
    expect(await draft({ text: "hello there" })).toBeNull();
    expect(defaultSemanticCache().size).toBe(0);
  });
});

describe("the cache is bounded and clearable", () => {
  test("clear() forces the next turn back to the provider", async () => {
    await draft({ text: "who is this" });
    defaultSemanticCache().clear();
    await draft({ text: "who is this" });
    expect(completions).toHaveLength(2);
  });
});
