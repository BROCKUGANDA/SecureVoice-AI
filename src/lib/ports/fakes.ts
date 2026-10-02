/**
 * WP-18 — a deterministic fake for EVERY port.
 *
 * Two rules decide whether a fake belongs in this file.
 *
 *   1. **A fake must not be cheaper than the thing it stands in for.** An
 *      audit sink whose `verifyChain()` always returns `ok: true` would let a
 *      tampering regression ship green, because the only test exercising the
 *      chain would be the fake. So this audit sink reproduces the real
 *      canonicalisation byte for byte — and the gate proves it by appending the
 *      same entries through the real Postgres chain and through this one and
 *      comparing `chainHash`. The fake's `verifyChain` then reproduces the real
 *      one exactly: fork detection, orphan detection, and the honest admission
 *      that a hash chain cannot see a truncated tail.
 *   2. **A fake is deterministic or it is decoration.** Every id comes from an
 *      injected seeded generator and every instant from an injected fixed
 *      clock. No `Date.now()`, no `Math.random()`, no counter that depends on
 *      call order across the suite.
 *
 * Where a fake must differ from the real adapter it stands in for — provider
 * id formats, generated identifiers — the difference is structural and the
 * gate compares behaviour, not bytes, and says so in the evidence.
 */

import { createHash } from "node:crypto";
import type {
  AuditAppendResult,
  AuditEntry,
  AuditSink,
  ChainVerification,
  Clock,
  ConversationPlacement,
  ConversationProvider,
  ConversationRequest,
  ConversationVerdict,
  IdGenerator,
  NotificationAck,
  NotificationEnvelope,
  NotificationReceipt,
  NotificationRequest,
  NotificationSink,
  PaymentProviderPort,
  RiskSignal,
  RiskSignalSource,
  SecretResult,
  SecretStore,
  StoredEntitlement,
  TelephonyCallRequest,
  TelephonyProvider,
  TelephonyResult,
  TelephonySmsRequest,
  TelephonyVerdict,
  TranscriptTurn,
} from "@/lib/ports/types";
import type {
  ChargeRequest,
  ChargeResult,
  CheckoutRequest,
  CheckoutSession,
  WebhookVerification,
} from "@/lib/payments/provider";
import type { RefundRequest, RefundResult } from "@/lib/payments/provider";

export const FAKE_IDS = {
  signalSource: "risksignal.fixture",
  conversation: "conversation.scripted",
  telephony: "telephony.recorder",
  notification: "notification.capture",
  payment: "payment.deterministic",
  secret: "secret.memory",
  audit: "audit.memory",
} as const;

/** Dependencies every fake shares. Defaults are deterministic, not convenient. */
export type FakeDeps = {
  clock: Clock;
  ids: IdGenerator;
};

// ── RiskSignalSource ─────────────────────────────────────────────────────────

export const FIXTURE_SIGNALS: readonly RiskSignal[] = Object.freeze([
  Object.freeze({
    transactionRef: "TXN-FIXTURE-0001",
    riskScore: 0.94,
    language: "en",
    phone: "+971500000001",
    currency: "AED",
    amountMinor: 245_000,
    merchant: "SUNRISE ELECTRONICS",
    consentRecordId: "CONSENT-FIXTURE-0001",
    orgId: "org-fixture",
  }),
  Object.freeze({
    transactionRef: "TXN-FIXTURE-0002",
    riskScore: 0.41,
    language: "ar",
    phone: "+971500000002",
    currency: "AED",
    amountMinor: 3_500,
    merchant: "AL MAZIDI GROCERY",
    consentRecordId: "CONSENT-FIXTURE-0002",
    orgId: "org-fixture",
  }),
  Object.freeze({
    transactionRef: "TXN-FIXTURE-0003",
    riskScore: 0.88,
    language: "hi",
    phone: "+911400000003",
    currency: "INR",
    amountMinor: 88_000,
    merchant: "DECOY TELECOM",
    consentRecordId: "CONSENT-FIXTURE-0003",
    orgId: "org-fixture",
  }),
]);

