import "server-only";

/**
 * Formal LLM adapter layer.
 *
 * One interface — `LlmAdapter` — and one factory — `createLlmAdapter(name)` —
 * standing in front of four providers that do NOT share a wire format:
 *
 *   - OpenAI, Groq and Gemini speak the OpenAI **chat-completions** shape
 *     (`POST …/chat/completions`, text at `choices[0].message.content`).
 *   - Anthropic speaks the **Messages** shape (`POST /v1/messages`, text at
 *     `content[].text`) and authenticates with `x-api-key`, not `Bearer`.
 *
 * A caller never learns which of the two shapes is underneath. It asks for a
 * completion and gets a string, or a typed `LlmAdapterError` naming the provider
 * and the HTTP status. That is the whole point of the adapter: the provider is a
 * configuration value, not a code path a caller branches on.
 *
 * ## Why a registry and not a `switch`
 *
 * `createLlmAdapter` resolves a provider through `LLM_ADAPTERS`, a
 * name-to-factory table, and `registerLlmAdapter` can add a provider at
 * runtime. The factory imports no provider module per branch, so adding a fifth
 * vendor is a registry entry rather than an edit to a conditional — and a caller
 * can enumerate what is loadable (`Object.keys(LLM_ADAPTERS)`) without
 * constructing one.
 *
 * ## Configuration
 *
 * Each factory reads its own environment by default and accepts an explicit
 * `LlmAdapterConfig` override for everything: credential, base URL, model,
 * timeout, sampling, and even the `fetch` implementation. The override is what
 * makes an adapter testable with no network and no credential — the same
 * posture `@/lib/payments/paystack` takes with its injected HTTP client.
 *
 * The environment variable names mirror `@/lib/config.ts` (`GROQ_API_KEY`,
 * `GEMINI_MODEL`, …) so a deployment that already tunes Groq or Gemini for the
 * voice plane tunes this layer with the same variables. Where a default here
 * differs from `@/lib/config.ts` it is because that module's default is tuned
 * for a two-second voice turn and this layer's is not; setting the variable
 * makes the two agree.
 *
 * ## Not a policy layer
 *
 * This module transports text and nothing else. It does not classify intent,
 * does not decide to freeze a card, and does not scan its own output — those
 * live in `@/lib/llm.ts`, `@/lib/llm-guard.ts` and `@/lib/compliance/*`, which
 * sit ABOVE this adapter and must keep sitting above it. A completion returned
 * from here is untrusted text until one of those has looked at it.
 */

import type { AdapterMode } from "@/lib/ports/types";
import { env } from "@/lib/config";

// ── provider vocabulary ──────────────────────────────────────────────────────

/** The providers this layer ships an adapter for. */
export const LLM_PROVIDERS = ["openai", "groq", "anthropic", "gemini"] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/** Narrow an arbitrary string to a known provider. Case-insensitive. */
export function isLlmProvider(value: string): value is LlmProvider {
  return (LLM_PROVIDERS as readonly string[]).includes(normaliseProviderName(value));
}

// ── configuration ────────────────────────────────────────────────────────────

/**
 * Everything a factory may be told, all optional.
 *
 * Every field falls back to an environment variable and then to a default, so
 * `createLlmAdapter("groq")` is a complete, working adapter the moment
 * `GROQ_API_KEY` is set. Supplying a field here overrides both — which is how a
 * test drives an adapter against a stub `fetch` with no credential at all.
 */
export type LlmAdapterConfig = {
  /** Provider credential. Overrides the provider's own env var. */
  apiKey?: string;
  /** Full endpoint URL (not just an origin). Overrides the provider default. */
  baseUrl?: string;
  /** Model id. Overrides the provider's env env and default. */
  model?: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Sampling temperature, 0..1. */
  temperature?: number;
  /** Response token ceiling. */
  maxTokens?: number;
  /** Injected transport, for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * System prompt to send alongside the user message.
   *
   * The voice agent's system prompt is the security boundary — it carries the
   * vishing rules, the disclosure requirement, and the "never ask for secrets"
   * directive. Without it the model has no constraints and will happily role-play
   * or solicit credentials. This field makes the adapter a complete transport
   * for the agent's needs, not just a generic chat-completions caller.
   */
  systemPrompt?: string;
};

// ── results and errors ───────────────────────────────────────────────────────

/**
 * The result of a successful completion.
 *
 * `text` is the extracted assistant message, trimmed and guaranteed non-empty.
 * `usage` is the provider's token accounting when it reports one — OpenAI and
 * Anthropic both do, but a proxy or a self-hosted model may not, so it is
 * optional. Callers that need usage for observability (Langfuse, cost tracking)
 * read it here rather than re-parsing the response.
 */
