/**
 * Qwen3Guard-Gen — the classification contract, as a PURE module.
 *
 * Qwen3Guard-Gen (QwenLM/Qwen3Guard) is served over the OpenAI-compatible chat
 * API with its safety instructions baked into the model's own chat template.
 * The caller does NOT embed a moderation system prompt: the official usage sends
 * the content as ordinary messages and the served template does the rest.
 *
 *   - Prompt moderation  →  one `user` message.
 *   - Response moderation →  `[user, assistant]` (the assistant turn is the
 *     content being judged).
 *
 * The model answers in a fixed, structured format, and this module owns BOTH
 * halves of that contract:
 *
 *   1. `buildModerationMessages` — how each SecureVoiceAI stage maps onto
 *      official messages, with a version tag (`TEMPLATE_VERSION`) so a cached
 *      verdict can never outlive the mapping that produced it.
 *   2. `parseVerdict` — the strict reader for the output. The output format is
 *      part of the safety property: anything this parser cannot read with
 *      total confidence is `invalid`, never "Safe". A malformed verdict that
 *      degraded to Safe would be a moderation bypass with a nicer name.
 *
 * Live-captured output shapes (Qwen3Guard-Gen-8B @ OVH Kepler, 2026-11-07):
 *   "Safety: Unsafe\nCategories: Violent"
 *   "Safety: Safe\nCategories: None"
 *   "Safety: Safe\nCategories: None\nRefusal: Yes"     (response moderation)
 *
 * This module is deliberately free of `server-only`, `db` and `fetch` so that
 * the parser — the piece whose correctness is a security property — can be
 * exercised by the fastest possible unit tests without a server environment.
 */

/** The content boundaries Qwen3Guard is consulted at. */
export const MODERATION_STAGES = ["input", "output", "speech", "tool", "ingest"] as const;
export type ModerationStage = (typeof MODERATION_STAGES)[number];

/**
 * Version of THIS module's prompt mapping. Bump when the message construction
 * changes; the cache key and every persisted row carry it, so an upgrade
 * invalidates cached verdicts instead of silently mixing semantics.
 */
export const TEMPLATE_VERSION = "qwen3guard-gen-1";

/** The model this deployment pins. Changed only through config + a re-benchmark. */
export const DEFAULT_MODERATION_MODEL = "Qwen3Guard-Gen-8B";

/**
 * The verdicts the model can express. `Controversial` is Qwen3Guard's own third
 * label (its README regex is `Safety: (Safe|Unsafe|Controversial)`); policy
 * treats it conservatively — see `moderate.ts`.
 */
export const SAFETY_VERDICTS = ["safe", "unsafe", "controversial", "invalid"] as const;
export type SafetyVerdict = (typeof SAFETY_VERDICTS)[number];

/**
 * The official category list, verbatim from the Qwen3Guard release. The parser
 * only accepts categories from this list: an unknown category means the output
 * is not something we can interpret, and the verdict must be `invalid`.
 * ("Jailbreak" is prompt-side only; "None" accompanies a Safe verdict.)
 */
export const QWEN3GUARD_CATEGORIES = [
  "Violent",
  "Non-violent Illegal Acts",
  "Sexual Content or Sexual Acts",
  "PII",
  "Suicide & Self-Harm",
  "Unethical Acts",
  "Politically Sensitive Topics",
  "Copyright Violation",
  "Jailbreak",
  "None",
] as const;
export type Qwen3GuardCategory = (typeof QWEN3GUARD_CATEGORIES)[number];

const CATEGORY_INDEX: ReadonlySet<string> = new Set(QWEN3GUARD_CATEGORIES);

/** Hard cap on content sent for classification. A voice turn is short by rule;
 *  the cap exists for the ingest/HTTP stages where arbitrary text arrives. */
export const MAX_MODERATION_CHARS = 6_000;

export type ModerationVerdict = {
  verdict: SafetyVerdict;
  /** Categories exactly as the model named them (empty for Safe). */
  categories: Qwen3GuardCategory[];
  /** Response moderation only: the model says the reply was itself a refusal. */
  refusal: boolean;
};

const SAFETY_RE = /^\s*Safety:\s*(Safe|Unsafe|Controversial)\s*$/im;
const CATEGORIES_RE = /^\s*Categories:\s*(.+?)\s*$/im;
const REFUSAL_RE = /^\s*Refusal:\s*(Yes|No)\s*$/im;

