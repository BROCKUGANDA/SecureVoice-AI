import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { append as auditAppend } from "@/lib/audit-chain";
import { transcript as redactText } from "@/lib/redact";
import { consume as consumeRateLimit, rateLimitId } from "@/lib/ratelimit";
import { analyzeSentiment } from "@/lib/sentiment";
import { draftAgentReply } from "@/lib/llm";
import { auditAgentReply, auditUserInput } from "@/lib/compliance/policy";
import { verifyTwilioSignature } from "@/lib/twilio";
import { db } from "@/lib/db";
import { transitionCase } from "@/lib/case-state-machine";
import {
  describeDtmfForSpeech,
  mapDtmfDigits,
  sanitiseGatherActionUrl,
  type DtmfAction,
} from "@/lib/voice/dtmf";
import {
  auditWrongNumber,
  buildWrongNumberClosure,
  detectCallbackRequest,
  detectWrongNumber,
  type WrongNumberVerdict,
} from "@/lib/voice/wrong-number";
import { resolveDeliveryLang, type Lang } from "@/lib/languages";
import { logError, logWarn } from "@/lib/validation/safe-log";

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
 *   CallSid, From, To, SpeechResult, Confidence, CallStatus, and `Digits` when
 *   the caller used the keypad.
 *
 * Two answer channels, one decision: every `<Gather>` this route emits (and the
 * one in `interventionTwiml` that starts the call) collects `dtmf speech`, so the
 * caller speaks or presses and the same intent vocabulary comes out the other
 * side. A press wins over a transcription when both arrive, because the press is
 * not subject to the line noise that made the transcription unreliable in the
 * first place. See `src/lib/voice/dtmf.ts` for the mapping and the rule that a
 * keypress classifies intent and authenticates nothing.
 */

/* ── Intent classification (same keywords as /api/agent) ── */

const DENY = [
  "not mine",
  "not me",
  "didn't",
  "did not",
  "never did",
  "i did not make",
  "i didn't make",
  "fraud",
  "scam",
  "stolen",
  "unauthorized",
  "stop it",
  "stop the",
  "freeze",
  "block it",
  "that wasn't me",
  "that was not me",
  "not authorized",
  "ليست عمليتي",
  "ليست لي",
  "لم أقم",
  "احتيال",
  "نصب",
  "مسروقة",
  "غير مصرح",
  "मेरा नहीं",
  "मैंने नहीं",
  "धोखा",
  "फ्रॉड",
  "चोरी",
  "میرا نہیں",
  "میں نے نہیں",
  "فراڈ",
  "چوری",
  "pas la mienne",
  "je n'ai pas",
  "fraude",
  "volé",
  "si yangu",
  "sikufanya",
  "utapeli",
  "wizi",
];

const CONFIRM = [
  "mine",
  "i did",
  "i authorized",
  "i made it",
  "it was me",
  "that was me",
  "عمليتي",
  "أنا قمت",
  "نعم",
  "मेरा है",
  "मैंने किया",
  "میرا ہے",
  "میں نے کیا",
  "c'est la mienne",
  "j'ai fait",
  "c'était moi",
  "ni yangu",
  "nilifanya",
];

