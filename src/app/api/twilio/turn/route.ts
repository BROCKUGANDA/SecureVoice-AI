import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { append as auditAppend } from "@/lib/audit-chain";
import { transcript as redactText } from "@/lib/redact";
import { consume as consumeRateLimit, rateLimitId } from "@/lib/ratelimit";
import { analyzeSentiment } from "@/lib/sentiment";
import { draftAgentReply } from "@/lib/llm";
import { auditAgentReply, auditUserInput } from "@/lib/compliance/policy";
import { verifyTwilioSignature } from "@/lib/twilio";

export const dynamic = "force-dynamic";

/**
 * Twilio conversation turn webhook — the bidirectional phone loop.
 *
 * Flow:
 *   1. Twilio places the call → initial TwiML has <Gather input="speech" action="/api/twilio/turn">
 *   2. Customer speaks → Twilio transcribes and POSTs here with SpeechResult
 *   3. We classify intent, draft reply, audit it
 *   4. Return TwiML: <Say>the reply</Say> + another <Gather> for the next turn
 *   5. If the agent decides to end (confirm_fraud / confirm_authorized), return
 *      closing TwiML without a <Gather> — the call ends naturally
 *
 * Twilio sends form-encoded POST with:
 *   CallSid, From, To, SpeechResult, Confidence, CallStatus
 *   (and Digits if using DTMF fallback)
 */

/* ── Intent classification (same keywords as /api/agent) ── */

const DENY = [
  "not mine", "not me", "didn't", "did not", "never did", "i did not make", "i didn't make",
  "fraud", "scam", "stolen", "unauthorized", "stop it", "stop the", "freeze", "block it",
  "that wasn't me", "that was not me", "not authorized",
  "ليست عمليتي", "ليست لي", "لم أقم", "احتيال", "نصب", "مسروقة", "غير مصرح",
  "मेरा नहीं", "मैंने नहीं", "धोखा", "फ्रॉड", "चोरी",
  "میرا نہیں", "میں نے نہیں", "فراڈ", "چوری",
  "pas la mienne", "je n'ai pas", "fraude", "volé",
  "si yangu", "sikufanya", "utapeli", "wizi",
];

const CONFIRM = [
  "mine", "i did", "i authorized", "i made it", "it was me", "that was me",
  "عمليتي", "أنا قمت", "نعم",
  "मेरा है", "मैंने किया",
  "میرا ہے", "میں نے کیا",
  "c'est la mienne", "j'ai fait", "c'était moi",
  "ni yangu", "nilifanya",
];

const GREETING = [
  "hello", "hi there", "good morning", "hey",
  "مرحبا", "السلام", "اهلا",
  "नमस्ते",
  "ہیلو", "سلام",
  "bonjour", "salut",
  "habari", "hujambo",
];

type Intent = "deny_fraud" | "confirm_authorized" | "greeting" | "unclear";

function classify(text: string): Intent {
  const t = text.toLowerCase();
  if (DENY.some((k) => t.includes(k))) return "deny_fraud";
  if (CONFIRM.some((k) => t.includes(k))) return "confirm_authorized";
  if (GREETING.some((k) => t.includes(k))) return "greeting";
  return "unclear";
}

/* ── Per-language replies (short — these are spoken on the phone) ── */

