import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { consume as consumeRateLimit, rateLimitId } from "@/lib/ratelimit";
import { checkBadActor, recordStrike } from "@/lib/abuse/bad-actor";
import { env } from "@/lib/config";
import { db } from "@/lib/db";
import { append as auditAppend } from "@/lib/audit-chain";
import { snippet } from "@/lib/redact";
import { TERMINAL_CASE_STATES } from "@/lib/case-state-machine";
import { findOrgByVoiceNumber, getTransferNumber } from "@/lib/institution";
import { escapeXml, twilioSignedUrl, verifyTwilioSignature } from "@/lib/twilio";
import { INBOUND_CALLBACK_ACK, type OutreachLang } from "@/lib/outreach-copy";
import { recordTelecomEvent } from "@/lib/telecom-outbox";

export const dynamic = "force-dynamic";

/**
 * POST /api/twilio/inbound-voice — the customer rings the institution's line.
 *
 * The other half of the conversation. Everything else on this platform dials
 * OUT; this is what happens when a customer who saw the alert (or who simply
 * does not trust an incoming unknown number) calls the institution's fraud
 * number back. Two facts decide the whole route, in this order:
 *
 *   1. WHICH TENANT. The number the customer dialled (`To`) is the tenant's own
 *      `twilioVoiceNumber`, so the institution is identified by the line they
 *      chose, not by anything the caller claims. A call to Bank A's number is
 *      Bank A's, always, and a number that belongs to nobody is answered as
 *      belonging to nobody — never defaulted to "the org" or to the platform's
 *      general line.
 *
 *   2. WHICH CASE. The latest non-terminal case for the caller's number inside
 *      THAT org (`From`, scoped by orgId). Two tenants can share a handset
 *      (a joint account holder, a recycled number), so an unscoped lookup would
 *      pull Bank B's alert into Bank A's call — the exact cross-talk the caller
 *      ID isolation prevents on the way out.
 *
 * Then the caller is bridged, by ladder:
 *
 *   a. the conversation plane, when `ELEVENLABS_INBOUND_SIP_URI` is configured —
 *      the agent answers with the tenant's own identity and the case is in hand;
 *   b. a human line, when the tenant has one (`transferPhone` / HUMAN_AGENT_PHONE);
 *   c. otherwise a spoken acknowledgement in the customer's language, and the
 *      inbound event is recorded so the duty operator sees an unhandled callback.
 *
 * ## Fails closed
 *
 * This route reads case data and bridges calls. An unsigned POST could make the
 * platform dial a third party from a tenant's number and speak to them as if
 * they were the customer with an open alert. No token, or any signature other
 * than valid, is a 403 and no TwiML is returned.
 */

const TWIML = "text/xml; charset=utf-8";

/** Nothing for Twilio to execute: the call ends. A hangup beats silence. */
function hangup(): NextResponse {
  return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`, {
    headers: { "Content-Type": TWIML },
  });
}

function refused(status: number): NextResponse {
  return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?><Response/>`, {
    status,
    headers: { "Content-Type": "text/xml" },
  });
}

/** The live case the customer is calling back about, if one exists. */
type OpenCase = {
  id: string;
  caseRef: string;
  state: string;
  language: string;
} | null;

