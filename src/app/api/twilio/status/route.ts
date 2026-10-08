import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { consume as consumeRateLimit, rateLimitId } from "@/lib/ratelimit";
import { checkBadActor, recordStrike } from "@/lib/abuse/bad-actor";
import { twilioSignedUrl, verifyTwilioSignature } from "@/lib/twilio";
import {
  twilioCallStatusToOurs,
  twilioMessageStatusToOurs,
  updateTelecomEvent,
  type TelecomStatus,
} from "@/lib/telecom-outbox";
import { logError, logWarn } from "@/lib/validation/safe-log";

export const dynamic = "force-dynamic";

/**
 * POST /api/twilio/status — the delivery callback for every call and SMS.
 *
 * `src/lib/twilio.ts` attaches this URL as `StatusCallback` whenever the
 * deployment has a reachable origin (TWILIO_WEBHOOK_BASE_URL / APP_BASE_URL), so
 * the outbox row a send created is folded to its real outcome as the carrier
 * learns it: queued → sent → delivered, or failed.
 *
 * ## What this route does NOT do
 *
 * It does not move a case. Case state is owned by the conversation plane (the
 * ElevenLabs post-call ingest) and by the dial worker; a carrier delivery report
 * is a TELECOM fact, not a business one. Treating `delivered` as "the customer
 * was verified" would be exactly the kind of false transition the single-writer
 * rule exists to prevent — and an SMS being delivered says nothing about whether
 * anyone read it.
 *
 * ## Why it fails closed on the signature
 *
 * The row this updates is the record a bank's compliance team reads. Unsigned,
 * anyone who could reach the URL could mark undelivered fraud alerts as
 * delivered. Same rule as /api/sms/inbound: no token configured, or no/valid-
 * only signature, is a 403 and nothing is written.
 *
 * ## Response shape
 *
 * Empty TwiML, always, including on refusal. A status callback URL that returns
 * non-empty TwiML is read by Twilio as instructions for a call that is already
 * over; a 5xx makes it retry the same report in a loop. Both are answered by
 * accepting quietly and logging what was wrong.
 */

const EMPTY = `<?xml version="1.0" encoding="UTF-8"?><Response/>`;

function accepted(): NextResponse {
  return new NextResponse(EMPTY, { headers: { "Content-Type": "text/xml; charset=utf-8" } });
}

function refused(status: number): NextResponse {
  return new NextResponse(EMPTY, { status, headers: { "Content-Type": "text/xml" } });
}

/** Twilio's own word for the outcome, kept verbatim in the payload. */
function detailOf(params: Record<string, string>): Record<string, string> {
  const detail: Record<string, string> = {};
  const raw = params.Status ?? params.MessageStatus ?? params.CallStatus;
  if (raw) detail.providerStatus = raw;
  // Codes are Twilio's documented vocabulary (21610 = busy, 30008 = unknown
  // sender, …). The NUMBER is the useful part: an error_message can quote the
  // customer's phone number back at us, and this column is not redacted.
  if (params.ErrorCode) detail.errorCode = params.ErrorCode;
  return detail;
}

export async function POST(req: NextRequest) {
  const ip = rateLimitId(req, "twilio-status");
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
    recordStrike(`ip:${ip}`, 3); // forged / unsigned webhooks are hostile, not mistakes
    return refused(403);
  }

  const rl = consumeRateLimit("twilio-status", ip, 1, 5);
  if (!rl.ok) return accepted();

  // A callback names its subject by sid, and the channel follows from which sid
  // is present: `MessageSid`/`AccountSid`+`Status` for SMS, `CallSid` for voice.
  const providerSid = params.CallSid ?? params.MessageSid ?? "";
  const channel: "voice" | "sms" = params.CallSid ? "voice" : "sms";
  if (!providerSid) return accepted();

  const raw = params.Status ?? params.CallStatus ?? params.MessageStatus ?? null;
  const status: TelecomStatus | null =
    channel === "voice" ? twilioCallStatusToOurs(raw) : twilioMessageStatusToOurs(raw);
  if (!status) {
    // `processing`, `in-progress` on a leg we never modelled, or a vocabulary
    // change upstream. Accepting it quietly is right; the alternative is a retry
    // storm over a status we simply do not track.
    logWarn("[twilio-status] unmapped status", { channel, status: raw });
    return accepted();
  }

  try {
    const touched = await updateTelecomEvent({
      providerSid,
      status,
      detail: detailOf(params),
      // A Messaging Service picks its own sender, so the outbound write could
      // only record the service. The callback carries the real number.
      fromPhone: channel === "sms" && isRealNumber(params.From) ? params.From : null,
    });
    if (touched === 0) {
      // Not an error — but the only signal that the outbox is not being closed.
      logWarn("[twilio-status] callback for an unknown sid", { channel, status });
    }
  } catch (err) {
    logError("[twilio-status] outbox update failed", { error: err instanceof Error ? err.message : String(err) });
    // 5xx deliberately: the report is real and unrecorded, and Twilio will bring
    // it again. A swallowed callback is a delivery record that stays `queued`
    // forever with nothing left to correct it.
    return refused(500);
  }

  return accepted();
}

/** `From` on an SMS callback is the sender; the service placeholder is not. */
function isRealNumber(v: string | undefined): boolean {
  return typeof v === "string" && /^\+\d{7,15}$/.test(v);
}

/** Health check, so the callback URL can be pasted into the Twilio console. */
export async function GET() {
  return NextResponse.json({
    endpoint: "POST /api/twilio/status",
    purpose: "Twilio delivery callbacks for outbound calls and SMS (the telecom outbox)",
    method: "POST (form-encoded, X-Twilio-Signature required)",
  });
}
