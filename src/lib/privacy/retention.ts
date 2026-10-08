import "server-only";
/**
 * Retention: per-organisation tiered deletion with a bounded, dry-run-capable
 * sweeper. WP-15.
 *
 * Tiers (the platform defaults; every one is overridable per org):
 *
 *   audio          30 days — call recordings. 0 days for an org that requires
 *                  immediate deletion (pilots under a no-recording agreement).
 *   transcripts    90 days — the sealed case payload.
 *   caseRecords    7 years — the redacted case row itself.
 *   audit          forever, hashes only — the chain.
 *
 * ── The rule that decides the whole design ──────────────────────────────────
 * The audit chain CANNOT be retained or deleted "except for the text". Every
 * `AuditLog` field is either hashed into the next link
 * (`chainHash = sha256(prevHash ‖ canonicalRow)`, canonical over callRef,
 * action, intent, callerId, redactedText, meta, orgId) or is the link itself
 * (`prevHash`). Dropping `redactedText` changes the canonical form, so the row's
 * own `chainHash` no longer matches what `verifyChain()` recomputes and the
 * chain breaks at that row. The only "repair" is to recompute that row and
 * every descendant — which produces a chain indistinguishable from an
 * untouched one, i.e. it destroys the tamper-evidence the chain exists to give.
 *
 * So retention is REFUSED on `AuditLog`, and that refusal is a code path
 * (`assertRetentionMutationAllowed`), not a comment. "Forever, hashes only" is
 * then true by construction in the sense that matters: the chain stores no
 * personal data in the first place — every audit row is PII-free at write time
 * (`src/lib/redact.ts`, I-10) — so there is nothing there for a deletion
 * deadline to reach.
 *
 * Where a deadline DOES have to be met, it is met against the ciphertext: the
 * transcript tier shreds the per-case data key (see crypto-shred.ts), after
 * which the sealed payload is inert. Deleting the key rather than the row is
 * what lets a 90-day deadline and an append-only log coexist.
 *
 * ── Operational shape ───────────────────────────────────────────────────────
 * `runRetention()` works one org at a time (a tier configured for org A must
 * never decide org B's deadline), in bounded batches with an explicit cursor, so
 * a sweeper cannot hold a long transaction or take the pool hostage, and it
 * reports `truncated` so the scheduler knows to call again. It re-verifies
 * every chain it touched with the real `verifyChain()` and fails loudly if one
 * is not intact — a retention run that broke a chain is an incident, and the
 * correct response is to stop, not to re-anchor the chain.
 */

import type { Prisma } from "@/generated/prisma/client";
import { env } from "@/lib/config";
import { db } from "@/lib/db";
import { verifyChain } from "@/lib/audit-chain";
import {
  CHAIN_PROTECTED_COLUMNS,
  deleteCaseRecord,
  eraseCase,
  type CasePayloadColumn,
} from "@/lib/privacy/crypto-shred";

export const DAY_MS = 86_400_000;

// ── Tiers and defaults ────────────────────────────────────────────────────────

export const TIERS = ["audio", "transcripts", "caseRecords", "audit"] as const;
export type Tier = (typeof TIERS)[number];

/** Sweeper order. Audio is purged before the payload is shredded, and the
 *  payload before the case row is deleted — running them in one pass in any
 *  other order would delete the row before shredding what it protected. */
export const TIER_ORDER: readonly Tier[] = ["audio", "transcripts", "caseRecords"];

/** The audit tier is not a number on purpose: it is the chain, and the chain is
 *  append-only. Encoding it as `Infinity` would invite a `<= cutoff` comparison
 *  somewhere. */
export const AUDIT_RETENTION = "forever-hashes-only" as const;

export const DEFAULT_RETENTION_DAYS = {
  audio: 30,
  transcripts: 90,
  caseRecords: 7 * 365,
} as const;

/** An org that must hold no recording at all — deletion is immediate (0 days). */
export const PILOT_AUDIO_DAYS = 0;

export const ENV_AUDIO_DAYS = "PRIVACY_AUDIO_RETENTION_DAYS";
export const ENV_TRANSCRIPT_DAYS = "PRIVACY_TRANSCRIPT_RETENTION_DAYS";
export const ENV_CASE_RECORD_DAYS = "PRIVACY_CASE_RECORD_RETENTION_DAYS";
export const ENV_PILOT_ORGS = "PRIVACY_PILOT_ORG_IDS";

