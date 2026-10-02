/**
 * The evidence recorder for the WP-21 gate.
 *
 * Two properties the artifact has to have:
 *
 *   1. **Deterministic.** The same set of outcomes must produce byte-identical
 *      JSON. That rules out timestamps, run ids, durations and anything derived
 *      from them — so this module records none, and says so in the artifact.
 *   2. **Sorted.** Every list is sorted by a declared key before serialisation,
 *      because "sorted" is what makes a diff between two runs readable instead
 *      of noise.
 *
 * The digest covers the payload only (not the digest field itself), using a
 * canonical JSON serialisation with keys sorted at every depth — the same
 * canonicalisation `src/lib/outbox.ts` uses for signed payloads, reimplemented
 * here so a hermetic failure-semantics gate does not have to construct a Prisma
 * client to hash a file.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Check = { area: string; name: string; ok: boolean; detail: string };

const checks: Check[] = [];

export type MatrixRow = {
  id: string;
  condition: string;
  required: string;
  observed: string;
  ok: boolean;
};

const matrixRows: MatrixRow[] = [];

export type BreakerRow = {
  dependency: string;
  declared: string;
  channel: string;
  secondary: string | null;
  alerts: boolean;
  degraded: boolean;
  preservesIntervention: boolean;
  retryAfterSec: number;
  lifecycle: string[];
  transitionsObserved: string[];
  fallbackInvoked: boolean;
  primaryInvokedWhileOpen: boolean;
  ok: boolean;
};

const breakerRows: BreakerRow[] = [];

export type FailurePayload = { [section: string]: unknown };

const sections: FailurePayload = {};

/** Record one machine-checked assertion. Every assertion in the gate goes here. */
export function record(area: string, name: string, ok: boolean, detail: string): boolean {
  checks.push({ area, name, ok, detail });
  return ok;
}

/** Record one row of the declared database failure matrix. */
export function recordMatrixRow(row: Omit<MatrixRow, "ok"> & { ok: boolean }): void {
  matrixRows.push(row);
}

/** Record one breaker's declared fallback and observed lifecycle. */
export function recordBreakerRow(row: BreakerRow): void {
  breakerRows.push(row);
}

/** Record an arbitrary evidence section (envelope map, timeout tree, scan). */
export function recordSection(id: string, value: unknown): void {
  sections[id] = value;
}

/** Deterministic JSON: object keys sorted at every depth. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") return Number.isFinite(value as number) ? JSON.stringify(value) : "null";
  if (t === "boolean" || t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (t === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return "null";
}

export function sortedChecks(): Check[] {
  return [...checks].sort((a, b) =>
    a.area === b.area ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.area < b.area ? -1 : 1,
  );
}

export function sortedMatrixRows(): MatrixRow[] {
  return [...matrixRows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function sortedBreakerRows(): BreakerRow[] {
  return [...breakerRows].sort((a, b) => (a.dependency < b.dependency ? -1 : a.dependency > b.dependency ? 1 : 0));
}

/** Build the artifact. Pure with respect to the filesystem. */
export function buildEvidence(): Record<string, unknown> {
  const allChecks = sortedChecks();
  const failed = allChecks.filter((c) => !c.ok);
  const sortedSections: Record<string, unknown> = {};
  for (const key of Object.keys(sections).sort()) sortedSections[key] = sections[key];

  const payload = {
    schemaVersion: 1,
    gate: "WP-21 failure semantics for the API and the database",
    determinism: {
      wallClockIncluded: false,
      randomIdentifiersIncluded: false,
      sortOrder: "sections by id, checks by (area, name), matrix rows by id, breakers by dependency",
      note: "No timestamp and no run id is recorded. The artifact must be byte-identical for an identical set of outcomes, so a clock reading would make every diff meaningless.",
    },
    database: {
      used: false,
      note: "Every row of the matrix is driven by a synthetic error object, so the gate does not need a live database and cannot be made to fail by breaking one.",
    },
    ...sortedSections,
    summary: {
      result: failed.length === 0 ? "pass" : "fail",
      areas: new Set(allChecks.map((c) => c.area)).size,
      checks: {
        total: allChecks.length,
        passed: allChecks.length - failed.length,
        failed: failed.length,
      },
      matrixRows: { total: sortedMatrixRows().length, ok: sortedMatrixRows().filter((r) => r.ok).length },
      breakers: { total: sortedBreakerRows().length, ok: sortedBreakerRows().filter((r) => r.ok).length },
      failedChecks: failed.map((c) => ({ area: c.area, name: c.name, detail: c.detail })),
    },
    checks: allChecks,
    matrix: sortedMatrixRows(),
    breakers: sortedBreakerRows(),
  };

  const digest = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  return {
    ...payload,
    digestAlgorithm: "sha256",
    digest,
  };
}

/** Write the artifact, creating its directory. Called once, from `afterAll`. */
export function writeEvidence(path: string): { bytes: number; digest: string } {
  const evidence = buildEvidence();
  mkdirSync(dirname(path), { recursive: true });
  const text = `${JSON.stringify(evidence, null, 2)}\n`;
  writeFileSync(path, text, "utf8");
  return { bytes: Buffer.byteLength(text, "utf8"), digest: evidence.digest as string };
}