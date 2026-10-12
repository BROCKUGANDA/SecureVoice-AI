/**
 * THE LLM SEAM — four providers, two wire formats, and a failure that says
 * which provider and whether retrying could help.
 *
 * `src/lib/adapters/llm-adapter.ts` is what `src/lib/llm.ts` resolves a tenant's
 * gateway through (checklist #401-#450). Three properties earn these tests:
 *
 *   1. `LlmAdapterError` carries `provider`, `status` and `retryable`. A bare
 *      `Error` discards exactly the two facts a caller needs to decide whether to
 *      try the next rung of the provider ladder or give up. `status: 0` means no
 *      HTTP response was received at all — timeout, DNS, TLS — which is why it is
 *      retryable: nothing about the request was wrong.
 *   2. AN EMPTY COMPLETION IS A FAILURE. A provider that answers 200 with no text
 *      resolves to `""` nowhere near the caller: on a fraud call the reply is
 *      what gets spoken, and a blank string becomes silence the customer cannot
 *      distinguish from a dropped call.
 *   3. AN UNCONFIGURED CREDENTIAL REFUSES BY NAME. The message names the variable
 *      to set, and it is not retryable — a missing key does not arrive on the
 *      second attempt.
 *
 * Every request goes through an injected `fetchImpl`, so nothing here can reach a
 * model or cost money.
 */
