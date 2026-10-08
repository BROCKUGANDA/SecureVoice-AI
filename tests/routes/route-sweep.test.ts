/**
 * AA-1.2 — the router-enumerated authorization sweep.
 *
 * The claim under test: **every route is accounted for**, so a route added in a
 * hurry cannot slip through uncovered.
 *
 * Why a filesystem sweep rather than a hand-written list: a hand-maintained list
 * goes stale the moment somebody adds a route in a hurry, and the failure is
 * silent — the new route simply is not covered and the suite stays green. Here
 * the table comes from `route-table.ts`, which walks `src/app/**\/route.ts`, so a
 * new route is visible to this suite the moment it is created.
 *
 * The split this suite enforces is three-way, and every route must land in
 * exactly one bucket:
 *
 *   PUBLIC_BY_DESIGN — genuinely reachable without an operator session, because
 *                      a DIFFERENT credential guards it (a vendor webhook
 *                      signature, an org-scoped producer key, a bearer token).
 *                      Listed with its reason in `route-table.ts`.
 *   DB_BACKED        — guarded, and proven by a suite that drives the real
 *                      handler against a live database (tenancy/isolation,
 *                      tenancy/console-routes, auth/*, console/fire).
 *   UNPROVEN         — anything else. Asserted to be EMPTY, because a route that
 *                      is neither declared public nor claimed by a DB-backed
 *                      suite is a route nobody has proved safe.
 *
 * That last bucket is the point: it is empty today only because somebody
 * classified the other routes, and it re-opens the instant a new one lands.
 */
import { describe, expect, test } from "bun:test";

import { discoverRoutes, isPublicByDesign, publicRoutes } from "./route-table";

const ALL_ROUTES = discoverRoutes("src/app");

/**
 * Routes whose real handler needs a database.
 *
 * Deliberately an explicit alternation rather than a broad pattern: a regex wide
 * enough to match everything would swallow the whole table and leave this suite
 * green while asserting nothing, which the tests below pin against.
 */
const DB_BACKED =
  /^(\/api\/(console|auth|metrics|status|v1|tts|agent|asr|enroll|interventions|pilot|onboarding)|\/v1\/|\/api$)/;

describe("the route table is derived, not declared", () => {
  test("discovery finds routes, so a sweep over an empty table cannot pass", () => {
    // A path filter matching nothing would make every check below vacuously
    // true. Assert the input is non-trivial before trusting any verdict on it.
    expect(ALL_ROUTES.length).toBeGreaterThan(20);
    expect(ALL_ROUTES.some((r) => r.path.startsWith("/api/"))).toBe(true);
  });

  test("every route resolves to a real file and exports at least one verb", () => {
    for (const route of ALL_ROUTES) {
      expect(route.file, `${route.path} has no source file`).toMatch(/^src\/app\/.+\/route\.tsx?$/);
      expect(route.methods.length, `${route.path} exports no HTTP verb`).toBeGreaterThan(0);
    }
  });

  test("route-group parentheses never reach the URL", () => {
    // `/api/(app)/x` 404s, and a sweep that probed it would record a false pass.
    for (const route of ALL_ROUTES) {
      expect(route.path, "route group leaked into the URL").not.toMatch(/[()]/);
    }
  });
});

describe("the public-by-design register is explicit and justified", () => {
  test("every exemption states a reason, and no path is listed twice", () => {
    for (const [path, reason] of Object.entries(publicRoutes())) {
      expect(reason.length, `${path} is public with no stated reason`).toBeGreaterThan(30);
    }
    const paths = Object.keys(publicRoutes());
    expect(new Set(paths).size, "duplicate entry in the public register").toBe(paths.length);
  });

  test("every exemption corresponds to a route that actually exists", () => {
    // A typo in the register would exempt a real route from scrutiny while
    // protecting nothing at all, which is worse than not listing it.
    const real = new Set(ALL_ROUTES.map((r) => r.path));
    for (const path of Object.keys(publicRoutes())) {
      expect(real.has(path), `${path} is exempted but no such route exists`).toBe(true);
    }
  });
});

describe("authorization coverage", () => {
  test("no route is left unaccounted for", () => {
    // THE anti-staleness check. A new route is discovered automatically and, until
    // somebody classifies it, it appears here rather than being silently uncovered.
    const unproven = ALL_ROUTES.filter(
      (r) => !isPublicByDesign(r.path) && !DB_BACKED.test(r.path),
    ).map((r) => r.path);
    expect(unproven, "neither public-by-design nor claimed by a DB-backed suite").toEqual([]);
  });

  test("the DB-backed exemption is pinned to the paths it claims, and nothing else", () => {
    // The real defence against DB_BACKED being widened to "match everything" is
    // that the exemption list is written out explicitly and compared. A broad
    // pattern that quietly swallowed the guarded table would make the
    // "unaccounted for" check above pass while nothing was actually proven.
    const EXPLICIT_DB_BACKED = new Set([
      "/api",
      "/api/agent",
      "/api/asr",
      "/api/auth/[...all]",
      "/api/auth/export",
      "/api/auth/invites",
      "/api/auth/invites/accept",
      "/api/auth/logout",
      "/api/auth/magic-link",
      "/api/auth/magic-link/verify",
      "/api/auth/me",
      "/api/auth/members",
      "/api/auth/password",
      "/api/auth/sessions",
      "/api/auth/sessions/revoke-all",
      "/api/auth/step-up",
      "/api/console/audit",
      "/api/console/crm",
      "/api/console/dead-letter",
      "/api/console/events",
      "/api/console/features",
      "/api/console/fire",
      "/api/console/freeze/commit",
      "/api/console/inbox",
      "/api/console/me",
      "/api/console/outbox/replay",
      "/api/console/producer-keys",
      "/api/console/realtime-token",
      "/api/console/settings",
      "/api/enroll",
      "/api/interventions",
      "/api/metrics",
      "/api/pilot",
      "/api/status",
      "/api/status/spans",
      "/api/tts",
      "/api/tts/stream",
      "/api/v1/interventions",
      "/api/v1/interventions/[id]",
      "/api/onboarding",
      "/v1/conformance/run",
    ]);

    // Every listed path must actually match the pattern...
    for (const path of EXPLICIT_DB_BACKED) {
      expect(DB_BACKED.test(path), `${path} is listed but the pattern does not match it`).toBe(
        true,
      );
    }
    // ...and the pattern must not match anything the list has not accounted for.
    const matched = ALL_ROUTES.filter(
      (r) => DB_BACKED.test(r.path) && !isPublicByDesign(r.path),
    ).map((r) => r.path);
    const unlisted = matched.filter((p) => !EXPLICIT_DB_BACKED.has(p));
    expect(unlisted, "the pattern matches routes the pinned list does not name").toEqual([]);

    // And the pinned list is not stale: every path in it is a real route.
    const real = new Set(ALL_ROUTES.map((r) => r.path));
    for (const path of EXPLICIT_DB_BACKED) {
      expect(real.has(path), `${path} is pinned but no such route exists`).toBe(true);
    }
  });
});
