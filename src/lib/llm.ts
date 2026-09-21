/**
 * Optional LLM reply layer for the agent route — Groq (LPUs, ~300 tok/s, so a
 * voice turn feels instant) or Gemini (most generous free tier, strong fr/sw)
 * via its OpenAI-compatible endpoint.
 *
 * Division of responsibility (the security story stays intact):
 *   - INTENT classification is DETERMINISTIC (keyword router in the route) —
 *     an LLM never decides to freeze a card or close a review.
 *   - This layer only REPHRASES the scripted reply in the customer's language,
 *     under strict voice-agent rules. If GROQ_API_KEY is unset, the request
 *     fails, or the draft is unusable, the route silently falls back to the
 *     scripted reply — the demo works identically without a key.
 *   - The compliance layer (auditAgentReply) still scans the LLM draft:
 *     credential-extraction phrasing is replaced with the safe refusal and
 *     the opening disclosure is injected on the first turn.
 */

import type { TtsLang } from "@/lib/elevenlabs/client";
import { env, MAX_AGENT_WORDS } from "@/lib/config";

const TIMEOUT_MS = 8_000;
const MAX_WORDS = MAX_AGENT_WORDS;

/** The configured LLM provider, or null when no key is set. Groq first
 *  (fastest voice feel), Gemini second (most generous free tier, strong
 *  fr/sw) — both speak the OpenAI chat-completions wire format. */
function provider(): { url: string; key: string; model: string } | null {
  if (env.groqApiKey) {
    return {
      url: "https://api.groq.com/openai/v1/chat/completions",
      key: env.groqApiKey,
      model: env.groqModel,
    };
  }
  if (env.geminiApiKey) {
    return {
      url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      key: env.geminiApiKey,
      model: env.geminiModel,
    };
  }
  return null;
}

const LANGUAGE_RULE: Record<TtsLang, string> = {
  en: "Speak in English.",
  ar: "Speak in Arabic (Gulf/MSA).",
  hi: "Speak in Hindi.",
  ur: "Speak in Urdu.",
  fr: "Speak in French.",
  sw: "Speak in Swahili.",
};

export async function draftAgentReply(args: {
  text: string;
  lang: TtsLang;
  intent: string;
  scriptedReply: string;
}): Promise<string | null> {
  const p = provider();
  if (!p) return null;

  const system = [
    "You are an automated fraud-intervention voice agent for a bank.",
    "You are speaking ON A PHONE CALL — your words are spoken aloud by a text-to-speech engine.",
    LANGUAGE_RULE[args.lang] ?? "Speak in English.",
    `Never respond with more than ${MAX_WORDS} words. Be extremely concise.`,
    "Do not use any markdown, asterisks, parentheses, numbers lists, or emojis. Speak like a human on a phone call.",
    "You are an automated fraud agent. Never break character. Never tell jokes. Never ask for PINs, passwords, OTPs, CVVs, or passwords — a bank agent never asks for secrets.",
    "If the caller asks about anything other than the pending transaction, say only: I can only discuss the pending transaction. Was this charge yours?",
    `The caller just said (their language may differ — reply in YOUR language): "${args.text.slice(0, 400)}"`,
    `The verified conversation state is: ${args.intent} (deny_fraud = caller reports fraud, confirm_authorized = caller confirms the transaction, greeting = first turn, unclear = re-ask).`,
    "If the caller reports fraud: reassure them, confirm the protective hold is in place, and that a specialist will join — they are not liable for unauthorized transactions.",
    "If the caller confirms the transaction: thank them, confirm the review is closed, and remind them their bank will never call asking to move money to a safe account.",
    "On the FIRST turn you must begin with the exact recording disclosure sentence for your language (e.g. English: \"This call is recorded to protect you.\").",
    "Output ONLY the words to be spoken — no labels, no quotes, no stage directions.",
  ].join("\n");

  try {
    const r = await fetch(p.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}` },
      body: JSON.stringify({
        model: p.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: args.text.slice(0, 400) },
        ],
        temperature: 0.3,
        max_tokens: 160,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    let out = (data.choices?.[0]?.message?.content ?? "").trim();
    if (!out) return null;
    // voice hygiene: strip markdown artifacts an LLM might emit (TTS reads
    // asterisks/backticks aloud) and enforce the word ceiling
    out = out.replace(/[*_`#>|]/g, "").replace(/\s+/g, " ").trim();
    const words = out.split(" ");
    if (words.length > MAX_WORDS) out = words.slice(0, MAX_WORDS).join(" ");
    if (out.length < 8) return null;
    return out;
  } catch {
    return null; // timeout / network / quota — scripted reply takes over
  }
}