import "server-only";
/**
 * Demo sign-in queue — bounded concurrent guided-demo sessions.
 *
 * The one-click demo credential is PUBLIC (it ships in the sign-in bundle), so
 * "who may sign into the demo user" cannot be answered by the password. It is
 * answered here instead, by three controls that compose:
 *
 *   1. JOIN RATE LIMIT (anti-spam). Each (IP, device) pair gets a small hourly
 *      budget of queue joins. A script cycling devices still shares the IP
 *      bucket, and a script cycling IPs still needs a fresh device id per
 *      attempt that also passes validation.
 *   2. CAPACITY (the bound). At most `capacity()` ACTIVE leases exist. A join
 *      past capacity becomes a QUEUED ticket, promoted FIFO when a seat frees.
 *      The count excludes stale leases (no heartbeat within the TTL), so a
 *      browser that closed without signing out stops holding its seat.
 *   3. LEASE (the session binding). Sign-in (`/api/demo/enter`) binds the
 *      active lease to the Better Auth user id. `getProfile()` requires a live
 *      lease for demo emails, which is what closes the manual-form bypass:
 *      signing in with the published password outside the queue yields a
 *      session with no lease, and therefore no profile.
 *
 * Concurrency: the join is check-then-insert, so two simultaneous joins past
 * the last seat could both read "room" — the PARTIAL unique index on live rows
 * (`DemoSeat_live_pair_key` in migration
 * 9zzzzzzzzzzzzzzzzzzzzzzzzzzzz_demo_seat_live_unique) turns the loser's insert
 * into P2002, which is caught and re-read as the existing row. (A plain
 * `@@unique([ipHash, deviceId, status])` was tried first and removed: it
 * permitted only one "released" row per pair, so the sweep's bulk release
 * violated its own index and died silently. Prisma cannot express a partial
 * index, so the backstop lives in SQL.) Two DIFFERENT pairs racing past the
 * last seat can still both land active; the overshoot is bounded by the race
 * window and the sweeper plus the next join's count re-converge it. A demo seat
 * is an operational bound, not money, so a momentary +1 under a race is
 * acceptable where a lost sign-in would not be. (Compare `store.take` in
 * src/lib/auth/store.ts, where exactly-once is money and gets the unique
 * index as the decider rather than the backstop.)
 *
 * Privacy: the IP is SHA-256 hashed before storage and the device id is
 * validated to a tight alphabet. Rows are operational state: `sweepStale`
 * releases dead leases on every join/status read, and released rows are
 * deleted wholesale by `pruneReleased` (called from the same paths).
 */

import { db } from "@/lib/db";
import { consume as consumeRateLimit, rateLimitHeaders } from "@/lib/ratelimit";
import { clientFingerprint, isRealIp, resolveClientIp } from "@/lib/ip-normalize";
import { ipPseudonym } from "@/lib/client-ip";
import { logWarn } from "@/lib/validation/safe-log";

export function demoCapacity(): number {
  const raw = Number(process.env.DEMO_SEAT_CAPACITY);
  if (Number.isFinite(raw) && raw > 0) return Math.min(Math.floor(raw), 100);
  return 5;
}

/** Seconds without a heartbeat before a lease is considered abandoned. */
export function demoLeaseTtlSec(): number {
  const raw = Number(process.env.DEMO_LEASE_TTL_SEC);
  if (Number.isFinite(raw) && raw >= 30) return Math.min(Math.floor(raw), 3600);
  return 180;
}

/** Joins per hour per (IP, device) pair. Anti-spam, not capacity. */
export function demoJoinPerHour(): number {
  const raw = Number(process.env.DEMO_JOIN_PER_HOUR);
  if (Number.isFinite(raw) && raw > 0) return Math.min(Math.floor(raw), 1000);
  return 20;
}

/**
 * Joins per hour per IP, across all devices. The pair budget alone cannot
 * stop a script cycling device ids (every fresh id is a fresh bucket), so the
 * IP bucket is the backstop: generous enough that a NAT-shared office of
 * judges never notices it, tight enough that a row-minting loop hits it
 * within minutes. Pruned released rows make the residual junk cheap.
 */
export function demoJoinIpPerHour(): number {
  const raw = Number(process.env.DEMO_JOIN_IP_PER_HOUR);
  if (Number.isFinite(raw) && raw > 0) return Math.min(Math.floor(raw), 10_000);
  return 100;
}