export type FixtureSignalSource = RiskSignalSource & {
  /** Everything pulled so far, in order. The fake's own transcript. */
  delivered(): RiskSignal[];
  /** Remaining fixtures. */
  pendingCount(): number;
  /** Put every fixture back, in its original order. */
  reset(): void;
};

/**
 * In-memory fixture feed. A FIFO queue: `pull()` drains in insertion order,
 * because a source that reorders signals is a different source and the order is
 * half of what a bank is entitled to assume.
 */
export function createFixtureSignalSource(
  signals: readonly RiskSignal[] = FIXTURE_SIGNALS,
  _deps: FakeDeps,
): FixtureSignalSource {
  const queue: RiskSignal[] = [...signals];
  const delivered: RiskSignal[] = [];
  let open = false;

  return {
    adapterId: FAKE_IDS.signalSource,
    mode: "fake",
    transport: "fixture",
    delivery: "pull",
    async open() {
      open = true;
      return { ok: true, target: `memory://fixtures/${queue.length}` };
    },
    async pull(opts) {
      // A closed source has no cursor: returning `[]` would be
      // indistinguishable from "nothing arrived", which is precisely the
      // confusion that lets a dead ingest look like a quiet one.
      if (!open) throw new Error(`RiskSignalSource(${FAKE_IDS.signalSource}) is not open`);
      const limit = opts?.limit ?? queue.length;
      const taken = queue.splice(0, Math.max(0, limit));
      delivered.push(...taken);
      return taken;
    },
    async close() {
      open = false;
    },
    delivered: () => delivered.map((s) => ({ ...s })),
    pendingCount: () => queue.length,
    reset() {
      queue.splice(0, queue.length, ...signals);
      delivered.length = 0;
      open = false;
    },
  };
}

// ── ConversationProvider ─────────────────────────────────────────────────────

/** The scripted call, per language. Compliance-approved opening, then a verdict. */
export const SCRIPTED_TRANSCRIPTS: Readonly<Record<string, readonly TranscriptTurn[]>> = {
  en: [
    { speaker: "agent", text: "This call is recorded to protect you.", atSeconds: 0 },
    { speaker: "agent", text: "We detected a transaction of AED 2450.00 at SUNRISE ELECTRONICS.", atSeconds: 4 },
    { speaker: "customer", text: "I never made that purchase.", atSeconds: 9 },
    { speaker: "agent", text: "Is this transaction yours? Please say yes or no.", atSeconds: 11 },
    { speaker: "customer", text: "No, it is not mine.", atSeconds: 15 },
    { speaker: "system", text: "verdict:confirmed_fraud", atSeconds: 17 },
  ],
  ar: [
    { speaker: "agent", text: "يتم تسجيل هذه المكالمة لحمايتك.", atSeconds: 0 },
    { speaker: "customer", text: "لم أقم بهذه العملية.", atSeconds: 8 },
    { speaker: "system", text: "verdict:uncertain", atSeconds: 14 },
  ],
  hi: [
    { speaker: "agent", text: "यह कॉल आपकी सुरक्षा के लिए रिकॉर्ड की जा रही है।", atSeconds: 0 },
    { speaker: "customer", text: "मैंने यह लेनदेन नहीं किया।", atSeconds: 8 },
    { speaker: "system", text: "verdict:confirmed_fraud", atSeconds: 13 },
  ],
};

const SCRIPTED_VERDICTS: Readonly<Record<string, ConversationVerdict>> = {
  en: "confirmed_fraud",
  ar: "uncertain",
  hi: "confirmed_fraud",
};

export type ScriptedConversationProvider = ConversationProvider & {
  /** Every placement the fake was asked for, in order. */
  placed(): Array<ConversationPlacement & { continuity: boolean; language: string }>;
};

