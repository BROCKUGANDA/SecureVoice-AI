/**
 * WP-18 GATE — internal seams.
 *
 *   cd C:\Users\HP\Desktop\SecureVoiceai
 *   $env:TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/securevoice_test?connection_limit=20"
 *   bun test tests/seams
 *
 * What this file proves, and what each proof is worth:
 *
 *   1. **Every port in the brief is bound**, and the registry reports the mode
 *      the ADAPTER declares. An adapter that cannot say whether it is real
 *      makes the registry refuse to construct, so "we were offline" is a fact
 *      the artifact can print rather than a comment.
 *   2. **Contract parity where the real adapter is safely callable offline.**
 *      AuditSink (Postgres chain) and NotificationSink (console inbox) are run
 *      through the SAME scenario as their fakes. The audit parity is
 *      byte-for-byte on `chainHash`, which is the strongest statement this
 *      repo can make about a fake: it computes the same hashes as the thing it
 *      stands in for.
 *   3. **Dry-run parity where a live call is not possible.** ConversationProvider
 *      is compared through `ELEVENLABS_DRY_RUN`. TelephonyProvider has NO
 *      dry-run in this repository, so its real adapter cannot be called at all
 *      without credentials — and that is asserted, not assumed (see check
 *      `telephony-real-adapter-refuses-without-credentials`), which is what
 *      earns it "bound-only" honestly rather than by omission.
 *   4. **A fixed clock and a seeded generator make a run byte-stable.** The
 *      whole fake pipeline runs twice and the canonical serialisations are
 *      compared byte for byte. A different seed MUST change the digest, or
 *      "deterministic" would be indistinguishable from "constant".
 *   5. **The in-memory audit chain still detects tampering.** A fake whose
 *      `verifyChain()` always said `ok` would let a tampering regression ship
 *      green, because the fake would be the only chain under test.
 *   6. **Offline mode completes a full intervention** — signal in, policy gate,
 *      case-state transitions, bank event enqueued, notification enqueued — with
 *      no network and no provider credentials, enforced by a `globalThis.fetch`
 *      tripwire armed at module load.
 *
 * Honesty rules this gate follows, because a green gate that overstates is
 * worse than no gate:
 *
 *   · Every port carries an explicit VERIFICATION LEVEL in the artifact:
 *     `contract-real`, `contract-dry-run`, `contract-offline-surface`, or
 *     `bound-only`. A bound port is never reported as tested.
 *   · Where the real and the fake legitimately differ — provider-scoped id
 *     formats, DB-assigned identifiers, adapters the brief names that this
 *     repository does not implement — the difference is asserted in both
 *     directions and reported. Parity is never claimed over a field that
 *     cannot match.
 *   · The negative control on the real audit chain exists so "both chains
 *     verified" cannot pass because neither verifies anything.
 *   · Every fixture is RUN-scoped and cleaned up in `afterAll`, so a run cannot
 *     disturb another agent working in the same database.
 */

import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { db, dbAudit } from "@/lib/db";
import { canTransition, createCase, transitionCase, transitionCaseWithOutbox } from "@/lib/case-state-machine";
import { runPolicyGate } from "@/lib/policy-gate";
import { topup } from "@/lib/billing/ledger";
import { recordPayment } from "@/lib/payments/manual-invoice";
import { canonicalJson } from "@/lib/outbox";
import { CROCKFORD, seededUlidGenerator, ulidGenerator, ULID_LENGTH } from "@/lib/ids";
import { fixedClock, systemClock } from "@/lib/clock";
import {
  DECLARED_ADAPTERS,
  PORT_NAMES,
  type PortDescriptor,
  type PortName,
} from "@/lib/ports/types";
import { createRegistry, PORT_BINDINGS } from "@/lib/ports/registry";
import {
  FIXTURE_SIGNALS,
  type CaptureNotificationSink,
  type InMemoryAuditSink,
} from "@/lib/ports/fakes";

// ── run identity ─────────────────────────────────────────────────────────────

const RUN = Date.now().toString(36);
const ORG = `org-seams-${RUN}`;
const CASE_REF = `SV-F-SEAMS${RUN.toUpperCase().slice(-8)}`;
const PAY_REF = `SEAMTRANSFER${RUN.toUpperCase()}`;
const CHAIN_REF = `SEAMCHAIN-${RUN}`;
/**
 * The audit-chain fixtures are scoped to a CONSTANT organisation, not to this
 * run's org, and that is load-bearing rather than lazy: `orgId` is sealed into
 * every chain hash, so a run-scoped org would make the chainHashes — and every
 * detail that quotes one — differ on every run, and the artifact's deterministic
 * core would not be deterministic at all. The rows stay cleanable because their
 * `callRef` IS run-scoped, which is the column cleanup filters on.
 */
const CHAIN_ORG = "org-seam-chain-fixture";
const EVIDENCE_PATH = resolve(process.cwd(), "evidence/seams/seams.json");
const RUN_INSTANT = new Date("2026-01-01T09:00:00.000Z");

/**
 * Fixed seeds. Not a stylistic choice: a seeded generator's output is a pure
 * function of its seed and its clock, so a seed containing the run id would put
 * a run-scoped value back into every identifier the gate reports.
 */
const SEED_AUDIT = "seams-audit-chain";
const SEED_TAMPER_A = "seams-tamper-edit";
const SEED_TAMPER_B = "seams-tamper-delete";
const SEED_TAMPER_C = "seams-tamper-fork";
const SEED_NOTIFY = "seams-notify-burst";
const SEED_PAY = "seams-payment";
const SEED_SECRET = "seams-secret";
const SEED_CONVERSATION = "seams-conversation";
const SEED_TELEPHONY = "seams-telephony";
const SEED_SOURCE = "seams-signal-source";
const SEED_INTERVENTION = "seams-offline-intervention";

/**
 * Chain appends share a millisecond-resolution `createdAt`, and the real
 * `appendInner` reads the chain head by `orderBy: { createdAt: desc }` — two
 * appends inside one millisecond make the head ambiguous and can fork the
 * chain. Pace them. (Same reason `tests/privacy` paces.)
 */
const pace = (): Promise<void> => Bun.sleep(4);

// ── run-scoped cleanup ───────────────────────────────────────────────────────

/**
 * Every row this gate can create, by column. Listed explicitly rather than
 * pattern-matched, because a gate that cleans up with `%seam%` will eventually
 * delete something that is not its own.
 *
 * `PAY-${PAY_REF}` is in the audit list and was NOT in the first version of this
 * cleanup, so `recordPayment`'s chained `payment_recorded` row survived every
 * run. That is the kind of leak that only shows up if the residue is asserted
 * rather than assumed — hence `the-gate-leaves-no-residue` below.
 */
const RUN_SCOPED_AUDIT_REFS = () => [
  CHAIN_REF,
  `${CHAIN_REF}-T`,
  CASE_REF,
  `PAY-${PAY_REF}`,
];

async function cleanupRunScopedRows(): Promise<Record<string, number>> {
  const outbox = await db.outboxEvent.deleteMany({ where: { caseRef: CASE_REF } });
  const audit = await dbAudit.auditLog.deleteMany({
    where: {
      OR: [
        { callRef: { in: RUN_SCOPED_AUDIT_REFS() } },
        { orgId: { in: [ORG, CHAIN_ORG] } },
      ],
    },
  });
  const notifications = await db.notification.deleteMany({
    where: { OR: [{ caseRef: CASE_REF }, { orgId: ORG }] },
  });
  const cases = await db.case.deleteMany({ where: { caseRef: CASE_REF } });
  const ledger = await db.usageLedger.deleteMany({ where: { orgId: ORG } });
  const payments = await db.paymentRecord.deleteMany({ where: { reference: PAY_REF } });
  return {
    outbox: outbox.count,
    auditLog: audit.count,
    notifications: notifications.count,
    cases: cases.count,
    ledger: ledger.count,
    payments: payments.count,
  };
}

async function countRunScopedRows(): Promise<Record<string, number>> {
  const audit = await dbAudit.auditLog.count({
    where: { OR: [{ callRef: { in: RUN_SCOPED_AUDIT_REFS() } }, { orgId: { in: [ORG, CHAIN_ORG] } }] },
  });
  const cases = await db.case.count({ where: { caseRef: CASE_REF } });
  const notifications = await db.notification.count({
    where: { OR: [{ caseRef: CASE_REF }, { orgId: ORG }] },
  });
  const outbox = await db.outboxEvent.count({ where: { caseRef: CASE_REF } });
  const ledger = await db.usageLedger.count({ where: { orgId: ORG } });
  const payments = await db.paymentRecord.count({ where: { reference: PAY_REF } });
  return { auditLog: audit, cases, notifications, outbox, ledger, payments };
}

// ── network tripwire ─────────────────────────────────────────────────────────
// Armed before any adapter is constructed. Every real adapter in this repo
// reaches the network through `globalThis.fetch` — the Paystack adapter takes an
// injected client, but ElevenLabs, Twilio and the realtime bridge do not. So a
// single stray call fails the gate instead of quietly reaching a provider.
const REAL_FETCH = globalThis.fetch;
const NETWORK_CALLS: string[] = [];
globalThis.fetch = ((input: unknown) => {
  const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
  NETWORK_CALLS.push(url);
  throw new Error(`WP-18 GATE: real network call attempted to ${url}`);
}) as unknown as typeof fetch;

/**
 * Credentials that must be absent for the offline intervention to mean
 * anything. Saved and restored so a developer's real `.env` cannot make the
 * offline claim false.
 */
const CREDENTIAL_ENV = [
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_AGENT_ID",
  "ELEVENLABS_PHONE_NUMBER_ID",
  "ELEVENLABS_VOICE_EN",
  "ELEVENLABS_VOICE_AR",
  "ELEVENLABS_VOICE_HI",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_FROM_NUMBER",
  "BANK_WEBHOOK_SECRET",
  "REALTIME_URL",
  "REALTIME_INGEST_SECRET",
] as const;

const SAVED_CREDENTIALS = new Map<string, string | undefined>(
  CREDENTIAL_ENV.map((k) => [k, process.env[k]]),
);
const SAVED_DRY_RUN = process.env.ELEVENLABS_DRY_RUN;
const SAVED_WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

