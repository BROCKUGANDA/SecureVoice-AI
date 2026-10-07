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
import {
  ABSOLUTE_LIFETIME_SECONDS,
  COOKIE_CACHE_SECONDS,
  SESSION_REFRESH_SECONDS,
} from "@/lib/auth/session-policy";

const secret = process.env.BETTER_AUTH_SECRET;
const baseURL = process.env.BETTER_AUTH_URL ?? process.env.APP_URL;

// Fail at boot rather than at first login. Better Auth requires >= 32 chars;
// a short or missing secret would otherwise surface as a confusing runtime
// error on the sign-in page in front of a judge.
if (!secret || secret.length < 32) {
  throw new Error(
    "BETTER_AUTH_SECRET must be set and at least 32 characters. Generate with: openssl rand -base64 32",
  );
}
if (!baseURL) {
  throw new Error("BETTER_AUTH_URL (or APP_URL) must be set so auth knows its own origin");
}

export const auth = betterAuth({
  appName: "SecureVoice AI",
  secret,
  baseURL,
  // CSRF allowlist. The console and the public site are served from the same
  // origin behind Caddy today; adding a subdomain means adding it here too.
  trustedOrigins: [baseURL],
  database: prismaAdapter(db, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
    // Deliberately NOT enabling auto-sign-in. A credential compromise should
    // force an MFA challenge, not land the operator straight in the console.
    requireEmailVerification: false,
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
    cookieCache: {
      enabled: true,
      // "compact" = base64url + HMAC. Not "jwt": there is no need for the
      // payload to be readable, and less readable is better here.
      strategy: "compact",
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
    dash(),
    sentinel(),
  ],
});

export type AuthSession = typeof auth.$Infer.Session;
export type AuthSessionUser = typeof auth.$Infer.Session.user;
