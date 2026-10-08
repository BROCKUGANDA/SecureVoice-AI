import "server-only";
import type { Lang } from "./languages";
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

/**
 * Supported conversation languages live in ./languages (client- and edge-safe,
 * no `server-only` marker) so the edge proxy and browser code can import the
 * same list without dragging the server config surface into their bundle.
 */
export { SUPPORTED_LANGS, LANG_LABEL } from "./languages";
export type { Lang } from "./languages";

/* ── TTS ── */

/**
 * Numeric env reader used by the tunables below: a finite, in-range number
 * wins; everything else (unset, NaN, out of range) takes the documented
 * default. Same contract as the hand-rolled getters above, deduplicated.
 */
function numSetting(
  name: string,
  fallback: number,
  min = 0,
  max = Number.POSITIVE_INFINITY,
): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= min && raw <= max ? raw : fallback;
}

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
  /**
   * The SIP address of the platform agent, for INBOUND calls — when a customer
   * rings the institution's fraud line and the conversation plane should answer.
   *
   * Null (unset) is a supported state, not a broken deployment: the inbound
   * route then routes to a human line if the tenant has one, and otherwise plays
   * the safe message and tells the customer to expect a callback. It is never a
   * reason to bridge a customer into nothing.
   */
  get elevenLabsInboundSipUri(): string | null {
    const raw = (process.env.ELEVENLABS_INBOUND_SIP_URI ?? "").trim();
    return raw ? raw : null;
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

  /* LiteLLM */
  get litellmApiKey(): string | undefined {
    return process.env.LITELLM_API_KEY;
  },
  /**
   * Default LiteLLM model.
   *
   * Deliberately NOT an OpenAI model: this deployment routes every inference
   * call through a Groq endpoint or a self-hosted LiteLLM proxy, so the default
   * has to be a model a proxy can actually serve.
   *
   * `llama-3.3-70b-instruct` is chosen for two reasons that matter here:
   *   - Multilingual coverage across the languages the agent actually speaks
   *     (ar, hi, ur, fr, sw). A model strong only on en/es loses the call the
   *     moment the customer answers in Urdu.
   *   - It is permissively licensed and self-hostable on commodity GPUs, so a
   *     LiteLLM proxy can serve it without an upstream vendor relationship.
   *
   * Overridable per deployment with LITELLM_MODEL.
   */
  get litellmModel(): string {
    return process.env.LITELLM_MODEL || "llama-3.3-70b-instruct";
  },
  get litellmBaseUrl(): string {
    return process.env.LITELLM_BASE_URL ?? "http://localhost:4000";
  },
  get litellmTimeoutMs(): number {
    const raw = Number(process.env.LITELLM_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 8_000;
  },
  get litellmTemperature(): number {
    const raw = Number(process.env.LITELLM_TEMPERATURE);
    return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.3;
  },
  get litellmMaxTokens(): number {
    const raw = Number(process.env.LITELLM_MAX_TOKENS);
    return Number.isFinite(raw) && raw > 0 ? raw : 160;
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

  /* ── Deepgram (ASR fallback vendor) ── */
  /** Endpoint host for the listen API; the route appends `/listen`. */
  get deepgramBaseUrl(): string {
    return process.env.DEEPGRAM_BASE_URL ?? "https://api.deepgram.com/v1";
  },
  get deepgramSttModel(): string {
    return process.env.DEEPGRAM_STT_MODEL || "nova-2";
  },
  get deepgramTimeoutMs(): number {
    return numSetting("DEEPGRAM_TIMEOUT_MS", 30_000, 1_000);
  },
  /** Race timeout for the dev-backend ASR path. */
  get asrTimeoutMs(): number {
    return numSetting("ASR_TIMEOUT_MS", 30_000, 1_000);
  },

  /* ── Twilio runtime tunables ── */
  /**
   * The origin configured in the Twilio console for INBOUND webhooks, or null.
   *
   * Only `TWILIO_WEBHOOK_BASE_URL` — never `APP_BASE_URL`. Twilio signs the URL
   * it was told to call, so verifying a signature has to reproduce that URL and
   * nothing else; falling back to the origin the app serves itself at would
   * reject every genuine webhook in a proxied deployment.
   */
  get twilioPublicBaseUrl(): string | null {
    const raw = (process.env.TWILIO_WEBHOOK_BASE_URL ?? "").trim().replace(/\/+$/, "");
    return raw ? raw : null;
  },
  get twilioApiBaseUrl(): string {
    return process.env.TWILIO_API_BASE_URL ?? "https://api.twilio.com";
  },
  get twilioTimeoutMs(): number {
    return numSetting("TWILIO_TIMEOUT_MS", 15_000, 1_000);
  },
  /** Live-fire attestation; see .env.example — necessary but not sufficient. */
  get twilioLiveSend(): boolean {
    return process.env.TWILIO_LIVE_SEND === "true";
  },
  /** TTL for signed TwiML audio URLs served from /api/twilio/audio. */
  get twilioAudioCacheTtlMs(): number {
    return numSetting("TWILIO_AUDIO_CACHE_TTL_MS", 3_600_000, 1_000);
  },
  /**
   * How long an inbound bridge waits for the far end (the agent leg or a human
   * specialist) before Twilio gives up and the route's next instruction runs.
   */
  get inboundDialTimeoutSec(): number {
    return numSetting("INBOUND_DIAL_TIMEOUT_SEC", 20, 5);
  },
  /**
   * The origin Twilio dials back for status callbacks, null when there is no
   * such origin.
   *
   * `TWILIO_WEBHOOK_BASE_URL` wins over `APP_BASE_URL` because the two are
   * genuinely different facts in a real deployment: operators' browsers and
   * Twilio's fleet do not always enter through the same host, and the internal
   * address the app serves itself at is unreachable from a carrier.
   *
   * An unreachable value returns null rather than the value, so no callback URL
   * is attached. That is the production-standard choice, not a convenience: a
   * URL Twilio cannot resolve makes the provider retry a message the customer
   * already received, and leaves the outbox showing an unknown outcome for a
   * delivery that actually happened — which is worse for a compliance record
   * than never having promised the callback.
   */
  get twilioWebhookBaseUrl(): string | null {
    const raw = (process.env.TWILIO_WEBHOOK_BASE_URL ?? process.env.APP_BASE_URL ?? "")
      .trim()
      .replace(/\/+$/, "");
    if (!/^https?:\/\/[^\s/]+$/i.test(raw)) return null;
    const authority = (raw.slice(raw.indexOf("//") + 2).split("/")[0] ?? "").split(":")[0] ?? "";
    const host = authority.replace(/^\[(.*)\]$/, "$1");
    // localhost / loopback / mDNS names exist only inside the network the app
    // is already in, so Twilio can never reach them. Bare IPs are allowed: a
    // VPS with no domain is a real, reachable deployment.
    if (host === "localhost" || host === "::1" || host.endsWith(".local") || /^127\./.test(host))
      return null;
    return raw;
  },

  /* ── Realtime push ── */
  get realtimeNotifyTimeoutMs(): number {
    return numSetting("REALTIME_NOTIFY_TIMEOUT_MS", 1_500, 100);
  },
  /** Grant-token lifetime. Must match REALTIME_TOKEN_TTL_SEC in
   * mini-services/realtime (both sides validate the same timestamp). */
  get realtimeTokenTtlSec(): number {
    return numSetting("REALTIME_TOKEN_TTL_SEC", 60, 10);
  },

  /* ── Dial / interventions ── */
  get dialProbeTimeoutMs(): number {
    return numSetting("DIAL_PROBE_TIMEOUT_MS", 30_000, 1_000);
  },
  get reversalWindowSecs(): number {
    return numSetting("REVERSAL_WINDOW_SECS", 300, 1);
  },

  /* ── CRM adapters ── */
  get crmHttpTimeoutMs(): number {
    return numSetting("CRM_HTTP_TIMEOUT_MS", 3_000, 100);
  },
  get crmRetryDelayMs(): number {
    return numSetting("CRM_RETRY_DELAY_MS", 500, 0);
  },

  /* ── Database & failure handling ── */
  get dbConnectTimeoutMs(): number {
    return numSetting("DB_CONNECT_TIMEOUT_MS", 10_000, 1_000);
  },
  get dbTxRetries(): number {
    return numSetting("DB_TX_RETRIES", 3, 0, 10);
  },
  get dbTxBackoffMs(): number {
    return numSetting("DB_TX_BACKOFF_MS", 25, 0);
  },
  get dbTimeoutRetryAfterSec(): number {
    return numSetting("DB_TIMEOUT_RETRY_AFTER_SEC", 5, 1);
  },
  get replicaLagThresholdMs(): number {
    return numSetting("REPLICA_LAG_THRESHOLD_MS", 2_000, 100);
  },
  get breakerOpenMs(): number {
    return numSetting("BREAKER_OPEN_MS", 30_000, 1_000);
  },

  /* ── Rate-limit housekeeping & pilot intake ── */
  get rateLimitStaleMs(): number {
    return numSetting("RATE_LIMIT_STALE_MS", 7_200_000, 60_000);
  },
  get pilotRateLimitPerHour(): number {
    return numSetting("PILOT_RATE_LIMIT_PER_HOUR", 6, 1);
  },

  /* ── Readiness warning thresholds ── */
  get readyzOutboxWarnSec(): number {
    return numSetting("READYZ_OUTBOX_WARN_SEC", 300, 1);
  },
  get readyzAuditStaleSec(): number {
    return numSetting("READYZ_AUDIT_STALE_SEC", 3_600, 1);
  },

  /* ── SMS verdict window ── */
  get smsReplyWindowMs(): number {
    return numSetting("SMS_REPLY_WINDOW_MS", 86_400_000, 60_000);
  },

  /* ── Queue & scale model ── */
  get queueLeaseMs(): number {
    return numSetting("QUEUE_LEASE_MS", 60_000, 1_000);
  },
  get callRateWindowMs(): number {
    return numSetting("CALL_RATE_WINDOW_MS", 300_000, 1_000);
  },
  get queueBackoffBaseMs(): number {
    return numSetting("QUEUE_BACKOFF_BASE_MS", 250, 0);
  },
  get queueBackoffMaxMs(): number {
    return numSetting("QUEUE_BACKOFF_MAX_MS", 8_000, 0);
  },
  get meanCallSeconds(): number {
    return numSetting("MEAN_CALL_SECONDS", 180, 1);
  },

  /* ── Capacity & admission bands ── */
  get elevenLabsBurstMultiplier(): number {
    return numSetting("ELEVENLABS_BURST_MULTIPLIER", 3, 1, 10);
  },
  get bandEnterConstrainedPct(): number {
    return numSetting("BAND_ENTER_CONSTRAINED_PCT", 0.7, 0.1, 1);
  },
  get bandEnterShedPct(): number {
    return numSetting("BAND_ENTER_SHED_PCT", 0.95, 0.1, 1);
  },
  /** Expected-loss floor (minor units) below which the voice channel sheds. */
  get shedExpectedLossMinor(): number {
    return numSetting("SHED_EXPECTED_LOSS_MINOR", 50_000, 1);
  },

  /* ── Abuse / bad-actor strike ladder ── */
  get abuseBadActorWindowMs(): number {
    return numSetting("ABUSE_BAD_ACTOR_WINDOW_MS", 3_600_000, 1_000);
  },
  get abuseBadActorThrottleAt(): number {
    return numSetting("ABUSE_BAD_ACTOR_THROTTLE_AT", 3, 1);
  },
  get abuseBadActorBlockAt(): number {
    return numSetting("ABUSE_BAD_ACTOR_BLOCK_AT", 6, 1);
  },
  get abuseBadActorBaseBlockMs(): number {
    return numSetting("ABUSE_BAD_ACTOR_BASE_BLOCK_MS", 3_600_000, 1_000);
  },
  get abuseBadActorMaxBlockMs(): number {
    return numSetting("ABUSE_BAD_ACTOR_MAX_BLOCK_MS", 86_400_000, 1_000);
  },
  get abuseBadActorMaxTracked(): number {
    return numSetting("ABUSE_BAD_ACTOR_MAX_TRACKED", 10_000, 100);
  },
  get abuseSlotLeaseMs(): number {
    return numSetting("ABUSE_SLOT_LEASE_MS", 900_000, 1_000);
  },

  /* ── Auth session policy ── */
  get authSessionLifetimeSec(): number {
    return numSetting("AUTH_SESSION_LIFETIME_SEC", 28_800, 300);
  },
  /** Idle logout. The client timer (NEXT_PUBLIC_IDLE_TIMEOUT_MS) should be
   * kept equal to this — see .env.example for the pairing rule. */
  get authIdleTimeoutSec(): number {
    return numSetting("AUTH_IDLE_TIMEOUT_SEC", 900, 60);
  },
  get authCookieCacheSec(): number {
    return numSetting("AUTH_COOKIE_CACHE_SEC", 300, 0);
  },
  get authStepUpWindowSec(): number {
    return numSetting("AUTH_STEP_UP_WINDOW_SEC", 300, 10);
  },
  get authInviteTtlMs(): number {
    return numSetting("AUTH_INVITE_TTL_MS", 259_200_000, 60_000);
  },
  get authMagicLinkTtlMs(): number {
    return numSetting("AUTH_MAGIC_LINK_TTL_MS", 900_000, 60_000);
  },
  // Record-retention TTLs (session row, invite row) are deliberately NOT env
  // knobs: session-policy.ts derives them from the primitives above plus a
  // fixed margin, so the retention window can never be tuned out of sync with
  // the lifetime it must outlive.

  /* ── TTS / Pinecone / telemetry / conformance ── */
  get ttsQuotaRetryAfterSec(): number {
    return numSetting("TTS_QUOTA_RETRY_AFTER_SEC", 3_600, 1);
  },
  get pineconeEmbeddingModel(): string {
    return process.env.PINECONE_EMBEDDING_MODEL || "llama-text-embed-v2";
  },
  get pineconeIndexMaxChars(): number {
    return numSetting("PINECONE_INDEX_MAX_CHARS", 12_000, 100);
  },
  get telemetryFlushDebounceMs(): number {
    return numSetting("TELEMETRY_FLUSH_DEBOUNCE_MS", 50, 0);
  },
  get retentionReportCap(): number {
    return numSetting("RETENTION_REPORT_CAP", 50, 1);
  },
  get conformanceProbeTimeoutMs(): number {
    return numSetting("CONFORMANCE_PROBE_TIMEOUT_MS", 5_000, 100);
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
