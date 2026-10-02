import "server-only";
/**
 * Centralised configuration — the single place that reads process.env and
 * exposes typed, validated values. Every module imports from here instead of
 * scattering `process.env.X` across the codebase.
 *
 * Benefits:
 *   - One file to audit when deploying to production
 *   - Fail-fast on missing critical vars (optional: call assertConfig() at boot)
 *   - Easy to mock in tests
 *   - No accidental exposure of server-only vars to client bundles
 */

/* ── Language ── */

export const SUPPORTED_LANGS = ["en", "ar", "hi", "ur", "fr", "sw"] as const;
export type Lang = (typeof SUPPORTED_LANGS)[number];

export const LANG_LABEL: Record<Lang, string> = {
  en: "English",
  ar: "العربية",
  hi: "हिन्दी",
  ur: "اردو",
  fr: "Français",
  sw: "Kiswahili",
};

/* ── TTS ── */

export const DAILY_CHAR_LIMIT = 2_000;
export const MAX_TTS_CHARS = 1_024;
export const TTS_CACHE_TTL_MS = 60 * 60 * 1_000; // 1h
export const TTS_CACHE_MAX = 96;

/* ── ASR ── */

export const MAX_ASR_B64_CHARS = 24_000_000; // ≈ 18 MB raw audio
export const MAX_ASR_BODY_BYTES = 34_000_000;

/* ── Agent ── */

export const MAX_AGENT_WORDS = 50;
export const MAX_AGENT_TEXT_CHARS = 600;

/* ── Intervention / SLA ── */

export const SLA_SECONDS = 60;
export const REPLAY_WINDOW_SEC = 300;

/* ── Idempotency ── */

export const IDEMPOTENCY_TTL_HOURS = 24;
export const IDEMPOTENCY_CLAIM_TTL_MS = 30_000;
export const IDEMPOTENCY_POLL_MS = 200;
export const IDEMPOTENCY_MAX_POLL_MS = 8_000;

/* ── Rate limiting ── */

export function rateLimitPerHour(): number {
  return Number(process.env.RATE_LIMIT_PER_HOUR) || 60;
}

/* ── Environment accessors (server-side only) ── */

export const env = {
  /* Database */
  get databaseUrl(): string | undefined { return process.env.DATABASE_URL; },

  /* Clerk */
  get clerkPublishableKey(): string | undefined { return process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY; },
  get clerkSecretKey(): string | undefined { return process.env.CLERK_SECRET_KEY; },

  /* Twilio */
  get twilioAccountSid(): string | undefined { return process.env.TWILIO_ACCOUNT_SID; },
  get twilioApiKeySid(): string | undefined { return process.env.TWILIO_API_KEY_SID; },
  get twilioApiKeySecret(): string | undefined { return process.env.TWILIO_API_KEY_SECRET; },
  get twilioAuthToken(): string | undefined { return process.env.TWILIO_AUTH_TOKEN; },
  get twilioFromNumber(): string | undefined { return process.env.TWILIO_FROM_NUMBER; },

  /* Auth / Webhooks */
  get authSecret(): string | undefined { return process.env.AUTH_SECRET; },
  get webhookSecret(): string | undefined { return process.env.WEBHOOK_SECRET; },

  /* ElevenLabs */
  get elevenLabsApiKey(): string | undefined { return process.env.ELEVENLABS_API_KEY; },
  get elevenLabsDryRun(): boolean { return process.env.ELEVENLABS_DRY_RUN === "true"; },
  get elevenLabsModel(): string { return process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2"; },
  get elevenLabsSttModel(): string { return process.env.ELEVENLABS_STT_MODEL || "scribe_v2"; },
  /** Agent id on the ElevenLabs Agents Platform that serves the live conversation. */
  get elevenLabsAgentId(): string | undefined { return process.env.ELEVENLABS_AGENT_ID; },
  voiceFor(lang: Lang): string | undefined {
    return process.env[`ELEVENLABS_VOICE_${lang.toUpperCase()}`];
  },

  /* Deepgram */
  get deepgramApiKey(): string | undefined { return process.env.DEEPGRAM_API_KEY; },

  /* Groq / Gemini */
  get groqApiKey(): string | undefined { return process.env.GROQ_API_KEY; },
  get groqModel(): string { return process.env.GROQ_MODEL || "qwen/qwen3.8-27b"; },
  get geminiApiKey(): string | undefined { return process.env.GEMINI_API_KEY; },
  get geminiModel(): string { return process.env.GEMINI_MODEL || "gemini-1.5-flash"; },

  /* Supabase */
  get supabaseUrl(): string | undefined { return process.env.SUPABASE_URL; },
  get supabasePublishableKey(): string | undefined { return process.env.SUPABASE_PUBLISHABLE_KEY; },
} as const;

/* ── Derived state ── */

export function isProdVoiceMode(): boolean {
  return !!env.elevenLabsApiKey && !env.elevenLabsDryRun;
}

export type TwilioMode = "api-key" | "auth-token" | "unconfigured";

export function twilioMode(): TwilioMode {
  if (env.twilioAccountSid && env.twilioApiKeySid && env.twilioApiKeySecret && env.twilioFromNumber) return "api-key";
  if (env.twilioAccountSid && env.twilioAuthToken && env.twilioFromNumber) return "auth-token";
  return "unconfigured";
}

export function isTwilioConfigured(): boolean {
  return twilioMode() !== "unconfigured";
}

/* ── Fail-fast check (call once at boot in production) ── */

export function assertCriticalConfig(): string[] {
  const missing: string[] = [];
  const critical = [
    ["AUTH_SECRET", env.authSecret],
    ["WEBHOOK_SECRET", env.webhookSecret],
    ["DATABASE_URL", env.databaseUrl],
    ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", env.clerkPublishableKey],
    ["CLERK_SECRET_KEY", env.clerkSecretKey],
  ] as const;
  for (const [name, val] of critical) {
    if (!val) missing.push(name);
  }
  return missing;
}
