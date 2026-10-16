/**
 * Demo-credential confinement.
 *
 * The one-click demo credential is PUBLIC by design — it ships in the sign-in
 * bundle (`NEXT_PUBLIC_DEMO_LOGIN_EMAIL`). Anything it can reach, everyone can
 * reach. So it must resolve to exactly the demo seat and nothing else:
 *
 *   · `getProfile()` (the server source of truth every guard reads) forces
 *     role "demo" and drops the org pointer, even for an Owner membership;
 *   · the client seat mapping (`seatForSession`) resolves `judge` for a demo
 *     address regardless of membership;
 *   · demo addresses cannot be invited into an organisation (issuance refused,
 *     redemption refused, invitation left unconsumed).
 *
 * Each assertion names the bypass it closes: without the forcing, a demo
 * address holding any membership row would sign straight into operator and
 * vendor surfaces with a published password.
 */

import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
import { seatForSession } from "@/lib/auth/seat";
import { isDemoAccount } from "@/lib/demo-account";

const DEMO = "demo-isolation@example.test";
const OPERATOR = "operator-isolation@example.test";
const ORG = "00000000-0000-4000-8000-000000000001";
const USER_DEMO = "00000000-0000-4000-8000-000000000011";
const USER_OP = "00000000-0000-4000-8000-000000000012";

process.env.NEXT_PUBLIC_DEMO_LOGIN_EMAIL = DEMO;

// ── client seat mapping (pure) ─────────────────────────────────────────────

test("a demo address resolves to judge even with an owner membership", () => {
  expect(isDemoAccount(DEMO)).toBe(true);
  expect(seatForSession("owner", DEMO)).toBe("judge");
  expect(seatForSession("admin", DEMO)).toBe("judge");
  expect(seatForSession("member", DEMO)).toBe("judge");
  expect(seatForSession(null, DEMO)).toBe("judge");
});

test("a non-demo address is unaffected by the confinement", () => {
  expect(isDemoAccount(OPERATOR)).toBe(false);
  expect(seatForSession("owner", OPERATOR)).toBe("operator");
  expect(seatForSession("member", OPERATOR)).toBe("vendor");
  expect(seatForSession(null, OPERATOR)).toBe("judge");
});

// ── server profile forcing (mocked session + db) ───────────────────────────

let currentEmail = DEMO;
let currentUserId = USER_DEMO;

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
}));

mock.module("@/lib/better-auth", () => ({
  auth: {
    api: {
      getSession: async () => ({
        session: { activeOrganizationId: ORG },
        user: { id: currentUserId, email: currentEmail, name: "Isolation" },
      }),
      getActiveMember: async () => ({ role: "owner" }),
    },
  },
}));

// The auth invite store (`@/lib/auth/store`) is Prisma-backed
// (`IdempotencyKey`), so the db mock carries a working in-memory KV for it —
// the invite tests below exercise the real `issueInvite`/`acceptInvite` code
// paths, not stubs of them. Keyed exactly like the composite unique index
// (`scope`, `key`, `callerId`), with the same read-enforced TTL.
type KvRow = { response: string; expiresAt: Date };
const kv = new Map<string, KvRow>();
const kvKey = (s: Record<string, unknown>) => {
  const nested = s.scope_key_callerId as
    { scope?: unknown; key?: unknown; callerId?: unknown } | undefined;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const c = {
    scope: str(nested?.scope ?? s.scope),
    key: str(nested?.key ?? s.key),
    callerId: str(nested?.callerId ?? s.callerId),
  };
  return `${c.scope}\n${c.key}\n${c.callerId}`;
};
const p2002 = () => {
  const err = new Error(
    "Unique constraint failed on the constraint `IdempotencyKey_scope_key_callerId_key`",
  ) as Error & {
    code: string;
    meta: unknown;
  };
  err.code = "P2002";
  err.meta = { target: ["scope", "key", "callerId"] };
  return err;
};

// The demo lease the queue would have bound at sign-in. `true` (the default)
// models the normal path — admitted through `/api/demo/enter`; `false`
// models the manual-form bypass (a session with no lease), which must resolve
// to signed-out.
let demoLeaseLive = true;

mock.module("@/lib/db", () => ({
  db: {
    demoSeat: {
      findFirst: async () =>
        demoLeaseLive
          ? {
              id: "seat-1",
              status: "active",
              userId: USER_DEMO,
              createdAt: new Date(),
              lastSeenAt: new Date(),
            }
          : null,
    },
    userProfile: {
      upsert: async ({
        create,
        update,
      }: {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => ({
        ...create,
        ...update,
      }),
    },
    organization: {
      findUnique: async () => ({ credits: 500 }),
    },
    idempotencyKey: {
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: Record<string, unknown>;
        create: KvRow & Record<string, string>;
        update: KvRow;
      }) => {
        const k = kvKey({ ...where, ...create });
        kv.set(k, { response: update.response, expiresAt: update.expiresAt });
        return { response: update.response };
      },
      findUnique: async ({ where }: { where: Record<string, unknown> }) => {
        const row = kv.get(kvKey(where)) ?? null;
        if (!row) return null;
        if (row.expiresAt.getTime() <= Date.now()) return null;
        return row;
      },
      create: async ({ data }: { data: KvRow & Record<string, string> }) => {
        const k = kvKey(data);
        if (kv.has(k)) throw p2002();
        kv.set(k, { response: data.response, expiresAt: data.expiresAt });
        return { response: data.response };
      },
    },
  },
}));

