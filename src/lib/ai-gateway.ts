export type AIProvider = "groq" | "lite_llm" | "fallback";

export interface AIResponse {
  text: string;
  provider: AIProvider;
  cached: boolean;
}

/**
 * AI Gateway — outbound AI failover and caching surface.
 *
 * Default path is Groq first, then LiteLLM-compatible endpoints, then the
 * hardcoded fallback. This module intentionally avoids importing provider
 * SDKs directly; callers should wire their own fetch-based provider client
 * here so the runtime does not pull in OpenAI by default.
 */

export async function callAIGateway(_prompt: string, _userText: string): Promise<AIResponse> {
  // The current production LLM path is src/lib/llm.ts, which already prefers
  // Groq and falls back to scripted replies when no key is configured. This
  // gateway remains provider-agnostic and fail-closed until the team decides
  // to add a second provider client.
  return {
    text: "I am having trouble processing this. Transferring you to a human agent.",
    provider: "fallback",
    cached: false,
  };
}
