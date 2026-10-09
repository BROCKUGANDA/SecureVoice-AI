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
