import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { consume as consumeRateLimit, rateLimitId } from "@/lib/ratelimit";
import { checkBadActor, recordStrike } from "@/lib/abuse/bad-actor";
import { verifyTwilioSignature, twilioSignedUrl } from "@/lib/twilio";
import { logError, logInfo } from "@/lib/validation/safe-log";

export const dynamic = "force-dynamic";

const EMPTY = `<?xml version="1.0" encoding="UTF-8"?><Response/>`;

function accepted(): NextResponse {
  return new NextResponse(EMPTY, { headers: { "Content-Type": "text/xml; charset=utf-8" } });
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
    verifyTwilioSignature(twilioSignedUrl(req), params, req.headers.get("x-twilio-signature")) !== true
  ) {
    recordStrike(`ip:${ip}`, 3);
    return refused(403);
  }

  const rl = consumeRateLimit("twilio-sms-webhook", ip, 1, 5);
  if (!rl.ok) return accepted();

  const from = params.From ?? "";
  const body = (params.Body ?? "").trim();
  const messageSid = params.MessageSid ?? "";
  const smsSid = params.SmsSid ?? messageSid;

  logInfo("[twilio-sms-webhook] inbound sms", {
    from,
    bodyLength: body.length,
    smsSid,
  });

  // In a full implementation this would correlate the inbound SMS to an open
  // intervention by phone token, append the reply to the case transcript, and
  // optionally trigger a follow-up action or human handoff. The important part
  // for the demo is that the route exists, validates Twilio signatures, and
  // records the inbound event.
  return accepted();
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
      "use the Twilio REST API or /api/twilio/status for outbound delivery tracking",
    ],
  });
}
