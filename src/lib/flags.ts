import "server-only";
/**
 * Feature flags — a single, auditable registry of runtime behaviour switches.
 *
 * Why a registry instead of ad-hoc `process.env.X === "true"` checks: this
 * project already had that pattern scattered (`ELEVENLABS_DRY_RUN`), and it has
 * two costs. You cannot answer "what is switchable in this deployment?" without
 * grepping, and a typo'd env var reads as a disabled feature rather than an
 * error. Here, both are impossible — the set of flags is a compile-time
 * constant, and an unrecognised value is a hard error rather than a silent
 * false.
 *
 * Conventions, matching the existing config surface:
 *   - Env names are `FEATURE_<NAME>`, uppercase snake case.
 *   - Booleans accept exactly "true" / "false" (case-insensitive). Anything else
 *     throws at read time. A typo in a deploy config should fail the deploy.
 *   - Defaults are chosen so the SAFE path is the default: a flag that changes
 *     money, compliance, or auth behaviour defaults to off, never on.
 *   - Server flags are read through this module only. Client-visible flags must
 *     go through `clientFlags()` below, because `process.env` is not populated
 *     in the browser bundle.
 */

/** Every flag this build can switch. Adding one here is the whole ceremony. */
export const FLAG_NAMES = [
  /* ── Realtime ─────────────────────────────────────────────────────────── */

  /**
   * Off by default because realtime is an *accelerator*: it is never the source
   * of truth. With it off, the console reads `/api/console/events` (SSE) and
   * every audit write is unaffected. Turning it on requires
   * REALTIME_INGEST_SECRET to be set — without a secret the realtime service
   * refuses every handshake, so on-without-secret is a silent outage, not a
   * graceful degradation. See `realtimeConfigured()`.
   */
  "realtime",

  /* ── Providers ────────────────────────────────────────────────────────── */

  /**
   * Real ElevenLabs neural voice. Off = the z-ai dev backend, which is what the
   * public demo runs so it never burns quota. This flag mirrors
   * ELEVENLABS_DRY_RUN and exists so the switch is visible in one list; if the
   * two ever disagree, ELEVENLABS_DRY_RUN wins (see `flag()` below), because
   * that is the var the provider client already reads.
   */
  "elevenLabsLive",

  /* ── Compliance ───────────────────────────────────────────────────────── */

  /**
   * PII redaction on log lines, audit rows, and webhook payloads.
   *
   * Defaults ON, and that is deliberate: this project handles bank transcripts
   * in en/ar/hi/ur. Turning redaction off is a debugging affordance for a local
   * run, never a production setting. If you disable it you are knowingly writing
   * customer PII into logs and the audit chain.
   */
  "piiRedaction",

  /* ── Interface ────────────────────────────────────────────────────────── */

  /**
   * The operator console's live activity feed over the websocket transport.
   * Separate from `realtime` so the transport can be proven end-to-end while
   * the feed itself stays on the SSE fallback during a rollout.
   */
  "consoleLiveFeed",

  /* ── Compliance & Safety ──────────────────────────────────────────────── */

  /**
   * Opening disclosure: "this call is being recorded". Required by law in many
   * jurisdictions before any recording begins. Defaults ON — a deployment with
   * this off is knowingly violating wiretapping law, so it must be an explicit
   * choice, and the flag() reader throws on anything other than "true"/"false".
   */
  "complianceDisclosure",

  /**
   * Never request credentials (PIN, password, OTP, CVV) from a caller. Defaults
   * ON — the voice-agent guardrails enforce this, but the flag makes it visible
   * in the registry so a reviewer can answer "what cannot be disabled?" without
   * grepping source for regex.
   */
  "complianceNoSecrets",

  /**
   * PII redaction on every outbound wire (logs, audit rows, webhook payloads).
   * Defaults ON; consolidates COMPLIANCE_PII_REDACTION into the flag registry.
   */
  "compliancePiiRedaction",

  /* ── Deployment ───────────────────────────────────────────────────────── */

  /**
   * Seed the demo case history on first boot. Mirrors SEED_DEMO; the flag is
   * the auditable surface and the env var is the input. Defaults OFF so a
   * fresh deployment is empty, not full of synthetic cases.
   */
  "seedDemo",

  /**
   * Webhook signature verification: when ON (default), an inbound risk signal
   * without a valid SV-Signature is refused before any processing. Turning this
   * OFF is a debugging affordance for a local harness only — it disables source
   * authentication on the ingestion gateway, so it must default to true.
   */
  "webhookStrictSignatures",

  /* ── Telephony ─────────────────────────────────────────────────────────── */

  /**
   * Use Twilio Media Streams + Deepgram + ElevenLabs for the live voice path
   * instead of ElevenLabs ConvAI. Off = current ConvAI path. On = custom
   * WebSocket pipeline with multi-agent routing and JIT AuthZ soft freeze.
   *
   * Defaults OFF because it requires a publicly reachable WebSocket endpoint
   * (`VOICE_STREAM_HOST`/`VOICE_STREAM_PORT`) and a separate worker process.
   */
  "twilioMediaStreams",
] as const;

