/**
 * PII redaction for any text that leaves the request handler (logged, written
 * to audit log, persisted to DB, signed into a webhook payload).
 *
 * Card PAN, IBAN, phone numbers, emails, OTPs, and long digit sequences are
 * replaced with stable short codes so conversation-level analytics stay useful
 * without ever storing the raw secret. The mapping is intentionally lossy — we
 * do NOT round-trip; redacted values cannot be unredacted server-side.
 *
 * Use:
 *   redact.transcript(input)        // full transcript text
 *   redact.snippet(value, kind)     // known-kind value (e.g. card PAN)
 */

const REDACTED = "[REDACTED]";

// 13–19 digit card/PAN strings (Luhn not enforced — redaction is best-effort)
const PAN_RE = /\b(?:\d[ -]?){13,19}\b/g;
// UAE IBAN: AE + 2 check digits + 21 digits
const IBAN_RE = /\bAE\d{21}\b/gi;
// Email — conservative; avoids matching inside larger identifiers
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// Phone numbers — E.164 or a UAE/Ugandan local number.
//
// WHY THIS IS NOT ONE LOOSE PATTERN. The previous expression ended in
// `\d{3,4}[ -]?\d{3,4}`, whose only mandatory part is SIX digits. That matched
// any bare 6-to-8 digit run, so `No row found with id 123456` logged as
// `No row found with id [REDACTED]` and `amount 250000 UGX charged` lost the
// amount. On a fraud platform those are exactly the values an incident review
// needs, and a log that silently swallows them is a log nobody can debug from.
//
// So a bare number now has to be LONG enough to plausibly be a phone: 9 or more
// digits. A 6-to-8 digit run is overwhelmingly a row id, an amount, a latency
// or a case ref, and it survives. Two shapes are still caught at the shorter
// length, because they are unambiguous:
//
//   · a `+` country code — `+971 50 123 4567`, `+256765162414`
//   · internal separators — `050 123 4567`, `(050) 123 4567`
//
// A bare 10-digit local number (`0501234567`) is still caught by the 9-digit
// rule, which is what the suite pins.
const PHONE_RE =
  /(?:\+\d{1,3}[ -]?(?:\(?\d{2,4}\)?[ -]?)?\d{3,4}[ -]?\d{3,4}|(?:\(?\d{2,4}\)?[ -]){2,}\d{3,4}|\b\d{9,15}\b)\b/g;
// 4–8 digit OTP / PIN / CVV — only when the surrounding text marks it as a code
// (bare numbers are usually amounts, case refs, or years; redacting those would
// corrupt audit fidelity, so we require an OTP-ish context cue).
const OTP_RE = /\b(?:otp|pin|passcode|password|cvv|cvc|code|رمز|کوڈ|कोड)\D{0,20}(\d{4,8})\b/gi;
// Standalone OTP in isolation ("123456") — too ambiguous to redact without
// context; amounts ("AED 2500") and risk scores ("0.94") must survive.

export function transcript(input: string): string {
  if (!input) return input;
  return input
    .replace(PAN_RE, REDACTED)
    .replace(IBAN_RE, REDACTED)
    .replace(EMAIL_RE, REDACTED)
    .replace(PHONE_RE, REDACTED)
    .replace(OTP_RE, (m, digits) => m.replace(digits, REDACTED));
}

/** Redact a value of known kind. Always returns a tagged placeholder. */
export function snippet(
  value: string,
  kind: "card" | "iban" | "phone" | "email" | "otp" | "pin",
): string {
  return `[REDACTED:${kind}]`;
}

/**
 * Redact a structured payload (one level deep). Strings are redacted; objects
 * and arrays are walked recursively. Use before JSON.stringify for any
 * audit-log / webhook payload that may carry caller transcript or PII.
 */
export function payload<T>(input: T): T {
  if (input == null) return input;
  if (typeof input === "string") return transcript(input) as unknown as T;
  if (Array.isArray(input)) return input.map((v) => payload(v)) as unknown as T;
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = payload(v);
    }
    return out as unknown as T;
  }
  return input;
}
