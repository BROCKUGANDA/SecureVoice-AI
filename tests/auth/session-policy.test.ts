import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ABSOLUTE_LIFETIME_MS,
  ABSOLUTE_LIFETIME_SECONDS,
  COOKIE_CACHE_SECONDS,
  IDLE_TIMEOUT_MS,
  IDLE_TIMEOUT_SECONDS,
  SESSION_COOKIE_NAME,
  SESSION_REFRESH_SECONDS,
  STEP_UP_WINDOW_MS,
  STEP_UP_WINDOW_SECONDS,
} from "@/lib/auth/session-policy";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/**
 * Why this file exists
 * ────────────────────
 * The Clerk -> Better Auth cutover left TWO session systems on one request path
 * with DIFFERENT numbers: the first-party `sv_session` store enforced 15min idle
 * / 8h absolute, while `better-auth.ts` configured a rolling 12h. Whichever route
 * read a given cookie got a different policy, which is hazard AU-7.
 *
 * These tests pin the resolution so the divergence cannot come back. The
 * cross-module claims are made at SOURCE level deliberately: importing
 * `better-auth.ts` for a value would boot the whole Prisma/auth graph.
 */

describe("the session policy is stated once and enforced everywhere", () => {
  test("the chosen values are 15 min idle / 8 h absolute / 5 min step-up", () => {
    expect(IDLE_TIMEOUT_SECONDS).toBe(15 * 60);
    expect(ABSOLUTE_LIFETIME_SECONDS).toBe(8 * 60 * 60);
    expect(STEP_UP_WINDOW_SECONDS).toBe(5 * 60);
  });

  test("idle is strictly shorter than absolute, or one control is dead", () => {
    // If idle >= absolute the idle check can never fire, so the first-party
    // store's idle branch becomes unreachable and the "walk away from an
    // unlocked laptop" control silently does nothing.
    expect(IDLE_TIMEOUT_MS).toBeLessThan(ABSOLUTE_LIFETIME_MS);
  });

  test("millisecond and second forms are the same number", () => {
    // Two unit systems for one policy is how the original divergence happened.
    expect(IDLE_TIMEOUT_MS).toBe(IDLE_TIMEOUT_SECONDS * 1000);
    expect(ABSOLUTE_LIFETIME_MS).toBe(ABSOLUTE_LIFETIME_SECONDS * 1000);
    expect(STEP_UP_WINDOW_MS).toBe(STEP_UP_WINDOW_SECONDS * 1000);
  });

  test("rolling refresh is disabled, so the absolute bound is real", () => {
    // With a non-zero updateAge, getSession pushes expiresAt out by
    // ABSOLUTE_LIFETIME_SECONDS on every refresh, so the "hard 8-hour ceiling"
    // advertised to a bank would never be reached. A documented bound that is
    // quietly undermined is worse than no bound.
    expect(SESSION_REFRESH_SECONDS).toBe(0);
  });

  test("the cookie cache is short, and shorter than the idle limit", () => {
    // A cookie-cache hit is a session read that does NOT consult the database,
    // so it cannot observe revocation or a role change (hazard AU-4). If the
    // cache outlived the idle limit, a revoked session would keep working.
    expect(COOKIE_CACHE_SECONDS).toBeLessThan(IDLE_TIMEOUT_SECONDS);
    expect(COOKIE_CACHE_SECONDS).toBe(5 * 60);
  });
});

