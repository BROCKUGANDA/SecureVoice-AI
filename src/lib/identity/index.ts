/**
 * Identity seam (WP-11).
 *
 * Clerk remains the platform's identity provider — it is mounted in
 * `src/app/layout.tsx` and backs `src/lib/credits.ts`. This directory holds the
 * mapping between Clerk's identity vocabulary and the WP-11 capability scale, so
 * a single `ROLE_CAPABILITIES` matrix governs both the Clerk path and the
 * first-party session path.
 *
 * WP-11 does not add a second identity system. See `clerk-bridge.ts` for the
 * full statement of what coexists and what does not.
 */

export {
  allowedClerkRoles,
  isHonourableClerkRole,
  mapClerkRole,
  type ClerkRoleClaims,
} from "@/lib/identity/clerk-role-map";

export { resolveClerkIdentity, resolveConsoleIdentity, type ConsoleIdentity } from "@/lib/identity/clerk-bridge";