const REPLIES: Record<Intent, Record<string, string>> = {
  deny_fraud: {
    en: "You did the right thing. I have placed a temporary freeze on your card effective immediately. A fraud specialist will join this call shortly. You will not be held liable for unauthorized transactions.",
    ar: "تصرفك صحيح. قمت بتجميد بطاقتك مؤقتاً الآن. سينضم أخصائي احتيال إلى المكالمة. لن تتحمل مسؤولية العمليات غير المصرح بها.",
    hi: "आपने सही किया। मैंने आपका कार्ड तुरंत फ्रीज़ कर दिया है। एक विशेषज्ञ जल्द ही जुड़ेंगे। अनधिकृत लेनदेन की ज़िम्मेदारी आपकी नहीं होगी۔",
    ur: "آپ نے بالکل درست کیا۔ میں نے فوراً آپ کا کارڈ فریز کر دیا ہے۔ ایک ماہر جلد ہی جڑے گا۔ غیر مجاز لین دین کی ذمہ داری آپ کی نہیں ہوگی۔",
    fr: "Vous avez fait la bonne chose. J'ai placé un gel temporaire sur votre carte. Un spécialiste va rejoindre cet appel. Vous ne serez pas tenu responsable.",
    sw: "Umefanya jambo sahihi. Nimefunga kadi yako kwa muda mara moja. Mtaalamu atajiunga na simu hii hivi karibuni. Hutawajibikia miamala isiyoidhinishwa.",
  },
  confirm_authorized: {
    en: "Thank you for confirming. I have closed the review on this transaction. Your bank will never call asking you to move money to a safe account. If anyone does, hang up and call the number on your card.",
    ar: "شكراً لتأكيدك. أغلقت المراجعة على هذه العملية. مصرفك لن يتصل أبداً لطلب نقل أموالك إلى حساب آمن.",
    hi: "धन्यवाद। मैंने इस लेनदेन की समीक्षा बंद कर दी। आपका बैंक कभी पैसा सुरक्षित खाते में भेजने के लिए नहीं कहेगा।",
    ur: "شکریہ۔ میں نے اس لین دین کی نظرثانی بند کر دی۔ آپ کا بینک کبھی پیسہ محفوظ اکاؤنٹ میں بھیجنے کے لیے نہیں کہے گا۔",
    fr: "Merci pour votre confirmation. J'ai fermé la vérification. Votre banque ne vous appellera jamais pour transférer de l'argent vers un compte sûr.",
    sw: "Asante kwa uthibitisho. Nimefunga ukaguzi wa muamala huu. Benki yako haitawahi kupigia kuomba uhamishe pesa kwenda akaunti salama.",
  },
  greeting: {
    en: "Hello — I am your bank's AI security assistant, calling about recent activity on your account. If you see a transaction you don't recognize, just say not mine.",
    ar: "مرحباً — أنا مساعد الأمان الذكي في مصرفك. إذا رأيت عملية لا تعرفها قل ليست عمليتي.",
    hi: "नमस्ते — मैं आपके बैंक का AI सुरक्षा सहायक हूँ। यदि कोई लेनदेन अपरिचित लगे तो कहें मेरा नहीं।",
    ur: "ہیلو — میں آپ کے بینک کا اے آئی سیکیورٹی اسسٹنٹ ہوں۔ اگر کوئی لین دین غیر مانوس لگے تو کہیں میرا نہیں۔",
    fr: "Bonjour — je suis l'assistant de sécurité IA de votre banque. Si vous voyez une transaction inconnue, dites ce n'est pas la mienne.",
    sw: "Habari — mimi ni msaidizi wa usalama wa AI wa benki yako. Ukiona muamala usioujua, sema si yangu.",
  },
  unclear: {
    en: "Is there a transaction you do not recognize? Say not mine and I will freeze your card immediately, or it's mine to close the review.",
    ar: "هل هناك عملية لا تعرفها؟ قل ليست عمليتي وسأجمّد بطاقتك فوراً، أو عمليتي لإغلاق المراجعة.",
    hi: "क्या कोई लेनदेन है जो आप नहीं पहचानते? कहें मेरा नहीं — मैं तुरंत कार्ड फ्रीज़ कर दूँगा।",
    ur: "کیا کوئی لین دین ہے جو آپ نہیں پہچانتے؟ کہیں میرا نہیں — میں فوراً کارڈ فریز کر دوں گا۔",
    fr: "Y a-t-il une transaction que vous ne reconnaissez pas ? Dites ce n'est pas la mienne et je gèlerai votre carte immédiatement.",
    sw: "Kuna muamala usioujua? Sema si yangu nitafunga kadi yako mara moja, au ni yangu kufunga ukaguzi.",
  },
};

/* ── TwiML helpers ── */

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] ?? c
  );
}

/** Best-available Twilio voice for a language (Polly / Google). */
const VOICE: Record<string, { voice: string; language: string }> = {
  en: { voice: "Polly.Joanna", language: "en-US" },
  ar: { voice: "Polly.Zeina", language: "ar" },
  hi: { voice: "Polly.Aditi", language: "hi-IN" },
  ur: { voice: "Polly.Sana", language: "ur-PK" },
  fr: { voice: "Polly.Celine", language: "fr-FR" },
  sw: { voice: "Google.sw-KE-Standard-A", language: "sw-KE" },
};

/**
 * Build TwiML for a conversation turn: speak the reply, then Gather for the
 * next input. When `endCall` is true, no Gather — the call ends after the
 * closing message.
 */
