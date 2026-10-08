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
 * Financial account identifiers — the exact category ElevenLabs' ElevenAgents
 * Terms §2.E names as Prohibited Data: "any financial account identifiers
 * (e.g., credit card numbers or bank account numbers) ... unless ElevenLabs has
 * expressly agreed in writing".
 *
 * Deliberately NARROWER than `redact.transcript`. That function also strips
 * phone and email shapes, and applying it here would mangle a bank's own
 * `transaction_ref`, breaking the correlation key the bank needs to reconcile
 * the call. The policy prohibits ACCOUNT IDENTIFIERS, so only those are masked.
 *
 * "13 to 19 digits" alone is NOT enough, and the first version of this guard got
 * it wrong: `TXN-1791325826155-3` carries a 13-digit millisecond epoch, so every
 * reference minted in the same millisecond collapsed to the same masked string
 * and a bank's distinct transactions began failing as duplicates. Two things
 * make a digit run a card number rather than a timestamp — it satisfies Luhn,
 * and it stands alone instead of sitting between separators inside a longer
 * identifier. Both are required here.
 */
const UAE_IBAN_RE = /\bAE\d{21}\b/gi;
const DIGIT_RUN_RE = /(?:\d[ -]?){12,18}\d/g;

/** Luhn checksum over a digits-only string. */
function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * The PAN-shaped substrings in `text`, in order. Exported so the rule "a
 * standalone Luhn-valid 13-19 digit run is a card number, and a timestamp
 * embedded in an identifier is not" is testable directly rather than only
 * through the mask.
 */
export function findAccountIdentifiers(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(DIGIT_RUN_RE)) {
    const raw = match[0];
    const digits = raw.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    if (!luhnValid(digits)) continue;

    const at = match.index ?? 0;
    const before = text.slice(0, at);
    const after = text.slice(at + raw.length);
    // Standalone only: a run touching a separator or digit on either side is a
    // fragment of something else, not a number the agent must never hear.
    if (/[-\d]$/.test(before) || /^[-\d]/.test(after)) continue;

    found.push(raw);
  }
  return found;
}

/** True when a value carries something the vendor contract forbids. */
export function containsAccountIdentifier(value: string): boolean {
  if (findAccountIdentifiers(value).length > 0) return true;
  UAE_IBAN_RE.lastIndex = 0;
  return UAE_IBAN_RE.test(value);
}

/**
 * Replace account identifiers with a tagged placeholder. The agent still learns
 * "a masked card reference is involved" — it never learns the number.
 */
export function maskAccountIdentifiers(value: string): { value: string; masked: number } {
  let out = value;
  let masked = 0;

  for (const raw of findAccountIdentifiers(out)) {
    const at = out.indexOf(raw);
    if (at === -1) continue;
    out = out.slice(0, at) + "[REDACTED:account_identifier]" + out.slice(at + raw.length);
    masked++;
  }

  const ibans = out.match(UAE_IBAN_RE) ?? [];
  if (ibans.length) {
    masked += ibans.length;
    out = out.replace(UAE_IBAN_RE, "[REDACTED:account_identifier]");
  }

  return { value: out, masked };
}

/**
 * Sanitise an untrusted string for use as a dynamic variable.
 * Returns a safe, bounded, instruction-free string.
 */
export function sanitizeUntrusted(raw: string): string {
  if (!raw) return "";

  // 0. Mask account identifiers BEFORE anything else. The length cap in step 4
  //    would otherwise truncate a long merchant string mid-digits and leave a
  //    partial run that no longer matches the identifier pattern — so the tail
  //    of a PAN would survive into the vendor's model context.
  let s = maskAccountIdentifiers(raw).value;

  // 1. Unicode normalisation — NFKC folds compatibility characters and
  //    homoglyphs to their base forms, defeating homoglyph attacks.
  s = s.normalize("NFKC");

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
