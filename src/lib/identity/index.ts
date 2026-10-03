/**
 * Identity seam (WP-11).
 *
 * Better Auth is the platform's identity provider (src/lib/better-auth.ts), and
 * the organization plugin makes the organization the tenant. This directory
 * holds the mapping between a session's role vocabulary and the WP-11 capability
 * scale, so a single `ROLE_CAPABILITIES` matrix governs every guard regardless of
 * which session path authenticated the request.
 *
 * There is deliberately no second identity provider. See `session-bridge.ts`.
 */
export {
  allowedSessionRoles,
  isHonourableSessionRole,
  mapSessionRole,
  type SessionRoleClaims,
} from "@/lib/identity/session-role-map";

export { resolveSessionIdentity, type ConsoleIdentity } from "@/lib/identity/session-bridge";
