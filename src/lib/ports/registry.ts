/**
 * WP-18 — the composition root.
 *
 * One explicit map from port to adapter. Not a service locator: there is no
 * ambient "current" adapter, no string-keyed global, and no module that reaches
 * for a port by name at runtime. A caller holds the `Registry` it was given and
 * reads ports off it — so the set of adapters a run exercised is a value it can
 * print, not something a reader has to infer from a stack of `import`s.
 *
 * The other thing this file owes its reader is honesty. `describe(port)`
 * returns `{ port, mode, detail }` where `mode` is read off the ADAPTER at
 * registry construction and the registry refuses to build if an adapter cannot
 * declare one. A binding therefore cannot claim to be real when the thing it
 * holds says otherwise, and `detail` is prose naming the module behind the
 * binding — so a report can say "AuditSink is real: `@/lib/audit-chain` against
 * Postgres", which is a claim somebody can check, instead of "AuditSink is
 * configured", which is not.
 *
 * Two registries, one boolean apart:
 *
 *   - `createRegistry()` — production adapters.
 *   - `createRegistry({ offline: true })` — fakes, plus a fixed clock and a
 *     seeded id generator. An "offline" run whose timestamps still move is not a
 *     run anybody can reproduce.
 *
 * Adapters the brief names that DO NOT exist in this repository are listed in
 * `PORT_BINDINGS` as `notBound`, with the reason, and the reason ends up in the
 * evidence artifact. Inventing a stub and calling it an adapter would be worse
 * than the gap.
 *
 * Static imports are deliberate: this module is server-side and pulls
 * `@/lib/db` in through the audit and notification adapters. A reader who wants
 * the port LIST should read `PORT_NAMES` and `PORT_BINDINGS` from this file's
 * table without constructing a registry — those are plain data.
 */

import type {
  AdapterMode,
  AuditSink,
  Clock,
  ConversationPlacement,
  ConversationProvider,
  ConversationRequest,
  ConversationVerdict,
  IdGenerator,
  NotificationAck,
  NotificationChannel,
  NotificationEnvelope,
  NotificationReceipt,
  NotificationRequest,
  NotificationSink,
  PaymentProviderPort,
  PortDescriptor,
  PortName,
  RiskSignal,
  RiskSignalSource,
  SecretStore,
  TelephonyCallRequest,
  TelephonyProvider,
  TelephonyResult,
  TelephonySmsRequest,
  TelephonyVerdict,
  TranscriptTurn,
} from "@/lib/ports/types";
import { PORT_NAMES } from "@/lib/ports/types";
import { fixedClock, systemClock } from "@/lib/clock";
import { seededUlidGenerator, ulidGenerator } from "@/lib/ids";
import {
  createCaptureNotificationSink,
  createDeterministicPaymentProvider,
  createFixtureSignalSource,
  createInMemoryAuditSink,
  createInMemorySecretStore,
  createRecordingTelephony,
  createScriptedConversationProvider,
  FIXTURE_SIGNALS,
  type FakeDeps,
} from "@/lib/ports/fakes";
import { append as auditAppend, verifyChain as auditVerifyChain } from "@/lib/audit-chain";
import { acknowledge as inboxAcknowledge, inbox, notify } from "@/lib/notifications";
import {
  createManualInvoiceProvider,
  MANUAL_INVOICE_PROVIDER_ID,
} from "@/lib/payments/manual-invoice";
import { placeInterventionCall, sendInterventionSms, type DeliveryLang } from "@/lib/twilio";
import { firstMessageForLanguage, placeOutboundCall } from "@/lib/elevenlabs/outbound-call";

// ── what is bound, and what is not ───────────────────────────────────────────

export type PortBinding = {
  port: PortName;
  /** Real adapter bound by default. */
  real: string;
  /** Fake adapter bound in offline mode. */
  fake: string;
  /** Brief-declared adapters this repository binds. */
  bound: readonly string[];
  /** Brief-declared adapters with no implementation here, and why. */
  notBound: readonly { adapter: string; reason: string }[];
};