export type LlmCompletion = {
  text: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
};

/**
 * The failure a `complete()` rejects with.
 *
 * A typed error rather than a `null` or a bare `Error` because the two facts a
 * caller needs in order to act — WHICH provider failed and WHETHER retrying
 * could help — are exactly the two a bare `Error` discards. `status === 0` is
 * the "no HTTP status was received" case (timeout, DNS, TLS), which is also why
 * it is retryable: nothing about the request itself was wrong.
 */
export class LlmAdapterError extends Error {
  /** The provider whose request failed. */
  readonly provider: LlmProvider;
  /** HTTP status, or 0 when no response was received at all. */
  readonly status: number;
  /** True for a timeout, a 429, or any 5xx — the request may succeed later. */
  readonly retryable: boolean;

  constructor(
    message: string,
    opts: { provider: LlmProvider; status: number; retryable?: boolean; cause?: unknown },
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "LlmAdapterError";
    this.provider = opts.provider;
    this.status = opts.status;
    this.retryable =
      opts.retryable ?? (opts.status === 0 || opts.status === 429 || opts.status >= 500);
  }
}

// ── the interface ────────────────────────────────────────────────────────────

/**
 * A provider, reduced to the one operation a caller needs.
 *
 * `adapterId` and `mode` mirror the port vocabulary in `@/lib/ports/types`: an
 * adapter says what it is, so a report can print the binding rather than infer
 * it. These are real adapters, so `mode` is always `"real"`.
 */
export interface LlmAdapter {
  /** Stable adapter id, e.g. `llm.openai`. Written to logs and evidence. */
  readonly adapterId: string;
  /** Which provider this adapter speaks to. */
  readonly provider: LlmProvider;
  /** Real or fake, per the port convention. Always `"real"` here. */
  readonly mode: AdapterMode;
  /** The model used when the caller configured none. */
  readonly defaultModel: string;
  /**
   * Send one user prompt and resolve with the assistant's text, trimmed.
   *
   * Rejects with an `LlmAdapterError` on a missing credential, a non-2xx
   * response, a transport failure, or an empty completion — never with a bare
   * `Error`, and never with a silent `null` that hides the reason.
   *
   * @param prompt The user's utterance. Must be non-empty.
   * @param opts.systemPrompt Optional system prompt. When provided, it is sent
   *   as the first message with `role: "system"`, which is how the voice agent's
   *   security rules reach the model. Omit for a bare user-message call.
   */
  complete(prompt: string, opts?: { systemPrompt?: string }): Promise<LlmCompletion>;
}

// ── shared wire format: chat-completions ─────────────────────────────────────

/** The resolved settings a chat-completions adapter runs with. */
type ChatCompletionsSpec = {
  provider: LlmProvider;
  adapterId: string;
  apiKey: string | undefined;
  /** Named in the refusal so an operator knows which variable to set. */
  apiKeyEnvVar: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  temperature: number;
  maxTokens: number;
  /**
   * The system prompt bound at construction. `complete()` may still override it
   * per call; this is the default, so a caller that configures the agent's rules
   * once is not relying on every later call site to remember to pass them.
   */
  systemPrompt?: string;
  fetchImpl: typeof fetch;
};

/**
 * OpenAI, Groq and Gemini differ only in endpoint, credential and default
 * model — the request and response shapes are identical — so they share one
 * implementation. A second copy of this body per provider is a second place for
 * the wire format to drift.
 */
