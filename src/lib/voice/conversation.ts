/**
 * Conversational state machine for the media-stream voice plane.
 *
 * ElevenLabs is not triggered on every LLM token — it is triggered only at a
 * few points decided by this state machine: the opening greeting (T+0), the
 * response after a final transcript, a capped silence nudge, and the terminal
 * closing after an Authorization outcome. Triggering at the wrong time makes
 * the agent talk over the customer, loop, or emit dead air.
 *
 * This module is deliberately PURE (no WebSocket, no vendors) so those rules —
 * including the barge-in interrupt while the AI is SPEAKING, and the
 * never-over-paused-audio silence nudge — are unit-testable without a live
 * call. The worker (src/worker/voice-stream.ts) applies the returned action.
 *
 *   idle ──greeting()──▶ speaking ──onSpeechEnd()──▶ listening
 *                          │  ▲                          │
 *                          │  └──── onSilence() (≤3) ────┘ (dead-air nudge)
 *                     onBargeIn() ◀── customer talks ── (speaking → listening,
 *                       clears Twilio buffer + cancels the TTS stream)
 *                             │
 *                          markThinking() ── route ── (reply speaks → loop)
 */
export type ConvLang = "en" | "ar" | "hi" | "ur" | "fr" | "sw";
export type Phase = "idle" | "speaking" | "listening" | "thinking";

/** The opening line spoken at T+0, per language: disclosure + the question. */
export const OPENING: Record<ConvLang, string> = {
  en: "Hello? This call is recorded. I am your bank's security assistant calling about a transaction on your card. Did you authorize it?",
  ar: "مرحبًا؟ هذا الاتصال مسجَّل. أنا مساعد الأمن لمصرفك، أتصل بخصوص عملية على بطاقتك. هل أجريتها أنت؟",
  hi: "नमस्ते? यह कॉल रिकॉर्ड की जा रही है। मैं आपके बैंक का सुरक्षा सहायक हूँ, आपके कार्ड के एक लेन-देन के बारे में बात करने बुला रहा हूँ। क्या यह आपने किया था?",
  ur: "سلام؟ یہ کال ریکارڈ کی جا رہی ہے۔ میں آپ کے بینک کا سیکیورٹی اسسٹنٹ ہوں، آپ کے کارڈ کے ایک لین دین کے بارے میں بات کرنے بلایا ہوں۔ کیا یہ آپ نے کیا تھا؟",
  fr: "Bonjour ? Cet appel est enregistré. Je suis l'assistant sécurité de votre banque, j'appelle au sujet d'une opération sur votre carte. L'avez-vous autorisée ?",
  sw: "Habari? Simu hii inarekodiwa. Mimi ni msaidizi wa usalama wa benki yako, nakupigia kuhusu muamala kwenye kadi yako. Je, uliidhinisha?",
};

/** The silence nudge for a caller who answers but says nothing. */
export const NUDGE: Record<ConvLang, string> = {
  en: "Hello? Are you there? I cannot hear you.",
  ar: "مرحبًا؟ هل أنت هناك؟ لا أسمعك.",
  hi: "नमस्ते? क्या आप वहाँ हैं? मैं आपको नहीं सुन पा रहा हूँ.",
  ur: "سلام؟ کیا آپ وہاں ہیں؟ میں آپ کو نہیں سن سکتا۔",
  fr: "Bonjour ? Êtes-vous là ? Je ne vous entends pas.",
  sw: "Habari? Wepo? Sikuskii.",
};

/** How many silence nudges per turn before the worker stops re-prompting (dead-air guard). */
export const MAX_NUDGES = 3;

// Each method returns the specific worker action it needs (a line to speak, or
// a barge-in), or `null` to keep listening. The worker applies the side
// effects (speak via ElevenLabs, or clear Twilio and cancel the stream); this
// class only decides.

export class ConversationState {
  phase: Phase = "idle";
  private nudges = 0;
  constructor(private readonly lang: ConvLang) {}

  private line(table: Record<ConvLang, string>): string {
    return table[this.lang] ?? table.en;
  }

  /** T+0 opening greeting. Idempotent: `null` once the call is already underway. */
  greeting(): { speak: string } | null {
    if (this.phase !== "idle") return null;
    this.phase = "speaking";
    return { speak: this.line(OPENING) };
  }