const GREETING = [
  "hello",
  "hi there",
  "good morning",
  "hey",
  "مرحبا",
  "السلام",
  "اهلا",
  "नमस्ते",
  "ہیلو",
  "سلام",
  "bonjour",
  "salut",
  "habari",
  "hujambo",
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
    en: "I'm sorry that happened — you did the right thing reporting it. I have flagged this transaction as fraud and placed a temporary restriction on your card while a human fraud specialist reviews it. The specialist will confirm and follow up with you shortly. You will not be held liable for unauthorized transactions.",
    ar: "أأسف لما حدث — تصرفك صحيح تماماً. أبلغت عن هذه العملية كاحتيال ووضعت قيداً مؤقتاً على بطاقتك ريثما يراجعها أخصائي احتيال بشري. سيؤكد الأخصائي الإجراء ويتواصل معك قريباً. لن تتحمل أي مسؤولية عن العمليات غير المصرح بها.",
    hi: "मुझे खेद है कि यह हुआ — आपने सही किया। मैंने इस लेनदेन को धोखाधड़ी के रूप में चिह्नित किया है और एक मानव फ्रॉड विशेषज्ञ की समीक्षा तक आपके कार्ड पर अस्थायी प्रतिबंध लगाया है। विशेषज्ञ पुष्टि करके जल्द ही आपसे संपर्क करेंगे। अनधिकृत लेनदेन की ज़िम्मेदारी आपकी नहीं होगी।",
    ur: "ہونے پر افسوس — آپ نے بالکل درست کیا۔ میں نے اس لین دین کو فراڈ کے طور پر نشان زد کیا ہے اور انسانی فراڈ ماہر کے جائزے تک آپ کے کارڈ پر عارضی پابندی لگائی ہے۔ ماہر تصدیق کر کے جلد آپ سے رابطہ کرے گا۔ غیر مجاز لین دین کی ذمہ داری آپ کی نہیں ہوگی۔",
    fr: "Je suis désolé pour ce qui s'est passé — vous avez fait la bonne chose en le signalant. J'ai signalé cette transaction comme frauduleuse et placé une restriction temporaire sur votre carte, le temps qu'un spécialiste anti-fraude humain l'examine. Il confirmera et vous recontactera rapidement. Vous ne serez pas tenu responsable des transactions non autorisées.",
    sw: "Nasikitika kwa kilichotokea — umefanya jambo sahihi kuripoti. Nimeweka alama ya udanganyifu kwenye muamala huu na kuweka kizuizi cha muda kwenye kadi yako wakati mtaalamu wa udanganyifu (binadamu) anakagua. Mtaalamu atathibitisha na kuwasiliana nawe hivi karibuni. Hutawajibikia miamala isiyoidhinishwa.",
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
    en: "Is there a transaction you do not recognize? Say not mine and I will flag it and restrict your card pending human review, or it's mine to close the review.",
    ar: "هل هناك عملية لا تعرفها؟ قل ليست عمليتي وسأبلّغ عنها وأقيّد بطاقتك مؤقتاً بانتظار مراجعة بشرية، أو عمليتي لإغلاق المراجعة.",
    hi: "क्या कोई लेनदेन है जो आप नहीं पहचानते? कहें मेरा नहीं — मैं इसे चिह्नित करके मानव समीक्षा तक कार्ड पर अस्थायी प्रतिबंध लगा दूँगा।",
    ur: "کیا کوئی لین دین ہے جو آپ نہیں پہچانتے؟ کہیں میرا نہیں — میں اسے نشان زد کر کے انسانی جائزے تک کارڈ پر عارضی پابندی لگا دوں گا۔",
    fr: "Y a-t-il une transaction que vous ne reconnaissez pas ? Dites ce n'est pas la mienne et je le signalerai et restreindrai temporairement votre carte en attendant un examen humain.",
    sw: "Kuna muamala usioujua? Sema si yangu nitaripoti na kuweka kizuizi cha muda kwenye kadi yako hadi mtu akague, au ni yangu kufunga ukaguzi.",
  },
};

/**
 * The phrases spoken around the turns themselves — the Gather prompt, the
 * no-speech retry, and the closing line. Same per-language shape as REPLIES
 * above, and constants for the same reason: the sentence that asks a silent
 * customer to speak is not one a model gets to improvise.
 */
