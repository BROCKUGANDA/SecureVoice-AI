/**
 * The seed writes a password hash directly into `account.password`, so the only
 * proof that matters is whether Better Auth's OWN verifier accepts it.
 *
 * Before 2026-10-10 the seed wrote `scrypt$16384$8$1$<b64salt>$<b64hash>`.
 * Better Auth 1.7.7's `verifyPassword` does `hash.split(":")` and throws
 * `Invalid password hash` when there is no colon — so the one-click demo login
 * 500'd even though the user existed. These specs pin the fixed shape
 * (`<salt>:<hexkey>`) against the real library, and also pin the parameters,
 * because a hash that is well-formed but derived with the wrong r is still
 * rejected, just more quietly.
 */
import { describe, expect, test } from "bun:test";
import { scryptSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const SCRIPT = new URL("../../scripts/seed-demo.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** The exact derivation the seed now performs. */
function seedHash(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const key = scryptSync(password.normalize("NFKC"), salt, 64, {
    N: 16384,
    r: 16,
    p: 1,
    // OpenSSL defaults to 32 MB; N=16384/r=16 needs ~134 MB, so this is
    // mandatory rather than a tuning knob.
    maxmem: 128 * 16384 * 16 * 2,
  }).toString("hex");
  return `${salt}:${key}`;
}

describe("the seed's password hash is one Better Auth will verify", () => {
  test("has the <salt>:<hexkey> shape the verifier splits on", () => {
    const hash = seedHash("DemoPass123!");
    const [salt, key, ...rest] = hash.split(":");
    expect(salt).toBeDefined();
    expect(key).toBeDefined();
    expect(rest).toHaveLength(0); // exactly one colon
    expect(salt).toMatch(/^[0-9a-f]+$/);
    expect(key).toMatch(/^[0-9a-f]+$/);
    // dkLen 64 bytes -> 128 hex chars.
    expect(key).toHaveLength(128);
  });

  test("verifies against Better Auth's own verifier", async () => {
    const { verifyPassword } = await import("@better-auth/utils/password");
    const password = "DemoPass123!";
    const hash = seedHash(password);
    // Must not throw ("Invalid password hash") and must not merely return false.
    await expect(verifyPassword(hash, password)).resolves.toBe(true);
  });

  test("rejects the wrong password, so it is not accepting everything", async () => {
    const { verifyPassword } = await import("@better-auth/utils/password");
    const hash = seedHash("DemoPass123!");
    await expect(verifyPassword(hash, "wrong-password")).resolves.toBe(false);
  });

  test("the seed source no longer writes the legacy $-delimited format", () => {
    const src = readFileSync(SCRIPT, "utf8");
    // The literal that produced the unverifiable hash.
    expect(src).not.toContain("scrypt$16384$8$1$");
    // And it does carry the corrected parameters.
    expect(src).toContain("r: 16");
  });
});
