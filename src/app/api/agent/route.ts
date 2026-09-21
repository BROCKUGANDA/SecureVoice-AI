import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auditAgentReply, auditUserInput, requireOutboundConsent } from "@/lib/compliance/policy";
import { transcript as redactText } from "@/lib/redact";
import { consume as consumeRateLimit } from "@/lib/ratelimit";
import { append as auditAppend } from "@/lib/audit-chain";
import { analyzeSentiment } from "@/lib/sentiment";
import { draftAgentReply } from "@/lib/llm";
import { SUPPORTED_LANGS, MAX_AGENT_TEXT_CHARS } from "@/lib/config";
import { badRequest, tooManyRequests, unprocessable, upstreamError, parseJson } from "@/lib/api-errors";

export const dynamic = "force-dynamic";

/**
 * SecureVoice conversation turn — deterministic, guardrailed intent routing.
 *
 * Wrapped in three safety nets:
 *   1. Rate-limit by `x-caller-id` (60/hour default)
 *   2. Compliance audit on the reply (PUP no-credential + opening disclosure + PII redaction)
 *   3. Tamper-evident audit-chain append before the response is returned
 *
 * The agent NEVER asks for PINs, passwords, or OTPs. The compliance layer
 * (`auditAgentReply`) scans the chosen reply and REFUSES + replaces any reply
 * that matches a credential-extraction pattern, even if the decision tree
 * picks it.
 */

const schema = z.object({
  text: z.string().trim().min(1).max(MAX_AGENT_TEXT_CHARS),
  lang: z.enum(SUPPORTED_LANGS).default("en"),
  callRef: z.string().min(3).max(64).optional(), // supplied by the client; generated if missing
  direction: z.enum(["inbound", "outbound"]).default("inbound"),
  consentRecordId: z.string().min(4).optional(),
});

type Intent = "deny_fraud" | "confirm_authorized" | "greeting" | "unclear";
type Action = "card_freeze" | "none" | "clarify" | "human_handoff";

const DENY = [
  // en
  "not mine", "not me", "didn't", "did not", "never did", "i did not make", "i didn't make",
  "fraud", "scam", "stolen", "unauthorized", "stop it", "stop the", "freeze", "block it", "block the",
  "no i did", "that wasn't me", "that was not me", "not authorized",
  // ar
  "ليست عمليتي", "ليست لي", "لم أقم", "لم أصرح", "لم اعتمد", "احتيال", "نصب", "مسروقة",
  "غير مصرح", "أوقف", "اوقف", "تجميد", "جمّد", "ليست مني",
  // hi
  "मेरा नहीं", "मेरा नही", "मैंने नहीं", "मैंने नही", "धोखा", "फ्रॉड", "ठगी", "चोरी",
  "फ्रीज़", "फ्रीज", "बंद करो", "बंद कर",
  // ur
  "میرا نہیں", "میرا نہيں", "میں نے نہیں", "میں نے نہیں کیا", "فراڈ", "ٹھگ", "چوری",
  "فریز", "فريز", "بند کرو", "بند کریں", "غیر مجاز", "روکیں", "روکو", "مجاز نہیں",
  // fr
  "pas la mienne", "pas à moi", "je n'ai pas", "je n ai pas", "fraude", "escroquerie", "volé", "volée",
  "non autorisé", "arrêtez", "bloquez", "geler", "gelez", "figez",
  // sw
  "si yangu", "sio yangu", "sikufanya", "matuso", "utapeli", "wizi", "ibiwa",
  "bila idhini", "zuia", "funga", "simamisha",
];

const CONFIRM = [
  "mine", "i did", "i authorized", "i made it", "i made that", "i did make", "yes i did",
  "it was me", "that was me",
  "عمليتي", "أنا قمت", "انا قمت", "أنا صرحت", "انا صرحت", "نعم أنا", "نعم انا", "مني أنا",
  "मेरा है", "मैंने किया", "मैंने ही", "हाँ मैंने", "हां मैंने",
  "میرا ہے", "میں نے کیا", "میں نے ہی", "ہاں میں نے", "ہاں، میں نے", "مجاز بنایا",
  // fr
  "c'est la mienne", "c est la mienne", "j'ai fait", "j ai fait", "j'ai autorisé", "j ai autorisé",
  "c'était moi", "c etait moi", "oui c'est moi", "oui c est moi",
  // sw
  "ni yangu", "mimi nilifanya", "nimeidhinisha", "nilifanya mimi", "ndiyo mimi",
];

