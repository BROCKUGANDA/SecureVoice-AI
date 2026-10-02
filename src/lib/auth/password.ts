import "server-only";
/**
 * Password hashing (WP-11).
 *
 * ── Intended algorithm: Argon2id ─────────────────────────────────────────────
 * Argon2id (RFC 9106) is the correct choice for this system: memory-hard, so
 * a leaked table of hashes cannot be attacked on cheap GPUs the way a
 * SHA-family or pure-CPU KDF can. Parameters below are OWASP's recommended
 * profile for Argon2id — m=19456 KiB (19 MiB), t=2, p=1, 32-byte salt,
 * 32-byte tag.
 *
 * ── What is ACTUALLY running today: scrypt, and it is not argon2id ───────────
 * WP-11 is not permitted to modify `package.json`, and neither `argon2` nor
 * `@node-rs/argon2` is a dependency of this repo. So Argon2id CANNOT be used
 * without an approved dependency change, and this module does not pretend
 * otherwise. It resolves an Argon2id implementation if one is present in
 * `node_modules` and falls back to scrypt from `node:crypto` otherwise.
 *
 *   PASSWORD_HASH_ALGORITHM reports which one is live.
 *   The algorithm is the FIRST FIELD of every stored hash, always.
 *   A scrypt hash is prefixed `scrypt$`. It is never labelled argon2id.
 *   Verification dispatches on that prefix, so a deployment that later adds
 *   argon2 reads its existing scrypt rows correctly and re-hashes on next login.
 *
 * ── Trade-off of the fallback, stated plainly ────────────────────────────────
 * scrypt is a memory-hard KDF too, and at N=2^15 / r=8 it is a defensible
 * password hash — OWASP lists scrypt among acceptable choices. The honest
 * differences from Argon2id:
 *
 *   · scrypt is sequential-memory-hard and less resistant to GPU/ASIC
 *     parallelism than Argon2id, which is memory-hard against both.
 *   · scrypt's cost parameter is a power of two and its memory use is
 *     N·r·128 bytes; the balance is coarser and less tunable than m/t/p.
 *   · Argon2id resists side-channel and timing attacks by construction
 *     (data-independent memory access). Node's scryptSync is native and
 *     constant-time with respect to the password, but this is a weaker
 *     guarantee than Argon2id gives, and it is the reason Argon2id is
 *     preferred where the dependency can be approved.
 *
 * Nothing else in the system should change because of the fallback: both are
 * memory-hard, both use a 32-byte random salt, both are verified in constant
 * time against a length-safe comparison, and neither is reversible.
 *
 * ── Format ───────────────────────────────────────────────────────────────────
 *   argon2id$m=19456,t=2,p=1$<salt-b64>$<tag-b64>
 *   scrypt$N=32768,r=8,p=1$<salt-b64>$<tag-b64>
 *   scrypt$<salt-hex>$<tag-hex>          ← legacy Account rows (pre-WP-11)
 *
 * The legacy two-field form is accepted on VERIFY only, so the pre-existing
 * `Account.passwordHash` values (documented in schema.prisma as
 * `scrypt$salt$hash`) keep working and are upgraded on next successful login.
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export type PasswordAlgorithm = "argon2id" | "scrypt";

/** OWASP-recommended Argon2id profile. */
const ARGON2_PARAMS = { m: 19456, t: 2, p: 1 } as const;
const ARGON2_SALT_BYTES = 32;
const ARGON2_TAG_BYTES = 32;

/**
 * scrypt cost. N=2^15 with r=8 costs ~32 MiB and ~100 ms — deliberately below
 * N=2^17 (128 MiB) because this codebase already stretches AUTH_SECRET-derived
 * keys with N=16384 (src/lib/privacy/crypto-shred.ts) and login sits on the
 * interactive path. Raise to 2^17 once argon2 replaces this fallback.
 */
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1 } as const;
const SCRYPT_SALT_BYTES = 32;
const SCRYPT_TAG_BYTES = 32;
const SCRYPT_MAXMEM = 96 * 1024 * 1024;

// ── Argon2id discovery ───────────────────────────────────────────────────────

