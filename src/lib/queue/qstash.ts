import "server-only";

/**
 * Upstash QStash as the retry-aware dispatch layer in front of the existing
 * worker functions. It is not a replacement for the Postgres queues — DialJob
 * and OutboxEvent remain the durable record — QStash is what makes the
 * synchronous request path non-owning: POST /api/v1/interventions ACKs the
 * bank, then QStash calls us back to actually dial, so the bank never sees a
 * 30s carrier round-trip and its retry storm never reaches our carrier
 * accounts.
 *
 * The dead-letter contract lives here: a message that exhausts QStash's
 * built-in retries is POSTed to `failureCallback`, which writes the envelope
 * into DeadLetter. Without this, a permanently failing QStash message would
 * still exist as a QStash dashboard line that nobody reads.
 */

import { Client } from "@upstash/qstash";
import type { JobEnvelope } from "./envelope";

export const QSTASH_TOKEN = process.env.QSTASH_TOKEN ?? "";
export const DISPATCH_PATH = "/api/queue/dispatch";
export function dispatchPath(): string {
  return process.env.QSTASH_DISPATCH_PATH ?? DISPATCH_PATH;
}

export function qstashConfigured(): boolean {
  return QSTASH_TOKEN.length > 20;
}

export function qstashClient(): Client {
  if (!qstashConfigured()) {
    throw new Error("QSTASH_TOKEN is not configured — set it in .env");
  }
  return new Client({ token: QSTASH_TOKEN });
}

export function appBaseUrl(): string {
  const explicit = process.env.QUEUE_PUBLIC_URL ?? process.env.BETTER_AUTH_URL;
  if (explicit && explicit.trim()) return explicit.replace(/\/$/, "");
  return "http://localhost:3000";
}

export const FAILURE_CALLBACK_PATH = "/api/queue/dead-letter";

/**
 * Publish a job envelope to the QStash dispatch route for its kind.
 *
 * Every publish sets:
 *  - `retries` — bounded, because a carrier failure loop is not a reason to
 *    retry forever (that would still be a call storm against a real phone).
 *  - `failureCallback` — the DLQ path above. Exhausted retries persist, not
 *    vanish.
 *  - `deduplicationId` — from the envelope's idempotencyKey. QStash stores
 *    the key for as long as its window holds, so a producer retry cannot
 *    enqueue the same case twice.
 */
export async function publishEnvelope(
  envelope: JobEnvelope,
  workerPath: string,
): Promise<{
  messageId: string;
}> {
  const client = qstashClient();
  const url = `${appBaseUrl()}${workerPath}`;
  const result = await client.publishJSON({
    url,
    body: envelope,
    retries: 4,
    deduplicationId: envelope.idempotencyKey,
    failureCallback: `${appBaseUrl()}${FAILURE_CALLBACK_PATH}`,
  });
  // The API returns different shapes per target; a publish to a URL always
  // yields a single message id, never a group or a schedule id.
  if ("messageId" in result) return { messageId: result.messageId };
  throw new Error("QStash returned an unexpected publish result");
}