export type FlagName = (typeof FLAG_NAMES)[number];

/**
 * Default state per flag. Read `realtime` before changing anything here: a
 * default that silently enables a service with no secret turns a missing
 * deployment variable into an outage.
 */
const DEFAULTS: Record<FlagName, boolean> = {
  realtime: false,
  elevenLabsLive: false,
  piiRedaction: true,
  consoleLiveFeed: false,
  complianceDisclosure: true,
  complianceNoSecrets: true,
  compliancePiiRedaction: true,
  seedDemo: false,
  webhookStrictSignatures: true,
  twilioMediaStreams: false,
};

/** Why a flag resolved the way it did — surfaced by `describeFlag()`. */
export type FlagSource = "env" | "default";

function parseBool(envVar: string, raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  // Deliberately loud. `FEATURE_REALTIME=yes` or an empty value from a CI
  // template would otherwise read as "off" and be indistinguishable from a
  // deliberate disable.
  throw new Error(
    `${envVar} must be "true" or "false", got ${JSON.stringify(raw)}. ` +
      `Set it explicitly rather than relying on the default.`,
  );
}

/**
 * Legacy vars that still stand in for a flag, so existing deploys keep the
 * behaviour they were tested with.
 *
 * `invert` exists because ELEVENLABS_DRY_RUN states the opposite of the flag it
 * backs: DRY_RUN=true means "use the dev backend", i.e. live voice is OFF. That
 * inversion is the whole reason this map is explicit rather than a bare lookup.
 */
const LEGACY_OVERRIDES: Partial<Record<FlagName, { envVar: string; invert: boolean }>> = {
  elevenLabsLive: { envVar: "ELEVENLABS_DRY_RUN", invert: true },
  /** COMPLIANCE_PII_REDACTION and FEATURE_PII_REDACTION are the same switch. */
  piiRedaction: { envVar: "COMPLIANCE_PII_REDACTION", invert: false },
  /** COMPLIANCE_OPENING_DISCLOSURE backs the complianceDisclosure flag. */
  complianceDisclosure: { envVar: "COMPLIANCE_OPENING_DISCLOSURE", invert: false },
  /** COMPLIANCE_NO_CREDENTIAL_REQUESTS backs the complianceNoSecrets flag. */
  complianceNoSecrets: { envVar: "COMPLIANCE_NO_CREDENTIAL_REQUESTS", invert: false },
  /** SEED_DEMO is the input for the seedDemo flag. */
  seedDemo: { envVar: "SEED_DEMO", invert: false },
};

/** The env var name a flag reads, e.g. `consoleLiveFeed` → `FEATURE_CONSOLE_LIVE_FEED`. */
function envVarFor(name: FlagName): string {
  return `FEATURE_${name.replace(/([A-Z])/g, "_$1").toUpperCase()}`;
}

/**
 * Read one flag.
 *
 * Order is: legacy var → this registry's var → default. The legacy var wins
 * because the provider client reads `ELEVENLABS_DRY_RUN` directly; if the two
 * disagreed, the flag would report a state the rest of the app does not obey,
 * which is worse than a redundant knob.
 */