export class RetentionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetentionConfigError";
  }
}

export type TierDays = {
  audioDays?: number;
  transcriptDays?: number;
  caseRecordDays?: number;
};

export type TierSource = "default" | "env" | "pilot" | "override";

export type RetentionPolicy = {
  orgId: string | null;
  audioDays: number;
  transcriptDays: number;
  caseRecordDays: number;
  audit: typeof AUDIT_RETENTION;
  /** Where each tier's number came from — recorded in the run report so a
   *  surprising deletion can be explained without reading this file. */
  sources: Record<"audio" | "transcripts" | "caseRecords", TierSource>;
  /** Human-readable notes (pilot rule applied, env override in force, …). */
  notes: string[];
};

const OVERRIDES = new Map<string, Required<TierDays>>();
/** Key for the shared (org-less) namespace. The NUL prefix means a real org can
 *  never collide with it, so a caller cannot impersonate "shared". */
const SHARED_ORG_KEY = "\u0000shared";
const orgKey = (orgId: string | null): string => (orgId === null ? SHARED_ORG_KEY : orgId);

/** Reject anything that is not a whole number of days >= 0. A negative day count
 *  would make a cutoff in the FUTURE and silently shred live cases. */
function assertDays(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RetentionConfigError(
      `${name} must be a whole number of days >= 0, got ${String(value)}`,
    );
  }
  return value;
}

function envDays(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new RetentionConfigError(`${name} must be a whole number of days >= 0, got "${raw}"`);
  }
  return parsed;
}

function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Per-org retention overrides. Not persisted: there is no policy table in the
 * schema for WP-15, and inventing one is a migration, not a code change. The
 * precedence is default < env < pilot rule < this map, so an explicit override
 * always wins and is visible in `sources`.
 */
export function configureRetention(orgId: string | null, tiers: TierDays): RetentionPolicy {
  const next: Required<TierDays> = {
    ...(OVERRIDES.get(orgKey(orgId)) ?? { audioDays: 0, transcriptDays: 0, caseRecordDays: 0 }),
  };
  for (const [name, value] of Object.entries(tiers) as [keyof TierDays, number | undefined][]) {
    if (value === undefined) continue;
    next[name] = assertDays(name, value);
  }
  OVERRIDES.set(orgKey(orgId), next);
  return retentionPolicy(orgId);
}

/** Forget every programmatic override. Test and administrative hygiene. */
export function resetRetentionConfig(): void {
  OVERRIDES.clear();
}

/** Org ids that currently carry an explicit programmatic override. */
export function configuredOrgs(): string[] {
  return [...OVERRIDES.keys()].filter((key) => key !== SHARED_ORG_KEY);
}

/** True when this org is configured to keep no recording at all. */
export function isPilotOrg(orgId: string | null): boolean {
  if (orgId === null) return false;
  return envList(ENV_PILOT_ORGS).includes(orgId);
}

/**
 * Resolve the effective policy for one org. Pure and env-reading, so a caller
 * (or the evidence writer) can ask "what would you delete today, and why?"
 * without running a sweep.
 */
