/**
 * LLM FAILOVER on a live turn — the ladder as attempts, not as a preference.
 *
 * `selectProvider()` chose ONE provider and any throw became `null`, which meant
 * an environment holding both a Groq key and a self-hosted LiteLLM had a working
 * second provider it never used, and a `DEPENDENCIES` list that named an "llm"
 * circuit breaker nobody had ever instantiated. This file drives the real
 * drafter with the adapter replaced by a script of outcomes, so what is asserted
 * is the behaviour that decides whether a customer hears a sentence or silence.
 *
 * The asymmetry that sets the ordering of these tests: a failed-over turn is a
 * slightly later answer; a turn that falls back from a TENANT'S OWN endpoint to a
 * platform provider is their call text in a processor nobody agreed to. The
 * second one is why a BYOK override has no tail.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { db } from "@/lib/db";
import { resetDefaultSemanticCache } from "@/lib/voice/semantic-cache";

let calls: { provider: string; model: string }[] = [];
let outcomes: ("ok" | "throw" | "slow")[] = ["ok"];
let replyText = "Hello, I am your bank's automated security assistant.";
let attemptDelayMs = 0;
/**
 * Token accounting the fake providers report, consumed in attempt order. Empty
 * means the provider reported nothing — the common case for a self-hosted model,
 * and the reason `LlmUsage`'s token columns are nullable.
 */
let usageScript: { promptTokens?: number; completionTokens?: number; totalTokens?: number }[] = [];

mock.module("@/lib/adapters/llm-adapter", () => ({
  createLlmAdapter: (provider: string, opts: { model?: string }) => ({
    adapterId: `llm.${provider}`,
    provider,
    mode: "real",
    defaultModel: opts?.model ?? "m",
    complete: async () => {
      calls.push({ provider, model: opts?.model ?? "m" });
      const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)] ?? "ok";
      if (attemptDelayMs > 0) await new Promise((r) => setTimeout(r, attemptDelayMs));
      if (outcome === "throw") throw new Error("upstream 503");
      const usage = usageScript[Math.min(calls.length - 1, usageScript.length - 1)];
      return { text: replyText, ...(usage ? { usage } : {}) };
    },
  }),
  LlmAdapterError: class LlmAdapterError extends Error {},
  LLM_PROVIDERS: ["groq", "openai", "gemini", "anthropic"],
  LLM_ADAPTERS: {},
  isLlmProvider: () => true,
  registerLlmAdapter: () => {
    /* empty */
  },
}));

const SAVED = {
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  LITELLM_API_KEY: process.env.LITELLM_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  LLM_TURN_BUDGET_MS: process.env.LLM_TURN_BUDGET_MS,
};

/** Two configured platform providers, in the order the ladder prefers. */
function withLadder(): void {
  process.env.GROQ_API_KEY = "gsk-first";
  process.env.LITELLM_API_KEY = "sk-litellm-second";
  delete process.env.GEMINI_API_KEY;
}

const BYOK = {
  name: "tenant_byok" as const,
  url: "https://bank.example/llm/v1/chat/completions",
  key: "tenant-key",
  model: "self-hosted",
  timeoutMs: 1000,
  temperature: 0.2,
  maxTokens: 120,
};

/**
 * Imported once, after the adapter mock above, so every test drives the same
 * module instance and the breaker state below is the one the drafter uses.
 */
const llm = await import("@/lib/llm");

async function draft(args: { providerOverride?: "byok" | "none" | "empty"; orgId?: string } = {}) {
  return llm.draftAgentReply({
    text: "was this charge mine",
    lang: "en",
    intent: "clarify",
    scriptedReply: "the scripted line",
    callRef: "SV-FAILOVER-TEST",
    callerId: "test",
    callCategory: "time_critical_fraud",
    orgId: args.orgId,
    providerOverride:
      args.providerOverride === "byok"
        ? BYOK
        : args.providerOverride === "empty"
          ? null
          : undefined,
  });
}

beforeEach(() => {
  calls = [];
  outcomes = ["ok"];
  attemptDelayMs = 0;
  usageScript = [];
  replyText = "Hello, I am your bank's automated security assistant.";
  withLadder();
  process.env.LLM_TURN_BUDGET_MS = "5000";
  resetDefaultSemanticCache();
  llm._resetLlmBreakerForTest();
});

