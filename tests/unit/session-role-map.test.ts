/**
 * UNIT — session role → WP-11 capability mapping.
 *
 * Covers the pure seam in src/lib/identity/session-role-map.ts plus the two
 * role-vocabulary properties it depends on (src/lib/auth/roles.ts). This
 * mapping had no test, and it is the single funnel every console identity passes
 * through — Better Auth memberships and first-party sessions both land here, so
 * a wrong default is a wrong default for the whole product.
 *
 * The properties that matter, and why:
 *
 *   · FAIL-CLOSED. Anything unrecognised resolves to Auditor (read-only). A
 *     fail-open default in a permission check is the failure mode this module
 *     exists to prevent, so the unknown-role cases are asserted explicitly
 *     rather than assumed.
 *   · `operator` is Admin, NOT Owner. Owner confers exactly one extra power —
 *     granting or changing the Owner role — and no pre-existing account should
 *     acquire that implicitly.
 *   · `demo` is Auditor, i.e. READ-ONLY, so a demo account cannot fire an
 *     intervention.
 *   · An explicit `platformRole` wins over the legacy `role`: it is an operator's
 *     stated intent, whereas `role` is only a default.
 *   · `ServiceAccount` is NEVER honoured from a session claim. It is a machine
 *     role authenticated by a producer key; a browser session asserting it would
 *     mint a machine identity out of a human.
 */
import { describe, expect, test } from "bun:test";
import {
  allowedSessionRoles,
  isHonourableSessionRole,
  mapSessionRole,
} from "@/lib/identity/session-role-map";
import {
  CAPABILITIES,
  PRIVILEGED_ACTIONS,
  ROLES,
  ROLE_CAPABILITIES,
  PRIVILEGED_ACTION_CAPABILITY,
  PRIVILEGED_ACTION_LABEL,
  isReadOnlyRole,
  isRole,
  isWriteCapability,
  roleHas,
  type Role,
} from "@/lib/auth/roles";

describe("mapSessionRole — legacy vocabulary", () => {
  test("operator maps to Admin, never Owner", () => {
    expect(mapSessionRole({ role: "operator" })).toBe("Admin");
  });

  test("operator does not inherit the Owner-only power", () => {
    const mapped = mapSessionRole({ role: "operator" });
    // The single power Owner adds over Admin is assigning the Owner role.
    expect(mapped).not.toBe("Owner");
    expect(roleHas(mapped, "member:setRole")).toBe(true);
  });

  test("demo maps to Auditor, which is read-only", () => {
    const mapped = mapSessionRole({ role: "demo" });
    expect(mapped).toBe("Auditor");
    expect(isReadOnlyRole(mapped)).toBe(true);
  });

  test("a demo account cannot fire an intervention", () => {
    const demo = mapSessionRole({ role: "demo" });
    expect(roleHas(demo, "case:fire")).toBe(false);
    expect(isWriteCapability("case:fire")).toBe(true);
  });
});

describe("mapSessionRole — fail closed", () => {
  test("an absent claim resolves to Auditor", () => {
    expect(mapSessionRole({})).toBe("Auditor");
    expect(mapSessionRole(undefined)).toBe("Auditor");
    expect(mapSessionRole(null)).toBe("Auditor");
  });

  test("null and empty-string claims resolve to Auditor", () => {
    expect(mapSessionRole({ role: null })).toBe("Auditor");
    expect(mapSessionRole({ role: "" })).toBe("Auditor");
    expect(mapSessionRole({ platformRole: null })).toBe("Auditor");
    expect(mapSessionRole({ platformRole: "" })).toBe("Auditor");
  });

  test("an unrecognised role never widens access", () => {
    for (const role of ["superadmin", "Owner", "owner", "admin", "ADMIN", "root", "auditor"]) {
      expect(mapSessionRole({ role })).toBe("Auditor");
    }
  });

  test("an unrecognised platformRole falls back to the legacy mapping", () => {
    // Not to Owner — an unparseable claim must not widen anything.
    expect(mapSessionRole({ platformRole: "superuser", role: "operator" })).toBe("Admin");
    expect(mapSessionRole({ platformRole: "superuser" })).toBe("Auditor");
  });

  test("every unknown-input result is read-only", () => {
    for (const claims of [{}, undefined, null, { role: "nonsense" }, { platformRole: 42 }]) {
      expect(isReadOnlyRole(mapSessionRole(claims as never))).toBe(true);
    }
  });
});

describe("mapSessionRole — explicit platformRole wins", () => {
  test("an explicit role overrides a conflicting legacy role", () => {
    expect(mapSessionRole({ platformRole: "Analyst", role: "operator" })).toBe("Analyst");
    expect(mapSessionRole({ platformRole: "Owner", role: "demo" })).toBe("Owner");
    expect(mapSessionRole({ platformRole: "Admin", role: "demo" })).toBe("Admin");
  });

  test("each honourable role resolves to itself", () => {
    for (const role of allowedSessionRoles()) {
      expect(mapSessionRole({ platformRole: role })).toBe(role);
    }
  });
});

