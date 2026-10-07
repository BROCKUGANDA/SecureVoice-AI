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

import { elevenLabsFetch } from "@/lib/elevenlabs/egress";
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
};

export type OutboundCallResult = {
  conversationId: string | null;
  callSid: string | null;
  dryRun: boolean;
};

function phoneNumberId(): string | null {
  return process.env.ELEVENLABS_PHONE_NUMBER_ID ?? null;
}

function agentId(): string | null {
  return process.env.ELEVENLABS_AGENT_ID ?? null;
}

function apiKey(): string | null {
  return process.env.ELEVENLABS_API_KEY ?? null;
}

function isDryRun(): boolean {
  return process.env.ELEVENLABS_DRY_RUN === "true";
}

/** Resolve the voice ID for a language from the environment. */
export function voiceForLanguage(lang: string): string | null {
  return process.env[`ELEVENLABS_VOICE_${lang.toUpperCase()}`] ?? null;
}

/**
 * The languages a call can actually be placed in. Adding a language here means
 * adding a TTS voice, an agent, and a first message — the three tests over this
 * map fail until all three exist, which is the point.
 */
export const CALL_LANGUAGES = ["en", "ar", "hi", "ur", "fr", "sw"] as const;
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
const FIRST_MESSAGES: Record<CallLanguage, string> = {
  en: `${OPENING_DISCLOSURE_EN}. I am your bank's AI security assistant, calling about a transaction on your card.`,
  ar: `${OPENING_DISCLOSURE_AR}. أنا مساعد الأمان في بنكك المعتمد على الذكاء الاصطناعي، وأتصل بك بخصوص عملية على بطاقتك.`,
  hi: `${OPENING_DISCLOSURE_HI}. मैं आपके बैंक का AI सुरक्षा सहायक हूं, और आपके कार्ड पर एक लेनदेन के बारे में बात करने के लिए कॉल कर रहा हूं।`,
  ur: `${OPENING_DISCLOSURE_UR}. میں آپ کے بینک کا AI سیکیورٹی اسسٹنٹ ہوں, اور آپ کے کارڈ پر ایک لین دین کے بارے میں بات کرنے کے لیے کال کر رہا ہوں۔`,
  fr: `${OPENING_DISCLOSURE_FR}. Je suis l'assistant sécurité IA de votre banque, et je vous appelle au sujet d'une transaction sur votre carte.`,
  sw: `${OPENING_DISCLOSURE_SW}. Mimi ni msaidizi wa usalama wa AI wa benki yako, nikukupigia kuhusu muamala kwenye kadi yako.`,
};

/** Resolve the first message for a language, or null when it is not callable. */
export function firstMessageForLanguage(lang: string): string | null {
  return isCallLanguage(lang) ? FIRST_MESSAGES[lang] : null;
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
    };
  }

  // NB: the locals must not shadow the resolver functions above (a
  // `const agentId = agentId()` here is a TDZ error, not a call).
  const agent = agentId();
  const phoneId = phoneNumberId();
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
  const firstMessage = firstMessageForLanguage(params.language);
  if (!firstMessage) {
    throw new Error(
      `No opening disclosure configured for language ${params.language}; refusing to dial`,
    );
  }

  const body = {
    agent_id: agent,
    agent_phone_number_id: phoneId,
    to_number: params.toNumber,
    conversation_initiation_client_data: {
      dynamic_variables: params.dynamicVariables,
      conversation_config_override: {
        tts: { voice_id: voiceId },
        agent: {
          language: params.language,
          first_message: firstMessage,
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
  };
}
