/**
 * WP-12 GATE — multi-tenancy isolation, proven.
 *
 * Two orgs, one run id, every read path in the isolation matrix, both
 * directions, and a machine-readable artifact at
 * `evidence/tenancy/isolation.json`.
 *
 *   cd C:\Users\HP\Desktop\SecureVoiceai
 *   $env:TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/securevoice_test?connection_limit=20"
 *   bun test tests/tenancy/isolation.test.ts
 *
 * This file is the gate (what must be true). `probe-registry.ts` holds the
 * fixtures and the per-read-path probes (how each path is exercised).
 *
 * Four jobs, in order:
 *
 *   1. FAIL CLOSED ON THE MATRIX. The canonical read-path list and the matrix
 *      must be the SAME set. A new read path promised but not probed fails; a
 *      matrix entry promising coverage the canonical list does not also fails.
 *      No filesystem scan is involved — a scan finds syntax, not a predicate.
 *   2. PROVE THE GUARD IS FAIL-CLOSED. A caller that forgets the scope gets a
 *      typed error naming the model, never an unscoped read.
 *   3. PROBE EVERY PATH × BOTH DIRECTIONS against two live orgs, and assert
 *      404-not-403 explicitly wherever the path has an id-shaped HTTP probe.
 *      Every probe carries a CONTROL (the org's own identifier) so a route that
 *      returns nothing to everybody cannot pass as "isolated", and the
 *      verdict-level assertions are derived HERE from the recorded outcome, so
 *      a driver cannot under-report a leak it observed.
 *   4. WRITE THE EVIDENCE before asserting on it, so the artifact exists even
 *      when the run fails, then re-read it and assert it is well-formed and
 *      digest-stable.
 *
 * Honesty rules this gate follows, because a green gate that hides a leak is
 * worse than no gate:
 *   · A read path that is NOT org-isolated today is `declared-gap`: it is
 *     probed, the leak is recorded in the artifact, and the gate ASSERTS THAT
 *     THE LEAK IS GONE. While the gap is open the check fails and this suite is
 *     RED — the build surfaces the open cross-tenant read, grouped and named,
 *     instead of reporting success. This is the opposite of what the gate used
 *     to do: it required the leak to still reproduce, so the suite was green
 *     precisely because the defect was present, and no reader of a green build
 *     could tell the difference. Closing a gap turns the check green and the
 *     entry must then be reclassified so the artifact stops advertising it.
 *   · The gap set is PINNED, so a new gap fails the gate and a fixed gap also
 *     fails until the entry is reclassified. Neither direction can be forgotten.
 *   · A path that cannot be probed without stealing shared state is
 *     `declared-global`, with the reason inline and a real declaration check.
 *   · Fixture identifiers never appear in the evidence; only the static matrix
 *     metadata and the boolean results do, so the artifact is byte-stable.
 */

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { db } from "@/lib/db";
import {
  PLATFORM_MODELS,
  TENANCY_BYPASS,
  TENANTED_MODELS,
  TenancyScopeError,
  assertScoped,
  hasOrgPredicate,
  inScopeTransaction,
  isTenancyScopeError,
  isTenantedModel,
  orgScopeFor,
  scopeKey,
  scopeWhere,
  scopedDb,
  type OrgScope,
} from "@/lib/tenancy/guard";
import {
  CANONICAL_READ_PATHS,
  ISOLATION_MATRIX,
  canonicalIds,
  canonicalModels,
  matrixEntry,
  matrixIds,
  type ReadPath,
} from "@/lib/tenancy/isolation-matrix";
import {
  DRIVERS,
  CONSENT_ID,
  CONSENT_PHONE,
  ID,
  NOT_PROBED_GUARD,
  ORG,
  RUN,
  asOrg,
  check,
  me,
  req,
  them,
  type Check,
  type Direction,
  type GuardEquivalent,
  type RawOutcome,
  type Side,
} from "./probe-registry";
type DirectionOutcome = {
  direction: Direction;
  sessionOrg: Side;
  probeOwner: Side;
  probed: boolean;
  axisApplicable: boolean;
  http: { method: string; route: string; status: number | null } | null;
  control: { described: string; status: number | null; ownVisible: boolean | null } | null;
  foreignVisible: boolean | null;
  foreignMutated: boolean | null;
  guardEquivalent: GuardEquivalent;
  checks: Check[];
  ok: boolean;
  error: string | null;
};

