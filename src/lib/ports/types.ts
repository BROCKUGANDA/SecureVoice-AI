/**
 * WP-18 — port INTERFACES. This file contains no implementations and imports
 * no concrete adapter.
 *
 * A port is the vocabulary a domain rule is allowed to speak. What sits behind
 * it — Postgres, ElevenLabs, Twilio, `process.env` — is not part of the
 * contract, which is the only reason a test can replace it without the domain
 * rule noticing.
 *
 * Three rules govern this file, and they are the reason it looks the way it
 * does:
 *
 *   1. **No adapter imports.** Only `import type`, and only of other *port*
 *      vocabulary (`@/lib/payments/provider` is the WP-13 port definition, not
 *      a gateway). A type-only import is erased at compile time, so pulling
 *      `PaymentProvider` from here costs the caller nothing and drags no
 *      gateway module into the bundle.
 *   2. **`Clock` and `IdGenerator` are ports too.** They are the two the rest
 *      of the system used to reach for implicitly — `Date.now()` and
 *      `Math.random()`. Leaving them implicit means every timestamp, every
 *      ordering decision and every generated id is a wall-clock value, and an
 *      evidence bundle is then only reproducible by accident. As injected
 *      ports, the same run is byte-identical twice.
 *   3. **Every adapter declares its own `mode`.** An adapter cannot be
 *      mistaken for the real thing, and the registry's descriptor is derived
 *      from the adapter rather than asserted beside it. A fake that quietly
 *      claimed `mode: "real"` is exactly the defect this makes impossible to
 *      write by accident.
 */

import type {
  ChargeResult,
  CheckoutRequest,
  CheckoutSession,
  Money,
  PaymentProvider,
  RefundRequest,
  RefundResult,
  StoredAuthorization,
  StoredEntitlement,
  WebhookVerification,
} from "@/lib/payments/provider";
import type { AuditEntry, ChainVerification } from "@/lib/audit-chain";

/** Re-exported so a caller needs one import to speak every money port. */
export type {
  ChargeResult,
  CheckoutRequest,
  CheckoutSession,
  Money,
  PaymentProvider,
  RefundRequest,
  RefundResult,
  StoredAuthorization,
  StoredEntitlement,
  WebhookVerification,
};

// ── port metadata ────────────────────────────────────────────────────────────

/** Every port in the WP-18 brief. The registry must bind all nine. */
export const PORT_NAMES = [
  "RiskSignalSource",
  "ConversationProvider",
  "TelephonyProvider",
  "NotificationSink",
  "PaymentProvider",
  "SecretStore",
  "AuditSink",
  "Clock",
  "IdGenerator",
] as const;

export type PortName = (typeof PORT_NAMES)[number];

/**
 * Whether an adapter is the production thing or a stand-in for it. Declared on
 * every adapter — see rule 3 in the file header.
 */
export type AdapterMode = "real" | "fake";

/** The adapters the brief names for each port, verbatim. */
export const DECLARED_ADAPTERS: Record<PortName, readonly string[]> = {
  RiskSignalSource: ["http", "kafka", "sftp", "poll"],
  ConversationProvider: ["elevenlabs", "builtin"],
  TelephonyProvider: ["twilio", "sip-trunk"],
  NotificationSink: ["webhook", "crm", "itsm", "siem", "contact-centre", "sms"],
  PaymentProvider: ["paystack", "manualinvoice", "flutterwave"],
  SecretStore: ["env", "vault", "kms"],
  AuditSink: ["postgres-append-only"],
  Clock: ["system"],
  IdGenerator: ["system"],
};

// ── determinism ──────────────────────────────────────────────────────────────

/**
 * Time as a dependency. `now()` is the whole contract; advancing is the fake's
 * own extra surface, not something a caller of the port may assume.
 */
export interface Clock {
  readonly adapterId: string;
  readonly mode: AdapterMode;
  /** Current time. Always a fresh `Date` — never a shared mutable instance. */
  now(): Date;
}

/** Identifier minting. Same seed, same sequence — that is the fake's promise. */
export interface IdGenerator {
  readonly adapterId: string;
  readonly mode: AdapterMode;
  /** A fresh id. Never returns the same value twice in one process. */
  next(): string;
}

// ── RiskSignalSource ─────────────────────────────────────────────────────────