function buildTurnTwiml(reply: string, lang: string, endCall: boolean, callSid: string): string {
  const { voice, language } = VOICE[lang] ?? VOICE.en;
  const say = `<Say voice="${voice}" language="${language}">${escapeXml(reply)}</Say>`;

  if (endCall) {
    return `<?xml version="1.0" encoding="UTF-8"?><Response>${say}<Hangup/></Response>`;
  }

  // Gather: collect speech input for up to 8 seconds of silence, then POST to this endpoint
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${say}<Gather input="speech" action="/api/twilio/turn?callSid=${escapeXml(callSid)}&lang=${lang}" method="POST" speechTimeout="auto" language="${language}"><Say voice="${voice}" language="${language}">Please speak now.</Say></Gather><Say voice="${voice}" language="${language}">Thank you. Goodbye.</Say><Hangup/></Response>`;
}

/* ── Main handler ── */

export async function POST(req: NextRequest) {
  const callerId = rateLimitId(req, "twilio-turn");

  // Parse the form body defensively — a malformed body must not become a 500.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return new NextResponse(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
      { status: 400, headers: { "Content-Type": "text/xml" } }
    );
  }

  // Twilio webhook authentication: without it, anyone can POST a forged
  // SpeechResult with a real CallSid — forging audit rows on live fraud cases
  // and burning the LLM budget. Verified when TWILIO_AUTH_TOKEN is configured
  // (set it — API-key mode alone cannot verify inbound webhooks).
  const params: Record<string, string> = {};
  form.forEach((v, k) => { params[k] = String(v); });
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const fullUrl = `${proto}://${req.headers.get("host")}${req.nextUrl.pathname}${req.nextUrl.search}`;
  const sigOk = verifyTwilioSignature(fullUrl, params, req.headers.get("x-twilio-signature"));
  if (sigOk === false) {
    return new NextResponse(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
      { status: 403, headers: { "Content-Type": "text/xml" } }
    );
  }
  if (sigOk === null) {
    console.warn("[twilio-turn] TWILIO_AUTH_TOKEN not set — inbound webhook signatures cannot be verified");
  }

  const callSid = String(form.get("CallSid") ?? req.nextUrl.searchParams.get("callSid") ?? "");
  const speechResult = String(form.get("SpeechResult") ?? "").trim();
  const confidence = Number(form.get("Confidence") ?? "0");
  const lang = String(
    form.get("lang") ?? req.nextUrl.searchParams.get("lang") ?? "en"
  ).slice(0, 2);

  const rl = consumeRateLimit("twilio-turn", callSid || callerId);
  if (!rl.ok) {
    return new NextResponse(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Thank you. Goodbye.</Say><Hangup/></Response>`,
      { headers: { "Content-Type": "text/xml" } }
    );
  }

  // No speech detected — ask again once, then end
  if (!speechResult) {
    const { voice, language } = VOICE[lang] ?? VOICE.en;
    return new NextResponse(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${voice}" language="${language}">I didn't catch that. Is there a transaction you do not recognize? Say not mine, or it's mine.</Say><Gather input="speech" action="/api/twilio/turn?callSid=${escapeXml(callSid)}&lang=${lang}" method="POST" speechTimeout="auto" language="${language}"></Gather><Say voice="${voice}" language="${language}">Thank you. Goodbye.</Say><Hangup/></Response>`,
      { headers: { "Content-Type": "text/xml" } }
    );
  }

  // Classify intent
  const intent = classify(speechResult);
  const userInputAudit = auditUserInput(speechResult);
  const sentiment = analyzeSentiment(speechResult);

  // Determine if the call should end
  const endCall =
    intent === "deny_fraud" ||
    intent === "confirm_authorized" ||
    sentiment.escalate;

  // Get the scripted reply; try LLM rephrase if configured
  const scripted = REPLIES[intent][lang] ?? REPLIES[intent].en;
  const drafted = await draftAgentReply({
    text: speechResult,
    lang: lang as "en" | "ar" | "hi" | "ur" | "fr" | "sw",
    intent,
    scriptedReply: scripted,
  });

  const audited = auditAgentReply({
    reply: drafted ?? scripted,
    intent,
    isOpening: false, // opening was in the initial TwiML
    lang: lang as "en" | "ar" | "hi" | "ur" | "fr" | "sw",
  });

  const reply = audited.reply;
  const action = endCall
    ? intent === "deny_fraud"
      ? "card_freeze"
      : "none"
    : "clarify";

  // Audit the turn
  try {
    await auditAppend({
      callRef: callSid || `SV-TW-${Date.now().toString(36)}`,
      action: "agent",
      intent,
      callerId,
      redactedText: redactText(speechResult),
      meta: {
        lang,
        direction: "inbound",
        channel: "twilio",
        confidence,
        replyLength: reply.length,
        llm: drafted != null,
        sentiment: sentiment.sentiment,
        escalate: sentiment.escalate,
        endCall,
        action,
        latencyMs: 0,
      },
    });
  } catch (err) {
    console.error("[twilio-turn] audit append failed:", err instanceof Error ? err.message : err);
  }

  const twiml = buildTurnTwiml(reply, lang, endCall, callSid);
  return new NextResponse(twiml, {
    headers: { "Content-Type": "text/xml" },
  });
}

/** Health check for Twilio webhook validation. */
export async function GET() {
  return NextResponse.json({
    endpoint: "POST /api/twilio/turn",
    purpose: "Twilio conversation turn webhook — receives SpeechResult, returns TwiML",
    method: "POST (form-encoded)",
  });
}
