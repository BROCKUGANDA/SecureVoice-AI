// Better Auth server configuration.
//
// This file lives at src/lib/better-auth.ts rather than src/lib/auth.ts on
// purpose: src/lib/auth/ is a hand-rolled module and a sibling auth.ts would
// make "@/lib/auth" resolve ambiguously. The CLI is pointed here explicitly
// with --config src/lib/better-auth.ts.
//
// `import "server-only"` is the FIRST import, without exception. This module
// holds BETTER_AUTH_SECRET and the Prisma handle; if it ever reaches a client
// bundle the secret is in the shipped JavaScript and the build must fail loudly
// rather than leak it quietly.
//
// Tenant model: the organization IS the tenant (hazard AU-3). There is no
// parallel tenant table, so `session.activeOrganizationId` is the single
// server-derived tenant identity that resolveTenant() hands to RLS.
//
// Session policy: every number lives in @/lib/auth/session-policy, shared with
// the first-party `sv_session` store so the two systems cannot disagree. Read
// that file for the chosen values and the documented deviation from the spec.
import "server-only";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { admin } from "better-auth/plugins/admin";
import { dash, sentinel } from "@better-auth/infra";
import { organization } from "better-auth/plugins/organization";
import { twoFactor } from "better-auth/plugins/two-factor";
import { db } from "@/lib/db";
import { sendResetPassword } from "@/lib/email/deliverers";
import { trustedOriginsFromEnv } from "@/lib/auth/origins";
import { revokeFirstPartySessionsOnSignOut } from "@/lib/auth/signout-backstop";
import { logError } from "@/lib/validation/safe-log";
import {
  ABSOLUTE_LIFETIME_SECONDS,
  COOKIE_CACHE_SECONDS,
  SESSION_REFRESH_SECONDS,
} from "@/lib/auth/session-policy";

const secret = process.env.BETTER_AUTH_SECRET;

// Fail at boot rather than at first login. Better Auth requires >= 32 chars;
// a short or missing secret would otherwise surface as a confusing runtime
// error on the sign-in page in front of a judge.
if (!secret || secret.length < 32) {
  throw new Error(
    "BETTER_AUTH_SECRET must be set and at least 32 characters. Generate with: openssl rand -base64 32",
  );
}

// The CSRF allowlist, and the boot failure that keeps it honest. See
// src/lib/auth/origins.ts for why a wildcard, a path, and a reflected `Host` are
// all refused, and why a loopback base URL under NODE_ENV=production is fatal
// rather than a warning. The same derivation is what the auth route logs against,
// so the diagnostic can never describe a different list from the one enforced here.
const origins = trustedOriginsFromEnv();
if (origins.rejected.length > 0) {
  // Not fatal: one typo in a four-host list should not stop the app. It is loud,
  // because the silent version of this is the operator assuming the host they
  // added is trusted when it was dropped.
  logError("[auth] BETTER_AUTH_TRUSTED_ORIGINS entries ignored — not origins", {
    rejected: origins.rejected.join(", "),
    expected: "https://host or https://host:port, with no path",
  });
}
const baseURL = origins.baseURL;

