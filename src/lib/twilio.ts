import "server-only";
/**
 * Twilio delivery layer — the live-telephony path for enrolled customers.
 *
 * Plain REST via fetch (no SDK dependency): the Twilio v2010 API is form-encoded
 * with HTTP Basic auth. Runtime auth prefers the dedicated API key
 * (TWILIO_API_KEY_SID/SECRET — rotatable independently) and falls back to the
 * master TWILIO_AUTH_TOKEN.
 *
 * Voice: outbound call with INLINE TwiML — Twilio executes the script directly,
 * so the platform needs no public webhook URL to place a call (works on trial
 * accounts and behind NAT). The spoken script is the compliance-approved
 * opening disclosure (identity + recording notice + never-ask-for-PIN promise)
 * followed by the fraud-alert instruction, in the customer's language.
 *
 * SMS: fallback/alert channel when the call is not preferred.
 *
 * Activation is env-driven: when Twilio vars are absent, isConfigured() is
 * false and the interventions route degrades to audit-only (no failure).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { twilioMode, isTwilioConfigured, env } from "@/lib/config";
import { blindPingSms, headsUpSms } from "@/lib/outreach-copy";
import type { InstitutionType } from "@/lib/institution-types";
import { getTelecomIdentity, type TelecomIdentity } from "@/lib/institution";
import { prepareSpeech, type SpeechContext } from "@/lib/compliance/speech-gate";
import { recordTelecomEvent } from "@/lib/telecom-outbox";
import { logError } from "@/lib/validation/safe-log";

export { twilioMode, isTwilioConfigured };
export type { TwilioMode } from "@/lib/config";

export type DeliveryLang = "en" | "ar" | "hi" | "ur" | "fr" | "sw";

type TwilioCreds = {
  accountSid: string;
  username: string; // API key SID or account SID
  password: string; // API key secret or auth token
  from: string;
};

function creds(): TwilioCreds {
  const mode = twilioMode();
  if (!mode || mode === "unconfigured") throw new Error("Twilio not configured");
  return {
    accountSid: env.twilioAccountSid!,
    username: mode === "api-key" ? env.twilioApiKeySid! : env.twilioAccountSid!,
    password: mode === "api-key" ? env.twilioApiKeySecret! : env.twilioAuthToken!,
    from: env.twilioFromNumber!,
  };
}

/** E.164 sanity check — Twilio rejects anything else. */
export function isE164(phone: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

/* ————— multilingual voice script (compliance-approved wording) ————— */

// Per-language Polly voices available on Twilio <Say>. Each line leads with the
// opening disclosure (identity + recording notice + no-PIN promise), per the
// server-enforced compliance policy.
const VOICE: Record<DeliveryLang, { voice: string; language: string }> = {
  en: { voice: "Polly.Joanna", language: "en-US" },
  ar: { voice: "Polly.Zeina", language: "ar" },
  hi: { voice: "Polly.Aditi", language: "hi-IN" },
  ur: { voice: "Polly.Sana", language: "ur-PK" },
  fr: { voice: "Polly.Celine", language: "fr-FR" },
  sw: { voice: "Google.sw-KE-Standard-A", language: "sw-KE" }, // Google voice — Amazon Polly has no Swahili
};

const SCRIPT: Record<DeliveryLang, (amount: string, merchant: string) => string> = {
  en: (amount, merchant) =>
    `This call is recorded to protect you. Hello — I am your bank's AI security assistant, calling about recent activity on your account. ` +
    (amount || merchant
      ? `We detected a transaction of ${amount || "an amount"}${merchant ? ` at ${merchant}` : ""} that may not be yours. `
      : `We detected suspicious activity on your account. `) +
    `To protect you, we have placed a temporary hold on the transaction and will verify the details with you on this call. I will never ask for your PIN, password, or one-time passcode. A fraud specialist may join this call shortly.`,
  ar: (amount, merchant) =>
    `هذه المكالمة مسجلة لحمايتك. مرحباً — أنا مساعد الأمان الذكي في مصرفك، أتصل بخصوص نشاط حديث على حسابك. ` +
    (amount || merchant
      ? `رصدنا عملية بمبلغ ${amount || "غير محدد"}${merchant ? ` لدى ${merchant}` : ""} قد لا تكون لك. `
      : `رصدنا نشاطاً مشبوهًا على حسابك. `) +
    `لحمايتك، وضعنا حجزاً مؤقتاً على العملية وسنتحقق من التفاصيل معك في هذه المكالمة. لن أطلب منك رمزاً سرياً أو كلمة مرور أو رمز تحقق أبداً. قد ينضم أخصائي احتيال إلى المكالمة بعد قليل.`,
  hi: (amount, merchant) =>
    `यह कॉल आपकी सुरक्षा के लिए रिकॉर्ड हो रही है। नमस्ते — मैं आपके बैंक का AI सुरक्षा सहायक हूँ, आपके खाते की हालिया गतिविधि के बारे में। ` +
    (amount || merchant
      ? `हमने ${amount || "एक राशि"}${merchant ? ` ${merchant} पर` : ""} का लेनदेन पाया है जो शायद आपका नहीं है। `
      : `हमें आपके खाते पर संदिग्ध गतिविधि मिली है। `) +
    `आपकी सुरक्षा के लिए हमने लेनदेन पर अस्थायी रोक लगा दी है और इस कॉल पर विवरण सत्यापित करेंगे। मैं कभी आपका PIN, पासवर्ड या वन-टाइम पासकोड नहीं पूछूँगा। एक फ्रॉड विशेषज्ञ कुछ ही में जुड़ सकते हैं।`,
  ur: (amount, merchant) =>
    `یہ کال آپ کی حفاظت کے لیے ریکارڈ ہو رہی ہے۔ ہیلو — میں آپ کے بینک کا اے آئی سیکیورٹی اسسٹنٹ ہوں، آپ کے اکاؤنٹ کی حالیہ سرگرمی کے بارے میں۔ ` +
    (amount || merchant
      ? `ہمیں ${amount || "ایک رقم"}${merchant ? ` ${merchant} پر` : ""} کا لین دین ملا ہے جو شاید آپ کا نہیں ہے۔ `
      : `ہمیں آپ کے اکاؤنٹ پر مشکوک سرگرمی ملی ہے۔ `) +
    `آپ کی حفاظت کے لیے ہم نے لین دین پر عارضی روک لگا دی ہے اور اسی کال میں تفصیلات کی تصدیق کریں گے۔ میں کبھی آپ سے PIN، پاس ورڈ یا ون ٹائم کوڈ نہیں پوچھوں گا۔ ایک فراڈ ماہر چند لمحوں میں شامل ہو سکتا ہے۔`,
  fr: (amount, merchant) =>
    `Cet appel est enregistré pour vous protéger. Bonjour — je suis l'assistant de sécurité IA de votre banque, j'appelle au sujet d'une activité récente sur votre compte. ` +
    (amount || merchant
      ? `Nous avons détecté une transaction de ${amount || "montant inconnu"}${merchant ? ` chez ${merchant}` : ""} qui pourrait ne pas être la vôtre. `
      : `Nous avons détecté une activité suspecte sur votre compte. `) +
    `Pour vous protéger, nous avons placé une retenue temporaire sur la transaction et vérifierons les détails avec vous lors de cet appel. Je ne vous demanderai jamais votre code PIN, mot de passe ou code à usage unique. Un spécialiste anti-fraude pourrait rejoindre cet appel sous peu.`,
  sw: (amount, merchant) =>
    `Simu hii inarekodiwa kulinda wewe. Habari — mimi ni msaidizi wa usalama wa AI wa benki yako, napiga kuhusu shughuli ya hivi karibuni kwenye akaunti yako. ` +
    (amount || merchant
      ? `Tumegundua muamala wa ${amount || "kiasi kisichojulikana"}${merchant ? ` kwenye ${merchant}` : ""} ambao huenda si wako. `
      : `Tumegundua shughuli ya kutuhumu kwenye akaunti yako. `) +
    `Kulinda wewe, tumeweka zuio la muda kwenye muamala na tuthibitisha maelezo naye kwenye simu hii. Sitakuomba PIN, nenosiri, au msimbo wa matumizi moja kamwe. Mtaalamu wa udanganyifu anaweza kujiunga na simu hii hivi karibuni.`,
};

/** XML-escapes a value headed for a TwiML document. Exported for the webhook
 *  routes that build their own TwiML: every string in a TwiML response needs
 *  this, including the ones that look like they cannot contain markup. */
export function escapeXml(s: string): string {
  return s.replace(
    /[<>&'"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] ?? c,
  );
}

/**
 * Inline TwiML for the fraud-intervention voice call — BIDIRECTIONAL.
 *
 * Opening: ElevenLabs audio via <Play> (when origin is available) or Polly <Say>.
 * Then: <Gather input="speech"> collects the customer's response and POSTs
 * to /api/twilio/turn, which runs the agent and returns the next TwiML.
 * The call loops until the agent confirms or denies, then hangs up.
 *
 * When `origin` is provided (the deployment URL), the opening uses ElevenLabs
 * audio via <Play>. Without it (local dev), falls back to Polly <Say>.
 */
export function interventionTwiml(
  lang: DeliveryLang,
  amount?: string,
  merchant?: string,
  origin?: string,
  callRef?: string,
  mediaStreamUrl?: string | null,
  speech?: SpeechContext,
): string {
  const { voice, language } = VOICE[lang] ?? VOICE.en;
  // The approved wording still goes through the speech gate. Redaction and
  // speakability are unconditional; the Islamic terminology pass only applies
  // when the tenant declared itself Shariah-compliant, so a takaful operator's
  // script says takaful and a conventional insurer's script keeps saying
  // insurance, which is what the customer's policy actually is.
  const text = prepareSpeech(
    (SCRIPT[lang] ?? SCRIPT.en)(amount ?? "", merchant ?? ""),
    speech,
  ).text;

  if (mediaStreamUrl) {
    const streamUrl = `${mediaStreamUrl}?lang=${lang}${callRef ? `&callSid=${escapeXml(callRef)}` : ""}`;
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${escapeXml(streamUrl)}" /></Connect></Response>`;
  }

  const turnUrl = `/api/twilio/turn?lang=${lang}${callRef ? `&callSid=${escapeXml(callRef)}` : ""}`;

  // ElevenLabs opening via <Play> when we have a public origin. The audio URL
  // is HMAC-signed: /api/twilio/audio renders TTS on the shared platform key,
  // so an unsigned URL would let anyone synthesize arbitrary audio on our bill.
  let opening: string;
  const spoken = text.slice(0, 1024);
  const sig = origin ? signAudioParams(spoken, lang, callRef ?? "") : null;
  if (origin && sig) {
    const audioUrl = `${origin}/api/twilio/audio?text=${encodeURIComponent(spoken)}&lang=${lang}${callRef ? `&callRef=${encodeURIComponent(callRef)}` : ""}&sig=${sig}`;
    opening = `<Play>${escapeXml(audioUrl)}</Play>`;
  } else {
    opening = `<Say voice="${voice}" language="${language}">${escapeXml(text)}</Say>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?><Response>${opening}<Gather input="speech" action="${escapeXml(turnUrl)}" method="POST" speechTimeout="auto" language="${language}"><Say voice="${voice}" language="${language}">Is this transaction yours? Please say yes or no.</Say></Gather><Say voice="${voice}" language="${language}">I didn't catch a response. A fraud specialist will follow up shortly. Thank you.</Say><Hangup/></Response>`;
}

/* ————— webhook + audio-URL authentication ————— */

/**
 * Sign the params of a /api/twilio/audio URL. Derived from WEBHOOK_SECRET
 * (domain-separated) so the audio endpoint can prove the URL was minted by
 * interventionTwiml, not invented by a caller. Returns null when no secret is
 * configured — the caller must then fall back to inline <Say>.
 */
export function signAudioParams(text: string, lang: string, callRef: string): string | null {
  const secret = env.webhookSecret;
  if (!secret) return null;
  return createHmac("sha256", `sv-audio:${secret}`)
    .update(`${lang}.${callRef}.${text}`)
    .digest("base64url");
}

/** Constant-time check of a sig produced by signAudioParams. */
export function verifyAudioSignature(
  text: string,
  lang: string,
  callRef: string,
  sig: string,
): boolean {
  const expected = signAudioParams(text, lang, callRef);
  if (!expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Validate an inbound Twilio webhook (X-Twilio-Signature): base64 HMAC-SHA1
 * of the full URL + sorted POST params, keyed with the account auth token.
 * Returns:
 *   true  — signature present and valid
 *   false — signature present and INVALID (reject the request)
 *   null  — cannot verify (no TWILIO_AUTH_TOKEN configured); the caller
 *           decides the policy (we log loudly and allow, since API-key-only
 *           deployments have no token to verify against — set one).
 */
export function verifyTwilioSignature(
  fullUrl: string,
  params: Record<string, string>,
  signatureHeader: string | null,
): boolean | null {
  const token = env.twilioAuthToken;
  if (!token) return null;
  if (!signatureHeader) return false;
  const data =
    fullUrl +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  const expected = createHmac("sha1", token).update(data).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The URL Twilio says it called, rebuilt the way Twilio built it.
 *
 * Twilio signs the PUBLIC url — `https://<console host>/api/...`. Behind Caddy
 * the request's own URL is the internal one, so `TWILIO_WEBHOOK_BASE_URL` is the
 * only authoritative answer; without it the forwarded host and protocol are the
 * best available reconstruction.
 *
 * Every webhook that mutates state verifies against this and nothing else, so
 * the rule lives in one function instead of being re-derived per route.
 */
export function twilioSignedUrl(req: {
  nextUrl: { pathname: string; search: string };
  headers: { get(name: string): string | null };
}): string {
  const base = env.twilioPublicBaseUrl;
  const path = `${req.nextUrl.pathname}${req.nextUrl.search}`;
  if (base) return `${base}${path}`;
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${req.headers.get("host")}${path}`;
}

/* ————— REST calls ————— */

/**
 * Live-fire attestation.
 *
 * Every carrier request this module makes — the intervention `Calls` and the
 * `Messages` sent as pre-notification, blind-ping and SMS fallback — reaches a
 * real handset on a real network the moment credentials are present. There is
 * no sandbox that a wrong destination lands in: a test fixture that looks like
 * a UAE mobile number is, to Twilio, indistinguishable from a customer.
 *
 * So credentials are necessary but not sufficient. A deployment states
 * `TWILIO_LIVE_SEND=true` to say "this account may place real calls and send
 * real SMS". Without it every request is refused here, at the one choke point
 * both `Calls` and `Messages` pass through, so a caller cannot bypass the guard
 * by reaching for a different function.
 *
 * Deliberately NOT defaulted in `.env.example` or docker-compose, and not set
 * by the test preload: tests that exercise the live path opt in explicitly and
 * stub `globalThis.fetch`, which is the only honest way to assert on an
 * outbound carrier request.
 *
 * Read per call, not at import — a module-level const would let one file's
 * opt-in leak into the next one sharing the process.
 */
export function liveSendAttested(): boolean {
  return env.twilioLiveSend;
}

/** The refusal, shaped like the other refused sends. */
export const LIVE_SEND_REFUSAL = {
  ok: false,
  status: 403,
  error:
    "Twilio live send not attested: set TWILIO_LIVE_SEND=true to place real calls and send real SMS from this account",
} as const;

/* ————— per-tenant outbound identity ————— */

/**
 * A tenant identity that could not be read is a REFUSAL, not a fallback.
 *
 * `getTelecomIdentity` throws rather than answering with nulls precisely so this
 * branch exists: silently sending Bank A's alert on the platform's shared number
 * is the mis-attribution the tenant is paying to avoid, and it is invisible in
 * the delivery logs — the message sends fine. A refused send is loud, retried by
 * the queue on the next attempt, and reported to the bank if it never lands.
 */
const IDENTITY_UNAVAILABLE = {
  ok: false,
  status: 503,
  error: "Tenant telecom identity lookup failed — refusing to send under the platform identity",
} as const;

/**
 * The SMS sender for a tenant, resolved here — at the one place a `Messages`
 * request is built — rather than at each call site.
 *
 * A Messaging Service and an explicit `From` are mutually exclusive on Twilio's
 * side, so a tenant with a service sends no `From` at all: the service chooses
 * the sender and the real number arrives on the status callback, which is what
 * fills in the outbox column.
 */
async function resolveSmsSender(
  orgId: string | null | undefined,
): Promise<
  | { ok: true; params: { From?: string; MessagingServiceSid?: string }; recordedFrom: string }
  | { ok: false; status: number; error: string }
> {
  let id: TelecomIdentity;
  try {
    id = await getTelecomIdentity(orgId);
  } catch {
    return IDENTITY_UNAVAILABLE;
  }
  const c = creds();
  if (id.messagingServiceSid) {
    return {
      ok: true,
      params: { MessagingServiceSid: id.messagingServiceSid },
      recordedFrom: `messaging_service:${id.messagingServiceSid}`,
    };
  }
  const from = id.smsSenderId ?? c.from;
  return { ok: true, params: { From: from }, recordedFrom: from };
}

/**
 * The caller ID for a tenant's voice leg.
 *
 * Deliberately NO fallback to the platform number when the org has configured
 * one. If that number is not owned by this account Twilio rejects the call and
 * the dial worker retries then dead-letters it — a loud, attributable failure on
 * the queue. Silently dialling out on the platform's line instead would deliver
 * the alert under the wrong identity, which is the failure nobody would notice
 * until a customer complained to the wrong bank.
 */
async function resolveVoiceCallerId(
  orgId: string | null | undefined,
): Promise<{ ok: true; from: string } | { ok: false; status: number; error: string }> {
  let id: TelecomIdentity;
  try {
    id = await getTelecomIdentity(orgId);
  } catch {
    return IDENTITY_UNAVAILABLE;
  }
  const c = creds();
  if (id.voiceNumber && !isE164(id.voiceNumber)) {
    // The stored value is not echoed: it is a phone number, and this string
    // reaches the job error column and the bank's webhook payload.
    return {
      ok: false,
      status: 422,
      error: "Tenant voice number is configured but is not E.164",
    };
  }
  return { ok: true, from: id.voiceNumber ?? c.from };
}

/** The URL Twilio reports delivery to, or null when the deployment has no
 *  reachable origin — see `env.twilioWebhookBaseUrl` for why that is better
 *  than attaching a callback the carrier cannot dial. */
function statusCallbackUrl(path: string): string | undefined {
  const base = env.twilioWebhookBaseUrl;
  return base ? `${base}${path}` : undefined;
}

export const TWILIO_STATUS_CALLBACK_PATH = "/api/twilio/status";

/**
 * The outbox row for a send that happened.
 *
 * Never allowed to change the outcome of the send. The message has already left
 * the building (or definitively failed), and a logging fault must not surface as
 * an exception a caller reads as "the customer was not alerted". It IS logged,
 * because an outbox that quietly stops filling is worse than no outbox at all:
 * it is a compliance record that looks complete.
 *
 * Skipped when the send carries no tenant or case context, because a row nobody
 * can attribute answers none of the questions the outbox exists for. Every
 * production call site has both; the callers that have neither are the tests
 * that stub the carrier, and keeping them DB-free keeps the unit tier fast.
 */
async function recordOutbox(args: {
  orgId?: string | null;
  caseId?: string | null;
  channel: "voice" | "sms";
  toPhone: string;
  fromPhone: string;
  providerSid?: string | null;
  status: "queued" | "in_progress" | "sent" | "delivered" | "failed";
  payload?: Record<string, unknown>;
}): Promise<string | undefined> {
  if (!args.orgId && !args.caseId) return undefined;
  try {
    return await recordTelecomEvent({
      ...args,
      orgId: args.orgId ?? null,
      caseId: args.caseId ?? null,
    });
  } catch (err) {
    logError("[telecom-outbox] FAILED TO RECORD send", {
      channel: args.channel,
      caseId: args.caseId ?? "unknown",
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

async function twilioPost(
  accountSid: string,
  username: string,
  password: string,
  path: string,
  params: Record<string, string>,
): Promise<
  { ok: true; data: Record<string, unknown> } | { ok: false; status: number; error: string }
> {
  if (!liveSendAttested()) return LIVE_SEND_REFUSAL;
  const body = new URLSearchParams(params).toString();
  const auth = Buffer.from(`${username}:${password}`).toString("base64");
  try {
    const r = await fetch(`${env.twilioApiBaseUrl}/2010-04-01/Accounts/${accountSid}/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(env.twilioTimeoutMs),
    });
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) {
      // Parens matter: `a ?? b !== undefined ? c : d` parses as
      // `(a ?? (b !== undefined)) ? c : d` — the intended message was never used
      // and raw Twilio error JSON leaked to the caller.
      const msg =
        (data as { message?: string }).message ??
        ((data as { code?: unknown }).code !== undefined
          ? JSON.stringify(data).slice(0, 300)
          : `Twilio ${r.status}`);
      return { ok: false, status: r.status, error: msg };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, status: 503, error: err instanceof Error ? err.message : "network error" };
  }
}

export type CallResult =
  { ok: true; sid: string; status: string } | { ok: false; error: string; status: number };

/** Place the fraud-intervention voice call to an enrolled customer.
 *  The call is bidirectional: opening message → Gather → conversation loop.
 *
 *  Live-fire gate is at `twilioPost` (liveSendAttested), the one choke point
 *  both calls and SMS pass through, not here: a `TWILIO_LIVE_SEND=false` or
 *  unset account must surface the actionable refusal that names the switch,
 *  and an attested-but-unreachable number must still 422 before any request
 *  is built. Pre-production safety (staging/development never dials a real
 *  customer) is carried by that same gate, which is default-deny.
 *
 *  `orgId` decides the caller ID and the outbox row — see
 *  `resolveVoiceCallerId`. A customer's caller ID is the institution's, or the
 *  alert is not the institution's. */
export async function placeInterventionCall(args: {
  to: string;
  lang: DeliveryLang;
  amount?: string;
  merchant?: string;
  origin?: string; // deployment URL for ElevenLabs <Play>
  callRef?: string; // audit chain reference
  orgId?: string | null;
  caseId?: string | null;
  mediaStreamUrl?: string | null;
  /**
   * The tenant's speech context, supplied by the caller. This module is a
   * transport and stays one: it does not look at the database. Whoever places
   * the call already knows which tenant it belongs to.
   */
  speech?: SpeechContext;
}): Promise<CallResult & { telecomEventId?: string; from?: string }> {
  const c = creds();
  if (!isE164(args.to)) return { ok: false, status: 422, error: "Destination phone is not E.164" };
  const caller = await resolveVoiceCallerId(args.orgId);
  if (!caller.ok) return { ok: false, status: caller.status, error: caller.error };
  const from = caller.from;
  const callback = statusCallbackUrl(TWILIO_STATUS_CALLBACK_PATH);
  const res = await twilioPost(c.accountSid, c.username, c.password, "Calls.json", {
    To: args.to,
    From: from,
    Twiml: interventionTwiml(
      args.lang,
      args.amount,
      args.merchant,
      args.origin,
      args.callRef,
      args.mediaStreamUrl,
      args.speech,
    ),
    ...(callback ? { StatusCallback: callback } : {}),
  });
  if (!res.ok) return { ok: false, status: res.status, error: res.error, from };
  const sid = String(res.data.sid ?? "");
  const status = String(res.data.status ?? "queued");
  const telecomEventId = await recordOutbox({
    orgId: args.orgId,
    caseId: args.caseId,
    channel: "voice",
    toPhone: args.to,
    fromPhone: from,
    providerSid: sid || null,
    status: "queued",
    payload: { callRef: args.callRef ?? null, lang: args.lang, twilioStatus: status },
  });
  return { ok: true, sid, status, from, telecomEventId };
}

/**
 * The hold audio a customer hears while Twilio dials the specialist. The agent
 * has already said the transfer line in the caller's language before the tool
 * fired (killing the AI leg is inherent to a TwiML update), so this is hold
 * audio, not the disclosure of the transfer.
 */
export function buildTransferTwiml(from: string, specialist: string): string {
  return (
    "<Response>" +
    '<Say voice="Polly.Amy">Connecting you to a specialist now. Please hold.</Say>' +
    `<Dial callerId="${from}"><Number>${specialist}</Number></Dial>` +
    "</Response>"
  );
}

export type TransferResult =
  { ok: true; sid: string; status: string } | { ok: false; error: string; status: number };

/**
 * Warm-transfer a LIVE call to a human: rewrite the Twilio call leg's TwiML so
 * the customer is bridged to the specialist's phone. The ElevenLabs agent leg
 * dies with the update — by design; the agent has already said its goodbye and
 * the tool is invoked only after it has.
 *
 * Live-fire gate is at `twilioPost`, the same choke point as calls and SMS: an
 * unattested deployment is refused (403) and the caller degrades to the queue
 * semantics rather than hanging the customer.
 */
export async function transferCallToSpecialist(args: {
  callSid: string;
  specialist: string;
}): Promise<TransferResult> {
  if (!/^CA[0-9a-f]{32}$/.test(args.callSid)) {
    return { ok: false, status: 422, error: "callSid is not a Twilio call sid" };
  }
  if (!isE164(args.specialist)) {
    return { ok: false, status: 422, error: "specialist number is not E.164" };
  }
  const c = creds();
  // Self-dial guard: the specialist leg is a NEW outbound call from the
  // platform's own number. Pointing it back at that number dials the platform
  // itself (for a platform-managed number, the AI agent answers) — an
  // AI-calls-AI loop instead of a human. Degrade loudly instead.
  if (args.specialist === c.from) {
    return {
      ok: false,
      status: 422,
      error:
        "HUMAN_AGENT_PHONE must be a line a human answers, not the platform's own calling number",
    };
  }
  const res = await twilioPost(c.accountSid, c.username, c.password, `Calls/${args.callSid}.json`, {
    Twiml: buildTransferTwiml(c.from, args.specialist),
  });
  if (!res.ok) return { ok: false, status: res.status, error: res.error };
  return {
    ok: true,
    sid: String(res.data.sid ?? args.callSid),
    status: String(res.data.status ?? "queued"),
  };
}

/**
 * The blind-ping SMS sent when the voice channel has failed (the dial job
 * dead-lettered, or the call reached a voicemail box).
 *
 * It carries NO merchant and NO amount - see src/lib/outreach-copy.ts for why -
 * and invites exactly one reply, YES or NO, which src/lib/sms-verdict.ts parses.
 * Kept as a named export here because this module is where SMS leaves the
 * building; the wording itself lives with the rest of the customer-facing copy.
 */
export function unreachableSmsBody(
  lang: DeliveryLang,
  opts: { last4?: string | null; institution?: InstitutionType } = {},
): string {
  return blindPingSms(lang, opts);
}

/**
 * SMS NEVER CARRIES A MERCHANT OR AN AMOUNT. SMS is unencrypted, sits on lock
 * screens and passes through carrier logs; if the customer's phone is already
 * compromised, a merchant name and amount are exactly what a scammer needs for a
 * convincing follow-up. `amount` and `merchant` are still ACCEPTED, so existing
 * callers keep compiling, but they are ignored here - enforced at the one place
 * every text leaves the platform, so no caller can reintroduce the leak.
 */
/** Send the fraud-alert SMS (fallback / opt-in channel).
 *  Live-fire gate is at `twilioPost` (liveSendAttested), the one choke point
 *  both calls and SMS pass through, so a pre-production deployment that has not
 *  stated `TWILIO_LIVE_SEND=true` is refused there with an actionable refusal
 *  and Twilio is never contacted. */
export async function sendInterventionSms(args: {
  to: string;
  lang: DeliveryLang;
  caseRef: string;
  /** @deprecated Ignored. SMS never carries an amount. */
  amount?: string;
  /** @deprecated Ignored. SMS never carries a merchant. */
  merchant?: string;
  /** `unreachable` = the voice channel failed; see `unreachableSmsBody`. */
  kind?: "heads_up" | "unreachable";
  /** Blind-ping only: last four digits of the card, so the customer recognises it. */
  last4?: string | null;
  /** Blind-ping only: wording for a bank ("card") or an insurer ("policy"). */
  institution?: InstitutionType;
  /**
   * The tenant whose alert this is. Its OWN sender is resolved from this at the
   * one place a `Messages` request is built — see `resolveSmsSender`. Null or an
   * org that has configured nothing rides the platform identity, which is how
   * every tenant that has not brought numbers behaves.
   */
  orgId?: string | null;
  /** Outbox join: the case this message belongs to. */
  caseId?: string | null;
}): Promise<CallResult & { telecomEventId?: string; from?: string }> {
  const c = creds();
  if (!isE164(args.to)) return { ok: false, status: 422, error: "Destination phone is not E.164" };
  const sender = await resolveSmsSender(args.orgId);
  if (!sender.ok) return { ok: false, status: sender.status, error: sender.error };
  const callback = statusCallbackUrl(TWILIO_STATUS_CALLBACK_PATH);
  const body =
    args.kind === "unreachable"
      ? unreachableSmsBody(args.lang, {
          last4: args.last4 ?? null,
          institution: args.institution ?? "bank",
        })
      : headsUpSms(args.lang, {
          caseRef: args.caseRef,
          institution: args.institution ?? "bank",
        });
  const res = await twilioPost(c.accountSid, c.username, c.password, "Messages.json", {
    To: args.to,
    ...sender.params,
    Body: body.slice(0, 300),
    ...(callback ? { StatusCallback: callback } : {}),
  });
  if (!res.ok)
    return { ok: false, status: res.status, error: res.error, from: sender.recordedFrom };
  const sid = String(res.data.sid ?? "");
  const status = String(res.data.status ?? "queued");
  const telecomEventId = await recordOutbox({
    orgId: args.orgId,
    caseId: args.caseId,
    channel: "sms",
    toPhone: args.to,
    fromPhone: sender.recordedFrom,
    providerSid: sid || null,
    status: "queued",
    payload: {
      caseRef: args.caseRef,
      kind: args.kind ?? "heads_up",
      lang: args.lang,
      twilioStatus: status,
    },
  });
  return { ok: true, sid, status, from: sender.recordedFrom, telecomEventId };
}
