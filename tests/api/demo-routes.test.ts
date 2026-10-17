/**
 * The demo queue's HTTP surface, driven against the real store.
 *
 * `tests/api/demo-queue.test.ts` proves the state machine; this suite proves
 * the two route handlers a browser actually talks to behave as the machine's
 * contract, because the route-sweep classifies `/api/demo/*` as DB-backed on
 * the strength of a suite that drives the real handlers — a claim with no
 * suite behind it would be the sweep's exemption list lying by default.
 *
 *   - `/api/demo/queue`  — join (bounded, keyed on the trust-gated address),
 *     heartbeat, leave, and the seat-state read, including the 422/404 edges;
 *   - `/api/demo/lease`  — answers only for the caller's own session id:
 *     401 signed out, `{held:false}` with no live lease, `{held:true,seatId}`
 *     with one.
 */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

import { db } from "@/lib/db";

const RUN = `dr${Date.now().toString(36).slice(-7)}`;
const previousCapacity = process.env.DEMO_SEAT_CAPACITY;

// The signed-in identity the shared stub reports, for readability at the call
// sites: "sign in as X" rather than "assign authState.currentUserId".
const setUser = (id: string | null) => {
  authState.currentUserId = id;
};

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
}));

// One shared Better Auth stub for the whole group — see _demo-auth-stub.ts for
// why this is not registered inline: a second inline `mock.module` of the same
// module replaces the first, and these two suites need DIFFERENT methods of
// `auth.api`.
import { authState } from "./_demo-auth-stub";

function device(n: number): string {
  return `dev${RUN}${n}`
    .replace(/[^A-Za-z0-9_-]/g, "")
    .padEnd(12, "0")
    .slice(0, 24);
}

function queuePost(body: Record<string, unknown>): Promise<Response> {
  return import("@/app/api/demo/queue/route").then(({ POST }) =>
    POST(
      new NextRequest("http://localhost/api/demo/queue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );
}

function queueGet(seatId: string): Promise<Response> {
  return import("@/app/api/demo/queue/route").then(({ GET }) =>
    GET(new NextRequest(`http://localhost/api/demo/queue?seatId=${encodeURIComponent(seatId)}`)),
  );
}

function leaseGet(): Promise<Response> {
  return import("@/app/api/demo/lease/route").then(({ GET }) => GET());
}

beforeAll(() => {
  process.env.DEMO_SEAT_CAPACITY = "2";
});

afterAll(async () => {
  if (previousCapacity === undefined) delete process.env.DEMO_SEAT_CAPACITY;
  else process.env.DEMO_SEAT_CAPACITY = previousCapacity;
  // Rows are keyed by RUN-prefixed device ids (ipHash is an opaque pseudonym
  // and cannot be filtered by run).
  await db.demoSeat.deleteMany({ where: { deviceId: { startsWith: `dev${RUN}` } } });
});

beforeEach(async () => {
  setUser(null);
  // Capacity counts are global: start every test from an empty board, or a
  // row abandoned by an earlier suite silently changes the counts below.
  await db.demoSeat.updateMany({
    where: { status: { in: ["active", "queued"] } },
    data: { status: "released" },
  });
});

test("join creates a live seat; the state read answers for it; a stranger's 404s", async () => {
  const joined = await queuePost({ action: "join", deviceId: device(1) });
  expect(joined.status).toBe(200);
  const seat = (await joined.json()) as { status: string; seatId: string };
  expect(["active", "queued"]).toContain(seat.status);

  const state = await queueGet(seat.seatId);
  expect(state.status).toBe(200);
  const stateBody = (await state.json()) as { status: string; seatId: string };
  expect(stateBody.seatId).toBe(seat.seatId);

  const missing = await queueGet(`nope-${RUN}`);
  expect(missing.status).toBe(404);

  const badRequest = await import("@/app/api/demo/queue/route").then(({ GET }) =>
    GET(new NextRequest("http://localhost/api/demo/queue")),
  );
  expect(badRequest.status).toBe(422);
});

test("heartbeat keeps the seat alive; leave releases it", async () => {
  const joined = await queuePost({ action: "join", deviceId: device(2) });
  const seat = (await joined.json()) as { seatId: string };

  const beat = await queuePost({ action: "heartbeat", deviceId: device(2), seatId: seat.seatId });
  expect(beat.status).toBe(200);
  expect(((await beat.json()) as { status: string }).status).toBe("active");

  const left = await queuePost({ action: "leave", deviceId: device(2), seatId: seat.seatId });
  expect(left.status).toBe(200);
  const row = await db.demoSeat.findUnique({ where: { id: seat.seatId } });
  expect(row?.status).toBe("released");

  const gone = await queuePost({ action: "heartbeat", deviceId: device(2), seatId: seat.seatId });
  expect(gone.status).toBe(404);
});

test("lease answers only for the caller's own session", async () => {
  expect((await leaseGet()).status).toBe(401);

  const joined = await queuePost({ action: "join", deviceId: device(3) });
  const seat = (await joined.json()) as { seatId: string };

  // The lease is keyed by SESSION id, because the demo credential is one shared
  // account: a user-keyed lookup would report the first holder's seat to the
  // second. So the stub session has to carry a session id, and the seat has to
  // be bound to THAT id — binding `userId` alone leaves `held: false`, which is
  // why this suite used to pass alone (an unrelated row from demo-enter happened
  // to satisfy the lookup) and fail the moment it ran beside its siblings.
  const mine = `sess-${RUN}-mine`;
  const theirs = `sess-${RUN}-theirs`;
  await db.demoSeat.update({
    where: { id: seat.seatId },
    data: { userId: `user-${RUN}`, sessionId: mine },
  });

  authState.currentSessionId = mine;
  setUser(`user-${RUN}`);
  const held = await leaseGet();
  const heldBody = (await held.json()) as { held: boolean; seatId?: string };
  expect(heldBody.held).toBe(true);
  expect(heldBody.seatId).toBe(seat.seatId);

  // Same user, different session: still refused. The user id is shared by every
  // admitted browser, so only the session can decide who holds what.
  authState.currentSessionId = theirs;
  setUser(`user-${RUN}`);
  expect(((await (await leaseGet()).json()) as { held: boolean }).held).toBe(false);

  // And a different user with no seat at all.
  authState.currentSessionId = theirs;
  setUser(`other-${RUN}`);
  expect(((await (await leaseGet()).json()) as { held: boolean }).held).toBe(false);
});

test("join validates the device id and the body before any write", async () => {
  const scope = { deviceId: { startsWith: `dev${RUN}` } };
  const rowsBefore = await db.demoSeat.count({ where: scope });
  const tampered = await queuePost({ action: "join", deviceId: "bad id with spaces" });
  expect(tampered.status).toBe(422);
  const noBody = await queuePost({ action: "bogus-action", deviceId: device(4) });
  expect(noBody.status).toBe(422);
  expect(await db.demoSeat.count({ where: scope })).toBe(rowsBefore);
});
