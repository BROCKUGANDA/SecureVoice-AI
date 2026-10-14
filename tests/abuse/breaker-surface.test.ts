/**
 * The breaker can be opened, seen and — the part that was missing — CLOSED.
 *
 * `resumeOrg()` existed for weeks with no caller. This suite is the caller's test,
 * and its centre of gravity is not the 200: it is the assertion that a dial which
 * was refused with `org_auto_paused` is ALLOWED again after the resume. A control
 * surface that only changes what the console displays would pass every status-code
 * assertion here and still leave a bank unable to place fraud calls.
 *
 * Also pinned, in order of how much they hurt to get wrong:
 *   · another org's breaker is not visible and not resumable — and not because a
 *     check catches it: the route derives the key from the session and accepts no
 *     org id in the body at all.
 *   · a resume of an org that is not paused answers 409 rather than reporting a
 *     success that resumed nothing.
 *   · the breaker fires BEFORE geography, so a paused org is refused for being
 *     paused rather than for a configuration accident that would hide the pause.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/console/abuse/route";
import { assertDialAllowed, resetDialState } from "@/lib/abuse/guards";
import { setOrgGeoPolicy } from "@/lib/abuse/geo";
import { resetVelocityState } from "@/lib/abuse/velocity";
import { cleanupRun, makeAccount, makeSession } from "../auth/helpers";

/**
 * A DISTINCT destination per phase, not one reused.
 *
 * The destination cooldown is keyed (org, e164) and stamped when a dial is
 * ALLOWED, so re-dialling the same number after a resume would be refused with
 * `destination_cooldown` — and the "resume reopened the line" assertion would pass
 * or fail on the order of the calls rather than on the breaker.
 */
const PHONE = (n: number) => `+9715012345${String(n).padStart(2, "0")}`;

function post(cookie: string | null, body: Record<string, unknown>) {
  return POST(
    new NextRequest("http://localhost/api/console/abuse", {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    } as ConstructorParameters<typeof NextRequest>[1]),
  );
}

function get(cookie: string | null) {
  return GET(
    new NextRequest("http://localhost/api/console/abuse", {
      headers: { ...(cookie ? { cookie } : {}) },
    } as ConstructorParameters<typeof NextRequest>[1]),
  );
}

async function operator(tag: string) {
  const account = await makeAccount("Owner", tag);
  const session = await makeSession(account);
  // A diallable geography, so a refusal after a resume can only mean the breaker.
  setOrgGeoPolicy(account.orgId, { allowlist: ["AE"] });
  return { orgId: account.orgId, cookie: session.cookie };
}

// A fresh destination per call, so the (org, e164) cooldown can never be the
// reason a dial is refused in these cases.
let dialSeq = 0;
const dial = (orgId: string) =>
  assertDialAllowed({
    orgId,
    e164: PHONE(++dialSeq),
    planTier: "enterprise",
    at: Date.UTC(2026, 0, 15, 8, 0),
  });

/** Both stores, and they are separate on purpose. */
function clearBreakerAndDials() {
  resetDialState();
  resetVelocityState();
}

afterAll(async () => {
  clearBreakerAndDials();
  await cleanupRun();
});

describe("console abuse breaker surface", () => {
  test("an unauthenticated caller is refused, and sees nothing", async () => {
    expect((await post(null, { action: "resume" })).status).toBe(401);
    expect((await get(null)).status).toBe(401);
  });

  test("pause denies the dial, resume lets it flow again", async () => {
    const { orgId, cookie } = await operator("br-cycle");
    try {
      expect(dial(orgId).allowed, "dialling is open before any pause").toBe(true);

      const paused = await post(cookie, { action: "pause", reason: "containment drill" });
      expect(paused.status).toBe(200);
      expect((await paused.json()).paused).toBe(true);

      const blocked = dial(orgId);
      expect(blocked.allowed).toBe(false);
      expect(blocked.reason).toBe("org_auto_paused");

      const listed = await get(cookie);
      expect(listed.status).toBe(200);
      const body = (await listed.json()) as { paused: { reason: string }[] };
      expect(body.paused).toHaveLength(1);
      expect(body.paused[0]?.reason).toBe("manual");

      const resumed = await post(cookie, { action: "resume" });
      expect(resumed.status).toBe(200);
      expect((await resumed.json()).resumed).toBe(true);

      // THE assertion the missing surface was about.
      expect(dial(orgId).allowed).toBe(true);
    } finally {
      clearBreakerAndDials();
    }
  });

  test("resuming an org that is not paused is refused, not silently ok", async () => {
    const { cookie } = await operator("br-noop");
    try {
      const res = await post(cookie, { action: "resume" });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("not_paused");
    } finally {
      clearBreakerAndDials();
    }
  });

  test("another org cannot see or lift a pause it does not own", async () => {
    const a = await operator("br-a");
    const b = await operator("br-b");
    try {
      expect((await post(a.cookie, { action: "pause" })).status).toBe(200);

      const bSee = (await (await get(b.cookie)).json()) as { paused: unknown[] };
      expect(bSee.paused, "org B must not see org A's breaker").toEqual([]);

      const bResume = await post(b.cookie, { action: "resume" });
      expect(bResume.status).toBe(409);
      // A is still blocked — B's attempt changed nothing about A.
      expect(dial(a.orgId).reason).toBe("org_auto_paused");

      // And the body cannot name an org: an `orgId` field is not accepted, so
      // there is no parameter through which A's key could be supplied.
      const forged = await post(b.cookie, { action: "resume", orgId: a.orgId });
      expect(forged.status).toBe(409);
      expect(dial(a.orgId).reason).toBe("org_auto_paused");
    } finally {
      clearBreakerAndDials();
    }
  });

  test("the breaker is checked before geography, so a pause is never misattributed", async () => {
    // An org with NO allowlist would normally deny with geo_allowlist_unconfigured.
    // Paused, it must deny with org_auto_paused instead — otherwise an operator
    // reading the refusal chases a configuration that is not the problem.
    const unconfigured = await makeAccount("Owner", "br-geo-order");
    const session = await makeSession(unconfigured);
    try {
      expect(dial(unconfigured.orgId).reason).toBe("geo_allowlist_unconfigured");
      expect((await post(session.cookie, { action: "pause" })).status).toBe(200);
      expect(dial(unconfigured.orgId).reason).toBe("org_auto_paused");
    } finally {
      clearBreakerAndDials();
    }
  });
});