/**
 * Scripted transcript player. `start()` mints a deterministic conversation id
 * from the injected generator and remembers the request; `transcript()` replays
 * the script for that request's language.
 *
 * `continue()` is the continuity plane — the same fake can serve the primary
 * and the fallback role, which is what lets a test prove the caller reaches for
 * continuity at all.
 */
export function createScriptedConversationProvider(deps: FakeDeps): ScriptedConversationProvider {
  const scripts = new Map<string, readonly TranscriptTurn[]>();
  const placements: Array<ConversationPlacement & { continuity: boolean; language: string }> = [];

  const remember = (req: ConversationRequest, continuity: boolean): ConversationPlacement => {
    const conversationId = deps.ids.next();
    scripts.set(conversationId, SCRIPTED_TRANSCRIPTS[req.language] ?? SCRIPTED_TRANSCRIPTS.en);
    const placement: ConversationPlacement = {
      conversationId,
      callSid: `CA_scripted_${conversationId}`,
      dryRun: false,
    };
    placements.push({ ...placement, continuity, language: req.language });
    return placement;
  };

  return {
    adapterId: FAKE_IDS.conversation,
    mode: "fake",
    async start(req) {
      return remember(req, false);
    },
    async continue(req) {
      return remember(req, true);
    },
    async transcript(conversationId) {
      return (scripts.get(conversationId) ?? []).map((t) => ({ ...t }));
    },
    async verdict(conversationId) {
      if (!scripts.has(conversationId)) return null;
      const lang = placements.find((p) => p.conversationId === conversationId)?.language ?? "en";
      return SCRIPTED_VERDICTS[lang] ?? null;
    },
    placed: () => placements.map((p) => ({ ...p })),
  };
}

// ── TelephonyProvider ────────────────────────────────────────────────────────

/** E.164, matching `@/lib/twilio`'s own check so the two can be compared. */
const E164 = /^\+[1-9]\d{7,14}$/;
/** Verbatim from the real adapter, so a parity check can compare it exactly. */
const NOT_E164 = "Destination phone is not E.164";

export type RecordingTelephony = TelephonyProvider & {
  calls(): Array<{ channel: "voice" | "sms"; to: string; language: string; caseRef: string; sid: string }>;
};

/**
 * Recording stub. It never dials: it writes down what it was asked to dial and
 * returns a queued result. That is the whole value — a test can assert the
 * platform dialled the right number in the right language without a carrier,
 * a credential or a cent.
 */
export function createRecordingTelephony(deps: FakeDeps): RecordingTelephony {
  const log: Array<{ channel: "voice" | "sms"; to: string; language: string; caseRef: string; sid: string }> = [];

  const accept = (channel: "voice" | "sms", to: string, language: string, caseRef: string): TelephonyResult => {
    if (!E164.test(to)) return { ok: false, status: 422, error: NOT_E164, channel };
    const sid = `CA_fake_${deps.ids.next()}`;
    log.push({ channel, to, language, caseRef, sid });
    return { ok: true, sid, status: "queued", channel };
  };

  return {
    adapterId: FAKE_IDS.telephony,
    mode: "fake",
    validateDestination(destination: string): TelephonyVerdict {
      return E164.test(destination) ? { ok: true } : { ok: false, reason: NOT_E164 };
    },
    async placeCall(req: TelephonyCallRequest): Promise<TelephonyResult> {
      return accept("voice", req.to, req.language, req.caseRef);
    },
    async sendSms(req: TelephonySmsRequest): Promise<TelephonyResult> {
      return accept("sms", req.to, req.language, req.caseRef);
    },
    calls: () => log.map((c) => ({ ...c })),
  };
}

// ── NotificationSink ─────────────────────────────────────────────────────────

/**
 * Dedupe key, mirroring `@/lib/notifications`' `dedupeKeyFor`: repeats inside
 * one window bucket fold into a single item carrying the real count. This is
 * the behaviour a burst has to have, so the fake has to have it too — a
 * capture buffer that appended one row per signal would prove nothing.
 */