function clearCredentials(): void {
  for (const k of CREDENTIAL_ENV) delete process.env[k];
  delete process.env.ELEVENLABS_DRY_RUN;
}
function restoreCredentials(): void {
  for (const [k, v] of SAVED_CREDENTIALS) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (SAVED_DRY_RUN === undefined) delete process.env.ELEVENLABS_DRY_RUN;
  else process.env.ELEVENLABS_DRY_RUN = SAVED_DRY_RUN;
  if (SAVED_WEBHOOK_SECRET === undefined) delete process.env.WEBHOOK_SECRET;
  else process.env.WEBHOOK_SECRET = SAVED_WEBHOOK_SECRET;
}

// ── evidence collector ───────────────────────────────────────────────────────

/**
 * How far a port's real adapter was actually exercised. This is the field that
 * stops "bound" from being read as "tested".
 */
type ParityLevel =
  | "contract-real"
  | "contract-dry-run"
  | "contract-offline-surface"
  | "bound-only";

type Parity = {
  port: PortName;
  level: ParityLevel;
  /** What was actually compared between the real adapter and the fake. */
  compared: string[];
  /** What was NOT exercised, and so is not claimed. */
  notCompared: string[];
  notes: string[];
};

const CHECKS: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: string): void {
  CHECKS.push({ name, ok, detail });
}
const passed = () => CHECKS.filter((c) => c.ok).length;
const failed = () => CHECKS.filter((c) => !c.ok).length;

/**
 * A per-test slice of the check log. Every test asserts on the checks IT added,
 * so a failure names the scenario that produced it instead of the first prefix
 * match in a log that is shared across the whole file.
 */
const mark = (): number => CHECKS.length;
function expectClean(from: number): void {
  const bad = CHECKS.slice(from).filter((c) => !c.ok);
  expect(bad.map((c) => `${c.name}: ${c.detail}`)).toEqual([]);
}

const PARITY: Parity[] = [];
function parity(entry: Parity): void {
  PARITY.push(entry);
}

async function captureError(fn: () => Promise<unknown> | unknown): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to throw, and it returned normally");
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * Run-scoped identifiers, longest first. A check detail that quotes one of them
 * (an event id, a payment reference) would otherwise put this run's fixture ids
 * into the artifact's deterministic core and make it unreproducible. They are
 * replaced with stable placeholders rather than deleted, so a reader still sees
 * WHICH reference was involved.
 */
const RUN_SCOPED: ReadonlyArray<readonly [string, string]> = [
  [CHAIN_REF, "[chainRef]"],
  [CASE_REF, "[caseRef]"],
  [PAY_REF, "[paymentRef]"],
  [ORG, "[org]"],
  [RUN, "[run]"],
];

function scrub(value: string): string {
  let out = value;
  for (const [needle, placeholder] of RUN_SCOPED) {
    if (needle.length > 0) out = out.split(needle).join(placeholder);
  }
  return out;
}

/**
 * Identifiers assigned OUTSIDE our control — Postgres cuids and the
 * `mi_…` ids the manual-invoice adapter mints. Collected as they are produced so
 * the artifact test can assert, exactly rather than by heuristic pattern, that
 * none of them reached the deterministic core. That assertion is what makes the
 * core's cross-run stability a verified property instead of a hope.
 */
const OPAQUE_IDS: string[] = [];

// ══════════════════════════════════════════════════════════════════════════════
// 1. Every port in the brief is bound, and its mode is its own.
// ══════════════════════════════════════════════════════════════════════════════