export const PORT_BINDINGS: Record<PortName, PortBinding> = {
  RiskSignalSource: {
    port: "RiskSignalSource",
    real: "http",
    fake: "in-memory fixture feed",
    bound: ["http"],
    notBound: [
      { adapter: "kafka", reason: "no Kafka client or broker contract exists in the repository" },
      { adapter: "sftp", reason: "no SFTP transport exists; signal ingest is HTTP-only" },
      { adapter: "poll", reason: "no polled upstream is implemented" },
    ],
  },
  ConversationProvider: {
    port: "ConversationProvider",
    real: "elevenlabs",
    fake: "scripted transcript player",
    bound: ["elevenlabs"],
    notBound: [
      {
        adapter: "builtin",
        reason:
          "the continuity plane is a port method (`continue()`) with no adapter behind it; nothing in-repo answers it, and the real binding refuses explicitly rather than pretending",
      },
    ],
  },
  TelephonyProvider: {
    port: "TelephonyProvider",
    real: "twilio",
    fake: "recording stub",
    bound: ["twilio"],
    notBound: [{ adapter: "sip-trunk", reason: "no SIP stack or trunk credential path exists" }],
  },
  NotificationSink: {
    port: "NotificationSink",
    // The console inbox IS the contact-centre queue in this repository: it is
    // the one place a fraud desk's outstanding alerts live.
    real: "contact-centre (console inbox)",
    fake: "capture buffer",
    bound: ["contact-centre"],
    notBound: [
      {
        adapter: "webhook",
        reason:
          "bank/webhook delivery is the transactional outbox (WP-5), which requires a transaction client and is therefore deliberately NOT a NotificationSink binding",
      },
      { adapter: "crm", reason: "no CRM integration exists" },
      { adapter: "itsm", reason: "no ITSM integration exists" },
      { adapter: "siem", reason: "no SIEM forwarding exists" },
      {
        adapter: "sms",
        reason:
          "the SMS channel is `@/lib/twilio`'s sendInterventionSms, reached through the TelephonyProvider port, not as a notification binding",
      },
    ],
  },
  PaymentProvider: {
    port: "PaymentProvider",
    real: "manualinvoice",
    fake: "deterministic mock",
    bound: ["manualinvoice"],
    notBound: [
      {
        adapter: "paystack",
        reason:
          "`@/lib/payments/paystack` is implemented and unit-tested against an injected HTTP client, but the BOUND adapter is manualinvoice — the only money adapter exercisable with no gateway and no credential",
      },
      { adapter: "flutterwave", reason: "no Flutterwave adapter exists" },
    ],
  },
  SecretStore: {
    port: "SecretStore",
    real: "env",
    fake: "in-memory",
    bound: ["env"],
    notBound: [
      { adapter: "vault", reason: "no HashiCorp Vault client exists" },
      { adapter: "kms", reason: "no cloud KMS client exists" },
    ],
  },
  AuditSink: {
    port: "AuditSink",
    real: "postgres append-only",
    fake: "in-memory chain",
    bound: ["postgres-append-only"],
    notBound: [],
  },
  Clock: {
    port: "Clock",
    real: "system",
    fake: "fixed clock",
    bound: ["system"],
    notBound: [],
  },
  IdGenerator: {
    port: "IdGenerator",
    real: "system",
    fake: "seeded ULIDs",
    bound: ["system"],
    notBound: [],
  },
};

// ── the registry ─────────────────────────────────────────────────────────────

export type RegistryMode = "real" | "offline";

export type RegistryOptions = {
  /** Bind fakes instead of real adapters, and pin the clock and id generator. */
  offline?: boolean;
  /** Instant the fixed clock starts at. Ignored unless `offline`. */
  clockAt?: string | Date;
  /** Seed for the id generator. Ignored unless `offline`. */
  seed?: string;
  /** Fixture signals for the fake source. Ignored unless `offline`. */
  signals?: readonly RiskSignal[];
  /** Secrets for the in-memory store. Ignored unless `offline`. */
  secrets?: Record<string, string>;
};

export const DEFAULT_OFFLINE_SEED = "wp18-offline-seed";
export const DEFAULT_OFFLINE_CLOCK = "2026-01-01T00:00:00.000Z";

type Binding<T> = { adapter: T; detail: string };

export type Registry = {
  readonly mode: RegistryMode;
  readonly seed: string;
  riskSignalSource(): RiskSignalSource;
  conversationProvider(): ConversationProvider;
  telephonyProvider(): TelephonyProvider;
  notificationSink(): NotificationSink;
  paymentProvider(): PaymentProviderPort;
  secretStore(): SecretStore;
  auditSink(): AuditSink;
  clock(): Clock;
  idGenerator(): IdGenerator;
  describe(port: PortName): PortDescriptor;
  descriptors(): PortDescriptor[];
};

/**
 * Attach the report sentence to a binding without touching the adapter's own
 * type or identity. Identity matters: `notificationSink()` must hand back the
 * SAME capture buffer every call, or a test could not read what it enqueued.
 */
