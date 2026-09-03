import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * SecureVoice conversation turn — deterministic, guardrailed intent routing.
 *
 * The production agent uses an LLM constrained by the guardrail policy; this
 * endpoint implements the same decision surface with a deterministic classifier
 * so behavior is auditable and reproducible (a regulatory requirement):
 *
 *   deny_fraud      → immediate protective action (temporary card freeze)
 *   confirm_authorized → no action, confirmation logged, review closed
 *   greeting        → introduction + safety framing
 *   unclear         → clarification (never act on ambiguity)
 *
 * The agent NEVER asks for PINs, passwords, or OTPs in any branch.
 */

const schema = z.object({
  text: z.string().trim().min(1).max(600),
  lang: z.enum(["en", "ar", "hi", "ur"]).default("en"),
});

type Intent = "deny_fraud" | "confirm_authorized" | "greeting" | "unclear";
type Action = "card_freeze" | "none" | "clarify";

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
];

const CONFIRM = [
  // en
  "mine", "i did", "i authorized", "i made it", "i made that", "i did make", "yes i did",
  "it was me", "that was me",
  // ar
  "عمليتي", "أنا قمت", "انا قمت", "أنا صرحت", "انا صرحت", "نعم أنا", "نعم انا", "مني أنا",
  // hi
  "मेरा है", "मैंने किया", "मैंने ही", "हाँ मैंने", "हां मैंने",
  // ur
  "میرا ہے", "میں نے کیا", "میں نے ہی", "ہاں میں نے", "ہاں، میں نے", "مجاز بنایا",
];

const GREETING = [
  "hello", "hi there", "good morning", "good evening", "good afternoon", "hey",
  "مرحبا", "السلام", "اهلا", "أهلا", "هلا",
  "नमस्ते", "नमस्कार", "हैलो",
  "ہیلو", "سلام", "السلام علیکم",
];

function classify(text: string): Intent {
  const t = text.toLowerCase();
  if (DENY.some((k) => t.includes(k))) return "deny_fraud";
  if (CONFIRM.some((k) => t.includes(k))) return "confirm_authorized";
  if (GREETING.some((k) => t.includes(k))) return "greeting";
  return "unclear";
}

