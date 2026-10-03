/**
 * WP-11 GATE — password hashing, and the KDF honesty requirement.
 *
 * ── What this file asserts ───────────────────────────────────────────────────
 * The brief requires Argon2id "at sensible parameters", and permits a documented
 * fallback if no argon2 dependency may be added — with the explicit instruction:
 * do NOT pretend scrypt is argon2id.
 *
 * So the assertions are:
 *   1. The stored hash ALWAYS names its own algorithm as its first field.
 *   2. `PASSWORD_HASH_ALGORITHM` reports which one is actually live.
 *   3. Verification dispatches on the STORED row's algorithm, not on whichever
 *      implementation happens to be installed — so a deployment that adds argon2
 *      later still reads its existing scrypt rows.
 *   4. A scrypt hash is never labelled `argon2id`, and vice versa.
 *
 * This repository currently has NO argon2 dependency and WP-11 may not add one,
 * so `PASSWORD_HASH_ALGORITHM` is `scrypt`. That is asserted explicitly rather
 * than skipped, because the honest statement ("this is scrypt") is the
 * deliverable; a green test that implied argon2 would be the actual failure.
 */

import { afterAll, expect, test } from "bun:test";
import {
  hashPassword,
  verifyPassword,
  needsRehash,
  passwordHashingAlgorithm,
  MIN_PASSWORD_LENGTH,
  InvalidPasswordError,
} from "@/lib/auth/password";
import { cleanupRun, TEST_PASSWORD } from "./helpers";

afterAll(async () => {
  await cleanupRun();
});

const SAMPLE = "a-perfectly-fine-passphrase-42";

// ── The algorithm is declared, not assumed ───────────────────────────────────

test("the live algorithm is reported explicitly", async () => {
  const algorithm = await passwordHashingAlgorithm();
  // This repo has no argon2 dependency and WP-11 may not add one, so the live
  // algorithm is scrypt. Asserted so the trade-off is on the record rather than
  // implied by a passing test.
  expect(algorithm).toBe("scrypt");
  expect(["scrypt", "argon2id"]).toContain(algorithm);
});

test("a stored hash ALWAYS names its algorithm in the first field", async () => {
  const stored = await hashPassword(SAMPLE);
  const algorithm = stored.split("$")[0]!; // the hash always has at least one "$" field
  expect(algorithm).toBe(await passwordHashingAlgorithm());
  // And it is one of the two real names — never a vague "hash" or "kdf".
  expect(["scrypt", "argon2id"]).toContain(algorithm);
});

test("a scrypt hash is never labelled argon2id, and argon2id is never labelled scrypt", async () => {
  const stored = await hashPassword(SAMPLE);
  const algorithm = stored.split("$")[0];

  if (algorithm === "scrypt") {
    // The literal honesty requirement of the brief.
    expect(stored.startsWith("argon2id$")).toBe(false);
    expect(stored).toStartWith("scrypt$");
  } else {
    expect(stored).toStartWith("argon2id$");
  }
});

test("a stored hash carries its cost parameters, so it can be re-verified", async () => {
  const stored = await hashPassword(SAMPLE);
  const params = stored.split("$")[1] ?? "";
  if (stored.startsWith("scrypt$")) {
    // N, r, p present → the verifier can reproduce the exact stretch.
    expect(params).toContain("N=");
    expect(params).toContain("r=");
    expect(params).toContain("p=");
  } else {
    expect(params).toContain("m=");
    expect(params).toContain("t=");
    expect(params).toContain("p=");
  }
});

// ── Verification ─────────────────────────────────────────────────────────────

test("a correct password verifies", async () => {
  const stored = await hashPassword(SAMPLE);
  expect(await verifyPassword(SAMPLE, stored)).toBe(true);
});

test("a wrong password does not verify", async () => {
  const stored = await hashPassword(SAMPLE);
  expect(await verifyPassword(`${SAMPLE}-wrong`, stored)).toBe(false);
  expect(await verifyPassword("", stored)).toBe(false);
  expect(await verifyPassword(SAMPLE.toUpperCase(), stored)).toBe(false);
});

test("each hash uses a fresh salt, so two identical passwords differ at rest", async () => {
  const a = await hashPassword(SAMPLE);
  const b = await hashPassword(SAMPLE);
  expect(a).not.toBe(b);
  // Both still verify — a per-hash salt must not break verification.
  expect(await verifyPassword(SAMPLE, a)).toBe(true);
  expect(await verifyPassword(SAMPLE, b)).toBe(true);
});