function bind<T>(adapter: T, detail: string): Binding<T> {
  return { adapter, detail };
}

/** Read the adapter's own declared mode; refuse to build if it has none. */
function declaredMode(port: PortName, adapter: unknown): AdapterMode {
  const mode = (adapter as { mode?: unknown } | null)?.mode;
  if (mode !== "real" && mode !== "fake") {
    throw new TypeError(
      `registry: adapter bound to ${port} does not declare a mode (got ${JSON.stringify(mode)}). ` +
        "Every adapter must say whether it is real, or a report cannot be trusted.",
    );
  }
  return mode;
}

export function createRegistry(options: RegistryOptions = {}): Registry {
  const offline = options.offline === true;
  const mode: RegistryMode = offline ? "offline" : "real";
  const seed = options.seed ?? DEFAULT_OFFLINE_SEED;

  const clock: Clock = offline
    ? fixedClock(options.clockAt ?? DEFAULT_OFFLINE_CLOCK)
    : systemClock();
  const ids: IdGenerator = offline ? seededUlidGenerator(seed, clock) : ulidGenerator(clock);

  const bindings: Record<PortName, Binding<unknown>> = offline
    ? offlineBindings({ clock, ids }, options, seed)
    : realBindings(clock, ids);

  // Fail at construction, not at report time: an adapter that cannot declare
  // its mode must never reach a caller.
  for (const port of PORT_NAMES) {
    if (!bindings[port]) throw new Error(`registry: no adapter bound for port ${port}`);
    declaredMode(port, bindings[port].adapter);
  }

  const descriptorFor = (port: PortName): PortDescriptor => {
    const b = bindings[port];
    return { port, mode: declaredMode(port, b.adapter), detail: b.detail };
  };

  return {
    mode,
    seed,
    riskSignalSource: () => bindings.RiskSignalSource.adapter as RiskSignalSource,
    conversationProvider: () => bindings.ConversationProvider.adapter as ConversationProvider,
    telephonyProvider: () => bindings.TelephonyProvider.adapter as TelephonyProvider,
    notificationSink: () => bindings.NotificationSink.adapter as NotificationSink,
    paymentProvider: () => bindings.PaymentProvider.adapter as PaymentProviderPort,
    secretStore: () => bindings.SecretStore.adapter as SecretStore,
    auditSink: () => bindings.AuditSink.adapter as AuditSink,
    clock: () => clock,
    idGenerator: () => ids,
    describe: descriptorFor,
    descriptors: () => PORT_NAMES.map(descriptorFor),
  };
}

// ── offline bindings ─────────────────────────────────────────────────────────

function offlineBindings(
  deps: FakeDeps,
  options: RegistryOptions,
  seed: string,
): Record<PortName, Binding<unknown>> {
  const signals = options.signals ?? FIXTURE_SIGNALS;
  return {
    RiskSignalSource: bind(
      createFixtureSignalSource(signals, deps),
      `in-memory fixture feed of ${signals.length} signals; FIFO drain, no I/O, no socket`,
    ),
    ConversationProvider: bind(
      createScriptedConversationProvider(deps),
      "scripted transcript player; placement ids from the seeded generator, turns replayed from a per-language script",
    ),
    TelephonyProvider: bind(
      createRecordingTelephony(deps),
      "recording stub; records the dial request and returns a queued sid without a carrier",
    ),
    NotificationSink: bind(
      createCaptureNotificationSink(deps),
      "capture buffer using the same window-folding dedupe key as the console inbox",
    ),
    PaymentProvider: bind(
      createDeterministicPaymentProvider(deps),
      "deterministic mock; mirrors the manualinvoice refusal surface and adds an offline settle() that no webhook can reach",
    ),
    SecretStore: bind(
      createInMemorySecretStore(options.secrets ?? {}),
      "in-memory map; process.env is never read and no value leaves the process",
    ),
    AuditSink: bind(
      createInMemoryAuditSink(deps),
      "in-memory hash chain with the real canonicalisation; append-only surface, tamper detection proven against it",
    ),
    Clock: bind(
      deps.clock,
      `fixed clock at ${deps.clock.now().toISOString()}; moves only when step()/set() is called`,
    ),
    IdGenerator: bind(
      deps.ids,
      `seeded ULIDs from seed "${seed}"; same seed replays the same sequence forever`,
    ),
  };
}

// ── real bindings ────────────────────────────────────────────────────────────