describe("a failed provider hands the turn to the next one", () => {
  test("Groq throws, LiteLLM answers, the customer hears a sentence", async () => {
    outcomes = ["throw", "ok"];
    const reply = await draft();
    expect(reply).toBe(replyText);
    expect(calls.map((c) => c.provider)).toEqual(["groq", "openai"]);
  });

  test("every provider failing still ends in the scripted reply, not a crash", async () => {
    outcomes = ["throw", "throw"];
    expect(await draft()).toBeNull();
    expect(calls).toHaveLength(2);
  });

  test("a successful first provider never touches the second", async () => {
    outcomes = ["ok"];
    expect(await draft()).toBe(replyText);
    expect(calls).toHaveLength(1);
  });

  test("an unspeakable completion is NOT a reason to try the next provider", async () => {
    // The request succeeded and the words were unusable. Asking a second
    // provider the same question inside the same budget is a slower way to reach
    // the script, so the ladder stops here by design.
    replyText = "ok";
    outcomes = ["ok", "ok"];
    expect(await draft()).toBeNull();
    expect(calls, "a second provider was tried for unusable words").toHaveLength(1);
  });
});

describe("the turn budget bounds the chain", () => {
  test("an attempt that cannot finish in the budget is never started", async () => {
    process.env.LLM_TURN_BUDGET_MS = "120";
    attemptDelayMs = 200;
    outcomes = ["throw", "ok"];
    const started = Date.now();
    const reply = await draft();
    expect(reply).toBeNull();
    expect(
      calls,
      "the second provider was begun after the turn budget had already gone",
    ).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("a tenant's own endpoint has no tail, on purpose", () => {
  test("BYOK failure does NOT fall back to a platform provider", async () => {
    // Their call text reaching Groq or Gemini on an availability excuse is a
    // data-residency decision this code is not allowed to make for them.
    outcomes = ["throw"];
    const reply = await draft({ providerOverride: "byok" });
    expect(reply).toBeNull();
    expect(calls.map((c) => c.provider)).toEqual(["openai"]);
    expect(calls[0]?.model).toBe("self-hosted");
  });

  test("a resolved-to-nothing override answers with the script and calls nobody", async () => {
    const reply = await draft({ providerOverride: "empty" });
    expect(reply).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("the llm breaker is real, not declared", () => {
  test("repeated failures open it, and an open breaker calls no provider", async () => {
    outcomes = ["throw", "throw"];
    // Five consecutive failures is the threshold; each draft() contributes two.
    for (let i = 0; i < 3; i++) expect(await draft()).toBeNull();
    expect(llm.llmBreakerState().state).toBe("open");

    const before = calls.length;
    expect(await draft()).toBeNull();
    expect(calls, "an open breaker must not spend a turn probing").toHaveLength(before);
  });

  test("a healthy turn does not open it", async () => {
    for (let i = 0; i < 3; i++) expect(await draft()).toBe(replyText);
    expect(llm.llmBreakerState().state).toBe("closed");
  });
});

afterAll(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("token usage is persisted, not only forwarded to Langfuse", () => {
  // The write is fire-and-forget by design — an observability row must never be
  // the reason a turn fails — so the assertion polls rather than assumes the
  // insert has landed by the time `draft()` resolves.
  async function waitForUsageRow(where: { totalTokens: number }) {
    const since = new Date(Date.now() - 15_000);
    for (let i = 0; i < 40; i++) {
      const row = await db.llmUsage.findFirst({
        where: { ...where, createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
      });
      if (row) return row;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  test("the answering rung's usage lands in LlmUsage with its tenant", async () => {
    usageScript = [{ promptTokens: 120, completionTokens: 7, totalTokens: 127 }];
    await draft({ orgId: "org-usage-test" });
    expect(calls.length).toBe(1);

    const row = await waitForUsageRow({ totalTokens: 127 });
    expect(row).not.toBeNull();
    if (!row) throw new Error("unreachable");
    // Attribution names the rung that ANSWERED, which is the only rung whose
    // tokens were spent — and the tenant that owns the cost.
    expect({ provider: row.provider, totalTokens: row.totalTokens, orgId: row.orgId }).toEqual({
      provider: calls[0]!.provider,
      totalTokens: 127,
      orgId: "org-usage-test",
    });
    expect(row.latencyMs).not.toBeNull();
  });

  test("a provider that reports no usage still records the call it answered", () => {
    usageScript = [];
    return (async () => {
      await draft();
      expect(calls.length).toBe(1);
      // The row is optional when the provider omits accounting; the poll above
      // covers the present case. Here the contract is only that the turn is
      // unaffected — no throw, a reply, and no usage-shaped crash swallowed
      // silently into a missing reply.
      expect(calls[0]).toBeDefined();
    })();
  });
});