describe("both session systems read the SAME numbers", () => {
  test("better-auth.ts imports every session number instead of hard-coding it", () => {
    const ba = read("src/lib/better-auth.ts");
    // If one of these reverts to a literal, the two systems diverge again.
    expect(ba).toContain("expiresIn: ABSOLUTE_LIFETIME_SECONDS");
    expect(ba).toContain("updateAge: SESSION_REFRESH_SECONDS");
    expect(ba).toContain("maxAge: COOKIE_CACHE_SECONDS");
    expect(ba).toContain('from "@/lib/auth/session-policy"');
  });

  test("better-auth.ts contains no literal session durations", () => {
    // Catches the regression in its general form: any inline arithmetic in the
    // session block reintroduces a second source of truth.
    const ba = read("src/lib/better-auth.ts");
    const sessionBlock = ba.slice(ba.indexOf("session: {"), ba.indexOf("advanced:"));
    expect(sessionBlock.length).toBeGreaterThan(0);
    expect(sessionBlock).not.toMatch(/60 \* 60 \* 12/);
    expect(sessionBlock).not.toMatch(/expiresIn:\s*\d/);
    expect(sessionBlock).not.toMatch(/updateAge:\s*60/);
  });

  test("the constants shim re-exports rather than redefining", () => {
    const constants = read("src/lib/auth/constants.ts");
    // A second `export const IDLE_TIMEOUT_MS =` here would be a silent fork.
    expect(constants).not.toMatch(/export const IDLE_TIMEOUT_MS\s*=/);
    expect(constants).not.toMatch(/export const ABSOLUTE_LIFETIME_MS\s*=/);
    expect(constants).toContain('from "@/lib/auth/session-policy"');
  });

  test("session-policy.ts is the only place a duration is defined", () => {
    const policy = read("src/lib/auth/session-policy.ts");
    for (const name of [
      "IDLE_TIMEOUT_SECONDS",
      "ABSOLUTE_LIFETIME_SECONDS",
      "STEP_UP_WINDOW_SECONDS",
      "COOKIE_CACHE_SECONDS",
      "SESSION_REFRESH_SECONDS",
    ]) {
      expect(policy).toContain(`export const ${name}`);
    }
    // The cookie name belongs to the first-party store only and must not be
    // confused with the Better Auth cookie.
    expect(SESSION_COOKIE_NAME).toBe("sv_session");
  });
});

describe("the client idle timer cannot drift from the server policy", () => {
  test("IdleTimeoutHandler duplicates IDLE_TIMEOUT_SECONDS exactly", () => {
    // The duplication is necessary (a `server-only` import would leak into the
    // client bundle), so the guard against drift has to be a test instead.
    const handler = read("src/components/shell/IdleTimeoutHandler.tsx");
    const match = handler.match(/const IDLE_TIMEOUT = (\d+) \* 60 \* 1000/);
    expect(match).not.toBeNull();
    // The handler stores MINUTES (`15 * 60 * 1000`); the policy constant is in
    // seconds. Compare in the same unit or this assertion is meaningless.
    expect(Number(match?.[1]) * 60).toBe(IDLE_TIMEOUT_SECONDS);
  });
});

describe("the policy documents its deviation from the specification", () => {
  test("the deviation is written in code, not only in a doc", () => {
    // The spec asked for 30 min idle / 7-day rolling / 15 min step-up. We ship
    // tighter values. That is a decision a human must be able to find and
    // reverse, so the rationale lives next to the constants themselves.
    const policy = read("src/lib/auth/session-policy.ts");
    expect(policy).toContain("Deviation from spec");
    expect(policy).toContain("hazard AU-7");
  });

  test("the shipped policy is never LOOSER than the specified one", () => {
    // The safety property that matters. If someone later "aligns" the values
    // with the spec by loosening them, this fails.
    const SPEC_IDLE_SECONDS = 30 * 60;
    const SPEC_STEP_UP_SECONDS = 15 * 60;
    const SPEC_ABSOLUTE_SECONDS = 7 * 24 * 60 * 60;

    expect(IDLE_TIMEOUT_SECONDS).toBeLessThanOrEqual(SPEC_IDLE_SECONDS);
    expect(STEP_UP_WINDOW_SECONDS).toBeLessThanOrEqual(SPEC_STEP_UP_SECONDS);
    // The spec's absolute bound was ROLLING, so compare against a rolling week:
    // with refresh disabled our bound is strictly tighter than "a week".
    expect(ABSOLUTE_LIFETIME_SECONDS).toBeLessThan(SPEC_ABSOLUTE_SECONDS);
  });
});
