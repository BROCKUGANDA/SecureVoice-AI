import "server-only";
/**
 * Feature flags and compliance invariants — one auditable surface for the
 * question "what can be changed in this deployment, and what cannot?"
 *
 * Why a registry instead of ad-hoc `process.env.X === "true"` checks: this
 * project already had that pattern scattered (`ELEVENLABS_DRY_RUN`), and it has
 * two costs. You cannot answer "what is switchable in this deployment?" without
 * grepping, and a typo'd env var reads as a disabled feature rather than an
 * error. Here, both are impossible — the set of flags is a compile-time
 * constant, and an unrecognised value is a hard error rather than a silent
 * false.
 *
 * ── FLAGS vs INVARIANTS: the distinction, and why it is enforced ──────────────
 * A **flag** picks between two behaviours that are both legitimate. A
 * **invariant** is a guarantee the product owes a customer, a regulator, or the
 * audit chain, and no legitimate deployment chooses to break it. Declaring an
 * invariant as a flag is not a harmless documentation nicety: it is a written
 * promise that setting an env var will change behaviour. When the enforcement is
 * unconditional (and for the four below, it always was — no call site ever
 * consulted the flag), the registry reports a control as OFF while the control
 * still fires. That is a registry that lies to the reviewer it exists to serve,
 * and an operator who sets `COMPLIANCE_NO_CREDENTIAL_REQUESTS=false` in good
 * faith gets a `false` back that describes nothing real.
 *
 * So the four compliance/security controls moved out of `FLAG_NAMES` and into
 * `INVARIANTS` at the bottom of this file, where they stay visible — the
 * registry's purpose is still to answer "what cannot be disabled?" without
 * grepping source, and deleting them would have destroyed exactly that answer.
 * They are reclassified, not removed. `tests/surface/invariants.test.ts` proves
 * every claim in that list against the filesystem, and proves that no invariant
 * name resolves from the environment at all.
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
 *   - **A flag must be honoured by a production path.** Every name in
 *     `FLAG_NAMES` needs an entry in `FLAG_CONSUMERS` naming a real file and the
 *     literal string that file uses to honour it; `tests/flags.test.ts` reads
 *     those files and checks the string is there. That is the generalisation that
 *     stops the class above: a switch nobody consults cannot be declared.
 */

/** Every flag this build can switch. Adding one here is the whole ceremony —
 *  and the compiler then demands a `FLAG_CONSUMERS` entry for it, which is what
 *  keeps a switch nobody honours from being declared at all. */
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
   * that is the var the provider client already reads (`src/lib/config.ts`).
   * The voice path never reads the `FEATURE_ELEVEN_LABS_LIVE` spelling, so this
   * entry is a mirror of a real knob, not a knob of its own.
   */
  "elevenLabsLive",

  /* ── Interface ────────────────────────────────────────────────────────── */

  /**
   * The operator console's live activity feed over the websocket transport.
   * Separate from `realtime` so the transport can be proven end-to-end while
   * the feed itself stays on the SSE fallback during a rollout.
   */
  "consoleLiveFeed",

  /* ── Deployment ───────────────────────────────────────────────────────── */

  /**
   * Seed the demo case history on first boot. Mirrors SEED_DEMO; the flag is
   * the auditable surface and the env var is the input. Defaults OFF so a
   * fresh deployment is empty, not full of synthetic cases.
   *
   * NO TypeScript file reads this. The consumer is the `db-setup` container in
   * `docker-compose.yml:118`, whose command is
   * `bunx prisma migrate deploy && if [ "$SEED_DEMO" = "true" ]; then bun
   * scripts/seed-demo.mjs; fi`. It is recorded in `FLAG_CONSUMERS` as
   * `kind: "compose"` so the consumer gate checks the compose file instead of
   * going blind on the one flag that is genuinely read outside the app.
   */
  "seedDemo",

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
 * What actually honours each flag: a repo-relative file, and the literal string
 * that file uses to honour it. `tests/flags.test.ts` reads every named file and
 * fails if the string is not in it, so an entry cannot be claimed without the
 * code existing, and deleting the code breaks the gate.
 *
 * `kind` is `"src"` for a TypeScript production path and `"compose"` for a value
 * read by a container command. Every flag needs at least one `"src"` consumer
 * unless it is honestly `"compose"`-only, which is asserted, not assumed.
 */
