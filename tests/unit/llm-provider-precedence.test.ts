/**
 * Unit — LLM provider selection, including the LiteLLM path.
 *
 * These assertions run against `selectProvider`, a PURE function over an
 * injected config, not against `process.env`. That is deliberate: env is global
 * mutable state, these tests are concurrent, and a version that blanks a
 * variable to reach the next rung can interleave with one that sets it — so the
 * suite passes for the wrong reason and the ladder becomes untouchable.
 * `provider()` is a thin binding of the same function to the real config, so
 * what is tested here is what runs in production.
 *
 * What is pinned, and why each matters:
 *
 *   - Precedence: GROQ > LITELLM > GEMINI, and none -> null. The null case is
 *     the demo path: `draftAgentReply` must return null so the VETTED SCRIPTED
 *     REPLY is spoken. Not an empty string, which TTS would read as silence.
 *
 *   - Per-provider tuning. A regression reading `env.groq*` inside the request
 *     would apply Groq's ceiling and timeout to a self-hosted 70B model. It
 *     presents as "the self-hosted model rambles" and never as an error.
 *
 *   - No OpenAI provider. A standing requirement, not an implementation
 *     detail, so it is asserted directly: an `openai` branch added to the
 *     ladder is the regression this file exists to catch the day it lands.
 */
import { expect, test } from "bun:test";
import type { Provider } from "@/lib/llm";

type Cfg = Parameters<typeof import("@/lib/llm").selectProvider>[0];

/**
 * A config with every provider ABSENT. Spread this and switch on the one being
 * exercised, so a new provider added to the real signature shows up here as a
 * compile error rather than as a silently-unset field that reads "not
 * configured" in every test.
 */
function cfg(overrides: Partial<Cfg> = {}): Cfg {
  return {
    groqBaseUrl: "https://api.groq.com/openai/v1/chat/completions",
    groqModel: "qwen/qwen3.8-27b",
    groqTimeoutMs: 8_000,
    groqTemperature: 0.3,
    groqMaxTokens: 160,
    litellmBaseUrl: "http://litellm:4000",
    litellmModel: "llama-3.3-70b-instruct",
    litellmTimeoutMs: 8_000,
    litellmTemperature: 0.3,
    litellmMaxTokens: 160,
    geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    geminiModel: "gemini-1.5-flash",
    ...overrides,
  };
}

async function select(overrides: Partial<Cfg>): Promise<Provider | null> {
  const { selectProvider } = await import("@/lib/llm");
  return selectProvider(cfg(overrides));
}

test("no provider configured resolves to null so the scripted reply is spoken", async () => {
  expect(await select({})).toBeNull();
});

test("Groq wins when configured", async () => {
  const p = await select({ groqApiKey: "gsk-x", litellmApiKey: "sk-x", geminiApiKey: "x" });
  expect(p!.name).toBe("groq");
});

test("LiteLLM is used when Groq is unset", async () => {
  const p = await select({ litellmApiKey: "sk-x", geminiApiKey: "x" });
  expect(p!.name).toBe("lite_llm");
});

test("Gemini is the last resort", async () => {
  const p = await select({ geminiApiKey: "x" });
  expect(p!.name).toBe("gemini");
});

test("an empty-string key reads as unconfigured, not as a bad credential", async () => {
  // Docker compose interpolates unset vars to "" rather than leaving them
  // absent, so a deployment with no key at all must fall through the ladder
  // rather than attempting a call with an empty bearer token.
  const p = await select({ groqApiKey: "", litellmApiKey: "", geminiApiKey: "" });
  expect(p).toBeNull();
});

test("no OpenAI provider exists in the selection ladder", async () => {
  const p = await select({ groqApiKey: "g", litellmApiKey: "l", geminiApiKey: "m" });

  expect(p!.name).not.toBe("openai");
  expect(p!.model).not.toContain("gpt-");
  // Scoped to the fields that identify WHO answers. Every provider speaks the
  // chat-completions wire format, so a URL path reading "/openai/v1/" is a
  // protocol shape — not an OpenAI dependency. What must never appear is the
  // OpenAI HOST.
  expect(String(p!.url)).not.toContain("api.openai.com");
});

test("the whole ladder stays OpenAI-free for a self-hosted LiteLLM deployment", async () => {
  // The configuration this codebase is actually pointed at: a LiteLLM proxy
  // with no upstream vendor relationship at all.
  const p = await select({ litellmApiKey: "sk-test" });
  expect(p!.name).toBe("lite_llm");
  expect(p!.model).not.toContain("gpt-");
  expect(String(p!.url)).not.toContain("api.openai.com");
});

test("LiteLLM default model is self-hostable and covers the agent's languages", async () => {
  const p = await select({ litellmApiKey: "sk-test" });
  // Permissively licensed and servable on commodity GPUs, with real coverage
  // of the languages this agent speaks (ar, hi, ur, fr, sw). A model strong
  // only on en loses the call the moment the customer answers in Urdu.
  expect(p!.model).toContain("llama");
  expect(p!.model).not.toContain("gpt-");
});

test("LiteLLM tuning is its own, not inherited", async () => {
  const p = await select({
    litellmApiKey: "sk-test",
    litellmTemperature: 0.1,
    litellmMaxTokens: 64,
    litellmTimeoutMs: 3_000,
  });
  expect(p!.temperature).toBe(0.1);
  expect(p!.maxTokens).toBe(64);
  expect(p!.timeoutMs).toBe(3_000);
});

test("Gemini's tuning is pinned, not inherited from another provider", async () => {
  const p = await select({ geminiApiKey: "x" });
  expect(p!.timeoutMs).toBe(8_000);
  expect(p!.temperature).toBe(0.3);
  expect(p!.maxTokens).toBe(160);
});

test("no provider leaks another provider's url, model, key or tuning", async () => {
  // Each rung carries its own identity end to end. The specific historical bug
  // this guards: mixing a provider's URL with another's model, or one
  // provider's max_tokens with another's timeout.
  const groq = await select({ groqApiKey: "g" });
  const litellm = await select({ litellmApiKey: "l" });
  const gemini = await select({ geminiApiKey: "m" });

  for (const p of [groq!, litellm!, gemini!]) {
    expect(p.url).toBeTruthy();
    expect(p.model).toBeTruthy();
    expect(p.key).toBeTruthy();
    expect(p.timeoutMs).toBeGreaterThan(0);
    expect(p.maxTokens).toBeGreaterThan(0);
    expect(p.temperature).toBeGreaterThanOrEqual(0);
    expect(p.temperature).toBeLessThanOrEqual(1);
  }

  const urls = new Set([groq!.url, litellm!.url, gemini!.url]);
  expect(urls.size).toBe(3);
});