/** The case reference the customer is calling about, or null for none. */
async function latestLiveCase(orgId: string, phone: string): Promise<OpenCase> {
  return db.case.findFirst({
    where: { orgId, phone, state: { notIn: [...TERMINAL_CASE_STATES] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, caseRef: true, state: true, language: true },
  });
}

const LANGS: readonly OutreachLang[] = ["en", "ar", "hi", "ur", "fr", "sw"];

function asLang(v: unknown): OutreachLang {
  return LANGS.includes(v as OutreachLang) ? (v as OutreachLang) : "en";
}

export async function POST(req: NextRequest) {
  const ip = rateLimitId(req, "twilio-inbound-voice");
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

  const rl = consumeRateLimit("twilio-inbound-voice", ip, 1, 15);
  if (!rl.ok) return hangup();

  // Twilio's `To` is the number that was dialled; `From` is the customer. Both
  // arrive as E.164 for an MSS/mobile caller, but anything else is refused
  // rather than interpolated: these strings go into a Dial and into a lookup.
  const dialed = (params.To ?? "").trim();
  const caller = (params.From ?? "").trim();
  const E164 = /^\+[1-9]\d{6,14}$/;
  if (!E164.test(dialed) || !E164.test(caller)) return hangup();

  let org;
  try {
    org = await findOrgByVoiceNumber(dialed);
  } catch (err) {
    console.error(
      "[twilio-inbound-voice] tenant lookup failed for a dialled number — refusing to guess:",
      err instanceof Error ? err.message : err,
    );
    // No TwiML that could bridge anything. The acknowledgement is the only safe
    // answer, and it names no institution because we do not know whose line this is.
    return speak("en");
  }

  if (!org) {
    // The platform's own line, or a number that was never assigned. Answering as
    // "nobody's tenant" is correct; silently picking an org is the cross-talk bug.
    console.warn("[twilio-inbound-voice] no tenant owns the dialled number — no case context");
    await auditAppend({
      callRef: "SV-INBOUND-UNASSIGNED",
      action: "agent",
      intent: "inbound_callback_unassigned_number",
      callerId: ip,
      redactedText: `Inbound call to ${snippet(dialed, "phone")} from ${snippet(caller, "phone")} matched no tenant.`,
    }).catch(() => {});
    return speak("en");
  }

  let open: OpenCase = null;
  try {
    open = await latestLiveCase(org.id, caller);
  } catch (err) {
    console.error(
      "[twilio-inbound-voice] case lookup failed:",
      err instanceof Error ? err.message : err,
    );
    // Fall through WITHOUT case context. A customer reaching their bank's fraud
    // line gets answered even if our own database is having a bad minute.
  }

  // The inbound leg is a telecom fact about this tenant, recorded the same way
  // an outbound one is. On an inbound row `toPhone` is the number the customer
  // dialled — the tenant's own line.
  void recordTelecomEvent({
    orgId: org.id,
    caseId: open?.id ?? null,
    channel: "voice",
    toPhone: dialed,
    fromPhone: caller,
    providerSid: params.CallSid ?? null,
    status: "in_progress",
    payload: { direction: "inbound", caseRef: open?.caseRef ?? null },
  }).catch((err: unknown) =>
    console.error("[twilio-inbound-voice] outbox write failed:", String(err)),
  );

  void auditAppend({
    callRef: open?.caseRef ?? "SV-INBOUND",
    action: open ? "agent" : "handoff",
    intent: open ? "inbound_callback_matched" : "inbound_callback_no_open_case",
    callerId: ip,
    redactedText: `Customer ${snippet(caller, "phone")} called ${org.name}; ${
      open ? `case ${open.caseRef} is ${open.state}` : "no live case was found"
    }.`,
    meta: { orgId: org.id, caseRef: open?.caseRef ?? null, state: open?.state ?? null },
    orgId: org.id,
  }).catch(() => {});

  const lang = asLang(open?.language);

  // ————— the bridge ladder —————
  const agentSip = env.elevenLabsInboundSipUri;
  if (agentSip) {
    // The conversation plane answers. Caller ID stays the CUSTOMER's number so
    // the agent side can correlate the live case by the same phone it dialled.
    return twiml(
      `<Dial record="record-from-answer" timeOut="${dialTimeoutSec()}" callerId="${escapeXml(caller)}">` +
        `<Sip>${escapeXml(agentSip)}</Sip>` +
        `</Dial>`,
    );
  }

  const specialist = await getTransferNumber(org.id).catch(() => null);
  if (specialist && specialist !== dialed) {
    // A human line. `from` is the tenant's number, so the specialist's handset
    // shows the customer the institution's own caller ID — never the platform's.
    return twiml(
      `<Say language="${twilioSayLang(lang)}">${escapeXml(INBOUND_CALLBACK_ACK[lang])}</Say>` +
        `<Dial record="record-from-answer" timeOut="${dialTimeoutSec()}" callerId="${escapeXml(dialed)}">` +
        `<Number>${escapeXml(specialist)}</Number>` +
        `</Dial>`,
    );
  }

  // Nothing can take the call in the moment. Say so in the customer's language
  // and stop: the audit row above is what an operator sees.
  return speak(lang);
}

/**
 * The spoken acknowledgement. It never names the institution: the copy says "a
 * fraud specialist will call you back", which is true for every tenant, while an
 * interpolated name read off the organization row is a branding surface nobody
 * has reviewed — and getting that wrong on a fraud call is the failure this
 * whole layer exists to prevent.
 */
function speak(lang: OutreachLang): NextResponse {
  return twiml(
    `<Say language="${twilioSayLang(lang)}">${escapeXml(INBOUND_CALLBACK_ACK[lang])}</Say>`,
  );
}

function twiml(body: string): NextResponse {
  return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    headers: { "Content-Type": TWIML },
  });
}

function dialTimeoutSec(): number {
  return env.inboundDialTimeoutSec;
}

/** Twilio's <Say> language codes, which are not quite the platform's. */
function twilioSayLang(lang: OutreachLang): string {
  switch (lang) {
    case "ar":
      return "ar";
    case "hi":
      return "hi-IN";
    case "ur":
      return "ur-PK";
    case "fr":
      return "fr-FR";
    case "sw":
      return "sw-KE";
    default:
      return "en-US";
  }
}

/** Discovery, so an operator can check the webhook is wired before a customer does. */
export async function GET() {
  return NextResponse.json({
    endpoint: "POST /api/twilio/inbound-voice",
    purpose:
      "Customer calls the tenant's fraud line back: tenant by dialled number, case by caller",
    method: "POST (form-encoded, X-Twilio-Signature required)",
    wiring: [
      "assign organization.twilioVoiceNumber per tenant (that is the number this route matches on)",
      "point that Twilio number's 'A Call Comes In' webhook at this URL",
      "set ELEVENLABS_INBOUND_SIP_URI to bridge to the agent, or a human line via transferPhone/HUMAN_AGENT_PHONE",
    ],
  });
}
