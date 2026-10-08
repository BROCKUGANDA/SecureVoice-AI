import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { consume as consumeRateLimit, rateLimitId } from "@/lib/ratelimit";
import { checkBadActor, recordStrike } from "@/lib/abuse/bad-actor";
import { verifyTwilioSignature, twilioSignedUrl } from "@/lib/twilio";
import { handleSmsReply } from "@/lib/sms-verdict";
import { logError, logInfo } from "@/lib/validation/safe-log";

export const dynamic = "force-dynamic";

/**
 * POST /api/twilio/sms-webhook - the customer's reply to an intervention SMS.
 *
 * This route and /api/sms/inbound are the two URLs a Twilio number's
 * "A MESSAGE COMES IN" field can legitimately be pointed at, depending on which
 * console the operator worked from. Both are therefore live entry points to the
 * SAME decision, and they must not become two implementations of it: the reply
 * parser, the tenant-collision rule, the reply window and the opt-out registries
 * all live in `handleSmsReply` (src/lib/sms-verdict.ts), and this file adds
 * nothing to them. A second parser here would mean a reply can resolve a case on
 * one URL and be ignored on the other, which is invisible from the outside —
 * the customer texts NO, one webhook moves the case into fraud review and the
 * other logs it and leaves the alert open.
 *
 * Verification stays fail-closed, exactly as /api/sms/inbound does it: only an
 * explicitly valid signature is read. `null` (no TWILIO_AUTH_TOKEN to verify
 * with) is refused too, because this route changes case state and queues an
 * event to a bank — unsigned, anyone who reaches the URL could post
 * `From=+971...&Body=YES` and close a stranger's alert.
 *
 * The answer is TwiML, and every character in it is ours or escaped: the reply
 * text comes from the shared handler's copy table, but a future copy change must
 * not be able to break the document.
 */

const EMPTY = `<?xml version="1.0" encoding="UTF-8"?><Response/>`;

/**
 * What the customer hears when the handler itself faults.
 *
 * Deliberately the same sentence /api/sms/inbound answers with, so the two
 * entry points cannot be told apart from a handset. Never a 5xx: Twilio retries
 * a 5xx webhook, and the retry walks into the same fault while the customer's
 * reply is silently dropped.
 */
const HANDLER_FAULT =
  "Sorry, we could not process that. Please call the number on your card or policy documents.";

function twiml(message: string | null): NextResponse {
  const body = message
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`
    : EMPTY;
  return new NextResponse(body, { headers: { "Content-Type": "text/xml; charset=utf-8" } });
}

function escapeXml(s: string): string {
  return s.replace(
    /[<>&'"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] ?? c,
  );
}

function refused(status: number): NextResponse {
  return new NextResponse(EMPTY, { status, headers: { "Content-Type": "text/xml" } });
}

export async function POST(req: NextRequest) {
  const ip = rateLimitId(req, "twilio-sms-webhook");
  if (checkBadActor(`ip:${ip}`).action === "block") return refused(403);

  let params: Record<string, string>;
  try {
    const form = await req.formData();
    params = {};
    form.forEach((v, k) => {
      params[k] = String(v);
    });
  } catch {
    return refused(400);
  }

  if (
    verifyTwilioSignature(twilioSignedUrl(req), params, req.headers.get("x-twilio-signature")) !==
    true
  ) {
    recordStrike(`ip:${ip}`, 3);
    return refused(403);
  }

  const rl = consumeRateLimit("twilio-sms-webhook", ip, 1, 5);
  if (!rl.ok) return twiml(null);

  const from = params.From ?? "";
  const smsSid = params.SmsSid ?? params.MessageSid ?? "";

  try {
    // The body goes in exactly as Twilio sent it. Whitespace, casing and
    // punctuation belong to the parser, not to this route: trimming or
    // lower-casing here would be a second, divergent normalisation.
    const result = await handleSmsReply({ from, body: params.Body ?? "" });
    logInfo("[twilio-sms-webhook] reply handled", {
      outcome: result.outcome,
      smsSid,
      // The ref is a case identifier, never the customer's words: what they
      // typed is untrusted text and is not stored (see src/lib/memory-guard.ts).
      ...(result.caseRef ? { caseRef: result.caseRef } : {}),
    });
    return twiml(result.reply);
  } catch (err) {
    // Never leak internals into an SMS, and never 5xx (see HANDLER_FAULT).
    logError("[twilio-sms-webhook] handler failed", {
      error: err instanceof Error ? err.message : String(err),
      smsSid,
    });
    return twiml(HANDLER_FAULT);
  }
}

export async function GET() {
  return NextResponse.json({
    endpoint: "POST /api/twilio/sms-webhook",
    purpose:
      "Customer SMS replies to outbound intervention messages: inbound YES/NO intents and opt-outs",
    method: "POST (form-encoded, X-Twilio-Signature required)",
    wiring: [
      "point the Twilio number's Messaging webhook at this URL",
      "this endpoint does not send SMS; it receives customer replies",
      "replies are handled by src/lib/sms-verdict.ts, the same handler /api/sms/inbound uses",
      "use the Twilio REST API or /api/twilio/status for outbound delivery tracking",
    ],
  });
}
