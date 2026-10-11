import "server-only";
import { z } from "zod";

/**
 * Runtime zod validation for LLM completion responses.
 *
 * The voice agent's output is spoken aloud to a bank customer. Before it reaches
 * the TTS engine it passes through several guards (vishing blocklist, injection
 * detection, word ceiling), but those operate on the extracted string AFTER the
 * provider response has been parsed. If the provider returns a malformed payload
 * — a missing `choices` array, a `message` object with no `content`, or content
 * that is not a string — the extraction code either crashes or returns `undefined`,
 * which then flows through as an empty string that TTS reads as silence.
 *
 * Silence on a fraud call is the worst outcome: the customer hears nothing and
 * assumes the line dropped, which is indistinguishable from a scammer hanging up.
 * A schema validates the raw provider response BEFORE extraction, so a malformed
 * payload is caught at the boundary rather than deep in the pipeline where its
 * only symptom is a missing word.
 *
 * Two schemas are exported because the two provider families have different wire
 * formats: OpenAI/Groq/Gemini speak chat-completions (`choices[0].message.content`),
 * while Anthropic speaks the Messages API (`content[].text`). A union would force
 * the caller to discriminate; separate schemas let each adapter validate against
 * its own shape.
 */

// ── OpenAI chat-completions response ─────────────────────────────────────────

/**
 * The shape OpenAI, Groq, and Gemini all return from `POST /chat/completions`.
 *
 * `content` is `unknown` (not `string`) because a provider may return `null` for
 * a refusal, an array of content parts for a multimodal model, or a plain string
 * for a text model. The schema accepts all three and the extraction function
 * decides what to do with each — but it REQUIRES the field to be present, which
 * is the actual safety property: a response with no `content` at all is a
 * malformed payload, not an empty completion.
 */
export const openAiCompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.unknown(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
    })
    .optional(),
});

export type OpenAiCompletionResponse = z.infer<typeof openAiCompletionSchema>;

// ── Anthropic Messages response ──────────────────────────────────────────────

/**
 * The shape Anthropic returns from `POST /v1/messages`.
 *
 * `content` is an array of typed blocks. A `text` block carries the completion;
 * a `tool_use` block carries a function call (which the voice agent never makes,
 * but the schema must not reject it — the extraction layer decides).
 */
export const anthropicCompletionSchema = z.object({
  content: z
    .array(
      z.object({
        type: z.string(),
        text: z.unknown().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
});

export type AnthropicCompletionResponse = z.infer<typeof anthropicCompletionSchema>;

// ── Extracted completion ─────────────────────────────────────────────────────

/**
 * The minimum a completion must satisfy to be worth speaking.
 *
 * `min(1)` after `.trim()` is the real check: a provider that returns only
 * whitespace, or a completion that becomes empty after the voice-hygiene
 * markdown strip, produces a string that TTS reads as silence. Catching it here
 * means the caller falls back to the scripted reply — which is always spoken,
 * always safe, and always audible — rather than synthesising nothing.
 */
export const spokenCompletionSchema = z.string().trim().min(1);

export type SpokenCompletion = z.infer<typeof spokenCompletionSchema>;

/**
 * Extract the completion text from a validated OpenAI chat-completions response.
 *
 * Handles the three shapes `content` can take:
 *   - `string` — the normal case.
 *   - `Array<{text: string}>` — some OpenAI-compatible gateways emit content
 *     parts instead of a single string.
 *   - `null` / `undefined` — a refusal or a malformed response.
 *
 * Returns `null` for anything unrecognised, so the caller can fall back rather
 * than crash.
 */
export function extractOpenAiCompletion(response: OpenAiCompletionResponse): string | null {
  const content = response.choices[0]?.message?.content;
  if (typeof content === "string") return content.trim() || null;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const t = (part as { text?: unknown }).text;
          if (typeof t === "string") return t;
        }
        return "";
      })
      .join("")
      .trim();
    return text || null;
  }
  return null;
}

/**
 * Extract the completion text from a validated Anthropic Messages response.
 *
 * Concatenates every `text` block. A response with no text blocks (e.g. a
 * tool-use-only turn) returns `null`.
 */
export function extractAnthropicCompletion(response: AnthropicCompletionResponse): string | null {
  const blocks = response.content;
  const text = blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("")
    .trim();
  return text || null;
}

/**
 * Validate a raw provider response against a schema and extract the completion.
 *
 * This is the single entry point llm.ts uses. It validates first, extracts
 * second, and validates the extraction third — three checks, each catching a
 * different failure mode:
 *
 *   1. The raw response is well-formed (schema).
 *   2. The completion is extractable (extraction function).
 *   3. The completion is speakable (min length after trim).
 *
 * Returns `null` at any failure, which llm.ts treats as "no reply, use the
 * scripted fallback".
 */
export function validateAndExtract(
  schema: typeof openAiCompletionSchema | typeof anthropicCompletionSchema,
  raw: unknown,
  extractor: (validated: never) => string | null,
): string | null {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return null;
  const text = extractor(parsed.data as never);
  if (text === null) return null;
  const spoken = spokenCompletionSchema.safeParse(text);
  return spoken.success ? spoken.data : null;
}