describe("mapSessionRole — ServiceAccount is never honoured from a session", () => {
  test("a session claiming ServiceAccount does not become one", () => {
    expect(mapSessionRole({ platformRole: "ServiceAccount" })).toBe("Auditor");
  });

  test("it falls back to the legacy mapping rather than failing outright", () => {
    expect(mapSessionRole({ platformRole: "ServiceAccount", role: "operator" })).toBe("Admin");
  });

  test("a machine role holds no console capability", () => {
    // Even though the session path refuses to mint one, the matrix must still
    // define what it means rather than leaving it undefined.
    expect(ROLE_CAPABILITIES.ServiceAccount.size).toBe(0);
  });
});

describe("allowedSessionRoles / isHonourableSessionRole", () => {
  test("ServiceAccount is excluded from the honourable set", () => {
    const allowed = allowedSessionRoles();
    expect(allowed).not.toContain("ServiceAccount");
    expect(allowed).toContain("Owner");
    expect(allowed).toHaveLength(ROLES.length - 1);
  });

  test("isHonourableSessionRole agrees with the ROLES vocabulary minus the machine role", () => {
    for (const role of ROLES) {
      expect(isHonourableSessionRole(role)).toBe(role !== "ServiceAccount");
    }
  });

  test("non-role values are not honourable", () => {
    for (const v of [null, undefined, "", 42, {}, [], true, "operator", "demo"]) {
      expect(isHonourableSessionRole(v)).toBe(false);
    }
  });
});

describe("role vocabulary invariants", () => {
  test("isRole accepts exactly the declared roles", () => {
    for (const role of ROLES) expect(isRole(role)).toBe(true);
    for (const v of ["", "owner", "Owner ", null, undefined, 1, {}]) {
      expect(isRole(v as never)).toBe(false);
    }
  });

  test("every capability is held by at least one role — no dead capabilities", () => {
    for (const cap of CAPABILITIES) {
      const holders = ROLES.filter((r) => roleHas(r, cap));
      expect({ cap, holders: holders.length > 0 }).toEqual({ cap, holders: true });
    }
  });

  test("every role has an explicit entry — no undefined lookup", () => {
    for (const role of ROLES) {
      expect(ROLE_CAPABILITIES[role]).toBeInstanceOf(Set);
    }
  });

  test("capability sets only contain declared capabilities", () => {
    for (const role of ROLES) {
      for (const cap of ROLE_CAPABILITIES[role]) {
        expect(CAPABILITIES).toContain(cap);
      }
    }
  });

  test("Owner is a strict superset of Admin", () => {
    // Owner differs from Admin only by the role-assignment power, so it must
    // hold everything Admin does.
    for (const cap of CAPABILITIES) {
      if (roleHas("Admin", cap)) expect(roleHas("Owner", cap)).toBe(true);
    }
  });

  test("only Owner may grant or change the Owner role", () => {
    for (const role of ROLES) {
      const canSetRole = roleHas(role, "member:setRole");
      if (role === "Owner") expect(canSetRole).toBe(true);
      // Admin also holds member:setRole, but RBAC refuses to let it assign
      // Owner; the matrix alone cannot express that, so only ownership is
      // asserted here.
    }
  });

  test("Auditor is read-only and ServiceAccount holds nothing", () => {
    expect(isReadOnlyRole("Auditor")).toBe(true);
    expect(isReadOnlyRole("ServiceAccount")).toBe(true);
    expect(isReadOnlyRole("Analyst")).toBe(false);
    expect(isReadOnlyRole("Admin")).toBe(false);
    expect(isReadOnlyRole("Owner")).toBe(false);
  });

  test("no write capability is granted to a read-only role", () => {
    for (const role of ["Auditor", "ServiceAccount"] as Role[]) {
      for (const cap of CAPABILITIES) {
        if (isWriteCapability(cap)) expect(roleHas(role, cap)).toBe(false);
      }
    }
  });

  test("the matrix is frozen so a stray mutation fails", () => {
    expect(Object.isFrozen(ROLE_CAPABILITIES)).toBe(true);
  });
});

describe("privileged actions", () => {
  test("every privileged action requires a capability some role actually holds", () => {
    // A step-up gated on a capability no role holds would make the action
    // permanently unreachable, so this is a real invariant, not decoration.
    for (const action of PRIVILEGED_ACTIONS) {
      const cap = PRIVILEGED_ACTION_CAPABILITY[action];
      expect(CAPABILITIES).toContain(cap);
      expect(ROLES.some((r) => roleHas(r, cap))).toBe(true);
    }
  });

  test("every privileged action has a human-facing label", () => {
    for (const action of PRIVILEGED_ACTIONS) {
      expect(PRIVILEGED_ACTION_LABEL[action]).toBeTruthy();
    }
  });

  test("the capability map and label map cover exactly the declared actions", () => {
    // A missing entry would make the step-up prompt say nothing at runtime.
    expect(Object.keys(PRIVILEGED_ACTION_CAPABILITY).sort()).toEqual(
      [...PRIVILEGED_ACTIONS].sort(),
    );
    expect(Object.keys(PRIVILEGED_ACTION_LABEL).sort()).toEqual([...PRIVILEGED_ACTIONS].sort());
  });

  test("a step-up does not confer the capability on its own", () => {
    // The role check runs first and the step-up check second, so an Auditor
    // holding a step-up still cannot act.
    expect(roleHas("Auditor", PRIVILEGED_ACTION_CAPABILITY.commit_freeze)).toBe(false);
  });
});
