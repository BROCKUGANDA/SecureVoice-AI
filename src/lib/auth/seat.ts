/**
 * The signed-in SEAT — which of the three audiences this person is.
 *
 * ## Why this file exists
 *
 * The navbar and the shell's RBAC gate both used to compute the role inline as
 * `session?.session?.activeOrganizationId ? "operator" : undefined`. That
 * expression is not a role check, it is a null check on the tenant pointer, and
 * it was wrong in both directions:
 *
 *   · Every signed-in seat that happened to have an organization was labelled an
 *     operator, so an `Analyst` was shown Settings and the Appendix — controls
 *     whose server routes reject them. The nav promised something the API refuses.
 *   · Every signed-in seat WITHOUT an organization was labelled nothing at all,
 *     so a hackathon judge with no tenant could not reach the product tour, and
 *     a demo seat could not reach anything it was entitled to.
 *
 * ## The three seats
 *
 * The audiences are named for who they are FOR, and each maps onto a role that
 * already exists in `src/lib/auth/roles.ts` — so no migration, no new column, and
 * no second authorisation system:
 *
 *   judge     → Auditor  Read-only. A hackathon judge or press reviewer: they
 *                        see the tour and the recorded evidence, and nothing that
 *                        mutates. Deliberately NOT granted to anyone who merely
 *                        lacks a tenant.
 *   vendor    → Analyst  Works the queue: cases, interventions, recordings.
 *                        A bank or insurer's fraud desk.
 *   operator  → Owner/Admin  Changes the organisation: settings, keys, team,
 *                        billing, the setup wizard.
 *
 * `ServiceAccount` is absent by construction: it is a machine identity
 * authenticated by a producer key, never by a browser session, so honouring it
 * here would mint a console seat out of a cookie. The same reasoning is in
 * `src/lib/identity/session-role-map.ts` and it is why that file exports
 * `isHonourableSessionRole` rather than plain `isRole`.
 *
 * ## What this file is NOT
 *
 * NOT an authorisation boundary. Every route re-checks the capability server-side
 * (`requireSignedIn` / `requireOperator`, and `roleHas()` against the matrix in
 * `src/lib/auth/roles.ts`). This decides what the nav PROMISES; the server decides
 * what is PERMITTED. A wrong seat here can show a control that 403s — it can never
 * grant one. That direction is the only safe direction for a client-side gate.
 *
 * ## Why it is safe to import from the browser
 *
 * It imports exactly one module — `@/lib/demo-account`, which is client-safe by
 * design (no `server-only`, no database). Not the Prisma handle, not the matrix —
 * `ROLES`/`isRole` are duplicated as a literal below rather than imported from
 * `src/lib/auth/roles.ts`, which is `server-only` and would throw at build time in
 * a client bundle. `tests/unit/seat.test.ts` asserts the two lists cannot drift.
 */

import { isDemoAccount } from "@/lib/demo-account";

/** The role vocabulary this app recognises, mirrored from `src/lib/auth/roles.ts`. */
const PLATFORM_ROLES = ["Owner", "Admin", "Analyst", "Auditor", "ServiceAccount"] as const;

export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export function isPlatformRole(value: unknown): value is PlatformRole {
  return typeof value === "string" && (PLATFORM_ROLES as readonly string[]).includes(value);
}

/**
 * The three audiences, ordered least-privileged first.
 *
 * The ORDER IS THE PERMISSION ORDER. `atLeast()` compares by index, so inserting a
 * seat in the wrong position silently widens or narrows everyone above it. Adding a
 * fourth seat means deciding, explicitly, where it belongs.
 */
export const SEATS = ["judge", "vendor", "operator"] as const;

export type Seat = (typeof SEATS)[number];

/** True when `seat` holds at least the authority of `required`. */
export function atLeast(seat: Seat, required: Seat): boolean {
  return SEATS.indexOf(seat) >= SEATS.indexOf(required);
}

/**
 * Map a Better Auth MEMBERSHIP role onto a seat.
 *
 * Better Auth's `organization()` plugin ships exactly three member roles by
 * default (`owner`, `admin`, `member` — see `defaultRolesSchema` in
 * better-auth/dist/plugins/organization). They map like this:
 *
 *   owner, admin → operator  They administer the organisation.
 *   member       → vendor    They work the queue.
 *
 * Two deliberate details:
 *
 *  · `null` means "no membership row was consulted", which is NOT the same as
 *    "membership says member". It happens when the session has no active
 *    organization at all. That case resolves to `judge` — the least-privileged
 *    seat — rather than to `operator`. `roleFromMembership` in `src/lib/credits.ts`
 *    resolves it the other way round, and that is right THERE and wrong HERE:
 *    that function's job is to keep existing pilot logins working on a
 *    pre-Better-Auth database, and it runs behind a server guard either way.
 *    Deciding what a tenant-less browser session may SEE is a different question,
 *    and a null answer to "which role do you hold" must not widen it.
 *
 *  · An unrecognised string also resolves to `judge`, never to `operator`. A role
 *    name this file does not understand must not widen access; that is the whole
 *    failure mode of a fail-open default in a permission check.
 */
export function seatFromMembershipRole(membershipRole: string | null | undefined): Seat {
  switch ((membershipRole ?? "").trim().toLowerCase()) {
    case "owner":
    case "admin":
      return "operator";
    case "member":
      return "vendor";
    default:
      return "judge";
  }
}

/**
 * The seat for a session, given the membership role AND the sign-in email.
 *
 * A demo address is confined to `judge` no matter what the membership row says:
 * the one-click credential is public by design, so a membership granting it
 * more must not widen what the nav promises. The server enforces the same rule
 * on the profile (`src/lib/credits.ts`); this is the client mirror, and like
 * everything here it can only hide controls, never grant them.
 */
export function seatForSession(
  membershipRole: string | null | undefined,
  email: string | null | undefined,
): Seat {
  if (isDemoAccount(email)) return "judge";
  return seatFromMembershipRole(membershipRole);
}

/** Map one of this app's own platform roles onto a seat. */
export function seatFromPlatformRole(role: string | null | undefined): Seat {
  switch (role) {
    case "Owner":
    case "Admin":
      return "operator";
    case "Analyst":
      return "vendor";
    default:
      // `ServiceAccount` and anything unknown: least privilege. See the header.
      return "judge";
  }
}

/** Human label for the seat, shown in the account menu. */
export function seatLabel(seat: Seat): { en: string; ar: string } {
  switch (seat) {
    case "operator":
      return { en: "Operator", ar: "مشغّل" };
    case "vendor":
      return { en: "Analyst", ar: "محلّل" };
    case "judge":
      return { en: "Read-only", ar: "للقراءة فقط" };
  }
}