function createChatCompletionsAdapter(spec: ChatCompletionsSpec): LlmAdapter {
  return {
    adapterId: spec.adapterId,
    provider: spec.provider,
    mode: "real",
    defaultModel: spec.model,
    async complete(prompt: string, opts?: { systemPrompt?: string }): Promise<LlmCompletion> {
      const text = assertPrompt(prompt);
      if (!spec.apiKey) {
        throw new LlmAdapterError(
          `${spec.provider}: ${spec.apiKeyEnvVar} is not configured — refusing to call the provider without a credential`,
          { provider: spec.provider, status: 401, retryable: false },
        );
      }
      const messages: Array<{ role: string; content: unknown }> = [];
      // A per-call prompt wins; the one bound at construction is the default.
      // Reading only `opts` would silently drop the agent's security rules for
      // every caller that configured them on the adapter — which is what
      // `src/lib/llm.ts` does.
      const systemPrompt = opts?.systemPrompt ?? spec.systemPrompt;
      if (systemPrompt) {
        messages.push({ role: "system", content: systemPrompt });
      }
      messages.push({ role: "user", content: text });
      const outcome = await postJson(spec.baseUrl, {
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${spec.apiKey}`,
        },
        body: {
          model: spec.model,
          messages,
          temperature: spec.temperature,
          max_tokens: spec.maxTokens,
        },
        timeoutMs: spec.timeoutMs,
        fetchImpl: spec.fetchImpl,
      });
      if (!outcome.ok) {
        throw new LlmAdapterError(`${spec.provider}: ${outcome.error}`, {
          provider: spec.provider,
          status: outcome.status,
        });
      }
      const completion = extractChatCompletionText(outcome.body);
      if (completion === null) {
        throw new LlmAdapterError(`${spec.provider}: provider returned no completion text`, {
          provider: spec.provider,
          status: 502,
        });
      }
      const usage = extractOpenAiUsage(outcome.body);
      return { text: completion, ...(usage ? { usage } : {}) };
    },
  };
}

/** OpenAI — `api.openai.com`, `Authorization: Bearer`. */
function createOpenAiAdapter(config: LlmAdapterConfig = {}): LlmAdapter {
  return createChatCompletionsAdapter({
    provider: "openai",
    adapterId: "llm.openai",
    apiKey: config.apiKey ?? process.env.OPENAI_API_KEY,
    apiKeyEnvVar: "OPENAI_API_KEY",
    baseUrl:
      config.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1/chat/completions",
    model: config.model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    timeoutMs: config.timeoutMs ?? readPositiveInt(process.env.OPENAI_TIMEOUT_MS, 15_000),
    temperature: config.temperature ?? readTemperature(process.env.OPENAI_TEMPERATURE, 0.3),
    maxTokens: config.maxTokens ?? readPositiveInt(process.env.OPENAI_MAX_TOKENS, 512),
    systemPrompt: config.systemPrompt,
    fetchImpl: config.fetchImpl ?? fetch,
  });
}

/** Groq — LPUs, OpenAI-compatible wire format. */
function createGroqAdapter(config: LlmAdapterConfig = {}): LlmAdapter {
  return createChatCompletionsAdapter({
    provider: "groq",
    adapterId: "llm.groq",
    apiKey: config.apiKey ?? process.env.GROQ_API_KEY,
    apiKeyEnvVar: "GROQ_API_KEY",
    baseUrl:
      config.baseUrl ??
      process.env.GROQ_BASE_URL ??
      "https://api.groq.com/openai/v1/chat/completions",
    model: config.model ?? env.groqModel,
    timeoutMs: config.timeoutMs ?? readPositiveInt(process.env.GROQ_TIMEOUT_MS, 8_000),
    temperature: config.temperature ?? readTemperature(process.env.GROQ_TEMPERATURE, 0.3),
    maxTokens: config.maxTokens ?? readPositiveInt(process.env.GROQ_MAX_TOKENS, 512),
    systemPrompt: config.systemPrompt,
    fetchImpl: config.fetchImpl ?? fetch,
  });
}

/** Gemini — the OpenAI-compatibility endpoint, `Authorization: Bearer`. */
function createGeminiAdapter(config: LlmAdapterConfig = {}): LlmAdapter {
  return createChatCompletionsAdapter({
    provider: "gemini",
    adapterId: "llm.gemini",
    apiKey: config.apiKey ?? process.env.GEMINI_API_KEY,
    apiKeyEnvVar: "GEMINI_API_KEY",
    baseUrl:
      config.baseUrl ??
      process.env.GEMINI_BASE_URL ??
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: config.model ?? env.geminiModel,
    timeoutMs: config.timeoutMs ?? readPositiveInt(process.env.GEMINI_TIMEOUT_MS, 15_000),
    temperature: config.temperature ?? readTemperature(process.env.GEMINI_TEMPERATURE, 0.3),
    maxTokens: config.maxTokens ?? readPositiveInt(process.env.GEMINI_MAX_TOKENS, 512),
    systemPrompt: config.systemPrompt,
    fetchImpl: config.fetchImpl ?? fetch,
  });
}

// ── Anthropic: the Messages wire format ──────────────────────────────────────

/**
 * Anthropic's Messages API is not chat-completions: the credential header is
 * `x-api-key`, a version header is mandatory, `max_tokens` is required rather
 * than optional, and the reply is a list of typed content blocks. It gets its
 * own implementation rather than a flag inside the shared one, because forcing
 * two shapes through one body is how a field ends up sent to the wrong vendor.
 */
function createAnthropicAdapter(config: LlmAdapterConfig = {}): LlmAdapter {
  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const baseUrl =
    config.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1/messages";
  const model = config.model ?? process.env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-latest";
  const timeoutMs = config.timeoutMs ?? readPositiveInt(process.env.ANTHROPIC_TIMEOUT_MS, 20_000);
  const temperature = config.temperature ?? readTemperature(process.env.ANTHROPIC_TEMPERATURE, 0.3);
  const maxTokens = config.maxTokens ?? readPositiveInt(process.env.ANTHROPIC_MAX_TOKENS, 1024);
  const systemPrompt = config.systemPrompt;
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    adapterId: "llm.anthropic",
    provider: "anthropic",
    mode: "real",
    defaultModel: model,
    async complete(prompt: string, opts?: { systemPrompt?: string }): Promise<LlmCompletion> {
      const text = assertPrompt(prompt);
      if (!apiKey) {
        throw new LlmAdapterError(
          "anthropic: ANTHROPIC_API_KEY is not configured — refusing to call the provider without a credential",
          { provider: "anthropic", status: 401, retryable: false },
        );
      }
      const messages: Array<{ role: string; content: unknown }> = [];
      const system = opts?.systemPrompt ?? systemPrompt;
      if (system) {
        messages.push({ role: "system", content: system });
      }
      messages.push({ role: "user", content: text });
      const outcome = await postJson(baseUrl, {
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-api-key": apiKey,
          // Pinned, not inherited: an API version is part of the request
          // contract, and letting it float would let a vendor change break a
          // deployment that never touched this file.
          "anthropic-version": "2023-06-01",
        },
        body: {
          model,
          max_tokens: maxTokens,
          temperature,
          messages,
        },
        timeoutMs,
        fetchImpl,
      });
      if (!outcome.ok) {
        throw new LlmAdapterError(`anthropic: ${outcome.error}`, {
          provider: "anthropic",
          status: outcome.status,
        });
      }
      const completion = extractAnthropicText(outcome.body);
      if (completion === null) {
        throw new LlmAdapterError("anthropic: provider returned no completion text", {
          provider: "anthropic",
          status: 502,
        });
      }
      const usage = extractAnthropicUsage(outcome.body);
      return { text: completion, ...(usage ? { usage } : {}) };
    },
  };
}

// ── the registry and the factory ─────────────────────────────────────────────

/** A function that builds a configured adapter for one provider. */
export type LlmAdapterFactory = (config?: LlmAdapterConfig) => LlmAdapter;

/**
 * The open registry, keyed by lower-cased provider name.
 *
 * It is deliberately a mutable `Record` rather than a frozen one: `registerLlmAdapter`
 * extends it, so a provider shipped outside this file is loadable through the
 * same factory as the built-ins. `Object.keys(LLM_ADAPTERS)` is the loadable
 * set — a caller can report it without constructing anything.
 */
export const LLM_ADAPTERS: Record<string, LlmAdapterFactory> = {
  openai: createOpenAiAdapter,
  groq: createGroqAdapter,
  anthropic: createAnthropicAdapter,
  gemini: createGeminiAdapter,
};

/**
 * Add or replace a provider factory. The name is normalised (trimmed, lower
 * cased) so `"OpenAI"` and `"openai"` cannot become two entries.
 */
export function registerLlmAdapter(provider: string, factory: LlmAdapterFactory): void {
  const key = normaliseProviderName(provider);
  if (key.length === 0) {
    throw new TypeError("registerLlmAdapter: provider name must be a non-empty string");
  }
  if (typeof factory !== "function") {
    throw new TypeError("registerLlmAdapter: factory must be a function");
  }
  LLM_ADAPTERS[key] = factory;
}

/**
 * Resolve an adapter by provider name.
 *
 * An unknown name is a `TypeError` at construction, not a runtime failure mid
 * call: a caller that typo'd a provider wants to hear about it before it sends
 * a request, and the message names every provider that IS loadable.
 */
export function createLlmAdapter(provider: string, config: LlmAdapterConfig = {}): LlmAdapter {
  const key = normaliseProviderName(provider);
  const factory = LLM_ADAPTERS[key];
  if (typeof factory !== "function") {
    throw new TypeError(
      `createLlmAdapter: unknown provider ${JSON.stringify(provider)}; ` +
        `known providers: ${Object.keys(LLM_ADAPTERS).sort().join(", ")}`,
    );
  }
  return factory(config);
}

// ── internals ────────────────────────────────────────────────────────────────

type HttpOutcome =
  { ok: true; status: number; body: unknown } | { ok: false; status: number; error: string };

/** POST a JSON body and normalise every outcome into one shape. */
function postJson(
  url: string,
  args: {
    headers: Record<string, string>;
    body: unknown;
    timeoutMs: number;
    fetchImpl: typeof fetch;
  },
): Promise<HttpOutcome> {
  return sendRequest(url, {
    headers: args.headers,
    body: JSON.stringify(args.body),
    timeoutMs: args.timeoutMs,
    fetchImpl: args.fetchImpl,
  });
}

/**
 * The single place an HTTP request leaves this module.
 *
 * A transport failure becomes `status: 0` rather than a thrown exception so the
 * caller has ONE failure shape to reason about, and so "the network was down"
 * is distinguishable from "the provider said 400". The body is parsed
 * defensively: a non-JSON error page is still an error, not a parse crash.
 */
async function sendRequest(
  url: string,
  init: {
    headers: Record<string, string>;
    body: string;
    timeoutMs: number;
    fetchImpl: typeof fetch;
  },
): Promise<HttpOutcome> {
  let res: Response;
  try {
    res = await init.fetchImpl(url, {
      method: "POST",
      headers: init.headers,
      body: init.body,
      signal: AbortSignal.timeout(init.timeoutMs),
    });
  } catch (err) {
    return { ok: false, status: 0, error: `network error: ${errorMessage(err)}` };
  }

  const text = await res.text().catch(() => "");
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: providerErrorMessage(body) ?? `HTTP ${res.status}`,
    };
  }
  return { ok: true, status: res.status, body };
}

/**
 * Pull the completion text out of a chat-completions reply.
 *
 * Handles the string case and the array-of-parts case some OpenAI-compatible
 * gateways emit. Returns `null` for an absent, empty or unrecognised payload so
 * the caller reports "no completion text" rather than returning `""`, which a
 * caller would have to treat as a valid empty answer.
 */
function extractChatCompletionText(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  const content = first?.message?.content;
  if (typeof content === "string") return normaliseCompletion(content);
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const text = (part as { text?: unknown }).text;
          if (typeof text === "string") return text;
        }
        return "";
      })
      .join("");
    return normaliseCompletion(joined);
  }
  return null;
}

/** Pull the completion text out of an Anthropic Messages reply. */
function extractAnthropicText(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const content = (body as { content?: unknown }).content;
  if (typeof content === "string") return normaliseCompletion(content);
  if (!Array.isArray(content)) return null;
  const joined = content
    .map((block) => {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") return text;
      }
      return "";
    })
    .join("");
  return normaliseCompletion(joined);
}

/** Trim a completion; an all-whitespace reply is "no completion", not "". */
function normaliseCompletion(text: string): string | null {
  const trimmed = text.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Extract token usage from an OpenAI chat-completions response, or null. */
function extractOpenAiUsage(body: unknown): LlmCompletion["usage"] {
  if (!body || typeof body !== "object") return undefined;
  const usage = (body as { usage?: Record<string, unknown> }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
  const completion =
    typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined;
  const total = typeof usage.total_tokens === "number" ? usage.total_tokens : undefined;
  if (prompt === undefined && completion === undefined && total === undefined) return undefined;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

/** Extract token usage from an Anthropic Messages response, or null. */
function extractAnthropicUsage(body: unknown): LlmCompletion["usage"] {
  if (!body || typeof body !== "object") return undefined;
  const usage = (body as { usage?: Record<string, unknown> }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  const output = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
  if (input === undefined && output === undefined) return undefined;
  // Anthropic reports input/output; OpenAI reports prompt/completion/total.
  // Normalise to the OpenAI shape so callers have one vocabulary.
  return {
    promptTokens: input,
    completionTokens: output,
    totalTokens: input !== undefined && output !== undefined ? input + output : undefined,
  };
}

/** A non-2xx body's human message, bounded, or `null` when it carries none. */
function providerErrorMessage(body: unknown): string | null {
  if (typeof body === "string") return body.slice(0, 300) || null;
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const err = record.error;
  if (typeof err === "string") return err.slice(0, 300);
  if (err && typeof err === "object") {
    const message = (err as Record<string, unknown>).message;
    if (typeof message === "string") return message.slice(0, 300);
  }
  if (typeof record.message === "string") return record.message.slice(0, 300);
  return null;
}

function assertPrompt(prompt: string): string {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new TypeError("LlmAdapter.complete: prompt must be a non-empty string");
  }
  return prompt;
}

function normaliseProviderName(provider: string): string {
  return typeof provider === "string" ? provider.trim().toLowerCase() : "";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A positive integer from an env string, or the fallback. */
function readPositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

/** A temperature in [0, 1] from an env string, or the fallback. */
function readTemperature(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}
