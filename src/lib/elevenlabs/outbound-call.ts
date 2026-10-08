import "server-only";
/**
 * ElevenLabs outbound call placement — the conversation-plane egress for a
 * fraud intervention. This is the ONLY place that calls
 * POST /v1/convai/twilio/outbound-call.
 *
 * The call carries:
 *   - dynamic_variables: sanitised merchant/amount/case data (invariant I-4 —
 *     the sanitiser runs before anything reaches this function)
 *   - conversation_config_override: per-case language, first_message and
 *     voice_id, so the bank signal selects the language at call start (WP-2
 *     step 5). These overrides must be enabled in the agent's platform
 *     settings or the platform silently ignores them.
 *
 * Dry-run mode (ELEVENLABS_DRY_RUN=true) simulates the provider round-trip
 * without network egress — the e2e test and the demo console use this path.
 */

import { env, SUPPORTED_LANGS } from "@/lib/config";
import { elevenLabsFetch } from "@/lib/elevenlabs/egress";
import { VOICEMAIL_INSURER } from "@/lib/outreach-copy";
import { VOCAB, type InstitutionType } from "@/lib/institution-types";
import { asCallCategory, buildSystemPrompt } from "@/lib/call-categories";
import {
  OPENING_DISCLOSURE_AR,
  OPENING_DISCLOSURE_EN,
  OPENING_DISCLOSURE_FR,
  OPENING_DISCLOSURE_HI,
  OPENING_DISCLOSURE_SW,
  OPENING_DISCLOSURE_UR,
} from "@/lib/compliance/policy";

export type OutboundCallParams = {
  toNumber: string;
  language: string;
  merchant?: string;
  amount?: number;
  currency?: string;
  caseRef: string;
  /** Sanitised dynamic variables — see sanitize-untrusted.ts. */
  dynamicVariables: Record<string, unknown>;
  /** The tenant's institution type. Absent means "bank", the default tenant. */
  institution?: InstitutionType;
  /** The tenant's display name (Organization.name) — what the agent introduces itself as. */
  institutionName?: string | null;
  /** WHY the institution is calling; selects the system prompt. Null reads as the default. */
  callCategory?: string | null;
  /**
   * The tenant's OWN phone number on the conversation platform
   * (`Organization.elevenPhoneNumberId`) — the DID the customer's handset shows.
   *
   * When present it REPLACES `ELEVENLABS_PHONE_NUMBER_ID`. That is the point of
   * the field: an institution's fraud alert has to ring from the number their
   * customers already know, and a bank whose alert goes out on a shared platform
   * line is a bank whose customers hang up. Nothing here falls back silently —
   * a caller that has a tenant identity is expected to pass it, and the dial
   * worker refuses the job when the identity could not be read.
   */
  phoneNumberId?: string | null;
};

export type OutboundCallResult = {
  conversationId: string | null;
  callSid: string | null;
  dryRun: boolean;
  /** The phone number identity the call went out on — the tenant's own when it
   *  has one, the deployment default otherwise. Recorded, not guessed, because
   *  the outbox has to say which line the customer actually saw. */
  phoneNumberId?: string | null;
};

function phoneNumberId(): string | null {
  return process.env.ELEVENLABS_PHONE_NUMBER_ID ?? null;
}

function agentId(): string | null {
  return env.elevenLabsAgentId ?? null;
}

function apiKey(): string | null {
  return env.elevenLabsApiKey ?? null;
}

function isDryRun(): boolean {
  return env.elevenLabsDryRun;
}

/** Resolve the voice ID for a language from the environment. Unknown languages
 * have no voice by definition — the dial path gates them through isCallLanguage. */
export function voiceForLanguage(lang: string): string | null {
  return isCallLanguage(lang) ? (env.voiceFor(lang) ?? null) : null;
}

/**
 * The languages a call can actually be placed in. Adding a language here means
 * adding a TTS voice, an agent, and a first message — the three tests over this
 * map fail until all three exist, which is the point.
 */
export const CALL_LANGUAGES = SUPPORTED_LANGS;
export type CallLanguage = (typeof CALL_LANGUAGES)[number];

export function isCallLanguage(lang: string): lang is CallLanguage {
  return (CALL_LANGUAGES as readonly string[]).includes(lang);
}

