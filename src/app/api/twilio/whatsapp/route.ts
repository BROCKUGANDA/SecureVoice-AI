import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { consume as consumeRateLimit, rateLimitId } from "@/lib/ratelimit";
import { checkBadActor, recordStrike } from "@/lib/abuse/bad-actor";
import { verifyTwilioSignature, twilioSignedUrl } from "@/lib/twilio";
import { handleSmsReply } from "@/lib/sms-verdict";
import { logError, logInfo } from "@/lib/validation/safe-log";

export const dynamic = "force-dynamic";

/**
 * POST /api/twilio/whatsapp — the WhatsApp mirror of /api/twilio/sms-webhook.
 *
 * Point a Twilio WhatsApp sender's "When a message comes in" webhook at this
 * URL. It is the SAME decision surface as the SMS entry points, and it must not
 * become a second one: the reply parser, the tenant-collision rule, the reply
 * window and the opt-out registries all live in `handleSmsReply`
 * (src/lib/sms-verdict.ts), exactly as /api/sms/inbound and
 * /api/twilio/sms-webhook use it. The only channel-specific work is the prefix:
 * WhatsApp delivers `From: whatsapp:+971…`, which is stripped to the bare
 * E.164 here so a STOP typed into WhatsApp reaches the SAME DoNotCall registry
 * that gates dialling — never a parallel, channel-scoped one.
 *
 * Fail-closed exactly like SMS: an explicitly valid `X-Twilio-Signature` is
 * required (refused when there is no token to verify with), because this route
 * changes case state and queues a bank event. Never a 5xx — Twilio retries a
 * 5xx webhook and the retry walks into the same fault while the reply is lost.
 */
const EMPTY = `<?xml version="1.0" encoding="UTF-8"?><Response/>`;

/** Same sentence as the SMS paths, so the two channels cannot be told apart. */
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

/** WhatsApp delivers `whatsapp:+971…`; the registry is keyed on `+971…`. */
function stripWa(from: string | undefined): string {
  return (from ?? "").replace(/^whatsapp:/, "").trim();
}

export async function POST(req: NextRequest) {
  const ip = rateLimitId(req, "twilio-whatsapp");
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

  const rl = consumeRateLimit("twilio-whatsapp", ip, 1, 5);
  if (!rl.ok) return twiml(null);

  const from = stripWa(params.From);
  const messageSid = params.MessageSid ?? params.SmsSid ?? "";

  try {
    // Body goes in exactly as sent — the parser owns normalisation.
    const result = await handleSmsReply({ from, body: params.Body ?? "" });
    logInfo("[twilio-whatsapp] reply handled", {
      outcome: result.outcome,
      messageSid,
      ...(result.caseRef ? { caseRef: result.caseRef } : {}),
    });
    return twiml(result.reply);
  } catch (err) {
    logError("[twilio-whatsapp] handler failed", {
      error: err instanceof Error ? err.message : String(err),
      messageSid,
    });
    return twiml(HANDLER_FAULT);
  }
}

export async function GET() {
  return NextResponse.json({
    endpoint: "POST /api/twilio/whatsapp",
    purpose:
      "Inbound WhatsApp replies to outbound intervention messages; shares the reply parser and opt-out registries with the SMS entry points",
    method: "POST (form-encoded, X-Twilio-Signature required)",
    wiring: [
      "point a Twilio WhatsApp sender's 'When a message comes in' webhook here",
      "From arrives as whatsapp:+E164 and is stripped before the shared handler, so a STOP lands in the same DoNotCall registry",
      "this endpoint does not send WhatsApp; it receives replies",
    ],
  });
}