mock.module("@/lib/audit-chain", () => ({
  append: async () => "test-hash",
}));

test("getProfile confines a demo address holding an owner membership", async () => {
  currentEmail = DEMO;
  currentUserId = USER_DEMO;
  const { getProfile } = await import("@/lib/credits");
  const profile = await getProfile();
  expect(profile).not.toBeNull();
  // Owner membership + active org, yet: demo role, no org, user wallet.
  expect(profile?.role).toBe("demo");
  expect(profile?.orgId).toBeNull();
  expect(profile?.walletScope).toBe("user");
});

test("getProfile resolves a leased demo session to signed-out when the lease lapses", async () => {
  currentEmail = DEMO;
  currentUserId = USER_DEMO;
  demoLeaseLive = false;
  try {
    const { getProfile } = await import("@/lib/credits");
    // No live lease: the manual-form bypass (or an expired seat) yields no
    // profile, which is what sends the shell to the sign-in view instead of
    // rendering a console with no data.
    expect(await getProfile()).toBeNull();
  } finally {
    demoLeaseLive = true;
  }
});

test("getProfile leaves a real operator untouched (control)", async () => {
  currentEmail = OPERATOR;
  currentUserId = USER_OP;
  const { getProfile } = await import("@/lib/credits");
  const profile = await getProfile();
  expect(profile?.role).toBe("operator");
  expect(profile?.orgId).toBe(ORG);
  expect(profile?.walletScope).toBe("org");
  currentEmail = DEMO;
  currentUserId = USER_DEMO;
});

// ── invitations: issuance refused ──────────────────────────────────────────

import * as realGuards from "@/lib/auth/guards";

mock.module("@/lib/auth/guards", () => ({
  ...realGuards,
  requirePrivileged: async () => ({
    ok: true,
    orgId: ORG,
    role: "Owner",
    identity: { accountId: "isolation-operator" },
  }),
}));

mock.module("@/lib/billing/seats", () => ({
  seatFacts: async () => ({ seats: 10, members: 1, remaining: 9, plan: "growth" }),
  seatGate: async () => ({ ok: true as const }),
}));

mock.module("@/lib/email/deliverers", () => ({
  deliverInvite: async () => {/* empty */},
}));

test("POST /api/auth/invites refuses a demo address with 422", async () => {
  const { POST } = await import("@/app/api/auth/invites/route");
  const res = await POST(
    new NextRequest("http://localhost/api/auth/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: DEMO, role: "Analyst" }),
    }),
  );
  expect(res.status).toBe(422);
  const body = (await res.json()) as { error?: string };
  expect(body.error ?? "").toMatch(/demo/i);
});

test("POST /api/auth/invites still issues to a real address (control)", async () => {
  const { POST } = await import("@/app/api/auth/invites/route");
  const res = await POST(
    new NextRequest("http://localhost/api/auth/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `real-${Date.now()}@example.test`, role: "Analyst" }),
    }),
  );
  expect(res.status).toBe(201);
});

// ── invitations: redemption refused, invite left usable ────────────────────

let issuedToken = "";

beforeAll(async () => {
  // Issued below the route (which would refuse), so `acceptInvite`'s own
  // refusal is what this exercises — the backstop for invitations minted
  // before the issuance check existed.
  const { issueInvite } = await import("@/lib/auth/invite");
  const { token } = await issueInvite({
    email: DEMO,
    name: "Demo",
    role: "Analyst",
    orgId: ORG,
    issuedBy: "isolation-operator",
  });
  issuedToken = token;
});

afterAll(async () => {
  delete process.env.NEXT_PUBLIC_DEMO_LOGIN_EMAIL;
});

test("acceptInvite refuses a demo address without consuming the invite", async () => {
  const { acceptInvite, inviteStatus } = await import("@/lib/auth/invite");
  const result = await acceptInvite({ token: issuedToken });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.reason).toBe("demo_address");
  // Not consumed: a legitimate re-issue path is unaffected.
  expect(await inviteStatus(issuedToken)).toBe("usable");
});

test("POST /api/auth/invites/accept answers 403 for a demo address", async () => {
  const { POST } = await import("@/app/api/auth/invites/accept/route");
  const res = await POST(
    new Request("http://localhost/api/auth/invites/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: issuedToken }),
    }) as never,
  );
  expect(res.status).toBe(403);
  const body = (await res.json()) as { code?: string };
  expect(body.code).toBe("demo_address");
});
