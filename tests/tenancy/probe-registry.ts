/**
 * WP-12 probe registry — the fixtures and the per-read-path probes.
 *
 * Split out of `isolation.test.ts` so the gate (what must be true) and the
 * probes (how each read path is exercised) can be read separately. One driver
 * per canonical read path; the gate fails if a canonical path has no driver
 * here, which is what makes it fail closed on a new read path.
 *
 * The Clerk mock is installed HERE, at module scope, on purpose: it has to be
 * registered before any module that calls `auth()` / `currentUser()` is
 * imported. Every such import in this file is a dynamic `await import()` inside
 * a driver, so the mock is always in place first.
 *
 * The org claim is the only thing under test. Role, credits and identity are
 * fixture furniture.
 */

import { afterAll, beforeAll, mock } from "bun:test";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  PLATFORM_MODELS,
  TENANCY_BYPASS,
  isTenancyScopeError,
  isTenantedModel,
  scopeWhere,
  scopedDb,
} from "@/lib/tenancy/guard";
// ── Session (Clerk is mocked; the org claim is the only thing under test) ────

/**
 * `role` is a real variable here, not decoration. `/api/enroll`'s `authorize()`
 * short-circuits on `profile?.role === "operator"` and returns the SESSION's org
 * — so an operator session can never exercise the producer-key branch. Probing
 * a route's Bearer path therefore requires a non-operator seat, which is what
 * `asProducer()` below arranges.
 */
const session = { userId: "", orgId: null as string | null, role: "operator" as "operator" | "demo" };

mock.module("@clerk/nextjs/server", () => ({
  auth: async () => ({
    userId: session.userId,
    sessionClaims: session.orgId ? { o: { id: session.orgId } } : {},
  }),
  currentUser: async () => ({
    id: session.userId,
    primaryEmailAddress: { emailAddress: `${session.userId}@tenancy-probe.invalid` },
    emailAddresses: [{ emailAddress: `${session.userId}@tenancy-probe.invalid` }],
    firstName: "Tenancy",
    lastName: "Probe",
    publicMetadata: { role: session.role },
  }),
}));

export type Side = "A" | "B";
export type Direction = "A-reads-B" | "B-reads-A";

export const me = (d: Direction): Side => (d === "A-reads-B" ? "A" : "B");
export const them = (d: Direction): Side => (d === "A-reads-B" ? "B" : "A");

type SessionSnapshot = { userId: string; orgId: string | null; role: "operator" | "demo" };
const snapshot = (): SessionSnapshot => ({ ...session });
const restore = (prev: SessionSnapshot): void => {
  session.userId = prev.userId;
  session.orgId = prev.orgId;
  session.role = prev.role;
};

/** Run `fn` as the given org's operator session, then restore. */
export async function asOrg<T>(org: Side, fn: () => Promise<T>): Promise<T> {
  const prev = snapshot();
  session.userId = org === "A" ? ID.clerkUserId.A : ID.clerkUserId.B;
  session.orgId = org === "A" ? ORG.A : ORG.B;
  session.role = "operator";
  try {
    return await fn();
  } finally {
    restore(prev);
  }
}

/**
 * Run `fn` as the given org's HEADLESS PRODUCER: a non-operator seat plus that
 * org's own `svb_…` bearer key. This is the path a bank's fraud engine
 * actually uses, and the one that makes `authorize()` resolve `orgId` from the
 * KEY rather than from a console session — so the probe tests tenant scoping
 * where an attacker would apply it.
 */
