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
 *
 * ── The blind index, and why there are two ───────────────────────────────────
 * A random token is unfindable: `storePii` mints one and only `resolvePii` reads
 * it, so nothing could ask the vault "do you already hold this number?". That is
 * what kept `Case.phone` in plaintext — an inbound SMS reply and an inbound voice
 * callback arrive carrying a customer's number and NO tenant, so they could only
 * match their case on the readable column.
 *
 * `blindIndexOf(type, value, scope?)` is HMAC-SHA256 under a key derived from
 * `AUTH_SECRET` in its own domain (`sv-blind:`), separate from the sealing key:
 * an index that could be derived from the ciphertext key would let a leaked
 * database decrypt nothing yet still confirm guesses about who banks here.
 *
 *   · the vault's own index includes the ORG. It exists to dedupe within a
 *     tenant, and an org-scoped message means the same customer hashes
 *     differently in every tenant, so the table cannot be used to discover that
 *     one person banks at two of them;
 *   · `Case.phoneIndex` deliberately OMITS the org, because the two lookups above
 *     have no tenant to hash in. That trades a pseudonym grouping — available to a
 *     reader who already had the numbers in the clear, row by row — for not
 *     storing the number at all. See the column comment in prisma/schema.prisma.
 */

import { createHash, createHmac } from "crypto";

import { db } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/byok";
import { logWarn } from "@/lib/validation/safe-log";

export type PiiType = "phone" | "name" | "pan" | "address";

function blindKey(): Buffer {
  // Same discipline as `byokKey()`: never fall back to a constant. An index whose
  // key is guessable is an index an attacker can precompute for every number in
  // the world.
  const base = process.env.AUTH_SECRET;
  if (!base) {
    throw new Error(
      "AUTH_SECRET is required to index a vault value — refusing to derive a searchable identifier under a guessable key.",
    );
  }
  return createHash("sha256").update(`sv-blind:${base}`).digest();
}

/**
 * The form a value is hashed in, so a lookup succeeds on a spelling difference
 * rather than failing silently.
 *
 * Phone is the only type with a matching path today (a customer's number arrives
 * from Twilio's `From`, and the number went out from the ingest payload), and
 * inbound E.164 validation means both sides are already canonical — the
 * normalisation is what keeps that true for a human-entered `+971 50 123 4567`.
 */
export function normalizePiiValue(type: PiiType, value: string): string {
  const trimmed = value.trim();
  if (type !== "phone") return trimmed;
  const digits = trimmed.replace(/[^\d+]/g, "");
  // A number with no digits in it is not a number: returning "+" here would seal
  // and index a punctuation mark, and `storePii`'s empty-value refusal would pass
  // on a value that only looks empty once the separators are stripped.
  if (!digits.replace("+", "")) return "";
  return digits.startsWith("+") ? digits : `+${digits}`;
}

/**
 * HMAC index of a value. Throws when `AUTH_SECRET` is missing — an unkeyed index
 * over PII is a pseudonym anyone can compute, which is not a protection.
 */
export function blindIndexOf(type: PiiType, plaintext: string, scope?: string): string {
  const normalized = normalizePiiValue(type, plaintext);
  if (!normalized) throw new Error(`blindIndexOf: empty ${type}`);
  return createHmac("sha256", blindKey())
    .update(`${scope ?? ""}|${type}|${normalized}`)
    .digest("hex");
}

/**
 * Seal one value and return the token that points at it.
 *
 * Idempotent per tenant: sealing the same value twice for the same org returns the
 * token of the row that already exists rather than accumulating a vault row per
 * case. The `ON CONFLICT … DO UPDATE` is a no-op write whose purpose is to make
 * `RETURNING` yield the existing token — the alternative, read-then-insert, is the
 * check-then-act race two concurrent signals would hit.
 *
 * @throws when `AUTH_SECRET` is unset, or the value is empty — never writes
 *         plaintext, and never mints a token for nothing.
 */
