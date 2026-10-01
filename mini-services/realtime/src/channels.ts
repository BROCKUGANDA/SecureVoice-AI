/**
 * Channel naming and the per-channel presence roster.
 *
 * Two rules, and they are the whole security model of this service:
 *
 *   1. A channel name is DERIVED from the org id. `caseChannel(orgId, callRef)`
 *      builds the only legal name for that case, so a grant that was minted for
 *      org A cannot contain org B's channel name — there is nothing to tamper
 *      with, because the client never supplies a raw channel string and we never
 *      accept one that is not in the grant's list.
 *
 *   2. Membership is checked on every join, and again on every emit target. A
 *      socket that somehow ended up subscribed to an extra room still cannot
 *      publish to it.
 *
 * Presence is kept as a refcount per (channel, socket) so a disconnecting client
 * is only removed from the roster once its last socket is gone. Multiple tabs on
 * the same case are normal — a case usually has a Tier-1 analyst and an
 * escalation specialist watching it.
 */

/** Cap on how many distinct orgs we track at once; evicts the quietest. */
const MAX_ORGS = 2_000;
/** Cap on sockets per channel; a broadcast fan-out this wide is a bug upstream. */
const MAX_PER_CHANNEL = 64;

export type Member = { sub: string; socketId: string; joinedAt: number };

export function caseChannel(orgId: string, callRef: string): string {
  return `case:${orgId}:${callRef}`;
}

export function orgChannel(orgId: string): string {
  return `org:${orgId}`;
}

/**
 * Sanitise an org id / call ref before it becomes part of a channel name.
 *
 * Colons are DELIMITERS in a channel name (`case:<org>:<callRef>`), so they are
 * stripped here even though the audit chain's safeKey() allows them. Allowing
 * them would let `orgId = "a:case:org_b"` produce a five-segment name that the
 * three-part join parser could never reconstruct — an unjoinable channel, and a
 * latent cross-org confusion bug. Org ids are Clerk ids (`org_…`) and call refs
 * are `SV-…`, so nothing legitimate is lost.
 */
export function safeSegment(v: string, max: number): string {
  return v.replace(/[^\w.-]/g, "").slice(0, max);
}

export class PresenceRegistry {
  /** channel → socketId → member */
  private rooms = new Map<string, Map<string, Member>>();
  /** last time an org was touched, for LRU eviction */
  private touched = new Map<string, number>();

  private roomFor(channel: string): Map<string, Member> {
    let room = this.rooms.get(channel);
    if (!room) {
      room = new Map();
      this.rooms.set(channel, room);
    }
    return room;
  }

  add(channel: string, member: Member): void {
    const room = this.roomFor(channel);
    // Evict the oldest socket rather than dropping the join: a client that
    // reconnects during a fan-out burst would otherwise lose live events.
    if (room.size >= MAX_PER_CHANNEL && !room.has(member.socketId)) {
      let oldestId: string | null = null;
      let oldestAt = Infinity;
      for (const [id, m] of room) {
        if (m.joinedAt < oldestAt) {
          oldestAt = m.joinedAt;
          oldestId = id;
        }
      }
      if (oldestId) room.delete(oldestId);
    }
    room.set(member.socketId, member);
    this.touch(channel);
  }

  remove(channel: string, socketId: string): Member | null {
    const room = this.rooms.get(channel);
    if (!room) return null;
    const gone = room.get(socketId) ?? null;
    room.delete(socketId);
    if (room.size === 0) this.rooms.delete(channel);
    this.touch(channel);
    return gone;
  }

  channelsOf(socketId: string): string[] {
    const out: string[] = [];
    for (const [channel, room] of this.rooms) {
      if (room.has(socketId)) out.push(channel);
    }
    return out;
  }

  members(channel: string): Member[] {
    const room = this.rooms.get(channel);
    return room ? [...room.values()] : [];
  }

  /** Distinct operators currently watching a channel (tabs collapse). */
  watchers(channel: string): string[] {
    return [...new Set(this.members(channel).map((m) => m.sub))];
  }

  stats() {
    let sockets = 0;
    for (const room of this.rooms.values()) sockets += room.size;
    return { channels: this.rooms.size, sockets };
  }

  private touch(channel: string): void {
    this.touched.set(channel, Date.now());
    // Evict the least-recently-touched channel when we exceed the cap. Churn on
    // one hot case must not be able to grow the registry without bound.
    if (this.touched.size <= MAX_ORGS) return;
    let oldestChannel: string | null = null;
    let oldestAt = Infinity;
    for (const [ch, at] of this.touched) {
      if (at < oldestAt) {
        oldestAt = at;
        oldestChannel = ch;
      }
    }
    if (oldestChannel && oldestChannel !== channel) {
      this.touched.delete(oldestChannel);
      this.rooms.delete(oldestChannel);
    }
  }
}