const GREETING = [
  "hello", "hi there", "good morning", "good evening", "good afternoon", "hey",
  "مرحبا", "السلام", "اهلا", "أهلا", "هلا",
  "नमस्ते", "नमस्कार", "हैलो",
  "ہیلو", "سلام", "السلام علیکم",
  // fr
  "bonjour", "bonsoir", "salut", "allô", "allo",
  // sw
  "habari", "hujambo", "shikamoo", "mambo",
];

function classify(text: string): Intent {
  const t = text.toLowerCase();
  if (DENY.some((k) => t.includes(k))) return "deny_fraud";
  if (CONFIRM.some((k) => t.includes(k))) return "confirm_authorized";
  if (GREETING.some((k) => t.includes(k))) return "greeting";
  return "unclear";
}

const REPLIES: Record<Intent, Record<"en" | "ar" | "hi" | "ur" | "fr" | "sw", string>> = {
  deny_fraud: {
    en: "I'm sorry that happened — you did the right thing reporting it. I have placed a temporary freeze on your card effective immediately, and the transaction is now with our fraud team. A specialist will join this call shortly. You will not be held liable for unauthorized transactions.",
    ar: "أأسف لما حدث — تصرفك صحيح تماماً. قمت بتجميد بطاقتك مؤقتاً فعلياً الآن، وأحلت العملية إلى فريق الاحتيال. سينضم أخصائي إلى المكالمة بعد قليل، ولن تتحمل أي مسؤولية عن العمليات غير المصرح بها.",
    hi: "मुझे खेद है कि यह हुआ — आपने सही किया। मैंने तुरंत आपका कार्ड अस्थायी रूप से फ्रीज़ कर दिया है और यह लेनदेन अब हमारी फ्रॉड टीम के पास है। एक विशेषज्ञ कुछ ही में जुड़ेंगे। अनधिकृत लेनदेन की ज़िम्मेदारी आपकी नहीं होगी।",
    ur: "ہونے پر افسوس — آپ نے بالکل درست کیا۔ میں نے فوراً آپ کا کارڈ عارضی طور پر فریز کر دیا ہے اور یہ لین دین اب ہماری فراڈ ٹیم کے پاس ہے۔ ایک ماہر چند لمحوں میں اس کال سے جڑے گا۔ غیر مجاز لین دین کی ذمہ داری آپ کی نہیں ہوگی۔",
  fr: "Je suis désolé pour ce qui s'est passé — vous avez fait la bonne chose en le signalant. J'ai placé un gel temporaire sur votre carte avec effet immédiat, et la transaction est maintenant avec notre équipe anti-fraude. Un spécialiste va rejoindre cet appel sous peu. Vous ne serez pas tenu responsable des transactions non autorisées.",
  sw: "Nasikitika kwa kilichotokea — umefanya jambo sahihi kuripoti. Nimefunga kadi yako kwa muda mara moja, na muamala huu sasa uko kwa timu yetu ya udanganyifu. Mtaalamu atajiunga na simu hii hivi karibuni. Hutawajibikia miamala isiyoidhinishwa.",
  },
  confirm_authorized: {
    en: "Thank you for confirming. I have logged your confirmation and closed the review on this transaction. One reminder: your bank will never call to ask you to move money to a safe account — if anyone does, hang up and call the number on your card.",
    ar: "شكراً لتأكيدك. سجّلت تأكيدك وأغلقت المراجعة على هذه العملية. وتذكير مهم: مصرفك لن يتصل بك أبداً لطلب نقل أموالك إلى حساب آمن — إذا تلقيت مثل هذا الاتصال فأغلقه واتصل بالرقم الموجود على بطاقتك.",
    hi: "पुष्टि के लिए धन्यवाद। मैंने आपकी पुष्टि दर्ज कर ली और इस लेनदेन की समीक्षा बंद कर दी। एक याद दिलानी: आपका बैंक कभी नहीं कहेगा कि पैसा 'सुरक्षित खाते' में भेजें — ऐसा कोई कहे तो कॉल काट दें और कार्ड पर दिया नंबर मिलाएँ।",
    ur: "تصدیق کے لیے شکریہ۔ میں نے آپ کی تصدیق درج کر لی اور اس لین دین کی نظرثانی بند کر دی۔ ایک یاد دہانی: آپ کا بینک کبھی بھی پیسہ 'محفوظ اکاؤنٹ' میں بھیجنے کے لیے نہیں کہے گا — ایسا کوئی کہے تو کال کاٹ دیں اور کارڈ پر دیا نمبر ملائیں۔",
  fr: "Merci pour votre confirmation. J'ai enregistré votre confirmation et fermé la vérification de cette transaction. Un rappel : votre banque ne vous appellera jamais pour vous demander de transférer de l'argent vers un compte sûr — si quelqu'un le fait, raccrochez et appelez le numéro au dos de votre carte.",
  sw: "Asante kwa uthibitisho wako. Nimerekodi uthibitisho wako na nimefunga ukaguzi wa muamala huu. Kumbuka: benki yako haitawahi kupigia kuomba uhamishe pesa kwenda akaunti salama — mtu akiomba hivyo, sitisha simu upige namba iliyo kwa nyuma ya kadi yako.",
  },
  greeting: {
    en: "This call is recorded to protect you. Hello — I am your bank's AI security assistant, calling about recent activity on your account. If you see a transaction you don't recognize, just say \"not mine\" and I will freeze your card immediately. I will never ask for your PIN, password, or one-time passcode.",
    ar: "هذه المكالمة مسجلة لحمايتك. مرحباً — أنا مساعد الأمان الذكي في مصرفك، أتصل بخصوص نشاط حديث على حسابك. إذا رأيت عملية لا تعرفها قل «ليست عمليتي» وسأجمّد بطاقتك فوراً. ولن أطلب منك رمزاً سرياً أو كلمة مرور أو رمز تحقق أبداً.",
    hi: "यह कॉल आपकी सुरक्षा के लिए रिकॉर्ड हो रहा है। नमस्ते — मैं आपके बैंक का AI सुरक्षा सहायक हूँ, आपके खाते की हालिया गतिविधि के बारे में। यदि कोई लेनदेन अपरिचित लगे तो बस 'मेरा नहीं' कहें — मैं तुरंत कार्ड फ्रीज़ कर दूँगा। मैं कभी PIN, पासवर्ड या OTP नहीं पूछूँगा।",
    ur: "یہ کال آپ کی حفاظت کے لیے ریکارڈ ہو رہی ہے۔ ہیلو — میں آپ کے بینک کا اے آئی سیکیورٹی اسسٹنٹ ہوں، آپ کے اکاؤنٹ کی حالیہ سرگرمی کے بارے میں۔ اگر کوئی لین دین غیر مانوس لگے تو بس 'میرا نہیں' کہیں — میں فوراً کارڈ فریز کر دوں گا۔ میں کبھی آپ سے PIN، پاس ورڈ یا ون ٹائم کوڈ نہیں پوچھوں گا۔",
  fr: "Cet appel est enregistré pour vous protéger. Bonjour — je suis l'assistant de sécurité IA de votre banque, j'appelle au sujet d'une activité récente sur votre compte. Si vous voyez une transaction que vous ne reconnaissez pas, dites simplement « ce n'est pas la mienne » et je gèlerai votre carte immédiatement. Je ne vous demanderai jamais votre code PIN, mot de passe ou code à usage unique.",
  sw: "Simu hii inarekodiwa kulinda wewe. Habari — mimi ni msaidizi wa usalama wa AI wa benki yako, napiga kuhusu shughuli ya hivi karibuni kwenye akaunti yako. Ukiona muamala usioujua, sema tu «si yangu» nitafunga kadi yako mara moja. Sitakuomba PIN, nenosiri, au msimbo wa matumizi moja kamwe.",
  },
  unclear: {
    en: "Just so I protect the right account: is there a transaction you do NOT recognize? Say \"not mine\" and I will freeze your card immediately, or \"it's mine\" to close the review. I will never ask for your PIN, password, or one-time passcode.",
    ar: "حتى أحمي الحساب الصحيح: هل هناك عملية لا تعرفها؟ قل «ليست عمليتي» وسأجمّد بطاقتك فوراً، أو «عمليتي» لإغلاق المراجعة. ولن أطلب منك رمزاً سرياً أو كلمة مرور أو رمز تحقق أبداً.",
    hi: "ताकि मैं सही खाते की सुरक्षा कर सकूँ: क्या कोई लेनदेन है जो आप नहीं पहचानते? 'मेरा नहीं' कहें — मैं तुरंत कार्ड फ्रीज़ कर दूँगा, या 'मेरा है' कहें तो समीक्षा बंद कर दूँगा। मैं कभी PIN, पासवर्ड या OTP नहीं पूछूँगा।",
    ur: "تاکہ میں صحیح اکاؤنٹ کی حفاظت کر سکوں: کیا کوئی لین دین ہے جو آپ نہیں پہچانتے؟ 'میرا نہیں' کہیں — میں فوراً کارڈ فریز کر دوں گا، یا 'میرا ہے' کہیں تو نظرثانی بند کر دوں گا۔ میں کبھی PIN، پاس ورڈ یا ون ٹائم کوڈ نہیں پوچھوں گا۔",
  fr: "Pour protéger le bon compte : y a-t-il une transaction que vous ne reconnaissez pas ? Dites « ce n'est pas la mienne » et je gèlerai votre carte immédiatement, ou « c'est la mienne » pour fermer la vérification. Je ne vous demanderai jamais votre code PIN, mot de passe ou code à usage unique.",
  sw: "Ili nilinde akaunti sahihi: kuna muamala usioujua? Sema «si yangu» nitafunga kadi yako mara moja, au «ni yangu» kufunga ukaguzi. Sitakuomba PIN, nenosiri, au msimbo wa matumizi moja kamwe.",
  },
};