  /** The AI's turn finished draining to the phone line. */
  onSpeechEnd(): void {
    if (this.phase === "speaking") this.phase = "listening";
  }

  /**
   * The AI begins a spoken turn (a routed reply). `markThinking()` left the
   * phase as "thinking" while the reply text was being chosen; this moves it to
   * "speaking" so barge-in is live again and the nudge stays suppressed until
   * the turn drains.
   */
  beginSpeaking(): void {
    this.phase = "speaking";
  }

  /**
   * The customer started talking. If the AI was still SPEAKING this is a
   * barge-in: stop the AI turn and return `{ bargeIn: true }` so the worker
   * clears Twilio's buffer and cancels the ElevenLabs stream mid-utterance.
   * Otherwise the customer is simply answering, so keep listening.
   */
  onBargeIn(): { bargeIn: true } | null {
    if (this.phase !== "speaking") return null;
    this.phase = "listening";
    return { bargeIn: true };
  }

  /** A complete answer arrived and is being routed. Resets the dead-air budget. */
  markThinking(): void {
    this.phase = "thinking";
    this.nudges = 0;
  }

  /**
   * The customer has been silent. Prompt them — but only while LISTENING, and
   * only a bounded number of times per turn so the agent never loops
   * "are you there?" into the void. Never nudges while the AI is speaking:
   * the AI talking over the customer reads as glitchy and interrupts people
   * mid-sentence.
   */
  onSilence(): { speak: string } | null {
    if (this.phase !== "listening") return null;
    if (this.nudges >= MAX_NUDGES) return null;
    this.nudges += 1;
    this.phase = "speaking";
    return { speak: this.line(NUDGE) };
  }
}

/* ---------------------------------------------------------------------------
 * The remaining fixed lines the media-stream worker speaks.
 *
 * They live here rather than in the worker because the pre-warm path
 * (src/worker/prewarm.ts → src/lib/voice/warm-audio.ts) synthesises them at
 * the DIALING state, before the customer answers. A table the warmer cannot
 * import is a table that stays cold on the first call of every language, so
 * the lines and the machine that speaks them are the same module.
 * ------------------------------------------------------------------------- */

/**
 * Spoken confirmation that a protective action was taken.
 *
 * Two rules govern this copy, in every language, because it is the sentence
 * with the most legal consequence in the whole call:
 *
 *   1. "TEMPORARILY restricted", never "frozen"/"blocked"/"closed". The brief is
 *      explicit that irreversible account actions are the institution's human
 *      fraud team's decision, not the agent's.
 *   2. "A human specialist will review" — the human-in-the-loop step is stated
 *      out loud, not implied.
 *
 * It is per-language for the same reason the emergency fallback is: this is the
 * moment the customer learns what has happened to their money, and reading it in
 * a language they did not choose is how a compliance-correct action becomes a
 * customer complaint.
 */
export const FREEZE_CONFIRMATION: Record<ConvLang, string> = {
  en: "Thank you. I have temporarily restricted your card to protect your account. A human fraud specialist will review this shortly.",
  ar: "شكرًا لك. لقد قيّدت بطاقتك مؤقتًا لحماية حسابك. سيقوم أخصائي الاحتيال بمراجعة الأمر قريبًا.",
  hi: "धन्यवाद। आपके खाते की सुरक्षा के लिए मैंने आपके कार्ड पर अस्थायी रोक लगा दी है। एक मानव विशेषज्ञ जल्द ही इसकी समीक्षा करेगा।",
  ur: "شکریہ۔ آپکے اکاؤنٹ کی حفاظت کے لیے میں نے آپ کے کارڈ پر عارضی پابندی لگا دی ہے۔ ایک انسانی ماہر جلد اس کا جائزہ لے گا۔",
  fr: "Merci. Nous avons temporairement restreint votre carte pour protéger votre compte. Un spécialiste de la fraude examinera cela prochainement.",
  sw: "Asante. Tumeweka kizuizi cha muda kwenye kadi yako kulinda akaunti yako. Mtaalamu wa udanganyifu atakagua hivi karibuni.",
};