export type FlagConsumer = {
  readonly where: string;
  readonly via: string;
  readonly kind: "src" | "compose";
};

export const FLAG_CONSUMERS: Record<FlagName, readonly FlagConsumer[]> = {
  realtime: [
    { where: "src/lib/realtime.ts", via: "realtimeConfigured", kind: "src" },
    {
      where: "src/app/api/console/realtime-token/route.ts",
      via: "realtimeConfigured",
      kind: "src",
    },
  ],
  elevenLabsLive: [
    // The provider client reads the legacy var directly; that read is the
    // switch. The registry entry exists so it is visible in one list.
    { where: "src/lib/config.ts", via: "ELEVENLABS_DRY_RUN", kind: "src" },
  ],
  consoleLiveFeed: [
    { where: "src/app/api/console/features/route.ts", via: "clientFlags", kind: "src" },
  ],
  seedDemo: [{ where: "docker-compose.yml", via: "SEED_DEMO", kind: "compose" }],
  twilioMediaStreams: [
    { where: "src/worker/dial.ts", via: 'flag("twilioMediaStreams")', kind: "src" },
  ],
};

/**
 * Default state per flag. Read `realtime` before changing anything here: a
 * default that silently enables a service with no secret turns a missing
 * deployment variable into an outage.
 *
 * There are no compliance defaults in this map, and that is the point: a
 * compliance control is not a default, it is a guarantee. See `INVARIANTS`.
 */
