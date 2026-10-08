import "server-only";

/**
 * Dead-letter helpers. Kept in a leaf module (no imports from route handlers)
 * so the route file stays small and the key-derivation rule is testable in
 * isolation.
 */

import { append as auditAppendRaw } from "@/lib/audit-chain";

/**
 * A stable DLQ idempotency key from whatever the failure callback received.
 *
 * Priority:
 *  1. the envelope's own idempotencyKey (normal path — QStash retried an
 *     envelope four times and then called us back with the same bytes),
 *  2. a hash of the raw payload bytes, so two DIFFERENT envelopes never
 *     collide on one row, and one envelope appearing twice always does.
 *
 * The hash path covers a malformed envelope: it cannot carry a valid
 * idempotencyKey, but it still must dead-letter exactly once.
 */
export function envelopeIdempotencyKeyForDlq(body: unknown): string {
  if (
    body &&
    typeof body === "object" &&
    "idempotencyKey" in body &&
    typeof (body as Record<string, unknown>).idempotencyKey === "string" &&
    ((body as Record<string, unknown>).idempotencyKey as string).length >= 4
  ) {
    return (body as { idempotencyKey: string }).idempotencyKey;
  }
  const canonical = stableStringify(body);
  return `dlq:${hash(canonical)}`;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(",")}}`;
}

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * The audit row a DLQ insert earns. Call-ref shaped so the audit chain
 * accepts it; the entity in context is the QStash message id, not a case.
 */
export async function auditAppend(entityId: string, eventType: string): Promise<void> {
  await auditAppendRaw(
    {
      callRef: entityId.slice(0, 64),
      action: "consent",
      intent: "queue_dead_lettered",
      callerId: "qstash-failure-callback",
      redactedText: `dead-lettered after retries exhausted: ${eventType}`,
      meta: { eventType, entityId },
      orgId: undefined,
    },
    { fast: true },
  );
}
