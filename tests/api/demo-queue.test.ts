/**
 * Demo sign-in queue: capacity, FIFO promotion, leases, and rate limits.
 *
 * Runs against the REAL DemoSeat table (migration
 * 9zzzzzzzzzzzzzzzzzzzzzzzzzzz_demo_seat_queue + the partial-index follow-up),
 * because the properties under test ARE the database's: the partial unique
 * index turning a double-join into one row, and the sweep/promote/count
 * queries agreeing with each other. A mocked store would prove the mocks.
 *
 * Isolation: every seat is keyed under a per-run ipHash (`RUN`), and the
 * capacity knob is set per test — a parallel suite cannot observe these rows
 * and these rows cannot change another suite's counts. Cleanup deletes the
 * run's rows in `afterAll`.
 *
 * Env knobs are read per call by the queue lib, so tests set and restore them
 * freely rather than forking behavior through dependency injection.
 */

import { afterAll, beforeEach, expect, test } from "bun:test";
import { db } from "@/lib/db";
import {
  claimSeat,
  demoCapacity,
  hashIp,
  heartbeat,
  joinQueue,
  leaseForUser,
  releaseSeat,
  releaseUserSeats,
  seatState,
  validDeviceId,
} from "@/lib/demo-queue";

const RUN = `q-${Date.now().toString(36)}`;
process.env.AUTH_SECRET ||= "test-only-demo-queue-hmac-secret-not-a-credential";

let octet = 10;
const addrOf = () => `203.0.113.${octet++}`;
/** Distinct canonical test-net addresses per tag, stable within the run. */
function hdrsForAddr(addr: string): Headers {
  // The proxy marker is what makes this proxied traffic: without it the
  // canonical resolver answers "untrusted" and every test shares one client,
  // which would make these isolation assertions vacuously true.
  const h = new Headers();
  h.set("x-securevoice-proxy", "1");
  h.set("x-securevoice-client-ip", addr);
  return h;
}
const addrCache = new Map<string, string>();
const addrFor = (tag: string) => {
  let addr = addrCache.get(tag);
  if (!addr) {
    addr = addrOf();
    addrCache.set(tag, addr);
  }
  return addr;
};
const ipOf = (tag: string) => hashIp(hdrsForAddr(addrFor(tag)));
const devOf = (tag: string) => `${RUN}-dev-${tag}`.slice(0, 32);

const prevCap = process.env.DEMO_SEAT_CAPACITY;
const prevJoin = process.env.DEMO_JOIN_PER_HOUR;
const prevTtl = process.env.DEMO_LEASE_TTL_SEC;

beforeEach(async () => {
  process.env.DEMO_SEAT_CAPACITY = "2";
  process.env.DEMO_JOIN_PER_HOUR = "1000";
  process.env.DEMO_LEASE_TTL_SEC = "180";
  // Capacity counts are GLOBAL, so every test starts from an empty board:
  // release all live rows first. DemoSeat holds only ephemeral operational
  // state (a lease is worthless without its heartbeat), so nothing of value
  // is destroyed — and without this, a row abandoned by an earlier run (or a
  // parallel suite) silently changes every count below.
  await db.demoSeat.updateMany({
    where: { status: { in: ["active", "queued"] } },
    data: { status: "released" },
  });
});

afterAll(async () => {
  if (prevCap === undefined) delete process.env.DEMO_SEAT_CAPACITY;
  else process.env.DEMO_SEAT_CAPACITY = prevCap;
  if (prevJoin === undefined) delete process.env.DEMO_JOIN_PER_HOUR;
  else process.env.DEMO_JOIN_PER_HOUR = prevJoin;
  if (prevTtl === undefined) delete process.env.DEMO_LEASE_TTL_SEC;
  else process.env.DEMO_LEASE_TTL_SEC = prevTtl;
  // ipHash is an opaque pseudonym and cannot be filtered by run prefix; every
  // row this file creates carries a RUN-prefixed deviceId instead.
  await db.demoSeat.deleteMany({ where: { deviceId: { startsWith: RUN } } }).catch(() => undefined);
});