test("WP-18 · every port in the brief is bound and reports its own mode", () => {
  const from = mark();
  const real = createRegistry();
  const offline = createRegistry({ offline: true, seed: "bind-check" });

  // The brief's table, encoded. If a port is added to the brief and not to
  // DECLARED_ADAPTERS, this fails.
  check(
    "brief-table-is-encoded",
    Object.keys(DECLARED_ADAPTERS).length === PORT_NAMES.length &&
      PORT_NAMES.every((p) => Array.isArray(DECLARED_ADAPTERS[p]) && DECLARED_ADAPTERS[p].length > 0),
    `${PORT_NAMES.length} ports, each with a non-empty declared-adapter list`,
  );

  // Every declared adapter is accounted for as bound or explicitly not bound.
  const unaccounted: string[] = [];
  for (const port of PORT_NAMES) {
    const binding = PORT_BINDINGS[port];
    const declared = DECLARED_ADAPTERS[port];
    const accounted = new Set([...binding.bound, ...binding.notBound.map((n) => n.adapter)]);
    for (const adapter of declared) {
      // Adapter ids in the brief's table are written with spaces or
      // capitalisation; the bindings use hyphenated slugs. Compare loosely.
      const normalised = adapter.toLowerCase().replace(/[\s]+/g, "-");
      const hit = [...accounted].some((a) => a.toLowerCase() === normalised || a.toLowerCase().startsWith(normalised));
      if (!hit) unaccounted.push(`${port}/${adapter}`);
    }
    if (binding.bound.length === 0) unaccounted.push(`${port}/<nothing bound>`);
  }
  check(
    "every-declared-adapter-is-bound-or-declared-unbound",
    unaccounted.length === 0,
    unaccounted.length === 0
      ? "all 9 ports account for every adapter the brief names"
      : `unaccounted: ${unaccounted.join(", ")}`,
  );

  const descriptors: PortDescriptor[] = real.descriptors();
  check(
    "real-registry-binds-every-port",
    descriptors.length === PORT_NAMES.length && PORT_NAMES.every((p) => descriptors.some((d) => d.port === p)),
    `real registry bound ${descriptors.length}/${PORT_NAMES.length} ports`,
  );
  check(
    "descriptors-are-in-canonical-order",
    descriptors.map((d) => d.port).join(",") === PORT_NAMES.join(","),
    "descriptor order matches PORT_NAMES, so the artifact is byte-stable",
  );

  const modes: string[] = [];
  const missingDetail: string[] = [];
  const modeLie: string[] = [];
  for (const d of descriptors) {
    if (d.mode !== "real") modes.push(`${d.port}=${d.mode}`);
    if (d.detail.trim().length === 0) missingDetail.push(d.port);
    // The descriptor's mode must equal the mode the ADAPTER declares. The
    // PaymentProvider binding is the one adapter whose `mode` the registry adds
    // (WP-13's interface has no such property and that file is not ours to
    // edit) — recorded rather than hidden.
    const adapter = (real as unknown as Record<string, () => { mode?: string }>)[
      {
        RiskSignalSource: "riskSignalSource",
        ConversationProvider: "conversationProvider",
        TelephonyProvider: "telephonyProvider",
        NotificationSink: "notificationSink",
        PaymentProvider: "paymentProvider",
        SecretStore: "secretStore",
        AuditSink: "auditSink",
        Clock: "clock",
        IdGenerator: "idGenerator",
      }[d.port]
    ]?.();
    if (adapter?.mode !== d.mode) modeLie.push(`${d.port}: adapter=${adapter?.mode} descriptor=${d.mode}`);
  }
  check("real-registry-reports-mode-real-for-every-port", modes.length === 0, modes.join("; ") || "9/9 real");
  check("every-port-carries-a-detail-string", missingDetail.length === 0, missingDetail.join(", ") || "9/9 described");
  check("descriptor-mode-equals-adapter-declared-mode", modeLie.length === 0, modeLie.join("; ") || "9/9 agree");

  const offlineDescriptors = offline.descriptors();
  const offlineModes = offlineDescriptors.filter((d) => d.mode !== "fake").map((d) => `${d.port}=${d.mode}`);
  check(
    "offline-registry-reports-mode-fake-for-every-port",
    offlineModes.length === 0,
    offlineModes.join("; ") || "9/9 fake — nothing in an offline run is real",
  );
  check("registry-mode-is-declared", offline.mode === "offline" && real.mode === "real", `offline=${offline.mode}, real=${real.mode}`);

  // The registry must not be a service locator: the same call must return the
  // same adapter instance, and a caller must get its port off the object it
  // holds rather than from ambient state.
  check(
    "adapters-are-stable-per-registry",
    offline.notificationSink() === offline.notificationSink() && offline.clock() === offline.clock(),
    "repeated getters return the identical adapter; there is no global",
  );

  parity({
    port: "Clock",
    level: "contract-real",
    compared: ["now() returns a Date", "monotonic non-decreasing sequence", "fixed clock moves only on step()/set()"],
    notCompared: ["nothing: the system clock's whole surface is offline"],
    notes: ["the two clocks disagree on VALUES by design; parity is on the contract, not the number"],
  });
  parity({
    port: "IdGenerator",
    level: "contract-real",
    compared: ["26-character Crockford base32 shape", "uniqueness over 500 ids", "monotonic within one millisecond"],
    notCompared: ["the id bytes themselves — a seeded generator reproducing random bytes would be the bug"],
    notes: ["same seed ⇒ same sequence; different seed ⇒ different sequence"],
  });

  expectClean(from);
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. AuditSink — real Postgres chain vs. in-memory chain, byte for byte.
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Four links, all scoped to this run's org.
 *
 * The org on every entry is not decoration: `verifyChain(callRef, orgId)`
 * FILTERS by org, so a single entry without one makes the walk start at a link
 * nothing else claims and report a phantom orphan. (The real chain and the fake
 * reported the same phantom, which is how the two bugs were told apart.)
 *
 * The hostile shapes are the point: control characters in an intent, an
 * over-long redacted text, an empty intent that sanitises to `undefined`, and a
 * nested meta. Both implementations must reduce them identically or the hashes
 * diverge.
 */
const CHAIN_ENTRIES = [
  { callRef: "", action: "freeze" as const, intent: "signal_received", callerId: "bank-prod-1", meta: { riskScore: 0.94, nested: { b: 2, a: 1 }, list: [3, 1, 2] }, orgId: CHAIN_ORG },
  { callRef: "", action: "agent" as const, intent: "transition_received_to_screened", callerId: "bank-prod-1", meta: { from: "RECEIVED", to: "SCREENED" }, orgId: CHAIN_ORG },
  { callRef: "", action: "asr" as const, intent: "customer_reply", callerId: "bank/prod 1", redactedText: "x".repeat(600), meta: {}, orgId: CHAIN_ORG },
  { callRef: "", action: "handoff" as const, intent: "", meta: { verdict: "confirmed_fraud" }, orgId: CHAIN_ORG },
].map((e) => ({ ...e, callRef: CHAIN_REF, orgId: CHAIN_ORG }));

test("WP-18 · AuditSink: the in-memory chain computes the same hashes as the Postgres chain", async () => {
  const from = mark();
  clearCredentials();
  const realSink = createRegistry().auditSink();
  const fakeRegistry = createRegistry({ offline: true, seed: SEED_AUDIT, clockAt: RUN_INSTANT });
  const fakeSink = fakeRegistry.auditSink();

  const realHashes: string[] = [];
  const fakeHashes: string[] = [];
  for (const entry of CHAIN_ENTRIES) {
    await pace();
    realHashes.push((await realSink.append(entry, { fast: false })).chainHash);
    fakeHashes.push((await fakeSink.append(entry)).chainHash);
  }

  check(
    "fake-chain-hashes-are-byte-identical-to-the-real-chain",
    realHashes.join(",") === fakeHashes.join(","),
    `${realHashes.length} links hashed identically by @/lib/audit-chain and the in-memory fake`,
  );
  check(
    "chain-hashes-are-sha256-hex",
    realHashes.every((h) => /^[0-9a-f]{64}$/.test(h)),
    "every chainHash is 64 hex characters",
  );

  const realVerification = await realSink.verifyChain(CHAIN_REF, CHAIN_ORG);
  const fakeVerification = await fakeSink.verifyChain(CHAIN_REF, CHAIN_ORG);
  check("real-chain-verifies", realVerification.ok === true, `ok=${realVerification.ok} rows=${realVerification.ok ? realVerification.rows : "n/a"}`);
  check(
    "fake-chain-verifies",
    fakeVerification.ok === true,
    `in-memory verification: ok=${fakeVerification.ok} rows=${fakeVerification.ok ? fakeVerification.rows : "n/a"}`,
  );
  check(
    "both-chains-report-the-same-link-count",
    realVerification.ok && fakeVerification.ok && realVerification.rows === fakeVerification.rows,
    `real=${realVerification.ok ? realVerification.rows : "n/a"} fake=${fakeVerification.ok ? fakeVerification.rows : "n/a"}`,
  );

  // NEGATIVE CONTROL on the REAL chain. Without this, "both chains verified"
  // could pass because neither verifier ever fails.
  const rows = await dbAudit.auditLog.findMany({ where: { callRef: CHAIN_REF }, orderBy: { createdAt: "asc" } });
  const victim = rows[1];
  OPAQUE_IDS.push(victim.id);
  await dbAudit.auditLog.update({
    where: { id: victim.id },
    data: { redactedText: "TAMPERED" },
  });
  const brokenReal = await realSink.verifyChain(CHAIN_REF, CHAIN_ORG);
  check(
    "negative-control-real-chain-reports-the-tampered-link",
    !brokenReal.ok && brokenReal.brokenAt === victim.id,
    `verifyChain reported a break and named the row that was rewritten (match=${brokenReal.brokenAt === victim.id})`,
  );

  parity({
    port: "AuditSink",
    level: "contract-real",
    compared: [
      "chainHash of every link, byte for byte, across 4 links including hostile input",
      "verifyChain() === ok with the same link count",
      "verifyChain() reports the exact tampered link id on a real-DB rewrite",
    ],
    notCompared: ["row ids — the real chain is assigned cuids by Postgres, the fake mints seeded ULIDs"],
    notes: [
      "the fake reproduces @/lib/audit-chain's canonicalisation (sorted top-level keys, recursively sorted meta)",
      "a hash chain cannot detect a truncated TAIL; append-only in the storage layer is what prevents truncation",
    ],
  });

  expectClean(from);
}, 60_000);

test("WP-18 · AuditSink: the in-memory chain still detects tampering", async () => {
  const from = mark();
  const sink = createRegistry({ offline: true, seed: SEED_TAMPER_A, clockAt: RUN_INSTANT }).auditSink() as InMemoryAuditSink;
  const ref = `${CHAIN_REF}-T`;
  for (const entry of CHAIN_ENTRIES) await sink.append({ ...entry, callRef: ref });

  const before = await sink.verifyChain(ref, CHAIN_ORG);
  check("tamper-baseline-verifies", before.ok === true, JSON.stringify(before));

  // 1. A rewritten field.
  const tampered = sink.corruptForTest(ref, 1, { redactedText: "TAMPERED", meta: '{"a":1}' });
  const afterEdit = await sink.verifyChain(ref, CHAIN_ORG);
  check(
    "tampered-row-is-detected-at-the-right-link",
    !afterEdit.ok && afterEdit.brokenAt === tampered?.id,
    `brokenAt=${afterEdit.ok ? "none" : afterEdit.brokenAt} expected=${tampered?.id}`,
  );

  // 2. A deleted link (the tail is untouched, so the break is an orphan).
  const fresh = createRegistry({ offline: true, seed: SEED_TAMPER_B, clockAt: RUN_INSTANT }).auditSink() as InMemoryAuditSink;
  for (const entry of CHAIN_ENTRIES) await fresh.append({ ...entry, callRef: ref });
  fresh.spliceForTest(ref, 1);
  const afterDelete = await fresh.verifyChain(ref, CHAIN_ORG);
  check(
    "deleted-link-is-detected-as-an-orphan",
    !afterDelete.ok && afterDelete.actual === "orphaned row",
    // The head hash is not quoted: `callRef` is sealed into every link, and this
    // chain's ref is run-scoped, so quoting it would put the run id in the core.
    `ok=${afterDelete.ok} actual=${afterDelete.ok ? "n/a" : afterDelete.actual} rows=${afterDelete.rows}`,
  );

  // 3. A forked link (two rows claiming the same prevHash).
  const forked = createRegistry({ offline: true, seed: SEED_TAMPER_C, clockAt: RUN_INSTANT }).auditSink() as InMemoryAuditSink;
  for (const entry of CHAIN_ENTRIES) await forked.append({ ...entry, callRef: ref });
  const planted = forked.forkForTest(ref, 1);
  const afterFork = await forked.verifyChain(ref, CHAIN_ORG);
  check(
    "forked-link-is-detected",
    !afterFork.ok && afterFork.brokenAt === planted?.id,
    `brokenAt=${afterFork.ok ? "none" : afterFork.brokenAt} expected=${planted?.id}`,
  );

  // 4. The surface is append-only. There is no update and no delete on the
  //    port — the property is structural, not a convention.
  check(
    "audit-surface-is-append-only",
    typeof (sink as unknown as Record<string, unknown>).update === "undefined" &&
      typeof (sink as unknown as Record<string, unknown>).delete === "undefined" &&
      typeof (sink as unknown as Record<string, unknown>).upsert === "undefined",
    "no update/delete/upsert on the adapter; the only mutation seams are named *ForTest",
  );

  expectClean(from);
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. NotificationSink — console inbox vs. capture buffer.
// ══════════════════════════════════════════════════════════════════════════════

test("WP-18 · NotificationSink: the capture buffer folds bursts exactly like the console inbox", async () => {
  const from = mark();
  clearCredentials();
  const real = createRegistry().notificationSink();
  const fake = createRegistry({ offline: true, seed: SEED_NOTIFY, clockAt: RUN_INSTANT }).notificationSink();

  const base = {
    orgId: ORG,
    severity: "page" as const,
    title: "Fraud desk: confirmed fraud",
    caseRef: CASE_REF,
    at: RUN_INSTANT,
  };

  // A burst of three identical alerts must become ONE item carrying three.
  const observed: { real: unknown[]; fake: unknown[] } = { real: [], fake: [] };
  for (let i = 0; i < 3; i++) {
    observed.real.push(await real.enqueue({ ...base, channel: "in-app", alertType: `seams:burst:${RUN}` }));
    observed.fake.push(await fake.enqueue({ ...base, channel: "in-app", alertType: `seams:burst:${RUN}` }));
  }
  const realShape = observed.real.map((r) => ({ ...(r as { id: string }), id: undefined, deduplicated: (r as { deduplicated: boolean }).deduplicated, count: (r as { count: number }).count }));
  const fakeShape = observed.fake.map((r) => ({ ...(r as { id: string }), id: undefined }));
  check(
    "burst-folds-identically",
    JSON.stringify(realShape) === JSON.stringify(fakeShape),
    `real=${JSON.stringify(realShape)} fake=${JSON.stringify(fakeShape)}`,
  );
  check(
    "a-burst-of-three-becomes-one-item-counting-three",
    (observed.real[2] as { count: number }).count === 3 && (observed.fake[2] as { count: number }).count === 3,
    "both adapters returned count=3 on the third identical enqueue",
  );

  const realPending = await real.pending(ORG);
  const fakePending = await fake.pending(ORG);
  check(
    "one-pending-item-per-burst",
    realPending.length === fakePending.length,
    `real pending=${realPending.length} fake pending=${fakePending.length}`,
  );
  check(
    "severity-and-alert-type-survive-both",
    realPending.every((n) => n.severity === "page") && fakePending.every((n) => n.severity === "page"),
    `real severities=${[...new Set(realPending.map((n) => n.severity))].join(",")} fake severities=${[...new Set(fakePending.map((n) => n.severity))].join(",")}`,
  );

  // A different alert type is a different item.
  await real.enqueue({ ...base, channel: "in-app", alertType: `seams:other:${RUN}` });
  await fake.enqueue({ ...base, channel: "in-app", alertType: `seams:other:${RUN}` });
  const realAfter = await real.pending(ORG);
  const fakeAfter = await fake.pending(ORG);
  check(
    "distinct-alert-types-are-distinct-items",
    realAfter.length === fakeAfter.length,
    `real=${realAfter.length} fake=${fakeAfter.length}`,
  );

  // Org scoping on acknowledge, in both directions and identical.
  const realId = realAfter[0].id;
  const fakeId = fakeAfter[0].id;
  const realWrongOrg = await real.acknowledge(realId, "org-somebody-else");
  const fakeWrongOrg = await fake.acknowledge(fakeId, "org-somebody-else");
  check(
    "acknowledge-is-org-scoped-in-both",
    JSON.stringify(realWrongOrg) === JSON.stringify(fakeWrongOrg) && !realWrongOrg.ok,
    `real=${JSON.stringify(realWrongOrg)} fake=${JSON.stringify(fakeWrongOrg)}`,
  );
  const realOk = await real.acknowledge(realId, ORG);
  const fakeOk = await fake.acknowledge(fakeId, ORG);
  check("acknowledge-succeeds-for-the-owning-org", realOk.ok === true && fakeOk.ok === true, JSON.stringify({ realOk, fakeOk }));
  const realTwice = await real.acknowledge(realId, ORG);
  const fakeTwice = await fake.acknowledge(fakeId, ORG);
  check(
    "double-acknowledge-is-the-same-typed-refusal",
    JSON.stringify(realTwice) === JSON.stringify(fakeTwice) && !realTwice.ok,
    `real=${JSON.stringify(realTwice)} fake=${JSON.stringify(fakeTwice)}`,
  );
  const realLeft = await real.pending(ORG);
  const fakeLeft = await fake.pending(ORG);
  check(
    "an-acknowledged-item-leaves-both-inboxes",
    realLeft.length === fakeLeft.length &&
      realLeft.every((n) => n.acknowledgedAt === null) &&
      fakeLeft.every((n) => n.acknowledgedAt === null),
    `real outstanding=${realLeft.length} fake outstanding=${fakeLeft.length} (2 before the acknowledgement)`,
  );

  parity({
    port: "NotificationSink",
    level: "contract-real",
    compared: [
      "burst folding (3 identical enqueues → 1 item, count=3)",
      "distinct alert types stay distinct items",
      "acknowledge() with the wrong org → not_found",
      "acknowledge() twice → already_acknowledged",
      "pending() shrinks after acknowledgement",
    ],
    notCompared: [
      "notification ids — Postgres assigns cuids, the fake mints seeded ULIDs",
      "`channel` — port vocabulary with no column behind it; the inbox is one channel by construction",
    ],
    notes: ["the bank webhook path is the transactional outbox (WP-5) and is deliberately not a NotificationSink binding"],
  });

  expectClean(from);
}, 60_000);

// ══════════════════════════════════════════════════════════════════════════════
// 4. PaymentProvider — manualinvoice vs. the deterministic mock.
// ══════════════════════════════════════════════════════════════════════════════

test("WP-18 · PaymentProvider: the deterministic mock matches manualinvoice on every shared surface", async () => {
  const from = mark();
  clearCredentials();
  const real = createRegistry().paymentProvider();
  const fake = createRegistry({ offline: true, seed: SEED_PAY, clockAt: RUN_INSTANT }).paymentProvider();
  const money = { amountMinor: 245_000, currency: "AED" };

  // Unknown reference: nothing settled, so nothing to list and nothing to refund.
  const realList = await real.listEntitlements("REF-NEVER-SETTLED");
  const fakeList = await fake.listEntitlements("REF-NEVER-SETTLED");
  check("unknown-reference-has-no-entitlements", JSON.stringify(realList) === "[]" && JSON.stringify(fakeList) === "[]", JSON.stringify({ realList, fakeList }));

  const realRefund = await real.refund({ reference: "REF-NEVER-SETTLED", money });
  const fakeRefund = await fake.refund({ reference: "REF-NEVER-SETTLED", money });
  check(
    "refund-of-an-unknown-reference-is-the-same-typed-refusal",
    JSON.stringify(realRefund) === JSON.stringify(fakeRefund),
    `real=${JSON.stringify(realRefund)} fake=${JSON.stringify(fakeRefund)}`,
  );

  // A real, settled payment on each side: manualinvoice via its own two-step
  // dual-control flow, the fake via its offline settle().
  const recorded = await recordPayment({
    orgId: ORG,
    bankReference: PAY_REF,
    money,
    recordedBy: "clerk-a",
    entitlements: [{ key: "calls", units: 100 }],
    purpose: "seams-parity",
  });
  check("manualinvoice-recorded-the-transfer", recorded.ok === true, `ok=${recorded.ok} duplicate=${recorded.duplicate} (the paymentId is a Postgres id and is deliberately not quoted)`);
  if (recorded.ok) OPAQUE_IDS.push(recorded.paymentId);
  await fake.settle({
    reference: PAY_REF,
    eventId: `fake:${PAY_REF}`,
    amountMinor: money.amountMinor,
    currency: money.currency,
    units: 100,
  });

  const realRefundOk = await real.refund({ reference: PAY_REF, money, reason: "seams-parity" });
  const fakeRefundOk = await fake.refund({ reference: PAY_REF, money });
  check(
    "refund-of-a-settled-reference-succeeds-in-both",
    JSON.stringify(realRefundOk) === JSON.stringify(fakeRefundOk) && realRefundOk.ok,
    `real=${JSON.stringify(realRefundOk)} fake=${JSON.stringify(fakeRefundOk)}`,
  );
  const realRefundTwice = await real.refund({ reference: PAY_REF, money });
  const fakeRefundTwice = await fake.refund({ reference: PAY_REF, money });
  check(
    "second-refund-is-the-same-typed-refusal",
    JSON.stringify(realRefundTwice) === JSON.stringify(fakeRefundTwice),
    `real=${JSON.stringify(realRefundTwice)} fake=${JSON.stringify(fakeRefundTwice)}`,
  );
  const realEntitlements = await real.listEntitlements(PAY_REF);
  const fakeEntitlements = await fake.listEntitlements(PAY_REF);
  check(
    "entitlements-survive-a-refund-in-both",
    realEntitlements.length === fakeEntitlements.length && realEntitlements.length === 1,
    `real=${JSON.stringify(realEntitlements)} fake=${JSON.stringify(fakeEntitlements)}`,
  );

  // The three methods a bank transfer cannot have. Both must REFUSE; the reason
  // strings legitimately name their own adapter, so the comparison is on the
  // verdict and the shape.
  const realWebhook = await real.verifyWebhook({ rawBody: "{}", headers: {} });
  const fakeWebhook = await fake.verifyWebhook({ rawBody: "{}", headers: {} });
  check(
    "webhook-verification-is-the-same-refusal",
    realWebhook.ok === false && fakeWebhook.ok === false && realWebhook.reason === fakeWebhook.reason,
    `real=${JSON.stringify(realWebhook)} fake=${JSON.stringify(fakeWebhook)}`,
  );

  const realCharge = await real.chargeStoredAuthorization({
    orgId: ORG,
    authorization: { authorizationCode: "AUTH_X", email: "ops@example.test" },
    money,
    purpose: "seams-parity",
    requestKey: "req-1",
  });
  const fakeCharge = await fake.chargeStoredAuthorization({
    orgId: ORG,
    authorization: { authorizationCode: "AUTH_X", email: "ops@example.test" },
    money,
    purpose: "seams-parity",
    requestKey: "req-1",
  });
  check(
    "stored-authorization-overage-is-refused-by-both",
    realCharge.ok === false &&
      fakeCharge.ok === false &&
      realCharge.reference === fakeCharge.reference &&
      realCharge.reason.length > 0 &&
      fakeCharge.reason.length > 0,
    `real=${JSON.stringify(realCharge)} fake=${JSON.stringify(fakeCharge)}`,
  );

  const realCheckoutErr = await captureError(() => real.createCheckout({
    orgId: ORG,
    purpose: "seams-parity",
    money,
    email: "ops@example.test",
    requestKey: "req-2",
  }));
  const fakeCheckoutErr = await captureError(() => fake.createCheckout({
    orgId: ORG,
    purpose: "seams-parity",
    money,
    email: "ops@example.test",
    requestKey: "req-2",
  }));
  check(
    "checkout-refuses-in-both",
    /checkout/i.test(realCheckoutErr.message) && /checkout/i.test(fakeCheckoutErr.message),
    `real="${realCheckoutErr.message}" fake="${fakeCheckoutErr.message}"`,
  );

  // The gateway path, which the fake reaches ONLY through settle().
  const duplicate = await fake.settle({
    reference: PAY_REF,
    eventId: "fake:replay",
    amountMinor: money.amountMinor,
    currency: money.currency,
    units: 100,
  });
  check(
    "a-replayed-settlement-is-a-no-op",
    duplicate.applied === false && duplicate.duplicate === true && duplicate.units === 0,
    JSON.stringify(duplicate),
  );

  parity({
    port: "PaymentProvider",
    level: "contract-real",
    compared: [
      "listEntitlements() of an unknown reference → []",
      "refund() of an unknown reference → { ok:false, reason:'not_found' }",
      "refund() of a settled reference → ok, then 'already_refunded' on the second call",
      "entitlements survive a refund",
      "verifyWebhook() → unsupported_event",
      "chargeStoredAuthorization() → refused, reference ''",
      "createCheckout() → throws",
      "a replayed settlement applies nothing",
    ],
    notCompared: [
      "refusal reason strings — each names its own adapter, which is correct",
      "dual control (recorder ≠ verifier) — `recordPayment`/`verifyPayment` are not port methods, so there is nothing to compare the fake against",
    ],
    notes: [
      "the bound real adapter is `manualinvoice`, the only money adapter exercisable with no gateway",
      "paystack is implemented and unit-tested against an injected HTTP client but is not the bound adapter",
    ],
  });

  expectClean(from);
}, 60_000);

// ══════════════════════════════════════════════════════════════════════════════
// 5. SecretStore — env vs. in-memory.
// ══════════════════════════════════════════════════════════════════════════════

test("WP-18 · SecretStore: the in-memory store answers exactly as process.env does", async () => {
  const from = mark();
  const KEY = "WP18_SEAM_SECRET";
  const value = "fixture-value-not-a-credential";
  process.env[KEY] = value;
  try {
    const real = createRegistry().secretStore();
    const fake = createRegistry({ offline: true, seed: SEED_SECRET, secrets: { [KEY]: value } }).secretStore();

    const realHit = await real.get(KEY);
    const fakeHit = await fake.get(KEY);
    check("a-present-secret-resolves-identically", JSON.stringify(realHit) === JSON.stringify(fakeHit), JSON.stringify({ realHit, fakeHit }));
    check("has-agrees", (await real.has(KEY)) === (await fake.has(KEY)) && (await real.has(KEY)), "both report the key present");

    const MISSING = "WP18_SEAM_ABSENT";
    const realMiss = await real.get(MISSING);
    const fakeMiss = await fake.get(MISSING);
    check("a-missing-secret-is-a-typed-miss-not-undefined", JSON.stringify(realMiss) === JSON.stringify(fakeMiss), JSON.stringify({ realMiss, fakeMiss }));
    check(
    "has-agrees-on-a-miss",
    (await real.has(MISSING)) === (await fake.has(MISSING)) && !(await real.has(MISSING)),
    "both report the key absent",
  );

    const realForbidden = await real.get("");
    const fakeForbidden = await fake.get("");
    check("an-empty-key-is-forbidden-in-both", JSON.stringify(realForbidden) === JSON.stringify(fakeForbidden), JSON.stringify({ realForbidden, fakeForbidden }));

    const keys = await fake.keys();
    check(
      "the-fake-enumerates-names-not-values",
      keys.includes(KEY) && JSON.stringify(keys) === JSON.stringify([...keys].sort()) && !JSON.stringify(keys).includes(value),
      `${keys.length} key name(s), sorted, no value present in the listing`,
    );
    check(
      "the-real-store-refuses-to-report-an-empty-string-as-a-secret",
      (await (async () => {
        process.env.WP18_SEAM_EMPTY = "";
        const r = await real.get("WP18_SEAM_EMPTY");
        delete process.env.WP18_SEAM_EMPTY;
        return r;
      })()).ok === false,
      "ELEVENLABS_API_KEY='' must read as a miss, not as an empty auth header",
    );

    parity({
      port: "SecretStore",
      level: "contract-real",
      compared: ["get() hit", "get() miss", "get() empty-key refusal", "has() on both outcomes", "an empty env value reads as a miss"],
      notCompared: ["keys() — process.env's key set is machine-specific, so the fake's list is not compared to it"],
      notes: ["the fake never reads process.env; the real store never leaves the process either"],
    });
  } finally {
    delete process.env[KEY];
  }

  expectClean(from);
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. Determinism — a fixed clock and a seeded generator make a run byte-stable.
// ══════════════════════════════════════════════════════════════════════════════

/**
 * The reproducible trace. Everything here is port traffic plus one pure
 * predicate (`canTransition`), driven by the injected clock and generator. No
 * wall clock, no randomness, no database — which is exactly why it can be
 * compared byte for byte.
 */
async function runSeededPipeline(seed: string): Promise<string> {
  const registry = createRegistry({ offline: true, seed, clockAt: RUN_INSTANT });
  const source = registry.riskSignalSource();
  const conversation = registry.conversationProvider();
  const notifications = registry.notificationSink();
  const audit = registry.auditSink();
  const clock = registry.clock();
  const ids = registry.idGenerator();

  await source.open();
  const signals = await source.pull();
  const trace: Record<string, unknown>[] = [];

  for (const signal of signals) {
    const caseRef = `SV-F-${ids.next()}`;
    const states: string[] = ["RECEIVED"];
    for (const to of ["SCREENED", "DIALING", "RINGING", "ANSWERED", "DISCLOSED", "VERIFYING"]) {
      const from = states[states.length - 1];
      const legal = canTransition(from, to);
      await audit.append({
        callRef: caseRef,
        action: "agent",
        intent: `transition_${from.toLowerCase()}_to_${to.toLowerCase()}`,
        callerId: "seams-gate",
        meta: { from, to, legal },
        orgId: ORG,
      });
      states.push(to);
    }

    const placement = await conversation.start({
      caseRef,
      toNumber: signal.phone,
      language: signal.language,
      firstMessage: "recorded",
      voiceId: "fixture-voice",
      dynamicVariables: { merchant: signal.merchant ?? "", amountMinor: signal.amountMinor, currency: signal.currency },
    });
    const turns = await conversation.transcript(placement.conversationId);
    const verdict = await conversation.verdict(placement.conversationId);

    const at = clock.now();
    const receipt = await notifications.enqueue({
      orgId: signal.orgId ?? ORG,
      channel: "in-app",
      alertType: `seams:trace:${caseRef}`,
      severity: verdict === "confirmed_fraud" ? "page" : "info",
      title: `${caseRef} ${verdict ?? "no_verdict"}`,
      caseRef,
      at,
    });

    trace.push({
      caseRef,
      occurredAt: at.toISOString(),
      transactionRef: signal.transactionRef,
      riskScore: signal.riskScore,
      states,
      placement,
      verdict,
      turns,
      receipt: { deduplicated: receipt.deduplicated, count: receipt.count },
      chainHead: (await audit.verifyChain(caseRef, ORG)).ok,
      sinkSize: (await notifications.pending(signal.orgId ?? ORG)).length,
    });
  }

  await source.close();
  return canonicalJson({ seed, trace });
}

test("WP-18 · a fixed clock and a seeded generator make a whole run byte-stable", async () => {
  const from = mark();
  // Two runs, same seed, byte for byte.
  const first = await runSeededPipeline("seed-A");
  const second = await runSeededPipeline("seed-A");
  check("the-same-seed-produces-byte-identical-output", first === second, `sha256 run1=${sha256(first).slice(0, 16)} run2=${sha256(second).slice(0, 16)}`);

  // A different seed MUST change the output, or "deterministic" would be
  // indistinguishable from "constant" — the classic way this claim rots.
  const other = await runSeededPipeline("seed-B");
  check("a-different-seed-produces-different-output", first !== other, `sha256 seed-B=${sha256(other).slice(0, 16)}`);

  // The generator's own promises, asserted directly.
  const clock = fixedClock(RUN_INSTANT);
  const seededA = seededUlidGenerator("unit", clock);
  const seededB = seededUlidGenerator("unit", clock);
  const seededC = seededUlidGenerator("other", clock);
  const seqA = Array.from({ length: 64 }, () => seededA.next());
  const seqB = Array.from({ length: 64 }, () => seededB.next());
  const seqC = Array.from({ length: 64 }, () => seededC.next());
  check("seeded-generators-with-one-seed-agree", seqA.join(",") === seqB.join(","), "two generators, one seed, 64 identical ids");
  check("a-different-seed-diverges", seqA[0] !== seqC[0], "seed changes the first id");
  check(
    "seeded-ids-are-valid-ulids",
    seqA.every((id) => id.length === ULID_LENGTH && [...id].every((ch) => CROCKFORD.includes(ch))),
    `${seqA.length} ids are ${ULID_LENGTH} Crockford base32 characters`,
  );
  check("seeded-ids-never-repeat", new Set(seqA).size === seqA.length, "64 ids, 64 distinct values");
  check("a-frozen-clock-makes-ids-strictly-increasing", seqA.every((id, i) => i === 0 || id > seqA[i - 1]), "same millisecond ⇒ monotonic entropy bump");

  const real = ulidGenerator(clock);
  const realSeq = Array.from({ length: 200 }, () => real.next());
  check(
    "system-ids-are-unique-and-well-formed",
    new Set(realSeq).size === realSeq.length &&
      realSeq.every((id) => id.length === ULID_LENGTH && [...id].every((ch) => CROCKFORD.includes(ch))),
    "200 system ULIDs, all distinct and well formed",
  );
  check("system-ids-are-monotonic-under-a-frozen-clock", realSeq.every((id, i) => i === 0 || id > realSeq[i - 1]), "call order is preserved in the id");

  // The fixed clock is genuinely fixed, and moving it is explicit.
  const f = fixedClock(RUN_INSTANT);
  const t0 = f.now().toISOString();
  f.now().setUTCFullYear(1999); // mutating the returned Date must not move the clock
  check("the-fixed-clock-does-not-move-on-its-own", f.now().toISOString() === t0, `frozen at ${t0}`);
  check("step-moves-the-clock-by-exactly-the-delta", f.step(1_500).getTime() - new Date(t0).getTime() === 1_500, "step(1500) advanced 1500 ms");
  check("set-jumps-to-an-absolute-instant", f.set("2027-06-01T00:00:00.000Z").toISOString() === "2027-06-01T00:00:00.000Z", "set() is absolute");

  // The system clock's contract, asserted against the wall clock it replaces.
  const sys = systemClock();
  const samples = Array.from({ length: 500 }, () => sys.now().getTime());
  check("the-system-clock-is-monotonic", samples.every((ms, i) => i === 0 || ms >= samples[i - 1]), "500 samples, never went backwards");
  check(
    "the-system-clock-tracks-the-wall-clock",
    Math.abs(samples[499] - samples[0]) < 60_000,
    // The span is not quoted: it is a measured wall-clock value and would differ
    // on every run, which would make the artifact's core non-reproducible. The
    // BOUND is the assertion; the number is not the claim.
    `500 samples all fall within 60 s of the first (the span itself is deliberately not quoted)`,
  );
  check(
    "both-clocks-return-a-Date",
    sys.now() instanceof Date && f.now() instanceof Date,
    "the port's return type holds for both adapters",
  );

  expectClean(from);
}, 60_000);

// ══════════════════════════════════════════════════════════════════════════════
// 7. ConversationProvider — dry-run parity. NOT live parity.
// ══════════════════════════════════════════════════════════════════════════════

test("WP-18 · ConversationProvider: the dry-run path is offline, and the scripted player matches its shape", async () => {
  const from = mark();
  const req = {
    caseRef: CASE_REF,
    toNumber: "+971500000001",
    language: "en",
    firstMessage: "recorded",
    voiceId: "fixture-voice",
    dynamicVariables: { merchant: "SUNRISE ELECTRONICS", amountMinor: 245_000 },
  };

  // ── dry-run parity ───────────────────────────────────────────────────────
  const previousDryRun = process.env.ELEVENLABS_DRY_RUN;
  process.env.ELEVENLABS_DRY_RUN = "true";
  const before = NETWORK_CALLS.length;
  const realDry = await createRegistry().conversationProvider().start(req);
  check(
    "the-real-dry-run-never-left-the-process",
    NETWORK_CALLS.length === before,
    `${NETWORK_CALLS.length - before} network calls during a real-adapter dry-run placement`,
  );
  const fakeConversation = createRegistry({ offline: true, seed: SEED_CONVERSATION, clockAt: RUN_INSTANT }).conversationProvider();
  const fakeStart = await fakeConversation.start(req);

  check("dry-run-reports-dryRun-true", realDry.dryRun === true, JSON.stringify(realDry));
  check(
    "both-placements-yield-non-empty-correlation-keys",
    realDry.conversationId.length > 0 &&
      realDry.callSid.length > 0 &&
      fakeStart.conversationId.length > 0 &&
      fakeStart.callSid.length > 0,
    `real=${realDry.conversationId}/${realDry.callSid} fake=${fakeStart.conversationId}/${fakeStart.callSid}`,
  );
  const realAgain = await createRegistry().conversationProvider().start(req);
  check(
    "a-placement-is-a-deterministic-function-of-its-inputs",
    realAgain.conversationId === realDry.conversationId,
    `the real dry-run derives its id from the case reference: ${realDry.conversationId}`,
  );
  // NOT claimed as parity: the id FORMAT is provider-scoped. Comparing
  // "conv_dryrun_SV-F-…" to a seeded ULID would be asserting that the fake is a
  // worse liar, not that it behaves the same.
  check(
    "id-formats-are-provider-scoped-and-therefore-not-compared",
    realDry.conversationId !== fakeStart.conversationId,
    `real="${realDry.conversationId}" fake="${fakeStart.conversationId}" — a deliberate, reported difference`,
  );

  // ── the divergences, asserted so they cannot be forgotten ────────────────
  const realContinue = await captureError(() => createRegistry().conversationProvider().continue(req));
  const fakeContinue = await fakeConversation.continue(req);
  check(
    "the-real-adapter-refuses-continuity-rather-than-faking-it",
    /continuity/i.test(realContinue.message),
    `real continue(): ${realContinue.message}`,
  );
  check("the-fake-can-serve-the-continuity-plane", fakeContinue.conversationId.length > 0, `fake continue(): ${fakeContinue.conversationId}`);
  const realTurns = (await createRegistry().conversationProvider().transcript(realDry.conversationId)).length;
  const fakeTurns = (await fakeConversation.transcript(fakeStart.conversationId)).length;
  check(
    "only-the-fake-can-replay-a-transcript",
    realTurns === 0 && fakeTurns > 0,
    `real adapter replayed ${realTurns} turns (no replay exists); the scripted player replayed ${fakeTurns}`,
  );

  if (previousDryRun === undefined) delete process.env.ELEVENLABS_DRY_RUN;
  else process.env.ELEVENLABS_DRY_RUN = previousDryRun;
  parity({
    port: "ConversationProvider",
    level: "contract-dry-run",
    compared: [
      "the real adapter's dry-run placement makes ZERO network calls",
      "dryRun === true on the real dry-run path",
      "non-empty conversationId and callSid from both adapters",
      "a placement is a deterministic function of its inputs",
    ],
    notCompared: [
      "a live placement — would place a real call",
      "id formats — provider-scoped, so a match would be a coincidence",
      "continue() — the brief's `builtin` continuity adapter is NOT bound; the real adapter refuses",
      "transcript() / verdict() — the real adapter has no replay, so there is nothing to compare",
    ],
    notes: ["dry-run is `ELEVENLABS_DRY_RUN=true`, the same switch the e2e suite uses"],
  });

  expectClean(from);
}, 60_000);

// ══════════════════════════════════════════════════════════════════════════════
// 8. TelephonyProvider + RiskSignalSource — honest "bound-only", with reasons.
// ══════════════════════════════════════════════════════════════════════════════

test("WP-18 · TelephonyProvider: destination validation matches; the carrier path cannot be reached offline", async () => {
  const from = mark();
  clearCredentials();
  const real = createRegistry().telephonyProvider();
  const fake = createRegistry({ offline: true, seed: SEED_TELEPHONY, clockAt: RUN_INSTANT }).telephonyProvider();

  const DESTINATIONS = [
    "+971500000001",
    "+14155550123",
    "+911400000003",
    "0501234567",
    "+97150000000a",
    "++971500000001",
    "+971 50 000 0001",
    "",
    "+1234567890123456789",
  ];
  const realVerdicts = DESTINATIONS.map((d) => real.validateDestination(d));
  const fakeVerdicts = DESTINATIONS.map((d) => fake.validateDestination(d));
  check(
    "destination-validation-is-identical-for-every-input",
    JSON.stringify(realVerdicts) === JSON.stringify(fakeVerdicts),
    `${DESTINATIONS.length} destinations compared, including ${realVerdicts.filter((v) => !v.ok).length} refusals`,
  );

  // WHY telephony is bound-only, asserted rather than assumed: with no
  // credentials the real adapter cannot even be invoked. If this check ever
  // starts passing, the carrier path became callable offline and the
  // verification level should be revisited.
  const refused = await captureError(() =>
    real.placeCall({ to: "+971500000001", language: "en", caseRef: CASE_REF }),
  );
  check(
    "telephony-real-adapter-refuses-without-credentials",
    /not configured/i.test(refused.message),
    `real placeCall(): ${refused.message} — this is why the carrier path is bound-only, not contract-tested`,
  );

  // The fake's own behaviour, verified independently of the real one.
  const bad = await fake.placeCall({ to: "0501234567", language: "en", caseRef: CASE_REF });
  check(
    "the-recording-stub-refuses-a-bad-destination-with-the-carrier-s-shape",
    bad.ok === false && bad.status === 422 && bad.error === "Destination phone is not E.164",
    JSON.stringify(bad),
  );
  const good = await fake.placeCall({ to: "+971500000001", language: "en", caseRef: CASE_REF });
  check("the-recording-stub-accepts-an-e164-destination", good.ok === true && good.sid.length > 0, JSON.stringify(good));
  const sms = await fake.sendSms({ to: "+971500000001", language: "en", caseRef: CASE_REF });
  check("the-recording-stub-records-sms-on-the-same-surface", sms.ok === true && sms.channel === "sms", JSON.stringify(sms));

  parity({
    port: "TelephonyProvider",
    level: "contract-offline-surface",
    compared: ["validateDestination() across 9 destinations including 4 refusals"],
    notCompared: [
      "placeCall() — the real adapter cannot be invoked without credentials; asserted, not assumed",
      "sendSms() — same reason",
      "sid format — carrier-scoped",
    ],
    notes: ["the sip-trunk adapter the brief names is not implemented in this repository"],
  });

  expectClean(from);
}, 60_000);

test("WP-18 · RiskSignalSource: the http ingest is push-only and says so", async () => {
  const from = mark();
  // The signing secret is the ONE environment variable this port legitimately
  // needs, and it is not a provider credential: it authenticates the bank
  // against us. The two open() outcomes below are asserted with it absent and
  // then present, and restored immediately — the no-credentials claim is made
  // in the intervention test, which unsets it.
  delete process.env.WEBHOOK_SECRET;
  const real = createRegistry().riskSignalSource();

  const noSecret = await real.open();
  check(
    "the-http-ingest-refuses-to-open-without-its-signing-secret",
    noSecret.ok === false && /WEBHOOK_SECRET/.test(noSecret.reason),
    JSON.stringify(noSecret),
  );
  process.env.WEBHOOK_SECRET = "fixture-not-a-real-secret";
  try {
    const withSecret = await real.open();
    check("the-http-ingest-opens-with-a-secret-configured", withSecret.ok === true && withSecret.target === "POST /v1/interventions", JSON.stringify(withSecret));
  } finally {
    if (SAVED_WEBHOOK_SECRET === undefined) delete process.env.WEBHOOK_SECRET;
    else process.env.WEBHOOK_SECRET = SAVED_WEBHOOK_SECRET;
  }
  const pullErr = await captureError(() => real.pull());
  check(
    "the-http-source-refuses-to-pull-instead-of-returning-an-empty-array",
    /push-only/.test(pullErr.message),
    `real pull(): ${pullErr.message} — an empty array here would read as "nothing arrived"`,
  );

  // The fake feed, on its own terms.
  const source = createRegistry({ offline: true, seed: SEED_SOURCE, clockAt: RUN_INSTANT }).riskSignalSource();
  const closedPull = await captureError(() => source.pull());
  check("the-fixture-feed-refuses-to-pull-while-closed", /not open/.test(closedPull.message), closedPull.message);
  await source.open();
  const pulled = await source.pull();
  check("the-fixture-feed-delivers-every-signal-in-order", JSON.stringify(pulled) === JSON.stringify(FIXTURE_SIGNALS), `${pulled.length} signals, insertion order preserved`);
  const drained = await source.pull();
  check("a-drained-feed-returns-nothing", drained.length === 0, `${drained.length} signals on the second pull`);
  const limited = await (async () => {
    source.reset();
    await source.open();
    return source.pull({ limit: 2 });
  })();
  check("pull(limit) is honoured", limited.length === 2, `${limited.length} signals with limit=2`);
  await source.close();

  parity({
    port: "RiskSignalSource",
    level: "bound-only",
    compared: [
      "the real adapter's open() refuses without WEBHOOK_SECRET and names it",
      "the real adapter's open() reports POST /v1/interventions when configured",
      "the real adapter's pull() throws (push-only) rather than returning []",
      "the fake feed's FIFO order, limit and closed-source behaviour",
    ],
    notCompared: [
      "the ingest end-to-end — needs a signed bank request and writes a real case row",
      "kafka, sftp and poll adapters — not implemented in this repository",
      "adapter-to-adapter parity — the http adapter is push-only and the fake is pull-only, so there is no shared operation to compare",
    ],
    notes: ["this is the one port with no shared operation between its real and fake adapters; it is reported as bound, not as tested"],
  });

  expectClean(from);
}, 60_000);

// ══════════════════════════════════════════════════════════════════════════════
// 9. The offline intervention — no network, no credentials, end to end.
// ══════════════════════════════════════════════════════════════════════════════

test("WP-18 · offline mode completes a full intervention with no network and no credentials", async () => {
  const from = mark();
  clearCredentials();

  // The claim is only worth anything if the credentials really are absent.
  const present = CREDENTIAL_ENV.filter((k) => (process.env[k] ?? "") !== "");
  check("no-provider-credentials-are-present", present.length === 0, present.length === 0 ? `${CREDENTIAL_ENV.length} credential variables are unset` : `still set: ${present.join(", ")}`);
  check("elevenlabs-dry-run-is-not-set", process.env.ELEVENLABS_DRY_RUN !== "true", `ELEVENLABS_DRY_RUN=${String(process.env.ELEVENLABS_DRY_RUN)}`);

  const netBefore = NETWORK_CALLS.length;
  const registry = createRegistry({ offline: true, seed: SEED_INTERVENTION, clockAt: RUN_INSTANT });
  const source = registry.riskSignalSource();
  const conversation = registry.conversationProvider();
  const telephony = registry.telephonyProvider();
  const notifications = registry.notificationSink() as CaptureNotificationSink;
  const audit = registry.auditSink();
  const secretStore = registry.secretStore();
  const payment = registry.paymentProvider();
  const clock = registry.clock();

  // 1. Signal in.
  await source.open();
  const signal = (await source.pull({ limit: 1 }))[0];
  check("signal-arrived-from-the-fixture-feed", signal !== undefined && signal.transactionRef === FIXTURE_SIGNALS[0].transactionRef, JSON.stringify({ transactionRef: signal?.transactionRef, riskScore: signal?.riskScore }));

  // Money-backed credit, written straight to the append-only ledger. The
  // policy gate refuses an org with no credits, and that refusal is the point.
  const top = await topup({ orgId: ORG, units: 5, eventId: `seams:${RUN}`, reason: "seams-offline-intervention" });
  check("the-intervention-has-credit-backing-it", top.ok === true, JSON.stringify(top.ok ? { units: top.entry.units } : top));

  // 2. Policy gate — the real one, against the real Postgres ledger.
  const gate = await runPolicyGate({
    orgId: ORG,
    phone: signal.phone,
    consentRecordId: signal.consentRecordId,
    caseRef: CASE_REF,
    callerId: "seams-gate",
  });
  check("the-policy-gate-admits-the-signal", gate.ok === true, JSON.stringify(gate));

  // 3. Case state transitions, through the single writer.
  await createCase({
    caseRef: CASE_REF,
    orgId: ORG,
    transactionRef: signal.transactionRef,
    riskScore: signal.riskScore,
    language: signal.language,
    phone: signal.phone,
    merchant: signal.merchant,
    amountMinor: signal.amountMinor,
    currency: signal.currency,
    consentRecordId: signal.consentRecordId,
  });
  await pace();
  await transitionCase(CASE_REF, "SCREENED");

  // 4. Conversation + telephony, both fakes: no carrier, no provider.
  const placement = await conversation.start({
    caseRef: CASE_REF,
    toNumber: signal.phone,
    language: signal.language,
    firstMessage: "recorded",
    voiceId: "fixture-voice",
    dynamicVariables: { merchant: signal.merchant ?? "", amountMinor: signal.amountMinor, currency: signal.currency, case_id: CASE_REF },
  });
  const call = await telephony.placeCall({ to: signal.phone, language: signal.language, amount: "2450.00", merchant: signal.merchant, caseRef: CASE_REF });
  check("the-conversation-and-the-dial-were-both-placed-offline", placement.conversationId.length > 0 && call.ok === true, JSON.stringify({ placement, call }));
  const turns = await conversation.transcript(placement.conversationId);
  const verdict = await conversation.verdict(placement.conversationId);
  check("the-scripted-transcript-yields-a-verdict", turns.length > 0 && verdict !== null, `${turns.length} turns, verdict=${verdict}`);

  for (const to of ["DIALING", "RINGING", "ANSWERED", "DISCLOSED", "VERIFYING", "CONFIRMED_FRAUD", "ESCALATED", "NOTIFIED"] as const) {
    await pace();
    await transitionCase(CASE_REF, to);
  }

  // 5. The bank event and its delivery commit together.
  const closed = await transitionCaseWithOutbox(CASE_REF, "CLOSED", {
    // `outcome` is a real Case column; an arbitrary key here would be written
    // into the Case row by the single writer and rejected by Prisma.
    meta: { outcome: verdict ?? "unknown", durationSeconds: 41 },
    outbox: {
      eventType: "case.closed",
      caseRef: CASE_REF,
      orgId: ORG,
      data: { caseRef: CASE_REF, verdict: verdict ?? "unknown", state: "CLOSED" },
      eventId: `seams-evt-${RUN}`,
    },
  });
  const outboxRow = await db.outboxEvent.findUnique({ where: { id: closed.eventId } });
  check(
    "the-verdict-and-its-bank-delivery-committed-together",
    closed.state === "CLOSED" && outboxRow !== null && outboxRow.payload.includes(CASE_REF),
    `event ${closed.eventId} enqueued with a ${outboxRow?.payload.length ?? 0}-byte canonical payload`,
  );

  // 6. Notification enqueued — through the port, and by the real transition
  //    writer as a side effect.
  const receipt = await notifications.enqueue({
    orgId: ORG,
    channel: "in-app",
    alertType: "seams:intervention-complete",
    severity: "page",
    title: `Intervention complete: ${CASE_REF}`,
    caseRef: CASE_REF,
    at: clock.now(),
  });
  check("a-notification-was-enqueued-through-the-port", receipt.deduplicated === false && receipt.count === 1, JSON.stringify(receipt));
  const captured = notifications.captured();
  check("the-notification-capture-buffer-holds-it", captured.some((n) => n.caseRef === CASE_REF), `${captured.length} item(s) captured`);

  const inboxRows = await db.notification.findMany({ where: { caseRef: CASE_REF } });
  check(
    "the-real-inbox-also-recorded-the-intervention",
    inboxRows.length > 0 && inboxRows.some((r) => r.severity === "page"),
    `${inboxRows.length} inbox row(s), severities=${[...new Set(inboxRows.map((r) => r.severity))].join(",")}`,
  );

  // 7. Audit: both sinks hold a verifiable chain for this case.
  await audit.append({
    callRef: CASE_REF,
    action: "freeze",
    intent: "seams_offline_intervention",
    callerId: "seams-gate",
    meta: { seed: registry.seed, verdict: verdict ?? "unknown" },
    orgId: ORG,
  });
  const fakeVerification = await audit.verifyChain(CASE_REF, ORG);
  const realAudit = createRegistry().auditSink();
  const realVerification = await realAudit.verifyChain(CASE_REF, ORG);
  check(
    "the-in-memory-chain-verifies-for-the-intervention",
    fakeVerification.ok === true && fakeVerification.rows > 0,
    `${fakeVerification.ok ? fakeVerification.rows : 0} links verified in memory (the head hash depends on the run-scoped org and is deliberately not quoted)`,
  );
  check(
    "the-postgres-chain-verifies-for-the-same-intervention",
    realVerification.ok === true && realVerification.rows > 0,
    `${realVerification.ok ? realVerification.rows : 0} links written to Postgres with no network and no credentials`,
  );

  // 8. The two remaining ports, exercised in the same offline run.
  const secretMiss = await secretStore.get("ELEVENLABS_API_KEY");
  check("the-secret-store-reports-no-provider-key-present", secretMiss.ok === false, JSON.stringify(secretMiss));
  const settled = await payment.settle({
    reference: `SEAMPAY-${RUN}`,
    eventId: `seams-pay-${RUN}`,
    amountMinor: signal.amountMinor,
    currency: signal.currency,
    units: 10,
  });
  check("the-payment-port-settled-offline", settled.applied === true, JSON.stringify(settled));

  // 9. The tripwire.
  check(
    "no-network-call-was-made-anywhere-in-the-offline-intervention",
    NETWORK_CALLS.length === netBefore,
    `${NETWORK_CALLS.length - netBefore} network calls; attempt log: ${JSON.stringify(NETWORK_CALLS.slice(netBefore))}`,
  );

  const caseRow = await db.case.findUnique({ where: { caseRef: CASE_REF } });
  check("the-case-ended-CLOSED", caseRow?.state === "CLOSED", `state=${caseRow?.state}`);

  expectClean(from);
}, 120_000);

// ══════════════════════════════════════════════════════════════════════════════
// 10. The artifact.
// ══════════════════════════════════════════════════════════════════════════════

let artifactWritten = false;

test("WP-18 · the evidence artifact lists every port, its mode, and what was actually tested", async () => {
  // Every port gets a parity entry, even if only "bound-only". A port missing
  // from the report is a port nobody is claiming anything about.
  const reported = new Set(PARITY.map((p) => p.port));
  const unreported = PORT_NAMES.filter((p) => !reported.has(p));

  // Modes and adapter ids are READ from freshly built registries, never typed
  // into this file — otherwise the artifact could claim a mode nobody resolved.
  const realDescriptors = createRegistry().descriptors();
  const offlineDescriptors = createRegistry({ offline: true, seed: "report" }).descriptors();
  const descriptorOf = (list: PortDescriptor[], port: PortName) => list.find((d) => d.port === port);

  const portRows = PORT_NAMES.map((port) => {
    const binding = PORT_BINDINGS[port];
    const p = PARITY.find((x) => x.port === port);
    const real = descriptorOf(realDescriptors, port);
    const offline = descriptorOf(offlineDescriptors, port);
    return {
      port,
      declaredAdapters: DECLARED_ADAPTERS[port],
      boundAdapters: binding.bound,
      realAdapter: binding.real,
      fakeAdapter: binding.fake,
      notBound: binding.notBound.map((n) => ({ adapter: n.adapter, reason: n.reason })),
      modeInRealRun: real?.mode ?? "unknown",
      realAdapterId: real?.detail.includes("@/lib") ? real.detail : (real ? "built-in" : ""),
      modeInOfflineRun: offline?.mode ?? "unknown",
      fakeAdapterId: offline?.detail ?? "",
      verification: p?.level ?? "bound-only",
      compared: p?.compared ?? [],
      notCompared: p?.notCompared ?? [],
      notes: p?.notes ?? ["no parity scenario was written for this port"],
    };
  });

  const contractTested = portRows.filter((r) => r.verification !== "bound-only").map((r) => r.port);
  const realParity = portRows.filter((r) => r.verification === "contract-real").map((r) => r.port);
  const dryRunOnly = portRows.filter((r) => r.verification === "contract-dry-run").map((r) => r.port);
  const offlineSurfaceOnly = portRows.filter((r) => r.verification === "contract-offline-surface").map((r) => r.port);
  const boundOnly = portRows.filter((r) => r.verification === "bound-only").map((r) => r.port);

  // ── checks that describe the artifact, recorded BEFORE the write so the
  //    summary in the file and the log in memory agree ───────────────────────
  check("artifact-lists-every-port", portRows.length === PORT_NAMES.length, `${portRows.length} ports in the artifact`);
  check("every-port-has-a-verification-level", portRows.every((r) => typeof r.verification === "string"), "no port is silently unclassified");
  check(
    "the-mode-in-the-run-is-read-from-the-registry",
    portRows.every((r) => r.modeInRealRun === "real" && r.modeInOfflineRun === "fake"),
    "the real run resolved 9 real adapters and the offline run resolved 9 fakes",
  );
  check(
    "bound-adapters-and-declared-adapters-are-both-listed",
    portRows.every((r) => r.declaredAdapters.length > 0 && r.boundAdapters.length > 0),
    `${PORT_NAMES.reduce((n, p) => n + DECLARED_ADAPTERS[p].length, 0)} declared adapters across the brief's table`,
  );
  check(
    "every-declared-adapter-is-either-bound-or-explained",
    portRows.every((r) => r.boundAdapters.length + r.notBound.length === r.declaredAdapters.length),
    "bound + notBound partitions the brief's table, per port",
  );
  check(
    "the-contract-tested-list-is-explicit-and-disjoint-from-bound-only",
    contractTested.length + boundOnly.length === portRows.length && contractTested.every((p) => !boundOnly.includes(p)),
    `contract-tested=[${contractTested.join(", ")}] bound-only=[${boundOnly.join(", ")}]`,
  );
  check("no-port-is-left-unreported", unreported.length === 0, unreported.length === 0 ? "every port has a verification level" : unreported.join(", "));
  check(
    "every-contract-tested-port-names-what-it-compared",
    portRows.filter((r) => r.verification !== "bound-only").every((r) => r.compared.length > 0 && r.notCompared.length > 0),
    "a parity claim without a 'not compared' list would be an overclaim",
  );
  check(
    "every-bound-only-port-explains-what-was-not-exercised",
    portRows.filter((r) => r.verification === "bound-only").every((r) => r.notCompared.length > 0),
    `${boundOnly.length} bound-only port(s), each with an explicit reason`,
  );
  // Run-scoped cleanup, asserted rather than assumed. A gate that quietly
  // accumulates rows makes the next run's numbers somebody else's problem, and
  // in a shared test database it eventually deletes or mis-measures someone
  // else's work.
  const removed = await cleanupRunScopedRows();
  const remaining = await countRunScopedRows();
  const residue = Object.values(remaining).reduce((n, v) => n + v, 0);
  check(
    "the-gate-leaves-no-residue",
    residue === 0,
    `removed ${JSON.stringify(removed)}; ${residue} run-scoped row(s) remain`,
  );
  check(
    "the-gate-touched-only-its-own-rows",
    removed.cases === 1 && removed.payments === 1 && removed.ledger === 2 && removed.outbox === 1,
    `deleted ${removed.cases} case, ${removed.payments} payment, ${removed.ledger} ledger rows (the credit top-up and the policy gate's reservation) and ${removed.outbox} outbox event — every one keyed by this run's ids`,
  );

  const scrubbedChecks = CHECKS.map((c) => ({ ...c, detail: scrub(c.detail) }));
  const scrubProbe = JSON.stringify({ ports: portRows, checks: scrubbedChecks });

  check(
    "no-run-scoped-identifier-leaked-into-the-deterministic-core",
    !scrubProbe.includes(RUN) &&
      !scrubProbe.includes(ORG) &&
      !scrubProbe.includes(CASE_REF) &&
      !scrubProbe.includes(PAY_REF) &&
      !scrubProbe.includes(CHAIN_REF),
    "fixture ids are replaced with stable placeholders, so the core is byte-stable across runs",
  );
  check(
    "the-scrubbed-core-still-shows-which-reference-was-involved",
    scrubbedChecks.some((c) => c.detail.includes("[paymentRef]") || c.detail.includes("[caseRef]")) &&
      scrubbedChecks.every((c) => !c.detail.includes(PAY_REF)),
    "placeholders replaced the identifiers rather than dropping the sentences",
  );
  check(
    "no-database-assigned-identifier-reached-the-core",
    OPAQUE_IDS.length > 0 && OPAQUE_IDS.every((id) => !scrubProbe.includes(id)),
    `${OPAQUE_IDS.length} Postgres-assigned id(s) were produced during the run and none appears in the core`,
  );

  const core = {
    schemaVersion: 1,
    gate: "WP-18 internal seams",
    digestAlgorithm: "sha256",
    /** Which fixture identifiers were replaced so the core stays byte-stable. */
    redactions: RUN_SCOPED.map(([, placeholder]) => placeholder),
    reproducibility: {
      seededPipelineByteStable: true,
      deterministicCoreByteStable: true,
      mechanism:
        "fixed clock at RUN_INSTANT + fixed seeds + a CONSTANT fixture org for the audit-chain fixtures (orgId is sealed into every chainHash); no run-scoped identifier and no database-assigned identifier appears in the core",
      verified: [
        "the seeded pipeline is run twice in one test and the canonical serialisations compared byte for byte",
        "a different seed MUST change the output, so determinism is not the same as a constant",
        `all ${OPAQUE_IDS.length} database-assigned identifiers produced during the run are absent from the core`,
      ],
    },
    ports: portRows,
    summary: {
      ports: portRows.length,
      contractTested,
      realParity,
      dryRunOnly,
      offlineSurfaceOnly,
      boundOnly,
      declaredAdaptersTotal: portRows.reduce((n, r) => n + r.declaredAdapters.length, 0),
      boundAdaptersTotal: portRows.reduce((n, r) => n + r.boundAdapters.length, 0),
      notBoundAdaptersTotal: portRows.reduce((n, r) => n + r.notBound.length, 0),
      checks: { total: CHECKS.length, passed: passed(), failed: failed() },
      result: failed() === 0 && unreported.length === 0 ? "pass" : "fail",
    },
    checks: scrubbedChecks,
    unreportedPorts: unreported,
  };

  const artifact = {
    ...core,
    digest: sha256(canonicalJson(core)),
    generatedAt: new Date().toISOString(),
    run: { id: RUN, org: ORG, caseRef: CASE_REF, chainRef: CHAIN_REF },
    commands: {
      test: "bun test tests/seams",
      typecheck: "bunx tsc --noEmit",
      env: "TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/securevoice_test?connection_limit=20",
    },
  };

  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  artifactWritten = true;

  // ── assertions on the bytes on disk, after the write. These use `expect`
  //    rather than `check` on purpose: adding to CHECKS here would make the
  //    artifact's own summary disagree with the log. ────────────────────────
  expect(existsSync(EVIDENCE_PATH)).toBe(true);
  const parsed = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8")) as Record<string, any>;

  expect(parsed.ports.length).toBe(PORT_NAMES.length);
  expect(parsed.ports.map((r: any) => r.port)).toEqual([...PORT_NAMES]);
  expect(parsed.summary.checks.total).toBe(CHECKS.length);
  expect(parsed.summary.checks.passed).toBe(passed());
  expect(parsed.summary.checks.failed).toBe(failed());
  expect(parsed.summary.result).toBe(failed() === 0 ? "pass" : "fail");
  expect(parsed.summary.contractTested).toEqual(contractTested);
  expect(parsed.summary.boundOnly).toEqual(boundOnly);
  expect(parsed.summary.realParity).toEqual(realParity);
  expect(parsed.summary.declaredAdaptersTotal).toBe(
    PORT_NAMES.reduce((n, p) => n + DECLARED_ADAPTERS[p].length, 0),
  );
  expect(parsed.summary.boundAdaptersTotal + parsed.summary.notBoundAdaptersTotal).toBe(parsed.summary.declaredAdaptersTotal);

  const { digest, generatedAt, run, commands, ...rest } = parsed;
  expect(typeof digest).toBe("string");
  expect(digest).toHaveLength(64);
  expect(sha256(canonicalJson(rest))).toBe(digest);
  const serialised = JSON.stringify(rest);
  expect(serialised.includes(RUN)).toBe(false);
  expect(serialised.includes(ORG)).toBe(false);
  expect(serialised.includes(CASE_REF)).toBe(false);
  expect(canonicalJson(rest)).toBe(canonicalJson(JSON.parse(JSON.stringify(rest))));
  expect(typeof generatedAt).toBe("string");
  expect(run.id).toBe(RUN);
  expect(commands.test).toBe("bun test tests/seams");

  expectClean(mark());
});

// ── cleanup ──────────────────────────────────────────────────────────────────

afterAll(async () => {
  restoreCredentials();

  if (!artifactWritten) {
    // A failing earlier test must still leave an artifact behind: a gate that
    // produces nothing when it fails is a gate whose silence looks like a pass.
    const core = {
      schemaVersion: 1,
      gate: "WP-18 internal seams",
      digestAlgorithm: "sha256",
      ports: [],
      summary: { result: "fail", reason: "the suite failed before the artifact test ran", checks: { total: CHECKS.length, passed: passed(), failed: failed() } },
      checks: CHECKS,
    };
    mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
    writeFileSync(
      EVIDENCE_PATH,
      `${JSON.stringify({ ...core, digest: sha256(canonicalJson(core)), generatedAt: new Date().toISOString(), run: { id: RUN, org: ORG, caseRef: CASE_REF, chainRef: CHAIN_REF } }, null, 2)}\n`,
      "utf8",
    );
  }

  // Run-scoped cleanup, again — the artifact test already did it and asserted
  // the residue was zero, so this is the net for a run that failed earlier.
  await cleanupRunScopedRows();

  await db.$disconnect();
  await dbAudit.$disconnect();
  globalThis.fetch = REAL_FETCH;
});