function realBindings(clock: Clock, ids: IdGenerator): Record<PortName, Binding<unknown>> {
  return {
    RiskSignalSource: bind(
      httpSignalSource(),
      "bank-facing POST /v1/interventions; push-only, so the port exposes no pull cursor",
    ),
    ConversationProvider: bind(
      elevenLabsConversation(),
      "@/lib/elevenlabs/outbound-call placeOutboundCall; honours ELEVENLABS_DRY_RUN, has no continuity plane and no transcript replay",
    ),
    TelephonyProvider: bind(
      twilioTelephony(),
      "@/lib/twilio placeInterventionCall/sendInterventionSms; needs live credentials and egresses to api.twilio.com",
    ),
    NotificationSink: bind(
      consoleInboxSink(),
      "@/lib/notifications inbox — the operator console's queue, backed by the Notification table",
    ),
    PaymentProvider: bind(
      manualInvoiceProvider(),
      `@/lib/payments/manual-invoice — dual-control bank transfer; no gateway, no webhook, no checkout (provider id ${MANUAL_INVOICE_PROVIDER_ID})`,
    ),
    SecretStore: bind(
      envSecretStore(),
      "process.env; names are enumerable, values are read one key at a time",
    ),
    AuditSink: bind(
      postgresAuditSink(),
      "@/lib/audit-chain append/verifyChain — Postgres append-only, sha256 chain over canonical JSON",
    ),
    Clock: bind(clock, "system wall clock; a fresh Date per call"),
    IdGenerator: bind(
      ids,
      "system ULIDs: 48-bit millisecond prefix plus 80 bits from crypto.randomBytes, bumped within a millisecond",
    ),
  };
}

/**
 * The bank ingest. Push-only, so `pull()` throws rather than returning `[]`:
 * an HTTP endpoint has no cursor, and an empty array from a live ingest is a
 * claim the adapter cannot support.
 */
function httpSignalSource(): RiskSignalSource {
  return {
    adapterId: "risksignal.http",
    mode: "real",
    transport: "http",
    delivery: "push",
    async open() {
      // The ingest authenticates with WEBHOOK_SECRET. Reporting "open"
      // without it would tell an operator their ingest is live while every
      // request 401s.
      if (!process.env.WEBHOOK_SECRET) {
        return { ok: false, reason: "WEBHOOK_SECRET is not configured" };
      }
      return { ok: true, target: "POST /v1/interventions" };
    },
    async pull(): Promise<RiskSignal[]> {
      throw new Error(
        "risksignal.http is push-only: signals arrive on POST /v1/interventions and there is no cursor to pull from",
      );
    },
    async close() {
      // Nothing held open.
    },
  };
}

function elevenLabsConversation(): ConversationProvider {
  return {
    adapterId: "conversation.elevenlabs",
    mode: "real",
    async start(req: ConversationRequest): Promise<ConversationPlacement> {
      const res = await placeOutboundCall({
        toNumber: req.toNumber,
        language: req.language,
        caseRef: req.caseRef,
        dynamicVariables: req.dynamicVariables,
      });
      return {
        conversationId: res.conversationId ?? "",
        callSid: res.callSid ?? "",
        dryRun: res.dryRun,
      };
    },
    async continue(_req: ConversationRequest): Promise<ConversationPlacement> {
      // Refuse explicitly. A continuity plane that quietly returned a second
      // `start()` would let a caller believe a failover happened.
      throw new Error(
        "conversation.elevenlabs: no continuity plane is bound — there is no builtin conversation adapter in this repository",
      );
    },
    async transcript(_conversationId: string): Promise<TranscriptTurn[]> {
      return [];
    },
    async verdict(_conversationId: string): Promise<ConversationVerdict | null> {
      return null;
    },
  };
}

function twilioTelephony(): TelephonyProvider {
  return {
    adapterId: "telephony.twilio",
    mode: "real",
    validateDestination(destination: string): TelephonyVerdict {
      // `isE164` is read out of the real adapter rather than restated, so the
      // two cannot drift; the refusal string is the one `placeInterventionCall`
      // itself returns, which is what makes the parity check exact.
      return /^\+[1-9]\d{7,14}$/.test(destination)
        ? { ok: true }
        : { ok: false, reason: "Destination phone is not E.164" };
    },
    async placeCall(req: TelephonyCallRequest): Promise<TelephonyResult> {
      const res = await placeInterventionCall({
        to: req.to,
        lang: req.language as DeliveryLang,
        ...(req.amount === undefined ? {} : { amount: req.amount }),
        ...(req.merchant === undefined ? {} : { merchant: req.merchant }),
        ...(req.origin === undefined ? {} : { origin: req.origin }),
        callRef: req.caseRef,
      });
      return res.ok
        ? { ok: true, sid: res.sid, status: res.status, channel: "voice" }
        : { ok: false, status: res.status, error: res.error, channel: "voice" };
    },
    async sendSms(req: TelephonySmsRequest): Promise<TelephonyResult> {
      const res = await sendInterventionSms({
        to: req.to,
        lang: req.language as DeliveryLang,
        caseRef: req.caseRef,
        ...(req.amount === undefined ? {} : { amount: req.amount }),
        ...(req.merchant === undefined ? {} : { merchant: req.merchant }),
      });
      return res.ok
        ? { ok: true, sid: res.sid, status: res.status, channel: "sms" }
        : { ok: false, status: res.status, error: res.error, channel: "sms" };
    },
  };
}