/**
 * The opening line, per language — COMPOSED from the policy module's disclosure
 * constants rather than restating them.
 *
 * The reason is a drift this file previously had: `compliance/policy.ts`
 * exported `OPENING_DISCLOSURE_AR` as "هذه المكالمة مسجلة لحمايتك" while the
 * message actually spoken here said "يتم تسجيل هذه المكالمة لحمايتك". Two
 * phrasings of one rule, neither referencing the other, so the "server-enforced
 * disclosure" was enforced on a string the customer never hears. Building the
 * message FROM the constant makes that structurally impossible, and the gate
 * asserts the substring on every language.
 *
 * Each message must carry three things: the recorded-call notice, an explicit
 * statement that the caller is an AI rather than a human, and the reason for the
 * call. The Arabic previously failed the middle one — "مساعد الأمان الذكي"
 * ("the intelligent security assistant") is not an AI disclosure.
 *
 * There is deliberately no English fallback. A language without a disclosure
 * cannot be dialled.
 *
 * ur/fr/sw wording needs native-speaker sign-off before a production pilot.
 */
/**
 * The intro sentence after the recording disclosure, per language and
 * institution. The disclosure ("this call is recorded") is unconditional —
 * every category, every tenant — and who is speaking is the only thing that
 * varies: a policyholder must not hear "your bank's … your card".
 */
const INTRO_BANK: Record<CallLanguage, string> = {
  en: "I am your bank's AI security assistant, calling about a transaction on your card.",
  ar: "أنا مساعد الأمان في بنكك المعتمد على الذكاء الاصطناعي، وأتصل بك بخصوص عملية على بطاقتك.",
  hi: "मैं आपके बैंक का AI सुरक्षा सहायक हूं, और आपके कार्ड पर एक लेनदेन के बारे में बात करने के लिए कॉल कर रहा हूं।",
  ur: "میں آپ کے بینک کا AI سیکیورٹی اسسٹنٹ ہوں, اور آپ کے کارڈ پر ایک لین دین کے بارے میں بات کرنے کے لیے کال کر رہا ہوں۔",
  fr: "Je suis l'assistant sécurité IA de votre banque, et je vous appelle au sujet d'une transaction sur votre carte.",
  sw: "Mimi ni msaidizi wa usalama wa AI wa benki yako, nakupigia simu kuhusu muamala kwenye kadi yako.",
};

const INTRO_INSURER: Record<CallLanguage, string> = {
  en: "I am your insurer's AI security assistant, calling about activity on your policy.",
  ar: "أنا مساعد الأمان المعتمد على الذكاء الاصطناعي في شركة التأمين الخاصة بك، وأتصل بك بخصوص نشاط على وثيقتك.",
  hi: "मैं आपकी बीमा कंपनी का AI सुरक्षा सहायक हूं, और आपकी पॉलिसी पर गतिविधि के बारे में बात करने के लिए कॉल कर रहा हूं।",
  ur: "میں آپ کی انشورنس کمپنی کا AI سیکیورٹی اسسٹنٹ ہوں، اور آپ کی پالیسی پر سرگرمی کے بارے میں بات کرنے کے لیے کال کر رہا ہوں۔",
  fr: "Je suis l'assistant sécurité IA de votre assureur, et je vous appelle au sujet d'une activité sur votre police.",
  sw: "Mimi ni msaidizi wa usalama wa AI wa kampuni yako ya bima, nakupigia simu kuhusu shughuli kwenye sera yako.",
};

const OPENING_DISCLOSURE: Record<CallLanguage, string> = {
  en: OPENING_DISCLOSURE_EN,
  ar: OPENING_DISCLOSURE_AR,
  hi: OPENING_DISCLOSURE_HI,
  ur: OPENING_DISCLOSURE_UR,
  fr: OPENING_DISCLOSURE_FR,
  sw: OPENING_DISCLOSURE_SW,
};

/**
 * Resolve the first message for a language and institution, or null when it is
 * not callable. There is deliberately no English fallback for the disclosure —
 * a language without one cannot be lawfully dialed.
 */
export function firstMessageForLanguage(
  lang: string,
  institution: InstitutionType = "bank",
): string | null {
  if (!isCallLanguage(lang)) return null;
  const intro = institution === "insurer" ? INTRO_INSURER[lang] : INTRO_BANK[lang];
  return `${OPENING_DISCLOSURE[lang]}. ${intro}`;
}