type Argon2Module = {
  /** Raw bytes, because `raw: true` is passed below — the PHC string form
   *  would hide the salt/tag split this module needs to store them itself. */
  hash(plain: string, opts: Record<string, unknown>): Promise<Uint8Array | Buffer>;
  verify(digest: string, plain: string): Promise<boolean>;
};

let argon2Cache: Argon2Module | null | undefined;

/**
 * Resolve an Argon2id implementation if the dependency is installed.
 *
 * Dynamic import, cached. Returns null when neither package is present — which
 * is the current state of this repository. A failed resolution is cached too,
 * so a missing optional dependency costs one failed import per process rather
 * than one per login.
 */
async function resolveArgon2(): Promise<Argon2Module | null> {
  if (argon2Cache !== undefined) return argon2Cache;
  for (const specifier of ["argon2", "@node-rs/argon2"]) {
    try {
      const mod = (await import(specifier)) as Argon2Module & {
        default?: Argon2Module;
      };
      const candidate = typeof mod.hash === "function" ? mod : mod.default;
      if (candidate && typeof candidate.hash === "function" && typeof candidate.verify === "function") {
        argon2Cache = candidate;
        return argon2Cache;
      }
    } catch {
      // Not installed. Try the next one.
    }
  }
  argon2Cache = null;
  return null;
}

/** Which algorithm `hashPassword` will use right now. Reported, never assumed. */
export async function passwordHashingAlgorithm(): Promise<PasswordAlgorithm> {
  return (await resolveArgon2()) ? "argon2id" : "scrypt";
}

// ── Hashing ──────────────────────────────────────────────────────────────────

/**
 * Hash a password. The returned string ALWAYS names its own algorithm, so the
 * choice of KDF is a property of the stored row and not of the reader's
 * environment.
 */
