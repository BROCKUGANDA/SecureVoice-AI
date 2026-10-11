/**
 * The PII vault must vault.
 *
 * `storePii()` used to insert its `plaintext` argument straight into a column
 * called `encryptedValue`, with a header comment deferring the real encryption to
 * "in production". Every reader after it — reviewer, integrator, auditor — would
 * take the column name as a fact about the data at rest. These checks hold the
 * two properties the name promises: what is stored is ciphertext, and a token
 * only resolves for the tenant that stored it.
 *
 *   bun test tests/privacy/pii-vault.test.ts
 */
import { afterAll, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { resolvePii, storePii } from "@/lib/compliance/pii-vault";

// Sealing key for this suite only. The vault refuses without one, so a suite
// that wants to prove it encrypts has to bring a key — and a fixed test key is
// never the one a deployment uses.
process.env.AUTH_SECRET = "pii-vault-suite-key-0123456789abcdef0123456789abcdef";

const ORG = "aaaaaaaa-1111-4111-8111-000000000001";
const OTHER_ORG = "aaaaaaaa-1111-4111-8111-000000000002";
const PHONE = "+971501234567";
const RUN = Date.now().toString(36);

const tokens: string[] = [];

async function sealed(token: string): Promise<string> {
  const rows = await db.$queryRaw<{ encryptedValue: string }[]>`
    SELECT "encryptedValue" FROM "pii_vault" WHERE "token" = ${token} LIMIT 1
  `;
  return rows[0]?.encryptedValue ?? "";
}

afterAll(async () => {
  // One bound parameter per row: `$executeRaw` interpolates safely, so a joined
  // string inside `IN (...)` would be one value, not a list.
  for (const token of tokens) {
    await db.$executeRaw`
      DELETE FROM "pii_vault" WHERE "token" = ${token}
    `;
  }
}, 60_000);

test("what lands in encryptedValue is not the value", async () => {
  const token = await storePii({ orgId: ORG, type: "phone", plaintext: PHONE });
  tokens.push(token);
  const stored = await sealed(token);
  expect(stored).not.toContain(PHONE);
  expect(stored).not.toBe(PHONE);
  // iv.tag.ciphertext — the AES-256-GCM envelope `src/lib/byok.ts` produces.
  const parts = stored.split(".");
  expect(parts.length).toBe(3);
  expect(parts[2]?.length).toBeGreaterThan(0);
});

test("the owning org gets its value back", async () => {
  const token = await storePii({ orgId: ORG, type: "name", plaintext: "Amina Okello" });
  tokens.push(token);
  expect(await resolvePii(token, ORG)).toBe("Amina Okello");
});

test("a token is not an authorisation — another org resolves nothing", async () => {
  const token = await storePii({ orgId: ORG, type: "pan", plaintext: "4111111111111111" });
  tokens.push(token);
  expect(await resolvePii(token, OTHER_ORG)).toBe(null);
  // The cross-tenant read the previous signature allowed: token alone.
  const rows = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM "pii_vault" WHERE "token" = ${token} AND "orgId" = ${OTHER_ORG}
  `;
  expect(rows[0]?.n).toBe(0);
});

test("an empty value is refused, not vaulted", async () => {
  await expect(storePii({ orgId: ORG, type: "phone", plaintext: "   " })).rejects.toThrow(
    /refuses to vault an empty/,
  );
});

test("an unscoped row is refused", async () => {
  await expect(storePii({ orgId: "", type: "phone", plaintext: PHONE })).rejects.toThrow(/orgId/);
});

test("resolve with no org scope returns nothing rather than guessing", async () => {
  const token = `nope-${RUN}`;
  expect(await resolvePii(token, "")).toBe(null);
  expect(await resolvePii("", ORG)).toBe(null);
});

test("no sealing key means no write — it does not fall back to plaintext", async () => {
  const prior = process.env.AUTH_SECRET;
  delete process.env.AUTH_SECRET;
  try {
    await expect(storePii({ orgId: ORG, type: "phone", plaintext: PHONE })).rejects.toThrow(
      /AUTH_SECRET/,
    );
  } finally {
    process.env.AUTH_SECRET = prior;
  }
});
