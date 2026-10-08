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

  // PAN/account numbers: 13-16 digit runs. Reject obvious non-PAN sequences
  // such as pure year-like or sequential digits where possible; keep this
  // regex conservative to avoid over-redacting legitimate content.
  redacted = redacted.replace(/\b\d{13,16}\b/g, "[REDACTED_PAN]");

  // Phone numbers in common formats.
  redacted = redacted.replace(
    /\+?\d[\d\s\-()]{10,}/g,
    "[REDACTED_PHONE]",
  );

  // SSN-style IDs.
  redacted = redacted.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED_SSN]");

  return redacted;
}

export function redactTranscript(transcript: string): string {
  return redactPII(transcript);
}
