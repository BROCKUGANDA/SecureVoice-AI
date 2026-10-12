import "server-only";
/**
 * Redis Pub/Sub — intervention state shared across more than one app instance.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A fraud intervention is created on whichever Node process the load balancer
 * happened to hand the bank's signal to. The state it changes, however, is not
 * necessarily held by that process: the operator console, the SSE stream and the
 * WebSocket room a customer or analyst is watching may all live on a DIFFERENT
 * instance. One process cannot read another process's memory, so a case created
 * on instance A is invisible to the console connected to instance B until B
 * happens to read it back from the database — a poll, not a push.
 *
 * Redis Pub/Sub is the smallest thing that closes that gap. The process that
 * owns the write PUBLISHes the intervention id (and whatever state changed);
 * every process subscribed to the channel — including the publisher — receives
 * it and refreshes its local view immediately.
 *
 * It is deliberately NOT a queue. A message published while an instance is
 * restarting is not replayed, because the database is the durable record and
 * pub/sub is only the "tell the other instances now" channel. A missed
 * notification costs one read, never a fact. That is also why a publish that
 * fails is not allowed to fail the caller: the database write and the audit
 * chain have already happened by the time this is called.
 *
 * ── Shape ───────────────────────────────────────────────────────────────────
 * TWO ioredis connections, because a Redis connection in subscriber mode cannot
 * run any other command — including PUBLISH. One publisher, one subscriber. Both
 * are created lazily on first use, so importing this module opens no socket:
 * tests and build-time evaluation cannot hang on a Redis that is not there, and
 * a single-instance deployment that never subscribes pays nothing.
 *
 * ── Failure posture ─────────────────────────────────────────────────────────
 * Every entry point resolves; none of them rejects on a Redis fault. A publish
 * returns `{ published: false }` and logs a line rather than throwing into the
 * intervention path — an outage degrades cross-instance push, it does not drop a
 * customer call. `subscribeToInterventions` returns a working (no-op) handle even
 * when Redis is absent, so the caller's start-up code has one shape to write.
 *
 * ── Transport ───────────────────────────────────────────────────────────────
 * The same rule the budget meter enforces applies here:
 * `assertRedisTransportIsEncrypted` requires `rediss://` in production unless the
 * operator explicitly acknowledges a private network
 * (`REDIS_ALLOW_PLAINTEXT_PRIVATE_NETWORK=true`, which docker-compose sets). An
 * intervention payload can name a case and its state — bank-relevant — so the
 * plaintext hop is at least as sensitive as the meter's counters.
 */

import Redis from "ioredis";
import { assertRedisTransportIsEncrypted } from "@/lib/redis";
import { logError, logInfo, logWarn } from "@/lib/validation/safe-log";

/**
 * The channel every instance subscribes to. One channel for all interventions:
 * the message carries the id, and a consumer filters on it. A per-intervention
 * channel would mean SUBSCRIBE/UNSUBSCRIBE churn on the hot path for no gain —
 * Redis pub/sub fan-out is already the cheap part.
 *
 * Overridable so two deployments sharing one Redis (a staging and a demo, say)
 * cannot cross-talk, which would show one tenant another's cases.
 */
export const INTERVENTION_CHANNEL =
  process.env.REDIS_PUBSUB_CHANNEL?.trim() || "securevoice:interventions";

/** The wire envelope. `ts` is the publisher's clock, for ordering only. */
export type InterventionMessage = {
  /** The intervention (case) this notification is about. The routing key. */
  interventionId: string;
  /** Whatever state the publisher wants the other instances to see. Opaque here. */
  data: unknown;
  /** ISO-8601 publish time. Informational; never used for correctness. */
  ts: string;
};

/** A subscriber callback. Runs for every message the channel delivers. */
export type InterventionSubscriber = (interventionId: string, data: unknown) => void;

/** The handle returned by `subscribeToInterventions`. */
export type InterventionSubscription = {
  /** Remove this callback. Closes the subscriber connection when the last one goes. */
  unsubscribe: () => Promise<void>;
};

/** True when a shared Redis is configured. False means single-process only. */
export function pubSubConfigured(): boolean {
  return !!process.env.REDIS_URL;
}

/* ── Connection management ─────────────────────────────────────────────────── */

const CONNECT_TIMEOUT_MS = 1_500;

let publisher: Redis | null = null;
let subscriber: Redis | null = null;
/** True once the subscriber is subscribed AND the message listener is attached. */
let subscribed = false;

/** Every registered callback. A Set so unsubscribe is O(1) and duplicates collapse. */
const callbacks = new Set<InterventionSubscriber>();