/**
 * Read a Qwen3Guard completion into a verdict.
 *
 * Rules, in order of how much they matter:
 *   - No parseable `Safety:` line → `invalid`. Truncated, empty or chatty
 *     output is unreadable, and unreadable is never Safe.
 *   - Categories must all be from the official list. An unknown category is
 *     NOT dropped (that would launders an unknown risk into a known one) —
 *     the whole verdict becomes `invalid`.
 *   - `Safe` with a non-None category is contradictory output → `invalid`.
 *   - `Unsafe`/`Controversial` with `Categories: None` is also contradictory.
 *   - A `Refusal:` line is accepted only on the Yes/No values; anything else
 *     leaves refusal false and lets the Safety line stand (refusal is
 *     informational; Safety is the control).
 */
export function parseVerdict(raw: string): ModerationVerdict {
  if (!raw) return { verdict: "invalid", categories: [], refusal: false };

  const safety = SAFETY_RE.exec(raw);
  if (!safety) return { verdict: "invalid", categories: [], refusal: false };

  const verdictMap: Record<string, SafetyVerdict> = {
    Safe: "safe",
    Unsafe: "unsafe",
    Controversial: "controversial",
  };
  const verdict = verdictMap[safety[1] as string];

  const categoriesLine = CATEGORIES_RE.exec(raw);
  if (!categoriesLine) return { verdict: "invalid", categories: [], refusal: false };
  const named = categoriesLine[1]!
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  if (named.length === 0) return { verdict: "invalid", categories: [], refusal: false };

  const categories: Qwen3GuardCategory[] = [];
  for (const name of named) {
    if (!CATEGORY_INDEX.has(name)) {
      return { verdict: "invalid", categories: [], refusal: false };
    }
    categories.push(name as Qwen3GuardCategory);
  }

  // Contradiction checks — the model talking nonsense must not become a pass.
  const hasNone = categories.length === 1 && categories[0] === "None";
  if (verdict === "safe" && !hasNone) return { verdict: "invalid", categories: [], refusal: false };
  if (verdict !== "safe" && hasNone) return { verdict: "invalid", categories: [], refusal: false };

  let refusal = false;
  const refusalLine = REFUSAL_RE.exec(raw);
  if (refusalLine) refusal = refusalLine[1] === "Yes";

  return { verdict, categories, refusal };
}

/** Messages shape used by the OpenAI-compatible endpoint. */
export type ModerationMessage = { role: "user" | "assistant"; content: string };

/**
 * Build the official message shape for a stage.
 *
 * `input`/`speech`/`tool`/`ingest` are PROMPT moderation (one user message —
 * what a caller said, what a tool would do, what a transcript contains).
 * `output` is RESPONSE moderation: the draft reply rides in the assistant
 * turn, and the caller's utterance (when known) rides in the user turn, which
 * is exactly the shape the official response-moderation example uses and lets
 * the model judge the reply in its conversational context.
 *
 * Content is truncated to `MAX_MODERATION_CHARS` on the right: classification
 * of the first N chars is the documented degradation, and an unbounded payload
 * would let one huge ingest body pin the provider's 32k context.
 */
export function buildModerationMessages(
  stage: ModerationStage,
  text: string,
  opts: { userText?: string } = {},
): ModerationMessage[] {
  const content = text.length > MAX_MODERATION_CHARS ? text.slice(0, MAX_MODERATION_CHARS) : text;
  if (stage === "output") {
    const msgs: ModerationMessage[] = [];
    if (opts.userText) {
      const u =
        opts.userText.length > MAX_MODERATION_CHARS
          ? opts.userText.slice(0, MAX_MODERATION_CHARS)
          : opts.userText;
      msgs.push({ role: "user", content: u });
    }
    msgs.push({ role: "assistant", content });
    return msgs;
  }
  return [{ role: "user", content }];
}

/**
 * Stage description for audit rows and operator surfaces — stable strings, not
 * prose that drifts.
 */
export function describeStage(stage: ModerationStage): string {
  switch (stage) {
    case "input":
      return "caller/user prompt or transcript before reasoning";
    case "output":
      return "assistant draft before persistence or speech";
    case "speech":
      return "final spoken text before synthesis";
    case "tool":
      return "tool invocation arguments before execution";
    case "ingest":
      return "post-call transcript before indexing";
  }
}