const PROMPTS: Record<string, Record<string, string>> = {
  speakNow: {
    en: "Please speak now.",
    ar: "تحدّث الآن، من فضلك.",
    hi: "कृपया अब बोलिए।",
    ur: "براہ کرم ابھی بات کیجیے۔",
    fr: "Veuillez parler maintenant.",
    sw: "Tafadhali sema sasa.",
  },
  notCaught: {
    en: "I didn't catch that. Is there a transaction you do not recognize? Say not mine, or it's mine.",
    ar: "لم أسمعك بوضوح. هل هناك عملية لا تعرفها؟ قل ليست لي، أو أنها لي.",
    hi: "मैं सुन नहीं पाया। क्या कोई लेनदेन है जो आप नहीं पहचानते? कहें मेरा नहीं, या मेरा है।",
    ur: "میں نہیں سن سکا۔ کیا کوئی لین دین ہے جو آپ نہیں پہچانتے؟ کہیں میرا نہیں، یا میرا ہے۔",
    fr: "Je n'ai pas bien saisi. Y a-t-il une opération que vous ne reconnaissez pas ? Dites ce n'est pas la mienne, ou c'est la mienne.",
    sw: "Sikukusikia vizuri. Kuna muamala usioujua? Sema si yangu, au ni yangu.",
  },
  goodbye: {
    en: "Thank you. Goodbye.",
    ar: "شكراً لك. إلى اللقاء.",
    hi: "धन्यवाद। अलविदा।",
    ur: "شکریہ۔ خدا حافظ۔",
    fr: "Merci. Au revoir.",
    sw: "Asante. Kwa heri.",
  },
};

/* ── TwiML helpers ── */