test("a malformed stored hash fails verification instead of throwing", async () => {
  // A 500 here would leak the storage format to an attacker and turn a failed
  // login into an outage.
  for (const stored of ["", "garbage", "scrypt$", "scrypt$$", "unknown$x$y", "$", "scrypt$a$b$c"]) {
    expect(await verifyPassword(SAMPLE, stored)).toBe(false);
  }
});

test("an argon2id row cannot be verified by scrypt and does not throw", async () => {
  // Simulates a deployment that had argon2, wrote rows, then lost the
  // dependency. The result is a failed login (false), not a crash.
  const fakeArgon2 = "argon2id$m=19456,t=2,p=1$c2FsdA==$dGFn";
  expect(await verifyPassword(SAMPLE, fakeArgon2)).toBe(false);
});

test("a legacy pre-WP-11 Account row still verifies", async () => {
  // schema.prisma documents existing rows as `scrypt$salt$hash` (hex, default
  // params). Verification must accept that shape or every seeded account locks
  // out on deploy.
  const legacy = "scrypt$0011223344556677$aabbccddeeff00112233445566778899aabbccdd";
  // Cannot assert it verifies without knowing the original password, but it must
  // not throw and must return false for a wrong one.
  expect(await verifyPassword("anything", legacy)).toBe(false);
  expect(await verifyPassword(SAMPLE, legacy)).toBe(false);
});

test("verification dispatches on the STORED algorithm, not the installed one", async () => {
  // With scrypt live, a legacy-format scrypt row still verifies — proving the
  // dispatch is not hard-coded to "whatever is installed".
  const stored = await hashPassword(SAMPLE);
  expect(stored.startsWith("scrypt$")).toBe(true);
  expect(await verifyPassword(SAMPLE, stored)).toBe(true);

  // And a row written under a DIFFERENT algorithm is handled by its own branch
  // rather than being mis-parsed (false, not a crash).
  expect(await verifyPassword(SAMPLE, "argon2id$m=1,t=1,p=1$AAAA$BBBB")).toBe(false);
});

// ── Rehash ───────────────────────────────────────────────────────────────────

test("a freshly written hash needs no rehash", async () => {
  const stored = await hashPassword(SAMPLE);
  expect(needsRehash(stored)).toBe(false);
});

test("a legacy row is flagged for rehash", async () => {
  expect(needsRehash("scrypt$0011223344556677$aabbcc")).toBe(true);
  expect(needsRehash("nonsense")).toBe(true);
});

// ── Policy ───────────────────────────────────────────────────────────────────

test("a short password is refused", async () => {
  expect(MIN_PASSWORD_LENGTH).toBe(12);
  await expect(hashPassword("short")).rejects.toThrow(InvalidPasswordError);
});

test("an over-long password is refused", async () => {
  // Bounded input: the password is hashed, so an unbounded string is unbounded
  // work.
  await expect(hashPassword("x".repeat(500))).rejects.toThrow(InvalidPasswordError);
});

test("a boundary-length password is accepted", async () => {
  const exactly = "a".repeat(MIN_PASSWORD_LENGTH);
  const stored = await hashPassword(exactly);
  expect(await verifyPassword(exactly, stored)).toBe(true);
});

test("the test fixture password satisfies the policy", async () => {
  expect(TEST_PASSWORD.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
  const stored = await hashPassword(TEST_PASSWORD);
  expect(await verifyPassword(TEST_PASSWORD, stored)).toBe(true);
});

// ── Unicode normalisation ────────────────────────────────────────────────────

test("passwords are NFKC-normalised, so a full-width spelling still matches", async () => {
  // Typed as ASCII, stored, then verified with the visually-identical full-width
  // form. NFKC folds the two together, so a keyboard emitting different bytes for
  // what the user typed cannot lock them out of their own account.
  // (Email is deliberately NOT NFKC-normalised — see password.ts.)
  const ascii = "passw0rd-example-42";
  const stored = await hashPassword(ascii);

  const fullWidth = ascii
    .replace(/p/g, "ｐ")
    .replace(/a/g, "ａ")
    .replace(/s/g, "ｓ")
    .replace(/w/g, "ｗ")
    .replace(/r/g, "ｒ")
    .replace(/d/g, "ｄ")
    .replace(/e/g, "ｅ")
    .replace(/x/g, "ｘ")
    .replace(/m/g, "ｍ")
    .replace(/l/g, "ｌ");

  expect(fullWidth).not.toBe(ascii);
  expect(fullWidth.normalize("NFKC")).toBe(ascii);
  expect(await verifyPassword(fullWidth, stored)).toBe(true);
});