export function retentionPolicy(orgId: string | null): RetentionPolicy {
  const notes: string[] = [];
  const sources: RetentionPolicy["sources"] = {
    audio: "default",
    transcripts: "default",
    caseRecords: "default",
  };

  const envAudio = envDays(ENV_AUDIO_DAYS);
  const envTranscript = envDays(ENV_TRANSCRIPT_DAYS);
  const envCase = envDays(ENV_CASE_RECORD_DAYS);

  let audioDays = envAudio ?? DEFAULT_RETENTION_DAYS.audio;
  let transcriptDays = envTranscript ?? DEFAULT_RETENTION_DAYS.transcripts;
  let caseRecordDays = envCase ?? DEFAULT_RETENTION_DAYS.caseRecords;
  if (envAudio !== null) {
    sources.audio = "env";
    notes.push(`${ENV_AUDIO_DAYS}=${envAudio}`);
  }
  if (envTranscript !== null) {
    sources.transcripts = "env";
    notes.push(`${ENV_TRANSCRIPT_DAYS}=${envTranscript}`);
  }
  if (envCase !== null) {
    sources.caseRecords = "env";
    notes.push(`${ENV_CASE_RECORD_DAYS}=${envCase}`);
  }

  // Pilots that require it: no recording is ever retained, so the audio tier is
  // due the instant the call ends (0 days → cutoff === now).
  if (isPilotOrg(orgId)) {
    audioDays = PILOT_AUDIO_DAYS;
    sources.audio = "pilot";
    notes.push(`org is listed in ${ENV_PILOT_ORGS}: audio retention is ${PILOT_AUDIO_DAYS} days`);
  }

  const override = OVERRIDES.get(orgKey(orgId));
  if (override) {
    if (override.audioDays !== 0 || sources.audio === "default") {
      audioDays = override.audioDays;
      sources.audio = "override";
    }
    transcriptDays = override.transcriptDays;
    sources.transcripts = "override";
    caseRecordDays = override.caseRecordDays;
    sources.caseRecords = "override";
    notes.push("programmatic override in force");
  }

  return {
    orgId,
    audioDays: assertDays("audioDays", audioDays),
    transcriptDays: assertDays("transcriptDays", transcriptDays),
    caseRecordDays: assertDays("caseRecordDays", caseRecordDays),
    audit: AUDIT_RETENTION,
    sources,
    notes,
  };
}

// ── The chain-protection rule ────────────────────────────────────────────────

export class ChainMutationRefusedError extends Error {
  constructor(
    public readonly target: string,
    public readonly columns: readonly string[],
    public readonly rowsDeleted: number,
  ) {
    super(
      `Retention refuses ${rowsDeleted > 0 ? `to delete ${rowsDeleted} ` : `to write `}${target} ` +
        `column(s) [${columns.join(", ")}]. Every AuditLog field is sealed into the hash chain ` +
        `(${CHAIN_PROTECTED_COLUMNS.join(", ")}): removing one breaks the chain at that row, and ` +
        `re-deriving the hashes produces a chain indistinguishable from an untouched one — ` +
        `which is the one property the chain exists to provide. Personal data is kept out of the ` +
        `chain at write time instead (redact.ts), and a deletion deadline is met by shredding the ` +
        `per-case data key, not by editing a chained row.`,
    );
    this.name = "ChainMutationRefusedError";
  }
}

export type RetentionMutation = {
  target: "AuditLog" | "Case";
  columns: readonly string[];
  /** Rows the caller intends to delete (audit rows are never deletable). */
  rowsDeleted?: number;
};

/**
 * The single enforcement point for "retention must never mutate the audit
 * chain". Every write the sweeper performs goes through here, so a future tier
 * cannot quietly start editing `redactedText`: it has to name its columns and
 * this throws. `Case` columns are allowed (no hash covers them) and must still
 * be named, which keeps the receipt honest.
 */
export function assertRetentionMutationAllowed(mutation: RetentionMutation): void {
  if (mutation.target !== "AuditLog") return;
  if (mutation.columns.length > 0 || (mutation.rowsDeleted ?? 0) > 0) {
    throw new ChainMutationRefusedError(
      mutation.target,
      mutation.columns,
      mutation.rowsDeleted ?? 0,
    );
  }
}

/** What the audit tier does, stated as data rather than as intent. */
export const AUDIT_TIER_DECISION = Object.freeze({
  tier: "audit" as const,
  policy: AUDIT_RETENTION,
  action: "append-only" as const,
  rowsDeleted: 0,
  rowsUpdated: 0,
  columns: Object.freeze([] as readonly string[]),
  protectedColumns: CHAIN_PROTECTED_COLUMNS,
  reason:
    "The chain commits to the redacted rows it already holds, and those rows are PII-free by " +
    "construction (I-10). Nothing in the chain is personal data, so no deletion deadline can reach " +
    "it; where one could, the per-case data key is shredded instead of the row being edited.",
});

// ── The audio store seam ─────────────────────────────────────────────────────