export function captureDedupeKey(input: {
  orgId: string | null;
  alertType: string;
  at: Date;
  windowMinutes: number;
}): string {
  const windowMinutes = input.windowMinutes > 0 ? input.windowMinutes : 0;
  const bucket =
    windowMinutes > 0 ? Math.floor(input.at.getTime() / (windowMinutes * 60_000)) : 0;
  return `${input.orgId ?? "default"}:${input.alertType}:${bucket}`;
}

export type CaptureNotificationSink = NotificationSink & {
  captured(): NotificationEnvelope[];
  reset(): void;
};

export function createCaptureNotificationSink(deps: FakeDeps): CaptureNotificationSink {
  const byKey = new Map<string, NotificationEnvelope>();

  return {
    adapterId: FAKE_IDS.notification,
    mode: "fake",
    channel: "in-app",

    async enqueue(req: NotificationRequest): Promise<NotificationReceipt> {
      if (typeof req.alertType !== "string" || req.alertType.length === 0) {
        throw new TypeError("NotificationRequest.alertType is required");
      }
      const at = req.at ?? deps.clock.now();
      const windowMinutes = req.windowMinutes ?? 15;
      const key = captureDedupeKey({ orgId: req.orgId, alertType: req.alertType, at, windowMinutes });
      const existing = byKey.get(key);
      if (existing) {
        existing.count += 1;
        return { id: existing.id, deduplicated: true, count: existing.count };
      }
      const row: NotificationEnvelope = {
        id: deps.ids.next(),
        orgId: req.orgId,
        channel: req.channel,
        alertType: req.alertType,
        severity: req.severity,
        title: req.title,
        caseRef: req.caseRef ?? null,
        count: 1,
        createdAt: at.toISOString(),
        acknowledgedAt: null,
      };
      byKey.set(key, row);
      return { id: row.id, deduplicated: false, count: 1 };
    },

    async pending(orgId: string | null): Promise<NotificationEnvelope[]> {
      return [...byKey.values()]
        .filter((n) => n.orgId === orgId && n.acknowledgedAt === null)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
        .map((n) => ({ ...n }));
    },

    async acknowledge(id: string, orgId: string | null): Promise<NotificationAck> {
      // Scope first: a caller that forgot the org must not be able to
      // acknowledge another tenant's alert by guessing an id.
      const row = [...byKey.values()].find((n) => n.id === id && n.orgId === orgId);
      if (!row) return { ok: false, error: "not_found" };
      if (row.acknowledgedAt !== null) return { ok: false, error: "already_acknowledged" };
      row.acknowledgedAt = deps.clock.now().toISOString();
      return { ok: true };
    },

    captured: () => [...byKey.values()].map((n) => ({ ...n })),
    reset() {
      byKey.clear();
    },
  };
}

// ── PaymentProvider ──────────────────────────────────────────────────────────

/**
 * Deterministic payment mock.
 *
 * Its refusal surface is a VERBATIM copy of the `manualinvoice` adapter's,
 * because that adapter is the only real money adapter in this repo that is
 * exercisable with no gateway and no credential — and a fake that answered
 * those five methods with plausible different values would let a caller's
 * error handling drift untested. What the mock ADDS is the deterministic
 * settlement path the offline gate needs, behind `settle()` rather than behind
 * `verifyWebhook()`, so nothing can mistake it for a real gateway webhook.
 */
export type DeterministicPaymentProvider = PaymentProviderPort & {
  settlements(): Array<{ reference: string; eventId: string; amountMinor: number; currency: string; units: number }>;
  /**
   * Offline-only settlement. Deliberately NOT reachable through
   * `verifyWebhook`, so no caller can be tricked into treating this as a
   * gateway-confirmed payment.
   */
  settle(input: {
    reference: string;
    eventId: string;
    amountMinor: number;
    currency: string;
    units: number;
  }): Promise<{ applied: boolean; duplicate: boolean; reference: string; units: number }>;
};

