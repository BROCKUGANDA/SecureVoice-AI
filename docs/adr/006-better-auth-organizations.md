# ADR-006: Better Auth Organizations over a hosted identity vendor

## Context

The tenant is the institution, and one person can legitimately belong to two of them:
a fraud desk contracted to monitor Bank A and Insurer B. Multi-membership with an
active-organisation switch is therefore a requirement, not a nicety — and identity is
the layer where a vendor change is most expensive, because it is the one that holds the
session key for every other decision.

A hosted identity platform solves the multi-tenancy and pays for it with three things
this deployment cannot trade away: the customer data leaves the box, session
behaviour becomes someone else's policy, and the per-seat pricing model collides
directly with the seat caps we enforce per plan.

## Decision

Better Auth, self-hosted, with its Organization plugin
(`src/lib/better-auth.ts`), and its data in the same Postgres as everything else, so
the tenant boundary is enforced once — by row-level security — rather than twice and
approximately.

Three decisions inside this one are load-bearing and were each learned the hard way:

- **Sign-up is closed, and the flag is the control.** `disableSignUp: true`. There was
  no signup route to find, and the filesystem patrol that proves it stayed green while
  Better Auth's own `POST /api/auth/sign-up/email` rode the catch-all
  (`src/app/api/auth/[...all]/route.ts`) with no CAPTCHA and no bad-actor check,
  because the Turnstile gate names only the sign-in path. An absence is the easiest
  kind of requirement to regress. Account creation happens by redeeming an invitation
  — one caller to `createIdentity`, asserted by a gate.
- **Role comes from the membership row.** Never from a field on the user record, which
  is exactly what a self-grant would edit. The provider's vocabulary
  (`owner|admin|member`) is _mapped_ into the application's, not cast through it: a
  cast turned every future real membership into a 403 for the person who should be an
  administrator.
- **The origin is validated before it can silently break sign-in.** Better Auth
  compares the browser's `Origin` to `BETTER_AUTH_URL`, so a loopback default on a
  public host answers every sign-in with "Invalid origin" while working perfectly on
  the laptop that set it. Serving under `NODE_ENV=production` on a loopback origin is
  now a boot failure, the apex/www sibling is trusted automatically, extra origins are
  an explicit allowlist that refuses wildcards, and the production defaults across
  compose, the Dockerfile and CI are pinned to one origin by a test that fails on
  drift.

Idle timeout is enforced by our own proxy layer (`src/proxy.ts`) rather than by a
dashboard setting, which is what makes it testable.

## Consequences

**Positive.** No identity vendor in the request path of a fraud call. Customer data
never leaves the deployment. Session, membership and tenant policy are one schema, so
an audit question about who could do what on a given call is one query. Auth changes
ship on this repository's review process instead of a support ticket.

**Negative, stated plainly.** We own auth availability and security patching, with no
vendor SLA behind either. `BETTER_AUTH_SECRET` rotation logs everyone out and is a
manual, planned operation. Self-hosting removes the audited third party from a bank's
security questionnaire — which reads as an asset right up to the moment a reviewer
asks who patches it, which is why the CSP, HSTS and the hardened headers are asserted
by gates rather than asserted in prose.

## Evidence

`src/lib/better-auth.ts` · `src/app/api/auth/[...all]/route.ts` ·
`src/lib/auth/signup.ts` · `src/lib/auth/invite.ts` · `src/lib/auth/origins.ts` ·
`src/lib/auth/roles.ts` · `src/lib/identity/session-role-map.ts` ·
`src/lib/credits.ts` (`roleFromMembership`) · `src/proxy.ts` · `scripts/assert-no-clerk.mjs` ·
`tests/auth/signup-closed.test.ts` · `tests/unit/auth-trusted-origins.test.ts` ·
`tests/unit/prod-origin-defaults.test.ts`