/**
 * What an answering machine hears, per language. The agent's
 * `voicemail_detection` tool reads this out (via the `voicemail_message` dynamic
 * variable) and then ends the call, so the conversational agent never burns
 * minutes talking to a mailbox.
 *
 * It is deliberately GENERIC: no amount, no merchant, no case reference. A
 * voicemail box is not the customer - it can be a shared family line, an
 * office assistant or a mailbox someone else can replay - and "your card was
 * used for AED 2,500 at Electronics World" is exactly the detail a scammer
 * wants to hear before ringing back as "the bank". It carries only:
 *   - that the caller is an automated AI assistant (never pass as a human),
 *   - a call to action that uses a number the customer ALREADY HOLDS (the one
 *     on their card) - never a number or link we supply, which a phisher would
 *     imitate,
 *   - the promise never to ask for a PIN or one-time code.
 * An SMS follows via `sendUnreachableSms`.
 *
 * ur/fr/sw wording needs native-speaker sign-off before a production pilot, as
 * with FIRST_MESSAGES.
 */
const VOICEMAIL_MESSAGES: Record<CallLanguage, string> = {
  en: "Hello, this is your bank's automated AI security assistant. We tried to reach you about a recent transaction on your card. If you do not recognise a recent card transaction, please call your bank now using the number on the back of your card. We will never ask for your PIN or one-time passcode. Thank you.",
  ar: "مرحباً، أنا مساعد الأمان الآلي المعتمد على الذكاء الاصطناعي في مصرفك. حاولنا الاتصال بك بخصوص عملية حديثة على بطاقتك. إذا لم تتعرّف على عملية حديثة على بطاقتك، يرجى الاتصال بمصرفك الآن على الرقم المطبوع خلف بطاقتك. لن نطلب منك أبداً رمز PIN أو رمز التحقق لمرة واحدة. شكراً لك.",
  hi: "नमस्ते, मैं आपके बैंक का स्वचालित AI सुरक्षा सहायक हूं। हमने आपके कार्ड पर हाल के एक लेनदेन के बारे में आपसे संपर्क करने की कोशिश की। यदि आप अपने कार्ड पर हाल के किसी लेनदेन को नहीं पहचानते, तो कृपया अपने कार्ड के पीछे दिए नंबर पर अभी अपने बैंक को कॉल करें। हम कभी आपका PIN या वन-टाइम पासकोड नहीं मांगेंगे। धन्यवाद।",
  ur: "ہیلو، میں آپ کے بینک کا خودکار AI سیکیورٹی اسسٹنٹ ہوں۔ ہم نے آپ کے کارڈ پر حالیہ لین دین کے بارے میں آپ سے رابطہ کرنے کی کوشش کی۔ اگر آپ اپنے کارڈ پر کسی حالیہ لین دین کو نہیں پہچانتے تو براہ کرم اپنے کارڈ کے پیچھے دیے گئے نمبر پر ابھی اپنے بینک کو کال کریں۔ ہم کبھی آپ سے PIN یا ون ٹائم کوڈ نہیں مانگیں گے۔ شکریہ۔",
  fr: "Bonjour, je suis l'assistant de sécurité automatisé par IA de votre banque. Nous avons essayé de vous joindre au sujet d'une transaction récente sur votre carte. Si vous ne reconnaissez pas une transaction récente, veuillez appeler votre banque dès maintenant au numéro figurant au dos de votre carte. Nous ne vous demanderons jamais votre code PIN ni votre code à usage unique. Merci.",
  sw: "Habari, mimi ni msaidizi wa usalama wa kiotomatiki wa AI wa benki yako. Tulijaribu kukupigia simu kuhusu muamala wa hivi karibuni kwenye kadi yako. Usipoutambua muamala wa hivi karibuni, tafadhali piga simu kwa benki yako sasa kwa namba iliyo nyuma ya kadi yako. Hatutakuomba kamwe PIN wala msimbo wa matumizi moja. Asante.",
};

/**
 * The voicemail message for a language, or null when it is not callable.
 * `institution` selects the bank wording ("your card") or the insurer wording
 * ("your policy or claim"); anything else is a bank, the tenant default.
 */
export function voicemailMessageForLanguage(
  lang: string,
  institution: InstitutionType = "bank",
): string | null {
  if (!isCallLanguage(lang)) return null;
  return institution === "insurer" ? VOICEMAIL_INSURER[lang] : VOICEMAIL_MESSAGES[lang];
}