export function flag(name: FlagName): boolean {
  const legacy = LEGACY_OVERRIDES[name];
  if (legacy) {
    // Read through a local: an indexed lookup is not narrowed by the guard
    // above, so TS still sees `string | undefined` here.
    const raw = process.env[legacy.envVar];
    if (raw !== undefined) return parseBool(legacy.envVar, raw) !== legacy.invert;
  }
  const raw = process.env[envVarFor(name)];
  if (raw !== undefined) return parseBool(envVarFor(name), raw);
  return DEFAULTS[name];
}

/**
 * Non-throwing read, for code that must not fail on bad config.
 *
 * `flag()` deliberately throws so a deploy typo is loud. That is the right
 * default, but it is wrong inside the audit path: `notifyRealtime()` promises
 * never to throw, because a websocket fan-out must not be able to fail a
 * compliance write. A malformed flag would otherwise propagate straight into
 * `audit-chain.append()`.
 *
 * So the audit path reads through here: on a bad value it takes the conservative
 * default and returns `false`, which for every flag that can reach this function
 * means "off" — the safe direction. The throw is still available to callers that
 * are not on a critical path (the token route), so a typo still surfaces as a
 * 500 rather than passing unnoticed forever.
 */
export function safeFlag(name: FlagName): boolean {
  try {
    return flag(name);
  } catch {
    return DEFAULTS[name];
  }
}

/** Every flag's effective state, for a startup log or a debug route. */
export function allFlags(): Record<FlagName, boolean> {
  return Object.fromEntries(FLAG_NAMES.map((n) => [n, flag(n)])) as Record<FlagName, boolean>;
}

/**
 * Realtime additionally requires a signing secret. The flag alone is not
 * enough, so callers that open a socket should use this rather than `flag()` —
 * otherwise a deployment with the flag on and no secret accepts connections
 * that then fail every authorization, which looks like a network problem.
 *
 * Uses `safeFlag` so a malformed value resolves to the default rather than
 * throwing; see that function for why the audit path needs this.
 */
export function realtimeConfigured(): boolean {
  return safeFlag("realtime") && !!process.env.REALTIME_INGEST_SECRET;
}

/**
 * Flags safe to expose to the browser. A server flag can gate a secret
 * (`realtime` depends on REALTIME_INGEST_SECRET), so only names listed here
 * are ever sent to a client — keep it to flags that control pure UI/transport
 * choice with no server-side dependency.
 */
const CLIENT_SAFE: readonly FlagName[] = ["consoleLiveFeed"];

export function clientFlags(): Record<string, boolean> {
  return Object.fromEntries(CLIENT_SAFE.map((n) => [n, flag(n)]));
}

/** One flag's value plus where it came from. Used by the debug route. */
export function describeFlag(name: FlagName): {
  value: boolean;
  source: FlagSource;
  envVar: string;
} {
  const legacy = LEGACY_OVERRIDES[name];
  if (legacy && process.env[legacy.envVar] !== undefined) {
    return { value: flag(name), source: "env", envVar: legacy.envVar };
  }
  const envVar = envVarFor(name);
  return {
    value: flag(name),
    source: process.env[envVar] !== undefined ? "env" : "default",
    envVar,
  };
}

/* ── Convenience accessors ─────────────────────────────────────────────────── */

/**
 * Opening disclosure gate. Safe defaults to true on a bad value so a typo'd
 * env var never silently disables a legal requirement.
 */
export function openingDisclosureEnabled(): boolean {
  return safeFlag("complianceDisclosure");
}

/**
 * Credential-request gate. Safe defaults to true.
 */
export function noCredentialRequests(): boolean {
  return safeFlag("complianceNoSecrets");
}

/**
 * PII redaction gate. Safe defaults to true.
 */
export function piiRedactionEnabled(): boolean {
  return safeFlag("piiRedaction");
}

/**
 * Webhook signature enforcement. Safe defaults to true — a malformed value
 * does NOT open the ingestion gateway.
 */
export function webhookSignaturesEnforced(): boolean {
  return safeFlag("webhookStrictSignatures");
}

/**
 * Demo seeding. Safe flag: on a bad value, does NOT seed (empty deployment).
 */
export function demoSeedEnabled(): boolean {
  return safeFlag("seedDemo");
}
