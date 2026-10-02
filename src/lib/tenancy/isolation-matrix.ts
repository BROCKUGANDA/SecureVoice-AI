/**
 * Isolation matrix (WP-12) — the declarative list of reads that must be
 * org-isolated, and the input to `tests/tenancy/isolation.test.ts`.
 *
 * ── Why a matrix and not a filesystem scan ──────────────────────────────────
 * Scanning `src/` for `db.<model>.find*` finds *syntax*. It cannot tell a
 * scoped read from an unscoped one, it cannot name the probe identifier, and
 * it goes green the moment a new read path is added — which is precisely the
 * moment a gate must go red. So the contract is written down here, in two
 * halves that must agree exactly:
 *
 *   CANONICAL_READ_PATHS — the promise. "These are every read path this
 *       platform claims to isolate." Ids + model only.
 *   ISOLATION_MATRIX — the evidence obligation. For each id: who performs the
 *       read, how you invoke it with a probe identifier, and what the foreign
 *       probe must produce.
 *
 * The gate asserts the two halves are the SAME SET (not a subset), that every
 * entry has a driver and an executed assertion, and that every tenant model
 * appears at least once. Add a canonical path and the matrix fails until you
 * say how to probe it. Add a matrix entry that the canonical list does not
 * promise, and the gate fails for claiming coverage you did not declare.
 *
 * ── Verdicts ────────────────────────────────────────────────────────────────
 *   foreign-probe-empty  the foreign identifier must yield NOTHING.
 *   foreign-probe-404    HTTP shape: 404, never 403. A 403 answers the
 *                        question the attacker asked ("does this exist?") —
 *                        a 404 does not. Asserted explicitly, both directions.
 *   identity-keyed       the read is partitioned by the tenant's own credential
 *                        (a producer key IS the tenant); isolation is structural.
 *   platform-global      the model carries no orgId by design; scope is either
 *                        structural or an explicit TENANCY_BYPASS.
 *
 * ── coverage ────────────────────────────────────────────────────────────────
 *   asserted       probed against two live orgs in both directions.
 *   declared-gap   PROBED AND FOUND UNSCOPED. These are real, characterised
 *                  defects in code outside this work package's write scope. The
 *                  gate pins their exact set: a new gap fails the gate, and a
 *                  fixed gap also fails the gate until the entry is reclassified
 *                  — neither can be forgotten.
 *   declared-global  not probed, with the reason recorded inline (probe would
 *                  steal shared infrastructure or need an upstream provider).
 */

export type IsolationVerdict =
  | "foreign-probe-empty"
  | "foreign-probe-404"
  | "identity-keyed"
  | "platform-global";

export type ReadPathCoverage = "asserted" | "declared-gap" | "declared-global";

export type ReadPathKind = "library" | "http";

export type HttpShape = {
  readonly method: "GET" | "POST" | "DELETE";
  /** The route the probe is delivered to. */
  readonly route: string;
  /** Where the probe identifier travels in the request. */
  readonly probeLocation: "query" | "body" | "header";
  readonly probeParam: string;
};

export type ReadPath = {
  /** Stable id — the key the evidence file and the test registry agree on. */
  readonly id: string;
  readonly title: string;
  /** The Prisma model the read touches. */
  readonly model: string;
  readonly kind: ReadPathKind;
  /** Source module that performs the read. */
  readonly module: string;
  /** Function or route handler that performs it. */
  readonly read: string;
  /** How to invoke the read with a probe identifier. */
  readonly probe: {
    /** The identifier column/field the other org owns. */
    readonly field: string;
    /** Human instruction, so an auditor can reproduce the probe by hand. */
    readonly invoke: string;
  };
  readonly verdict: IsolationVerdict;
  readonly coverage: ReadPathCoverage;
  readonly http?: HttpShape;
  /** Why the gap exists, or why the path is not probed. Required for gaps. */
  readonly notes: string;
};

// ── The promise ──────────────────────────────────────────────────────────────

export type CanonicalReadPath = {
  readonly id: string;
  readonly model: string;
  /** Short statement of the isolation property the platform owes. */
  readonly obligation: string;
};

