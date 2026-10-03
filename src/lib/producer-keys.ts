import "server-only";
/**
 * Producer API keys — headless machine auth for the /api/interventions ingest.
 * A bank's fraud engine can authenticate either with an HMAC signature
 * (shared WEBHOOK_SECRET) or with its own Bearer key (`svb_…`), scoped to the
 * org it fires signals for. Plaintext keys are shown exactly once; only the
 * SHA-256 hash is stored.
 */

import { createHash, randomBytes } from "crypto";
import { db } from "@/lib/db";

export function generateProducerKey(): string {
  return `svb_${randomBytes(24).toString("hex")}`;
}

export function hashProducerKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export type ProducerAuth =
  { ok: true; callerId: string; orgId: string | null; keyId: string } | { ok: false };

/** Verify a Bearer svb_ key against the stored hashes. */
export async function verifyProducerKey(bearer: string | null): Promise<ProducerAuth> {
  if (!bearer || !bearer.startsWith("svb_")) return { ok: false };
  const row = await db.producerKey.findUnique({
    where: { keyHash: hashProducerKey(bearer) },
    select: { id: true, orgId: true, revoked: true },
  });
  if (!row || row.revoked) return { ok: false };
  // fire-and-forget last-used stamp — never blocks the request path
  void db.producerKey
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});
  return { ok: true, callerId: `pk:${row.id.slice(0, 12)}`, orgId: row.orgId, keyId: row.id };
}