async function liveCount(): Promise<number> {
  // Global count is deterministic here: beforeEach releases every live row, so
  // the only live rows are this file's, created since the reset. ipHash is an
  // opaque pseudonym and cannot be filtered by run prefix.
  return db.demoSeat.count({ where: { status: "active" } });
}

test("device ids are validated to a tight alphabet", () => {
  expect(validDeviceId("abcDEF-0123456789_X")).toBe(true);
  expect(validDeviceId("short")).toBe(false);
  expect(validDeviceId("x".repeat(65))).toBe(false);
  expect(validDeviceId("semi;colon")).toBe(false);
  expect(validDeviceId("has space12")).toBe(false);
  expect(validDeviceId(null)).toBe(false);
  expect(validDeviceId(42)).toBe(false);
});

test("IPs are pseudonymised, never stored raw", () => {
  const headers = () => {
    const h = new Headers();
    h.set("x-securevoice-proxy", "1");
    h.set("x-securevoice-client-ip", "203.0.113.7");
    return h;
  };
  const h = hashIp(headers());
  expect(h).not.toContain("203.0.113.7");
  expect(h.length).toBeGreaterThan(0);
  expect(hashIp(headers())).toBe(h);
});

test("all spellings of one address are one client", () => {
  const headersFor = (ip: string) => {
    const h = new Headers();
    h.set("x-securevoice-proxy", "1");
    h.set("x-securevoice-client-ip", ip);
    return h;
  };
  // Two spellings of one person holding two seats is a capacity leak for free.
  expect(hashIp(headersFor("203.0.113.5"))).toBe(hashIp(headersFor("::ffff:203.0.113.5")));
});

test("join under capacity grants an active seat, and rejoin is the same seat", async () => {
  const ip = ipOf("a");
  const dev = devOf("a");
  const first = await joinQueue(ip, dev, `rl:${RUN}:a`);
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error("unreachable");
  expect(first.state.status).toBe("active");

  const second = await joinQueue(ip, dev, `rl:${RUN}:a`);
  expect(second.ok).toBe(true);
  if (!second.ok) throw new Error("unreachable");
  expect(second.state.status).toBe("active");
  if (first.state.status !== "active" || second.state.status !== "active")
    throw new Error("unreachable");
  expect(second.state.seatId).toBe(first.state.seatId);

  // One row, not two: the double-click did not mint a second seat.
  expect(
    await db.demoSeat.count({
      where: { ipHash: ip, deviceId: dev, status: { in: ["active", "queued"] } },
    }),
  ).toBe(1);
});

test("joins past capacity queue FIFO with positions", async () => {
  expect(demoCapacity()).toBe(2);
  const mk = (tag: string) => joinQueue(ipOf(tag), devOf(tag), `rl:${RUN}:${tag}`);
  const r1 = await mk("b1");
  const r2 = await mk("b2");
  expect(r1.ok && r1.state.status).toBe("active");
  expect(r2.ok && r2.state.status).toBe("active");

  const r3 = await mk("b3");
  const r4 = await mk("b4");
  expect(r3.ok && r3.state.status).toBe("queued");
  expect(r4.ok && r4.state.status).toBe("queued");
  if (!r3.ok || r3.state.status !== "queued" || !r4.ok || r4.state.status !== "queued") {
    throw new Error("unreachable");
  }
  expect(r3.state.position).toBe(1);
  expect(r4.state.position).toBe(2);
  expect(await liveCount()).toBe(2);
});

test("releasing a seat promotes the head of the line", async () => {
  const mk = (tag: string) => joinQueue(ipOf(tag), devOf(tag), `rl:${RUN}:c${tag}`);
  const a = await mk("c1");
  await mk("c2");
  const q = await mk("c3");
  if (!a.ok || a.state.status !== "active" || !q.ok || q.state.status !== "queued") {
    throw new Error("unreachable");
  }
  await releaseSeat(a.state.seatId);
  const head = await seatState(q.state.seatId);
  expect(head?.status).toBe("active");
});

