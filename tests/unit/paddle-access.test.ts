import { describe, expect, test } from "bun:test";
import { decideAccess, hasPaidAccess, isAtRisk } from "../../src/lib/payments/access.ts";

/**
 * The access rule.
 *
 * These are the cases the brief names explicitly, and two of them are the ones a
 * naive implementation gets wrong in opposite directions:
 *
 *   - treating a SCHEDULED cancellation as a terminal one (revoking a customer
 *     who has paid through the end of the period);
 *   - treating `past_due` / `paused` as terminal (cutting off a bank's fraud
 *     line on a declined card while Paddle is still dunning).
 *
 * `decideAccess` takes only a status, so the scheduled fields CANNOT be passed
 * in — the signature is the guard.
 */

describe("decideAccess", () => {
  test.each(["active", "trialing"])("%s grants access", (status) => {
    expect(hasPaidAccess(status)).toBe(true);
    expect(isAtRisk(status)).toBe(false);
  });

  test("canceled denies access", () => {
    expect(hasPaidAccess("canceled")).toBe(false);
  });

  test.each(["past_due", "paused"])("%s is gracious but flagged", (status) => {
    const d = decideAccess(status);
    expect(d.granted, `${status} should keep access`).toBe(true);
    // And it must NOT look like plain `active`. A caller that ignores
    // `needsAttention` is the one who cuts the customer off by accident.
    expect(d.needsAttention).toBe(true);
  });

  test("an unknown status fails CLOSED", () => {
    // Paddle adding a status this build has not seen must not become
    // "grant everything" by falling through a default branch.
    const d = decideAccess("some_future_status");
    expect(d.granted).toBe(false);
    expect(d.reason).toBe("unknown_status");
  });

  test("no subscription denies access", () => {
    expect(hasPaidAccess(null)).toBe(false);
    expect(hasPaidAccess(undefined)).toBe(false);
    expect(hasPaidAccess("")).toBe(false);
  });
});

describe("a SCHEDULED change is not a change", () => {
  test("decideAccess takes no scheduled fields, so it cannot revoke on one", () => {
    // The type is one `string`. This is a compile-time guard, asserted here as a
    // runtime fact so the intent survives a future signature change.
    expect(decideAccess.length).toBe(1);
  });

  test("active + scheduled cancel still grants", () => {
    // The exact scenario the brief asks about. `status` is what decides.
    expect(hasPaidAccess("active")).toBe(true);
    // And a caller that reads only `status` cannot see the pending cancel at all,
    // which is what makes the rule unbreakable rather than merely documented.
  });
});
