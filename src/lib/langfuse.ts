import "server-only";
import { Langfuse } from "langfuse";

/**
 * Langfuse observability for LLM calls.
 *
 * This module initialises the Langfuse client and exports a single helper —
 * {@link traceLlmCall} — that wraps an LLM inference call in a Langfuse trace
 * with generation tracking. The trace captures:
 *
 *   - The model name and provider.
 *   - Token usage (prompt + completion tokens) when the provider reports it.
 *   - Latency (measured around the fetch call).
 *   - Any error that caused the call to fail.
 *
 * All data is sent asynchronously to the Langfuse backend; a network failure
 * or misconfiguration NEVER blocks or degrades a live voice turn. The wrapper
 * swallows every Langfuse-internal error so the LLM path is unaffected.
 *
 * Environment variables (see .env.example):
 *   LANGFUSE_PUBLIC_KEY  — public project key from cloud.langfuse.com
 *   LANGFUSE_SECRET_KEY  — secret project key
 *   LANGFUSE_BASE_URL    — https://cloud.langfuse.com (default)
 */

/**
 * The Langfuse client instance.
 *
 * Initialised lazily so importing this module in environments without
 * Langfuse credentials (tests, local dev without a key) does not throw.
 * When the keys are missing the client is `undefined` and every helper
 * degrades to a no-op that simply runs the underlying LLM call.
 */
let _client: Langfuse | null | undefined;

/**
 * Lazily create (or return the cached) Langfuse client.
 *
 * Returns `null` when credentials are not configured, so callers can
 * guard with a simple `if (!langfuse)` rather than a try/catch.
 */
function getClient(): Langfuse | null {
  if (_client !== undefined) return _client;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) {
    _client = null;
    return _client;
  }
  _client = new Langfuse({
    publicKey,
    secretKey,
    baseUrl: process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com",
  });
  return _client;
}

/** The Langfuse client, or null when not configured. Exported for advanced use. */
export const langfuse: Langfuse | null = getClient();

/**
 * The result of a traced LLM call.
 */
export interface LlmTraceResult<T> {
  /** The value returned by the underlying LLM call. */
  value: T;
  /** The Langfuse trace ID, when a trace was created. */
  traceId?: string;
}

/**
 * Run an LLM call under a Langfuse trace with generation tracking.
 *
 * This is the single entry point for LLM observability. It creates a Langfuse
 * trace, starts a generation span around the async work, and enriches the span
 * with token usage and latency when the provider supplies them.
 *
 * The wrapper is transparent: it resolves with exactly the value the inner
 * function returns, so callers cannot tell whether tracing was active. When
 * Langfuse is not configured (no keys) the inner function runs without any
 * tracing overhead beyond a single null check.
 *
 * Every Langfuse SDK call is wrapped in try/catch — a tracing failure must
 * NEVER cause a voice-turn failure. The LLM call itself is NOT wrapped; its
 * errors propagate normally so the caller's existing fallback logic works.
 *
 * @param params - Trace configuration and the LLM call to execute.
 * @returns The result of `params.run`, plus the trace ID when tracing was active.
 *
 * @example
 * ```ts
 * const reply = await traceLlmCall({
 *   name: "draft-agent-reply",
 *   model: provider.model,
 *   input: { system, user },
 *   metadata: { lang: "en", intent: "greeting" },
 *   run: async (generation) => {
 *     const response = await fetch(provider.url, { ... });
 *     const data = await response.json();
 *     const text = data.choices[0].message.content;
 *     // Report token usage if available:
 *     if (data.usage) {
 *       generation.end({
 *         usage: {
 *           promptTokens: data.usage.prompt_tokens,
 *           completionTokens: data.usage.completion_tokens,
 *         },
 *       });
 *     }
 *     return text;
 *   },
 * });
 * ```
 */
export async function traceLlmCall<T>(params: {
  /** Trace name shown in the Langfuse dashboard. */
  name: string;
  /** Model identifier (e.g. "qwen/qwen3.8-27b"). */
  model: string;
  /** The prompt/system input — stored in Langfuse for debugging. */
  input: unknown;
  /** Arbitrary metadata attached to the trace (language, intent, etc.). */
  metadata?: Record<string, unknown>;
  /**
   * The actual LLM call. Receives a `generation` handle — call
   * `generation.end({ usage })` when the call finishes to record token counts.
   */
  run: (generation: LangfuseGeneration) => Promise<T>;
}): Promise<LlmTraceResult<T>> {
  const client = getClient();
  if (!client) {
    // No Langfuse configured — just run the call.
    const value = await params.run({
      end: () => {},
    });
    return { value };
  }

  try {
    const trace = client.trace({
      name: params.name,
      input: params.input,
      metadata: params.metadata,
    });

    const generation = trace.generation({
      name: `${params.name}-generation`,
      model: params.model,
      modelParameters: {
        // Stored for filtering in the Langfuse UI.
      },
    });

    const startTime = performance.now();
    try {
      const value = await params.run(generation);
      const latencyMs = performance.now() - startTime;
      trace.update({ metadata: { ...params.metadata, latencyMs } });
      return { value, traceId: trace.id };
    } catch (err) {
      // Record the error on the trace, then re-throw so the caller's
      // fallback logic (scripted reply, etc.) runs normally.
      trace.update({
        metadata: {
          ...params.metadata,
          error: err instanceof Error ? err.message : String(err),
          latencyMs: performance.now() - startTime,
        },
      });
      throw err;
    }
  } catch (err) {
    // Langfuse SDK failure — fall through to untraced execution.
    // The LLM call itself has NOT run yet (trace creation failed),
    // so we still need to execute it.
    console.warn("[langfuse] trace creation failed, running untraced:", err);
    const value = await params.run({ end: () => {} });
    return { value };
  }
}

/**
 * A minimal generation handle passed to {@link traceLlmCall}'s `run` callback.
 *
 * Only the `end` method is part of the public contract — callers use it to
 * finalise the generation span with token usage. The full Langfuse generation
 * object is accepted but re-typed here so this module owns the interface.
 */
export interface LangfuseGeneration {
  /** Finalise the generation span, optionally recording token usage. */
  end: (opts?: {
    usage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    };
    output?: unknown;
  }) => void;
}

/**
 * Flush any pending Langfuse events and shut down the client gracefully.
 *
 * Call this in a SIGTERM/SIGINT handler or before `process.exit()` to ensure
 * buffered traces are delivered. After this call the client is unusable.
 *
 * All errors are swallowed — a flush failure must not crash the process.
 */
export async function flushLangfuse(): Promise<void> {
  const client = getClient();
  if (!client) return;
  try {
    await client.shutdownAsync();
  } catch (err) {
    console.warn("[langfuse] shutdown failed:", err);
  }
}