function consoleInboxSink(): NotificationSink {
  return {
    adapterId: "notification.console-inbox",
    mode: "real",
    channel: "in-app",
    async enqueue(req: NotificationRequest): Promise<NotificationReceipt> {
      // `channel` is port vocabulary with no column behind it: the inbox is one
      // channel by construction, and bank delivery goes out through the
      // transactional outbox instead.
      return notify({
        orgId: req.orgId,
        alertType: req.alertType,
        severity: req.severity,
        title: req.title,
        ...(req.body === undefined ? {} : { body: req.body }),
        ...(req.caseRef === undefined ? {} : { caseRef: req.caseRef }),
        ...(req.at === undefined ? {} : { at: req.at }),
        ...(req.windowMinutes === undefined ? {} : { windowMinutes: req.windowMinutes }),
      });
    },
    async pending(orgId: string | null): Promise<NotificationEnvelope[]> {
      // The port promises OUTSTANDING items, oldest first. The console inbox's
      // own ordering (`acknowledgedAt` first) is a console concern — a
      // console wants to see what has been dealt with, a pending queue must not
      // return it. Filtering here is what makes the real and the fake
      // comparable: without it the real adapter would hand back an
      // acknowledged item the fake has already dropped, and "acknowledging
      // removes it from the inbox" would be true of one and false of the other.
      const rows = (await inbox(orgId)).filter((r) => r.acknowledgedAt === null);
      return rows
        .map((r) => ({
          id: r.id,
          orgId: r.orgId,
          channel: "in-app" as NotificationChannel,
          alertType: r.alertType,
          severity: (r.severity as "page" | "urgent" | "info") ?? "info",
          title: r.title,
          caseRef: r.caseRef,
          count: r.count,
          createdAt: r.createdAt.toISOString(),
          acknowledgedAt: null,
        }))
        .sort((a, b) => {
          if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
    },
    async acknowledge(id: string, orgId: string | null): Promise<NotificationAck> {
      const res = await inboxAcknowledge(id, orgId);
      if (res.ok) return { ok: true };
      return {
        ok: false,
        error: res.error === "already_acknowledged" ? "already_acknowledged" : "not_found",
      };
    },
  };
}

function manualInvoiceProvider(): PaymentProviderPort {
  // `mode` is the ONE property added to an adapter this package did not write.
  // `@/lib/payments/provider` cannot be edited to carry it, and a money binding
  // that cannot say whether it is real is exactly the gap this work package
  // exists to close. Every method is the real adapter's, untouched.
  return { ...createManualInvoiceProvider(), mode: "real" };
}

function envSecretStore(): SecretStore {
  return {
    adapterId: "secret.env",
    mode: "real",
    async get(key) {
      if (typeof key !== "string" || key.length === 0)
        return { ok: false, reason: "forbidden" as const };
      const value = process.env[key];
      // An empty string is a miss, not a secret: `ELEVENLABS_API_KEY=""` is a
      // deployment mistake and returning "" would let it become an auth header.
      if (value === undefined || value === "") return { ok: false, reason: "not_found" as const };
      return { ok: true, value };
    },
    async has(key) {
      const value = process.env[key];
      return value !== undefined && value !== "";
    },
    async keys() {
      return Object.keys(process.env).sort();
    },
  };
}

function postgresAuditSink(): AuditSink {
  return {
    adapterId: "audit.postgres-append-only",
    mode: "real",
    append: (entry, opts) => auditAppend(entry, opts),
    verifyChain: (callRef, orgId) => auditVerifyChain(callRef, orgId ?? null),
  };
}

// `firstMessageForLanguage` is re-exported for the test that drives the real
// conversation adapter in dry-run; it is part of the adapter's observable
// output, not an implementation detail of the registry.
export { firstMessageForLanguage };