export async function hashPassword(plain: string): Promise<string> {
  assertUsablePassword(plain);
  const argon2 = await resolveArgon2();
  if (argon2) {
    const salt = randomBytes(ARGON2_SALT_BYTES);
    // The node-argon2 and node-rs/argon2 option shapes agree on these names.
    const digest = await argon2.hash(plain, {
      type: 2, // argon2id
      memoryCost: ARGON2_PARAMS.m,
      timeCost: ARGON2_PARAMS.t,
      parallelism: ARGON2_PARAMS.p,
      salt,
      hashLength: ARGON2_TAG_BYTES,
      raw: true,
    });
    const b64 = (b: Buffer | Uint8Array): string => Buffer.from(b).toString("base64");
    return `argon2id$m=${ARGON2_PARAMS.m},t=${ARGON2_PARAMS.t},p=${ARGON2_PARAMS.p}$${b64(salt)}$${b64(digest)}`;
  }
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const tag = scryptSync(plain.normalize("NFKC"), salt, SCRYPT_TAG_BYTES, {
    ...SCRYPT_PARAMS,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$N=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}$${salt.toString("base64")}$${tag.toString("base64")}`;
}

// ── Verification ─────────────────────────────────────────────────────────────

type ParsedScrypt = { params: { N: number; r: number; p: number }; salt: Buffer; tag: Buffer };

function parseScrypt(stored: string): ParsedScrypt | null {
  const parts = stored.split("$");
  if (parts.length < 3) return null;
  // Legacy 3-field form: scrypt$<salt-hex>$<tag-hex>, default params (the
  // pre-WP-11 Account rows).
  if (!parts[1].includes("=")) {
    const salt = Buffer.from(parts[1], "hex");
    const tag = Buffer.from(parts[2], "hex");
    if (salt.length === 0 || tag.length === 0) return null;
    return { params: SCRYPT_PARAMS, salt, tag };
  }
  const params = Object.fromEntries(
    parts[1]
      .split(",")
      .map((kv) => kv.split("="))
      .filter((kv): kv is [string, string] => kv.length === 2)
      .map(([k, v]) => [k, Number(v)])
  ) as Partial<{ N: number; r: number; p: number }>;
  const salt = Buffer.from(parts[2] ?? "", "base64");
  const tag = Buffer.from(parts[3] ?? "", "base64");
  if (!params.N || !params.r || !params.p || salt.length === 0 || tag.length === 0) return null;
  return { params: { N: params.N, r: params.r, p: params.p }, salt, tag };
}

/**
 * Verify a password against a stored hash.
 *
 * Dispatches on the stored row's own algorithm prefix — never on which
 * implementation happens to be installed. A deployment that adds argon2 keeps
 * verifying its existing scrypt rows, and a row written under argon2id still
 * verifies if argon2 is later removed (it returns false rather than throwing,
 * so the failure is a failed login, not a 500 that reveals the algorithm).
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (typeof plain !== "string" || typeof stored !== "string" || plain === "" || stored === "") {
    return false;
  }
  const separator = stored.indexOf("$");
  if (separator < 0) return false;
  const algorithm = stored.slice(0, separator);
  try {
    if (algorithm === "argon2id") {
      const argon2 = await resolveArgon2();
      if (!argon2) return false; // Cannot check an argon2id row without argon2.
      return await argon2.verify(stored, plain.normalize("NFKC"));
    }
    if (algorithm === "scrypt") {
      const parsed = parseScrypt(stored);
      if (!parsed) return false;
      const candidate = scryptSync(plain.normalize("NFKC"), parsed.salt, parsed.tag.length, {
        N: parsed.params.N,
        r: parsed.params.r,
        p: parsed.params.p,
        // maxmem scales with N·r so a stronger stored row still verifies.
        maxmem: Math.max(SCRYPT_MAXMEM, parsed.params.N * parsed.params.r * 256),
      });
      // Constant-time, and length-safe: a wrong-length digest must be a failed
      // login, not a thrown TypeError.
      return (
        candidate.length === parsed.tag.length && timingSafeEqual(candidate, parsed.tag)
      );
    }
    return false;
  } catch {
    // A malformed stored hash is a failed verification, never a 500.
    return false;
  }
}

/**
 * True when a stored scrypt row predates WP-11's parameter block and should be
 * re-hashed on the next successful login.
 */
export function needsRehash(stored: string): boolean {
  const separator = stored.indexOf("$");
  if (separator < 0) return true;
  const algorithm = stored.slice(0, separator);
  const params = stored.slice(separator + 1).split("$")[0] ?? "";
  if (algorithm === "argon2id") {
    return (
      !params.includes(`m=${ARGON2_PARAMS.m}`) ||
      !params.includes(`t=${ARGON2_PARAMS.t}`) ||
      !params.includes(`p=${ARGON2_PARAMS.p}`)
    );
  }
  if (algorithm === "scrypt") {
    return !params.includes(`N=${SCRYPT_PARAMS.N}`) || !params.includes(`r=${SCRYPT_PARAMS.r}`);
  }
  return true;
}

// ── Policy ───────────────────────────────────────────────────────────────────

/**
 * A password long enough to be worth storing. Length is the property that
 * actually resists guessing; composition rules mostly produce "Password1!".
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

export function assertUsablePassword(plain: string): void {
  if (typeof plain !== "string") {
    throw new InvalidPasswordError("Password must be a string.");
  }
  if (plain.length < MIN_PASSWORD_LENGTH) {
    throw new InvalidPasswordError(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
    );
  }
  if (plain.length > MAX_PASSWORD_LENGTH) {
    // Bounded input: scrypt's memory use is fixed, but the password itself is
    // hashed, so an unbounded string is unbounded work.
    throw new InvalidPasswordError(`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
}

export class InvalidPasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPasswordError";
  }
}

/**
 * Normalise an email for lookup and for binding an invite.
 *
 * Lowercased and trimmed. Deliberately NOT Unicode-normalised to NFKC: email
 * local parts are case-sensitive per RFC 5321 and providers are inconsistent,
 * so aggressive folding can merge two addresses a provider treats as distinct.
 * Case-folding only is the behaviour every mainstream provider implements.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function isValidEmail(email: string): boolean {
  return typeof email === "string" && email.length <= 254 && EMAIL_RE.test(email);
}