export async function storePii(params: {
  orgId: string;
  type: PiiType;
  plaintext: string;
}): Promise<string> {
  const value = normalizePiiValue(params.type, params.plaintext ?? "");
  if (!params.orgId)
    throw new Error(
      "storePii requires an orgId — an unscoped vault row is readable by nobody and correctable by nobody",
    );
  if (!value) throw new Error(`storePii refuses to vault an empty ${params.type}`);

  // Throws if AUTH_SECRET is missing. That is the intended behaviour: the
  // alternative is a vault that stores the thing it is meant to protect.
  const sealed = encryptSecret(value);
  const index = blindIndexOf(params.type, value, params.orgId);
  const token = crypto.randomUUID();
  const rows = await db.$queryRaw<{ token: string }[]>`
    INSERT INTO "pii_vault" ("token", "orgId", "encryptedValue", "type", "blindIndex")
    VALUES (${token}, ${params.orgId}, ${sealed}, ${params.type}, ${index})
    ON CONFLICT ("orgId", "type", "blindIndex")
    DO UPDATE SET "orgId" = EXCLUDED."orgId"
    RETURNING "token"
  `;
  const won = rows[0]?.token;
  if (!won) throw new Error(`storePii: the ${params.type} row was neither inserted nor returned`);
  return won;
}

/**
 * The token this org already holds for a value, or null when it holds none.
 * Does not seal, and does not create.
 */
export async function tokenForPii(params: {
  orgId: string;
  type: PiiType;
  plaintext: string;
}): Promise<string | null> {
  if (!params.orgId) return null;
  let index: string;
  try {
    index = blindIndexOf(params.type, params.plaintext, params.orgId);
  } catch {
    return null;
  }
  const rows = await db.$queryRaw<{ token: string }[]>`
    SELECT "token" FROM "pii_vault"
    WHERE "orgId" = ${params.orgId} AND "type" = ${params.type} AND "blindIndex" = ${index}
    LIMIT 1
  `;
  return rows[0]?.token ?? null;
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
 * The columns a case row should carry for one destination number.
 *
 * When the value can be sealed, the row holds the token and the match index and
 * NO readable number. When it cannot — no tenant to store it under, or no
 * `AUTH_SECRET` to seal and index it with — the number stays on the row, because
 * the alternative is a case with no destination: the dial path fails closed on a
 * null resolve and a fraud alert never reaches its customer. Such a row is
 * visibly un-tokenized (`customerPhoneToken IS NULL`), so nothing about it claims
 * a protection it did not get, and the backfill script counts it.
 */
export async function vaultCasePhone(args: {
  orgId?: string | null;
  phone?: string | null;
}): Promise<{
  phone: string | null;
  phoneIndex: string | null;
  customerPhoneToken: string | null;
}> {
  const raw = args.phone?.trim();
  if (!raw) return { phone: null, phoneIndex: null, customerPhoneToken: null };
  try {
    const phoneIndex = blindIndexOf("phone", raw);
    const customerPhoneToken = args.orgId
      ? await storePii({ orgId: args.orgId, type: "phone", plaintext: raw })
      : null;
    return {
      phone: customerPhoneToken ? null : normalizePiiValue("phone", raw),
      phoneIndex,
      customerPhoneToken,
    };
  } catch (err) {
    logWarn("[pii-vault] destination not sealed — the case keeps the raw number", {
      orgId: args.orgId ?? null,
      error: err instanceof Error ? err.message : String(err),
    });
    return { phone: raw, phoneIndex: null, customerPhoneToken: null };
  }
}

/**
 * Match cases addressed by this number, whether they are vaulted or legacy.
 *
 * `phoneIndex` is the lookup that works once the plaintext column is cleared; the
 * `phone` arm keeps rows the backfill has not reached answerable.
 *
 * Production reached `pending: 0` on 2026-10-19 — 847 raw rows became 22 sealed
 * rows plus 825 cleared ones — so no case holds a number the index cannot answer.
 * The arm stays anyway, and §42's exit condition was incomplete rather than met:
 * the `catch` below leaves this OR with a single member when `AUTH_SECRET` is
 * absent, and deleting the arm would make a keyless deployment match nothing at
 * all. A rotation or a keyless staging box is the case this arm still serves.
 */
export function casePhoneWhere(plaintext: string): Record<string, unknown> {
  const arms: Record<string, unknown>[] = [];
  try {
    arms.push({ phoneIndex: blindIndexOf("phone", plaintext) });
  } catch {
    // No key: only rows that still hold the number can answer.
  }
  arms.push({ phone: plaintext });
  return { OR: arms };
}

/**
 * Resolve a Case row's destination phone number.
 *
 * Tokenized rows resolve through the vault under the row's own org; rows created
 * before tokenization carry the legacy raw `phone` column and answer from it until
 * the backfill reaches them. A token that resolves to nothing (another org's row,
 * or a secret rotation) falls back to the legacy column when one exists, and to
 * null otherwise — the dial path treats null as "no destination" and fails closed,
 * so a rotation never dials a stale or wrong number.
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