export const auth = betterAuth({
  appName: "SecureVoice AI",
  secret,
  baseURL,
  // CSRF allowlist. The console and the public site are served from the same
  // origin behind Caddy today; adding a subdomain means adding it to
  // BETTER_AUTH_TRUSTED_ORIGINS, not editing this line. The apex/www sibling of
  // every accepted entry is included by the builder.
  trustedOrigins: origins.origins,
  database: prismaAdapter(db, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
    /**
     * SIGN-UP DISABLED, and this line is the control — not the absence of a
     * route.
     *
     * `src/lib/auth/signup.ts` documents that "there is no public signup route"
     * is a claim about missing code, and `tests/auth/signup-closed.test.ts`
     * patrols the filesystem for one. Neither of them covers the door that was
     * already open: `src/app/api/auth/[...all]/route.ts` forwards every unmatched
     * POST to Better Auth, and Better Auth's own `POST /api/auth/sign-up/email`
     * is served by that catch-all. `turnstileRequired()` guards only
     * `/api/auth/sign-in/email`, so a signup reached this handler with no CAPTCHA
     * and no bad-actor check, while `docs/SECURITY-QUESTIONNAIRE.md` answered
     * "Is there public sign-up?" with "No."
     *
     * `enabled` has to stay `true`: the console signs operators IN with
     * credentials, and password recovery runs through Better Auth's own accounts.
     * This flag is the half that lets the answer be true — sign-in yes, account
     * creation only by invitation.
     */
    disableSignUp: true,
    // Deliberately NOT enabling auto-sign-in. A credential compromise should
    // force an MFA challenge, not land the operator straight in the console.
    requireEmailVerification: false,
    // Password RESET for accounts Better Auth owns. Delivers through the same
    // Resend queue as the first-party flows (src/lib/email/queue.ts), so a
    // provider outage is retried by the email worker rather than dropped.
    //
    // Both magic links and resets are live, which is intentional: the
    // first-party store (@/lib/auth/*) is what the console actually uses, and
    // Better Auth's credential accounts need a recovery path too or they are
    // permanently locked. See src/lib/auth/magic-link.ts:5-15 for why magic
    // link remains the PRIMARY sign-in.
    sendResetPassword,
  },
  session: {
    // Every number below comes from the single session policy
    // (src/lib/auth/session-policy.ts), which also documents the deliberate
    // deviation from the specification. Hard-coding a second set here is what
    // created hazard AU-7: two systems, two answers, and no way to reason about
    // which limit a given route actually enforced.
    //
    // expiresIn is ABSOLUTE (not rolling) and rolling refresh is DISABLED, so the
    // 8-hour bound is a real bound rather than a bound that every request pushes
    // further out. The cookie and the stored row therefore expire at the same
    // instant, which matters because `getSession()` trusts the row.
    expiresIn: ABSOLUTE_LIFETIME_SECONDS,
    updateAge: SESSION_REFRESH_SECONDS,
    // Cookie cache is for DISPLAY only (hazard AU-4). Revocation, role and
    // tenant checks must read the database, so callers that authorize use
    // auth.api.getSession() and never trust a cached copy.
    //
    // STRATEGY: "jwe", not the default "compact". Read the implementation
    // (better-auth 1.7.7, dist/cookies/index.mjs:100-105) before changing it —
    // the three strategies are not variations on a theme:
    //
    //   · "compact" (the library default) → `signJWT()`: a SIGNED JWS. The
    //     payload is base64url JSON, so anyone holding the cookie can read the
    //     session fields with no secret at all. This file used to carry a
    //     comment claiming compact was "not readable" — that was wrong, and the
    //     claim is exactly what would make a reader skip the switch.
    //   · "jwt"     → `signJWT()` with a custom signer / JWKS. Still readable.
    //   · "jwe"     → `symmetricEncodeJWT()`: ENCRYPTED with the app secret.
    //     The payload cannot be read without BETTER_AUTH_SECRET.
    //
    // So "jwe" is the only strategy that delivers the intent the old comment
    // described. It matters here more than in a typical app: the session object
    // carries `activeOrganizationId` (the tenant identity, hazard AU-3), and a
    // readable cookie hands a tenant id to anything that can read the browser's
    // cookie jar — a shared terminal, a screen-share, an XSS in a sibling page.
    //
    // Cost: one symmetric decryption per request that reads the cache, versus a
    // base64 decode. That is a few microseconds against the ~280 ms database
    // round trip the cache exists to avoid.
    cookieCache: {
      enabled: true,
      strategy: "jwe",
      maxAge: COOKIE_CACHE_SECONDS,
    },
  },
  advanced: {
    useSecureCookies: process.env.NODE_ENV === "production",
    database: {
      // UUIDs everywhere so the RLS policy's ::uuid cast works without
      // special-casing the auth tables (hazard AU-8).
      generateId: "uuid",
    },
    // Only trust forwarding headers from our own proxy (hazard LB-6).
    // Without this a caller can spoof X-Forwarded-For and poison rate
    // limiting and the audit trail.
    //
    // Order matters and is read left to right:
    //   1. `x-securevoice-client-ip` — set by src/proxy.ts ONLY after Caddy
    //      identified itself (PROXY_MARKER), already sanitised to `[\w.:]` and
    //      capped at 64 chars. It is the value the app's own rate limiter keys
    //      on (src/lib/ratelimit.ts `rateLimitId`), so preferring it here keeps
    //      Better Auth's rate limit and audit trail keyed identically.
    //   2. `x-forwarded-for` — the raw, caller-influenceable chain. Kept as a
    //      fallback for deployments that reach the app without the proxy, so a
    //      missing proxy degrades to "the best guess available" rather than to
    //      "no address at all".
    //
    // NOTE: this is NOT the Better Auth dashboard's "Forward Headers" setting.
    // That setting sends a STATIC value, and this header is per-request. A
    // static value here would make every caller share one rate-limit bucket and
    // stamp a constant IP onto every audit row.
    ipAddress: {
      ipAddressHeaders: ["x-securevoice-client-ip", "x-forwarded-for"],
    },
  },
  /**
   * Sign-out must kill BOTH session systems, and one hook is the only place that
   * can guarantee it for every caller.
   *
   * The rationale — the two session systems, why magic link mints only one of
   * them, and why the revocation is per-IDENTITY rather than per-session — lives
   * in src/lib/auth/signout-backstop.ts. It is its own module rather than inline
   * here for one concrete reason: `tests/auth/signin-lockout.test.ts` replaces
   * this whole module with `{ auth: {} }` via `mock.module`, which bun applies
   * process-wide, so a hook defined here is unreachable from a test that runs
   * after it. The behaviour is tested directly instead, and the wiring below is
   * asserted against the source text.
   *
   * The Navbar and the idle handler also POST /api/auth/logout, which revokes
   * THIS session precisely. This hook is the backstop for every sign-out that is
   * not those two.
   */
  databaseHooks: {
    session: {
      delete: {
        // The hook receives the deleted session record DIRECTLY — not wrapped in
        // `{ session }` — followed by the endpoint context.
        after: async (session) => {
          await revokeFirstPartySessionsOnSignOut(session.userId);
          // A demo sign-out frees its queue seat, promoting the head of the
          // line. Best-effort by design: a hook that throws would break
          // sign-out itself, and a missed release still converges via the
          // heartbeat TTL. Wrapped so a queue-store outage can never fail a
          // sign-out.
          try {
            const { releaseUserSeats } = await import("@/lib/demo-queue");
            // Scoped to THIS session. The demo credential is one shared account,
            // so releasing on the user id alone would let one judge signing out
            // evict every other judge's seat — a wave of spurious "removed from
            // the queue" banners for a room that is all still there.
            await releaseUserSeats(session.userId, session.id);
          } catch {
            // converged by TTL; sign-out must not fail for this.
          }
        },
      },
    },
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 30,
    // Database-backed so the limit survives the multi-replica deploy in Part S.
    // Memory-backed limits reset on every restart and are per-instance, which
    // makes them decorative.
    storage: "database",
  },
  // `twoFactor()` with no options stores the OTP a user types into
  // `verification.value` as PLAINTEXT (better-auth 1.7.7,
  // plugins/two-factor/otp/index.mjs: `storeOTP: "plain"` is the default). A
  // code read out of the database is a second factor that works, for as long as
  // its window lasts, against anyone holding a row.
  //
  // Hashed is the correct mode here, not encrypted: the code is compared for
  // equality exactly once and never needs to be recovered, so nothing is lost
  // that a fraud desk would want back. The plugin's verify path hashes the
  // user's input the same way, and a resend rotates rather than reusing.
  //
  // Not a claim about the TOTP secret or the backup codes — both are already
  // symmetric-encrypted by the plugin before they are written, with no option
  // to turn that off. See docs/SECURITY.md for what remains plaintext.
  plugins: [
    organization(),
    twoFactor({ otpOptions: { storeOTP: "hashed" } }),
    admin(),
    // `dash()` telemetry, with activity tracking ON.
    //
    // Activity tracking writes `user.lastActiveAt` (see the schema comment and
    // migration `9zzzzzzzzzzzzzzzzzzz_user_last_active_at`) and is off by
    // default precisely because it needs that column. It is enabled here for a
    // second reason beyond the dashboard's activity charts: `sentinel()`'s
    // stale-user check reads the same field —
    // `checkStaleUser(userId, activityTrackingEnabled ? user.lastActiveAt : null)`
    // (infra dist/index.mjs:2899) — so while tracking is off, sentinel is handed
    // `null` on every call and that security check cannot fire. Enabling the
    // column makes the dormant check live.
    //
    // `apiKey` is not passed: it defaults to `process.env.BETTER_AUTH_API_KEY`,
    // which is the single place the key is configured.
    dash({ activityTracking: { enabled: true } }),
    sentinel(),
  ],
});

export type AuthSession = typeof auth.$Infer.Session;
export type AuthSessionUser = typeof auth.$Infer.Session.user;
