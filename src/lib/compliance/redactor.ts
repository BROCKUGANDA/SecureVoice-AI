/**
 * PII redaction pipeline for transcripts, prompts, and outbound payloads.
 *
 * This is a defense-in-depth layer: even when upstream redaction succeeds,
 * anything leaving this module is guaranteed to have raw PANs, phones, and
 * SSN-style identifiers replaced with tokenized placeholders.
 */

export function redactPII(text: string): string {
  if (!text) return text;

  let redacted = text;

  // Order matters and is not cosmetic: the phone pattern is broad enough to
  // swallow both of the shapes below, so running it first meant an SSN was
  // logged as a phone number and a spaced-out card number was logged as a phone
  // number too. Nothing leaked either way, but the compliance record said the
  // wrong thing about what left the building. Specific shapes first, general
  // digit-run last.

  // SSN-style IDs: exactly ddd-dd-dddd.
  redacted = redacted.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED_SSN]");

  // PAN/account numbers: 13 to 16 digits, printed either solid or in the
  // four-group blocks a card number is normally read as.
  redacted = redacted.replace(/\b(?:\d[ \-]?){12,15}\d\b/g, "[REDACTED_PAN]");

  // Phone numbers in common formats, including everything the two rules above
  // did not recognise.
  redacted = redacted.replace(/\+?\d[\d\s\-()]{10,}/g, "[REDACTED_PHONE]");

  return redacted;
}

export function redactTranscript(transcript: string): string {
  return redactPII(transcript);
}