/**
 * One bank fraud signal, in the shape `POST /v1/interventions` accepts. This is
 * the ONLY shape domain code sees, whichever transport delivered it: an SFTP
 * drop and a Kafka topic must produce the same object here, or the policy gate
 * has a second, untested code path.
 */
export type RiskSignal = {
  transactionRef: string;
  riskScore: number;
  language: string;
  /** E.164. */
  phone: string;
  /** ISO-4217 alpha-3. */
  currency: string;
  /** Integer minor units. Never a float. */
  amountMinor: number;
  merchant?: string;
  consentRecordId: string;
  orgId?: string | null;
};

export type RiskSignalTransport = "http" | "kafka" | "sftp" | "poll" | "fixture";

/** Whether signals are pushed at us or we pull them. */
export type RiskSignalDelivery = "push" | "pull";

export type SourceOpen = { ok: true; target: string } | { ok: false; reason: string };

export interface RiskSignalSource {
  readonly adapterId: string;
  readonly mode: AdapterMode;
  readonly transport: RiskSignalTransport;
  readonly delivery: RiskSignalDelivery;
  /**
   * Validate configuration and report where signals arrive from. Must not
   * perform I/O: a caller that opens the source to *describe* it (a health
   * check, a report) must not dial a broker.
   */
  open(): Promise<SourceOpen>;
  /**
   * Drain up to `limit` signals in a stable order.
   *
   * Throws a typed `Error` on a push-only source: an HTTP endpoint has no
   * cursor, and returning `[]` would make "nothing to pull" indistinguishable
   * from "nothing arrived", which is the confusion that hides a dead ingest.
   */
  pull(opts?: { limit?: number }): Promise<RiskSignal[]>;
  /** Release the source. Idempotent. */
  close(): Promise<void>;
}

// ── ConversationProvider ─────────────────────────────────────────────────────

/** Sanitised — invariant I-4: nothing untrusted reaches a voice provider. */
export type ConversationRequest = {
  caseRef: string;
  /** E.164. */
  toNumber: string;
  /** BCP-47. */
  language: string;
  firstMessage: string;
  voiceId: string;
  dynamicVariables: Record<string, unknown>;
};

export type ConversationPlacement = {
  conversationId: string;
  callSid: string;
  /** True when the provider round-trip was simulated, not placed. */
  dryRun: boolean;
};

export type TranscriptTurn = {
  speaker: "agent" | "customer" | "system";
  text: string;
  /** Seconds from conversation start. */
  atSeconds: number;
};

export type ConversationVerdict = "confirmed_fraud" | "confirmed_legitimate" | "uncertain" | "no_answer";

export interface ConversationProvider {
  readonly adapterId: string;
  readonly mode: AdapterMode;
  /** Primary plane: the provider that places the live conversation. */
  start(req: ConversationRequest): Promise<ConversationPlacement>;
  /**
   * Continuity plane: carry on (or take over) when the primary cannot. Not
   * every provider can, so a provider without continuity refuses explicitly
   * rather than pretending.
   */
  continue(req: ConversationRequest): Promise<ConversationPlacement>;
  /** Ordered turns for a conversation. Empty when the id is unknown. */
  transcript(conversationId: string): Promise<TranscriptTurn[]>;
  verdict(conversationId: string): Promise<ConversationVerdict | null>;
}

// ── TelephonyProvider ────────────────────────────────────────────────────────

export type TelephonyVerdict = { ok: true } | { ok: false; reason: string };

export type TelephonyCallRequest = {
  /** E.164. */
  to: string;
  language: string;
  amount?: string;
  merchant?: string;
  /** Public origin, when one exists, so audio URLs can be signed. */
  origin?: string;
  caseRef: string;
};

export type TelephonySmsRequest = {
  to: string;
  language: string;
  caseRef: string;
  amount?: string;
  merchant?: string;
};

export type TelephonyResult =
  | { ok: true; sid: string; status: string; channel: "voice" | "sms" }
  | { ok: false; status: number; error: string; channel: "voice" | "sms" };

export interface TelephonyProvider {
  readonly adapterId: string;
  readonly mode: AdapterMode;
  /**
   * Destination check, evaluated BEFORE any credential lookup and before any
   * egress. It is on the port rather than buried in an adapter because it is
   * the one telephony behaviour every carrier agrees on — which also makes it
   * the only part of this port that can be compared against a real adapter
   * with no credentials and no network.
   */
  validateDestination(destination: string): TelephonyVerdict;
  placeCall(req: TelephonyCallRequest): Promise<TelephonyResult>;
  sendSms(req: TelephonySmsRequest): Promise<TelephonyResult>;
}