/**
 * The platform stores no call recording (I-10: the provider is the system of
 * record), so the audio tier has nothing local to delete. Rather than pretend,
 * the tier purges a REGISTERED store: the integration point for wherever
 * recordings do exist (provider-side deletion, an S3 prefix, a transcript
 * vendor). With no store registered the tier reports `none-configured` and
 * deletes nothing — a real answer, and the one the gate asserts.
 */
export type AudioArtifact = { id: string; caseRef: string; bytes: number };

export interface AudioStore {
  listForCase(caseRef: string): Promise<AudioArtifact[]>;
  deleteForCase(caseRef: string): Promise<number>;
}

const NO_AUDIO_STORE: AudioStore = {
  async listForCase() {
    return [];
  },
  async deleteForCase() {
    return 0;
  },
};

let audioStore: AudioStore = NO_AUDIO_STORE;

export function registerAudioStore(store: AudioStore | null): void {
  audioStore = store ?? NO_AUDIO_STORE;
}

export function audioStoreConfigured(): boolean {
  return audioStore !== NO_AUDIO_STORE;
}

// ── The selector ─────────────────────────────────────────────────────────────

export type TierAction =
  "purgeAudio" | "shredPayloadKey" | "deleteCaseRecord" | "chainProtectedAppendOnly";

export type DueTier = {
  tier: Tier;
  /** Days in the window. 0 means "due immediately". */
  days: number;
  cutoff: Date | null;
  /** True when rows can be due at `at` at all (a finite window). */
  due: boolean;
  where: Prisma.CaseWhereInput;
  action: TierAction;
  /** The columns this tier writes, and how many rows it deletes — fed to
   *  `assertRetentionMutationAllowed` before anything runs. */
  mutation: RetentionMutation;
  note: string;
};

export type DueSelector = {
  at: Date;
  orgId: string | null;
  policy: RetentionPolicy;
  tiers: Record<Tier, DueTier>;
};

/** Rows whose payload/audio landed before `cutoff`. `postCallAt` is when the
 *  call ended; `createdAt` is the fallback for a case that never got a
 *  post-call ingest (so an un-ingested case still ages out on the clock). */
function agedWhere(orgId: string | null, cutoff: Date): Prisma.CaseWhereInput {
  return {
    orgId,
    OR: [{ postCallAt: { lt: cutoff } }, { postCallAt: null, createdAt: { lt: cutoff } }],
  };
}

/**
 * …and, for the payload tier, only while the case still HOLDS something.
 * Without this clause a shredded case re-enters the selection on every run
 * forever: the window has closed but shredding does not move `createdAt`, so the
 * sweeper would re-read (and re-decide) the same rows until the backlog is
 * exhausted — a quiet denial-of-service against the database.
 */
function holdsPayloadWhere(): Prisma.CaseWhereInput {
  return {
    OR: [
      { dataKeyEnc: { not: null } },
      { transcriptRedacted: { not: null } },
      { evaluationResults: { not: null } },
      { dataCollectionResults: { not: null } },
    ],
  };
}

/**
 * The selector: what is due at `at`, per tier, for one org — expressed as
 * Prisma predicates so the sweeper and any operator query share ONE definition
 * of "due" instead of two that can drift.
 */
