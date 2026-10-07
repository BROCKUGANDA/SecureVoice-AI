import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { consume as consumeRateLimit, rateLimitId } from "@/lib/ratelimit";
import { verifyTwilioSignature } from "@/lib/twilio";
import { handleSmsReply } from "@/lib/sms-verdict";
import { checkBadActor, recordStrike } from "@/lib/abuse/bad-actor";

export const dynamic = "force-dynamic";

/**
 * POST /api/sms/inbound - Twilio "A MESSAGE COMES IN" webhook.
 *
 * Point the messaging webhook of the platform's Twilio number at
 *   https://<your-host>/api/sms/inbound
 * and the customer's YES / NO reply to the blind-ping SMS closes the case.
 *
 * ## Why this fails CLOSED where /api/twilio/turn fails open
 *
 * The voice-turn route only drives a demo conversation, so it logs and carries on
 * when TWILIO_AUTH_TOKEN is missing. THIS route changes case state and queues an
 * event to a bank. Without a verified Twilio signature, anyone who can reach the
 * URL could POST `From=+971...&Body=NO` and put a stranger's case into human
 * fraud review - or `Body=YES` and close a real alert. So: no token configured,
 * or no / wrong signature, is a 403 and nothing is read.
 *
 * Twilio signs the PUBLIC URL it called. Behind a proxy the URL we can see is not
 * that URL, so set TWILIO_WEBHOOK_BASE_URL (e.g. https://app.example.com) to the
 * exact origin configured in the Twilio console.
 *
 * The response is TwiML. Every string we put in it is XML-escaped: the reply text
 * is ours, but `from`-derived language selection and future copy changes must not
 * be able to break the document.
 */

const EMPTY = `<?xml version="1.0" encoding="UTF-8"?><Response/>`;

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

function publicUrl(req: NextRequest): string {
  const base = process.env.TWILIO_WEBHOOK_BASE_URL?.replace(/\/+$/, "");
  if (base) return `${base}${req.nextUrl.pathname}${req.nextUrl.search}`;
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${req.headers.get("host")}${req.nextUrl.pathname}${req.nextUrl.search}`;
}

export async function POST(req: NextRequest) {
  const ip = rateLimitId(req, "sms-inbound");

  // A source already blocked for abuse gets the same nothing a STOP gets.
  if (checkBadActor(`ip:${ip}`).action === "block") return twiml(null);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return new NextResponse(EMPTY, { status: 400, headers: { "Content-Type": "text/xml" } });
  }

  const params: Record<string, string> = {};
  form.forEach((v, k) => {
    params[k] = String(v);
  });

  // FAIL CLOSED: only an explicitly valid signature proceeds. `null` (no token to
  // verify with) is refused too - see the header comment.
  const sigOk = verifyTwilioSignature(
    publicUrl(req),
    params,
    req.headers.get("x-twilio-signature"),
  );
  if (sigOk !== true) {
    recordStrike(`ip:${ip}`, 3); // forged / unsigned webhooks are hostile, not mistakes
    return new NextResponse(EMPTY, { status: 403, headers: { "Content-Type": "text/xml" } });
  }

  // Per-sender budget, so one handset cannot hammer the case lookup.
  // Validate E.164 before using as a rate-limit key — an unbounded string
  // would let an attacker create unlimited Redis keys and exhaust memory.
  const from = String(params.From ?? "");
  const rateKey = /^\+[1-9]\d{7,14}$/.test(from) ? from : ip;
  const rl = consumeRateLimit("sms-inbound", rateKey, 1, 30);
  if (!rl.ok) return twiml(null);

  try {
    const result = await handleSmsReply({ from, body: String(params.Body ?? "") });
    return twiml(result.reply);
  } catch (err) {
    // Never leak internals into an SMS, and never 5xx: Twilio would retry the same
    // reply into the same fault. A generic "reply again" is the safe answer.
    console.error("[sms-inbound] handler failed:", err instanceof Error ? err.message : err);
    return twiml(
      "Sorry, we could not process that. Please call the number on your card or policy documents.",
    );
  }
}

/** Health check, so the webhook URL can be pasted into the Twilio console and tested. */
export async function GET() {
  return NextResponse.json({
    endpoint: "POST /api/sms/inbound",
    purpose: "Twilio inbound-SMS webhook: YES / NO replies to the fraud-alert text",
    method: "POST (form-encoded, X-Twilio-Signature required)",
  });
}