const ACTION: Record<Intent, Action> = {
  deny_fraud: "card_freeze",
  confirm_authorized: "none",
  greeting: "none",
  unclear: "clarify",
};

export async function POST(req: NextRequest) {
  const started = Date.now();
  const callerId = req.headers.get("x-caller-id") || "anon";

  // 1. Rate limit BEFORE we parse the body (cheapest possible reject)
  const rl = consumeRateLimit("agent", callerId);
  if (!rl.ok) {
    return tooManyRequests("Rate limit exceeded; retry later.", Math.ceil(rl.retryAfterMs / 1000));
  }

  const body = await parseJson(req);
  if (body === null) return badRequest("Invalid JSON body");

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return unprocessable(`text (1–${MAX_AGENT_TEXT_CHARS} chars) and lang (${SUPPORTED_LANGS.join("|")}) are required`);
  }

  // 2. Outbound consent gate (PUP compliance)
  const consent = requireOutboundConsent({
    direction: parsed.data.direction,
    consentRecordId: parsed.data.consentRecordId,
  });
  if (!consent.ok) {
    return NextResponse.json({ error: consent.error }, { status: consent.status });
  }

  const { text, lang, callRef = `SV-C-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, direction } = parsed.data;

  // 3. Classify intent + read the customer's state (checklist #19: panicked or
  //    coached callers are flagged for immediate human takeover)
  const intent = classify(text);
  const baseAction = ACTION[intent];
  const userInputAudit = auditUserInput(text);
  const sentimentResult = analyzeSentiment(text);

  // 4. Draft the reply: the deterministic scripted line is the default; when a
  //    GROQ_API_KEY is configured the LLM rephrases it in-language (never
  //    decides the action). Compliance still audits whichever text wins.
  const scripted = REPLIES[intent][lang];
  const drafted = await draftAgentReply({ text, lang, intent, scriptedReply: scripted });
  const audited = auditAgentReply({
    reply: drafted ?? scripted,
    intent,
    isOpening: intent === "greeting" || direction === "outbound",
    lang,
  });

  // 5. Audit-chain append — record the redacted user text + the (redacted) reply
  try {
    await auditAppend({
      callRef,
      action: "agent",
      intent,
      callerId,
      redactedText: redactText(text),
      meta: {
        lang,
        direction,
        replyLength: audited.reply.length,
        llm: drafted != null,
        refused: !!audited.refused,
        suspicious: userInputAudit.suspicious,
        suspiciousReason: userInputAudit.reason,
        sentiment: sentimentResult.sentiment,
        escalate: sentimentResult.escalate,
        escalationReason: sentimentResult.reason,
        guardrails: audited.guardrails,
        latencyMs: Date.now() - started,
      },
    });
  } catch (err) {
    console.error("[agent] audit append failed:", err instanceof Error ? err.message : err);
    // Don't fail the request on audit-write failure in dev; in prod this would
    // trip an alert. (See docs/RUNBOOK.md — "Audit append failure".)
  }

  return NextResponse.json({
    ok: true,
    callRef,
    intent,
    action: audited.refused || sentimentResult.escalate ? "human_handoff" : baseAction,
    reply: audited.reply,
    llm: drafted != null,
    guardrails: audited.guardrails,
    sentiment: sentimentResult.sentiment,
    escalate: sentimentResult.escalate,
    escalationReason: sentimentResult.reason,
    latencyMs: Date.now() - started,
  });
}