export async function asProducer<T>(org: Side, fn: (bearer: string, callerId: string) => Promise<T>): Promise<T> {
  const prev = snapshot();
  session.userId = ID.clerkUserId[org];
  session.orgId = org === "A" ? ORG.A : ORG.B;
  session.role = "demo";
  try {
    return await fn(ID.producerKeyPlaintext[org], `pk:tenancy-probe-${org}`);
  } finally {
    restore(prev);
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Unique per run, so repeated runs never collide on a unique index. */
export const RUN = Date.now().toString(36);

export const ORG: Record<Side, string> = { A: `org-tenancy-a-${RUN}`, B: `org-tenancy-b-${RUN}` };

export const ID = {
  callRef: { A: `SV-C-TA-${RUN}`, B: `SV-C-TB-${RUN}` },
  caseRef: { A: `SV-F-TA-${RUN}`, B: `SV-F-TB-${RUN}` },
  conversationId: { A: `conv-tenancy-a-${RUN}`, B: `conv-tenancy-b-${RUN}` },
  customerRef: { A: `CUST-TA-${RUN}`, B: `CUST-TB-${RUN}` },
  gapCustomerRef: { A: `CUST-GAP-TA-${RUN}`, B: `CUST-GAP-TB-${RUN}` },
  controlCustomerRef: { A: `CUST-CTRL-TA-${RUN}`, B: `CUST-CTRL-TB-${RUN}` },
  // The opt-out probe's own control: the production route must SUCCEED when the
  // tenant-bound caller names its OWN customer, otherwise a blanket 404 would
  // satisfy the cross-tenant assertion without isolating anything.
  controlGapCustomerRef: { A: `CUST-CTRLGAP-TA-${RUN}`, B: `CUST-CTRLGAP-TB-${RUN}` },
  clerkUserId: { A: `clerk_tenancy_a_${RUN}`, B: `clerk_tenancy_b_${RUN}` },
  orgName: { A: `ORG-A-SENTINEL-${RUN}`, B: `ORG-B-SENTINEL-${RUN}` },
  dedupeKey: { A: `tenancy-a-${RUN}`, B: `tenancy-b-${RUN}` },
  notificationId: {} as Record<Side, string>,
  gapNotificationId: {} as Record<Side, string>,
  // Dedicated CONTROL rows. A control that mutates the same row the next
  // direction's foreign probe inspects would make the gate order-dependent:
  // revoking org A's key as a control in A-reads-B would then look like a
  // cross-tenant mutation when B-reads-A probes it back.
  controlNotificationId: {} as Record<Side, string>,
  producerKeyId: {} as Record<Side, string>,
  controlProducerKeyId: {} as Record<Side, string>,
  producerKeyPlaintext: {} as Record<Side, string>,
  producerKeyHash: {} as Record<Side, string>,
};

export const AUDIT_AT: Record<Side, Date> = { A: new Date(), B: new Date() };
let PILOT_REF = "";
/**
 * The two expressions `src/app/api/interventions/route.ts` now issues for the
 * enrolled-customer lookup, quoted in the probe's check details so a failure
 * names the exact code under test rather than a description of it.
 */
const INTERVENTIONS_CUSTOMER_LOOKUP_TENANT =
  "db.customer.findFirst({ where: { customerRef: signal.customer.ref, orgId } })";
const INTERVENTIONS_CUSTOMER_LOOKUP_ORGLESS =
  "db.customer.findFirst({ where: { customerRef: signal.customer.ref, OR: [{ orgId: null }, { orgId: 'default' }] } })";

export const CONSENT_PHONE = "+971509876543";
export const CONSENT_ID = `CN-${RUN}`;

beforeAll(async () => {
  const { append } = await import("@/lib/audit-chain");
  const { generateProducerKey, hashProducerKey } = await import("@/lib/producer-keys");

  for (const side of ["A", "B"] as const) {
    // Audit chain rows, written by the real chain writer so the chain verifies.
    // `action: "freeze"` is what the case-list read filters on.
    const row = await append(
      {
        callRef: ID.callRef[side],
        action: "freeze",
        intent: "signal_received",
        callerId: "tenancy-probe",
        meta: { tenancyProbe: true },
        orgId: ORG[side],
      },
      { fast: true },
    );
    const stored = await db.auditLog.findUnique({ where: { id: row.id }, select: { createdAt: true } });
    AUDIT_AT[side] = stored?.createdAt ?? AUDIT_AT[side];

    await db.case.create({
      data: {
        caseRef: ID.caseRef[side],
        conversationId: ID.conversationId[side],
        orgId: ORG[side],
        state: "CONFIRMED_FRAUD",
        transactionRef: `TXN-${RUN}-${side}`,
        phone: CONSENT_PHONE,
      },
    });

    for (const ref of [
      ID.customerRef[side],
      ID.gapCustomerRef[side],
      ID.controlCustomerRef[side],
      ID.controlGapCustomerRef[side],
    ]) {
      await db.customer.create({
        data: { customerRef: ref, phone: CONSENT_PHONE, orgId: ORG[side], consentRecordId: CONSENT_ID },
      });
    }

    await db.userProfile.create({
      data: {
        clerkUserId: ID.clerkUserId[side],
        email: `${ID.clerkUserId[side]}@tenancy-probe.invalid`,
        name: `Tenancy Probe ${side}`,
        role: "operator",
        orgId: ORG[side],
        orgName: ID.orgName[side],
        credits: 500,
      },
    });

    ID.notificationId[side] = (
      await db.notification.create({
        data: {
          orgId: ORG[side],
          alertType: "fraud_confirmed",
          severity: "urgent",
          title: `Tenancy probe ${side}`,
          dedupeKey: ID.dedupeKey[side],
        },
        select: { id: true },
      })
    ).id;

    // A separate alert for the library-level gap probe, so acknowledging it
    // cannot disturb the control of the HTTP acknowledge path.
    ID.gapNotificationId[side] = (
      await db.notification.create({
        data: {
          orgId: ORG[side],
          alertType: "escalation",
          severity: "info",
          title: `Tenancy probe gap ${side}`,
          dedupeKey: `${ID.dedupeKey[side]}:gap`,
        },
        select: { id: true },
      })
    ).id;

    // And a third for the HTTP acknowledge control, so a successful control
    // never acknowledges the row the other direction probes.
    ID.controlNotificationId[side] = (
      await db.notification.create({
        data: {
          orgId: ORG[side],
          alertType: "case_stuck",
          severity: "info",
          title: `Tenancy probe control ${side}`,
          dedupeKey: `${ID.dedupeKey[side]}:control`,
        },
        select: { id: true },
      })
    ).id;

    ID.producerKeyPlaintext[side] = generateProducerKey();
    ID.producerKeyHash[side] = hashProducerKey(ID.producerKeyPlaintext[side]);
    ID.producerKeyId[side] = (
      await db.producerKey.create({
        data: { label: `tenancy-probe-${side}`, keyHash: ID.producerKeyHash[side], orgId: ORG[side] },
        select: { id: true },
      })
    ).id;
    ID.controlProducerKeyId[side] = (
      await db.producerKey.create({
        data: {
          label: `tenancy-probe-control-${side}`,
          keyHash: hashProducerKey(`${ID.producerKeyPlaintext[side]}-control`),
          orgId: ORG[side],
        },
        select: { id: true },
      })
    ).id;
  }
}, 60_000);

afterAll(async () => {
  const orgs = { in: [ORG.A, ORG.B] };
  await db.auditLog.deleteMany({ where: { orgId: orgs } });
  await db.case.deleteMany({ where: { orgId: orgs } });
  await db.customer.deleteMany({ where: { orgId: orgs } });
  await db.producerKey.deleteMany({ where: { orgId: orgs } });
  await db.notification.deleteMany({ where: { orgId: orgs } });
  await db.outboxEvent.deleteMany({ where: { orgId: orgs } });
  await db.userProfile.deleteMany({ where: { orgId: orgs } });
  if (PILOT_REF) await db.pilotRequest.deleteMany({ where: { ref: PILOT_REF } });
  await db.$disconnect();
}, 60_000);

// ── Request helpers ─────────────────────────────────────────────────────────

export function req(
  method: "GET" | "POST" | "DELETE",
  route: string,
  opts: {
    query?: Record<string, string>;
    body?: unknown;
    /** e.g. `authorization: "Bearer svb_…"` for the headless-producer auth path. */
    headers?: Record<string, string>;
  } = {},
): NextRequest {
  const url = new URL(`http://localhost${route}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  return new NextRequest(url, {
    method,
    ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
    headers: opts.headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  } as ConstructorParameters<typeof NextRequest>[1]);
}

// ── Result shape ────────────────────────────────────────────────────────────

/** What the scoped equivalent of a probe returned, when one was run. */
export type GuardEquivalent = { applied: boolean; empty: boolean | null; detail: string };

export type Check = { name: string; ok: boolean; detail: string };
export const check = (name: string, ok: boolean, detail: string): Check => ({ name, ok, detail });

export type RawOutcome = {
  probed: boolean;
  axisApplicable?: boolean;
  http?: { method: string; route: string; status: number | null } | null;
  control?: { described: string; status: number | null; ownVisible: boolean | null } | null;
  foreignVisible?: boolean | null;
  foreignMutated?: boolean | null;
  guardEquivalent?: GuardEquivalent;
  checks: Check[];
};

export type Driver = (dir: Direction) => Promise<RawOutcome>;

// ── The probe registry ──────────────────────────────────────────────────────
//
// One driver per canonical read path. A canonical path with no driver here is
// a gate failure (see job 1) — that is the fail-closed property: a new read
// path cannot be added to the contract without saying how it is probed.

export const NOT_PROBED_GUARD: GuardEquivalent = {
  applied: false,
  empty: null,
  detail: "no guard equivalent for this path",
};

export const DRIVERS: Record<string, Driver> = {
  "console.audit.case-list": async (dir) => {
    const { GET } = await import("@/app/api/console/audit/route");
    const res = await asOrg(me(dir), () => GET(req("GET", "/api/console/audit")));
    const body = (await res.json()) as { cases?: { callRef: string }[] };
    const cases = body.cases ?? [];
    return {
      probed: true,
      http: { method: "GET", route: "/api/console/audit", status: res.status },
      control: {
        described: "the caller's own callRef is listed in cases[]",
        status: res.status,
        ownVisible: cases.some((c) => c.callRef === ID.callRef[me(dir)]),
      },
      foreignVisible: cases.some((c) => c.callRef === ID.callRef[them(dir)]),
      guardEquivalent: {
        applied: true,
        empty: null,
        detail: "route already scopes the query; the guard equivalent is the same predicate",
      },
      checks: [
        check("http-2xx", res.status === 200, `expected 200, got ${res.status}`),
        check(
          "control-own-case-listed",
          cases.some((c) => c.callRef === ID.callRef[me(dir)]),
          "the caller's own case must be listed, or the foreign check is vacuous",
        ),
        check(
          "foreign-callRef-absent",
          !cases.some((c) => c.callRef === ID.callRef[them(dir)]),
          "the other org's callRef must not appear in the case list",
        ),
      ],
    };
  },

  "console.audit.case-chain": async (dir) => {
    const { GET } = await import("@/app/api/console/audit/route");
    const foreign = await asOrg(me(dir), () =>
      GET(req("GET", "/api/console/audit", { query: { callRef: ID.callRef[them(dir)] } })),
    );
    const control = await asOrg(me(dir), () =>
      GET(req("GET", "/api/console/audit", { query: { callRef: ID.callRef[me(dir)] } })),
    );
    return {
      probed: true,
      http: { method: "GET", route: "/api/console/audit?callRef=", status: foreign.status },
      control: {
        described: "the caller's own callRef returns the chain with 200",
        status: control.status,
        ownVisible: control.status === 200,
      },
      foreignVisible: foreign.status === 200,
      guardEquivalent: {
        applied: true,
        empty: null,
        detail: "route performs the org-scoped findFirst before verifyChain",
      },
      checks: [
        check("foreign-probe-is-404", foreign.status === 404, `expected 404, got ${foreign.status}`),
        check("never-403", foreign.status !== 403, "a 403 confirms the caseRef exists — 404 must be indistinguishable from 'no such case'"),
        check("control-own-chain-200", control.status === 200, `expected 200 for the caller's own chain, got ${control.status}`),
      ],
    };
  },

  "console.events.activity": async (dir) => {
    const { fetchActivitySince } = await import("@/lib/activity-feed");
    // Window opens before BOTH fixture rows so the foreign row is inside it —
    // otherwise "the foreign row is absent" would prove nothing.
    const opened = new Date(Math.min(AUDIT_AT.A.getTime(), AUDIT_AT.B.getTime()) - 1_000);
    const rows = await fetchActivitySince({
      scope: { orgId: ORG[me(dir)] },
      cursor: { createdAt: opened, id: "" },
      take: 100,
    });
    const foreignRows = rows.filter((r) => r.callRef === ID.callRef[them(dir)]);
    const foreignOrgRows = rows.filter((r) => r.orgId !== ORG[me(dir)]);
    return {
      probed: true,
      control: {
        described: "the caller's own audit row is in the feed window",
        status: null,
        ownVisible: rows.some((r) => r.callRef === ID.callRef[me(dir)]),
      },
      foreignVisible: foreignRows.length > 0,
      guardEquivalent: {
        applied: true,
        empty: foreignRows.length === 0,
        detail: "the scope is a required argument of the read model, not an optional filter",
      },
      checks: [
        check("control-own-row-in-window", rows.some((r) => r.callRef === ID.callRef[me(dir)]), "own row must be in the window or the foreign check is vacuous"),
        check("foreign-callRef-absent", foreignRows.length === 0, `${foreignRows.length} foreign row(s) leaked into the activity feed`),
        check("every-row-in-scope", foreignOrgRows.length === 0, `${foreignOrgRows.length} row(s) carried a foreign orgId`),
      ],
    };
  },

  "console.producer-keys.list": async (dir) => {
    const { GET } = await import("@/app/api/console/producer-keys/route");
    const res = await asOrg(me(dir), () => GET());
    const body = (await res.json()) as { keys?: { id: string }[] };
    const keys = body.keys ?? [];
    return {
      probed: true,
      http: { method: "GET", route: "/api/console/producer-keys", status: res.status },
      control: {
        described: "the caller's own key id is listed",
        status: res.status,
        ownVisible: keys.some((k) => k.id === ID.producerKeyId[me(dir)]),
      },
      foreignVisible: keys.some((k) => k.id === ID.producerKeyId[them(dir)]),
      guardEquivalent: {
        applied: true,
        empty: null,
        detail: "orgScope is applied to the where clause in the route",
      },
      checks: [
        check("http-2xx", res.status === 200, `expected 200, got ${res.status}`),
        check("control-own-key-listed", keys.some((k) => k.id === ID.producerKeyId[me(dir)]), "own key must be listed or the foreign check is vacuous"),
        check("foreign-key-id-absent", !keys.some((k) => k.id === ID.producerKeyId[them(dir)]), "the other org's producer key must not be listed"),
      ],
    };
  },

  "console.producer-keys.revoke": async (dir) => {
    const { DELETE } = await import("@/app/api/console/producer-keys/route");
    const foreignId = ID.producerKeyId[them(dir)];
    const res = await asOrg(me(dir), () =>
      DELETE(req("DELETE", "/api/console/producer-keys", { query: { id: foreignId } })),
    );
    const after = await db.producerKey.findUnique({ where: { id: foreignId }, select: { revoked: true } });
    const control = await asOrg(me(dir), () =>
      DELETE(req("DELETE", "/api/console/producer-keys", { query: { id: ID.controlProducerKeyId[me(dir)] } })),
    );
    return {
      probed: true,
      http: { method: "DELETE", route: "/api/console/producer-keys?id=", status: res.status },
      control: {
        described: "revoking the caller's own key succeeds",
        status: control.status,
        ownVisible: control.status === 200,
      },
      foreignVisible: res.status === 200,
      foreignMutated: after?.revoked === true,
      guardEquivalent: {
        applied: true,
        empty: (await scopedDb({ orgId: ORG[me(dir)] }).producerKey.updateMany({ where: { id: foreignId }, data: { revoked: true } })).count === 0,
        detail: "scoped updateMany against the foreign key id matches zero rows",
      },
      checks: [
        check("foreign-probe-is-404", res.status === 404, `expected 404, got ${res.status}`),
        check("never-403", res.status !== 403, "a 403 confirms the key id exists"),
        check("foreign-key-not-revoked", after?.revoked === false, "the other org's key must still be unrevoked"),
        check("control-own-key-revoked-200", control.status === 200, `expected 200 revoking the caller's own key, got ${control.status}`),
      ],
    };
  },

  "console.inbox.list": async (dir) => {
    const { GET } = await import("@/app/api/console/inbox/route");
    const res = await asOrg(me(dir), () => GET());
    const body = (await res.json()) as { notifications?: { id: string }[] };
    const rows = body.notifications ?? [];
    return {
      probed: true,
      http: { method: "GET", route: "/api/console/inbox", status: res.status },
      control: {
        described: "the caller's own alert id is in the inbox",
        status: res.status,
        ownVisible: rows.some((n) => n.id === ID.notificationId[me(dir)]),
      },
      foreignVisible: rows.some((n) => n.id === ID.notificationId[them(dir)]),
      guardEquivalent: {
        applied: true,
        empty: null,
        detail: "notifications.inbox(orgId) ORs only the shared namespace when orgId is null",
      },
      checks: [
        check("http-2xx", res.status === 200, `expected 200, got ${res.status}`),
        check("control-own-alert-listed", rows.some((n) => n.id === ID.notificationId[me(dir)]), "own alert must be listed or the foreign check is vacuous"),
        check("foreign-alert-id-absent", !rows.some((n) => n.id === ID.notificationId[them(dir)]), "the other org's alert must not appear in the inbox"),
      ],
    };
  },

  "console.inbox.acknowledge": async (dir) => {
    const { POST } = await import("@/app/api/console/inbox/route");
    const foreignId = ID.notificationId[them(dir)];
    const res = await asOrg(me(dir), () =>
      POST(req("POST", "/api/console/inbox", { body: { action: "acknowledge", id: foreignId } })),
    );
    const after = await db.notification.findUnique({ where: { id: foreignId }, select: { acknowledgedAt: true } });
    const control = await asOrg(me(dir), () =>
      POST(req("POST", "/api/console/inbox", { body: { action: "acknowledge", id: ID.controlNotificationId[me(dir)] } })),
    );
    return {
      probed: true,
      http: { method: "POST", route: "/api/console/inbox", status: res.status },
      control: {
        described: "acknowledging the caller's own alert succeeds",
        status: control.status,
        ownVisible: control.status === 200,
      },
      foreignVisible: res.status === 200,
      foreignMutated: after?.acknowledgedAt !== null,
      guardEquivalent: {
        applied: true,
        empty: (await scopedDb({ orgId: ORG[me(dir)] }).notification.updateMany({ where: { id: foreignId }, data: { acknowledgedAt: new Date() } })).count === 0,
        detail: "scoped updateMany against the foreign alert id matches zero rows",
      },
      checks: [
        check("foreign-probe-is-404", res.status === 404, `expected 404, got ${res.status}`),
        check("never-403", res.status !== 403, "a 403 confirms the alert id exists"),
        check("foreign-alert-not-acknowledged", after?.acknowledgedAt === null, "the other org's alert must remain unacknowledged"),
        check("control-own-alert-ack-200", control.status === 200, `expected 200 acknowledging the caller's own alert, got ${control.status}`),
      ],
    };
  },

  "console.settings.read": async (dir) => {
    const { GET } = await import("@/app/api/console/settings/route");
    const res = await asOrg(me(dir), () => GET());
    const text = await res.text();
    const controlRes = await asOrg(them(dir), () => GET());
    const controlText = await controlRes.text();
    return {
      probed: true,
      http: { method: "GET", route: "/api/console/settings", status: res.status },
      control: {
        described: "the caller's own session sees its own orgName sentinel",
        status: controlRes.status,
        ownVisible: controlText.includes(ID.orgName[them(dir)]),
      },
      foreignVisible: text.includes(ID.orgName[them(dir)]),
      guardEquivalent: {
        applied: true,
        empty: (await scopedDb({ orgId: ORG[me(dir)] }).userProfile.findFirst({ where: { orgName: ID.orgName[them(dir)] } })) === null,
        detail: "scoped findFirst for the foreign org's sentinel orgName returns nothing",
      },
      checks: [
        check("http-2xx", res.status === 200, `expected 200, got ${res.status}`),
        check("control-own-sentinel-visible", controlText.includes(ID.orgName[them(dir)]), "the org's own sentinel must be returned, or the foreign check is vacuous"),
        check("foreign-sentinel-absent", !text.includes(ID.orgName[them(dir)]), "settings must not contain the other org's white-label state"),
      ],
    };
  },

  "identity.user-profile": async (dir) => {
    const { getProfile } = await import("@/lib/credits");
    const profile = await asOrg(me(dir), () => getProfile());
    const foreignRow = await scopedDb({ orgId: ORG[me(dir)] }).userProfile.findFirst({
      where: { clerkUserId: ID.clerkUserId[them(dir)] },
    });
    return {
      probed: true,
      control: {
        described: "getProfile resolves the caller's own org and clerk id",
        status: null,
        ownVisible: profile?.orgId === ORG[me(dir)] && profile?.clerkUserId === ID.clerkUserId[me(dir)],
      },
      foreignVisible: profile?.orgId === ORG[them(dir)] || profile?.clerkUserId === ID.clerkUserId[them(dir)],
      guardEquivalent: {
        applied: true,
        empty: foreignRow === null,
        detail: "the other org's clerkUserId resolves to nothing under the caller's scope",
      },
      checks: [
        check("resolves-own-org", profile?.orgId === ORG[me(dir)], "getProfile must resolve the session's own orgId"),
        check("resolves-own-identity", profile?.clerkUserId === ID.clerkUserId[me(dir)], "getProfile must resolve the session's own clerkUserId"),
        check("no-foreign-identity", !(profile?.orgId === ORG[them(dir)] || profile?.clerkUserId === ID.clerkUserId[them(dir)]), "the resolved profile must not be the other org's"),
        check("guard-refuses-foreign-clerk-id", foreignRow === null, "scoped findFirst for the other org's clerkUserId must be empty"),
      ],
    };
  },

  "identity.producer-key": async (dir) => {
    const { verifyProducerKey, hashProducerKey } = await import("@/lib/producer-keys");
    const foreignPlaintext = ID.producerKeyPlaintext[them(dir)];
    const auth = await verifyProducerKey(foreignPlaintext);
    const ownAuth = await verifyProducerKey(ID.producerKeyPlaintext[me(dir)]);
    const resolved = await scopedDb({ orgId: ORG[me(dir)] }).producerKey.findFirst({
      where: { keyHash: hashProducerKey(foreignPlaintext) },
    });
    const bogus = await verifyProducerKey("svb_not_a_real_key");
    return {
      probed: true,
      control: {
        described: "the caller's own plaintext key authenticates as the caller's org",
        status: null,
        ownVisible: ownAuth.ok === true && ownAuth.orgId === ORG[me(dir)],
      },
      foreignVisible: resolved !== null,
      guardEquivalent: {
        applied: true,
        empty: resolved === null,
        detail: "the foreign keyHash resolves to nothing under the caller's scope",
      },
      checks: [
        check("key-authenticates-as-its-own-org", auth.ok === true && auth.orgId === ORG[them(dir)], "a producer key must authenticate as exactly the org it was issued to"),
        check("own-key-authenticates-as-own-org", ownAuth.ok === true && ownAuth.orgId === ORG[me(dir)], "the caller's own key must authenticate as the caller's org"),
        check("foreign-keyhash-invisible-in-scope", resolved === null, "the other org's keyHash must not resolve under the caller's scope"),
        check("unknown-key-refused", bogus.ok === false, "an unknown key must not authenticate"),
      ],
    };
  },

  "lib.case.by-ref": async (dir) => {
    const { caseByRef } = await import("@/lib/case-state-machine");
    const leaked = await caseByRef(ID.caseRef[them(dir)]);
    const own = await caseByRef(ID.caseRef[me(dir)]);
    const guarded = await scopedDb({ orgId: ORG[me(dir)] }).case.findFirst({ where: { caseRef: ID.caseRef[them(dir)] } });
    return {
      probed: true,
      control: { described: "caseByRef returns the caller's own case", status: null, ownVisible: own !== null },
      foreignVisible: leaked !== null,
      guardEquivalent: {
        applied: true,
        empty: guarded === null,
        detail: "scopedDb(orgId).case.findFirst({ where: { caseRef } }) returns null for the foreign ref",
      },
      checks: [
        // The gap assertion: asserted TRUE, so a silent fix fails the gate and
        // forces the entry to be reclassified rather than quietly forgotten.
        check("DECLARED-GAP-still-unscoped", leaked !== null, "caseByRef has no org predicate — if this passes, the gap is fixed and the entry must be reclassified"),
        check("control-own-case-returned", own !== null, "the caller's own case must resolve, or the gap assertion is meaningless"),
        check("guard-closes-the-gap", guarded === null, "the scoped equivalent must return nothing for the foreign caseRef"),
      ],
    };
  },

  "lib.case.by-conversation": async (dir) => {
    const { caseByConversation } = await import("@/lib/case-state-machine");
    const leaked = await caseByConversation(ID.conversationId[them(dir)]);
    const own = await caseByConversation(ID.conversationId[me(dir)]);
    const guarded = await scopedDb({ orgId: ORG[me(dir)] }).case.findFirst({
      where: { conversationId: ID.conversationId[them(dir)] },
    });
    return {
      probed: true,
      control: {
        described: "caseByConversation returns the caller's own case",
        status: null,
        ownVisible: own !== null,
      },
      foreignVisible: leaked !== null,
      guardEquivalent: {
        applied: true,
        empty: guarded === null,
        detail: "scopedDb(orgId).case.findFirst({ where: { conversationId } }) returns null for the foreign id",
      },
      checks: [
        check("DECLARED-GAP-still-unscoped", leaked !== null, "caseByConversation has no org predicate — if this passes, the gap is fixed and the entry must be reclassified"),
        check("control-own-case-returned", own !== null, "the caller's own case must resolve, or the gap assertion is meaningless"),
        check("guard-closes-the-gap", guarded === null, "the scoped equivalent must return nothing for the foreign conversation id"),
      ],
    };
  },

  "api.enroll.customer-by-ref": async (dir) => {
    const { POST } = await import("@/app/api/enroll/route");
    const foreignRef = ID.customerRef[them(dir)];
    const res = await asOrg(me(dir), () =>
      POST(
        req("POST", "/api/enroll", {
          body: { action: "enroll", customerRef: foreignRef, phone: CONSENT_PHONE, lang: "en", channel: "call", consentRecordId: CONSENT_ID },
        }),
      ),
    );
    const after = await db.customer.findUnique({ where: { customerRef: foreignRef }, select: { orgId: true, phone: true } });
    const control = await asOrg(me(dir), () =>
      POST(
        req("POST", "/api/enroll", {
          body: { action: "enroll", customerRef: ID.controlCustomerRef[me(dir)], phone: CONSENT_PHONE, lang: "en", channel: "call", consentRecordId: CONSENT_ID },
        }),
      ),
    );
    return {
      probed: true,
      http: { method: "POST", route: "/api/enroll", status: res.status },
      control: {
        described: "enrolling the caller's own control customer succeeds",
        status: control.status,
        ownVisible: control.status === 200,
      },
      foreignVisible: res.status === 200,
      foreignMutated: after?.orgId !== ORG[them(dir)] || after?.phone !== CONSENT_PHONE,
      guardEquivalent: {
        applied: true,
        empty: (await scopedDb({ orgId: ORG[me(dir)] }).customer.findFirst({ where: { customerRef: foreignRef } })) === null,
        detail: "scoped findFirst for the foreign customerRef returns nothing",
      },
      checks: [
        check("foreign-probe-is-404", res.status === 404, `expected 404, got ${res.status}`),
        check("never-403", res.status !== 403, "a 403 confirms the customerRef exists"),
        check("foreign-customer-not-repointed", after?.orgId === ORG[them(dir)] && after?.phone === CONSENT_PHONE, "the other org's customer must keep its org and phone"),
        check("control-own-enroll-200", control.status === 200, `expected 200 enrolling the caller's own customer, got ${control.status}`),
      ],
    };
  },

  "api.enroll.customer-optout": async (dir) => {
    const { POST } = await import("@/app/api/enroll/route");
    const foreignRef = ID.gapCustomerRef[them(dir)];
    const ownRef = ID.controlGapCustomerRef[me(dir)];
    const optout = (bearer: string, callerId: string, customerRef: string) =>
      POST(
        req("POST", "/api/enroll", {
          body: { action: "optout", customerRef },
          // The headless-producer auth path: `authorize()` resolves orgId from
          // the KEY, which is how a bank actually calls this endpoint and where
          // an attacker would apply the tenant boundary.
          headers: { authorization: `Bearer ${bearer}`, "x-caller-id": callerId },
        }),
      );

    // ── 1. The production handler, tenant-bound, naming the OTHER org's ref ──
    // Authenticated as THIS org (not the row's owner). If this probe ever
    // returns 200 the scoping is gone; if it returns 404 for everyone, the
    // control below catches the route having simply stopped working.
    const res = await asProducer(me(dir), (bearer, callerId) => optout(bearer, callerId, foreignRef));
    const after = await db.customer.findUnique({
      where: { customerRef: foreignRef },
      select: { optedOut: true, orgId: true },
    });

    // ── 2. Control: the same call naming the org's OWN ref must succeed ─────
    const control = await asProducer(me(dir), (bearer, callerId) => optout(bearer, callerId, ownRef));
    const controlAfter = await db.customer.findUnique({
      where: { customerRef: ownRef },
      select: { optedOut: true, orgId: true },
    });

    // ── 3. NEGATIVE CONTROL: the predicate the route used to issue ──────────
    // If the unscoped expression no longer reaches the foreign row, the two
    // assertions above are only proving that this fixture happens to be tidy,
    // not that the org predicate is what prevents the mutation. So run the old
    // expression and require it to still find AND flip the foreign row. This
    // deliberately mutates a fixture row; nothing downstream reads it.
    const unscopedRead = await db.customer.findFirst({
      where: { customerRef: foreignRef },
      select: { orgId: true },
    });
    const unscopedWrite = await db.customer.updateMany({
      where: { customerRef: foreignRef },
      data: { optedOut: true },
    });
    const afterControl = await db.customer.findUnique({
      where: { customerRef: foreignRef },
      select: { optedOut: true },
    });

    const guarded = await scopedDb({ orgId: ORG[me(dir)] }).customer.updateMany({
      where: { customerRef: foreignRef },
      data: { optedOut: true },
    });

    return {
      probed: true,
      http: { method: "POST", route: "/api/enroll (optout)", status: res.status },
      control: {
        described: "the tenant-bound producer opts out its OWN customer and gets 200",
        status: control.status,
        ownVisible: control.status === 200 && controlAfter?.optedOut === true && controlAfter?.orgId === ORG[me(dir)],
      },
      foreignVisible: res.status === 200,
      foreignMutated: after?.optedOut === true,
      guardEquivalent: {
        applied: true,
        empty: guarded.count === 0,
        detail: "the guard's injected predicate matches zero rows for the foreign customerRef — the same answer the route now gives",
      },
      checks: [
        check("foreign-probe-is-404", res.status === 404, `expected 404 "Unknown customerRef", got ${res.status}`),
        check("never-403", res.status !== 403, "a 403 confirms the customerRef exists; the route must answer 404 like an unknown ref"),
        check("foreign-row-not-mutated", after?.optedOut === false, "the other org's customer must keep optedOut=false — rows updated must not reach it"),
        check("foreign-row-still-theirs", after?.orgId === ORG[them(dir)], "the foreign row's orgId must be unchanged"),
        check("control-own-optout-succeeds", control.status === 200, `expected 200 opting out the caller's own customer, got ${control.status}`),
        check("control-own-row-mutated", controlAfter?.optedOut === true, "the caller's own customer must actually be opted out, or the 404 above is vacuous"),
        // Negative controls — the scoping is what prevents the mutation.
        check("NEGATIVE-CONTROL-unscoped-read-reaches-foreign-row", unscopedRead?.orgId === ORG[them(dir)], "the unscoped expression must still resolve the other org's customer, or the isolation assertion is vacuous"),
        check("NEGATIVE-CONTROL-unscoped-write-mutates-foreign-row", unscopedWrite.count === 1 && afterControl?.optedOut === true, "the unscoped expression must still be able to flip the other org's consent — this is the defect the org predicate removes"),
      ],
    };
  },

  "api.interventions.customer-by-ref": async (dir) => {
    // End-to-end is still out of gate scope (the ingest pipeline needs the live
    // telephony provider), so the EXACT expressions the route now issues are
    // executed directly against the fixtures — tenant-bound branch and
    // org-less branch — rather than a paraphrase of them.
    const ownRef = ID.customerRef[me(dir)];
    const foreignRef = ID.customerRef[them(dir)];
    const tenantBound = await db.customer.findFirst({ where: { customerRef: foreignRef, orgId: ORG[me(dir)] } });
    const orgLess = await db.customer.findFirst({
      where: { customerRef: foreignRef, OR: [{ orgId: null }, { orgId: "default" }] },
    });
    const control = await db.customer.findFirst({ where: { customerRef: ownRef, orgId: ORG[me(dir)] } });

    // Negative control: the pre-fix expression, which is the defect.
    const unscoped = await db.customer.findFirst({ where: { customerRef: foreignRef }, select: { orgId: true } });

    return {
      probed: true,
      control: {
        described: "the same tenant-bound expression resolves the caller's own customer",
        status: null,
        ownVisible: control?.orgId === ORG[me(dir)],
      },
      foreignVisible: tenantBound !== null,
      guardEquivalent: {
        applied: true,
        empty: (await scopedDb({ orgId: ORG[me(dir)] }).customer.findFirst({ where: { customerRef: foreignRef } })) === null,
        detail: "the guard's injected predicate returns nothing for the foreign customerRef",
      },
      checks: [
        check(
          "tenant-bound-lookup-returns-nothing",
          tenantBound === null,
          `${INTERVENTIONS_CUSTOMER_LOOKUP_TENANT} must not resolve the other org's customer — its phone number is the dialled target`,
        ),
        check(
          "org-less-lookup-returns-nothing",
          orgLess === null,
          `${INTERVENTIONS_CUSTOMER_LOOKUP_ORGLESS} must not resolve a named org's customer either`,
        ),
        check("control-own-customer-resolved", control?.orgId === ORG[me(dir)], "the caller's own customer must resolve, or the assertions above are vacuous"),
        check(
          "NEGATIVE-CONTROL-unscoped-lookup-reaches-foreign-row",
          unscoped?.orgId === ORG[them(dir)],
          "the pre-fix unscoped expression must still resolve the other org's customer, or the isolation assertion is vacuous",
        ),
      ],
    };
  },

  "lib.audit-chain.verify": async (dir) => {
    const { verifyChain } = await import("@/lib/audit-chain");
    const foreign = await verifyChain(ID.callRef[them(dir)]);
    const guarded = await scopedDb({ orgId: ORG[me(dir)] }).auditLog.findFirst({
      where: { callRef: ID.callRef[them(dir)] },
    });
    return {
      probed: true,
      control: {
        described: "verifyChain verifies the caller's own chain",
        status: null,
        ownVisible: (await verifyChain(ID.callRef[me(dir)])).ok === true,
      },
      foreignVisible: foreign.ok === true && foreign.rows > 0,
      guardEquivalent: {
        applied: true,
        empty: guarded === null,
        detail: "scoped findFirst for the foreign callRef returns nothing",
      },
      checks: [
        check("DECLARED-GAP-verifyChain-walks-foreign-rows", foreign.ok === true && foreign.rows > 0, "verifyChain reads by callRef alone — if this passes, the gap is fixed and the entry must be reclassified"),
        check("guard-closes-the-gap", guarded === null, "the scoped equivalent must return nothing for the foreign callRef"),
      ],
    };
  },

  "lib.notifications.acknowledge": async (dir) => {
    const { acknowledge } = await import("@/lib/notifications");
    const foreignId = ID.gapNotificationId[them(dir)];
    const result = await acknowledge(foreignId);
    const after = await db.notification.findUnique({ where: { id: foreignId }, select: { acknowledgedAt: true } });
    const guarded = await scopedDb({ orgId: ORG[me(dir)] }).notification.updateMany({
      where: { id: foreignId },
      data: { acknowledgedAt: new Date() },
    });
    return {
      probed: true,
      foreignVisible: result.ok === true,
      foreignMutated: after?.acknowledgedAt !== null,
      guardEquivalent: {
        applied: true,
        empty: guarded.count === 0,
        detail: "scoped updateMany against the foreign alert id matches zero rows",
      },
      checks: [
        check("DECLARED-GAP-acknowledge-acts-on-foreign-alert", result.ok === true, "acknowledge reads by id alone — if this passes, the gap is fixed and the entry must be reclassified"),
        check("guard-closes-the-gap", guarded.count === 0, "the scoped equivalent must match zero rows"),
      ],
    };
  },

  "pilot.leads": async (dir) => {
    const { POST } = await import("@/app/api/pilot/route");
    if (!PILOT_REF) {
      const created = await POST(
        req("POST", "/api/pilot", {
          body: { name: "Tenancy Probe", email: `probe-${RUN}@tenancy-probe.invalid`, institution: "Probe Bank" },
        }),
      );
      PILOT_REF = ((await created.json()) as { ref: string }).ref;
    }
    const rows = await TENANCY_BYPASS.run(
      "PilotRequest",
      "WP-12 isolation gate: prove the global-model escape hatch reads a public lead",
      (raw) => raw.pilotRequest.findMany({ where: { ref: PILOT_REF } }),
    );
    const refused = (() => {
      try {
        TENANCY_BYPASS.client("Case", "tenant models are never bypassable");
        return false;
      } catch (err) {
        return isTenancyScopeError(err) && err.reason === "bypass_refused";
      }
    })();
    const log = TENANCY_BYPASS.log();
    return {
      probed: true,
      // A global model has no tenant axis: the direction axis is recorded for a
      // uniform artifact shape, and explicitly marked as not applicable.
      axisApplicable: false,
      foreignVisible: false,
      control: {
        described: "the public route created the lead and the bypass reads it back",
        status: null,
        ownVisible: rows.length === 1,
      },
      guardEquivalent: {
        applied: true,
        empty: null,
        detail: "TENANCY_BYPASS is the sanctioned non-scoped read for a declared platform model",
      },
      checks: [
        check("public-route-created-the-lead", rows.length === 1, "the lead must be readable through the declared bypass"),
        check("bypass-refuses-tenant-model", refused, "TENANCY_BYPASS must refuse every model in TENANTED_MODELS"),
        check("bypass-log-holds-only-platform-models", log.every((b) => Object.prototype.hasOwnProperty.call(PLATFORM_MODELS, b.model)), "no bypass may target a tenant model"),
        check("bypass-log-non-empty", log.length > 0, "the bypass must be recorded, so it can be audited"),
      ],
    };
  },

  "console.outbox.dead-letters": async () => ({
    // Not probed: POST with all=true would replay every unreplayed dead letter
    // in the shared queue. The declaration itself is what is asserted.
    probed: false,
    axisApplicable: false,
    foreignVisible: null,
    control: { described: "not probed", status: null, ownVisible: null },
    guardEquivalent: NOT_PROBED_GUARD,
    checks: [
      check(
        "declared-platform-model-with-reason",
        typeof PLATFORM_MODELS.DeadLetter?.reason === "string" && PLATFORM_MODELS.DeadLetter.reason.length > 20,
        "DeadLetter must be declared in PLATFORM_MODELS with a written reason",
      ),
    ],
  }),

  "lib.outbox.claim-batch": async () => ({
    // Not probed: a claim is a destructive claim on the shared delivery queue.
    probed: false,
    axisApplicable: false,
    foreignVisible: null,
    control: { described: "not probed", status: null, ownVisible: null },
    guardEquivalent: NOT_PROBED_GUARD,
    checks: [
      check(
        "tenant-model-declared",
        isTenantedModel("OutboxEvent"),
        "OutboxEvent is a tenant model, so its deliberately global read must be written down here",
      ),
      check(
        "scope-would-constrain-it",
        Object.prototype.hasOwnProperty.call(scopeWhere({ orgId: ORG.A }), "orgId"),
        "if the worker were rewritten on the guard, the claim would be org-constrained",
      ),
    ],
  }),
};
