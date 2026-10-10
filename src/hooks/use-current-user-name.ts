"use client";

import { useSession } from "@/lib/auth-client";

/**
 * The signed-in operator's display name, and `"?"` when there is none to show.
 *
 * ADAPTED FROM THE SUPABASE BLOCK for the same reason as
 * `use-current-user-image.ts`: upstream reads `user_metadata.full_name` from a
 * Supabase Auth session, and there is no Supabase Auth session in this project
 * (auth is Better Auth — see src/lib/better-auth.ts). Reading it would return
 * the `"?"` fallback for every operator, which is indistinguishable from a user
 * who genuinely has no name.
 *
 * Precedance is `name`, then `email`, then `"?"` — matching what the navbar
 * already renders for the same session (src/components/shell/Navbar.tsx), so the
 * avatar's initials and the name beside it are always derived from the same
 * value rather than drifting apart.
 *
 * Returns null while the session is pending so the avatar can distinguish
 * "still loading" from "there is no name".
 */
export const useCurrentUserName = (): string | null => {
  const { data: session, isPending } = useSession();
  if (isPending || !session) return null;
  return session.user.name ?? session.user.email ?? null;
};