const DEFAULTS: Record<FlagName, boolean> = {
  realtime: false,
  elevenLabsLive: false,
  consoleLiveFeed: false,
  seedDemo: false,
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
 *
 * Two entries were REMOVED from this map, and they are the reason this file was
 * wrong before: `COMPLIANCE_OPENING_DISCLOSURE` and
 * `COMPLIANCE_NO_CREDENTIAL_REQUESTS` were mapped onto what are now invariants,
 * which let the registry resolve a value for a control nothing reads. An operator
 * setting either to `false` got `false` back and a lie — the disclosure is still
 * injected and the credential ask is still refused, by code that never consults
 * a flag. Both names are now listed under `retiredEnvVars` on their `INVARIANTS`
 * entry and are read by nothing. `COMPLIANCE_PII_REDACTION` retired the same way.
 */
const LEGACY_OVERRIDES: Partial<Record<FlagName, { envVar: string; invert: boolean }>> = {
  elevenLabsLive: { envVar: "ELEVENLABS_DRY_RUN", invert: true },
  /** SEED_DEMO is the input for the seedDemo flag, read by `db-setup`. */
  seedDemo: { envVar: "SEED_DEMO", invert: false },
};

/** The env var name a flag reads, e.g. `consoleLiveFeed` → `FEATURE_CONSOLE_LIVE_FEED`. */
function envVarFor(name: FlagName): string {
  return `FEATURE_${name.replace(/([A-Z])/g, "_$1").toUpperCase()}`;
}

/* ── Invariants: what cannot be disabled ──────────────────────────────────── */

/**
 * One guarantee, where it is enforced, and what proves it.
 *
 * `enforcedAt[].line` is the line whose text must contain `identifier`. Naming a
 * line AND an identifier is deliberate: a bare path rots silently when the guard
 * moves, and a bare line number rots when anything above it changes. The pair is
 * checkable by `tests/surface/invariants.test.ts`, which reads the file and fails
 * if that line no longer carries that identifier — so this list cannot quietly
 * become fiction the way the flag registry did.
 *
 * `neverConsultsFlags` is the structural half of the claim. These files import
 * nothing from `@/lib/flags`, which is *why* the guarantee is unconditional: the
 * enforcement is not behind a read that could be flipped. The same test asserts
 * that stays true, so re-gating one of these paths on a flag is a build failure
 * rather than a regression nobody notices.
 */
export type EnforcedAt = {
  readonly file: string;
  readonly line: number;
  readonly identifier: string;
};

export type ProvedBy = {
  /** Repo-relative test file that must exist. */
  readonly file: string;
  /** A string the test file must contain — the guardrail token its assertion checks. */
  readonly asserts: string;
};

export type InvariantName =
  | "complianceDisclosure"
  | "complianceNoSecrets"
  | "compliancePiiRedaction"
  | "webhookStrictSignatures";

export type Invariant = {
  readonly name: InvariantName;
  /** One line: what is guaranteed, stated as a property of the running system. */
  readonly guarantees: string;
  readonly enforcedAt: readonly EnforcedAt[];
  readonly provedBy: readonly ProvedBy[];
  /** Why this is not a deployment choice. */
  readonly notConfigurable: string;
  /** Env names that once backed it. None is read by anything, in any code path. */
  readonly retiredEnvVars: readonly string[];
  /** Registry names this control was wrongly declared under, for the audit trail. */
  readonly retiredFlagNames: readonly string[];
  /** Files whose enforcement is unconditional because they read no flag. */
  readonly neverConsultsFlags: readonly string[];
};

export const INVARIANTS: readonly Invariant[] = [
  {
    name: "complianceDisclosure",
    guarantees:
      "Every dialed call opens with the recorded-call disclosure in the language the customer actually hears, and a language without one is not dialable.",
    enforcedAt: [
      { file: "src/lib/compliance/policy.ts", line: 116, identifier: "disclosure" },
      { file: "src/lib/elevenlabs/outbound-call.ts", line: 172, identifier: "OPENING_DISCLOSURE" },
    ],
    provedBy: [
      { file: "tests/unit/compliance-credential-guard.test.ts", asserts: "disclosure_injected" },
      { file: "tests/unit/compliance-disclosure.test.ts", asserts: "OPENING_DISCLOSURE_EN" },
    ],
    notConfigurable:
      "A recorded-call disclosure is a legal requirement in the jurisdictions this product dials into. Offering an env var that turns it off would sell a compliance guarantee and then hand the buyer the switch to break it.",
    retiredEnvVars: ["COMPLIANCE_OPENING_DISCLOSURE", "FEATURE_COMPLIANCE_DISCLOSURE"],
    retiredFlagNames: ["complianceDisclosure"],
    neverConsultsFlags: ["src/lib/compliance/policy.ts", "src/lib/elevenlabs/outbound-call.ts"],
  },
  {
    name: "complianceNoSecrets",
    guarantees:
      "The platform never asks a caller for a PIN, password, OTP, CVV or card number, and a caller who asks the agent for one gets a fixed per-language refusal instead of a drafted reply.",
    enforcedAt: [
      { file: "src/lib/compliance/policy.ts", line: 93, identifier: "asksForCredential" },
      { file: "src/app/api/agent/route.ts", line: 495, identifier: "callerRequestsSecret" },
    ],
    provedBy: [
      {
        file: "tests/unit/compliance-credential-guard.test.ts",
        asserts: "refused:credential_request_pattern",
      },
      { file: "tests/unit/compliance-never-ask.test.ts", asserts: "callerRequestsSecret" },
    ],
    notConfigurable:
      "Refusing to solicit credentials is the entire difference between this product and the scam it calls about. A guardrail that can be switched off by an env var is a phishing tool with a settings page.",
    retiredEnvVars: ["COMPLIANCE_NO_CREDENTIAL_REQUESTS", "FEATURE_COMPLIANCE_NO_SECRETS"],
    retiredFlagNames: ["complianceNoSecrets"],
    neverConsultsFlags: [
      "src/lib/compliance/policy.ts",
      "src/lib/compliance/credential-ask.ts",
      "src/lib/compliance/never-ask.ts",
      "src/app/api/agent/route.ts",
    ],
  },
  {
    name: "compliancePiiRedaction",
    guarantees:
      "Card PANs, UAE IBANs, emails, phone numbers and context-marked OTP/PIN sequences are stripped from logs, audit rows, webhook payloads and vendor egress before those bytes leave the process.",
    enforcedAt: [
      { file: "src/lib/redact.ts", line: 51, identifier: "transcript" },
      { file: "src/lib/compliance/policy.ts", line: 126, identifier: "redactText" },
    ],
    provedBy: [
      { file: "tests/unit/redact.test.ts", asserts: "transcript" },
      { file: "tests/unit/compliance-credential-guard.test.ts", asserts: "pii_redacted" },
    ],
    notConfigurable:
      "These are bank transcripts in en/ar/hi/ur. `src/lib/redact.ts` has never consulted a flag, so the switch was always cosmetic — and it was declared TWICE in the registry, as `piiRedaction` and as `compliancePiiRedaction`, with a comment calling them the same switch. One of the two would report `false` while redaction ran.",
    retiredEnvVars: [
      "COMPLIANCE_PII_REDACTION",
      "FEATURE_PII_REDACTION",
      "FEATURE_COMPLIANCE_PII_REDACTION",
    ],
    retiredFlagNames: ["piiRedaction", "compliancePiiRedaction"],
    neverConsultsFlags: ["src/lib/redact.ts", "src/lib/compliance/policy.ts"],
  },
  {
    name: "webhookStrictSignatures",
    guarantees:
      "A risk signal arriving at the ingestion gateway is refused with 401 unless it carries a valid, in-window SV-Signature HMAC or an unrevoked org-scoped producer key.",
    enforcedAt: [
      { file: "src/app/api/v1/interventions/route.ts", line: 223, identifier: "verifySignature" },
      {
        file: "src/app/api/v1/interventions/route.ts",
        line: 173,
        identifier: "Missing SV-Signature",
      },
    ],
    provedBy: [
      { file: "tests/failure-envelope/failure-envelope.test.ts", asserts: "unauthenticated" },
    ],
    notConfigurable:
      "This is source authentication on the endpoint that stages account freezes. `FEATURE_WEBHOOK_STRICT_SIGNATURES=false` was documented as a local-debug affordance, but an unauthenticated caller who dials is not a debugging convenience, and the route never read the flag anyway — the 401 always fired.",
    retiredEnvVars: ["FEATURE_WEBHOOK_STRICT_SIGNATURES"],
    retiredFlagNames: ["webhookStrictSignatures"],
    neverConsultsFlags: ["src/app/api/v1/interventions/route.ts"],
  },
];

const INVARIANT_NAME_SET = new Set<string>(INVARIANTS.map((i) => i.name));
const FLAG_NAME_SET = new Set<string>(FLAG_NAMES as readonly string[]);

/** Every invariant, for an operator-facing surface. Never for a client bundle. */
export function invariants(): readonly Invariant[] {
  return INVARIANTS;
}

/**
 * A name that was declared as a flag but is a guarantee.
 *
 * Thrown rather than answered with `false`. `flag()` and `safeFlag()` take
 * `FlagName`, and the invariant names are no longer in that union, so the
 * compiler refuses them — verified by the `@ts-expect-error` gate in
 * `tests/flags.test.ts`, which fails to type-check if a name ever leaks back in.
 * This is the defence for the callers the compiler cannot stop: a cast, a JS
 * caller, or a string read from config. Before this, `flag("piiRedaction" as
 * FlagName)` after the removal would have returned `undefined`, which is
 * `false` to every `if` — a registry that silently reports a compliance control
 * as disabled. That is the exact lie this file exists to end.
 */
export class InvariantNotConfigurableError extends TypeError {
  constructor(name: string) {
    super(
      `"${name}" is a compliance invariant, not a flag: it is enforced by code that reads no flag, ` +
        `and it cannot be enabled or disabled from the environment. ` +
        `Read it from INVARIANTS (via invariants()) instead of flag().`,
    );
    this.name = "InvariantNotConfigurableError";
  }
}

function assertConfigurable(name: string): void {
  if (INVARIANT_NAME_SET.has(name)) throw new InvariantNotConfigurableError(name);
  // Also catches a typo'd or unregistered name here, which would otherwise miss
  // `DEFAULTS` and come back as `undefined` — falsy — i.e. read as "off".
  if (!FLAG_NAME_SET.has(name)) {
    throw new TypeError(
      `"${name}" is not a declared flag. Known flags: ${FLAG_NAMES.join(", ")}. ` +
        `An unrecognised name must fail loudly rather than resolve to a default.`,
    );
  }
}

/**
 * Read one flag.
 *
 * Order is: legacy var → this registry's var → default. The legacy var wins
 * because the provider client reads `ELEVENLABS_DRY_RUN` directly; if the two
 * disagreed, the flag would report a state the rest of the app does not obey,
 * which is worse than a redundant knob.
 *
 * Compliance invariants are not readable through this function at all; see
 * `InvariantNotConfigurableError`.
 */
export function flag(name: FlagName): boolean {
  assertConfigurable(name);
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
 * default, which for every flag that can reach this function means "off" — the
 * safe direction. The throw is still available to callers that are not on a
 * critical path (the token route), so a typo still surfaces as a 500 rather than
 * passing unnoticed forever.
 *
 * `InvariantNotConfigurableError` is deliberately NOT swallowed. "Treat an
 * invariant request as the safe default" sounds right and is not: the safe
 * default for a name that is not a flag is `undefined`, and swallowing here would
 * put the lie back into the one path built to be forgiving.
 */
export function safeFlag(name: FlagName): boolean {
  try {
    return flag(name);
  } catch (err) {
    if (err instanceof InvariantNotConfigurableError) throw err;
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

/**
 * One flag's value plus where it came from. Used by the debug route.
 *
 * Invariant names cannot reach this: they are not in `FlagName`, so the
 * compiler refuses the call, and `flag()` — which this delegates to — throws if
 * the refusal is bypassed. There is therefore no path through this function that
 * can report a compliance control as `false`, `undefined`, or "off".
 */
export function describeFlag(name: FlagName): {
  value: boolean;
  source: FlagSource;
  envVar: string;
} {
  assertConfigurable(name);
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

/**
 * The invariants, in the flat shape an operator-facing surface serves.
 *
 * `enforced: true` is a property of the build, not a value read from anything,
 * and `envVarsIgnored` names the vars that used to pretend otherwise so an
 * operator who has one set in a live environment sees it listed as ignored
 * rather than as a setting the system honoured.
 */
export type InvariantSurface = {
  readonly name: InvariantName;
  readonly guarantees: string;
  readonly enforced: true;
  readonly configurable: false;
  readonly enforcedAt: readonly string[];
  readonly provedBy: readonly string[];
  readonly notConfigurable: string;
  readonly envVarsIgnored: readonly string[];
};

export function invariantSurface(): readonly InvariantSurface[] {
  return INVARIANTS.map((i) => ({
    name: i.name,
    guarantees: i.guarantees,
    enforced: true,
    configurable: false,
    enforcedAt: i.enforcedAt.map((e) => `${e.file}:${e.line}`),
    provedBy: i.provedBy.map((p) => p.file),
    notConfigurable: i.notConfigurable,
    envVarsIgnored: i.retiredEnvVars,
  }));
}