export function createDeterministicPaymentProvider(_deps: FakeDeps): DeterministicPaymentProvider {
  void _deps;
  const settled = new Map<string, { eventId: string; amountMinor: number; currency: string; units: number }>();
  const refunded = new Set<string>();
  const log: Array<{ reference: string; eventId: string; amountMinor: number; currency: string; units: number }> = [];

  return {
    id: "deterministic",
    mode: "fake",

    async createCheckout(_req: CheckoutRequest): Promise<CheckoutSession> {
      throw new Error("deterministic: bank transfers are started by issuing a quote, not a checkout URL");
    },

    async verifyWebhook(_input: {
      rawBody: Buffer | string;
      headers: Record<string, string | string[] | undefined>;
    }): Promise<WebhookVerification> {
      return { ok: false, reason: "unsupported_event", detail: "deterministic has no webhook surface" };
    },

    async chargeStoredAuthorization(_req: ChargeRequest): Promise<ChargeResult> {
      return { ok: false, reference: "", reason: "deterministic: overage must be invoiced and verified manually" };
    },

    async listEntitlements(reference: string): Promise<StoredEntitlement[]> {
      // A refund does NOT erase the entitlements envelope: the real adapter
      // leaves `entitlementsJson` in place and only flips `status`, so the fake
      // keeps the row too and refuses a second refund with `already_refunded`.
      const row = settled.get(reference);
      return row ? [{ key: "calls", units: row.units }] : [];
    },

    async refund(req: RefundRequest): Promise<RefundResult> {
      if (!settled.has(req.reference)) return { ok: false, reference: req.reference, reason: "not_found" };
      if (refunded.has(req.reference)) {
        return { ok: false, reference: req.reference, reason: "already_refunded" };
      }
      refunded.add(req.reference);
      return { ok: true, reference: req.reference };
    },

    settlements: () => log.map((r) => ({ ...r })),
    async settle(input: {
      reference: string;
      eventId: string;
      amountMinor: number;
      currency: string;
      units: number;
      entitlements?: StoredEntitlement[];
    }): Promise<{ applied: boolean; duplicate: boolean; reference: string; units: number }> {
      if (!Number.isInteger(input.amountMinor) || input.amountMinor < 0) {
        throw new TypeError("settle.amountMinor must be a non-negative integer");
      }
      if (!/^[A-Z]{3}$/.test(input.currency)) {
        throw new TypeError("settle.currency must be an ISO-4217 alpha-3 code");
      }
      const existing = settled.get(input.reference);
      if (existing) return { applied: false, duplicate: true, reference: input.reference, units: 0 };
      const row = {
        eventId: input.eventId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        units: input.units,
      };
      settled.set(input.reference, row);
      log.push({ reference: input.reference, ...row });
      return { applied: true, duplicate: false, reference: input.reference, units: input.units };
    },
  };
}

// ── SecretStore ──────────────────────────────────────────────────────────────

export function createInMemorySecretStore(seed: Record<string, string> = {}): SecretStore {
  const values = new Map<string, string>(Object.entries(seed));
  return {
    adapterId: FAKE_IDS.secret,
    mode: "fake",
    async get(key: string): Promise<SecretResult> {
      if (typeof key !== "string" || key.length === 0) {
        return { ok: false, reason: "forbidden" };
      }
      const value = values.get(key);
      return value === undefined ? { ok: false, reason: "not_found" } : { ok: true, value };
    },
    async has(key: string): Promise<boolean> {
      return values.has(key);
    },
    async keys(): Promise<string[]> {
      return [...values.keys()].sort();
    },
  };
}

// ── AuditSink ────────────────────────────────────────────────────────────────

const GENESIS_HASH = "0".repeat(64);

