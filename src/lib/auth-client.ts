"use client";
/**
 * Better Auth browser client.
 *
 * The ONLY module in this codebase that talks to Better Auth from the browser.
 * Every `"use client"` component imports from here rather than calling
 * `createAuthClient` inline, so there is exactly one session signal in the app
 * and a sign-in anywhere refetches the navbar, the console and the landing page
 * together.
 *
 * The `organizationClient` plugin is what makes `useSession()` carry
 * `activeOrganizationId` on the CLIENT as well as the server, which is why the
 * tenant switcher can re-render without a full page load. Its atom listeners
 * refetch the session automatically after `set-active`, so no component is
 * responsible for manually refetching after a tenant switch.
 *
 * Deliberately NOT imported by anything server-side. A session check that
 * trusts the browser is not a session check: server code must call
 * `auth.api.getSession({ headers })` against the database (hazard AU-4, AU-5).
 */
import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [organizationClient()],
});

/** The subset the console actually uses, named once so call sites read well. */
export const { signIn, signOut, signUp, useSession } = authClient;
