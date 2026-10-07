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

/** Daily synthesis character ceiling per caller. Read per-call from env so it can
 * be tightened without a rebuild. */
export function dailyCharLimit(): number {
  return Number(process.env.DAILY_CHAR_LIMIT) || 2_000;
}
/** Max characters accepted in a single TTS request. */
export function maxTtsChars(): number {
  return Number(process.env.MAX_TTS_CHARS) || 1_024;
}
export const TTS_CACHE_TTL_MS = Number(process.env.TTS_CACHE_TTL_MS) || 60 * 60 * 1_000; // 1h
export const TTS_CACHE_MAX = Number(process.env.TTS_CACHE_MAX) || 96;

/* ── ASR ── */

export const MAX_ASR_B64_CHARS = Number(process.env.MAX_ASR_B64_CHARS) || 24_000_000; // ≈ 18 MB raw audio
export const MAX_ASR_BODY_BYTES = Number(process.env.MAX_ASR_BODY_BYTES) || 34_000_000;

/* ── Agent ── */

export function maxAgentWords(): number {
  return Number(process.env.MAX_AGENT_WORDS) || 50;
}
export const MAX_AGENT_TEXT_CHARS = Number(process.env.MAX_AGENT_TEXT_CHARS) || 600;

/* ── Intervention / SLA ── */

/** SLA seconds before the dial job is claimable. Configurable so a deployment
 * can lengthen or shorten the pre-notification window without a code change. */
export function slaSeconds(): number {
  return Number(process.env.SLA_SECONDS) || 60;
}
export function replayWindowSec(): number {
  return Number(process.env.REPLAY_WINDOW_SEC) || 300;
}

/* ── Idempotency ── */

export const IDEMPOTENCY_TTL_HOURS = Number(process.env.IDEMPOTENCY_TTL_HOURS) || 24;
export const IDEMPOTENCY_CLAIM_TTL_MS = Number(process.env.IDEMPOTENCY_CLAIM_TTL_MS) || 30_000;
export const IDEMPOTENCY_POLL_MS = Number(process.env.IDEMPOTENCY_POLL_MS) || 200;
export const IDEMPOTENCY_MAX_POLL_MS = Number(process.env.IDEMPOTENCY_MAX_POLL_MS) || 8_000;

/* ── Rate limiting ── */

export function rateLimitPerHour(): number {
  return Number(process.env.RATE_LIMIT_PER_HOUR) || 60;
}

/* ── Environment accessors (server-side only) ── */

