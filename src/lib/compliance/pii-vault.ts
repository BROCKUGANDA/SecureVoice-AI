/**
 * PII vault service.
 *
 * Stores sensitive values by token reference only. The main `interventions`
 * table stores a token; the plaintext never lives there.
 *
 * In production, `encrypted_value` should be encrypted at rest via
 * application-level encryption or Postgres pgp_sym_encrypt. This module
 * only defines the storage boundary and token API.
 */

import { db } from "@/lib/db";

export type PiiType = "phone" | "name" | "pan" | "address";

export async function storePii(params: {
  orgId: string;
  type: PiiType;
  plaintext: string;
}): Promise<string> {
  const token = crypto.randomUUID();
  await db.$executeRaw`
    INSERT INTO "pii_vault" ("token", "orgId", "encryptedValue", "type")
    VALUES (${token}, ${params.orgId}, ${params.plaintext}, ${params.type})
  `;
  return token;
}

export async function resolvePii(token: string): Promise<string | null> {
  const rows = await db.$queryRaw<{ encryptedValue: string }[]>`
    SELECT "encryptedValue"
    FROM "pii_vault"
    WHERE "token" = ${token}
    LIMIT 1
  `;
  return rows[0]?.encryptedValue ?? null;
}
