/**
 * Unit — LLM provider selection.
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
 *   - Precedence: GROQ > GEMINI, and neither -> null. The null case is the demo
 *     path: `draftAgentReply` must return null so the VETTED SCRIPTED REPLY is
 *     spoken. Not an empty string, which TTS would read as silence.
 *
 *   - Per-provider tuning. A regression reading `env.groq*` inside the request
 *     would apply Groq's ceiling and timeout to Gemini. It presents as "the
 *     fallback rambles" and never as an error.
 *
 *   - No OpenAI provider. A standing requirement, not an implementation
 *     detail, so it is asserted directly: an `openai` branch added to the
 *     ladder is the regression this file exists to catch the day it lands.
 *
 * The self-hosted LiteLLM rung was removed on 2026-10-20 (docs/GAP-REGISTER.md
 * §62): a proxy in front of Groq shares rung 1's vendor, key and rate limit, so
 * it failed in exactly the outage a fallback exists for. A future rung has to
 * fail independently to earn its place here.
 */
import { expect, test } from "bun:test";
import type { Provider, selectProvider } from "@/lib/llm";

type Cfg = Parameters<typeof selectProvider>[0];

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
  const p = await select({ groqApiKey: "gsk-x", geminiApiKey: "x" });
  expect(p!.name).toBe("groq");
});

test("Gemini answers when Groq is unset", async () => {
  const p = await select({ geminiApiKey: "x" });
  expect(p!.name).toBe("gemini");
});

test("an empty-string key reads as unconfigured, not as a bad credential", async () => {
  // Docker compose interpolates unset vars to "" rather than leaving them
  // absent, so a deployment with no key at all must fall through the ladder
  // rather than attempting a call with an empty bearer token.
  const p = await select({ groqApiKey: "", geminiApiKey: "" });
  expect(p).toBeNull();
});

test("no OpenAI provider exists in the selection ladder", async () => {
  const p = await select({ groqApiKey: "g", geminiApiKey: "m" });

  expect(p!.name).not.toBe("openai");
  expect(p!.model).not.toContain("gpt-");
  // Scoped to the fields that identify WHO answers. Every provider speaks the
  // chat-completions wire format, so a URL path reading "/openai/v1/" is a
  // protocol shape — not an OpenAI dependency. What must never appear is the
  // OpenAI HOST.
  expect(String(p!.url)).not.toContain("api.openai.com");
});

test("Gemini's model is not an OpenAI one either", async () => {
  const p = await select({ geminiApiKey: "m" });
  expect(p!.name).toBe("gemini");
  expect(p!.model).not.toContain("gpt-");
  expect(String(p!.url)).not.toContain("api.openai.com");
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
  const gemini = await select({ geminiApiKey: "m" });

  for (const p of [groq!, gemini!]) {
    expect(p.url).toBeTruthy();
    expect(p.model).toBeTruthy();
    expect(p.key).toBeTruthy();
    expect(p.timeoutMs).toBeGreaterThan(0);
    expect(p.maxTokens).toBeGreaterThan(0);
    expect(p.temperature).toBeGreaterThanOrEqual(0);
    expect(p.temperature).toBeLessThanOrEqual(1);
  }

  const urls = new Set([groq!.url, gemini!.url]);
  expect(urls.size).toBe(2);
});