/** Holding line for a caller routed to a human without a fraud claim. */
export const HOLDING_FOLLOWUP: Record<ConvLang, string> = {
  en: "I understand. A fraud specialist will follow up shortly.",
  ar: "فهمت. سيتواصل معك أخصائي الاحتيال قريبًا.",
  hi: "मैं समझ गया। एक विशेषज्ञ जल्द ही आपसे संपर्क करेगा।",
  ur: "میں سمجھ گیا۔ ایک ماہر جلد آپ سے رابطہ کرے گا۔",
  fr: "Je comprends. Un spécialiste vous rappellera prochainement.",
  sw: "Nimeelewa. Mtaalamu atakupigia simu karibuni.",
};

/**
 * Holding line for a caller who sounds distressed.
 *
 * Deliberately leads with the offer of a human rather than a reassurance script.
 * The Support Through Difficult Moments scope says bereavement, illness and job
 * loss are handed to a qualified person — so the first thing this caller should
 * hear is that a person is coming, not an agent trying to keep them on the line.
 */
export const HOLDING_EMPATHY: Record<ConvLang, string> = {
  en: "I am sorry you are going through this. I will connect you with a specialist who can help. Please stay on the line.",
  ar: "أعتذر عما تمر به. سأوصلك بأخصائي يمكنه المساعدة. يرجى البقاء على الخط.",
  hi: "मुझे खेद है कि आप इससे गुज़र रहे हैं। मैं आपको एक विशेषज्ञ से जोड़ दूँगा जो मदद कर सकता है। कृपया लाइन पर रहें।",
  ur: "مجھے افسوس ہے کہ آپ اس سے گزار رہے ہیں۔ میں آپ کو ایک ماہر سے ملاتا ہوں جو مدد کر سکتا ہے۔ براہ کرم لائن پر رہیں۔",
  fr: "Je suis désolé que vous traversiez cela. Je vous mets en relation avec un spécialiste qui pourra vous aider. Veuillez rester en ligne.",
  sw: "Pole sana kwa hayo unayopitia. Nitakuunganisha na mtaalamu anayeweza kukusaidia. Tafadhali endelea kwenye simu.",
};

/**
 * The last-resort line: what the customer hears when every AI and TTS path has
 * failed. Per-language, and that is not a nicety.
 *
 * This is the sentence that tells someone their money is being protected. In
 * English it is at least legible to the person who caused the outage. Spoken to
 * an Urdu, Hindi, Arabic or Swahili caller in English, it is unintelligible at
 * the exact moment they most need to understand what has happened to their
 * account — which is why the multilingual variants are first-class here rather
 * than an English string with a TODO.
 *
 * The copy is deliberately the SAME claim in every language: a temporary hold,
 * human review follows, contact the bank on the number in their card or policy
 * documents. It must never promise a freeze, a refund, or a final outcome —
 * those are the institution's human fraud team to decide.
 */
export const EMERGENCY_FALLBACK: Record<ConvLang, string> = {
  en: "We are experiencing technical difficulties. To protect your account, we have placed a temporary hold. A specialist will call you back. Please contact your bank using the number on your card.",
  ar: "نواجه صينا بعض الصعوبات التقنية. لحماية حسابك، وضعنا حجزًا مؤقتًا. سيعاود أخصائي الاتصال بك. يرجى الاتصال ببنكك باستخدام الرقم الموجود على بطاقتك.",
  hi: "हमें कुछ तकनीकी कठिनाइयों का सामना करना पड़ रहा है। आपके खाते की सुरक्षा के लिए, हमने अस्थायी रोक लगा दी है। एक विशेषज्ञ आपको वापस कॉल करेगा। कृपया अपने कार्ड पर दिए नंबर पर अपने बैंक को कॉल करें।",
  ur: "ہمیں کچھ تکنیکی مشکلات کا سامنا کرنا پڑ رہا ہے۔ آپکے اکاؤنٹ کی حفاظت کے لیے ہم نے عارضی پابندی لگا دی ہے۔ ایک ماہر آپ کو واپس کال کرے گا۔ براہ کرم اپنے کارڈ پر دیے گئے نمبر پر اپنے بینک کو کال کریں۔",
  fr: "Nous rencontrons des difficultés techniques. Pour protéger votre compte, nous avons placé une retenue temporaire. Un spécialiste vous rappellera. Veuillez contacter votre banque avec le numéro indiqué sur votre carte.",
  sw: "Tunakabiliwa na tatizo la kiteknolojia. Ili kulinda akaunti yako, tumeweka kizuizi cha muda. Mtaalamu atakupigia simu. Tafadhali wasiliana na benki yako kwa nambari iliyo kwenye kadi yako.",
};
