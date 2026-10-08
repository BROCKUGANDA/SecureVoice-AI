import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auditAgentReply, auditUserInput, requireOutboundConsent } from "@/lib/compliance/policy";
import { transcript as redactText } from "@/lib/redact";
import { consume as consumeRateLimit, rateLimitId } from "@/lib/ratelimit";
import { append as auditAppend } from "@/lib/audit-chain";
import { analyzeSentiment } from "@/lib/sentiment";
import { draftAgentReply } from "@/lib/llm";
import { checkBadActor, recordStrike } from "@/lib/abuse/bad-actor";
import { detectInjectionAttempt } from "@/lib/llm-guard";
import { screenForMemory } from "@/lib/memory-guard";
import { SUPPORTED_LANGS, MAX_AGENT_TEXT_CHARS } from "@/lib/config";
import {
  badRequest,
  tooManyRequests,
  unprocessable,
  upstreamError,
  parseJson,
} from "@/lib/api-errors";
import { logError } from "@/lib/validation/safe-log";

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
  // 1-based turn number within the call, supplied by the client. Optional: absent
  // means "unknown", which can never trigger the unclear-turn handoff.
  turn: z.number().int().min(1).max(200).optional(),
  direction: z.enum(["inbound", "outbound"]).default("inbound"),
  consentRecordId: z.string().min(4).optional(),
});

type Intent = "deny_fraud" | "confirm_authorized" | "greeting" | "unclear" | "doubt" | "handoff";
type Action = "card_freeze" | "none" | "clarify" | "human_handoff";

/**
 * After this many turns without a clear answer the call goes to a human rather
 * than looping ("Was this you?" / "Are you sure?" / ...). A loop is how a fraud
 * victim ends up arguing with a script at 2am; a person resolves it in one turn.
 */
const MAX_UNCLEAR_TURNS = 4;

/**
 * A caller who asks "are you a scammer?" is doing exactly what we tell people to
 * do. These are QUESTIONS about the call, checked BEFORE the fraud-denial words:
 * "are you a scam-mer" contains "scam", and reading it as "this transaction is a
 * scam" would freeze-flag an account because the customer was being careful.
 * Question forms only, so "that was a scam, I never did it" still denies.
 */
const DOUBT = [
  "are you a scam",
  "are you scam",
  "is this a scam",
  "are you real",
  "are you a real",
  "are you a robot",
  "are you a bot",
  "are you human",
  "are you a human",
  "how do i know",
  "how can i trust",
  "prove you",
  "who are you",
  "who is this",
  "who is calling",
  "هل أنت محتال",
  "هل هذا احتيال",
  "هل أنت حقيقي",
  "هل أنت روبوت",
  "كيف أعرف",
  "من أنت",
  "क्या आप ठग",
  "क्या यह धोखा है",
  "क्या आप असली",
  "क्या आप रोबोट",
  "आप कौन",
  "کیا آپ فراڈ",
  "کیا یہ فراڈ ہے",
  "کیا آپ اصلی",
  "کیا آپ روبوٹ",
  "آپ کون",
  "êtes-vous une arnaque",
  "est-ce une arnaque",
  "êtes-vous un robot",
  "êtes-vous réel",
  "qui êtes-vous",
  "comment savoir",
  "wewe ni tapeli",
  "huu ni utapeli",
  "wewe ni roboti",
  "wewe ni nani",
];

const DENY = [
  // en
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
  "block the",
  "no i did",
  "that wasn't me",
  "that was not me",
  "not authorized",
  // ar
  "ليست عمليتي",
  "ليست لي",
  "لم أقم",
  "لم أصرح",
  "لم اعتمد",
  "احتيال",
  "نصب",
  "مسروقة",
  "غير مصرح",
  "أوقف",
  "اوقف",
  "تجميد",
  "جمّد",
  "ليست مني",
  // hi
  "मेरा नहीं",
  "मेरा नही",
  "मैंने नहीं",
  "मैंने नही",
  "धोखा",
  "फ्रॉड",
  "ठगी",
  "चोरी",
  "फ्रीज़",
  "फ्रीज",
  "बंद करो",
  "बंद कर",
  // ur
  "میرا نہیں",
  "میرا نہيں",
  "میں نے نہیں",
  "میں نے نہیں کیا",
  "فراڈ",
  "ٹھگ",
  "چوری",
  "فریز",
  "فريز",
  "بند کرو",
  "بند کریں",
  "غیر مجاز",
  "روکیں",
  "روکو",
  "مجاز نہیں",
  // fr
  "pas la mienne",
  "pas à moi",
  "je n'ai pas",
  "je n ai pas",
  "fraude",
  "escroquerie",
  "volé",
  "volée",
  "non autorisé",
  "arrêtez",
  "bloquez",
  "geler",
  "gelez",
  "figez",
  // sw
  "si yangu",
  "sio yangu",
  "sikufanya",
  "matuso",
  "utapeli",
  "wizi",
  "ibiwa",
  "bila idhini",
  "zuia",
  "funga",
  "simamisha",
];