export const CANONICAL_READ_PATHS: readonly CanonicalReadPath[] = Object.freeze([
  {
    id: "console.audit.case-list",
    model: "AuditLog",
    obligation: "The case list shows only the caller's own cases.",
  },
  {
    id: "console.audit.case-chain",
    model: "AuditLog",
    obligation: "A chain walk for a foreign caseRef answers 404, never 403.",
  },
  {
    id: "console.events.activity",
    model: "AuditLog",
    obligation: "The live activity feed is org-scoped, not platform-wide.",
  },
  {
    id: "console.producer-keys.list",
    model: "ProducerKey",
    obligation: "An operator sees only their own org's machine keys.",
  },
  {
    id: "console.producer-keys.revoke",
    model: "ProducerKey",
    obligation: "Revoking a foreign key is a 404, never a 403, never a success.",
  },
  {
    id: "console.inbox.list",
    model: "Notification",
    obligation: "The alert inbox shows only the caller's own alerts.",
  },
  {
    id: "console.inbox.acknowledge",
    model: "Notification",
    obligation: "Acknowledging a foreign alert is a 404, never a 403.",
  },
  {
    id: "console.settings.read",
    model: "UserProfile",
    obligation: "Settings return the caller's own white-label and BYOK state only.",
  },
  {
    id: "lib.outbox.claim-batch",
    model: "OutboxEvent",
    obligation:
      "The delivery worker drains ONE shared queue: a claim is deliberately not org-scoped, and every claimed row carries its own orgId for the signed payload.",
  },
  {
    id: "identity.user-profile",
    model: "UserProfile",
    obligation: "A session resolves only its own profile; another org's is unreachable.",
  },
  {
    id: "identity.producer-key",
    model: "ProducerKey",
    obligation: "A producer key authenticates as exactly one org, and resolves as nothing under any other scope.",
  },
  {
    id: "lib.case.by-ref",
    model: "Case",
    obligation: "caseByRef must not return another org's case.",
  },
  {
    id: "lib.case.by-conversation",
    model: "Case",
    obligation: "caseByConversation must not return another org's case.",
  },
  {
    id: "api.enroll.customer-by-ref",
    model: "Customer",
    obligation: "Enrolling against another org's customerRef is a 404, never a 403.",
  },
  {
    id: "api.enroll.customer-optout",
    model: "Customer",
    obligation: "A STOP must not opt out another org's customer.",
  },
  {
    id: "api.interventions.customer-by-ref",
    model: "Customer",
    obligation: "Ingest must not resolve another org's customer by customerRef.",
  },
  {
    id: "lib.audit-chain.verify",
    model: "AuditLog",
    obligation: "verifyChain must not walk another org's rows.",
  },
  {
    id: "lib.notifications.acknowledge",
    model: "Notification",
    obligation: "acknowledge() must not act on another org's alert.",
  },
  {
    id: "pilot.leads",
    model: "PilotRequest",
    obligation: "Public-site leads are global; the triage read is an explicit bypass, never a tenant read.",
  },
  {
    id: "console.outbox.dead-letters",
    model: "DeadLetter",
    obligation: "The replay console is operator-scoped at the deployment level; the model carries no orgId.",
  },
]);

// ── The evidence obligation ──────────────────────────────────────────────────

