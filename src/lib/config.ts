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
export { SUPPORTED_LANGS } from "./languages";
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
  const raw = process.env[name];
  // An EMPTY value is UNSET, not zero.
  //
  // `Number("")` is 0, and 0 is inside the range of every setting whose
  // minimum is 0 — so a blank environment variable used to be read as "zero
  // milliseconds" for a setting whose documented default was five seconds. The
  // operator typed nothing; the platform took it as an instruction.
  //
  // The contract this function documents has always said "unset, NaN or out of
  // range takes the default", and an empty string is the most common way a
  // variable is unset — `.env.example` ships the placeholders as `NAME=""`.
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** The dial retry ladder that ships as the default — see `env.dialRetryLadderMs`
 * for why a configured replacement can be refused. */
const DIAL_RETRY_LADDER_DEFAULT_MS = [150_000, 300_000, 600_000];
/** The last refused value. One warning PER DISTINCT VALUE: the getter runs per
 * call, so a boolean warn-once would spam-free but also evidence-free — a second
 * operator retuning to a different bad ladder would get silence. */
let dialLadderRefusedRaw: string | null = null;

/** Daily synthesis character ceiling per caller. Read per-call from env so it can
 * be tightened without a rebuild. */
export function dailyCharLimit(): number {
  return Number(process.env.DAILY_CHAR_LIMIT) || 2_000;
}
/** Max characters accepted in a single TTS request. */
export function maxTtsChars(): number {
  return Number(process.env.MAX_TTS_CHARS) || 1_024;
}

/**
 * Synthesis characters one anonymous caller may spend on the PLATFORM ElevenLabs
 * key, per hour. `0` (the default) refuses the request outright — the historically
 * safe behaviour, and the reason this is opt-in.
 *
 * Setting it above zero is what lets the public demo tell the truth. Until now a
 * signed-out visitor got 401 from `/api/tts` and `voice-client` quietly fell back to
 * the browser's `SpeechSynthesis`, so the page claimed a neural voice while the audio
 * was the visitor's own operating system.
 *
 * The window is hourly because that is what the limiter natively enforces: this
 * becomes the bucket's capacity, charged in characters per request. It is a per
 * client-IP bound, not a global one, so it caps what one scraped visitor can drain
 * rather than what the demo costs in aggregate — a deployment that wants a total
 * ceiling needs a counter with a daily row, which an anonymous caller does not have.
 */