type PathOutcome = {
  path: string;
  title: string;
  model: string;
  verdict: ReadPath["verdict"];
  coverage: ReadPath["coverage"];
  module: string;
  read: string;
  probeField: string;
  probeInvoke: string;
  http: { method: string; route: string; probeParam: string } | null;
  notes: string;
  directions: DirectionOutcome[];
  ok: boolean;
};
// ── Verdict invariants ──────────────────────────────────────────────────────
//
// These are derived by the GATE, from the outcome a driver reports — not by the
// driver. A driver that observes a leak and quietly omits it from its own
// checks cannot pass: the recorded booleans are the contract, and this is where
// they are held to it. Without this, a driver bug is indistinguishable from a
// clean run in the artifact.
function invariantChecks(entry: ReadPath, raw: RawOutcome): Check[] {
  const out: Check[] = [];
  const guard = raw.guardEquivalent ?? NOT_PROBED_GUARD;
  if (!raw.probed) {
    out.push(
      check(
        "not-probed-requires-a-declared-reason",
        entry.coverage === "declared-global" && entry.notes.includes("NOT PROBED"),
        "an unprobed path must be classified declared-global and say why inline",
      ),
    );
    return out;
  }
  if (raw.foreignMutated === true && entry.coverage !== "declared-gap") {
    out.push(
      check(
        "no-undeclared-cross-tenant-mutation",
        false,
        "a declared-isolated path mutated the other org's row",
      ),
    );
  }
  // A control that did not see its own row makes the whole direction
  // inconclusive: "the foreign row was absent" proves nothing.
  if (entry.verdict !== "platform-global" && raw.control && raw.control.ownVisible !== true) {
    out.push(
      check(
        "control-probe-was-inconclusive",
        false,
        `control (${raw.control.described}) did not return the caller's own row, so the foreign result is meaningless`,
      ),
    );
  }
  // A `declared-gap` entry is a KNOWN, STILL-OPEN cross-tenant read. This gate
  // asserts the gap is GONE (`foreignVisible === false`), so while the gap is
  // open the check FAILS and the build surfaces it.
  //
  // It used to assert the opposite — that the leak still reproduces — which made
  // the suite green precisely because the defect was present. A gate that cannot
  // fail on the defect it names is worse than no gate: it converts an open
  // cross-tenant read into a passing test result. The probe still runs and the
  // artifact still records what leaked, so the evidence is unchanged; what
  // changed is the verdict. Closing the gap turns this check green, and the
  // entry then has to be reclassified (see PINNED_GAPS) so the artifact stops
  // advertising a leak that no longer happens.
  if (entry.coverage === "declared-gap") {
    out.push(
      check(
        "declared-gap-is-still-open",
        raw.foreignVisible === false,
        raw.foreignVisible === true
          ? `KNOWN OPEN GAP: ${entry.id} still returns the other org's row (${entry.read}). Fix the read, then reclassify this matrix entry.`
          : `${entry.id} no longer leaks; reclassify it from declared-gap so the artifact stops advertising an open gap.`,
      ),
    );
  }
  switch (entry.verdict) {
    case "foreign-probe-empty":
      // A declared gap is handled above and asserted to be CLOSED. Everything
      // else asserts the stronger property directly: a leak is a failure.
      if (entry.coverage !== "declared-gap") {
        out.push(
          check(
            "recorded-foreign-probe-is-empty",
            raw.foreignVisible === false,
            `foreignVisible=${raw.foreignVisible} contradicts verdict foreign-probe-empty`,
          ),
        );
      }
      break;
    case "foreign-probe-404":
      out.push(
        check("recorded-foreign-probe-is-404", raw.http?.status === 404, `recorded status ${raw.http?.status} contradicts verdict foreign-probe-404`),
        check("recorded-foreign-probe-is-not-403", raw.http?.status !== 403, "a 403 confirms existence and must never be the cross-tenant answer"),
      );
      break;
    case "identity-keyed":
      out.push(
        check(
          "identity-key-read-is-invisible-in-scope",
          guard.applied === true && guard.empty === true,
          "a credential-keyed read must resolve as nothing under a foreign scope",
        ),
      );
      break;
    case "platform-global":
      out.push(
        check(
          "platform-global-read-is-explicit",
          raw.axisApplicable === false,
          "a model with no org column has no tenant axis; the record must say so rather than imply a direction was probed",
        ),
      );
      break;
  }
  return out;
}

