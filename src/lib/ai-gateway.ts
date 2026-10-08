import OpenAI from "openai";

const openai = new OpenAI();

export type AIProvider = "openai" | "groq" | "fallback";

export interface AIResponse {
  text: string;
  provider: AIProvider;
  cached: boolean;
}

export async function callAIGateway(prompt: string, userText: string): Promise<AIResponse> {
  // Semantic caching would be implemented against a shared Redis cache here.
  // The current deployment does not require a second provider client, so
  // this gateway remains provider-agnostic and fail-closed.
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: userText },
    ],
    temperature: 0,
    max_tokens: 120,
  });

  const text = response.choices[0]?.message?.content ?? "";
  if (!text) {
    return {
      text: "I am having trouble processing this. Transferring you to a human agent.",
      provider: "fallback",
      cached: false,
    };
  }

  return { text, provider: "openai", cached: false };
}