/**
 * Build a client without opening a socket. `lazyConnect` is the same posture
 * src/lib/redis.ts takes: importing this module must never dial anything.
 *
 * The publisher fails fast (`enableOfflineQueue: false`, one retry) because it
 * has a caller with a declared degraded path — a publish that has not landed in
 * a second is not worth waiting on. The subscriber is the opposite: it is a
 * long-lived process-lifetime connection with no caller to degrade to, so it is
 * allowed to keep retrying (`maxRetriesPerRequest: null`) and ioredis
 * re-subscribes automatically after a reconnect.
 */
function makeClient(role: "publisher" | "subscriber"): Redis {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not set");
  assertRedisTransportIsEncrypted(url);

  const client = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: role === "subscriber" ? null : 1,
    connectTimeout: CONNECT_TIMEOUT_MS,
    commandTimeout: CONNECT_TIMEOUT_MS,
  });
  // ioredis re-emits connection errors on the instance; without a listener an
  // outage becomes an unhandled 'error' event and takes the process down.
  client.on("error", () => undefined);
  return client;
}

/** Resolve once a connecting/reconnecting client is ready, or reject on failure. */
function waitForReady(client: Redis, role: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.off("ready", onReady);
      client.off("error", onError);
      client.off("end", onEnd);
      if (err) reject(err);
      else resolve();
    };
    const onReady = (): void => finish();
    const onError = (err: Error): void => finish(err);
    const onEnd = (): void => finish(new Error(`${role} connection closed before it was ready`));

    const timer = setTimeout(
      () => finish(new Error(`${role} did not become ready within ${CONNECT_TIMEOUT_MS}ms`)),
      CONNECT_TIMEOUT_MS + 500,
    );
    timer.unref?.();

    client.once("ready", onReady);
    client.once("error", onError);
    client.once("end", onEnd);

    // Status may already have moved past the state that would emit the event.
    if (client.status === "ready") finish();
    else if (client.status === "end") finish(new Error(`${role} connection ended`));
  });
}

/**
 * Bring a lazy client up and wait until it is usable. `connect()` on a
 * `lazyConnect` client resolves when the connection is ready; if it is already
 * connecting or reconnecting we wait for the 'ready' event instead.
 */
async function ensureConnected(client: Redis, role: "publisher" | "subscriber"): Promise<void> {
  if (client.status === "ready") return;
  if (client.status === "wait") {
    await client.connect();
    return;
  }
  await waitForReady(client, role);
}

function getPublisher(): Redis {
  if (!publisher) publisher = makeClient("publisher");
  return publisher;
}

function getSubscriber(): Redis {
  if (!subscriber) subscriber = makeClient("subscriber");
  return subscriber;
}

/* ── Receive path ──────────────────────────────────────────────────────────── */

/**
 * Fan one raw message out to every registered callback.
 *
 * The payload is parsed defensively: a message on the channel is data from
 * another process (and, on a shared Redis, potentially another deployment), so a
 * malformed one is logged and dropped rather than allowed to throw inside an
 * ioredis event handler — an uncaught throw there would take the process down.
 * A callback that throws is likewise isolated: one bad consumer must not stop
 * the others from being told.
 */