const CONFIRM = [
  "mine",
  "i did",
  "i authorized",
  "i made it",
  "i made that",
  "i did make",
  "yes i did",
  "it was me",
  "that was me",
  "عمليتي",
  "أنا قمت",
  "انا قمت",
  "أنا صرحت",
  "انا صرحت",
  "نعم أنا",
  "نعم انا",
  "مني أنا",
  "मेरा है",
  "मैंने किया",
  "मैंने ही",
  "हाँ मैंने",
  "हां मैंने",
  "میرا ہے",
  "میں نے کیا",
  "میں نے ہی",
  "ہاں میں نے",
  "ہاں، میں نے",
  "مجاز بنایا",
  // fr
  "c'est la mienne",
  "c est la mienne",
  "j'ai fait",
  "j ai fait",
  "j'ai autorisé",
  "j ai autorisé",
  "c'était moi",
  "c etait moi",
  "oui c'est moi",
  "oui c est moi",
  // sw
  "ni yangu",
  "mimi nilifanya",
  "nimeidhinisha",
  "nilifanya mimi",
  "ndiyo mimi",
];

const GREETING = [
  "hello",
  "hi there",
  "good morning",
  "good evening",
  "good afternoon",
  "hey",
  "مرحبا",
  "السلام",
  "اهلا",
  "أهلا",
  "هلا",
  "नमस्ते",
  "नमस्कार",
  "हैलो",
  "ہیلو",
  "سلام",
  "السلام علیکم",
  // fr
  "bonjour",
  "bonsoir",
  "salut",
  "allô",
  "allo",
  // sw
  "habari",
  "hujambo",
  "shikamoo",
  "mambo",
];

function classify(text: string): Intent {
  const t = text.toLowerCase();
  // Doubt FIRST: see DOUBT. A careful customer is not a fraud report.
  if (DOUBT.some((k) => t.includes(k))) return "doubt";
  if (DENY.some((k) => t.includes(k))) return "deny_fraud";
  if (CONFIRM.some((k) => t.includes(k))) return "confirm_authorized";
  if (GREETING.some((k) => t.includes(k))) return "greeting";
  return "unclear";
}

type Lang = "en" | "ar" | "hi" | "ur" | "fr" | "sw";

const REPLIES: Record<
  "deny_fraud" | "confirm_authorized" | "greeting" | "unclear",
  Record<Lang, string>