/** Tight alphabet so a device id cannot smuggle structure into keys or logs. */
export function validDeviceId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value);
}

/**
 * The storage key for a client's address.
 *
 * Takes HEADERS, not an address, so a caller cannot accidentally key a seat on a
 * header it believed. It used to take a string and hash whatever it was handed,
 * which meant the trust decision had already been made (or skipped) somewhere
 * upstream and this function could not see it.
 *
 * Through the canonical resolver, so all three spellings of one address
 * (`203.0.113.5`, `::ffff:203.0.113.5`, `203.0.113.005`) are ONE client. Two
 * spellings of one person holding two seats is a capacity leak an attacker gets
 * for free, and the alternative — two spellings of one person being two rate-limit
 * buckets — is the same hole in the other direction.
 *
 * Keyed under AUTH_SECRET rather than a bare SHA-256: an unkeyed digest of an
 * address is trivially reversible by enumerating the whole IPv4 space in a
 * laptop, which would make this table a durable address log wearing a hash as a
 * disguise. See `src/lib/hmac.ts`.
 *
 * Falls back to a stable per-process fingerprint for an unestablished address, so
 * a caller that bypassed the proxy cannot mint a fresh seat per request by
 * choosing a header. Not durable across restarts, which is the correct trade: a
 * queue position is not money, and minting one per request is the attack.
 */
export function hashIp(headers: Headers): string {
  const ip = resolveClientIp(headers);
  if (isRealIp(ip)) return ipPseudonym(ip)!;
  return clientFingerprint(ip);
}

export type SeatStatus = "active" | "queued" | "released";

export type DemoSeatRow = {
  id: string;
  status: SeatStatus;
  userId: string | null;
  createdAt: Date;
  lastSeenAt: Date;
};

export type QueueState =
  | { status: "active"; seatId: string; capacity: number; activeCount: number }
  | { status: "queued"; seatId: string; position: number; capacity: number; activeCount: number };

function cutoff(): Date {
  return new Date(Date.now() - demoLeaseTtlSec() * 1000);
}