function onMessage(channel: string, payload: string): void {
  if (channel !== INTERVENTION_CHANNEL) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    logWarn("[redis-pubsub] dropped a malformed intervention message", { channel });
    return;
  }
  if (!parsed || typeof parsed !== "object") {
    logWarn("[redis-pubsub] dropped an intervention message that was not an object", { channel });
    return;
  }

  const message = parsed as Partial<InterventionMessage>;
  if (typeof message.interventionId !== "string" || message.interventionId.length === 0) {
    logWarn("[redis-pubsub] dropped an intervention message with no intervention id", { channel });
    return;
  }
  const interventionId = message.interventionId;

  for (const callback of [...callbacks]) {
    try {
      callback(interventionId, message.data);
    } catch (err) {
      logError("[redis-pubsub] an intervention subscriber threw", {
        interventionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/* ── Public API ────────────────────────────────────────────────────────────── */

/**
 * Publish an intervention state change to every instance on the channel.
 *
 * Best-effort by contract: it resolves either way and never rejects. The caller
 * is on the intervention hot path, where the durable write has already happened
 * and a Redis fault must not be turned into a failed request.
 *
 * @param interventionId  The case/intervention this is about. Empty is refused
 *                        (a message with no routing key cannot be consumed).
 * @param data            Opaque state for other instances. Must be JSON-
 *                        serialisable; a value that is not (a cycle, a BigInt)
 *                        is reported as `{ published: false }`, not thrown.
 * @returns `published` — whether the message reached Redis. `receivers` — how
 *          many subscribers Redis fanned it out to (0 is normal when this is the
 *          only instance, and is NOT an error).
 */
export async function publishIntervention(
  interventionId: string,
  data: unknown,
): Promise<{ published: boolean; receivers: number }> {
  if (typeof interventionId !== "string" || interventionId.trim() === "") {
    logWarn("[redis-pubsub] refused to publish an intervention with an empty id");
    return { published: false, receivers: 0 };
  }
  if (!pubSubConfigured()) {
    // Single-instance / demo: there is no other process to tell. Not an error.
    logWarn("[redis-pubsub] REDIS_URL is not set — intervention published to this process only");
    return { published: false, receivers: 0 };
  }

  try {
    const client = getPublisher();
    await ensureConnected(client, "publisher");
    const message: InterventionMessage = {
      interventionId,
      data,
      ts: new Date().toISOString(),
    };
    const receivers = await client.publish(INTERVENTION_CHANNEL, JSON.stringify(message));
    return { published: true, receivers };
  } catch (err) {
    logError("[redis-pubsub] intervention publish failed", {
      interventionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { published: false, receivers: 0 };
  }
}

/**
 * Subscribe to intervention messages. Call once at process start-up.
 *
 * The subscriber connection is shared across callers: the first subscribe opens
 * it, later ones just add a callback. When Redis is not configured this still
 * returns a valid handle — an unsubscribe that simply removes the callback — so
 * a single-instance deployment and a multi-instance one run the same start-up
 * code with no branching at the call site.
 *
 * @param callback  Invoked as `(interventionId, data)` for every message. It runs
 *                  synchronously inside the ioredis event loop, so it must not
 *                  block; a throw is caught and logged, never propagated.
 * @returns A handle whose `unsubscribe()` removes this callback (and closes the
 *          connection when it was the last one).
 */
export async function subscribeToInterventions(
  callback: InterventionSubscriber,
): Promise<InterventionSubscription> {
  if (typeof callback !== "function") {
    throw new TypeError("subscribeToInterventions requires a callback function");
  }
  callbacks.add(callback);

  const unsubscribe = async (): Promise<void> => {
    callbacks.delete(callback);
    if (callbacks.size === 0) await closeSubscriber();
  };

  if (!pubSubConfigured()) {
    logWarn(
      "[redis-pubsub] REDIS_URL is not set — interventions are not synced across instances " +
        "(this process will not receive messages published by others)",
    );
    return { unsubscribe };
  }

  if (!subscribed) {
    try {
      const client = getSubscriber();
      await ensureConnected(client, "subscriber");
      // Attach the listener BEFORE subscribing so a message that arrives in the
      // same tick as the SUBSCRIBE confirmation cannot be missed.
      client.on("message", onMessage);
      await client.subscribe(INTERVENTION_CHANNEL);
      subscribed = true;
      logInfo("[redis-pubsub] subscribed to the intervention channel", {
        channel: INTERVENTION_CHANNEL,
      });
    } catch (err) {
      // Leave `subscribed` false so a later subscribe call retries; the callback
      // is already registered and will be served once a connection lands.
      logError("[redis-pubsub] subscribe failed", {
        channel: INTERVENTION_CHANNEL,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { unsubscribe };
}

/** Tear the subscriber connection down (used when the last callback leaves). */
async function closeSubscriber(): Promise<void> {
  const client = subscriber;
  subscriber = null;
  subscribed = false;
  if (!client) return;
  client.off("message", onMessage);
  try {
    await client.quit();
  } catch {
    try {
      client.disconnect();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Close both connections. Idempotent, safe to call from a shutdown handler, and
 * never rejects — the graceful-shutdown path must not be blocked by a Redis that
 * is already gone. Registered there via `closePubSub()`.
 */
export async function closePubSub(): Promise<void> {
  const clients = [subscriber, publisher].filter((c): c is Redis => c !== null);
  subscriber = null;
  publisher = null;
  subscribed = false;
  callbacks.clear();

  if (clients.length === 0) return;

  await Promise.all(
    clients.map(async (client) => {
      try {
        // QUIT flushes pending replies and closes cleanly; if the socket is
        // already broken it rejects, and disconnect() is the blunt fallback.
        await client.quit();
      } catch {
        try {
          client.disconnect();
        } catch {
          /* nothing left to close */
        }
      }
    }),
  );
  logInfo("[redis-pubsub] connections closed");
}

/**
 * Test helper: drop every callback and both connections without touching a real
 * socket beyond what is already open. Mirrors `_reset()` on the budget meter.
 */
export function _resetPubSub(): void {
  callbacks.clear();
  subscriber?.disconnect();
  publisher?.disconnect();
  subscriber = null;
  publisher = null;
  subscribed = false;
}
