import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Invariants for the password-reset path and the email outbox.
 *
 * These are SOURCE-level guards, not behavioural tests: the reset flow is
 * defined by properties that are easy to break with an innocuous-looking edit
 * and impossible to notice until a sign-in link stops arriving or a credential
 * leaks into a log. The magic-link module carries the same kind of reasoning,
 * so these mirror its hazards.
 *
 * The behavioural half (mint → deliver → redeem) needs a live Postgres and is
 * covered by the DB-backed suite; see the module header for why this file reads
 * the source instead.
 */

const RESET = "src/lib/auth/password-reset.ts";
const RESET_ROUTE = "src/app/api/auth/reset/route.ts";
const EMAIL_OUTBOX = "src/lib/email/outbox.ts";
const QUEUE = "src/lib/email/queue.ts";
const INVITES_ROUTE = "src/app/api/auth/invites/route.ts";

const read = (path: string) => readFileSync(path, "utf8");

describe("password reset", () => {
  test("mints a 256-bit random token, not a guessable id", () => {
    const src = read(RESET);
    expect(src).toContain("randomBytes(32)");
    expect(src).toContain("base64url");
  });

  test("stores only the hash of the token, never the token itself", () => {
    const src = read(RESET);
    // The put() call must key on hashResetToken(token), not the raw token.
    expect(src).toMatch(/put\(\s*AUTH_SCOPES\.passwordReset,\s*hashResetToken\(token\)/);
  });

  test("consumes the token in a SEPARATE scope from the token row", () => {
    const src = read(RESET);
    // Conflating them would make redemption a no-op, because the token row
    // already exists from issuance. This is the same defect magicLinkConsumed
    // exists to avoid.
    expect(src).toContain("AUTH_SCOPES.passwordResetConsumed");
    expect(src).not.toMatch(/take\(\s*AUTH_SCOPES\.passwordReset,/);
  });

  test("burns a constant-time comparison on an unknown token", () => {
    const src = read(RESET);
    // Without this, a miss returns faster than a hit and the endpoint leaks
    // which tokens were ever issued.
    expect(src).toContain("timingSafeEqual");
  });

  test("returns the same neutral answer for every outcome", () => {
    const route = read(RESET_ROUTE);
    // A differing status for "registered" vs "not registered" turns this into an
    // account oracle for bank staff addresses.
    expect(route).toContain("status: 202");
    expect(route).not.toMatch(/status: 404/);
    // The neutral message must be returned regardless of whether an identity
    // was found, so the `if (identity)` block must not alter the response.
    expect(route).toMatch(/if \(identity\) \{[\s\S]*?\n  \}/);
  });
});

describe("email outbox", () => {
  test("claims with SKIP LOCKED and re-asserts state (compare-and-set)", () => {
    const src = read(EMAIL_OUTBOX);
    // SKIP LOCKED alone is not a claim: two workers can both select the same id
    // across statements and both send a single-use credential.
    expect(src).toContain("FOR UPDATE SKIP LOCKED");
    expect(src).toContain("RETURNING");
    // The CAS re-check on the UPDATE's own WHERE.
    expect(src).toMatch(/AND \(\s*\(e\.state = 'PENDING'/);
  });

  test("never persists the token in the queued payload", () => {
    const queue = read(QUEUE);
    // A queued row outlives the token TTL; a stored token is a live credential.
    expect(queue).toContain("delete (persistable as Record<string, unknown>).token");
  });

  test("writes the durable row BEFORE attempting the provider send", () => {
    const queue = read(QUEUE);
    const enqueueAt = queue.indexOf("await enqueueEmail(");
    const sendAt = queue.indexOf("await sendQueuedEmail(");
    expect(enqueueAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(-1);
    // Reverse order would drop the message on a crash between mint and send.
    expect(enqueueAt).toBeLessThan(sendAt);
  });

  test("backoff is bounded so a poisoned row cannot retry forever", () => {
    const src = read(EMAIL_OUTBOX);
    expect(src).toContain("Math.min");
    expect(src).toContain("maxAttempts()");
  });
});

describe("email link targets", () => {
  test("each flow's link points at the page that CONSUMES its token", () => {
    const src = read("src/lib/email/resend.ts");
    // A reset token redeemed against the magic-link verifier is hashed under a
    // different scope and always fails, so the user is told their link is
    // invalid on a perfectly good link.
    expect(src).toContain('buildLink("/auth/reset-password/confirm"');
    // The verify page, NOT the request form: a link that lands on a page whose
    // job is to ASK for an email makes the recipient re-enter it.
    expect(src).toContain('buildLink("/auth/magic-link/verify"');
    expect(src).toContain('buildLink("/auth/invites/accept"');
    // The reset branch must use the reset URL, not the sign-in one.
    const branch = src.slice(src.indexOf('case "password_reset"'));
    expect(branch.slice(0, 400)).toContain("resetUrl,");
    expect(branch.slice(0, 400)).not.toContain("resetUrl: signInUrl");
  });
});

describe("reset confirm route", () => {
  test("validates the password BEFORE consuming the token", () => {
    const src = read("src/app/api/auth/reset/confirm/route.ts");
    // Consuming first would burn a valid link on a weak password and force the
    // user to request another — the same ordering bug acceptInvite documents.
    // Match the CALL sites (with the argument), not the prose in the header.
    const validate = src.indexOf("assertUsablePassword(parsed");
    const consume = src.indexOf("redeemPasswordReset(parsed");
    expect(validate).toBeGreaterThan(-1);
    expect(consume).toBeGreaterThan(-1);
    expect(validate).toBeLessThan(consume);
  });

  test("revokes every existing session when the password changes", () => {
    const src = read("src/app/api/auth/reset/confirm/route.ts");
    // A reset exists because the password may be compromised; leaving the
    // attacker's session alive would defeat the whole operation.
    expect(src).toContain("setIdentityPassword");
  });

  test("never echoes the token back in the response", () => {
    const src = read("src/app/api/auth/reset/confirm/route.ts");
    const tail = src.slice(src.lastIndexOf("NextResponse.json("));
    expect(tail).not.toMatch(/token:\s*parsed\.data\.token/);
  });
});

describe("invite route", () => {
  test("no longer echoes the raw invite token in the HTTP response", () => {
    const src = read(INVITES_ROUTE);
    // The regression this guards: an admin-authenticated response carrying a
    // usable credential. The token must leave only via email. Match a bare
    // `token,` that sits inside a returned object literal, NOT the `token,`
    // argument inside deliverInvite({...}) — that one is required to build the
    // email and is correct.
    const responseTail = src.slice(src.lastIndexOf("status: 201"));
    expect(responseTail).not.toMatch(/^\s*token,\s*$/m);
    expect(responseTail).not.toMatch(/token:\s*token\b/);
  });

  test("delivers the invite through the email queue", () => {
    const src = read(INVITES_ROUTE);
    expect(src).toContain("deliverInvite");
  });
});