type ChainRow = {
  id: string;
  callRef: string;
  action: string;
  intent?: string | null;
  callerId?: string | null;
  redactedText?: string | null;
  /** Stored as a JSON STRING, exactly as the real chain stores it. */
  meta?: string | null;
  orgId?: string | null;
  prevHash: string;
  chainHash: string;
};

/** Copied from `@/lib/audit-chain` so the hashes agree byte for byte. */
function safeKey(v: string | undefined, max: number): string | undefined {
  if (!v) return undefined;
  return v.replace(/[^\w.:-]/g, "").slice(0, max) || undefined;
}

function sanitizeEntry(entry: AuditEntry): AuditEntry {
  return {
    ...entry,
    callRef: safeKey(entry.callRef, 64) ?? "SV-UNKNOWN",
    action: entry.action,
    intent: safeKey(entry.intent, 40),
    callerId: safeKey(entry.callerId, 64),
    redactedText: entry.redactedText?.slice(0, 500),
    orgId: safeKey(entry.orgId, 64),
  };
}

/** Recursively sort keys at every depth — identical to the real chain. */
function canonicalizeNested(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalizeNested).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalizeNested(obj[k])).join(",") + "}";
}

function canonical(row: Record<string, unknown>): string {
  return JSON.stringify(row, Object.keys(row).sort());
}

function chainHash(prev: string, row: Record<string, unknown>): string {
  return createHash("sha256")
    .update(prev)
    .update("\n")
    .update(canonical({ ...row, prevHash: prev }))
    .digest("hex");
}

export type InMemoryAuditSink = AuditSink & {
  /** Every stored row, oldest link first. Inspection only. */
  rows(callRef: string): readonly ChainRow[];
  head(callRef: string): string;
  /**
   * TEST-ONLY tamper seam. The real chain is protected by Postgres constraints
   * and the retention guard (`assertRetentionMutationAllowed`); neither exists
   * in memory, so the gate needs a way to simulate an attacker with database
   * write access. Without it, "the fake detects tampering" is untestable — and
   * untestable is indistinguishable from untrue.
   */
  corruptForTest(callRef: string, index: number, patch: Partial<ChainRow>): ChainRow | null;
  /** TEST-ONLY: delete a link, simulating a removed row. */
  spliceForTest(callRef: string, index: number): ChainRow | null;
  /** TEST-ONLY: plant an extra row hanging off the same link (a fork). */
  forkForTest(callRef: string, index: number): ChainRow | null;
};

/**
 * In-memory hash chain. Append-only by SURFACE: there is no update and no
 * delete on the public type, and the only mutation entry points are named
 * `*ForTest` so a grep finds every one of them.
 */