// ── Pinned sets — a change here is a change to the tenancy contract ─────────
//
// The four OPEN gaps. Two more were closed on 2026-10-02 (the ingest customer
// lookup and the enroll opt-out branch); their entries were reclassified to
// `asserted` and their probes now exercise the production handler with the org
// predicate in place, plus a negative control proving the pre-fix unscoped
// expression still leaks. Removing a name from this list is a deliberate act:
// the gate will not notice on its own.
const PINNED_GAPS = [
  "lib.audit-chain.verify",
  "lib.case.by-conversation",
  "lib.case.by-ref",
  "lib.notifications.acknowledge",
].sort();

const PINNED_GLOBAL = ["console.outbox.dead-letters", "lib.outbox.claim-batch"].sort();

// Declared gaps observed NOT to leak in the run that wrote the artifact. Filled
// by the probe job so the artifact assertions below can distinguish "a gap is
// still open" (expected to fail, and the build must show it) from "a gap was
// closed and the matrix entry was never reclassified" (a stale claim, also a
// failure, but a different one with a different fix).
const closedGaps = new Set<string>();

// ── Evidence ────────────────────────────────────────────────────────────────

const EVIDENCE_PATH = resolve(import.meta.dir, "..", "..", "evidence", "tenancy", "isolation.json");

