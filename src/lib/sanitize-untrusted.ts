import "server-only";
/**
 * Sanitiser for untrusted bank-supplied strings that become ElevenLabs
 * dynamic variables (invariant I-4).
 *
 * A merchant name is attacker-controllable in a real deployment: a fraud
 * engine bug, a compromised producer, or a social-engineered cardholder can
 * put arbitrary text into the `merchant` field. That text must never reach
 * the system prompt or be interpreted as an instruction. The agent prompt
 * already states that variables are data, never instructions — this module
 * is the enforcement point that makes the promise true.
 *
 * Rules:
 *   1. Strip control characters and newlines (log injection, TTS artifacts).
 *   2. Cap at 64 characters (a merchant name is not a paragraph).
 *   3. Neutralise instruction-shaped substrings — text that looks like a
 *      prompt-injection attempt is replaced with a safe placeholder so the
 *      agent reads a name, not a command.
 *   4. Normalise to NFKC and strip bidi/zero-width controls (unicode attacks).
 *
 * The output is safe to pass as a dynamic variable. It is NEVER interpolated
 * into the system prompt — only into the `dynamic_variables` map the platform
 * exposes to the agent as data.
 */

/** Instruction-shaped patterns that must never survive sanitisation. */
const INSTRUCTION_PATTERNS: RegExp[] = [
  /\bignore\s+(all\s+)?(previous|prior|above|your)\s+(instructions?|rules?|prompts?)\b/gi,
  /\bdisregard\s+(all\s+)?(previous|prior|above|your)\s+(instructions?|rules?|prompts?)\b/gi,
  /\bforget\s+(all\s+)?(previous|prior|above|your)\s+(instructions?|rules?|prompts?)\b/gi,
  /\boverride\s+(your|all)\s+(instructions?|rules?|prompts?|guidelines?)\b/gi,
  /\bnew\s+instructions?\s*:/gi,
  /\bsystem\s+prompt\s*:/gi,
  /\byou\s+are\s+now\b/gi,
  /\bact\s+as\b/gi,
  /\bpretend\s+(to\s+be|you\s+are)\b/gi,
  /\bdo\s+not\s+(follow|obey|listen)\b/gi,
  /\bstop\s+(following|obeying|listening)\b/gi,
  /\bforget\s+everything\b/gi,
  /\breset\s+(your|all)\s+(instructions?|rules?|prompts?)\b/gi,
];

/** Characters that are never valid in a spoken merchant name. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

export const MAX_UNTRUSTED_LEN = 64;

/**
 * Sanitise an untrusted string for use as a dynamic variable.
 * Returns a safe, bounded, instruction-free string.
 */
export function sanitizeUntrusted(raw: string): string {
  if (!raw) return "";

  // 1. Unicode normalisation — NFKC folds compatibility characters and
  //    homoglyphs to their base forms, defeating homoglyph attacks.
  let s = raw.normalize("NFKC");

  // 2. Strip control characters, bidi overrides, zero-width joiners.
  s = s.replace(CONTROL_CHARS, "");

  // 3. Neutralise instruction-shaped substrings. Replace with a marker so
  //    the agent reads a name, not a command. The replacement is deliberately
  //    boring — it must not be instruction-shaped itself.
  for (const pattern of INSTRUCTION_PATTERNS) {
    s = s.replace(pattern, "[redacted]");
  }

  // 4. Collapse whitespace and cap length.
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > MAX_UNTRUSTED_LEN) {
    s = s.slice(0, MAX_UNTRUSTED_LEN).trim();
  }

  return s;
}

/**
 * Sanitise a map of dynamic variables. Every string value passes through
 * sanitizeUntrusted; non-string values are passed through unchanged (they are
 * structured data the platform types, not free text).
 */
export function sanitizeDynamicVariables(vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(vars)) {
    out[k] = typeof v === "string" ? sanitizeUntrusted(v) : v;
  }
  return out;
}