export function dueForDeletion(at: Date, opts: { orgId?: string | null } = {}): DueSelector {
  const orgId = opts.orgId ?? null;
  const policy = retentionPolicy(orgId);
  const cutoffFor = (days: number): Date => new Date(at.getTime() - days * DAY_MS);

  const audioCutoff = cutoffFor(policy.audioDays);
  const transcriptCutoff = cutoffFor(policy.transcriptDays);
  const recordCutoff = cutoffFor(policy.caseRecordDays);

  return {
    at,
    orgId,
    policy,
    tiers: {
      audio: {
        tier: "audio",
        days: policy.audioDays,
        cutoff: audioCutoff,
        due: true,
        where: agedWhere(orgId, audioCutoff),
        action: "purgeAudio",
        mutation: { target: "Case", columns: [] },
        note:
          policy.audioDays === 0
            ? "immediate (pilot / no-recording agreement): every call in this org is due at once"
            : `recordings older than ${policy.audioDays} days; none are stored on our side unless an audio store is registered`,
      },
      transcripts: {
        tier: "transcripts",
        days: policy.transcriptDays,
        cutoff: transcriptCutoff,
        due: true,
        where: { AND: [agedWhere(orgId, transcriptCutoff), holdsPayloadWhere()] },
        action: "shredPayloadKey",
        mutation: { target: "Case", columns: ["dataKeyEnc", "erasedAt", ...PAYLOAD_COLUMNS] },
        note:
          `payloads older than ${policy.transcriptDays} days that still hold a key or text: shred the ` +
          `per-case data key and clear the plaintext columns. The ciphertext stays in the chain ` +
          `(deleting it would break the chain) and is inert without the key.`,
      },
      caseRecords: {
        tier: "caseRecords",
        days: policy.caseRecordDays,
        cutoff: recordCutoff,
        due: true,
        where: { orgId, createdAt: { lt: recordCutoff } },
        action: "deleteCaseRecord",
        mutation: { target: "Case", columns: [] },
        note: `redacted case rows older than ${policy.caseRecordDays} days; the case's audit chain is unaffected`,
      },
      audit: {
        tier: "audit",
        days: Number.POSITIVE_INFINITY,
        cutoff: null,
        due: false,
        // An empty predicate is never executed: `due` is false and the sweeper
        // skips the tier. It is `{}` rather than a "match nothing" filter so a
        // future caller that ignores `due` gets an obvious, auditable mistake
        // (every row) rather than a silent no-op.
        where: {},
        action: "chainProtectedAppendOnly",
        mutation: { target: "AuditLog", columns: [], rowsDeleted: 0 },
        note: AUDIT_TIER_DECISION.reason,
      },
    },
  };
}

const PAYLOAD_COLUMNS: readonly CasePayloadColumn[] = [
  "transcriptRedacted",
  "evaluationResults",
  "dataCollectionResults",
];

// ── The sweeper ──────────────────────────────────────────────────────────────

export type RetentionRunOptions = {
  /** Report what would happen; write nothing. */
  dryRun?: boolean;
  /** Rows per batch per tier. */
  batchSize?: number;
  /** Batches per tier before yielding, so one run cannot monopolise the pool. */
  maxBatchesPerTier?: number;
  /** Restrict the run to these orgs. Omit to sweep every org present in `Case`. */
  orgIds?: (string | null)[];
  /** Hard cap on orgs per run. */
  maxOrgs?: number;
};

export type TierReport = {
  tier: Tier;
  due: number;
  acted: number;
  batches: number;
  truncated: boolean;
  caseRefs: string[];
};

export type RetentionRunReport = {
  at: string;
  dryRun: boolean;
  batchSize: number;
  maxBatchesPerTier: number;
  orgs: { orgId: string | null; policy: RetentionPolicy }[];
  tiers: Record<Tier, TierReport>;
  audioStore: "configured" | "none-configured";
  audit: typeof AUDIT_TIER_DECISION;
  payloadsShredded: number;
  caseRecordsDeleted: number;
  audioArtifactsPurged: number;
  chain: { refsChecked: number; intact: boolean; brokenAt: string | null };
  /** `tier: null` means the failure was not attributable to one tier (a policy
   *  that would not resolve, a mutation the guard refused). */
  errors: { caseRef: string; tier: Tier | null; stage: string; error: string }[];
};

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_BATCHES = 20;
const DEFAULT_MAX_ORGS = 1_000;
/** How many caseRefs a tier's report carries before it stops appending. */
const REPORTED_REFS_CAP = env.retentionReportCap;

/** Every org that currently has a case row, plus any org with an explicit
 *  override (so a configured org with zero cases is still evaluated). */
async function orgsToSweep(
  explicit: (string | null)[] | undefined,
  max: number,
): Promise<(string | null)[]> {
  if (explicit) return explicit.slice(0, max);
  const rows = await db.case.groupBy({ by: ["orgId"] });
  const orgs = new Set<string | null>(rows.map((r) => r.orgId as string | null));
  for (const org of configuredOrgs()) orgs.add(org);
  // The shared namespace is always evaluated: rows with orgId IS NULL are real
  // data (seeded/demo cases) and a policy that never looks at them is a policy
  // that leaks.
  orgs.add(null);
  return [...orgs].slice(0, max);
}

