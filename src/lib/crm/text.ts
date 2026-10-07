/**
 * Ticket text for the institution's CRM. Pure - no I/O.
 *
 * Two things this text must always do, because a ticket is read by a person in
 * a hurry who may not know how SecureVoice works:
 *
 *   1. Say honestly that an SMS reply or a voice answer is EVIDENCE, not
 *      authorisation - anyone holding the handset can type "YES" - and that
 *      NOTHING was frozen, blocked or reversed automatically. A human decides.
 *   2. Say where the proof is: the full redacted audit chain, via the audit ref.
 *
 * And one thing it must never do: carry customer data. No phone number, no
 * merchant, no amount, no card digits, no transcript. Staff look the case up by
 * the references inside their own systems. References are still stripped to a
 * conservative character set so a hostile or malformed value cannot inject
 * markup or extra lines into the ticket.
 */

import type { HandoffReason, HandoffTicket } from "./types";

export const TEST_CASE_REF_PREFIX = "SV-TEST-";

const REASON_LABEL: Record<HandoffReason, string> = {
  sms_reply_no: "customer replied NO to the SMS alert",
  voice_fraud_denied: "customer told the voice agent they did not authorise the activity",
  unreachable_no_reply: "customer unreachable - no reply to the SMS",
  voice_failed_sms_unavailable: "voice call failed and the SMS could not be sent",
  human_review: "human review requested",
};

const REASON_DETAIL: Record<HandoffReason, string> = {
  sms_reply_no:
    "The customer replied NO to the SMS alert about this activity. Treat it as a possible " +
    "fraud report.",
  voice_fraud_denied:
    "On the verification call the customer said they did not make or authorise this activity. " +
    "Treat it as a possible fraud report.",
  unreachable_no_reply:
    "SecureVoice could not reach the customer by voice, and the customer did not reply to the " +
    "SMS within the reply window. The customer has not confirmed or denied the activity.",
  voice_failed_sms_unavailable:
    "The verification call failed and SMS could not be used as a fallback, so the customer has " +
    "not been contacted.",
  human_review: "This case needs a human decision.",
};

const PRIORITY_LABEL = { urgent: "URGENT", high: "High", normal: "Normal" } as const;

/** Keep references to a conservative, single-line character set. */
function safeRef(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[^A-Za-z0-9._:/-]/g, "").slice(0, 80);
  return cleaned.length > 0 ? cleaned : null;
}

function safeToken(value: string | null | undefined, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40);
  return cleaned.length > 0 ? cleaned : fallback;
}

export function isTestTicket(ticket: Pick<HandoffTicket, "caseRef">): boolean {
  return ticket.caseRef.startsWith(TEST_CASE_REF_PREFIX);
}

export function buildTicketText(ticket: HandoffTicket): { subject: string; body: string } {
  const caseRef = safeRef(ticket.caseRef) ?? "unknown";
  const txRef = safeRef(ticket.transactionRef);
  const auditRef = safeRef(ticket.auditRef) ?? "unknown";
  const test = isTestTicket(ticket);

  const subject =
    `${test ? "[SecureVoice test] " : "[SecureVoice] "}` +
    `Human review needed: ${REASON_LABEL[ticket.reason]} (ref ${txRef ?? caseRef})`;

  const lines: string[] = [];
  if (test) {
    lines.push(
      "THIS IS A TEST TICKET sent from the SecureVoice console to check the connection.",
      "No customer or case is involved. You can close it.",
      "",
    );
  }
  lines.push(
    "SecureVoice has flagged a case that needs a human decision.",
    "",
    `Reason: ${REASON_DETAIL[ticket.reason]}`,
    `Priority: ${PRIORITY_LABEL[ticket.priority]}`,
    `Institution type: ${ticket.institutionType}`,
    `Signal: ${safeToken(ticket.signalKind, "not specified")}`,
    `Customer response: ${ticket.customerResponse ?? "none"}`,
    `Resolution method: ${safeToken(ticket.resolutionMethod, "none")}`,
    `Customer language: ${safeToken(ticket.language, "unknown")}`,
    "",
    `Transaction ref: ${txRef ?? "not provided"}`,
    `Case ref: ${caseRef}`,
    `Audit ref: ${auditRef}`,
  );
  if (ticket.consoleUrl && /^https:\/\/[^\s]+$/.test(ticket.consoleUrl)) {
    lines.push(`SecureVoice console: ${ticket.consoleUrl}`);
  }
  lines.push(
    "",
    "Please read before acting:",
    "- An SMS reply or a voice call answer is EVIDENCE, not authorisation. Anyone holding the " +
      "customer's phone can reply or answer.",
    "- NOTHING was frozen, blocked or reversed automatically. A human must decide what to do.",
    "- The full redacted audit chain for this case is available using the audit ref above.",
    "- Customer contact and transaction details are intentionally not included in this ticket. " +
      "Look the case up by the transaction ref or audit ref in your own systems.",
  );

  return { subject, body: lines.join("\n") };
}