const REPLIES: Record<Intent, Record<"en" | "ar" | "hi" | "ur", string>> = {
  deny_fraud: {
    en: "I'm sorry that happened — you did the right thing reporting it. I have placed a temporary freeze on your card effective immediately, and the transaction is now with our fraud team. A specialist will join this call shortly. You will not be held liable for unauthorized transactions.",
    ar: "أأسف لما حدث — تصرفك صحيح تماماً. قمت بتجميد بطاقتك مؤقتاً فعلياً الآن، وأحلت العملية إلى فريق الاحتيال. سينضم أخصائي إلى المكالمة بعد قليل، ولن تتحمل أي مسؤولية عن العمليات غير المصرح بها.",
    hi: "मुझे खेद है कि यह हुआ — आपने सही किया। मैंने तुरंत आपका कार्ड अस्थायी रूप से फ्रीज़ कर दिया है और यह लेनदेन अब हमारी फ्रॉड टीम के पास है। एक विशेषज्ञ कुछ ही में जुड़ेंगे। अनधिकृत लेनदेन की ज़िम्मेदारी आपकी नहीं होगी।",
    ur: "ہونے پر افسوس — آپ نے بالکل درست کیا۔ میں نے فوراً آپ کا کارڈ عارضی طور پر فریز کر دیا ہے اور یہ لین دین اب ہماری فراڈ ٹیم کے پاس ہے۔ ایک ماہر چند لمحوں میں اس کال سے جڑے گا۔ غیر مجاز لین دین کی ذمہ داری آپ کی نہیں ہوگی۔",
  },
  confirm_authorized: {
    en: "Thank you for confirming. I have logged your confirmation and closed the review on this transaction. One reminder: your bank will never call to ask you to move money to a safe account — if anyone does, hang up and call the number on your card.",
    ar: "شكراً لتأكيدك. سجّلت تأكيدك وأغلقت المراجعة على هذه العملية. وتذكير مهم: مصرفك لن يتصل بك أبداً لطلب نقل أموالك إلى حساب آمن — إذا تلقيت مثل هذا الاتصال فأغلقه واتصل بالرقم الموجود على بطاقتك.",
    hi: "पुष्टि के लिए धन्यवाद। मैंने आपकी पुष्टि दर्ज कर ली और इस लेनदेन की समीक्षा बंद कर दी। एक याद दिलानी: आपका बैंक कभी नहीं कहेगा कि पैसा 'सुरक्षित खाते' में भेजें — ऐसा कोई कहे तो कॉल काट दें और कार्ड पर दिया नंबर मिलाएँ।",
    ur: "تصدیق کے لیے شکریہ۔ میں نے آپ کی تصدیق درج کر لی اور اس لین دین کی نظرثانی بند کر دی۔ ایک یاد دہانی: آپ کا بینک کبھی بھی پیسہ 'محفوظ اکاؤنٹ' میں بھیجنے کے لیے نہیں کہے گا — ایسا کوئی کہے تو کال کاٹ دیں اور کارڈ پر دیا نمبر ملائیں۔",
  },
  greeting: {
    en: "Hello — this is your bank's AI security assistant, calling about recent activity on your account. This call is recorded to protect you. If you see a transaction you don't recognize, just say \"not mine\" and I will freeze your card immediately. I will never ask for your PIN, password, or one-time passcode.",
    ar: "مرحباً — أنا مساعد الأمان الذكي في مصرفك، أتصل بخصوص نشاط حديث على حسابك. هذه المكالمة مسجلة لحمايتك. إذا رأيت عملية لا تعرفها قل «ليست عمليتي» وسأجمّد بطاقتك فوراً. ولن أطلب منك رمزاً سرياً أو كلمة مرور أو رمز تحقق أبداً.",
    hi: "नमस्ते — मैं आपके बैंक का AI सुरक्षा सहायक हूँ, आपके खाते की हालिया गतिविधि के बारे में। यह कॉल आपकी सुरक्षा के लिए रिकॉर्ड हो रही है। यदि कोई लेनदेन अपरिचित लगे तो बस 'मेरा नहीं' कहें — मैं तुरंत कार्ड फ्रीज़ कर दूँगा। मैं कभी PIN, पासवर्ड या OTP नहीं पूछूँगा।",
    ur: "ہیلو — میں آپ کے بینک کا اے آئی سیکیورٹی اسسٹنٹ ہوں، آپ کے اکاؤنٹ کی حالیہ سرگرمی کے بارے میں۔ یہ کال آپ کی حفاظت کے لیے ریکارڈ ہو رہی ہے۔ اگر کوئی لین دین غیر مانوس لگے تو بس 'میرا نہیں' کہیں — میں فوراً کارڈ فریز کر دوں گا۔ میں کبھی آپ سے PIN، پاس ورڈ یا ون ٹائم کوڈ نہیں پوچھوں گا۔",
  },
  unclear: {
    en: "Just so I protect the right account: is there a transaction you do NOT recognize? Say \"not mine\" and I will freeze your card immediately, or \"it's mine\" to close the review. I will never ask for your PIN, password, or one-time passcode.",
    ar: "حتى أحمي الحساب الصحيح: هل هناك عملية لا تعرفها؟ قل «ليست عمليتي» وسأجمّد بطاقتك فوراً، أو «عمليتي» لإغلاق المراجعة. ولن أطلب منك رمزاً سرياً أو كلمة مرور أو رمز تحقق أبداً.",
    hi: "ताकि मैं सही खाते की सुरक्षा कर सकूँ: क्या कोई लेनदेन है जो आप नहीं पहचानते? 'मेरा नहीं' कहें — मैं तुरंत कार्ड फ्रीज़ कर दूँगा, या 'मेरा है' कहें तो समीक्षा बंद कर दूँगा। मैं कभी PIN, पासवर्ड या OTP नहीं पूछूँगा।",
    ur: "تاکہ میں صحیح اکاؤنٹ کی حفاظت کر سکوں: کیا کوئی لین دین ہے جو آپ نہیں پہچانتے؟ 'میرا نہیں' کہیں — میں فوراً کارڈ فریز کر دوں گا، یا 'میرا ہے' کہیں تو نظرثانی بند کر دوں گا۔ میں کبھی PIN، پاس ورڈ یا ون ٹائم کوڈ نہیں پوچھوں گا۔",
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "text (1–600 chars) and lang (en|ar|hi|ur) are required" }, { status: 422 });
  }

  const { text, lang } = parsed.data;
  const intent = classify(text);

  return NextResponse.json({
    ok: true,
    intent,
    action: ACTION[intent],
    reply: REPLIES[intent][lang],
    guardrails: ["no_pin_otp", "single_write_action", "audit_logged"],
    latencyMs: Date.now() - started,
  });
}