import { describe, expect, test } from "bun:test";
import {
  createLlmAdapter,
  isLlmProvider,
  LLM_ADAPTERS,
  LlmAdapterError,
  LLM_PROVIDERS,
  registerLlmAdapter,
} from "@/lib/adapters/llm-adapter";

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function transport(
  response: { status?: number; body?: unknown } = {
    status: 200,
    body: { choices: [{ message: { content: "  that was not me  " } }] },
  },
): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(
      typeof response.body === "string" ? response.body : JSON.stringify(response.body ?? {}),
      { status: response.status ?? 200 },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const KEY = { apiKey: "sk_test_key" };

describe("the factory", () => {
  test("resolves every built-in and reports its default model", () => {
    const seen = new Set<string>();
    for (const name of LLM_PROVIDERS) {
      const adapter = createLlmAdapter(name, { ...KEY, fetchImpl: transport().fetchImpl });
      expect(adapter.provider).toBe(name);
      expect(adapter.mode).toBe("real");
      expect(adapter.adapterId).toBe(`llm.${name}`);
      // A model name that is a real deployment target, not a placeholder.
      expect(adapter.defaultModel.length).toBeGreaterThan(3);
      seen.add(adapter.defaultModel);
    }
    // Four providers with four different defaults: one shared "gpt-4o-mini"
    // would mean three of them are silently calling the same thing.
    expect(seen.size).toBe(LLM_PROVIDERS.length);
  });

  test("an unknown provider is refused at construction, and the message is a TypeError", () => {
    expect(() => createLlmAdapter("mistral")).toThrow(TypeError);
    expect(isLlmProvider("groq")).toBe(true);
    expect(isLlmProvider("mistral")).toBe(false);
  });

  test("the registry is open, and a registered provider is loadable by the same factory", () => {
    registerLlmAdapter("  Local  ", (config) => createLlmAdapter("groq", config));
    expect(createLlmAdapter("local", { ...KEY, fetchImpl: transport().fetchImpl }).provider).toBe(
      "groq",
    );
    expect(() => registerLlmAdapter("", () => createLlmAdapter("groq"))).toThrow(TypeError);
    expect(() => registerLlmAdapter("x", 42 as never)).toThrow(TypeError);
    delete LLM_ADAPTERS["local"];
  });
});

describe("the chat-completions wire format", () => {
  test("posts Bearer auth to the provider endpoint and reads the assistant text", async () => {
    const t = transport({
      status: 200,
      body: {
        choices: [{ message: { content: " That was not me. " } }],
        usage: { prompt_tokens: 120, completion_tokens: 7, total_tokens: 127 },
      },
    });
    const res = await createLlmAdapter("openai", { ...KEY, fetchImpl: t.fetchImpl }).complete(
      "was this your card purchase?",
    );

    expect(res.text).toBe("That was not me.");
    expect(res.usage).toEqual({ promptTokens: 120, completionTokens: 7, totalTokens: 127 });
    expect(t.calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(t.calls[0]!.headers.authorization).toBe("Bearer sk_test_key");
    const body = t.calls[0]!.body;
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.max_tokens).toBe(512);
    expect(body.messages).toEqual([{ role: "user", content: "was this your card purchase?" }]);
  });

  test("a system prompt is the FIRST message, which is how the agent's security rules reach the model", async () => {
    const t = transport();
    await createLlmAdapter("groq", { ...KEY, fetchImpl: t.fetchImpl }).complete("hello", {
      systemPrompt: "Never ask for a PIN.",
    });

    expect(t.calls[0]!.body.messages).toEqual([
      { role: "system", content: "Never ask for a PIN." },
      { role: "user", content: "hello" },
    ]);
    // Groq speaks the OpenAI format at its own endpoint with its own default.
    expect(t.calls[0]!.url).toBe("https://api.groq.com/openai/v1/chat/completions");
  });

  test("a content array is joined, so a chunked reply survives", async () => {
    const t = transport({
      body: {
        choices: [{ message: { content: [{ text: "not " }, { text: "mine" }, " at all"] } }],
      },
    });
    const res = await createLlmAdapter("openai", { ...KEY, fetchImpl: t.fetchImpl }).complete("x");
    expect(res.text).toBe("not mine at all");
  });

  test("a configured endpoint and model override the provider defaults", async () => {
    const t = transport();
    const adapter = createLlmAdapter("openai", {
      ...KEY,
      baseUrl: "https://gateway.bank.ae/v1/chat",
      model: "in-house-1",
      maxTokens: 64,
      temperature: 0,
      fetchImpl: t.fetchImpl,
    });
    await adapter.complete("x");

    expect(t.calls[0]!.url).toBe("https://gateway.bank.ae/v1/chat");
    expect(t.calls[0]!.body.model).toBe("in-house-1");
    expect(t.calls[0]!.body.max_tokens).toBe(64);
    expect(t.calls[0]!.body.temperature).toBe(0);
    expect(adapter.defaultModel).toBe("in-house-1");
  });

  test("a system prompt bound at construction reaches the wire, and a per-call one overrides it", async () => {
    // `src/lib/llm.ts` configures the agent's rules ONCE, on the adapter. The
    // field existed and was read by nothing, so every fraud call ran with no
    // system message at all — the vishing rules, the disclosure requirement and
    // the never-ask-for-a-PIN directive were silently dropped.
    const bound = transport();
    await createLlmAdapter("openai", {
      ...KEY,
      systemPrompt: "You are a bank's automated fraud assistant.",
      fetchImpl: bound.fetchImpl,
    }).complete("who is this?");
    expect(bound.calls[0]!.body.messages).toEqual([
      { role: "system", content: "You are a bank's automated fraud assistant." },
      { role: "user", content: "who is this?" },
    ]);

    const overridden = transport();
    await createLlmAdapter("groq", {
      ...KEY,
      systemPrompt: "bound rules",
      fetchImpl: overridden.fetchImpl,
    }).complete("x", { systemPrompt: "call-specific rules" });
    expect((overridden.calls[0]!.body.messages as { role: string; content: string }[])[0]).toEqual({
      role: "system",
      content: "call-specific rules",
    });

    // The same on the Anthropic wire format, which is its own implementation.
    const claude = transport({ body: { content: [{ type: "text", text: "ok" }] } });
    await createLlmAdapter("anthropic", {
      ...KEY,
      systemPrompt: "Never ask for a PIN.",
      fetchImpl: claude.fetchImpl,
    }).complete("hello");
    expect((claude.calls[0]!.body.messages as { role: string }[])[0]!.role).toBe("system");
    expect(JSON.stringify(claude.calls[0]!.body)).toContain("Never ask for a PIN.");
  });

  test("a bare call sends no system message at all, rather than an empty one", async () => {
    const t = transport();
    await createLlmAdapter("openai", { ...KEY, fetchImpl: t.fetchImpl }).complete(
      "only a question",
    );
    expect(t.calls[0]!.body.messages).toEqual([{ role: "user", content: "only a question" }]);
  });
});

describe("the Anthropic Messages format", () => {
  test("uses the key header, pins the API version, and normalises usage to one vocabulary", async () => {
    const t = transport({
      body: {
        content: [
          { type: "text", text: "I did not authorise it." },
          { type: "tool_use", id: "t1" },
        ],
        usage: { input_tokens: 300, output_tokens: 12 },
      },
    });
    const res = await createLlmAdapter("anthropic", { ...KEY, fetchImpl: t.fetchImpl }).complete(
      "did you make this payment?",
      { systemPrompt: "You are a fraud assistant." },
    );

    expect(t.calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(t.calls[0]!.headers["x-api-key"]).toBe("sk_test_key");
    expect(t.calls[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(t.calls[0]!.headers.authorization).toBeUndefined();
    // max_tokens is REQUIRED by this API, unlike the OpenAI-compatible ones.
    expect(t.calls[0]!.body.max_tokens).toBe(1024);
    // Only `type: "text"` blocks are spoken; a tool_use block is not prose.
    expect(res.text).toBe("I did not authorise it.");
    expect(res.usage).toEqual({ promptTokens: 300, completionTokens: 12, totalTokens: 312 });
  });
});

describe("failures a caller can act on", () => {
  test("a missing credential refuses by env-var name and says it is not retryable", async () => {
    const t = transport();
    const err = await createLlmAdapter("groq", { fetchImpl: t.fetchImpl })
      .complete("x")
      .catch((e) => e);

    expect(err).toBeInstanceOf(LlmAdapterError);
    expect(err.status).toBe(401);
    expect(err.retryable).toBe(false);
    expect(err.provider).toBe("groq");
    expect(err.message).toContain("GROQ_API_KEY");
    // Refusing means refusing: no request left the process.
    expect(t.calls).toHaveLength(0);
  });

  test("an empty completion is a 502, never an empty string handed to the caller", async () => {
    for (const body of [
      { choices: [] },
      { choices: [{ message: { content: "   " } }] },
      { choices: [{ message: {} }] },
      {},
    ]) {
      const err = await createLlmAdapter("openai", {
        ...KEY,
        fetchImpl: transport({ body }).fetchImpl,
      })
        .complete("x")
        .catch((e) => e);
      expect(err).toBeInstanceOf(LlmAdapterError);
      expect(err.status).toBe(502);
      expect(err.message).toContain("no completion text");
    }
  });

  test("retryability is the provider's status, not a guess", async () => {
    const cases: [number, boolean][] = [
      [400, false],
      [401, false],
      [404, false],
      [429, true],
      [500, true],
      [503, true],
    ];
    for (const [status, retryable] of cases) {
      const err = await createLlmAdapter("openai", {
        ...KEY,
        fetchImpl: transport({ status, body: { error: { message: "no" } } }).fetchImpl,
      })
        .complete("x")
        .catch((e) => e);
      expect(err.status, `status ${status}`).toBe(status);
      expect(err.retryable, `retryable for ${status}`).toBe(retryable);
      expect(err.message).toBe(`openai: no`);
    }
  });

  test("a transport failure is status 0 and retryable, because nothing about the request was wrong", async () => {
    const dead = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    const err = await createLlmAdapter("openai", { ...KEY, fetchImpl: dead })
      .complete("x")
      .catch((e) => e);

    expect(err).toBeInstanceOf(LlmAdapterError);
    expect(err.status).toBe(0);
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("socket hang up");
  });

  test("a request that never answers is bounded by the timeout", async () => {
    const never = ((...args: unknown[]) => {
      const init = args[1] as { signal?: AbortSignal };
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("The operation aborted.")));
      });
    }) as unknown as typeof fetch;

    const raced = await Promise.race([
      createLlmAdapter("openai", { ...KEY, timeoutMs: 40, fetchImpl: never })
        .complete("x")
        .catch((e) => e),
      new Promise((resolve) => setTimeout(() => resolve("HUNG"), 1_500)),
    ]);

    expect(raced).not.toBe("HUNG");
    expect(raced).toBeInstanceOf(LlmAdapterError);
    expect((raced as InstanceType<typeof LlmAdapterError>).status).toBe(0);
    expect((raced as InstanceType<typeof LlmAdapterError>).retryable).toBe(true);
  });

  test("an empty prompt is refused before the credential check or any egress", async () => {
    const t = transport();
    const adapter = createLlmAdapter("openai", { fetchImpl: t.fetchImpl });

    // TypeError, not LlmAdapterError: this is a caller bug, not a provider fault.
    await expect(adapter.complete("   ")).rejects.toBeInstanceOf(TypeError);
    await expect(adapter.complete("")).rejects.toThrow("non-empty string");
    expect(t.calls).toHaveLength(0);
  });

  test("a non-JSON success body is a 502 rather than a crash", async () => {
    const err = await createLlmAdapter("openai", {
      ...KEY,
      fetchImpl: transport({ status: 200, body: "<html>proxy said no</html>" }).fetchImpl,
    })
      .complete("x")
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmAdapterError);
    expect(err.status).toBe(502);
  });
});
