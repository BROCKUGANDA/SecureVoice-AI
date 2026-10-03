import "server-only";
/**
 * WP-11 Authentication — public surface.
 *
 * Import order inside this package is a security dependency, and the barrel
 * documents it:
 *
 *   store.ts      no deps          persistence primitive (IdempotencyKey-backed)
 *   roles.ts      no deps          the capability matrix — no I/O
 *   password.ts   no deps          KDF
 *   constants.ts  no deps          the policy numbers
 *   audit.ts      audit-chain      audit events
 *   identity.ts   store, roles     accounts + revocation epochs
 *   session.ts    store, identity  the server-side session control
 *   invite.ts     identity+session  single-use provisioning
 *   stepup.ts     session, roles   re-authentication
 *   rbac.ts       roles, db        data-access-layer enforcement
 *   magic-link.ts store, identity  primary sign-in
 *   guards.ts     all of the above route-handler-shaped entry points
 *
 * `guards.ts` is the only module a route handler should import. Everything else
 * is exposed for tests and for the specialised callers that need exactly one
 * piece (e.g. `assertCapability` inside a shared helper).
 */

export {
  ABSOLUTE_LIFETIME_MS,
  IDLE_TIMEOUT_MS,
  INVITE_TTL_MS,
  MAGIC_LINK_TTL_MS,
  SESSION_COOKIE_ATTRS,
  SESSION_COOKIE_NAME,
  STEP_UP_WINDOW_MS,
} from "@/lib/auth/constants";

export {
  CAPABILITIES,
  PRIVILEGED_ACTIONS,
  PRIVILEGED_ACTION_CAPABILITY,
  PRIVILEGED_ACTION_LABEL,
  ROLES,
  ROLE_CAPABILITIES,
  WRITE_CAPABILITIES,
  isPrivilegedAction,
  isReadOnlyRole,
  isRole,
  isWriteCapability,
  roleHas,
  type Capability,
  type PrivilegedAction,
  type Role,
} from "@/lib/auth/roles";

export {
  InvalidPasswordError,
  MIN_PASSWORD_LENGTH,
  isValidEmail,
  needsRehash,
  normalizeEmail,
  passwordHashingAlgorithm,
  verifyPassword,
  hashPassword,
} from "@/lib/auth/password";

export {
  absoluteRemainingMs,
  idleRemainingMs,
  issueSession,
  listIdentitySessions,
  parseSessionToken,
  readSessionCookie,
  revokeIdentitySessions,
  revokeSession,
  signSessionToken,
  verifySession,
  SessionConfigError,
  type AuthMethod,
  type SessionCheck,
  type SessionRecord,
  type SessionRejection,
} from "@/lib/auth/session";

export {
  CONSOLE_ROLES,
  IdentityError,
  NO_ORG,
  createIdentity,
  getIdentity,
  getIdentityByEmail,
  legacyRoleToPlatformRole,
  listOrgMembers,
  revokeOrgSessions,
  setRole,
  type Identity,
} from "@/lib/auth/identity";

export {
  acceptInvite,
  hashInviteToken,
  inviteStatus,
  issueInvite,
  type AcceptInviteResult,
  type InviteRecord,
  type InviteRejection,
} from "@/lib/auth/invite";

export {
  currentStepUp,
  issueStepUp,
  requireStepUp,
  type StepUpGrant,
  type StepUpMethod,
} from "@/lib/auth/stepup";

export {
  hashMagicToken,
  issueMagicLink,
  redeemMagicLink,
  type MagicLinkDeliverer,
  type RedeemMagicLinkResult,
} from "@/lib/auth/magic-link";

export {
  CapabilityError,
  RawSqlDeniedError,
  assertCapability,
  assertMayAssignRole,
  authorizedDb,
  hasCapability,
  rbacDb,
} from "@/lib/auth/rbac";

export {
  loginWithPassword,
  logout,
  requireAuth,
  requireCapability,
  requirePrivileged,
  sessionStatus,
  type AuthDenied,
  type Authed,
} from "@/lib/auth/guards";

export {
  SIGNUP_CLOSED_CODE,
  SIGNUP_CLOSED_MESSAGE,
  SIGNUP_CLOSED_STATUS,
  accountCreationPath,
  createAccountFromSignup,
} from "@/lib/auth/signup";

export { AUTH_AUDIT_INTENTS, auditAuthEvent, auditAuthEventRequired } from "@/lib/auth/audit";
