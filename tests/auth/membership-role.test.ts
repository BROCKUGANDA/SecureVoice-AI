/**
 * Better Auth's membership role is MAPPED into this module's vocabulary, never cast.
 *
 * `src/lib/credits.ts` carries two values, `"operator" | "demo"`, and 45 call sites
 * read them. Better Auth's organization plugin carries `owner | admin | member`. The
 * line that joined them was `membershipRole as Role` — a cast, so the compiler
 * accepted "owner" as if it were "operator" — and the very next consumer of that
 * value is `requireOperator()`'s `profile.role !== "operator"`, which answers 403.
 *
 * The bug was invisible for exactly one reason: this deployment's `member` table is
 * empty, so the branch that reads a membership has never run in anger, and every
 * session has taken the fallback. The moment Better Auth memberships exist — which
 * is the pilot's first week — every institution administrator starts getting "Operator
 * access required" while signed in as the Owner. An unexercised branch of an
 * authorisation check is not a low-risk branch; it is an untested one.
 *
 *   bun test tests/auth/membership-role.test.ts
 */
import { describe, expect, test } from "bun:test";
import { roleFromMembership, type Role } from "@/lib/credits";

describe("roleFromMembership", () => {
  test("the administrator roles of the provider become operator", () => {
    for (const role of ["owner", "admin", "Owner", "ADMIN"]) {
      expect(roleFromMembership(role, "org-1"), role).toBe("operator");
    }
  });

  test("a plain member is not the institution administrator", () => {
    // `requireOperator` guards settings, billing and seats — the 403 message says
    // "this area is for the institution admin". Mapping `member` to operator would
    // make every console user an admin of the bank's money and guardrails.
    expect(roleFromMembership("member", "org-1")).toBe("demo");
  });

  test("an unknown or malformed role gets the least privileged answer", () => {
    // A typo in the provider, a role added upstream, or a hostile claim all land the
    // same way: not an admin. The convenient answer would be to pass the string
    // through, which is what the cast did.
    for (const role of ["superuser", "svc-account", "ServiceAccount", "", " ", "owner "]) {
      expect(roleFromMembership(role, "org-1"), JSON.stringify(role)).toBe("demo");
    }
  });

  test("no membership row is a removal, not an implicit promotion", () => {
    // An active org with no member row for this user means the membership was
    // deleted (or the cookie still names an org the user has left). It is not
    // an operator. The one legacy shape that may still fall back is an org that
    // has never had ANY member rows; `getProfile` proves that with a count and
    // passes the flag explicitly.
    expect(roleFromMembership(null, "org-1")).toBe("demo");
    expect(roleFromMembership(null, "org-1", { legacyOrgWithoutMembers: true })).toBe("operator");
    expect(roleFromMembership(null, null)).toBe("demo");
  });

  test("the function's answer is always one of the two values the callers test", () => {
    // The point of the whole exercise: nothing outside this vocabulary can ever
    // reach `profile.role`, so `!== "operator"` is a real check and not a string
    // comparison against a value no provider would ever send.
    const cases: (string | null)[] = ["owner", "admin", "member", "weird", null];
    for (const role of cases) {
      for (const org of ["org-1", null]) {
        const out: Role = roleFromMembership(role, org);
        expect(["operator", "demo"]).toContain(out);
      }
    }
  });
});
