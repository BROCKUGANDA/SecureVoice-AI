/**
 * PII vault service.
 *
 * Sensitive values are stored by token reference so a row that needs to point at
 * a phone number or a name can hold the token instead of the value.
 *
 * ── What this column is ──────────────────────────────────────────────────────
 * `encryptedValue` is encrypted. It used to be a lie: `storePii()` wrote
 * `params.plaintext` straight into it, so the table named for protection held
 * readable PII, and the header comment deferred the actual encryption to "in
 * production" — the same move that turns a documented gap into an undocumented
 * one, because every reader after it believes the column means what it says.
 *
 * Values are sealed with the same AES-256-GCM path BYOK keys use
 * (`src/lib/byok.ts`), derived from `AUTH_SECRET`. Without that secret the vault
 * refuses: storing plaintext because the key is missing is exactly the failure
 * the table exists to prevent, so it throws instead.
 *
 * ── Tenant boundary ──────────────────────────────────────────────────────────
 * Resolution is scoped to the org that stored the value. A token is a random
 * uuid, not an authorisation: resolving on the token alone meant any caller with
 * any token could read another tenant's customer, which is the cross-tenant read
 * the rest of the platform is built to refuse.
 */

import { db } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/byok";

export type PiiType = "phone" | "name" | "pan" | "address";

/**
 * Seal one value and return the token that points at it.
 * @throws when `AUTH_SECRET` is unset, or the value is empty — never writes
 *         plaintext, and never mints a token for nothing.
 */
export async function storePii(params: {
  orgId: string;
  type: PiiType;
  plaintext: string;
}): Promise<string> {
  const value = params.plaintext?.trim();
  if (!params.orgId)
    throw new Error(
      "storePii requires an orgId — an unscoped vault row is readable by nobody and correctable by nobody",
    );
  if (!value) throw new Error(`storePii refuses to vault an empty ${params.type}`);

  // Throws if AUTH_SECRET is missing. That is the intended behaviour: the
  // alternative is a vault that stores the thing it is meant to protect.
  const sealed = encryptSecret(value);
  const token = crypto.randomUUID();
  await db.$executeRaw`
    INSERT INTO "pii_vault" ("token", "orgId", "encryptedValue", "type")
    VALUES (${token}, ${params.orgId}, ${sealed}, ${params.type})
  `;
  return token;
}

/**
 * Resolve a token back to its value, for the org that stored it.
 * @returns the plaintext, or null when the token is unknown, belongs to another
 *          org, or no longer decrypts (an `AUTH_SECRET` rotation).
 */
export async function resolvePii(token: string, orgId: string): Promise<string | null> {
  if (!token || !orgId) return null;
  const rows = await db.$queryRaw<{ encryptedValue: string }[]>`
    SELECT "encryptedValue"
    FROM "pii_vault"
    WHERE "token" = ${token}
      AND "orgId" = ${orgId}
    LIMIT 1
  `;
  const sealed = rows[0]?.encryptedValue;
  if (!sealed) return null;
  return decryptSecret(sealed);
}

/**
 * Resolve a Case row's destination phone number.
 *
 * Tokenized rows (everything written since the vault went live) resolve through
 * the vault under the row's own org; rows created before tokenization carry the
 * legacy raw `phone` column and resolve from it until they age out. A token that
 * resolves to nothing (another org's row, or a secret rotation) falls back to the
 * legacy column when one exists, and to null otherwise — the dial path treats
 * null as "no destination" and fails closed, so a rotation never dials a stale
 * or wrong number.
 */
export async function resolveCasePhone(
  row: { customerPhoneToken?: string | null; phone?: string | null } | null | undefined,
  orgId?: string | null,
): Promise<string | null> {
  if (row?.customerPhoneToken) {
    const resolved = await resolvePii(row.customerPhoneToken, orgId ?? "");
    if (resolved) return resolved;
  }
  return row?.phone ?? null;
}