export const ISOLATION_MATRIX: readonly ReadPath[] = Object.freeze([
  {
    id: "console.audit.case-list",
    title: "Command Center case list",
    model: "AuditLog",
    kind: "http",
    module: "src/app/api/console/audit/route.ts",
    read: "GET",
    probe: {
      field: "callRef",
      invoke: "GET /api/console/audit as org A; the response `cases[]` must not contain org B's callRef.",
    },
    verdict: "foreign-probe-empty",
    coverage: "asserted",
    http: { method: "GET", route: "/api/console/audit", probeLocation: "query", probeParam: "callRef" },
    notes:
      "Scoping lives in the route's `orgScope` (line 30). Both directions are probed because the shared/`default` fallback is the branch most likely to leak.",
  },
  {
    id: "console.audit.case-chain",
    title: "Audit chain walk for one caseRef",
    model: "AuditLog",
    kind: "http",
    module: "src/app/api/console/audit/route.ts",
    read: "GET",
    probe: {
      field: "callRef",
      invoke: "GET /api/console/audit?callRef=<other org's callRef> as org A — must be 404, not 403.",
    },
    verdict: "foreign-probe-404",
    coverage: "asserted",
    http: { method: "GET", route: "/api/console/audit", probeLocation: "query", probeParam: "callRef" },
    notes:
      "Route does an org-scoped findFirst before verifyChain (lines 34-47). The 404-not-403 assertion is the point: a 403 confirms the caseRef exists.",
  },
  {
    id: "console.events.activity",
    title: "SSE activity feed read model",
    model: "AuditLog",
    kind: "library",
    module: "src/lib/activity-feed.ts",
    read: "fetchActivitySince",
    probe: {
      field: "callRef",
      invoke:
        "fetchActivitySince({ scope: { orgId: A } }) must not return org B's audit rows; likewise B against A.",
    },
    verdict: "foreign-probe-empty",
    coverage: "asserted",
    notes:
      "The scope is a required argument here by design (see the module docstring), and /api/console/events re-derives it from `guard.profile.orgId` (route line 44). The read model is probed rather than the SSE transport because the transport adds a timer, not a predicate.",
  },
  {
    id: "console.producer-keys.list",
    title: "Bank integration keys list",
    model: "ProducerKey",
    kind: "http",
    module: "src/app/api/console/producer-keys/route.ts",
    read: "GET",
    probe: {
      field: "id",
      invoke: "GET /api/console/producer-keys as org A; `keys[]` must not contain org B's key id.",
    },
    verdict: "foreign-probe-empty",
    coverage: "asserted",
    http: { method: "GET", route: "/api/console/producer-keys", probeLocation: "query", probeParam: "" },
    notes: "orgScope is applied to the where clause (route lines 22-27).",
  },
  {
    id: "console.producer-keys.revoke",
    title: "Revoke a bank integration key",
    model: "ProducerKey",
    kind: "http",
    module: "src/app/api/console/producer-keys/route.ts",
    read: "DELETE",
    probe: {
      field: "id",
      invoke: "DELETE /api/console/producer-keys?id=<org B's key id> as org A — must be 404 and must not revoke it.",
    },
    verdict: "foreign-probe-404",
    coverage: "asserted",
    http: {
      method: "DELETE",
      route: "/api/console/producer-keys",
      probeLocation: "query",
      probeParam: "id",
    },
    notes:
      "updateMany with the org scope; a zero count is reported as 404 (route lines 65-72). The gate also re-reads the row to prove the foreign key was not mutated.",
  },
  {
    id: "console.inbox.list",
    title: "Operator alert inbox",
    model: "Notification",
    kind: "http",
    module: "src/app/api/console/inbox/route.ts",
    read: "GET",
    probe: {
      field: "id",
      invoke: "GET /api/console/inbox as org A; `notifications[]` must not contain org B's alert id.",
    },
    verdict: "foreign-probe-empty",
    coverage: "asserted",
    http: { method: "GET", route: "/api/console/inbox", probeLocation: "query", probeParam: "" },
    notes: "Delegates to notifications.inbox(orgId), which ORs the shared namespace when orgId is null.",
  },
  {
    id: "console.inbox.acknowledge",
    title: "Acknowledge an alert",
    model: "Notification",
    kind: "http",
    module: "src/app/api/console/inbox/route.ts",
    read: "POST",
    probe: {
      field: "id",
      invoke:
        'POST /api/console/inbox { action: "acknowledge", id: <org B\'s alert id> } as org A — must be 404.',
    },
    verdict: "foreign-probe-404",
    coverage: "asserted",
    http: {
      method: "POST",
      route: "/api/console/inbox",
      probeLocation: "body",
      probeParam: "id",
    },
    notes:
      "Ownership is pre-checked against the caller's own inbox (route lines 48-51) precisely so a foreign id is indistinguishable from a nonexistent one. The gate also re-reads the row to prove acknowledgedAt stayed null.",
  },
  {
    id: "console.settings.read",
    title: "White-label + BYOK settings",
    model: "UserProfile",
    kind: "http",
    module: "src/app/api/console/settings/route.ts",
    read: "GET",
    probe: {
      field: "orgName",
      invoke:
        "GET /api/console/settings as org A; the response must not contain the sentinel orgName written to org B's profile.",
    },
    verdict: "foreign-probe-empty",
    coverage: "asserted",
    http: { method: "GET", route: "/api/console/settings", probeLocation: "query", probeParam: "" },
    notes:
      "Identity-keyed read with no id-shaped probe: the route can only ever pass its own clerkUserId, so the cross-tenant probe is a SENTINEL orgName written onto the other org's profile. Both directions return 200 for the caller's own profile and neither response may contain the other org's sentinel. Deliberately NOT a 404 assertion — there is no identifier in the request for a 404 to hide, and claiming otherwise would be a fake assertion. The four genuinely id-shaped paths (console.audit.case-chain, console.producer-keys.revoke, console.inbox.acknowledge, api.enroll.customer-by-ref) carry the 404-never-403 assertion.",
  },
  {
    id: "identity.user-profile",
    title: "Session profile resolution",
    model: "UserProfile",
    kind: "library",
    module: "src/lib/credits.ts",
    read: "getProfile",
    probe: {
      field: "orgName",
      invoke: "getProfile() as org A's session must resolve orgId=A and never surface org B's profile values.",
    },
    verdict: "foreign-probe-empty",
    coverage: "asserted",
    notes:
      "The Clerk session claim is the only source of orgId here, and the upsert is keyed by clerkUserId — a session cannot address another org's row.",
  },
  {
    id: "identity.producer-key",
    title: "Producer key authentication",
    model: "ProducerKey",
    kind: "library",
    module: "src/lib/producer-keys.ts",
    read: "verifyProducerKey",
    probe: {
      field: "keyHash",
      invoke:
        "verifyProducerKey(org B's plaintext) authenticates as org B, and the same keyHash resolves to NOTHING under scopedDb({ orgId: A }).",
    },
    verdict: "identity-keyed",
    coverage: "asserted",
    notes:
      "The key IS the tenant, so the read is keyed by a secret rather than a scope. Isolation is therefore structural — and the gate proves it by resolving the foreign keyHash through org A's scoped client and requiring null.",
  },
  {
    id: "lib.case.by-ref",
    title: "Case lookup by public reference",
    model: "Case",
    kind: "library",
    module: "src/lib/case-state-machine.ts",
    read: "caseByRef",
    probe: {
      field: "caseRef",
      invoke: "caseByRef(org B's caseRef) currently returns org B's case. The scoped equivalent must return null.",
    },
    verdict: "foreign-probe-empty",
    coverage: "declared-gap",
    notes:
      "GAP: `db.case.findUnique({ where: { caseRef } })` (line 157) has no org predicate. No HTTP route currently calls it with attacker-controlled input, and the fix is outside this work package's write scope. Guard equivalent probed in the same run: scopedDb({ orgId: A }).case.findFirst({ where: { caseRef: B } }) is null.",
  },
  {
    id: "lib.case.by-conversation",
    title: "Case lookup by provider conversation id",
    model: "Case",
    kind: "library",
    module: "src/lib/case-state-machine.ts",
    read: "caseByConversation",
    probe: {
      field: "conversationId",
      invoke:
        "caseByConversation(org B's conversationId) currently returns org B's case. The scoped equivalent must return null.",
    },
    verdict: "foreign-probe-empty",
    coverage: "declared-gap",
    notes:
      "GAP: `db.case.findFirst({ where: { conversationId } })` (line 152) has no org predicate. This is the post-call webhook join key, so a replayed foreign conversation id would attach a foreign case to the wrong org's record. Guard equivalent probed in the same run.",
  },
  {
    id: "api.enroll.customer-by-ref",
    title: "Enroll / re-point a customer",
    model: "Customer",
    kind: "http",
    module: "src/app/api/enroll/route.ts",
    read: "POST",
    probe: {
      field: "customerRef",
      invoke: "POST /api/enroll as org A with org B's customerRef — must be 404.",
    },
    verdict: "foreign-probe-404",
    coverage: "asserted",
    http: { method: "POST", route: "/api/enroll", probeLocation: "body", probeParam: "customerRef" },
    notes:
      "The read is unscoped but the route then compares `existing.orgId` to the caller's and answers 404 (route lines 151-154). The gate also re-reads the row to prove org B's phone/consent were not re-pointed.",
  },
  {
    id: "api.enroll.customer-optout",
    title: "STOP opt-out",
    model: "Customer",
    kind: "http",
    module: "src/app/api/enroll/route.ts",
    read: "POST",
    probe: {
      field: "customerRef",
      invoke:
        "POST /api/enroll { action: 'optout', customerRef: <the other org's ref> } authenticated with THIS org's svb_ producer key — must be 404 and must not reach the other org's row.",
    },
    verdict: "foreign-probe-404",
    coverage: "asserted",
    http: { method: "POST", route: "/api/enroll", probeLocation: "body", probeParam: "customerRef" },
    notes:
      "FIXED 2026-10-02 (was a declared gap): the opt-out branch now scopes by org — `where: { customerRef, orgId }` for a tenant-bound caller, and the shared rows only for an org-less one. A producer naming another tenant's customerRef now updates 0 rows and is answered 404, which is also why `rowsUpdated` can no longer confirm existence. Probed through the real route handler over the headless-producer auth path — a Clerk operator session short-circuits `authorize()` before the Bearer branch, so the probe uses a demo-role seat — in both directions, with a control proving the same call succeeds for the caller's own customer and a negative control proving the pre-fix unscoped expression still reaches and mutates the foreign row.",
  },
  {
    id: "api.interventions.customer-by-ref",
    title: "Ingest resolves the enrolled customer",
    model: "Customer",
    kind: "http",
    module: "src/app/api/interventions/route.ts",
    read: "POST",
    probe: {
      field: "customerRef",
      invoke:
        "A signal from org A naming org B's customerRef must resolve to nothing — org B's phone number must never become a dialled number.",
    },
    verdict: "foreign-probe-empty",
    coverage: "asserted",
    http: { method: "POST", route: "/api/interventions", probeLocation: "body", probeParam: "customer.ref" },
    notes:
      "FIXED 2026-10-02 (was the highest-severity gap in this matrix): the ingest lookup is now `db.customer.findFirst({ where: { customerRef, orgId } })` for a tenant-bound caller, and the shared rows only otherwise. Probed by executing both of the route's exact expressions against the fixtures (tenant-bound branch AND org-less branch) plus a negative control proving the pre-fix unscoped expression still resolves the other org's customer. Still not driven end to end, because a full request needs the live telephony pipeline — the expression, not the request, is what crosses the tenant boundary.",
  },
  {
    id: "lib.audit-chain.verify",
    title: "Tamper-evidence chain walk",
    model: "AuditLog",
    kind: "library",
    module: "src/lib/audit-chain.ts",
    read: "verifyChain",
    probe: {
      field: "callRef",
      invoke:
        "verifyChain(org B's callRef) currently walks and returns org B's rows; the console route's own pre-check is what protects it.",
    },
    verdict: "foreign-probe-empty",
    coverage: "declared-gap",
    notes:
      "GAP (defence in depth, not currently exploitable): `verifyChain` reads by callRef alone (line 263). The only caller, /api/console/audit, org-checks first, so the route is safe today. The function would return a foreign chain to any future caller that skipped the pre-check. Guard equivalent probed in the same run.",
  },
  {
    id: "lib.notifications.acknowledge",
    title: "Alert acknowledgement (library)",
    model: "Notification",
    kind: "library",
    module: "src/lib/notifications.ts",
    read: "acknowledge",
    probe: {
      field: "id",
      invoke: "acknowledge(org B's alert id) currently succeeds; the route's own pre-check is what protects it.",
    },
    verdict: "foreign-probe-empty",
    coverage: "declared-gap",
    notes:
      "GAP (defence in depth, not currently exploitable): `acknowledge` reads by id alone (line 110). The only caller pre-checks against the caller's own inbox, so the route is safe today. The evidence records this so a future caller that skips the pre-check is a test failure, not a breach.",
  },
  {
    id: "pilot.leads",
    title: "Public-site pilot leads",
    model: "PilotRequest",
    kind: "library",
    module: "src/app/api/pilot/route.ts",
    read: "POST / TENANCY_BYPASS read",
    probe: {
      field: "ref",
      invoke:
        "Create a lead through the public route, then read it back through TENANCY_BYPASS.run('PilotRequest', …). The bypass log must record only declared platform models.",
    },
    verdict: "platform-global",
    coverage: "asserted",
    notes:
      "The canonical TENANCY_BYPASS case: a website lead has no organization until it is onboarded, so `PilotRequest` is declared in PLATFORM_MODELS and read through the audited escape hatch rather than a scope. The gate also asserts the hatch refuses every model in TENANTED_MODELS.",
  },
  {
    id: "console.outbox.dead-letters",
    title: "Dead-letter replay console",
    model: "DeadLetter",
    kind: "http",
    module: "src/app/api/console/outbox/replay/route.ts",
    read: "GET",
    probe: {
      field: "caseRef",
      invoke: "GET /api/console/outbox/replay lists rows regardless of caseRef org — the model carries no orgId.",
    },
    verdict: "platform-global",
    coverage: "declared-global",
    http: { method: "GET", route: "/api/console/outbox/replay", probeLocation: "query", probeParam: "" },
    notes:
      "NOT PROBED, deliberately: GET drains nothing but POST with `all: true` replays every unreplayed dead letter, and a probe would mutate shared delivery state that the WP-5 gate also asserts on. `DeadLetter` is declared in PLATFORM_MODELS (the org lives on the OutboxEvent row) and the route is operator-gated. Flagged as a real residual risk: any future multi-operator deployment needs this scoped.",
  },
  {
    id: "lib.outbox.claim-batch",
    title: "Outbox delivery worker claim",
    model: "OutboxEvent",
    kind: "library",
    module: "src/lib/outbox.ts",
    read: "claimBatch",
    probe: {
      field: "orgId",
      invoke:
        "claimBatch() takes the oldest due rows across ALL orgs by design — a per-org claim would deadlock the queue behind a silent tenant's backlog.",
    },
    verdict: "platform-global",
    coverage: "declared-global",
    notes:
      "NOT PROBED, deliberately: claiming is a destructive claim on the SHARED delivery queue, so a probe would steal events the WP-5 gate asserts on. This is the one tenant model with a deliberately global read, and it is a raw `$queryRaw` — outside the Prisma model layer the guard can instrument, which is exactly why it is written down here. The org is not lost: the signed payload carries org_id, and the worker's updates are by event id. Residual risk, recorded: the operator replay console (console.outbox.dead-letters) is the human-facing surface over these rows and is not org-scoped.",
  },
]);

// ── Registry lookups ─────────────────────────────────────────────────────────

export function matrixEntry(id: string): ReadPath {
  const found = ISOLATION_MATRIX.find((p) => p.id === id);
  if (!found) throw new Error(`No isolation matrix entry for read path: ${id}`);
  return found;
}

export function matrixIds(): string[] {
  return ISOLATION_MATRIX.map((p) => p.id).sort();
}

export function canonicalIds(): string[] {
  return CANONICAL_READ_PATHS.map((p) => p.id).sort();
}

/** Tenant models with no read path promised for them — a fail-closed signal. */
export function canonicalModels(): string[] {
  return [...new Set(CANONICAL_READ_PATHS.map((p) => p.model))].sort();
}

export function declaredGaps(): ReadPath[] {
  return ISOLATION_MATRIX.filter((p) => p.coverage === "declared-gap");
}

export function isHttpPath(id: string): boolean {
  return ISOLATION_MATRIX.some((p) => p.id === id && p.kind === "http" && p.verdict === "foreign-probe-404");
}