> = {
  deny_fraud: {
    en: "I'm sorry that happened — you did the right thing reporting it. I have flagged this transaction as fraud and placed a temporary restriction on your card while a human fraud specialist reviews it. The specialist will confirm and follow up with you shortly. You will not be held liable for unauthorized transactions.",
    ar: "أأسف لما حدث — تصرفك صحيح تماماً. أبلغت عن هذه العملية كاحتيال ووضعت قيداً مؤقتاً على بطاقتك ريثما يراجعها أخصائي احتيال بشري. سيؤكد الأخصائي الإجراء ويتواصل معك قريباً. لن تتحمل أي مسؤولية عن العمليات غير المصرح بها.",
    hi: "मुझे खेद है कि यह हुआ — आपने सही किया। मैंने इस लेनदेन को धोखाधड़ी के रूप में चिह्नित किया है और एक मानव फ्रॉड विशेषज्ञ की समीक्षा तक आपके कार्ड पर अस्थायी प्रतिबंध लगाया है। विशेषज्ञ पुष्टि करके जल्द ही आपसे संपर्क करेंगे। अनधिकृत लेनदेन की ज़िम्मेदारी आपकी नहीं होगी।",
    ur: "ہونے پر افسوس — آپ نے بالکل درست کیا۔ میں نے اس لین دین کو فراڈ کے طور پر نشان زد کیا ہے اور انسانی فراڈ ماہر کے جائزے تک آپ کے کارڈ پر عارضی پابندی لگائی ہے۔ ماہر تصدیق کر کے جلد آپ سے رابطہ کرے گا۔ غیر مجاز لین دین کی ذمہ داری آپ کی نہیں ہوگی۔",
    fr: "Je suis désolé pour ce qui s'est passé — vous avez fait la bonne chose en le signalant. J'ai signalé cette transaction comme frauduleuse et placé une restriction temporaire sur votre carte, le temps qu'un spécialiste anti-fraude humain l'examine. Il confirmera et vous recontactera rapidement. Vous ne serez pas tenu responsable des transactions non autorisées.",
    sw: "Nasikitika kwa kilichotokea — umefanya jambo sahihi kuripoti. Nimeweka alama ya udanganyifu kwenye muamala huu na kuweka kizuizi cha muda kwenye kadi yako wakati mtaalamu wa udanganyifu (binadamu) anakagua. Mtaalamu atathibitisha na kuwasiliana nawe hivi karibuni. Hutawajibikia miamala isiyoidhinishwa.",
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
    en: "This call is recorded to protect you. Hello — I am your bank's AI security assistant, calling about recent activity on your account. If you see a transaction you don't recognize, just say \"not mine\" and I will flag it and restrict your card pending human review. I will never ask for your PIN, password, or one-time passcode.",
    ar: "هذه المكالمة مسجلة لحمايتك. مرحباً — أنا مساعد الأمان الذكي في مصرفك، أتصل بخصوص نشاط حديث على حسابك. إذا رأيت عملية لا تعرفها قل «ليست عمليتي» وسأبلّغ عنها وأقيّد بطاقتك مؤقتاً بانتظار مراجعة بشرية. ولن أطلب منك رمزاً سرياً أو كلمة مرور أو رمز تحقق أبداً.",
    hi: "यह कॉल आपकी सुरक्षा के लिए रिकॉर्ड हो रहा है। नमस्ते — मैं आपके बैंक का AI सुरक्षा सहायक हूँ, आपके खाते की हालिया गतिविधि के बारे में। यदि कोई लेनदेन अपरिचित लगे तो बस 'मेरा नहीं' कहें — मैं इसे चिह्नित करके मानव समीक्षा तक कार्ड पर अस्थायी प्रतिबंध लगा दूँगा। मैं कभी PIN, पासवर्ड या OTP नहीं पूछूँगा।",
    ur: "یہ کال آپ کی حفاظت کے لیے ریکارڈ ہو رہی ہے۔ ہیلو — میں آپ کے بینک کا اے آئی سیکیورٹی اسسٹنٹ ہوں، آپ کے اکاؤنٹ کی حالیہ سرگرمی کے بارے میں۔ اگر کوئی لین دین غیر مانوس لگے تو بس 'میرا نہیں' کہیں — میں اسے نشان زد کر کے انسانی جائزے تک کارڈ پر عارضی پابندی لگا دوں گا۔ میں کبھی آپ سے PIN، پاس ورڈ یا ون ٹائم کوڈ نہیں پوچھوں گا۔",
    fr: "Cet appel est enregistré pour vous protéger. Bonjour — je suis l'assistant de sécurité IA de votre banque, j'appelle au sujet d'une activité récente sur votre compte. Si vous voyez une transaction que vous ne reconnaissez pas, dites simplement « ce n'est pas la mienne » et je le signalerai et restreindrai temporairement votre carte en attendant un examen humain. Je ne vous demanderai jamais votre code PIN, mot de passe ou code à usage unique.",
    sw: "Simu hii inarekodiwa kulinda wewe. Habari — mimi ni msaidizi wa usalama wa AI wa benki yako, napiga kuhusu shughuli ya hivi karibuni kwenye akaunti yako. Ukiona muamala usioujua, sema tu «si yangu» nitaripoti na kuweka kizuizi cha muda kwenye kadi yako hadi mtu akague. Sitakuomba PIN, nenosiri, au msimbo wa matumizi moja kamwe.",
  },
  unclear: {
    en: 'Just so I protect the right account: is there a transaction you do NOT recognize? Say "not mine" and I will flag it and restrict your card pending human review, or "it\'s mine" to close the review. I will never ask for your PIN, password, or one-time passcode.',
    ar: "حتى أحمي الحساب الصحيح: هل هناك عملية لا تعرفها؟ قل «ليست عمليتي» وسأبلّغ عنها وأقيّد بطاقتك مؤقتاً بانتظار مراجعة بشرية، أو «عمليتي» لإغلاق المراجعة. ولن أطلب منك رمزاً سرياً أو كلمة مرور أو رمز تحقق أبداً.",
    hi: "ताकि मैं सही खाते की सुरक्षा कर सकूँ: क्या कोई लेनदेन है जो आप नहीं पहचानते? 'मेरा नहीं' कहें — मैं इसे चिह्नित करके मानव समीक्षा तक कार्ड पर अस्थायी प्रतिबंध लगा दूँगा, या 'मेरा है' कहें तो समीक्षा बंद कर दूँगा। मैं कभी PIN, पासवर्ड या OTP नहीं पूछूँगा।",
    ur: "تاکہ میں صحیح اکاؤنٹ کی حفاظت کر سکوں: کیا کوئی لین دین ہے جو آپ نہیں پہچانتے؟ 'میرا نہیں' کہیں — میں اسے نشان زد کر کے انسانی جائزے تک کارڈ پر عارضی پابندی لگا دوں گا، یا 'میرا ہے' کہیں تو نظرثانی بند کر دوں گا۔ میں کبھی PIN، پاس ورڈ یا ون ٹائم کوڈ نہیں پوچھوں گا۔",
    fr: "Pour protéger le bon compte : y a-t-il une transaction que vous ne reconnaissez pas ? Dites « ce n'est pas la mienne » et je le signalerai et restreindrai temporairement votre carte en attendant un examen humain, ou « c'est la mienne » pour fermer la vérification. Je ne vous demanderai jamais votre code PIN, mot de passe ou code à usage unique.",
    sw: "Ili nilinde akaunti sahihi: kuna muamala usioujua? Sema «si yangu» nitaripoti na kuweka kizuizi cha muda kwenye kadi yako hadi mtu akague, au «ni yangu» kufunga ukaguzi. Sitakuomba PIN, nenosiri, au msimbo wa matumizi moja kamwe.",
  },
};