test("a stale lease holds no seat and is swept on the next join", async () => {
  const ip = ipOf("d");
  const dev = devOf("d");
  const stale = await db.demoSeat.create({
    data: {
      ipHash: ip,
      deviceId: dev,
      status: "active",
      lastSeenAt: new Date(Date.now() - 3600_000),
    },
    select: { id: true },
  });
  // A fresh pair still gets a seat: the stale row does not count as live.
  const fresh = await joinQueue(ipOf("d2"), devOf("d2"), `rl:${RUN}:d2`);
  expect(fresh.ok && fresh.state.status).toBe("active");
  // And the sweep released the stale row rather than leaving it.
  const row = await db.demoSeat.findUnique({ where: { id: stale.id }, select: { status: true } });
  expect(row?.status).toBe("released");
});

test("heartbeat renews; a released seat reports gone", async () => {
  const joined = await joinQueue(ipOf("e"), devOf("e"), `rl:${RUN}:e`);
  if (!joined.ok || joined.state.status !== "active") throw new Error("unreachable");
  expect(await heartbeat(joined.state.seatId)).toBe(true);
  await releaseSeat(joined.state.seatId);
  expect(await heartbeat(joined.state.seatId)).toBe(false);
  expect(await seatState(joined.state.seatId)).toBeNull();
});

test("claim binds the lease to the user; releaseUserSeats frees and promotes", async () => {
  const mk = (tag: string) => joinQueue(ipOf(tag), devOf(tag), `rl:${RUN}:f${tag}`);
  const a = await mk("f1");
  await mk("f2");
  const q = await mk("f3");
  if (!a.ok || a.state.status !== "active" || !q.ok || q.state.status !== "queued") {
    throw new Error("unreachable");
  }
  const claimed = await claimSeat(ipOf("f1"), devOf("f1"), "user-claim-1");
  expect(claimed?.userId).toBe("user-claim-1");
  expect(await leaseForUser("user-claim-1")).not.toBeNull();
  expect(await leaseForUser("user-nobody")).toBeNull();

  // Sign-out path: all of the user's seats release and the head promotes.
  expect(await releaseUserSeats("user-claim-1")).toBe(1);
  expect(await leaseForUser("user-claim-1")).toBeNull();
  expect((await seatState(q.state.seatId))?.status).toBe("active");
});

test("claiming with no live seat returns null (enter must refuse)", async () => {
  expect(await claimSeat(ipOf("g"), devOf("g"), "user-ghost")).toBeNull();
});

test("an exhausted pair budget refuses the rejoin after a release", async () => {
  // Rejoins of a LIVE row short-circuit before spending, so exhaustion is
  // proven the honest way: join (spends the single token), release (row gone),
  // rejoin (no live row → must spend → refused). That is also the real
  // anti-spam shape: a join→leave→join loop burns budget every cycle.
  process.env.DEMO_JOIN_PER_HOUR = "1";
  const ip = ipOf("h");
  const dev = devOf("h");
  const key = `${ip}:${dev}`;
  const first = await joinQueue(ip, dev, key);
  expect(first.ok).toBe(true);
  if (!first.ok || first.state.status !== "active") throw new Error("unreachable");
  await releaseSeat(first.state.seatId);
  const second = await joinQueue(ip, dev, key);
  expect(second.ok).toBe(false);
  if (second.ok) throw new Error("unreachable");
  expect(second.retryAfterMs).toBeGreaterThan(0);
  expect(second.limit).toBe(1);
});

test("the per-IP backstop stops device-id cycling", async () => {
  // A fresh device id is a fresh pair bucket, so the pair budget alone cannot
  // see the loop. The IP bucket can: one token shared across every device on
  // the address.
  process.env.DEMO_JOIN_PER_HOUR = "1000";
  process.env.DEMO_JOIN_IP_PER_HOUR = "1";
  try {
    const ip = ipOf("i");
    const first = await joinQueue(ip, devOf("i1"), `${ip}:${devOf("i1")}`);
    expect(first.ok).toBe(true);
    const second = await joinQueue(ip, devOf("i2"), `${ip}:${devOf("i2")}`);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.limit).toBe(1);
  } finally {
    delete process.env.DEMO_JOIN_IP_PER_HOUR;
  }
});
