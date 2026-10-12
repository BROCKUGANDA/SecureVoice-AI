import "server-only";

import { PostHog } from "posthog-node";

const POSTHOG_KEY = process.env.POSTHOG_KEY ?? "";
const POSTHOG_HOST = process.env.POSTHOG_HOST ?? "https://us.i.posthog.com";

/**
 * Server-side PostHog singleton.
 *
 * Initialised lazily so that importing this module in a context where
 * PostHog is not configured (e.g. local dev without env vars) does not
 * throw. The instance is a no-op when POSTHOG_KEY is unset, so callers
 * can capture unconditionally.
 */
let client: PostHog | null = null;

export function getPostHog(): PostHog | null {
  if (!POSTHOG_KEY) return null;

  if (!client) {
    client = new PostHog(POSTHOG_KEY, {
      host: POSTHOG_HOST,
      // Batch events and flush every 10s or 20 events — whichever comes first.
      // This keeps event capture off the hot path of request handling.
      flushAt: 20,
      flushInterval: 10_000,
    });
  }

  return client;
}

/**
 * Capture a server-side event. Safe to call unconditionally — when
 * PostHog is not configured this is a no-op.
 */
export function captureServerEvent(
  distinctId: string,
  event: string,
  properties?: Record<string, unknown>,
): void {
  const ph = getPostHog();
  if (!ph) return;

  try {
    ph.capture({ distinctId, event, properties });
  } catch {
    // Analytics must never break the request path.
  }
}

/**
 * Shutdown the PostHog client — flushes pending events. Called from
 * graceful-shutdown hooks.
 */
export async function shutdownPostHog(): Promise<void> {
  if (!client) return;
  await client.shutdown();
  client = null;
}

export { POSTHOG_KEY, POSTHOG_HOST };
