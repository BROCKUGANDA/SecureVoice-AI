/**
 * The seat model — who may see what, and why the mapping cannot quietly widen.
 *
 * This is the client-side half of the RBAC story and it is deliberately a pure
 * table with no session, no fetch and no React, because that is what makes the
 * dangerous direction testable: a role string this module does not understand
 * must resolve to the LEAST privileged seat, and the only way to prove that is to
 * throw every unrecognised value at it and assert none of them reach `operator`.
 *
 * The navbar and the shell's RBAC gate both read this. Neither is an
 * authorisation boundary — every route re-checks server-side — so the failure
 * mode being guarded here is "a control is shown that the API will 403", not
 * "a control is hidden that the API would have allowed".
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SEATS,
  atLeast,
  isPlatformRole,
  seatFromMembershipRole,
  seatFromPlatformRole,
  seatLabel,
} from "@/lib/auth/seat";
import { ACCESS_SEAT, VIEW_ACCESS, type View } from "@/lib/store";
import { pathForView } from "@/lib/console-routes";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

describe("membership role -> seat", () => {
  test("the roles that administer an organisation are operators", () => {
    expect(seatFromMembershipRole("owner")).toBe("operator");
    expect(seatFromMembershipRole("admin")).toBe("operator");
  });

  test("a plain member is a working seat, not an admin", () => {
    // This is the whole point of the split. The old nav computed the role as
    // `activeOrganizationId ? "operator" : undefined`, so every member of every
    // organisation was shown Settings and the Appendix — screens whose routes
    // reject them.
    expect(seatFromMembershipRole("member")).toBe("vendor");
  });

  test("matching is case- and whitespace-insensitive", () => {
    expect(seatFromMembershipRole("Owner")).toBe("operator");
    expect(seatFromMembershipRole("  ADMIN ")).toBe("operator");
  });

  test("no membership at all is a read-only seat, never an operator", () => {
    // `null` means "no membership row was consulted" — a session with no active
    // organization. `roleFromMembership` in src/lib/credits.ts resolves this to
    // `operator` so existing pilot logins keep working; that is right behind a
    // server guard and wrong for deciding what a browser session may SEE.
    expect(seatFromMembershipRole(null)).toBe("judge");
    expect(seatFromMembershipRole(undefined)).toBe("judge");
    expect(seatFromMembershipRole("")).toBe("judge");
  });

  test("an unrecognised role never widens access", () => {
    // The fail-open default is the whole failure mode of a permission check, so
    // every plausible typo and every machine-ish name is asserted to land on the
    // least-privileged seat.
    for (const hostile of [
      "administrator",
      "superadmin",
      "root",
      "owner,admin",
      "undefined",
      "null",
      "NaN",
      "<script>",
      "0",
      "true",
    ]) {
      expect(seatFromMembershipRole(hostile), `${hostile} widened access`).toBe("judge");
    }
  });

  test("ServiceAccount is not a seat a browser session can claim", () => {
    // It is a machine identity authenticated by a producer key, never by a
    // cookie. Honouring it here would mint a console seat out of a session.
    expect(seatFromPlatformRole("ServiceAccount")).toBe("judge");
    expect(isPlatformRole("ServiceAccount")).toBe(true);
  });
});

describe("platform role -> seat", () => {
  test("mirrors the WP-11 vocabulary", () => {
    expect(seatFromPlatformRole("Owner")).toBe("operator");
    expect(seatFromPlatformRole("Admin")).toBe("operator");
    expect(seatFromPlatformRole("Analyst")).toBe("vendor");
    expect(seatFromPlatformRole("Auditor")).toBe("judge");
  });

  test("the seat order matches the capability order", () => {
    // Owner/Admin administer, Analyst works the queue, Auditor only reads. If
    // the two lists ever disagree about which is more privileged, the nav and the
    // server guards stop meaning the same thing — so they are asserted against
    // each other rather than trusted.
    expect(seatFromPlatformRole("Owner")).toBe(seatFromPlatformRole("Admin"));
    expect(atLeast(seatFromPlatformRole("Analyst"), seatFromPlatformRole("Auditor"))).toBe(true);
    expect(atLeast(seatFromPlatformRole("Auditor"), seatFromPlatformRole("Analyst"))).toBe(false);
  });
});

describe("seat ordering", () => {
  test("judge < vendor < operator", () => {
    expect(atLeast("judge", "judge")).toBe(true);
    expect(atLeast("vendor", "judge")).toBe(true);
    expect(atLeast("operator", "vendor")).toBe(true);
    expect(atLeast("vendor", "operator")).toBe(false);
    expect(atLeast("judge", "operator")).toBe(false);
  });

  test("the ladder is exactly three rungs and is ordered", () => {
    // `atLeast` compares by INDEX. Reordering this array silently widens or
    // narrows every seat at once, so the order itself is asserted.
    expect([...SEATS]).toEqual(["judge", "vendor", "operator"]);
  });

  test("every seat has a label in both languages", () => {
    for (const seat of SEATS) {
      const label = seatLabel(seat);
      expect(label.en.length).toBeGreaterThan(0);
      expect(label.ar.length).toBeGreaterThan(0);
    }
  });
});

describe("VIEW_ACCESS is total and consistent", () => {
  const views = Object.keys(VIEW_ACCESS) as View[];

  test("every view declares a seat, and every seat is one of ours", () => {
    for (const view of views) {
      const access = VIEW_ACCESS[view];
      expect(access, `${view} has no declared access`).toBeDefined();
      const seat = ACCESS_SEAT[access];
      if (access === "public") {
        expect(seat, `${view} is public but requires a seat`).toBeNull();
      } else {
        expect(seat, `${view} is ${access} but maps to no seat`).not.toBeNull();
        expect(SEATS, `${view} requires an unknown seat ${seat}`).toContain(seat as never);
      }
    }
  });

  test("no console view is public", () => {
    // A console screen reachable without a session is a data leak in the nav
    // even when every route behind it is guarded. The marketing and legal pages
    // ARE public on purpose — a listing reviewer must reach pricing without an
    // account — so this is scoped to the views that have a shell URL.
    for (const view of views) {
      const path = pathForView(view);
      if (path === null || !path.startsWith("/console")) continue;
      expect(VIEW_ACCESS[view], `${view} (${path}) is public`).not.toBe("public");
    }
  });

  test("the public marketing and legal pages stay public", () => {
    // The inverse, stated so the check above cannot be satisfied by making
    // everything private.
    for (const view of [
      "home",
      "docs",
      "security",
      "pricing",
      "privacy",
      "terms",
      "refund",
    ] as View[]) {
      expect(VIEW_ACCESS[view], `${view} is not public`).toBe("public");
    }
  });

  test("the mutating surfaces are operator-only", () => {
    // Settings, the appendix and the tenant setup wizard all change or expose
    // the organisation. None may be reachable by a seat that only reads.
    for (const view of ["settings", "deck", "setup"] as View[]) {
      expect(ACCESS_SEAT[VIEW_ACCESS[view]], `${view} is not operator-only`).toBe("operator");
    }
  });

  test("the Command Center is a working seat, not a read-only one", () => {
    // It opens cases and freezes cards. A `judge` there would make "read-only"
    // a claim the UI contradicts.
    expect(ACCESS_SEAT[VIEW_ACCESS.console]).toBe("vendor");
    expect(atLeast("judge", ACCESS_SEAT[VIEW_ACCESS.console]!)).toBe(false);
  });

  test("the tour and the dashboard are open to every signed-in seat", () => {
    // A judge who cannot open the product tour is a judge who concludes there is
    // no product.
    for (const view of ["dashboard", "product", "demo"] as View[]) {
      expect(ACCESS_SEAT[VIEW_ACCESS[view]], `${view} is not judge-level`).toBe("judge");
    }
  });

  test("no view requires a seat above operator", () => {
    for (const view of views) {
      const seat = ACCESS_SEAT[VIEW_ACCESS[view]];
      if (seat === null) continue;
      expect(atLeast("operator", seat), `${view} needs ${seat}, which operator lacks`).toBe(true);
    }
  });

  test("the gate's own fallback is reachable by the seat it falls back TO", () => {
    // The shell's RBAC gate sends a signed-in seat that is refused a screen to
    // `dashboard`. If `dashboard` were not `judge`-level, a judge bounced out of
    // the Command Center would land on a screen the gate immediately refuses —
    // an infinite redirect that renders as a blank page.
    //
    // This asserts the invariant rather than the implementation: whatever the
    // fallback is, it must be open to the least-privileged signed-in seat.
    const FALLBACK: View = "dashboard";
    expect(ACCESS_SEAT[VIEW_ACCESS[FALLBACK]], `${FALLBACK} is not open to a judge`).toBe("judge");
    for (const seat of SEATS) {
      const required = ACCESS_SEAT[VIEW_ACCESS[FALLBACK]]!;
      expect(atLeast(seat, required), `${seat} cannot reach the fallback ${FALLBACK}`).toBe(true);
    }
  });
});

describe("the mirrored role list cannot drift from the server", () => {
  test("seat.ts lists exactly the roles auth/roles.ts declares", () => {
    // `PLATFORM_ROLES` in src/lib/auth/seat.ts is a LITERAL rather than an import,
    // because src/lib/auth/roles.ts is `server-only` and would throw in a client
    // bundle. A copy is only safe if something asserts the original has not
    // changed — which is what this is.
    const server = read("src/lib/auth/roles.ts");
    const declared = server.match(/export const ROLES = \[([^\]]*)\]/);
    expect(declared, "could not read ROLES out of auth/roles.ts").not.toBeNull();
    // Read the capture group ONCE into a local. Under `noUncheckedIndexedAccess`
    // a regex match's group is `string | undefined` regardless of the `!`, so
    // the assertion above does not narrow it for the next line.
    const serverBody = declared?.[1];
    expect(serverBody, "ROLES capture group was empty").toBeDefined();
    const serverRoles = [...(serverBody ?? "").matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]).sort();

    // Compare against the literal in seat.ts, which is the thing at risk.
    const seatFile = read("src/lib/auth/seat.ts");
    const clientLiteral = seatFile.match(/const PLATFORM_ROLES = \[([^\]]*)\] as const/);
    expect(clientLiteral, "could not read PLATFORM_ROLES out of auth/seat.ts").not.toBeNull();
    const clientBody = clientLiteral?.[1];
    expect(clientBody, "PLATFORM_ROLES capture group was empty").toBeDefined();
    const clientRoles = [...(clientBody ?? "").matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);

    expect(clientRoles.sort()).toEqual(serverRoles);
  });

  test("the store does not reintroduce the old two-value vocabulary", () => {
    // "user" was the old name for what is now "judge", which read as though it
    // granted something when it granted nothing.
    const store = read("src/lib/store.ts");
    expect(store).not.toContain('"user" | "operator"');
    expect(store).not.toMatch(/:\s*"user"/);
  });
});