/**
 * Run the sweeper. Bounded per tier, per org, and honest about being cut short.
 *
 * `dryRun` writes nothing at all — it still reports exactly how many rows each
 * tier WOULD act on, so the operator-facing "what runs tonight" answer and the
 * nightly job cannot disagree.
 */
export async function runRetention(
  now: Date = new Date(),
  opts: RetentionRunOptions = {},
): Promise<RetentionRunReport> {
  const dryRun = opts.dryRun ?? false;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatchesPerTier = opts.maxBatchesPerTier ?? DEFAULT_MAX_BATCHES;
  const maxOrgs = opts.maxOrgs ?? DEFAULT_MAX_ORGS;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RetentionConfigError(
      `batchSize must be a positive integer, got ${String(batchSize)}`,
    );
  }
  if (!Number.isInteger(maxBatchesPerTier) || maxBatchesPerTier < 1) {
    throw new RetentionConfigError(
      `maxBatchesPerTier must be a positive integer, got ${String(maxBatchesPerTier)}`,
    );
  }

  const report: RetentionRunReport = {
    at: now.toISOString(),
    dryRun,
    batchSize,
    maxBatchesPerTier,
    orgs: [],
    // The audit tier is never selected (see TIER_ORDER); its numbers stay zero
    // by construction, which is exactly the report a DPO wants to read.
    tiers: {
      audio: { tier: "audio", due: 0, acted: 0, batches: 0, truncated: false, caseRefs: [] },
      transcripts: {
        tier: "transcripts",
        due: 0,
        acted: 0,
        batches: 0,
        truncated: false,
        caseRefs: [],
      },
      caseRecords: {
        tier: "caseRecords",
        due: 0,
        acted: 0,
        batches: 0,
        truncated: false,
        caseRefs: [],
      },
      audit: { tier: "audit", due: 0, acted: 0, batches: 0, truncated: false, caseRefs: [] },
    },
    audioStore: audioStoreConfigured() ? "configured" : "none-configured",
    audit: AUDIT_TIER_DECISION,
    payloadsShredded: 0,
    caseRecordsDeleted: 0,
    audioArtifactsPurged: 0,
    chain: { refsChecked: 0, intact: true, brokenAt: null },
    errors: [],
  };

  const orgs = await orgsToSweep(opts.orgIds, maxOrgs);
  // caseRef -> orgId. The sweep crosses org boundaries, but chain verification
  // is org-scoped, so the owning org has to travel with the ref. Passing null
  // would silently skip every org-scoped chain and report false corruption.
  const touchedRefs = new Map<string, string | null>();

  for (const orgId of orgs) {
    let selector: DueSelector;
    try {
      selector = dueForDeletion(now, { orgId });
    } catch (error) {
      report.errors.push({
        caseRef: "",
        tier: null,
        stage: "resolve-policy",
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    report.orgs.push({ orgId, policy: selector.policy });

    for (const tier of TIER_ORDER) {
      const due = selector.tiers[tier];
      // The audit tier is never selected: `due` is false and `where` is `{}`.
      if (!due.due) continue;
      // Enforcement, not documentation: name the writes before performing them.
      try {
        assertRetentionMutationAllowed(due.mutation);
      } catch (error) {
        report.errors.push({
          caseRef: "",
          tier,
          stage: "assert-mutation-allowed",
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      // Keyset cursor, so a tier whose action does not mutate the row (the audio
      // tier, when nothing is stored) still advances instead of re-reading the
      // same batch forever.
      let cursor: { at: Date; ref: string } | null = null;
      for (let batch = 0; batch < maxBatchesPerTier; batch++) {
        const where: Prisma.CaseWhereInput = cursor
          ? {
              AND: [
                due.where,
                {
                  OR: [
                    { createdAt: { gt: cursor.at } },
                    { createdAt: cursor.at, caseRef: { gt: cursor.ref } },
                  ],
                },
              ],
            }
          : due.where;

        let rows: { caseRef: string; createdAt: Date; orgId: string | null }[];
        try {
          rows = await db.case.findMany({
            where,
            // orgId travels with the row: chain verification is org-scoped, so
            // the sweep has to know which namespace each ref belongs to.
            select: { caseRef: true, createdAt: true, orgId: true },
            orderBy: [{ createdAt: "asc" }, { caseRef: "asc" }],
            take: batchSize,
          });
        } catch (error) {
          report.errors.push({
            caseRef: "",
            tier,
            stage: "select",
            error: error instanceof Error ? error.message : String(error),
          });
          break;
        }
        if (rows.length === 0) break;

        report.tiers[tier].batches += 1;
        report.tiers[tier].due += rows.length;
        // The report is a receipt, not a dump: a full-scope nightly run touches
        // thousands of rows and `caseRefs` exists so an operator can look up the
        // cases in a UI, not to be serialised into a cron log.
        for (const row of rows) {
          if (report.tiers[tier].caseRefs.length < REPORTED_REFS_CAP) {
            report.tiers[tier].caseRefs.push(row.caseRef);
          }
        }
        // `if (rows.length === 0) break;` above proved this batch is non-empty and
        // nothing reassigns `rows` in between, so the final element exists.
        const lastRow = rows[rows.length - 1]!;
        cursor = { at: lastRow.createdAt, ref: lastRow.caseRef };
        if (rows.length === batchSize) report.tiers[tier].truncated = true;

        if (dryRun) continue;

        for (const row of rows) {
          try {
            const acted = await applyTierAction(tier, row.caseRef, report);
            if (acted) report.tiers[tier].acted += 1;
          } catch (error) {
            // One bad row must not abort the sweep: a case whose chain is
            // mid-append, say. It is logged and reported, never swallowed.
            const message = error instanceof Error ? error.message : String(error);
            report.errors.push({ caseRef: row.caseRef, tier, stage: "act", error: message });
            console.error(`[retention] ${tier} failed for ${row.caseRef}: ${message}`);
          }
          touchedRefs.set(row.caseRef, row.orgId ?? null);
        }
      }
    }
  }

  // Re-verify every chain this run touched, with the production verifier. A
  // retention job that broke a chain is an incident: say so, do not re-anchor.
  for (const [ref, refOrgId] of touchedRefs) {
    if (report.chain.brokenAt) break;
    try {
      const verification = await verifyChain(ref, refOrgId);
      report.chain.refsChecked += 1;
      if (!verification.ok) {
        report.chain.intact = false;
        report.chain.brokenAt = ref;
        console.error(
          `[retention] INVARIANT I-6 VIOLATED: chain for ${ref} does not verify ` +
            `(expected ${verification.expected}, actual ${verification.actual})`,
        );
      }
    } catch (error) {
      report.chain.intact = false;
      report.chain.brokenAt = ref;
      console.error(`[retention] chain verification failed for ${ref}: ${error}`);
    }
  }

  return report;
}

async function applyTierAction(
  tier: Tier,
  caseRef: string,
  report: RetentionRunReport,
): Promise<boolean> {
  switch (tier) {
    case "audio": {
      if (!audioStoreConfigured()) return false;
      const purged = await audioStore.deleteForCase(caseRef);
      report.audioArtifactsPurged += purged;
      return purged > 0;
    }
    case "transcripts": {
      // Key shredding, not row editing: this is the tier that reconciles a
      // deletion deadline with an append-only log.
      const result = await eraseCase(caseRef, {
        reason: "retention:transcripts",
        requestedBy: "retention-sweeper",
        legalBasis: `retention:${report.dryRun ? "dry-run" : "applied"}`,
      });
      if (!result.alreadyErased) report.payloadsShredded += 1;
      return !result.alreadyErased;
    }
    case "caseRecords": {
      await deleteCaseRecord(caseRef, {
        reason: "retention:caseRecords",
        requestedBy: "retention-sweeper",
      });
      report.caseRecordsDeleted += 1;
      return true;
    }
    case "audit":
      // Unreachable: `due` is false for the audit tier and TIER_ORDER omits it.
      // Present so the switch is exhaustive and a future caller gets a refusal
      // rather than silence.
      throw new ChainMutationRefusedError("AuditLog", AUDIT_TIER_DECISION.columns, 1);
    default: {
      const exhaustive: never = tier;
      throw new Error(`unknown retention tier: ${String(exhaustive)}`);
    }
  }
}