// Said when the caller asks whether this is a scam or whether we are real. It
// asks for NOTHING, tells them how to verify independently, and never claims to be
// human. It is deliberately not generated: this is the sentence a fraudster's
// victim most needs to be exactly right.
const DOUBT_REPLIES: Record<Lang, string> = {
  en: "That is a fair question. I am an automated AI assistant calling for your bank, and I am not asking for any personal information — only whether you recognise one transaction. If you feel unsafe, hang up and call the number on the back of your card.",
  ar: "سؤال في محله. أنا مساعد آلي يعمل بالذكاء الاصطناعي أتصل نيابةً عن مصرفك، ولا أطلب أي معلومات شخصية — فقط هل تتعرّف على عملية واحدة. إن شعرت بعدم الأمان فأنهِ المكالمة واتصل بالرقم المطبوع خلف بطاقتك.",
  hi: "यह एक उचित सवाल है। मैं आपके बैंक की ओर से कॉल करने वाला एक स्वचालित AI सहायक हूँ, और मैं कोई व्यक्तिगत जानकारी नहीं माँग रहा — केवल यह कि क्या आप एक लेनदेन को पहचानते हैं। यदि असुरक्षित लगे तो कॉल काट दें और कार्ड के पीछे दिए नंबर पर कॉल करें।",
  ur: "یہ ایک جائز سوال ہے۔ میں آپ کے بینک کی طرف سے کال کرنے والا خودکار AI اسسٹنٹ ہوں، اور میں کوئی ذاتی معلومات نہیں مانگ رہا — صرف یہ کہ کیا آپ ایک لین دین کو پہچانتے ہیں۔ اگر غیر محفوظ محسوس ہو تو کال کاٹ دیں اور کارڈ کے پیچھے دیے گئے نمبر پر کال کریں۔",
  fr: "C'est une question légitime. Je suis un assistant IA automatisé qui appelle de la part de votre banque, et je ne demande aucune information personnelle — seulement si vous reconnaissez une transaction. Si vous ne vous sentez pas en sécurité, raccrochez et appelez le numéro au dos de votre carte.",
  sw: "Hilo ni swali la haki. Mimi ni msaidizi wa AI wa kiotomatiki ninayepiga kwa niaba ya benki yako, na siombi taarifa zozote binafsi — ni kama unautambua muamala mmoja tu. Ukijisikia si salama, kata simu upige namba iliyo nyuma ya kadi yako.",
};