export const env = {
  /* Database */
  get databaseUrl(): string | undefined {
    return process.env.DATABASE_URL;
  },

  /* Better Auth */
  get betterAuthSecret(): string | undefined {
    return process.env.BETTER_AUTH_SECRET;
  },
  get betterAuthUrl(): string | undefined {
    return process.env.BETTER_AUTH_URL ?? process.env.APP_URL;
  },
  get betterAuthApiKey(): string | undefined {
    return process.env.BETTER_AUTH_API_KEY;
  },

  /**
   * Base URL the app serves itself at. Used for dev fallbacks (e.g. the
   * outbox callback URL when BANK_WEBHOOK_URL is unset). In production
   * BANK_WEBHOOK_URL should always be set.
   */
  get appBaseUrl(): string {
    return process.env.APP_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  },
  /* Twilio */
  get twilioAccountSid(): string | undefined {
    return process.env.TWILIO_ACCOUNT_SID;
  },
  get twilioApiKeySid(): string | undefined {
    return process.env.TWILIO_API_KEY_SID;
  },
  get twilioApiKeySecret(): string | undefined {
    return process.env.TWILIO_API_KEY_SECRET;
  },
  get twilioAuthToken(): string | undefined {
    return process.env.TWILIO_AUTH_TOKEN;
  },
  get twilioFromNumber(): string | undefined {
    return process.env.TWILIO_FROM_NUMBER;
  },

  /* Auth / Webhooks */
  get authSecret(): string | undefined {
    return process.env.AUTH_SECRET;
  },
  get webhookSecret(): string | undefined {
    return process.env.WEBHOOK_SECRET;
  },

  /* ElevenLabs */
  get elevenLabsApiKey(): string | undefined {
    return process.env.ELEVENLABS_API_KEY;
  },
  get elevenLabsDryRun(): boolean {
    return process.env.ELEVENLABS_DRY_RUN === "true";
  },
  get elevenLabsModel(): string {
    return process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2";
  },
  get elevenLabsSttModel(): string {
    return process.env.ELEVENLABS_STT_MODEL || "scribe_v2";
  },
  /** Agent id on the ElevenLabs Agents Platform that serves the live conversation. */
  get elevenLabsAgentId(): string | undefined {
    return process.env.ELEVENLABS_AGENT_ID;
  },
  voiceFor(lang: Lang): string | undefined {
    return process.env[`ELEVENLABS_VOICE_${lang.toUpperCase()}`];
  },

  /* Deepgram */
  get deepgramApiKey(): string | undefined {
    return process.env.DEEPGRAM_API_KEY;
  },

  /* Groq / Gemini */
  get groqApiKey(): string | undefined {
    return process.env.GROQ_API_KEY;
  },
  get groqModel(): string {
    return process.env.GROQ_MODEL || "qwen/qwen3.8-27b";
  },
  get groqBaseUrl(): string {
    return process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1/chat/completions";
  },
  get groqTimeoutMs(): number {
    const raw = Number(process.env.GROQ_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 8_000;
  },
  get groqTemperature(): number {
    const raw = Number(process.env.GROQ_TEMPERATURE);
    return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.3;
  },
  get groqMaxTokens(): number {
    const raw = Number(process.env.GROQ_MAX_TOKENS);
    return Number.isFinite(raw) && raw > 0 ? raw : 160;
  },
  get geminiApiKey(): string | undefined {
    return process.env.GEMINI_API_KEY;
  },
  get geminiModel(): string {
    return process.env.GEMINI_MODEL || "gemini-1.5-flash";
  },
  get geminiBaseUrl(): string {
    return (
      process.env.GEMINI_BASE_URL ??
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    );
  },

  /* ElevenLabs base URL + voice / egress tunables */
  /** Base URL for the ElevenLabs API. Overridable so a gateway or proxy can sit
   * in front of the vendor, and a region move is a config change, not a rebuild. */
  get elevenLabsBaseUrl(): string {
    return process.env.ELEVENLABS_API_BASE_URL ?? "https://api.elevenlabs.io";
  },
  /**
   * TTS voice synthesis timeout in milliseconds. Default 25 s; overridable so a
   * deployment can tighten it for voice SLAs or loosen it for high-latency links.
   */
  get ttsTimeoutMs(): number {
    const raw = Number(process.env.ELEVENLABS_TTS_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 25_000;
  },
  /**
   * ElevenLabs signed-WebSocket URL time-to-live in seconds. Defaults to 900 s
   * (15 min, the vendor maximum). Configurable so a deployment can shorten the
   * credential window.
   */
  get signedUrlTtlSecs(): number {
    const raw = Number(process.env.ELEVENLABS_SIGNED_URL_TTL_SECONDS);
    return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 900;
  },
  /**
   * Voice synthesis parameters for the ElevenLabs TTS request body. Previously
   * hardcoded; env-driven now so a deployment can tune voice clarity per voice.
   */
  get voiceStability(): number {
    const raw = Number(process.env.TTS_VOICE_STABILITY);
    return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.5;
  },
  get voiceSimilarityBoost(): number {
    const raw = Number(process.env.TTS_VOICE_SIMILARITY_BOOST);
    return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.75;
  },
  get voiceUseSpeakerBoost(): boolean {
    return process.env.TTS_VOICE_USE_SPEAKER_BOOST !== "false";
  },
  get voiceDefaultSpeed(): number {
    const raw = Number(process.env.TTS_DEFAULT_VOICE_SPEED);
    return Number.isFinite(raw) && raw > 0 && raw <= 2 ? raw : 1.0;
  },

  /* Supabase */
  get supabaseUrl(): string | undefined {
    return process.env.SUPABASE_URL;
  },
  get supabasePublishableKey(): string | undefined {
    return process.env.SUPABASE_PUBLISHABLE_KEY;
  },

  /* ------------------------------------------------------------------
   * Environment posture.
   *
   * APP_ENV drives the one behaviour that must differ between a
   * pre-production deployment and production: whether outbound
   * side-effects may reach real customers. It is explicit rather than
   * inferred from NODE_ENV so a `staging` deploy can never silently
   * inherit production's permissions.
   *
   *   production  — real telephony + real voice, real customer contact.
   *   staging     — same code, same DB, real voice, but outbound calls and
   *                 SMS are REFUSED (403) so no real customer is dialled.
   *   development — no external calls at all; dry-run voice.
   *
   * Irreversible fraud actions are unaffected: `card_freeze` never commits
   * a freeze in ANY environment (see the route) — it can only stage a
   * reversible request for a human specialist.
   * ---------------------------------------------------------------- */
  get appEnv(): "production" | "staging" | "development" {
    const raw = (process.env.APP_ENV ?? process.env.NODE_ENV ?? "development").toLowerCase();
    return raw === "production" || raw === "staging" ? raw : "development";
  },
  get isProduction(): boolean {
    return this.appEnv === "production";
  },
  get isStaging(): boolean {
    return this.appEnv === "staging";
  },
  /**
   * True when this deployment is allowed to contact a real phone number.
   * Only production. Everything else returns 403 on the outbound path
   * rather than silently no-opping, so a misconfigured deploy fails loudly.
   */
  get canContactRealNumbers(): boolean {
    return this.isProduction;
  },

  /** ISO-4217 currency for intervention signals. Defaults to AED (the demo
   * deployment's market) but is env-driven so a deployment in a different
   * jurisdiction overrides it without a code change. */
  get interventionCurrency(): string {
    return (process.env.INTERVENTION_CURRENCY || "AED").toUpperCase();
  },
  /** Minor units per major unit (e.g. 100 fils per AED dirham, 100 cents per USD
   * dollar). Configurable so exotic-currency deployments are not stuck. */
  get minorUnitsPerMajor(): number {
    const raw = Number(process.env.MINOR_UNITS_PER_MAJOR);
    return Number.isFinite(raw) && raw > 0 ? raw : 100;
  },
} as const;

/* ── Derived state ── */

export function isProdVoiceMode(): boolean {
  return !!env.elevenLabsApiKey && !env.elevenLabsDryRun;
}

export type TwilioMode = "api-key" | "auth-token" | "unconfigured";

export function twilioMode(): TwilioMode {
  if (env.twilioAccountSid && env.twilioApiKeySid && env.twilioApiKeySecret && env.twilioFromNumber)
    return "api-key";
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
    ["BETTER_AUTH_SECRET", env.betterAuthSecret],
    ["BETTER_AUTH_URL", env.betterAuthUrl],
  ] as const;
  for (const [name, val] of critical) {
    if (!val) missing.push(name);
  }
  return missing;
}