/** Sorted-key JSON: the same content always serialises to the same bytes. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

let artifact: Record<string, unknown> | null = null;

function buildArtifact(paths: PathOutcome[]): Record<string, unknown> {
  // Sorted by path id: the artifact's shape must not depend on the order the
  // matrix happens to declare entries in.
  paths = [...paths].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const allChecks = paths.flatMap((p) => p.directions.flatMap((d) => d.checks));
  const passed = allChecks.filter((c) => c.ok).length;
  const unscoped = paths.filter((p) => p.coverage === "declared-gap");
  const ok = paths.every((p) => p.ok);
  const summary = {
    // Honest verdict. A still-open cross-tenant read is a FAIL, so this is
    // "pass" only when nothing leaked. The old "pass-with-declared-gaps"
    // described a suite that was green because the defect was present.
    result: !ok ? "fail" : "pass",
    pathsDeclared: CANONICAL_READ_PATHS.length,
    pathsProbed: paths.filter((p) => p.directions.some((d) => d.probed)).length,
    directionsProbed: paths.reduce((n, p) => n + p.directions.filter((d) => d.probed).length, 0),
    coverage: {
      asserted: paths.filter((p) => p.coverage === "asserted").length,
      declaredGap: unscoped.length,
      declaredGlobal: paths.filter((p) => p.coverage === "declared-global").length,
    },
    checks: { total: allChecks.length, passed, failed: allChecks.length - passed },
    http404Asserted: paths.filter(
      (p) => p.directions.some((d) => d.checks.some((c) => c.name === "foreign-probe-is-404")),
    ).length,
    never403Asserted: paths.reduce(
      (n, p) => n + p.directions.filter((d) => d.checks.some((c) => c.name === "never-403")).length,
      0,
    ),
    tenantModelsDeclared: TENANTED_MODELS.length,
    unscopedReadPaths: unscoped.map((p) => ({ path: p.path, module: p.module, read: p.read })),
  };

  // Deterministic core. It is EXACTLY the artifact minus the three volatile
  // fields, so the digest check in the next test is a structural equality check
  // rather than a hand-maintained mirror of the file shape. No timestamps, no
  // fixture identifiers.
  const core = {
    schemaVersion: 1,
    gate: "WP-12 multi-tenancy isolation",
    digestAlgorithm: "sha256",
    summary,
    canonicalReadPaths: CANONICAL_READ_PATHS.map((p) => ({
      id: p.id,
      model: p.model,
      obligation: p.obligation,
    })),
    matrix: ISOLATION_MATRIX.map((p) => ({
      id: p.id,
      model: p.model,
      verdict: p.verdict,
      coverage: p.coverage,
      kind: p.kind,
      module: p.module,
      read: p.read,
      probeField: p.probe.field,
      http: p.http ? { method: p.http.method, route: p.http.route, probeParam: p.http.probeParam } : null,
    })),
    paths,
  };

  return {
    schemaVersion: core.schemaVersion,
    gate: core.gate,
    digestAlgorithm: core.digestAlgorithm,
    digest: sha256(canonical(core)),
    generatedAt: new Date().toISOString(),
    run: {
      id: RUN,
      orgs: { A: ORG.A, B: ORG.B },
      database: process.env.TEST_DATABASE_URL ? "TEST_DATABASE_URL" : "DATABASE_URL",
      note: "identifiers above are per-run; the digest covers the deterministic core only",
    },
    summary: core.summary,
    canonicalReadPaths: core.canonicalReadPaths,
    matrix: core.matrix,
    paths: core.paths,
  };
}

// ── Job 1 — the matrix fails closed ──────────────────────────────────────────

test("WP-12 · matrix fails closed: canonical list and matrix are the same set", () => {
  // A path promised but not probed, or probed but not promised, is a failure in
  // both directions. This is what makes the gate fail closed on new read paths.
  expect(matrixIds()).toEqual(canonicalIds());
  expect(new Set(matrixIds()).size).toBe(ISOLATION_MATRIX.length);

  for (const p of ISOLATION_MATRIX) {
    expect(typeof p.module, `${p.id}.module`).toBe("string");
    expect(p.module.length, `${p.id}.module`).toBeGreaterThan(0);
    expect(typeof p.read, `${p.id}.read`).toBe("string");
    expect(p.probe.field.length, `${p.id}.probe.field`).toBeGreaterThan(0);
    expect(p.probe.invoke.length, `${p.id}.probe.invoke`).toBeGreaterThan(20);
    expect(p.notes.length, `${p.id}.notes`).toBeGreaterThan(20);
    // The canonical list must describe the same model as the matrix.
    const canonicalEntry = CANONICAL_READ_PATHS.find((c) => c.id === p.id);
    expect(canonicalEntry, `${p.id} is missing from CANONICAL_READ_PATHS`).toBeDefined();
    expect(canonicalEntry!.model, `${p.id} model drift`).toBe(p.model);
    // Every model the matrix touches must be declared in exactly one registry.
    expect(
      isTenantedModel(p.model) || Object.prototype.hasOwnProperty.call(PLATFORM_MODELS, p.model),
      `${p.id} touches undeclared model ${p.model}`,
    ).toBe(true);
    // A 404 verdict is only meaningful with an id-shaped HTTP probe.
    if (p.verdict === "foreign-probe-404") {
      expect(p.kind, `${p.id} 404 verdict needs an http path`).toBe("http");
      expect(p.http, `${p.id} 404 verdict needs an http shape`).toBeDefined();
      expect(p.http!.probeParam.length, `${p.id} needs a probe parameter`).toBeGreaterThan(0);
    }
    // Every canonical path has a driver — the fail-closed property.
    expect(typeof DRIVERS[p.id], `no probe driver for read path ${p.id}`).toBe("function");
  }

  // A tenant model with no promised read path is an unowned tenant: fail.
  for (const model of TENANTED_MODELS) {
    expect(canonicalModels(), `tenant model ${model} has no read path in the matrix`).toContain(model);
  }

  // The gap set is pinned: a new gap fails, a fixed gap fails until reclassified.
  expect(ISOLATION_MATRIX.filter((p) => p.coverage === "declared-gap").map((p) => p.id).sort()).toEqual(PINNED_GAPS);
  expect(ISOLATION_MATRIX.filter((p) => p.coverage === "declared-global").map((p) => p.id).sort()).toEqual(PINNED_GLOBAL);
  // Every pinned gap must actually document itself.
  for (const id of PINNED_GAPS) {
    expect(matrixEntry(id).notes).toContain("GAP");
  }
});

// ── Job 2 — the guard is fail-closed ────────────────────────────────────────

test("WP-12 · guard is fail-closed: an unscoped read is refused, not served", async () => {
  // 1. No scope at all is refused. There is no "default to everything" mode.
  for (const bad of [null, undefined, "", {}, { orgId: "" }, { orgId: 7 }, { shared: false }]) {
    let caught: unknown = null;
    try {
      scopedDb(bad as unknown as OrgScope);
    } catch (err) {
      caught = err;
    }
    expect(isTenancyScopeError(caught), `scope ${JSON.stringify(bad)} must be refused`).toBe(true);
    expect((caught as TenancyScopeError).reason).toBe("invalid_scope");
  }

  // 2. A model in neither registry is refused by name.
  let unregistered: unknown = null;
  try {
    assertScoped("NonexistentModel", { orgId: ORG.A });
  } catch (err) {
    unregistered = err;
  }
  expect((unregistered as TenancyScopeError).reason).toBe("unregistered_model");
  expect((unregistered as TenancyScopeError).model).toBe("NonexistentModel");

  // 3. A platform model cannot be "scoped" — it must go through the bypass.
  let platformErr: unknown = null;
  try {
    assertScoped("PilotRequest", { ref: "SV-P-XXXXX" });
  } catch (err) {
    platformErr = err;
  }
  expect((platformErr as TenancyScopeError).reason).toBe("unregistered_model");
  expect((platformErr as TenancyScopeError).message).toContain("TENANCY_BYPASS");

  // 4. A tenant predicate with no org clause is refused, naming the model.
  for (const model of TENANTED_MODELS) {
    let caught: unknown = null;
    try {
      assertScoped(model, { id: "anything" }, { operation: "findMany" });
    } catch (err) {
      caught = err;
    }
    expect(isTenancyScopeError(caught), `${model} with an unscoped where must be refused`).toBe(true);
    expect((caught as TenancyScopeError).reason).toBe("missing_org_predicate");
    expect((caught as TenancyScopeError).model).toBe(model);
    expect((caught as TenancyScopeError).message).toContain(model);
  }

  // 5. The org clause is recognised at any depth — the guard is not a
  //    string-match on the top level.
  expect(hasOrgPredicate({ orgId: ORG.A })).toBe(true);
  expect(hasOrgPredicate({ AND: [{ orgId: ORG.A }] })).toBe(true);
  expect(hasOrgPredicate({ OR: [{ id: "x" }, { orgId: null }] })).toBe(true);
  expect(hasOrgPredicate({ NOT: { orgId: ORG.A } })).toBe(true);
  expect(hasOrgPredicate({ AND: [{ OR: [{ id: "x" }] }, { id: "y" }] })).toBe(false);
  expect(hasOrgPredicate({ case: { orgId: ORG.A } })).toBe(false);
  expect(hasOrgPredicate(undefined)).toBe(false);
  assertScoped("Case", { AND: [{ state: "DIALING" }, { orgId: ORG.A }] });

  // 6. Asking for another org while scoped to this one is refused, not emptied.
  let cross: unknown = null;
  try {
    assertScoped("Case", { orgId: ORG.B }, { operation: "findFirst", scope: { orgId: ORG.A } });
  } catch (err) {
    cross = err;
  }
  expect((cross as TenancyScopeError).reason).toBe("cross_org_request");
  expect((cross as TenancyScopeError).message).toContain(ORG.B);

  // 7. The injected predicate: own rows visible, foreign rows not, without the
  //    caller ever typing an org predicate.
  const asA = scopedDb({ orgId: ORG.A });
  expect((await asA.case.findFirst({ where: { caseRef: ID.caseRef.A } }))?.orgId).toBe(ORG.A);
  expect(await asA.case.findFirst({ where: { caseRef: ID.caseRef.B } })).toBeNull();
  expect(await asA.case.findMany({ where: { caseRef: { in: [ID.caseRef.A, ID.caseRef.B] } } })).toHaveLength(1);
  expect(await asA.auditLog.count({ where: { callRef: ID.callRef.B } })).toBe(0);
  expect(await asA.auditLog.count({ where: { callRef: ID.callRef.A } })).toBe(1);
  expect(await asA.customer.count()).toBe(4);
  expect(await asA.notification.count()).toBe(3);
  expect(await asA.producerKey.count()).toBe(2);
  // Symmetric: B sees only B.
  expect(await scopedDb({ orgId: ORG.B }).case.findFirst({ where: { caseRef: ID.caseRef.A } })).toBeNull();
  expect(await scopedDb(orgScopeFor(ORG.B)).case.findFirst({ where: { caseRef: ID.caseRef.B } })).not.toBeNull();

  // 8. An explicit foreign org in `where` is refused at the client, not
  //    silently answered with zero rows.
  let clientCross: unknown = null;
  try {
    await asA.case.findFirst({ where: { orgId: ORG.B, caseRef: ID.caseRef.B } });
  } catch (err) {
    clientCross = err;
  }
  expect(isTenancyScopeError(clientCross)).toBe(true);
  expect((clientCross as TenancyScopeError).reason).toBe("cross_org_request");
  expect((clientCross as TenancyScopeError).model).toBe("Case");
  expect((clientCross as TenancyScopeError).operation).toBe("findFirst");

  // 9. Writes are stamped, and a contradicting orgId is refused.
  const created = await asA.customer.create({
    data: { customerRef: `CUST-GUARD-${RUN}`, phone: CONSENT_PHONE },
    select: { orgId: true },
  });
  expect(created.orgId).toBe(ORG.A);
  let writeCross: unknown = null;
  try {
    await asA.customer.create({ data: { customerRef: `CUST-GUARD-X-${RUN}`, phone: CONSENT_PHONE, orgId: ORG.B } });
  } catch (err) {
    writeCross = err;
  }
  expect((writeCross as TenancyScopeError).reason).toBe("org_mismatch_on_write");
  let upsertCross: unknown = null;
  try {
    await asA.customer.upsert({
      where: { customerRef: `CUST-GUARD-${RUN}` },
      create: { customerRef: `CUST-GUARD-${RUN}`, phone: CONSENT_PHONE },
      update: { orgId: ORG.B },
    });
  } catch (err) {
    upsertCross = err;
  }
  expect((upsertCross as TenancyScopeError).reason).toBe("org_mismatch_on_write");

  // 10. A transaction's callback client is guarded too.
  const inTx = await inScopeTransaction({ orgId: ORG.A }, async (tx) => {
    const own = await tx.case.findFirst({ where: { caseRef: ID.caseRef.A } });
    const foreign = await tx.case.findFirst({ where: { caseRef: ID.caseRef.B } });
    return { own: own?.orgId ?? null, foreign: foreign?.orgId ?? null };
  });
  expect(inTx).toEqual({ own: ORG.A, foreign: null });

  // 11. The shared namespace is the un-namespaced rows plus "default" — the
  //     same rule the console routes apply by hand, and never "all orgs".
  expect(scopeWhere({ orgId: "org_x" })).toEqual({ orgId: "org_x" });
  expect(scopeWhere(orgScopeFor(null))).toEqual({ OR: [{ orgId: null }, { orgId: "default" }] });
  expect(scopeKey({ orgId: "org_x" })).toBe("org:org_x");
  expect(scopeKey({ shared: true })).toBe("shared");
  const shared = scopedDb(orgScopeFor(undefined));
  const sharedCase = await shared.case.create({
    data: { caseRef: `SV-F-SHARED-${RUN}`, phone: CONSENT_PHONE },
    select: { orgId: true },
  });
  expect(sharedCase.orgId).toBeNull();
  expect(await shared.case.findFirst({ where: { caseRef: ID.caseRef.A } })).toBeNull();
  // A shared session still cannot reach a named org.
  expect(await shared.auditLog.count({ where: { callRef: ID.callRef.A } })).toBe(0);

  // 12. TENANCY_BYPASS cannot reach a tenant model, whatever the reason.
  for (const model of TENANTED_MODELS) {
    let refused: unknown = null;
    try {
      TENANCY_BYPASS.client(model, "a very good reason that is still refused");
    } catch (err) {
      refused = err;
    }
    expect(isTenancyScopeError(refused), `bypass of ${model} must be refused`).toBe(true);
    expect((refused as TenancyScopeError).reason).toBe("bypass_refused");
  }
  let weakReason: unknown = null;
  try {
    TENANCY_BYPASS.client("PilotRequest", "why");
  } catch (err) {
    weakReason = err;
  }
  expect((weakReason as TenancyScopeError).reason).toBe("bypass_refused");
  TENANCY_BYPASS.reset();
}, 120_000);

// ── Job 3 + 4 — probe every path, then write and verify the artifact ────────

test("WP-12 · isolation: every read path × both orgs", async () => {
  const paths: PathOutcome[] = [];

  for (const entry of ISOLATION_MATRIX) {
    const driver = DRIVERS[entry.id];
    const directions: DirectionOutcome[] = [];
    for (const dir of ["A-reads-B", "B-reads-A"] as const) {
      const base: DirectionOutcome = {
        direction: dir,
        sessionOrg: me(dir),
        probeOwner: them(dir),
        probed: false,
        axisApplicable: true,
        http: null,
        control: null,
        foreignVisible: null,
        foreignMutated: null,
        guardEquivalent: NOT_PROBED_GUARD,
        checks: [],
        ok: false,
        error: null,
      };
      try {
        const raw = await driver!(dir);
        base.probed = raw.probed;
        base.axisApplicable = raw.axisApplicable ?? true;
        base.http = raw.http ?? null;
        base.control = raw.control ?? null;
        base.foreignVisible = raw.foreignVisible ?? null;
        base.foreignMutated = raw.foreignMutated ?? null;
        base.guardEquivalent = raw.guardEquivalent ?? NOT_PROBED_GUARD;
        base.checks = [...raw.checks, ...invariantChecks(entry, raw)];
        base.ok = base.checks.length > 0 && base.checks.every((c) => c.ok);
      } catch (err) {
        base.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        base.checks = [check("probe-executed", false, base.error)];
      }
      directions.push(base);
    }
    paths.push({
      path: entry.id,
      title: entry.title,
      model: entry.model,
      verdict: entry.verdict,
      coverage: entry.coverage,
      module: entry.module,
      read: entry.read,
      probeField: entry.probe.field,
      probeInvoke: entry.probe.invoke,
      http: entry.http ? { method: entry.http.method, route: entry.http.route, probeParam: entry.http.probeParam } : null,
      notes: entry.notes,
      directions,
      ok: directions.every((d) => d.ok),
    });
  }

  // Written BEFORE any assertion, so a failing run still leaves the artifact.
  artifact = buildArtifact(paths);
  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  // Now assert, per path, so a failure names the read path. Every failure is
  // collected before reporting: a gate that aborts on the first failure hides
  // the other nineteen.
  //
  // The declared-gap failures are EXPECTED to be present while the gaps are
  // open, and they are reported FIRST and separately, because the whole point
  // of this gate is that an open cross-tenant read must be visible in the build
  // output rather than absorbed into a green run. They are still failures — the
  // suite is red until the gaps are closed — but they are listed as known-open
  // defects, not buried among unexpected ones.
  const failures: string[] = [];
  const openGapFailures: string[] = [];
  const staleGapFailures: string[] = [];
  for (const p of paths) {
    for (const d of p.directions) {
      const label = `${p.path} [${d.direction}]`;
      if (d.error) failures.push(`${label} :: probe threw :: ${d.error}`);
      if (d.checks.length === 0) failures.push(`${label} :: produced no checks`);
      for (const c of d.checks) {
        if (c.ok) continue;
        const line = `${label} :: ${c.name} — ${c.detail}`;
        if (c.name === "declared-gap-is-still-open") {
          // Distinguish "still open" from "closed but never reclassified".
          if (p.coverage === "declared-gap") openGapFailures.push(line);
          else staleGapFailures.push(line);
        } else {
          failures.push(line);
        }
      }
    }
    // A declared gap that did not leak in either direction has been closed and
    // must be reclassified; record it so the artifact assertions can say so.
    if (p.coverage === "declared-gap" && p.directions.every((d) => d.foreignVisible === false)) {
      closedGaps.add(p.path);
    }
  }

  if (openGapFailures.length > 0) {
    console.error(
      `\n  KNOWN OPEN CROSS-TENANT GAPS (${openGapFailures.length} failing checks, ${closedGaps.size} gaps closed):\n` +
        openGapFailures.map((f) => `    ✗ ${f}`).join("\n") +
        `\n  These are open defects, not passing checks. Fix each read in ` +
        `src/lib/case-state-machine.ts, src/lib/audit-chain.ts or ` +
        `src/lib/notifications.ts, then reclassify the matrix entry in ` +
        `src/lib/tenancy/isolation-matrix.ts. See docs/GAP-REGISTER.md.\n`,
    );
  }
  if (staleGapFailures.length > 0) {
    console.error(
      `\n  STALE GAP ENTRIES — these no longer leak but are still declared as open:\n` +
        staleGapFailures.map((f) => `    ✗ ${f}`).join("\n"),
    );
  }
  // Everything unexpected must be clean.
  expect(failures).toEqual([]);
  // And the suite stays red until every declared gap is closed. This is the
  // assertion that replaced "the leak must still reproduce": the build now
  // fails on the defect instead of passing because of it.
  expect([...openGapFailures, ...staleGapFailures]).toEqual([]);

  // Direction count: every path is probed both ways, always.
  expect(paths.length).toBe(CANONICAL_READ_PATHS.length);
  for (const p of paths) expect(p.directions.map((d) => d.direction)).toEqual(["A-reads-B", "B-reads-A"]);

  // The two orgs must be genuinely distinct tenants, or nothing above means
  // anything.
  expect(ORG.A).not.toBe(ORG.B);
  expect((await db.case.findFirst({ where: { caseRef: ID.caseRef.A } }))?.orgId).toBe(ORG.A);
  expect((await db.case.findFirst({ where: { caseRef: ID.caseRef.B } }))?.orgId).toBe(ORG.B);
}, 180_000);

test("WP-12 · evidence artifact is deterministic and well-formed", () => {
  const raw = readFileSync(EVIDENCE_PATH, "utf8");
  const parsed = JSON.parse(raw) as Record<string, any>;

  // Shape.
  expect(parsed.schemaVersion).toBe(1);
  expect(parsed.gate).toBe("WP-12 multi-tenancy isolation");
  expect(parsed.digestAlgorithm).toBe("sha256");
  expect(typeof parsed.digest).toBe("string");
  expect(parsed.digest).toHaveLength(64);
  expect(typeof parsed.generatedAt).toBe("string");
  expect(parsed.run.id).toBe(RUN);
  expect(Array.isArray(parsed.canonicalReadPaths)).toBe(true);
  expect(Array.isArray(parsed.matrix)).toBe(true);
  expect(Array.isArray(parsed.paths)).toBe(true);
  expect(parsed.canonicalReadPaths.length).toBe(CANONICAL_READ_PATHS.length);
  expect(parsed.paths.length).toBe(ISOLATION_MATRIX.length);

  // Every path × both directions, in a stable order.
  const ids = parsed.paths.map((p: any) => p.path);
  expect(ids).toEqual([...ids].sort());
  expect(new Set(ids).size).toBe(ids.length);
  for (const p of parsed.paths) {
    expect(p.directions.map((d: any) => d.direction)).toEqual(["A-reads-B", "B-reads-A"]);
    for (const d of p.directions) {
      expect(d.checks.length).toBeGreaterThan(0);
      expect(d.checks.every((c: any) => typeof c.name === "string" && typeof c.ok === "boolean")).toBe(true);
    }
  }

  // Summary is internally consistent — a summary that disagrees with the body
  // is worse than no summary.
  const allChecks = parsed.paths.flatMap((p: any) => p.directions.flatMap((d: any) => d.checks));
  expect(parsed.summary.checks.total).toBe(allChecks.length);
  expect(parsed.summary.checks.passed).toBe(allChecks.filter((c: any) => c.ok).length);
  // The only checks permitted to fail are the declared-gap ones, and only
  // because the gap is still open. Asserting `failed === 0` here (as this gate
  // used to) is what let an open cross-tenant read ship as a green suite.
  const failedChecks = allChecks.filter((c: any) => !c.ok);
  expect(
    failedChecks.every((c: any) => c.name === "declared-gap-is-still-open"),
    `unexpected non-gap failures: ${failedChecks.filter((c: any) => c.name !== "declared-gap-is-still-open").map((c: any) => c.name).join(", ")}`,
  ).toBe(true);
  // Every declared gap is probed both ways, so an open gap is exactly one
  // failure per direction per gap. If a gap were closed this count drops, and
  // the matrix entry must be reclassified at the same time.
  expect(failedChecks.length).toBe(
    PINNED_GAPS.filter((id) => !closedGaps.has(id)).length * 2,
  );
  expect(parsed.summary.coverage.declaredGap).toBe(PINNED_GAPS.length);
  expect(parsed.summary.coverage.asserted + parsed.summary.coverage.declaredGap + parsed.summary.coverage.declaredGlobal).toBe(parsed.paths.length);
  expect(parsed.summary.unscopedReadPaths.map((p: any) => p.path).sort()).toEqual(PINNED_GAPS);
  // 404-not-403 was asserted explicitly, in both directions, for every
  // id-shaped HTTP probe.
  expect(parsed.summary.http404Asserted).toBe(
    ISOLATION_MATRIX.filter((p) => p.verdict === "foreign-probe-404").length,
  );
  expect(parsed.summary.never403Asserted).toBe(
    ISOLATION_MATRIX.filter((p) => p.verdict === "foreign-probe-404").length * 2,
  );
  // `result` is the honest verdict, not a euphemism: while any gap is open the
  // run is a FAIL. "pass-with-declared-gaps" described a suite that was green
  // because the defect was present.
  expect(parsed.summary.result).toBe(failedChecks.length === 0 ? "pass" : "fail");
  // The artifact still advertises the open gaps, so the evidence of the leak is
  // not lost by making the verdict honest: it keeps advertising every read path
  // still declared unscoped, which is what the matrix says.
  expect(parsed.summary.unscopedReadPaths.map((p: any) => p.path).sort()).toEqual(PINNED_GAPS);

  // Determinism: the digest covers the deterministic core, and no fixture
  // identifier leaked into the artifact.
  const { digest, generatedAt, run, ...rest } = parsed;
  expect(sha256(canonical(rest))).toBe(digest);
  const serialised = JSON.stringify(rest);
  expect(serialised).not.toContain(RUN);
  expect(serialised).not.toContain(CONSENT_ID);
  expect(typeof generatedAt).toBe("string");
  expect(run.orgs.A).toBe(ORG.A);
  // Re-serialising the same content reproduces the same bytes.
  expect(canonical(rest)).toBe(canonical(JSON.parse(JSON.stringify(rest))));
});
