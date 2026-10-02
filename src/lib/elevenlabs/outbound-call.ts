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

const API = process.env.ELEVENLABS_API_BASE ?? "https://api.elevenlabs.io";

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

/** Resolve the first message for a language from the agent definition. */
export function firstMessageForLanguage(lang: string): string {
  // These mirror agent/securevoice.agent.yaml — kept in sync by agent:apply.
  const messages: Record<string, string> = {
    en: "This call is recorded to protect you. I am your bank's AI security assistant calling about a transaction on your card.",
    ar: "يتم تسجيل هذه المكالمة لحمايتك. أنا مساعد الأمان الذكي في بنكك، وأتصل بك بخصوص عملية على بطاقتك.",
    hi: "यह कॉल आपकी सुरक्षा के लिए रिकॉर्ड की जा रही है। मैं आपके बैंक का AI सुरक्षा सहायक हूं।",
  };
  return messages[lang] ?? messages.en;
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
    throw new Error("ElevenLabs outbound call not configured: set ELEVENLABS_AGENT_ID, ELEVENLABS_PHONE_NUMBER_ID, ELEVENLABS_API_KEY");
  }

  const voiceId = voiceForLanguage(params.language);
  if (!voiceId) {
    throw new Error(`No voice configured for language ${params.language}`);
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
          first_message: firstMessageForLanguage(params.language),
        },
      },
    },
  };

  const res = await fetch(`${API}/v1/convai/twilio/outbound-call`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ElevenLabs outbound-call ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  return {
    conversationId: data.conversation_id ?? null,
    callSid: data.callSid ?? null,
    dryRun: false,
  };
}