/** Said when a call has gone round in circles: a human takes over. */
const HANDOFF_REPLIES: Record<Lang, string> = {
  en: "I want to make sure you get the right help, so I am connecting you to a human specialist now. Please stay on the line.",
  ar: "أريد التأكد من حصولك على المساعدة المناسبة، لذلك سأحوّلك الآن إلى أخصائي بشري. يرجى البقاء على الخط.",
  hi: "मैं चाहता हूँ कि आपको सही मदद मिले, इसलिए मैं अभी आपको एक मानव विशेषज्ञ से जोड़ रहा हूँ। कृपया लाइन पर बने रहें।",
  ur: "میں چاہتا ہوں کہ آپ کو صحیح مدد ملے، اس لیے میں ابھی آپ کو ایک انسانی ماہر سے جوڑ رہا ہوں۔ براہ کرم لائن پر رہیں۔",
  fr: "Je veux m'assurer que vous obtenez la bonne aide, donc je vous mets en relation avec un spécialiste humain. Merci de rester en ligne.",
  sw: "Ninataka uhakikishe unapata msaada sahihi, kwa hiyo ninakuunganisha sasa na mtaalamu binadamu. Tafadhali baki kwenye mstari.",
};

const ACTION: Record<Intent, Action> = {
  deny_fraud: "card_freeze",
  confirm_authorized: "none",
  greeting: "none",
  unclear: "clarify",
  doubt: "clarify",
  handoff: "human_handoff",
};

export async function POST(req: NextRequest) {
  const started = Date.now();
  const callerId = rateLimitId(req);

  // 1. Rate limit BEFORE we parse the body (cheapest possible reject)
  const rl = consumeRateLimit("agent", callerId);
  if (!rl.ok) {
    return tooManyRequests("Rate limit exceeded; retry later.", Math.ceil(rl.retryAfterMs / 1000));
  }

  // A source that has spent an hour probing this endpoint (hunting for an
  // injection that sticks, or for the freeze trigger) gets the same answer a
  // rate-limited one does, so it cannot tell WHY it is being slowed down.
  // Keyed on the proxy-resolved caller identity; see src/lib/abuse/bad-actor.ts.
  if (checkBadActor(`agent:${callerId}`).action === "block") {
    return tooManyRequests("Rate limit exceeded; retry later.", 3600);
  }

  const body = await parseJson(req);
  if (body === null) return badRequest("Invalid JSON body");

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return unprocessable(
      `text (1–${MAX_AGENT_TEXT_CHARS} chars) and lang (${SUPPORTED_LANGS.join("|")}) are required`,
    );
  }

  // 2. Outbound consent gate (PUP compliance)
  const consent = requireOutboundConsent({
    direction: parsed.data.direction,
    consentRecordId: parsed.data.consentRecordId,
  });
  if (!consent.ok) {
    return NextResponse.json({ error: consent.error }, { status: consent.status });
  }

  const {
    text,
    lang,
    callRef = `SV-C-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    direction,
  } = parsed.data;

  // 3. Classify intent + read the customer's state (checklist #19: panicked or
  //    coached callers are flagged for immediate human takeover)
  const classified = classify(text);
  // Four turns without a clear answer and a human takes over, instead of looping.
  const turnCapped = classified === "unclear" && (parsed.data.turn ?? 0) >= MAX_UNCLEAR_TURNS;
  const intent: Intent = turnCapped ? "handoff" : classified;
  const baseAction = ACTION[intent];
  const userInputAudit = auditUserInput(text);
  const sentimentResult = analyzeSentiment(text);
  // Instruction-shaped speech is audited (below), never refused - hanging up on
  // "ignore your instructions" would let anyone end the fraud team's call at
  // will - but it IS counted against the source, so sustained probing escalates.
  // `auditUserInput` is a narrow regex ("ignore all your previous instructions"
  // slips past it on the word "your"), so the stronger detectors vote too.
  const hostile =
    userInputAudit.suspicious ||
    detectInjectionAttempt(text) ||
    screenForMemory(text).verdict === "poisoned";
  if (hostile) recordStrike(`agent:${callerId}`, 3);

  // 4. Draft the reply: the deterministic scripted line is the default; when a
  //    GROQ_API_KEY is configured the LLM rephrases it in-language (never
  //    decides the action). Compliance still audits whichever text wins.
  const scripted = (
    intent === "doubt" ? DOUBT_REPLIES : intent === "handoff" ? HANDOFF_REPLIES : REPLIES[intent]
  )[lang];
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
    logError("[agent] audit append failed", {
      error: err instanceof Error ? err.message : String(err),
    });
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