function escapeXml(s: string): string {
  return s.replace(
    /[<>&'"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] ?? c,
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

  // Flow phrases follow the same per-language rule as REPLIES: keyed by lang,
  // English as the fallback for anything the table does not carry.
  const speakNow = escapeXml(PROMPTS.speakNow[lang] ?? PROMPTS.speakNow.en);
  const goodbye = escapeXml(PROMPTS.goodbye[lang] ?? PROMPTS.goodbye.en);

  return `<?xml version="1.0" encoding="UTF-8"?><Response>${say}${gather(voice, language, speakNow, callSid, lang)}<Say voice="${voice}" language="${language}">${goodbye}</Say><Hangup/></Response>`;
}

/**
 * The one `<Gather>` this route emits, for both channels at once.
 *
 * `input="dtmf speech"` is the point: the same question is offered on the keypad
 * and by voice, so a caller on a noisy line, a caller who will not speak to an
 * unknown number, and a caller who cannot speak at all all get an answer channel
 * that works. A single builder is deliberate — two `<Gather>` strings in this
 * file would drift, and a caller who pressed a key into a speech-only Gather
 * hears silence and hangs up.
 */
function gather(voice: string, language: string, prompt: string, callSid: string, lang: string) {
  const action =
    sanitiseGatherActionUrl(`/api/twilio/turn?callSid=${callSid}&lang=${lang}`) ??
    "/api/twilio/turn";
  return `<Gather input="dtmf speech" numDigits="1" timeout="8" method="POST" speechTimeout="auto" action="${escapeXml(action)}" language="${language}"><Say voice="${voice}" language="${language}">${prompt}</Say></Gather>`;
}

/* ── Main handler ── */

/**
 * Answer a keypad turn.
 *
 * THE SECURITY RULE this route implements, stated where it can be audited: a
 * press classifies INTENT and nothing else. It is a tone on a copper pair — no
 * proof of identity, in-band, replayable — so `confirm_authorized` here is worth
 * exactly what the spoken "yes it was me" is worth in the same position, and this
 * path is not wired to authentication, authorisation, unblocking, or money
 * release. Anyone extending it to a state transition must put the institution's
 * approved challenge flow behind it first.
 *
 * The reply is a CONSTANT from `src/lib/voice/dtmf.ts`, never an LLM draft: the
 * sentence that confirms a protective action, or invites a second attempt after a
 * mis-key, is one a model does not get to paraphrase. That is also why this
 * branch costs no inference budget and cannot be prompt-injected — a press is not
 * text.
 */
async function answerKeypad(args: {
  action: DtmfAction;
  lang: Lang;
  callSid: string;
  callerId: string;
  voice: string;
  language: string;
}): Promise<NextResponse> {
  const { action, lang, callSid, callerId, voice, language } = args;

  // The two actions that keep the caller in the conversation. Everything else
  // closes it: `deny_fraud` and `confirm_authorized` are answers, `cancel` is a
  // caller who rang off, and `request_human` is a handoff — the line is passed
  // on, so there is nothing left for this script to say.
  const continues = action === "repeat" || action === "none";
  const reply =
    action === "cancel"
      ? (PROMPTS.goodbye[lang] ?? PROMPTS.goodbye.en)
      : describeDtmfForSpeech(action, lang);

  const auditAction =
    action === "deny_fraud"
      ? "card_freeze"
      : action === "request_human"
        ? "escalate"
        : continues
          ? "clarify"
          : "none";

  try {
    await auditAppend({
      callRef: callSid || `SV-TW-${Date.now().toString(36)}`,
      action: "agent",
      // The keypad's own vocabulary, not the speech one: `request_human`,
      // `repeat`, `cancel` and `none` are answers a customer gave, and flattening
      // them into `unclear` would make a handoff request invisible in the trail.
      intent: action,
      callerId,
      meta: {
        lang,
        direction: "inbound",
        channel: "twilio",
        // Which channel the answer arrived on, so an operator can tell a press
        // from a word — the two carry different evidential weight.
        source: "keypad",
        replyLength: reply.length,
        llm: false,
        endCall: !continues,
        action: auditAction,
        latencyMs: 0,
      },
    });
  } catch (err) {
    logError("[twilio-turn] audit append failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!continues) {
    return new NextResponse(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${voice}" language="${language}">${escapeXml(reply)}</Say><Hangup/></Response>`,
      { headers: { "Content-Type": "text/xml" } },
    );
  }

  return new NextResponse(
    `<?xml version="1.0" encoding="UTF-8"?><Response>${replyToSay(reply, voice, language)}${gather(voice, language, escapeXml(describeDtmfForSpeech("none", lang)), callSid, lang)}<Say voice="${voice}" language="${language}">${escapeXml(PROMPTS.goodbye[lang] ?? PROMPTS.goodbye.en)}</Say><Hangup/></Response>`,
    { headers: { "Content-Type": "text/xml" } },
  );
}

/** A <Say> with the call's voice and language attributes, escaped. */
function replyToSay(text: string, voice: string, language: string): string {
  return `<Say voice="${voice}" language="${language}">${escapeXml(text)}</Say>`;
}

/**
 * End the call on a wrong number or a callback request, and record it.
 *
 * THE INVARIANT, restated where it can be audited: this path stages NO freeze and
 * queues NO escalation. A stranger saying "that's not my number" is not a fraud
 * signal — it is a denial-of-service on the fraud programme if treated as one,
 * because anyone could freeze any card by answering the phone and saying four
 * words. `buildWrongNumberClosure` returns `mustNotFreeze: true` as a LITERAL
 * type; nothing here is allowed to weaken that into a runtime flag.
 *
 * Two kinds, two endings. A wrong number CLOSES the case (there is no cardholder
 * on this line and no further call will reach one). A callback request does NOT:
 * the cardholder is real and merely busy, so the case stays open and the re-dial
 * is recorded as required. `closurePath()` computes the edges from the case's
 * ACTUAL state rather than assuming one, and a `null` path is reported as the gap
 * in the machine that it is — never papered over with a direct write, because
 * `src/lib/case-state-machine.ts` is the only writer of case state.
 */
async function answerWrongNumber(args: {
  text: string;
  verdict: WrongNumberVerdict;
  lang: Lang;
  voice: string;
  language: string;
  callSid: string;
  callerId: string;
}): Promise<NextResponse> {
  const { verdict, lang, voice, language, callSid, callerId } = args;

  const caseRow = callSid
    ? await db.case
        .findFirst({
          where: { callSid },
          select: { caseRef: true, orgId: true, state: true },
        })
        .catch(() => null)
    : null;

  const callback =
    verdict.kind === "callback_requested"
      ? detectCallbackRequest(args.text, { language: lang === "ar" ? "ar" : "en" })
      : undefined;

  const closure = buildWrongNumberClosure(verdict, {
    language: lang === "ar" ? "ar" : "en",
    ...(caseRow ? { currentState: caseRow.state } : {}),
    ...(callback ? { callback } : {}),
  });

  const callRef = caseRow?.caseRef ?? callSid ?? "";

  // The audit row is written by the module's own writer so the freeze/escalation
  // denials are recorded in the shape the tests assert, and never throws.
  await auditWrongNumber({
    callRef: callRef || `SV-TW-${Date.now().toString(36)}`,
    verdict,
    ...(callback ? { callback } : {}),
    ...(caseRow?.orgId ? { orgId: caseRow.orgId } : {}),
    callerId,
    ...(caseRow ? { currentState: caseRow.state } : {}),
  });

  // Apply the machine's own path, edge by edge, through the single writer.
  // `record.path` is a state SEQUENCE — its first element is where the case
  // already is — so the edges to take are everything after it. Asking the machine
  // to transition a case into the state it already holds is not a no-op, it is an
  // IllegalTransitionError, and applying the whole list would abort a closure on
  // its first element.
  //
  // An illegal edge throws; it is caught, logged, and the state already reached
  // stays reached, because each edge committed on its own. Reporting a half-
  // applied closure is honest; force-writing the last state is not.
  const applied: string[] = [];
  const edges = closure.record.path.slice(1);
  if (caseRow && closure.actionable && edges.length > 0) {
    try {
      for (const to of edges) {
        await transitionCase(caseRow.caseRef, to);
        applied.push(to);
      }
    } catch (err) {
      logError("[twilio-turn] wrong-number closure could not be applied", {
        caseRef: caseRow.caseRef,
        error: err instanceof Error ? err.message : String(err),
        attempted: edges.join("->"),
        applied: applied.join("->"),
      });
    }
  }

  if (!closure.actionable && verdict.confidence > 0) {
    // An identity question ("who is this?") is NOT a wrong number, and hanging up
    // on the actual cardholder is the other half of this failure. The call
    // continues with the ordinary scripted turn, and the low-confidence detection
    // is what the audit row says it is: not conclusive.
    logWarn("[twilio-turn] wrong-number detection below the action threshold", {
      kind: verdict.kind,
      confidence: verdict.confidence,
      callSid: callSid || "unknown",
    });
  }

  const speech = closure.speech || (REPLIES.unclear[lang] ?? REPLIES.unclear.en);
  // A wrong number has nothing left to ask, so the call ends on that sentence.
  // A callback request does not: the spoken line asks "later today, or another
  // time?" and hanging up on it would be the platform asking a question it refuses
  // to hear. The case is closed to NOTIFIED and recorded NOW — the cardholder is
  // busy, that is established — while the turn stays open for one more answer,
  // which is what the scripted sentence promised. After that input the ordinary
  // goodbye-and-hangup tail ends the call.
  const endsCall = closure.actionable && verdict.kind === "wrong_number";
  const body = endsCall
    ? `<?xml version="1.0" encoding="UTF-8"?><Response>${replyToSay(speech, voice, language)}<Hangup/></Response>`
    : buildTurnTwiml(speech, lang, false, callSid);

  return new NextResponse(body, { headers: { "Content-Type": "text/xml" } });
}

export async function POST(req: NextRequest) {
  const callerId = rateLimitId(req, "twilio-turn");

  // Parse the form body defensively — a malformed body must not become a 500.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return new NextResponse(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
      { status: 400, headers: { "Content-Type": "text/xml" } },
    );
  }

  // Twilio webhook authentication: without it, anyone can POST a forged
  // SpeechResult with a real CallSid — forging audit rows on live fraud cases
  // and burning the LLM budget. Verified when TWILIO_AUTH_TOKEN is configured
  // (set it — API-key mode alone cannot verify inbound webhooks).
  const params: Record<string, string> = {};
  form.forEach((v, k) => {
    params[k] = String(v);
  });
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const fullUrl = `${proto}://${req.headers.get("host")}${req.nextUrl.pathname}${req.nextUrl.search}`;
  const sigOk = verifyTwilioSignature(fullUrl, params, req.headers.get("x-twilio-signature"));
  if (sigOk !== true) {
    // Fail closed, exactly as /api/twilio/status, /sms-webhook and
    // /inbound-voice already do. `null` means TWILIO_AUTH_TOKEN is unset, so the
    // signature cannot be checked at all — and a webhook whose signature cannot
    // be checked is not an authenticated webhook. Treating that as pass let
    // anyone POST a forged SpeechResult against a live CallSid: the forged turn
    // was written to the hash-chained audit log and spent real LLM budget, so
    // the audit trail would carry an exchange that never happened.
    logWarn("[twilio-turn] refused — webhook signature not verified", {
      reason: sigOk === null ? "twilio_auth_token_unset" : "signature_mismatch",
      callSid: params.CallSid ?? "unknown",
    });
    return new NextResponse(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
      { status: 403, headers: { "Content-Type": "text/xml" } },
    );
  }

  const callSid = String(form.get("CallSid") ?? req.nextUrl.searchParams.get("callSid") ?? "");
  const speechResult = String(form.get("SpeechResult") ?? "").trim();
  const confidence = Number(form.get("Confidence") ?? "0");
  const lang = resolveDeliveryLang(
    String(form.get("lang") ?? req.nextUrl.searchParams.get("lang") ?? ""),
  );

  // The keypad channel, read as the hostile carrier field it is. `absent` (no
  // `Digits` in the body) is the normal speech turn and falls through to the
  // speech path; a `Digits` value that is present is handled below and WINS over
  // `SpeechResult`, because a press is unambiguous where a transcription may not
  // be — that ordering is the entire reason the channel exists.
  const rawDigits = form.get("Digits");
  const digits =
    rawDigits === null ? "" : typeof rawDigits === "string" ? rawDigits : String(rawDigits);
  const dtmf = mapDtmfDigits(digits);

  const rl = consumeRateLimit("twilio-turn", callSid || callerId);
  // Resolve the voice plane once, before any early return: every spoken path —
  // including the rate-limit refusal below — must speak in the caller's
  // language, so no branch may skip this lookup.
  const { voice, language } = VOICE[lang] ?? VOICE.en;
  if (!rl.ok) {
    // Same voice/language attributes as every other <Say> in this file: a
    // rate-limited caller is still a customer, and hearing the goodbye in
    // English because this one path skipped the attributes is a defect they
    // would experience as the system not recognising them.
    return new NextResponse(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${voice}" language="${language}">${escapeXml(PROMPTS.goodbye[lang] ?? PROMPTS.goodbye.en)}</Say><Hangup/></Response>`,
      { headers: { "Content-Type": "text/xml" } },
    );
  }

  // ── A key was pressed ───────────────────────────────────────────────────────
  if (dtmf.ok) {
    return answerKeypad({ action: dtmf.action, lang, callSid, callerId, voice, language });
  }
  if (dtmf.reason !== "absent") {
    // A press that is present but not actionable: too long, a non-keypad
    // character, two different keys in one burst, or a key nothing is bound to.
    // Never guess the intent — say the two options again on both channels. A
    // caller who pressed `21` meant one of them, and which one is not ours to
    // decide: guessing is how "1, that was not me" gets recorded as "2, I
    // authorised it" on a fraud call.
    logWarn("[twilio-turn] keypad press not actionable", {
      reason: dtmf.reason,
      callSid: callSid || "unknown",
    });
    return answerKeypad({ action: "none", lang, callSid, callerId, voice, language });
  }

  // No speech detected — ask again once, then end
  if (!speechResult) {
    return new NextResponse(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${voice}" language="${language}">${escapeXml(PROMPTS.notCaught[lang] ?? PROMPTS.notCaught.en)}</Say>${gather(voice, language, escapeXml(describeDtmfForSpeech("none", lang)), callSid, lang)}<Say voice="${voice}" language="${language}">${escapeXml(PROMPTS.goodbye[lang] ?? PROMPTS.goodbye.en)}</Say><Hangup/></Response>`,
      { headers: { "Content-Type": "text/xml" } },
    );
  }

  // ── A stranger or a busy cardholder, not a customer ────────────────────────
  // BEFORE any intent classification and before another word is spoken. The
  // opening script has already recited merchant and amount, so every sentence
  // after "that's not my number" is a disclosure of someone else's financial
  // data to whoever picked up, on a recorded line, in a country whose PDPL makes
  // that the bank's problem. Detecting it after the LLM turn would be detection
  // that costs the disclosure it exists to prevent.
  const wrongNumber = detectWrongNumber(speechResult, {
    language: lang === "ar" ? "ar" : "en",
  });
  if (wrongNumber.kind !== "not_detected") {
    return answerWrongNumber({
      text: speechResult,
      verdict: wrongNumber,
      lang,
      voice,
      language,
      callSid,
      callerId,
    });
  }

  // Classify intent
  const intent = classify(speechResult);
  const userInputAudit = auditUserInput(speechResult);
  const sentiment = analyzeSentiment(speechResult);
  // Determine if the call should end
  const endCall = intent === "deny_fraud" || intent === "confirm_authorized" || sentiment.escalate;

  // Get the scripted reply; try LLM rephrase if configured
  const scripted = REPLIES[intent][lang] ?? REPLIES[intent].en;
  // The tenant, for knowledge-base retrieval. Resolved HERE rather than inside
  // `draftAgentReply` for the reason that file states: the drafter keeps the
  // database out of a live turn, so a storage blip cannot stall the reply. Same
  // shape as the wrong-number branch above (`callSid → case → org`), and it
  // degrades to `null`, which simply means the turn is drafted without the
  // bank's documents — never a refused call.
  const orgForKnowledge = callSid
    ? await db.case
        .findFirst({ where: { callSid }, select: { orgId: true } })
        .then((row) => row?.orgId ?? null)
        .catch(() => null)
    : null;
  const drafted = await draftAgentReply({
    text: speechResult,
    lang: lang as "en" | "ar" | "hi" | "ur" | "fr" | "sw",
    intent,
    scriptedReply: scripted,
    orgId: orgForKnowledge,
  });

  const audited = auditAgentReply({
    reply: drafted ?? scripted,
    intent,
    isOpening: false, // opening was in the initial TwiML
    lang: lang as "en" | "ar" | "hi" | "ur" | "fr" | "sw",
  });

  const reply = audited.reply;
  const action = endCall ? (intent === "deny_fraud" ? "card_freeze" : "none") : "clarify";

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
        // The input guard's verdict, RECORDED rather than acted on. Computed and
        // discarded, as it was before, would have been a fake gate — but the
        // response here is deliberately only visibility: `/api/agent` counts an
        // injection-shaped utterance as a strike because its callerId is the
        // end user's own address, while this route's is Twilio's egress, shared
        // by every call the platform places. Striking it would let one customer
        // saying "ignore previous instructions" rate-limit the whole tenant's
        // inbound webhooks. So: audited, never refused, never punished here.
        injectionSuspicious: userInputAudit.suspicious,
        ...(userInputAudit.reason ? { injectionReason: userInputAudit.reason } : {}),
        latencyMs: 0,
      },
    });
  } catch (err) {
    logError("[twilio-turn] audit append failed", {
      error: err instanceof Error ? err.message : String(err),
    });
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