// ── NotificationSink ─────────────────────────────────────────────────────────

export type NotificationChannel =
  | "webhook"
  | "crm"
  | "itsm"
  | "siem"
  | "contact-centre"
  | "sms"
  | "in-app";

export type NotificationSeverity = "page" | "urgent" | "info";

export type NotificationRequest = {
  orgId: string | null;
  channel: NotificationChannel;
  alertType: string;
  severity: NotificationSeverity;
  title: string;
  body?: string;
  caseRef?: string | null;
  /** Explicit instant, so a replay lands where the original did. */
  at?: Date;
  /** Window over which repeats fold into one item. 0 disables folding. */
  windowMinutes?: number;
};

export type NotificationEnvelope = {
  id: string;
  orgId: string | null;
  channel: NotificationChannel;
  alertType: string;
  severity: NotificationSeverity;
  title: string;
  caseRef: string | null;
  count: number;
  createdAt: string;
  acknowledgedAt: string | null;
};

export type NotificationReceipt = {
  id: string;
  /** True when this enqueue folded into an existing item. */
  deduplicated: boolean;
  /** How many events the item now carries — a burst becomes one alert. */
  count: number;
};

export type NotificationAck = { ok: true } | { ok: false; error: "not_found" | "already_acknowledged" };

export interface NotificationSink {
  readonly adapterId: string;
  readonly mode: AdapterMode;
  /** The channel this binding delivers to. One sink, one channel. */
  readonly channel: NotificationChannel;
  enqueue(req: NotificationRequest): Promise<NotificationReceipt>;
  /** Outstanding items for an org, oldest first. */
  pending(orgId: string | null): Promise<NotificationEnvelope[]>;
  /**
   * Org-scoped on purpose: a caller that forgets the scope gets
   * `not_found`, never another tenant's acknowledgement.
   */
  acknowledge(id: string, orgId: string | null): Promise<NotificationAck>;
}

// ── PaymentProvider ──────────────────────────────────────────────────────────

/**
 * The WP-13 money port, re-declared with `mode`. Re-declared rather than
 * aliased because `@/lib/payments/provider` cannot be edited to add the
 * property, and a binding that cannot say whether it is real is exactly the
 * thing this work package exists to remove.
 */
export interface PaymentProviderPort extends PaymentProvider {
  readonly mode: AdapterMode;
}

// ── SecretStore ──────────────────────────────────────────────────────────────

export type SecretResult =
  | { ok: true; value: string }
  | { ok: false; reason: "not_found" | "not_configured" | "forbidden" };

export interface SecretStore {
  readonly adapterId: string;
  readonly mode: AdapterMode;
  /**
   * Resolve a secret. A miss is a typed result — never `undefined`, which is
   * one `??` away from being interpolated into an auth header.
   */
  get(key: string): Promise<SecretResult>;
  has(key: string): Promise<boolean>;
  /**
   * Secret NAMES only. A store that can enumerate values is a store that
   * leaks them.
   */
  keys(): Promise<string[]>;
}

// ── AuditSink ────────────────────────────────────────────────────────────────

export type AuditAppendResult = { id: string; chainHash: string };

export interface AuditSink {
  readonly adapterId: string;
  readonly mode: AdapterMode;
  /**
   * Append one link. Implementations expose NO update and NO delete: the
   * append-only property is a property of the surface, not of a convention a
   * caller is trusted to follow.
   */
  append(entry: AuditEntry, opts?: { fast?: boolean }): Promise<AuditAppendResult>;
  /** Walk the chain from genesis and report the first break, if any. */
  verifyChain(callRef: string, orgId?: string | null): Promise<ChainVerification>;
}

export type { AuditEntry, ChainVerification };

// ── the descriptor ───────────────────────────────────────────────────────────

/**
 * What the registry reports for one port: the port, whether the bound adapter
 * is real, and — in prose — what was actually exercised. The prose is not
 * decoration: `detail` is the difference between "AuditSink is real" and
 * "AuditSink is real, and this run appended four links to Postgres and
 * verified the chain", which is the only claim worth putting in a report.
 */
export type PortDescriptor = {
  port: PortName;
  mode: AdapterMode;
  detail: string;
};