export function createInMemoryAuditSink(deps: FakeDeps): InMemoryAuditSink {
  const byCallRef = new Map<string, ChainRow[]>();

  const chainFor = (callRef: string): ChainRow[] => {
    let rows = byCallRef.get(callRef);
    if (!rows) {
      rows = [];
      byCallRef.set(callRef, rows);
    }
    return rows;
  };

  return {
    adapterId: FAKE_IDS.audit,
    mode: "fake",

    async append(entry: AuditEntry, _opts?: { fast?: boolean }): Promise<AuditAppendResult> {
      const clean = sanitizeEntry(entry);
      const rows = chainFor(clean.callRef);
      const prevHash = rows.length > 0 ? rows[rows.length - 1].chainHash : GENESIS_HASH;
      const canonicalMeta = clean.meta ? canonicalizeNested(clean.meta) : undefined;
      const hash = chainHash(prevHash, {
        ...(clean as unknown as Record<string, unknown>),
        meta: canonicalMeta as unknown as Record<string, unknown> | undefined,
      });
      const row: ChainRow = {
        id: deps.ids.next(),
        callRef: clean.callRef,
        action: clean.action,
        intent: clean.intent ?? null,
        callerId: clean.callerId ?? null,
        redactedText: clean.redactedText ?? null,
        meta: canonicalMeta ?? null,
        orgId: clean.orgId ?? null,
        prevHash,
        chainHash: hash,
      };
      rows.push(row);
      return { id: row.id, chainHash: row.chainHash };
    },

    /**
     * Walk the chain by FOLLOWING prev-hash links, exactly as the real
     * verification does — timestamp order is ambiguous when two links share a
     * millisecond. Fork and orphan detection included.
     *
     * What it cannot do, and does not claim to: detect a truncated TAIL. A
     * hash chain proves nothing has been rewritten; it cannot prove the last
     * row is still the last row. Append-only is what makes truncation
     * impossible, and that property lives in the storage layer, not here.
     */
    async verifyChain(callRef: string, orgId?: string | null): Promise<ChainVerification> {
      const all = (byCallRef.get(callRef) ?? []).filter(
        (r) => (orgId ? r.orgId === orgId : true),
      );
      const byPrev = new Map<string, ChainRow[]>();
      for (const row of all) {
        const bucket = byPrev.get(row.prevHash ?? GENESIS_HASH);
        if (bucket) bucket.push(row);
        else byPrev.set(row.prevHash ?? GENESIS_HASH, [row]);
      }

      let prev = GENESIS_HASH;
      const visited = new Set<string>();
      for (;;) {
        const candidates = byPrev.get(prev);
        if (!candidates || candidates.length === 0) break;
        if (candidates.length > 1) {
          return {
            ok: false,
            brokenAt: candidates[1].id,
            expected: candidates[1].prevHash ?? GENESIS_HASH,
            actual: candidates[1].chainHash,
            rows: all.length,
          };
        }
        const row = candidates[0];
        const expected = chainHash(prev, {
          callRef: row.callRef,
          action: row.action,
          intent: row.intent ?? undefined,
          callerId: row.callerId ?? undefined,
          redactedText: row.redactedText ?? undefined,
          meta: (row.meta ?? undefined) as unknown as Record<string, unknown> | undefined,
          orgId: row.orgId ?? undefined,
        });
        if (row.chainHash !== expected) {
          return { ok: false, brokenAt: row.id, expected, actual: row.chainHash, rows: all.length };
        }
        prev = row.chainHash;
        visited.add(row.id);
      }

      if (visited.size !== all.length) {
        const orphan = all.find((r) => !visited.has(r.id));
        return {
          ok: false,
          brokenAt: orphan?.id ?? all[0]?.id ?? "none",
          expected: prev,
          actual: "orphaned row",
          rows: all.length,
        };
      }
      return { ok: true, rows: all.length };
    },

    rows(callRef) {
      return chainFor(callRef).map((r) => ({ ...r }));
    },
    head(callRef) {
      const rows = chainFor(callRef);
      return rows.length === 0 ? GENESIS_HASH : rows[rows.length - 1].chainHash;
    },
    corruptForTest(callRef, index, patch) {
      const rows = chainFor(callRef);
      const row = rows[index];
      if (!row) return null;
      Object.assign(row, patch);
      return { ...row };
    },
    spliceForTest(callRef, index) {
      const rows = chainFor(callRef);
      if (index < 0 || index >= rows.length) return null;
      return { ...rows.splice(index, 1)[0] };
    },
    forkForTest(callRef, index) {
      const rows = chainFor(callRef);
      const source = rows[index];
      if (!source) return null;
      const planted: ChainRow = { ...source, id: deps.ids.next() };
      rows.push(planted);
      return { ...planted };
    },
  };
}

// ── re-exports ───────────────────────────────────────────────────────────────
// The `PaymentProviderPort` above needs the WP-13 request/result vocabulary,
// which lives in `@/lib/payments/provider`. Re-exporting it here means a test
// that only imports the fakes still has every type it needs to write a parity
// scenario.
export type {
  ChargeRequest,
  ChargeResult,
  CheckoutRequest,
  CheckoutSession,
  RefundRequest,
  RefundResult,
  WebhookVerification,
};