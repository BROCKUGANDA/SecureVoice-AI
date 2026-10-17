import { mock } from "bun:test";

/**
 * ONE Better Auth stub for the whole `tests/api` group, shared by every suite
 * that needs it.
 *
 * `mock.module` in Bun is PROCESS-GLOBAL and last-registration-wins — it replaces
 * the module rather than merging into it. So two suites in one `bun test` run
 * that each stubbed `@/lib/better-auth` with a DIFFERENT shape did not compose:
 * whichever loaded second silently deleted the other's method.
 *
 * That is not a hypothetical. `demo-routes.test.ts` needs `auth.api.getSession`
 * and `demo-enter.test.ts` needs `auth.api.signInEmail`; running the two files
 * together failed in EITHER order, in a test that passes when its file runs
 * alone. A suite that only goes red in the company of its siblings is the
 * worst kind to diagnose, and the fix is structural rather than a retry: one
 * registration, both methods, shared mutable state each suite sets for itself.
 */
export const authState = {
  /** `null` = signed out. Suites assign this to pretend to be a given user. */
  currentUserId: null as string | null,
  /**
   * The session id `getSession` reports. Not optional in practice: `/api/demo/lease`
   * reads `session.session.id` and looks the seat up by it, because the demo
   * credential is one shared account. A stub with a user but no session makes the
   * lease suite fail for a reason that has nothing to do with what it is testing.
   */
  currentSessionId: null as string | null,
  /** What `signInEmail` reports back. */
  signInUserId: "user-enter-1",
  signInSessionId: "sess-enter-1",
};

mock.module("@/lib/better-auth", () => ({
  auth: {
    api: {
      getSession: async () =>
        authState.currentUserId
          ? {
              user: { id: authState.currentUserId },
              session: { id: authState.currentSessionId ?? `sess-${authState.currentUserId}` },
            }
          : null,
      // The real `signInEmail` returns the session alongside the user. The demo
      // lease binds to the SESSION id rather than the user id, because the demo
      // credential is one published account and a user-keyed lease would admit
      // every browser once any one of them was in — which is precisely the
      // capacity bound the queue exists to hold.
      signInEmail: async () =>
        new Response(
          JSON.stringify({
            user: { id: authState.signInUserId },
            session: { id: authState.signInSessionId },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "set-cookie": "better-auth.session_token=stub-session; Path=/; HttpOnly",
            },
          },
        ),
    },
  },
}));
