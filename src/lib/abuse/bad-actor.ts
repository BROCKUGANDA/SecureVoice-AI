/**
 * Bad-actor tracking: stop a hostile source from probing the platform for free.
 *
 * Several surfaces here accept input from anyone who can send a text or place a
 * call: the inbound-SMS reply handler, the live conversation turn, the agent
 * tool endpoints. Each already validates its input. What validation alone does
 * NOT do is notice that the SAME source has now failed forty times - enumerating
 * which phone numbers have an open fraud case, hunting for a prompt-injection
 * that sticks, or replaying forged webhooks - and make the forty-first attempt
 * cost something.
 *
 * ## Model
 *
 * A source (a phone number, an IP, a producer key) accumulates weighted STRIKES
 * inside a sliding window. Crossing a threshold moves it up a ladder:
 *
 *   allow  ->  throttle (still served, slowly / with a generic answer)  ->  block
 *
 * A block lasts an hour and DOUBLES each time the source earns another one
 * (capped at 24h), so a patient attacker pays more per probe than a mistyped
 * customer ever will.
 *
 * ## What it is careful NOT to do
 *
 *   - It never blocks a source for ordinary mistakes. A customer who replies
 *     "maybe" earns a fraction of a strike; it takes sustained abuse to block.
 *   - It keys on a HASH of the identifier, so a phone number is never held in
 *     memory or written to a log by this module.
 *   - It fails OPEN on internal error (the callers wrap it): a bug here must
 *     never stop a genuine fraud victim from answering their bank.
 *   - A block is advisory to the CALLER: SMS blocks answer with the same generic
 *     text a non-match gets, so a probe cannot tell "blocked" from "no such case".
 *
 * ## Known limit
 *
 * State is per-process. With N web instances an attacker gets up to N times the
 * budget before every instance has seen them. That is acceptable for a throttle
 * (the durable record is the audit chain each strike also writes), and the
 * limitation is stated here rather than implied away. Moving the map to the
 * shared Redis (src/lib/redis.ts) is the upgrade path if it ever matters.
 */

import { createHash } from "node:crypto";

import { env } from "../config";

export type ActorAction = "allow" | "throttle" | "block";

export type ActorVerdict = {
  action: ActorAction;
  /** Strikes currently inside the window (rounded to 1 d.p.). */
  strikes: number;
  /** When the block lifts, if blocked. */
  retryAfterMs?: number;
};

const WINDOW_MS = env.abuseBadActorWindowMs; // strikes older than an hour stop counting
const THROTTLE_AT = env.abuseBadActorThrottleAt;
const BLOCK_AT = env.abuseBadActorBlockAt;
const BASE_BLOCK_MS = env.abuseBadActorBaseBlockMs;
const MAX_BLOCK_MS = env.abuseBadActorMaxBlockMs;
const MAX_TRACKED = env.abuseBadActorMaxTracked; // bound memory: a flood of distinct sources cannot grow this forever

type Entry = {
  hits: { at: number; weight: number }[];
  blockedUntil: number;
  blocks: number; // how many times this source has been blocked: drives the doubling
  lastSeen: number;
};

const table = new Map<string, Entry>();

function keyOf(identifier: string): string {
  return createHash("sha256").update(identifier).digest("hex").slice(0, 24);
}

function prune(now: number): void {
  if (table.size <= MAX_TRACKED) return;
  // Drop the least recently seen quarter. Cheap, and it can only ever forgive.
  const byAge = [...table.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
  for (const [k] of byAge.slice(0, Math.ceil(table.size / 4))) table.delete(k);
  void now;
}

function liveStrikes(e: Entry, now: number): number {
  e.hits = e.hits.filter((h) => now - h.at < WINDOW_MS);
  return e.hits.reduce((n, h) => n + h.weight, 0);
}

function verdictFor(e: Entry, now: number): ActorVerdict {
  const strikes = Math.round(liveStrikes(e, now) * 10) / 10;
  if (e.blockedUntil > now) return { action: "block", strikes, retryAfterMs: e.blockedUntil - now };
  if (strikes >= THROTTLE_AT) return { action: "throttle", strikes };
  return { action: "allow", strikes };
}

/** Where does this source stand right now? Does not record anything. */
export function checkBadActor(identifier: string, now: number = Date.now()): ActorVerdict {
  const e = table.get(keyOf(identifier));
  return e ? verdictFor(e, now) : { action: "allow", strikes: 0 };
}

/**
 * Record misbehaviour. `weight` scales it: a malformed reply is 0.5, a probe for
 * a non-existent case is 1, an instruction-injection attempt or a forged
 * signature is 3. Returns the verdict AFTER this strike so the caller can react
 * to the transition (and audit it) in the same breath.
 */
export function recordStrike(
  identifier: string,
  weight: number,
  now: number = Date.now(),
): ActorVerdict {
  const k = keyOf(identifier);
  let e = table.get(k);
  if (!e) {
    prune(now);
    e = { hits: [], blockedUntil: 0, blocks: 0, lastSeen: now };
    table.set(k, e);
  }
  e.lastSeen = now;
  e.hits.push({ at: now, weight: Math.max(0, weight) });

  if (e.blockedUntil <= now && liveStrikes(e, now) >= BLOCK_AT) {
    e.blocks += 1;
    const duration = Math.min(BASE_BLOCK_MS * 2 ** (e.blocks - 1), MAX_BLOCK_MS);
    e.blockedUntil = now + duration;
    // The strikes that earned the block are spent: the NEXT block must be earned
    // afresh, but `blocks` remembers this source is a repeat offender.
    e.hits = [];
  }
  return verdictFor(e, now);
}

/** Test seam. */
export function _resetBadActors(): void {
  table.clear();
}