/** Release dead leases and prune old released rows. Runs inside join/status. */
async function sweep(): Promise<void> {
  const stale = cutoff();
  try {
    await db.demoSeat.updateMany({
      where: { status: { in: ["active", "queued"] }, lastSeenAt: { lt: stale } },
      data: { status: "released" },
    });
    // Released rows are garbage once stale themselves; keep a day for forensics.
    await db.demoSeat.deleteMany({
      where: {
        status: "released",
        updatedAt: { lt: new Date(Date.now() - 24 * 3600 * 1000) },
      },
    });
  } catch (err) {
    // The queue must never take down sign-in: a sweep failure degrades to
    // "stale seats linger until the next sweep", which the live-row filter
    // below already treats as absent.
    logWarn("[demo-queue] sweep failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function liveCounts(): Promise<{ active: number }> {
  const stale = cutoff();
  const active = await db.demoSeat.count({
    where: { status: "active", lastSeenAt: { gte: stale } },
  });
  return { active };
}

/** Promote the oldest queued ticket while capacity allows. Returns promotions. */
async function promote(): Promise<number> {
  const cap = demoCapacity();
  let promoted = 0;
  for (;;) {
    const { active } = await liveCounts();
    if (active >= cap) return promoted;
    const head = await db.demoSeat.findFirst({
      where: { status: "queued", lastSeenAt: { gte: cutoff() } },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (!head) return promoted;
    const claimed = await db.demoSeat.updateMany({
      where: { id: head.id, status: "queued" },
      data: { status: "active", lastSeenAt: new Date() },
    });
    if (claimed.count === 0) continue; // lost the race; re-read the head
    promoted += 1;
  }
}

async function positionOf(seatId: string): Promise<number> {
  const me = await db.demoSeat.findUnique({ where: { id: seatId }, select: { createdAt: true } });
  if (!me) return 0;
  const ahead = await db.demoSeat.count({
    where: { status: "queued", lastSeenAt: { gte: cutoff() }, createdAt: { lt: me.createdAt } },
  });
  return ahead + 1;
}

function toRow(r: {
  id: string;
  status: string;
  userId: string | null;
  createdAt: Date;
  lastSeenAt: Date;
}): DemoSeatRow {
  return {
    id: r.id,
    status: r.status === "active" || r.status === "released" ? r.status : "queued",
    userId: r.userId,
    createdAt: r.createdAt,
    lastSeenAt: r.lastSeenAt,
  };
}

/**
 * Join (or rejoin) the queue for one (IP, device) pair.
 *
 * Idempotent per pair: an existing live row is returned with a refreshed
 * heartbeat rather than minted again, so a double-click or a retry storm is
 * one seat, not two — and costs no budget. Only minting a NEW seat spends:
 * first the per-pair budget, then the per-IP backstop (which is what stops a
 * device-id cycling loop, since every fresh id is otherwise a fresh bucket).
 */
export async function joinQueue(
  ipHash: string,
  deviceId: string,
  rateLimitKey: string,
): Promise<{ ok: true; state: QueueState } | { ok: false; retryAfterMs: number; limit: number }> {
  await sweep();

  const existing = await db.demoSeat.findFirst({
    where: {
      ipHash,
      deviceId,
      status: { in: ["active", "queued"] },
      lastSeenAt: { gte: cutoff() },
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    // Live by construction (the query filters staleness; anything older was
    // released by the sweep above). Refresh and return — no budget spent.
    const row = toRow(existing);
    await db.demoSeat.update({ where: { id: row.id }, data: { lastSeenAt: new Date() } });
    const { active } = await liveCounts();
    if (row.status === "active") {
      return {
        ok: true,
        state: {
          status: "active",
          seatId: row.id,
          capacity: demoCapacity(),
          activeCount: active,
        },
      };
    }
    // A queued ticket re-checking may have been promotable since.
    await promote();
    const fresh = await db.demoSeat.findUnique({ where: { id: row.id } });
    if (fresh && fresh.status === "active") {
      return {
        ok: true,
        state: {
          status: "active",
          seatId: row.id,
          capacity: demoCapacity(),
          activeCount: active,
        },
      };
    }
    return {
      ok: true,
      state: {
        status: "queued",
        seatId: row.id,
        position: await positionOf(row.id),
        capacity: demoCapacity(),
        activeCount: active,
      },
    };
  }

  // New seat: spend budget first (pair, then the IP backstop), so a refusal
  // happens before any row exists rather than minting-then-discarding one.
  const pair = await consumeRateLimit("demo-queue-join", rateLimitKey, 1, demoJoinPerHour());
  if (!pair.ok) return { ok: false, retryAfterMs: pair.retryAfterMs, limit: pair.limit };
  const ip = await consumeRateLimit("demo-queue-join-ip", ipHash, 1, demoJoinIpPerHour());
  if (!ip.ok) return { ok: false, retryAfterMs: ip.retryAfterMs, limit: ip.limit };

  const cap = demoCapacity();
  const { active } = await liveCounts();
  const status: SeatStatus = active < cap ? "active" : "queued";
  try {
    const created = await db.demoSeat.create({
      data: { ipHash, deviceId, status, lastSeenAt: new Date() },
    });
    if (status === "active") {
      return {
        ok: true,
        state: { status: "active", seatId: created.id, capacity: cap, activeCount: active + 1 },
      };
    }
    return {
      ok: true,
      state: {
        status: "queued",
        seatId: created.id,
        position: await positionOf(created.id),
        capacity: cap,
        activeCount: active,
      },
    };
  } catch (err) {
    // Lost the insert race against our own twin (unique index backstop):
    // re-read the winner rather than failing the join.
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002") {
      const winner = await db.demoSeat.findFirst({
        where: { ipHash, deviceId, status: { in: ["active", "queued"] } },
        orderBy: { createdAt: "desc" },
      });
      if (winner) {
        const row = toRow(winner);
        const counts = await liveCounts();
        if (row.status === "active") {
          return {
            ok: true,
            state: { status: "active", seatId: row.id, capacity: cap, activeCount: counts.active },
          };
        }
        return {
          ok: true,
          state: {
            status: "queued",
            seatId: row.id,
            position: await positionOf(row.id),
            capacity: cap,
            activeCount: counts.active,
          },
        };
      }
    }
    throw err;
  }
}

/**
 * Heartbeat a seat, active or queued. Returns false when the seat is gone.
 *
 * Queued tickets heartbeat too: the sweep releases anything stale, and a
 * waiter who only polls status without heartbeating would be swept out of
 * line. The client poll loop therefore heartbeats on every tick.
 */
export async function heartbeat(seatId: string): Promise<boolean> {
  await sweep();
  const touched = await db.demoSeat.updateMany({
    where: { id: seatId, status: { in: ["active", "queued"] }, lastSeenAt: { gte: cutoff() } },
    data: { lastSeenAt: new Date() },
  });
  if (touched.count === 0) {
    // The seat may have lapsed while capacity sat free — promote on the way
    // out so a heartbeat never observes a seat it could have granted.
    await promote();
    return false;
  }
  return true;
}

/** Read current state for a seat (promoting opportunistically). */
export async function seatState(seatId: string): Promise<QueueState | null> {
  await sweep();
  await promote();
  const row = await db.demoSeat.findUnique({ where: { id: seatId } });
  if (!row || row.status === "released" || row.lastSeenAt < cutoff()) return null;
  const { active } = await liveCounts();
  if (row.status === "active") {
    return { status: "active", seatId: row.id, capacity: demoCapacity(), activeCount: active };
  }
  return {
    status: "queued",
    seatId: row.id,
    position: await positionOf(row.id),
    capacity: demoCapacity(),
    activeCount: active,
  };
}

/** Release a seat explicitly (sign-out, "leave" action). Promotes the head. */
export async function releaseSeat(seatId: string): Promise<void> {
  await db.demoSeat.updateMany({ where: { id: seatId }, data: { status: "released" } });
  await promote();
}

/** Release every live seat held by a user (sign-out backstop). */
/**
 * Release every live seat held by a user (sign-out backstop).
 *
 * Scoped to the caller's OWN session where one is given, because `userId` is
 * shared by every admitted browser — releasing on the user alone would let one
 * judge signing out evict every other judge's seat and hand the whole room a
 * wave of spurious "you were removed from the queue" banners.
 */
export async function releaseUserSeats(userId: string, sessionId?: string | null): Promise<number> {
  const released = await db.demoSeat.updateMany({
    where: {
      userId,
      status: { in: ["active", "queued"] },
      ...(sessionId ? { sessionId } : {}),
    },
    data: { status: "released" },
  });
  if (released.count > 0) await promote();
  return released.count;
}

/**
 * Redeem an ACTIVE seat, binding it to the user AND the session that just signed
 * in (the claim step of `/api/demo/enter`). The pair must match: a grant for one
 * device does not admit another, which is what stops a single queue position from
 * minting sessions for a room.
 *
 * Both ids are stamped, but the SESSION is the one `leaseForSession` checks.
 */
export async function claimSeat(
  ipHash: string,
  deviceId: string,
  userId: string,
  sessionId: string,
): Promise<DemoSeatRow | null> {
  const row = await db.demoSeat.findFirst({
    where: { ipHash, deviceId, status: "active", lastSeenAt: { gte: cutoff() } },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return null;
  const claimed = await db.demoSeat.update({
    where: { id: row.id },
    data: { userId, sessionId, lastSeenAt: new Date() },
  });
  return toRow(claimed);
}

/**
 * The seat a SESSION holds. A demo session is admitted only while it is live.
 *
 * Keyed on the session rather than the user, and that is load-bearing rather than
 * tidier. The demo credential is one published account, so every admitted browser
 * shares a single `userId`: a user-keyed lookup returned whichever seat happened
 * to be live for that user, which meant browser A's seat ALSO admitted browser B
 * the moment B typed the published password into the manual sign-in form. The
 * capacity bound this queue exists to enforce was N+1 the instant anyone was
 * admitted.
 *
 * Per session, N browsers hold N seats up to capacity and a session holding none
 * is refused. The manual form never redeems a seat, so it can never mint an
 * admitted demo session — which closes that bypass WITHOUT capping legitimate
 * concurrency to one.
 */
export async function leaseForSession(sessionId: string): Promise<DemoSeatRow | null> {
  if (!sessionId) return null;
  const row = await db.demoSeat.findFirst({
    where: { sessionId, status: "active", lastSeenAt: { gte: cutoff() } },
    orderBy: { lastSeenAt: "desc" },
  });
  return row ? toRow(row) : null;
}

export { rateLimitHeaders };
