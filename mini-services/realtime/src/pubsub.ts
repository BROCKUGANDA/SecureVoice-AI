/**
 * Cross-instance fan-out for the realtime service (WP-20 sprint slice).
 *
 * The hazard this file exists to prevent: run two replicas behind a
 * round-robin proxy with no shared bus, and a client connected to node A never
 * sees an event ingested into node B. Nothing errors. The console simply goes
 * quiet, and an operator watching a live fraud call cannot tell the difference
 * between "no news" and "broken news". This is the most common realtime scaling
 * bug, and it is silent by construction.
 *
 * So: when REDIS_URL is configured, every instance joins a Socket.IO Redis
 * adapter and broadcasts propagate across nodes. When it is NOT configured,
 * the service starts anyway and says so loudly — a single-node deployment is a
 * legitimate deployment, but it must never pretend to be multi-node.
 *
 * The transport is deliberately websocket-only in this configuration: the
 * polling->websocket upgrade breaks under round-robin unless Caddy pins the
 * session, and a silent downgrade mid-call is worse than a failed connect.
 */

import { createAdapter } from "@socket.io/redis-adapter";
import { createClient, type RedisClientType } from "redis";
import type { Server } from "socket.io";

export type PubSub = {
  mode: "redis" | "single-node";
  detail: string;
  close: () => Promise<void>;
};

export function redisUrl(): string | null {
  const url = process.env.REDIS_URL?.trim();
  return url ? url : null;
}

/**
 * Attach the Redis adapter when configured. Returns a description of what was
 * actually done so /readyz can report it truthfully.
 */
export async function attachPubSub(io: Server): Promise<PubSub> {
  const url = redisUrl();
  if (!url) {
    const detail =
      "REDIS_URL not set - single-instance fan-out only. Run more than one replica only after setting it, " +
      "or events ingested into one instance will never reach clients on another.";
    console.warn(`[realtime] ${detail}`);
    return { mode: "single-node", detail, close: async () => {} };
  }

  // Duplicate connections: one for pub, one for sub. Sharing a client between
  // the two roles is the classic cause of silently dropped broadcasts.
  const pubClient = createClient({ url }) as RedisClientType;
  const subClient = pubClient.duplicate() as RedisClientType;
  for (const [name, client] of [
    ["pub", pubClient],
    ["sub", subClient],
  ] as const) {
    client.on("error", (err: unknown) => console.error(`[realtime] redis ${name} error:`, err));
  }

  try {
    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    const detail = `redis adapter attached (${new URL(url).host}) - broadcasts propagate across replicas`;
    console.log(`[realtime] ${detail}`);
    return {
      mode: "redis",
      detail,
      close: async () => {
        await Promise.allSettled([pubClient.quit(), subClient.quit()]);
      },
    };
  } catch (err) {
    await Promise.allSettled([pubClient.quit().catch(() => {}), subClient.quit().catch(() => {})]);
    // Refuse to start rather than serve a silently-broken multi-node service.
    throw new Error(`[realtime] REDIS_URL is set but unreachable: ${String(err)}`);
  }
}