export async function placeOutboundCall(params: OutboundCallParams): Promise<OutboundCallResult> {
  const dryRun = isDryRun();

  if (dryRun) {
    // Simulate the provider round-trip. The conversation_id is the join key
    // for the post-call webhook (WP-4) — in dry-run we synthesise a stable
    // one so the case can be correlated end to end.
    return {
      conversationId: `conv_dryrun_${params.caseRef}`,
      callSid: `CA_dryrun_${params.caseRef}`,
      dryRun: true,
      phoneNumberId: null,
    };
  }

  // NB: the locals must not shadow the resolver functions above (a
  // `const agentId = agentId()` here is a TDZ error, not a call).
  const agent = agentId();
  const phoneId = params.phoneNumberId ?? phoneNumberId();
  const key = apiKey();
  if (!agent || !phoneId || !key) {
    throw new Error(
      "ElevenLabs outbound call not configured: set ELEVENLABS_AGENT_ID, ELEVENLABS_PHONE_NUMBER_ID, ELEVENLABS_API_KEY",
    );
  }

  const voiceId = voiceForLanguage(params.language);
  if (!voiceId) {
    throw new Error(`No voice configured for language ${params.language}`);
  }
  // No disclosure in this language means we cannot lawfully open the call, so
  // the dial is refused here rather than answered in a language the customer
  // may not understand.
  const inst = params.institution ?? "bank";
  const firstMessage = firstMessageForLanguage(params.language, inst);
  if (!firstMessage) {
    throw new Error(
      `No opening disclosure configured for language ${params.language}; refusing to dial`,
    );
  }

  // The Dynamic Prompt Router (src/lib/call-categories.ts): the category — the
  // reason the institution is calling — selects the system prompt this call
  // speaks under, composed from the unconditional base rules plus the
  // category's powers and prohibitions. The override must be whitelisted in
  // agent/securevoice.agent.yaml (overrides.conversation_config_override) or
  // the platform silently ignores it and the YAML's default prompt applies.
  const category = asCallCategory(params.callCategory);
  const categoryPrompt = buildSystemPrompt({
    institutionName: params.institutionName || VOCAB[inst].institution,
    institutionType: inst,
    institutionNoun: VOCAB[inst].institution,
    accountNoun: VOCAB[inst].account,
    protectiveAction: VOCAB[inst].protectiveAction,
    category,
    language: params.language,
    amountMinor: params.amount,
    currency: params.currency,
    merchant: params.merchant,
  });

  const body = {
    agent_id: agent,
    agent_phone_number_id: phoneId,
    to_number: params.toNumber,
    conversation_initiation_client_data: {
      // `voicemail_message` is spread LAST so a caller-supplied dynamic variable
      // can never replace what a mailbox hears: the agent's voicemail_detection
      // tool reads exactly this key, and it must stay the generic, PII-free text.
      // `institution_type` / `institution_noun` / `account_noun` are constants
      // from VOCAB, set here (not taken from the caller) so the words the agent
      // uses for the tenant can never be steered by a producer's payload.
      // `call_category` is likewise server-resolved: the case row's value, not
      // anything a producer can re-declare at dial time.
      dynamic_variables: {
        ...params.dynamicVariables,
        institution_type: inst,
        institution_noun: VOCAB[inst].institution,
        account_noun: VOCAB[inst].account,
        call_category: category,
        voicemail_message: voicemailMessageForLanguage(params.language, inst) ?? "",
      },
      conversation_config_override: {
        tts: { voice_id: voiceId },
        agent: {
          language: params.language,
          first_message: firstMessage,
          prompt: { prompt: categoryPrompt },
        },
      },
    },
  };

  const res = await elevenLabsFetch<{ conversation_id?: string; callSid?: string }>({
    path: "/v1/convai/twilio/outbound-call",
    method: "POST",
    body,
    // Outbound dials bill minutes, not TTS chars, so nothing is reserved against
    // the character budget. The throttle is keyed on a constant, NOT on caseRef:
    // it protects the shared vendor account, and a per-case key would let anyone
    // mint a fresh bucket by opening another case.
    billableChars: 0,
    callerId: "dial",
  });

  if (!res.ok) {
    // Breaker-open / quota / retry-exhausted all surface here with a typed
    // status. The dial path treats this as a failed placement, not a silent
    // drop — the caller decides queue-vs-alert per the declared fallback.
    throw new Error(
      `ElevenLabs outbound-call ${res.error.status}: ${res.error.body.slice(0, 300)}`,
    );
  }

  const data = res.data;
  return {
    conversationId: data.conversation_id ?? null,
    callSid: data.callSid ?? null,
    dryRun: false,
    phoneNumberId: phoneId,
  };
}