export function anonCharPerHour(): number {
  const raw = Number(process.env.TTS_ANON_CHAR_LIMIT_PER_HOUR);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
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
  /**
   * Optional decoy line. When set, an inbound call whose `To` equals this
   * number is held by the voice honeypot instead of being resolved to a tenant.
   * Empty is the safe default: no production behaviour changes until an
   * operator deliberately provisions the trap.
   */
  get twilioHoneypotNumber(): string | undefined {
    const value = process.env.TWILIO_HONEYPOT_NUMBER?.trim();
    return value || undefined;
  },

  /* Auth / Webhooks */
  get authSecret(): string | undefined {
    return process.env.AUTH_SECRET;
  },
  get webhookSecret(): string | undefined {
    return process.env.WEBHOOK_SECRET;
  },
  /**
   * The DEPLOYMENT-INTERNAL ingest secret.
   *
   * `WEBHOOK_SECRET` is shared with every producer — a bank's fraud engine
   * signs inbound signals with it — so a request carrying it proves only that
   * the caller knows a shared secret. It must therefore never be able to
   * CHOOSE a tenant: the ingest refuses an `org_id` from that path.
   *
   * The platform's own console fires a real signal into a real tenant's
   * organisation, so it needs a credential that can. That credential is this
   * one: a separate value, held only by the deployment, never given to a
   * producer, and never sent to a browser. A request signed with it is the
   * platform acting on its own tenant's behalf, which is a different
   * authority from a producer's, and the ingest treats it as such.
   */
  get consoleIngestSecret(): string | undefined {
    return process.env.CONSOLE_INGEST_SECRET;
  },

  /* ElevenLabs */
  get elevenLabsApiKey(): string | undefined {
    return process.env.ELEVENLABS_API_KEY;
  },
  get elevenLabsDryRun(): boolean {
    return process.env.ELEVENLABS_DRY_RUN === "true";
  },
  get commercialUseAttested(): boolean {
    return process.env.ELEVENLABS_COMMERCIAL_USE === "true";
  },
  get elevenLabsModel(): string {
    // Must equal `tts.model_id` in agent/securevoice.agent.yaml. It used to default
    // to eleven_multilingual_v2 while the agent ran eleven_v4_turbo, so the same
    // sentence sounded different in the console preview than on the call, and
    // nothing compared the two. tests/unit/tts-model-resolution.test.ts now asserts
    // the pair per language, so changing one side alone fails CI.
    return process.env.ELEVENLABS_MODEL || "eleven_v4_turbo";
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
  /**
   * Publish each READY tenant document into the agent's OWN knowledge base too,
   * not only into Pinecone. Off unless this says `true`.
   *
   * The default matters more here than anywhere else in this file: attaching a
   * bank's policy text to a platform agent is a write to a shared vendor resource
   * that outlives the request, and a deployment that simply has an ElevenLabs key
   * configured must not acquire it by inheritance. `scripts/agent-apply.ts` is the
   * other half of that resource, so this is opt-in on the same terms as
   * `ELEVENLABS_COMMERCIAL_USE` and `TWILIO_LIVE_SEND`: an explicit `true`, and
   * anything else is off.
   */
  get kbPlatformSync(): boolean {
    return process.env.KB_PLATFORM_SYNC === "true";
  },
  /**
   * Ceiling on the text one platform-KB document may carry (default 200 000 chars).
   *
   * A refused publish is better than a partial one. The alternative — truncating a
   * policy mid-clause so the vendor accepts the call — makes the agent quote half an
   * obligation on a live fraud call and records nothing odd about it. Over the
   * ceiling the document is reported on the row (`platformError`) and the tenant's
   * RAG path is untouched, so the operator raises the ceiling or shortens the
   * document with the reason in front of them.
   */
  get kbPlatformMaxChars(): number {
    return numSetting("KB_PLATFORM_MAX_CHARS", 200_000, 1_000);
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
   * How long the WHOLE TTS fallback ladder may take for one request, measured from
   * the moment synthesis starts and enforced in `synthesizeWithLadder`.
   *
   * This is the value the ladder cannot exceed. `ttsTimeoutMs` bounds one attempt,
   * and the ladder multiplies it: three egress attempts on the primary, up to eight
   * pooled keys, three PlayHT attempts. Bounding only the attempt left the sum
   * unbounded, which on a live call is not a slow response but dead air with the
   * line still open.
   *
   * 10 s is deliberately generous — long enough that a healthy first or second rung
   * always finishes inside it, short enough that a customer is never held in silence
   * past the point where an emergency cue is the better answer. The clock stops the
   * WAIT, not the vendor call: an attempt already in flight is abandoned rather than
   * cancelled, so its cost is still paid. What the budget guarantees is the caller's
   * latency, not the invoice.
   */
  get ttsRequestBudgetMs(): number {
    const raw = Number(process.env.TTS_REQUEST_BUDGET_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
  },

  /**
   * Per-attempt TTS timeout. Default 6 s; overridable so a deployment can tighten it
   * further for voice SLAs or loosen it for high-latency links.
   *
   * It was 25 s, and 25 s is not a timeout on a live call — it is a way to be late
   * with extra steps, because this value multiplies through the fallback ladder rather
   * than bounding it: the egress wrapper makes 3 attempts, the key pool walks up to 8
   * keys, and PlayHT runs its own 3 attempts after that. At 25 s the worst case for one
   * sentence was minutes of dead air while the customer waited, and every rung in
   * between looked healthy because it was merely still trying. 6 s bounds one attempt
   * to roughly the length of the phrase it is synthesising; the ladder's worst case is
   * now ~4 minutes rather than ~17, and the honest next step is a per-request budget
   * that the ladder cannot exceed, which is still open.
   */
  get ttsTimeoutMs(): number {
    const raw = Number(process.env.ELEVENLABS_TTS_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 6_000;
  },
  /**
   * How long a live turn may wait for knowledge-base retrieval before the
   * reply is drafted WITHOUT it (default 400 ms).
   *
   * The budget is small on purpose and it is a deadline, not a retry: this sits
   * inside the ~2 s first-audio window that `src/worker/voice-stream.ts` holds,
   * so a slow vector query is worth less than nothing — the customer hears
   * silence while their policy document is found. Retrieval that misses the
   * deadline falls through to exactly the un-grounded reply this code produced
   * before the knowledge base existed.
   */
  get ragRetrievalTimeoutMs(): number {
    const raw = Number(process.env.RAG_RETRIEVAL_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 400;
  },
  /** Ceiling on the characters of retrieved text a single turn may receive. */
  get ragContextMaxChars(): number {
    const raw = Number(process.env.RAG_CONTEXT_MAX_CHARS);
    return Number.isFinite(raw) && raw > 0 ? raw : 1200;
  },
  /**
   * Total wall-clock a live turn may spend trying LLM providers (default 1500 ms).
   *
   * This is what makes failover safe to have. Each provider carries its own
   * timeout, so a chain of them is unbounded unless something caps the TURN:
   * without a budget, a Groq that times out at 3 s followed by a Gemini at 8 s
   * replaces a fast scripted reply with eleven seconds of dead air on the phone.
   * The drafter therefore never STARTS an attempt it cannot finish inside this.
   */
  get llmTurnBudgetMs(): number {
    const raw = Number(process.env.LLM_TURN_BUDGET_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 1_500;
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
    // 0.7, not 0.5. This default disagreed with every other statement of the
    // voice — the comment above it, and the pitch copy in src/lib/deck.ts
    // ("We tuned stability at 0.7 for consistency, similarity boost at 0.75,
    // and style at 0.3"). The code shipped 0.5, so the product was describing a
    // voice setting it was not using: lower stability means more expressive
    // variance between utterances, and this agent reads money back to a
    // frightened cardholder. Env-overridable, so a deployment that set it keeps
    // its own value.
    //
    // The deck copy that motivated this comment is gone (2026-10-16, claims audit): it
    // quoted these worker defaults as though they were the shipped agent's settings, and
    // named a `style` parameter that exists nowhere. `agent/securevoice.agent.yaml` is
    // still 0.5 / 0.8 — two planes, two tunings, both now stated where they are true.
    return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.7;
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
  /**
   * The silence Deepgram waits after the caller's last syllable before it sends the
   * `UtteranceEnd` message (`utterance_end_ms` on the live listen URL).
   *
   * This is the knob `caller_stop_to_agent_audio` depends on. Without it the
   * platform never receives an end-of-utterance signal at all — the request is
   * never made, so the span has no start instant to measure from — which is the
   * exact gap recorded in `tests/telemetry/spans-producers.test.ts`.
   *
   * Never zero. Zero is Deepgram's "disable this message" value, so a mis-set knob
   * would turn a published latency budget off while every code path still looked
   * instrumented: the silently-empty measurement this file family exists to
   * prevent. The floor is therefore 1,000 ms, which is also what Deepgram's own
   * guidance asks for (with `interim_results=true`, which both listen URLs already
   * send). Out-of-range values fall back to the default rather than reaching the
   * vendor, because an invalid query parameter fails the entire listen request —
   * a dead ASR leg on a live fraud call, not a degraded metric.
   */
  get deepgramUtteranceEndMs(): number {
    return numSetting("DEEPGRAM_UTTERANCE_END_MS", 1_000, 1_000, 10_000);
  },
  /** Race timeout for the dev-backend ASR path. */
  get asrTimeoutMs(): number {
    return numSetting("ASR_TIMEOUT_MS", 30_000, 1_000);
  },
  /**
   * Ceiling on a plausible `caller_stop_to_agent_audio` sample, in ms.
   *
   * That span joins two different clocks: an audio offset Deepgram reports
   * (`last_word_end`) mapped onto this process's wall clock by the instant this
   * process first wrote to the stream. A stale anchor — a reconnect mid-utterance,
   * an adopted pooled socket, a message that belongs to a stream that no longer
   * exists — can therefore yield a gap of minutes, and a 40 s "turn latency" is not
   * a slow turn, it is a broken derivation. Refusing it and logging the reason
   * above error level is worth more than a sample that would move the published
   * p95 in whichever direction the artefact happened to point.
   *
   * Floored at 1 s so it cannot be configured to zero (a zero would switch the
   * budget off while pretending to measure it) and capped at 60 s, which is the
   * whole conversation-level budget this span sits inside.
   */
  get voiceCallerStopMaxMs(): number {
    return numSetting("VOICE_CALLER_STOP_MAX_MS", 15_000, 1_000, 60_000);
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
  /**
   * The dial retry ladder in ms — how long a failed dial job waits before each
   * successive attempt. Read from `DIAL_RETRY_LADDER_MS` (comma-separated) so a
   * deploy can retune dial backoff without a rebuild; `src/lib/scale/queue.ts`
   * exports the result as `DIAL_RETRY_LADDER_MS`. The default is the ladder that
   * was previously hard-coded there ([150s, 300s, 600s]), so nothing changes
   * until someone sets the var.
   *
   * This ladder is bounded from outside by a carrier rule, not by taste:
   * carriers flag a number that re-dials inside five minutes as robocall spam
   * and start sending every later call to voicemail — the one outcome a
   * fraud-intervention call cannot afford. Attempts land at t0, t0+L1,
   * t0+L1+L2 with ±20% jitter, so the first two waits must sum to more than
   * `CALL_RATE_WINDOW_MS` even at the bottom of the jitter band:
   *   0.8 × (L1 + L2) > CALL_RATE_WINDOW_MS.
   * A configured ladder that violates it is REFUSED — the default is used and a
   * console.warn names the value, the rule and the window at boot. A silent
   * refusal would be exactly the knob-that-does-nothing this file's audit
   * removed the others for; a loud one gives the operator the fix. Malformed
   * input (non-numeric, zero, negative, empty rungs) is refused the same way.
   *
   * Fewer rungs than `MAX_DIAL_ATTEMPTS` is legal: `backoffBaseMs` clamps to
   * the last rung, so a two-rung ladder just repeats the second wait.
   */
  get dialRetryLadderMs(): number[] {
    const raw = (process.env.DIAL_RETRY_LADDER_MS ?? "").trim();
    if (!raw) return [...DIAL_RETRY_LADDER_DEFAULT_MS];
    const rungs = raw.split(",").map((s) => Number(s.trim()));
    const malformed = rungs.length === 0 || rungs.some((n) => !Number.isFinite(n) || n <= 0);
    const firstTwo = (rungs[0] ?? 0) + (rungs[1] ?? rungs[0] ?? 0);
    const carrierUnsafe = !malformed && 0.8 * firstTwo <= this.callRateWindowMs;
    if (malformed || carrierUnsafe) {
      if (dialLadderRefusedRaw !== raw) {
        dialLadderRefusedRaw = raw;
        console.warn(
          `config: DIAL_RETRY_LADDER_MS="${raw}" refused (${
            malformed
              ? "rungs must be positive finite ms, comma-separated"
              : `first two waits must satisfy 0.8 × (L1+L2) > CALL_RATE_WINDOW_MS = ${this.callRateWindowMs}ms`
          }) — using the default [${DIAL_RETRY_LADDER_DEFAULT_MS.join(", ")}]. ` +
            "Retuning dial backoff into the carrier's robocall window strips every later call to voicemail.",
        );
      }
      return [...DIAL_RETRY_LADDER_DEFAULT_MS];
    }
    return rungs;
  },
  /**
   * How long a staged soft freeze waits for a second actor before the sweep
   * escalates it (`src/lib/freeze-window.ts`).
   *
   * The default was 300s while `src/app/llms.txt/route.ts` — the file an answer
   * engine quotes verbatim, and the one a bank's compliance reviewer can fetch
   * without an account — published a 24-hour hold. One of the two had to be wrong.
   * The window IS the promise, so the promise is now the default: this is a fraud
   * desk's decision window, and five minutes is not one a specialist can honour —
   * the escalation page would count how many holds nobody reached in time rather
   * than alert on the one that matters.
   *
   * Still an operator knob: a deployment that wants a tighter window sets
   * `REVERSAL_WINDOW_SECS`, and the published text is rendered from this value so
   * the two cannot drift apart again.
   */
  get reversalWindowSecs(): number {
    return numSetting("REVERSAL_WINDOW_SECS", 86_400, 1);
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

  /* ── Pilot mode ──────────────────────────────────────────────────────────
   *
   * The pilot's own tunables. Every one of them is a DECISION an operator
   * makes per deployment — how long the kill-switch state is trusted, how long
   * a blocked dial waits before it is looked at again, how many cases the
   * console's waiting list shows — and a decision that lives in a source file
   * is a decision that needs a deploy to change.
   */
  get pilotSwitchCacheMs(): number {
    return numSetting("PILOT_SWITCH_CACHE_MS", 5_000, 0);
  },
  get pilotBlockRetryMinMs(): number {
    return numSetting("PILOT_BLOCK_RETRY_MIN_MS", 60_000, 1_000);
  },
  get pilotBlockRetryMaxMs(): number {
    return numSetting("PILOT_BLOCK_RETRY_MAX_MS", 86_400_000, 60_000);
  },
  /**
   * How long a job waits when the pilot is in SHADOW mode.
   *
   * Long enough that a shadow deployment is not re-deciding every queued case
   * every minute, short enough that a switch out of shadow takes effect
   * promptly.
   */
  get pilotShadowRetryMs(): number {
    return numSetting("PILOT_SHADOW_RETRY_MS", 300_000, 1_000);
  },
  /**
   * How long a job waits when the CHARTER refuses it.
   *
   * Long on purpose: the charter is a decision an operator makes in the
   * deployment configuration, and a job that re-decides every minute while an
   * operator works out what to do is noise in the queue and in the audit chain.
   */
  get pilotCharterRetryMs(): number {
    return numSetting("PILOT_CHARTER_RETRY_MS", 3_600_000, 60_000);
  },
  get pilotWaitingListLimit(): number {
    return numSetting("PILOT_WAITING_LIST_LIMIT", 25, 1, 1_000);
  },
  /**
   * The floor under the cap's reset countdown.
   *
   * The countdown is how long the operator has before the cap refills, and a
   * zero would read as "the cap resets NOW" for a cap that resets at
   * midnight. One minute is the smallest value that still means "not yet".
   */
  get pilotCapResetFloorSec(): number {
    return numSetting("PILOT_CAP_RESET_FLOOR_SEC", 60, 1);
  },
  /**
   * How long the dial worker holds a claim across a carrier call.
   *
   * It has to outlast the longest call the platform places plus the handover,
   * and it is the number that decides how long a dead worker's job waits to
   * be picked up again — so it is a deployment decision, not a constant.
   */
  get dialWorkerCallLeaseMs(): number {
    return numSetting("DIAL_WORKER_CALL_LEASE_MS", 900_000, 60_000);
  },
  /** The telephony breaker's failure threshold, per deployment. */
  get breakerFailureThreshold(): number {
    return numSetting("BREAKER_FAILURE_THRESHOLD", 5, 1);
  },
  /** The telephony breaker's half-open probe count, per deployment. */
  get breakerHalfOpenProbes(): number {
    return numSetting("BREAKER_HALF_OPEN_PROBES", 1, 1);
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
  /* ── pgvector transcript RAG ── */
  /**
   * Embedding model for case transcripts. OpenAI `text-embedding-3-small`
   * (1536 dims) matches the `vector(1536)` column in the migration; any model
   * with a different width breaks the stored vectors and is the operator's
   * problem to migrate. Kept env-driven so the value can change without a
   * rebuild, exactly like PINECONE_EMBEDDING_MODEL.
   */
  get ragEmbeddingModel(): string {
    return process.env.RAG_EMBEDDING_MODEL ?? "text-embedding-3-small";
  },
  /** Characters fed to one embedding call. Long transcripts are chunked (see
   *  src/lib/knowledge/transcript-embeddings.ts); this bounds one chunk. */
  get ragEmbeddingMaxChars(): number {
    return numSetting("RAG_EMBEDDING_MAX_CHARS", 4_000, 500);
  },
  /** Max chunks embedded per transcript. A bound so one long call cannot burn
   *  the embedding budget on its own; the remaining tail is not indexed. */
  get ragEmbeddingMaxChunks(): number {
    return numSetting("RAG_EMBEDDING_MAX_CHUNKS", 4, 1, 64);
  },
  /** pgvector transcript RAG is gated behind OPENAI_API_KEY, the same way
   *  Pinecone is gated behind PINECONE_API_KEY. Absence means nothing has
   *  left the building; presence is the operator's explicit opt-in. */
  get ragEmbeddingsConfigured(): boolean {
    return (process.env.OPENAI_API_KEY ?? "").length > 8;
  },
  get conformanceProbeTimeoutMs(): number {
    return numSetting("CONFORMANCE_PROBE_TIMEOUT_MS", 5_000, 100);
  },
} as const;

/* ── Derived state ── */

export function isProdVoiceMode(): boolean {
  return !!env.elevenLabsApiKey && !env.elevenLabsDryRun;
}

/**
 * What a surface should say the voice path IS.
 *
 * Reading the API key alone is the bug this exists to stop: the egress guard refuses
 * every live vendor call until the commercial-use attestation is set, so a
 * deployment with a key and no attestation answers the caller with the emergency cue
 * while its own status endpoint reports `elevenlabs`. Measured on securevoiceai.me
 * 2026-10-19 — `X-Voice-Source: emergency`, 0.48 s, byte-identical for different
 * sentences — while the status surface still named ElevenLabs as the provider.
 *
 * So the label names the rung that will actually answer, not the credential that
 * exists.
 */
export function voiceProviderLabel(): string {
  if (!env.elevenLabsApiKey) return "z-ai-dev (no key configured)";
  if (env.elevenLabsDryRun) return "z-ai-dev (dry-run)";
  if (!env.commercialUseAttested) {
    return "emergency-cue (ElevenLabs refused: ELEVENLABS_COMMERCIAL_USE unset)";
  }
  return "elevenlabs";
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
