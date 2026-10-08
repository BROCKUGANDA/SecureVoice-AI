/**
 * User-level authorization helpers.
 *
 * Uses Better Auth to verify the caller's session and role before allowing
 * sensitive operations such as triggering an outbound intervention.
 */

import { auth } from "@/lib/better-auth";
import { headers } from "next/headers";

export async function requireUserAuth(requiredRole: "admin" | "analyst" | "member" = "member") {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    throw new Error("Unauthorized");
  }

  const member = await auth.api.getActiveMember({
    headers: await headers(),
  });

  const role = member?.role ?? "member";
  if (requiredRole === "admin" && role !== "admin") {
    throw new Error("Forbidden: Admin access required.");
  }

  return {
    orgId: session.session.activeOrganizationId,
    userId: session.user.id,
    role,
  };
}
